import type { ProviderMeta } from '../../../contracts/src/index.ts'
import { GLOBAL_INDICES, isGlobalMarketOpen, marketLocalTime, type GlobalIndexQuote, type GlobalIndicesData } from '../../../contracts/src/market-indices.ts'
import { ProviderCache } from './cache.ts'
import { SourceCircuit, type SourceCircuitOptions } from './source-circuit.ts'
import { isMarketDate } from '../../../contracts/src/market-history.ts'
import { isoNow, type Clock, type HttpClient } from '../http.ts'

const QQ: Record<string, string> = { HSI: 'hkHSI', IXIC: 'usIXIC' }
const SINA: Record<string, string> = { HSI: 'rt_hkHSI', IXIC: 'gb_ixic', XIN9: 'b_FTXIN9', KS11: 'b_KOSPI', N225: 'b_NKY' }
const EM: Record<string, string> = { HSI: 'HSI', IXIC: 'NDX', XIN9: 'XIN9', KS11: 'KS11', N225: 'N225' }
const finite = (raw: unknown): number | null => typeof raw === 'number' && Number.isFinite(raw) ? raw
  : typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null

function zonedTimestamp(dateTime: string, zone: string): string | null {
  const match = dateTime.match(/^(\d{4})[-/](\d{2})[-/](\d{2}) (\d{2}):(\d{2}):(\d{2})$/)
  if (match === null) return null
  if (!isMarketDate(`${match[1]}-${match[2]}-${match[3]}`) || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return null
  const target = Date.UTC(...[Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])] as [number, number, number, number, number, number])
  let result = target
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const local = marketLocalTime(result, zone)
    const actual = Date.parse(`${local.date}T00:00:00Z`) + local.minutes * 60_000 + Number(match[6]) * 1000
    result += target - actual
  }
  return Number.isFinite(result) ? new Date(result).toISOString() : null
}

export class GlobalIndexProvider {
  readonly circuit: SourceCircuit
  private readonly cache: ProviderCache<GlobalIndicesData>
  private readonly last = new Map<string, GlobalIndexQuote>()
  constructor(private readonly http: HttpClient, private readonly clock: Clock, private readonly timeoutMs = 5000, circuit: Omit<SourceCircuitOptions, 'clock'> = {}) {
    this.circuit = new SourceCircuit({ ...circuit, clock })
    this.cache = new ProviderCache(clock, () => isGlobalMarketOpen(clock.now()) ? 25_000 : 6 * 3_600_000)
  }

  private row(code: string, price: unknown, change: unknown, changePct: unknown, timestamp: string | null, providerId: string, sourceName: string): GlobalIndexQuote | null {
    const definition = GLOBAL_INDICES.find(item => item.code === code)
    const value = finite(price)
    const time = timestamp === null ? NaN : Date.parse(timestamp)
    if (definition === undefined || value === null || value <= 0 || !Number.isFinite(time) || time > this.clock.now() + 60_000) return null
    return { code, name: definition.name, price: value, change: finite(change), changePct: finite(changePct), amount: null,
      upCount: null, downCount: null, flatCount: null, marketDate: marketLocalTime(time, definition.zone).date,
      meta: { providerId, sourceName, sourceTimestamp: timestamp, fetchedAt: isoNow(this.clock), cacheState: 'fresh' } }
  }

  private async text(url: string, referer: string): Promise<string> {
    const response = await this.http.request(url, { timeoutMs: this.timeoutMs, responseEncoding: 'gb18030', headers: { Referer: referer } })
    if (response.status < 200 || response.status >= 300) throw new Error(`海外指数 HTTP ${response.status}`)
    return response.body
  }

  private async tencent(codes: string[]): Promise<GlobalIndexQuote[]> {
    const body = await this.text(`https://qt.gtimg.cn/q=${codes.map(code => QQ[code]).join(',')}`, 'https://gu.qq.com/')
    const result: GlobalIndexQuote[] = []
    for (const match of body.matchAll(/\bv_([A-Za-z0-9]+)="([^"]*)"/g)) {
      const code = codes.find(code => QQ[code] === match[1])
      if (code === undefined) continue
      const fields = match[2]!.split('~')
      if (fields[2] !== (code === 'IXIC' ? '.IXIC' : 'HSI')) continue
      const row = this.row(code, fields[3], fields[31], fields[32], zonedTimestamp(fields[30] ?? '', code === 'IXIC' ? 'America/New_York' : 'Asia/Hong_Kong'), 'tencent-global', '腾讯海外指数')
      if (row !== null) result.push(row)
    }
    return result
  }

  private async sina(codes: string[]): Promise<GlobalIndexQuote[]> {
    const body = await this.text(`https://hq.sinajs.cn/list=${codes.map(code => SINA[code]).join(',')}`, 'https://finance.sina.com.cn/')
    const result: GlobalIndexQuote[] = []
    for (const match of body.matchAll(/\bhq_str_([A-Za-z0-9_]+)="([^"]*)"/g)) {
      const code = codes.find(code => SINA[code] === match[1])
      if (code === undefined || match[2] === '') continue
      const f = match[2]!.split(',')
      let timestamp: string | null
      let price: unknown, change: unknown, pct: unknown
      if (code === 'HSI') {
        timestamp = zonedTimestamp(`${f[17]} ${f[18]}`, 'Asia/Hong_Kong')
        ;[price, change, pct] = [f[6], f[7], f[8]]
      } else if (code === 'IXIC') {
        // The leading Sina time is acquisition time; the EDT/EST field is the actual US quote time.
        const local = f.find(value => /\b(?:EDT|EST)$/.test(value))?.match(/^(\w{3}) (\d{1,2}) (\d{2}):(\d{2})(AM|PM) (EDT|EST)$/)
        const month = local === undefined || local === null ? -1 : ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(local[1]!)
        timestamp = null
        if (local != null && month >= 0 && /^\d{4}-/.test(f[3] ?? '')) {
          let year = Number(f[3]!.slice(0, 4))
          const hour = Number(local[3]) % 12 + (local[5] === 'PM' ? 12 : 0)
          let value = Date.UTC(year, month, Number(local[2]), hour + (local[6] === 'EDT' ? 4 : 5), Number(local[4]))
          if (value > this.clock.now() + 86_400_000) value = Date.UTC(--year, month, Number(local[2]), hour + (local[6] === 'EDT' ? 4 : 5), Number(local[4]))
          timestamp = new Date(value).toISOString()
        }
        ;[price, change, pct] = [f[1], f[4], f[2]]
      } else {
        timestamp = zonedTimestamp(`${f[6]} ${f[7]}`, 'Asia/Shanghai')
        ;[price, change, pct] = [f[1], f[2], f[3]]
      }
      const row = this.row(code, price, change, pct, timestamp, 'sina-global', '新浪环球指数')
      if (row !== null) result.push(row)
    }
    return result
  }

  private async eastmoney(codes: string[]): Promise<GlobalIndexQuote[]> {
    const params = new URLSearchParams({ secids: codes.map(code => `100.${EM[code]}`).join(','), fields: 'f12,f13,f14,f2,f3,f4,f124', fltt: '2', invt: '2' })
    const response = await this.http.request(`https://push2.eastmoney.com/api/qt/ulist.np/get?${params}`, { timeoutMs: this.timeoutMs, headers: { Referer: 'https://quote.eastmoney.com/' } })
    if (response.status !== 200) throw new Error('东财海外指数请求失败')
    const json = JSON.parse(response.body) as { data?: { diff?: unknown } }
    const rows = json.data?.diff
    if (!Array.isArray(rows)) throw new Error('东财海外指数格式无效')
    return rows.flatMap((f: Record<string, unknown>) => {
      const code = codes.find(code => EM[code] === f.f12 && f.f13 === 100)
      const time = finite(f.f124)
      if (code === undefined || time === null || time <= 0) return []
      const row = this.row(code, f.f2, f.f4, f.f3, new Date(time * 1000).toISOString(), 'eastmoney-global-fallback', '东方财富海外指数（备源兜底）')
      return row === null ? [] : [row]
    })
  }

  async get(cacheOnly = false): Promise<GlobalIndicesData> {
    const value = cacheOnly ? this.cache.peek('global') : await this.cache.get('global', async () => {
      const found = new Map<string, GlobalIndexQuote>()
      for (const source of ['tencent', 'sina', 'eastmoney-push2'] as const) {
        const codes = GLOBAL_INDICES.filter(item => !found.has(item.code) && (source !== 'tencent' || QQ[item.code] !== undefined)).map(item => item.code)
        if (codes.length === 0) continue
        let rows: GlobalIndexQuote[] = []
        try {
          await this.circuit.run(source, async () => {
            rows = await (source === 'tencent' ? this.tencent(codes) : source === 'sina' ? this.sina(codes) : this.eastmoney(codes))
            if (codes.some(code => !rows.some(row => row.code === code))) throw new Error('海外指数响应不完整')
            return rows
          })
        } catch { /* Keep valid rows from a partial batch while recording its circuit failure. */ }
        for (const row of rows) { found.set(row.code, row); this.last.set(row.code, row) }
      }
      if (found.size === 0) throw new Error('海外指数数据源均不可用')
      return { indices: GLOBAL_INDICES.map(item => found.get(item.code) ?? this.unavailable(item.code)),
        meta: { providerId: 'global-indices', sourceName: '海外指数汇总', sourceTimestamp: null, fetchedAt: isoNow(this.clock), cacheState: 'fresh' as const } }
    })
    if (value === null) return { indices: GLOBAL_INDICES.map(item => this.unavailable(item.code)), meta: this.emptyMeta() }
    return { ...value, indices: value.indices.map(row => ({ ...row, meta: value.meta.cacheState === 'stale' && row.price !== null
      ? { ...row.meta, cacheState: 'stale' } : value.meta.cacheState === 'cached' && row.meta.cacheState === 'fresh' ? { ...row.meta, cacheState: 'cached' } : row.meta })) }
  }

  private emptyMeta(): ProviderMeta { return { providerId: 'global-indices', sourceName: '海外指数', sourceTimestamp: null, fetchedAt: isoNow(this.clock), cacheState: 'unavailable' } }
  private unavailable(code: string): GlobalIndexQuote {
    const previous = this.last.get(code)
    if (previous !== undefined) return { ...previous, meta: { ...previous.meta, cacheState: 'stale' } }
    return { code, name: GLOBAL_INDICES.find(item => item.code === code)!.name, price: null, change: null, changePct: null, amount: null,
      upCount: null, downCount: null, flatCount: null, marketDate: null, meta: this.emptyMeta() }
  }
  clear(): number { return this.cache.clear() }
}
