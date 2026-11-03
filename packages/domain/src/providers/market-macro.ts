import { macroRangeThrough, type MacroRange } from '../../../contracts/src/macro-range.ts'
import { MACRO_ETFS, type MacroEtfData, type MacroIndexData } from '../../../contracts/src/market-macro.ts'
import { beijingMarketDate, isMarketDate } from '../../../contracts/src/market-history.ts'
import type { StockKLineData } from '../../../contracts/src/index.ts'
import { isoNow, type Clock, type HttpClient } from '../http.ts'
import { ProviderCache } from './cache.ts'
import { SourceCircuit } from './source-circuit.ts'

/** Read the public table as data; never evaluate the site's JavaScript wrapper. */
export function parseEtfAssets(body: string, from: string, to: string): MacroEtfData['funds'][number]['points'] {
  if (!/期末净资产（亿元）/.test(body)) throw new Error('基金规模字段已变化')
  const points = new Map<string, number>()
  for (const row of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => cell[1]!.replace(/<[^>]*>/g, '').trim())
    const date = cells[0] ?? ''
    if (!isMarketDate(date) || date < from || date > to || cells.length !== 6) continue
    const raw = cells[4]!.replace(/,/g, '')
    if (!/^\d+(?:\.\d+)?$/.test(raw)) continue
    const assets = Number(raw)
    if (Number.isFinite(assets) && assets > 0) points.set(date, assets)
  }
  if (points.size === 0) throw new Error('公开基金规模不可用')
  return [...points].sort(([a], [b]) => a.localeCompare(b)).map(([date, assets]) => ({ date, assets }))
}

export class MarketMacroProvider {
  private readonly etfs: ProviderCache<MacroEtfData>
  private readonly index: ProviderCache<MacroIndexData>
  private readonly indexFallback: ProviderCache<MacroIndexData>
  private readonly officialHistory: ProviderCache<MacroIndexData>
  constructor(private readonly http: HttpClient, private readonly clock: Clock, readonly circuit: SourceCircuit,
    private readonly kline: (before?: string) => Promise<StockKLineData>) {
    const ttl = () => {
      const now = new Date(clock.now() + 8 * 3_600_000)
      const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
      return now.getUTCDay() > 0 && now.getUTCDay() < 6 && minutes >= 565 && minutes <= 905 ? 25_000 : 6 * 3_600_000
    }
    this.etfs = new ProviderCache(clock, ttl)
    this.index = new ProviderCache(clock, ttl)
    this.indexFallback = new ProviderCache(clock, ttl)
    this.officialHistory = new ProviderCache(clock, 6 * 3_600_000)
  }

  private range(range?: MacroRange) { return range ?? macroRangeThrough(beijingMarketDate(this.clock.now())) }

  private closedDate(date: string): boolean {
    const today = beijingMarketDate(this.clock.now())
    const bj = new Date(this.clock.now() + 8 * 3_600_000)
    return date < today || (date === today && bj.getUTCHours() * 60 + bj.getUTCMinutes() >= 905)
  }

  getEtfs(range?: MacroRange): Promise<MacroEtfData | null> {
    return this.etfs.get(JSON.stringify(this.range(range)), () => this.circuit.run('eastmoney-fund', async () => {
      const { from, to } = this.range(range)
      const funds: MacroEtfData['funds'] = []
      // Four bounded requests, sequential to avoid bursting the public fund service.
      for (const { code } of MACRO_ETFS) {
        const result = await this.http.request(`https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=gmbd&mode=0&code=${code}`,
          { timeoutMs: 5000, headers: { Referer: `https://fundf10.eastmoney.com/gmbd_${code}.html` } })
        if (result.status !== 200) throw new Error(`基金规模 HTTP ${result.status}`)
        funds.push({ code, points: parseEtfAssets(result.body, from, to) })
      }
      const common = funds[0]!.points.filter(point => funds.every(fund => fund.points.some(row => row.date === point.date)))
      const date = common.at(-1)?.date
      if (date === undefined) throw new Error('四只ETF没有可对齐的报告期')
      return { funds: funds.map(fund => ({ ...fund, points: fund.points.filter(point => point.date <= date) })),
        meta: { providerId: 'eastmoney-fund', sourceName: '东方财富基金公开季报规模', sourceTimestamp: date, fetchedAt: isoNow(this.clock), cacheState: 'fresh' } }
    }))
  }

  getIndex(range?: MacroRange): Promise<MacroIndexData | null> {
    return this.index.get(JSON.stringify(this.range(range)), async () => {
      const { from, to } = this.range(range)
      const official = await this.officialHistory.get(`${from}:${to}`, () => this.circuit.run('csi-index', async () => {
        const params = new URLSearchParams({ indexCode: '000300', startDate: from.replace(/-/g, ''), endDate: to.replace(/-/g, '') })
        const response = await this.http.request(`https://www.csindex.com.cn/csindex-home/perf/index-perf?${params}`, { timeoutMs: 5000 })
        if (response.status !== 200) throw new Error(`中证历史行情 HTTP ${response.status}`)
        const raw: unknown = JSON.parse(response.body)
        if (raw === null || typeof raw !== 'object' || !('code' in raw) || String(raw.code) !== '200' || !('data' in raw) || !Array.isArray(raw.data)) throw new Error('中证历史行情格式错误')
        const points: MacroIndexData['points'] = []
        for (const row of raw.data) {
          if (row === null || typeof row !== 'object' || row.indexCode !== '000300' || typeof row.tradeDate !== 'string' || !/^\d{8}$/.test(row.tradeDate)) throw new Error('中证指数代码或日期错误')
          const date = `${row.tradeDate.slice(0, 4)}-${row.tradeDate.slice(4, 6)}-${row.tradeDate.slice(6)}`
          if (!isMarketDate(date) || date < from || date > to || typeof row.close !== 'number' || !Number.isFinite(row.close) || row.close <= 0 || (points.at(-1)?.date ?? '') >= date) throw new Error('中证指数观测无效')
          points.push({ date, close: row.close })
        }
        const minimum = Math.min(900, Math.max(1, Math.floor((Date.parse(to) - Date.parse(from)) / 86_400_000 * 0.45)))
        if (points.length < minimum || Date.parse(points[0]!.date) - Date.parse(from) > 14 * 86_400_000 || Date.parse(to) - Date.parse(points.at(-1)!.date) > 14 * 86_400_000) throw new Error('中证历史区间不完整')
        return { points, meta: { providerId: 'csi-index', sourceName: '中证指数官方历史日线', sourceTimestamp: points.at(-1)!.date, fetchedAt: isoNow(this.clock), cacheState: 'fresh' } }
      }))
      if (official === null || official.meta.cacheState === 'stale') {
        const fallback = await this.getFallbackIndex(range)
        if (fallback !== null) return fallback
        if (official !== null) return official
        throw new Error('沪深300历史行情不可用')
      }
      try {
        const recent = await this.kline(range === undefined ? undefined : new Date(Date.parse(to) + 86_400_000).toISOString().slice(0, 10))
        const known = new Map(official.points.map(point => [point.date, point.close]))
        const bars = recent.bars.filter(bar => isMarketDate(bar.date) && this.closedDate(bar.date) && Number.isFinite(bar.close) && bar.close > 0)
        const consistent = bars.every(bar => !known.has(bar.date) || Math.abs(known.get(bar.date)! - bar.close) <= 0.02)
        const added = bars.filter(bar => bar.date > official.points.at(-1)!.date && bar.date <= to).sort((a, b) => a.date.localeCompare(b.date))
        if (consistent && added.length > 0 && recent.meta !== null && !['stale', 'unavailable'].includes(recent.meta.cacheState)) {
          const merged = new Map([...official.points, ...added].map(point => [point.date, point.close]))
          const points = [...merged].sort(([a], [b]) => a.localeCompare(b)).map(([date, close]) => ({ date, close }))
          return { points, meta: { providerId: `csi-index+${recent.meta.providerId}`, sourceName: `中证历史日线（至${official.points.at(-1)!.date}） / ${recent.meta.sourceName}补充日线`, sourceTimestamp: points.at(-1)!.date, fetchedAt: isoNow(this.clock), cacheState: 'fresh' } }
        }
      } catch { /* A recent quote failure must not discard official historical closes. */ }
      return official
    })
  }

  private getFallbackIndex(range?: MacroRange): Promise<MacroIndexData | null> {
    return this.indexFallback.get(JSON.stringify(this.range(range)), async () => {
      const { from, to } = this.range(range)
      const points = new Map<string, number>()
      let before: string | undefined = range === undefined ? undefined : new Date(Date.parse(to) + 86_400_000).toISOString().slice(0, 10)
      let meta: StockKLineData['meta'] = null
      for (let page = 0; page < 4; page += 1) {
        const result = await this.kline(before)
        const bars = result.bars.filter(bar => isMarketDate(bar.date) && this.closedDate(bar.date) && Number.isFinite(bar.close) && bar.close > 0)
          .sort((a, b) => a.date.localeCompare(b.date))
        if (bars.length === 0 || result.meta === null || result.meta.cacheState === 'unavailable') throw new Error('沪深300历史行情不完整')
        meta ??= result.meta
        for (const bar of bars) if (bar.date >= from && bar.date <= to) points.set(bar.date, bar.close)
        const oldest = bars[0]!.date
        if (oldest <= from || !result.hasMore) break
        if (page === 3 || (before !== undefined && oldest >= before)) throw new Error('沪深300历史分页未完成')
        before = oldest
      }
      if (meta === null || points.size === 0) throw new Error('沪深300历史行情不可用')
      const rows = [...points].sort(([a], [b]) => a.localeCompare(b)).map(([date, close]) => ({ date, close }))
      if (Date.parse(rows[0]!.date) - Date.parse(from) > 14 * 86_400_000 || Date.parse(to) - Date.parse(rows.at(-1)!.date) > 14 * 86_400_000) throw new Error('沪深300备源历史区间不完整')
      return { points: rows, meta: { ...meta, sourceTimestamp: rows.at(-1)!.date } }
    })
  }

  clear(): number { return this.etfs.clear() + this.index.clear() + this.indexFallback.clear() + this.officialHistory.clear() }
}
