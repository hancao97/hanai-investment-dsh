import type { StockQuote, ProviderMeta } from '../../../contracts/src/index.ts'
import type { MarketLadderData, LimitUpStock, YesterdayLimitPerformance } from '../../../contracts/src/market-ladder.ts'
import { LADDER_BOARD_TYPE_METHOD, limitBoardType } from '../../../contracts/src/market-ladder.ts'
import { beijingMarketDate, isMarketDate, marketDateFromMeta } from '../../../contracts/src/market-history.ts'
import { isMarketOpen } from '../../../contracts/src/market-hours.ts'
import { fetchJson, isoNow, type HttpClient, type Clock } from '../http.ts'
import { ProviderCache } from './cache.ts'
import { SourceCircuit } from './source-circuit.ts'

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const sealTime = (v: unknown): string => {
  const raw = String(v).padStart(6, '0')
  if (!/^([01]\d|2[0-3])[0-5]\d[0-5]\d$/.test(raw)) throw new Error('封板时间无效')
  return `${raw.slice(0, 2)}:${raw.slice(2, 4)}:${raw.slice(4)}`
}

/** Public pool batches, not a scan of every stock. Each pool has its own failure circuit. */
export class MarketLadderProvider {
  readonly circuit: SourceCircuit
  private readonly cache: ProviderCache<MarketLadderData>
  constructor(private readonly http: HttpClient, private readonly clock: Clock, private readonly timeoutMs = 5000, private readonly quotes?: (secIds: string[]) => Promise<{ quotes: StockQuote[]; meta: ProviderMeta }>) {
    this.circuit = new SourceCircuit({ clock })
    this.cache = new ProviderCache(clock, () => isMarketOpen(new Date(clock.now())) ? 25_000 : 6 * 3_600_000)
  }
  clear() { return this.cache.clear() }
  get(date?: string): Promise<MarketLadderData | null> {
    if (date === undefined) {
      const now = new Date(this.clock.now() + 8 * 3_600_000)
      if (now.getUTCHours() * 60 + now.getUTCMinutes() < 565) now.setUTCDate(now.getUTCDate() - 1)
      while ([0, 6].includes(now.getUTCDay())) now.setUTCDate(now.getUTCDate() - 1)
      date = now.toISOString().slice(0, 10)
    }
    if (!isMarketDate(date) || date > beijingMarketDate(this.clock.now())) throw new Error('涨停梯队日期无效')
    const target = date
    return this.cache.get(target, async () => {
      const details = new Map<string, Pick<LimitUpStock, 'reason' | 'boardType'>>()
      try {
        const primary = await this.circuit.run('ths-limit-reason', () => this.ths(target, details))
        if (primary !== undefined) return primary
      } catch { /* Transport or validation failures are counted by the source circuit. */ }
      return this.circuit.run('eastmoney-limit-up', () => this.eastmoney(target, details))
    })
  }
  private meta(date: string, providerId: string, sourceName: string): MarketLadderData['meta'] {
    return { providerId, sourceName, sourceTimestamp: date, fetchedAt: isoNow(this.clock), cacheState: 'fresh' }
  }
  /** Parameters and fields follow dsh-plugin; all summaries come from the same pool scope. */
  private async ths(date: string, details: Map<string, Pick<LimitUpStock, 'reason' | 'boardType'>>): Promise<MarketLadderData | undefined> {
    const { rows, summary } = await this.thsRows(date)
    let ambiguousBoards = false
    const stocks: LimitUpStock[] = rows.map(row => {
      const consecutive = typeof row.high_days === 'string' ? row.high_days.match(/^(\d+)天(\d+)板$/) : null
      const boards = row.high_days === '首板' ? 1 : consecutive && consecutive[1] === consecutive[2] ? Number(consecutive[1]) : NaN
      if (!count(boards) || boards < 1 || boards > 100) {
        if (consecutive && count(Number(consecutive[1])) && count(Number(consecutive[2])) && Number(consecutive[1]) > Number(consecutive[2]) && Number(consecutive[2]) >= 1) ambiguousBoards = true
        else throw new Error('同花顺连续涨停字段无效')
      }
      const time = (seconds: unknown) => new Date(Number(seconds) * 1000 + 8 * 3_600_000).toISOString().slice(11, 19)
      return { code: String(row.code), name: String(row.name), boards, industry: '未分类', firstSeal: time(row.first_limit_up_time), lastSeal: time(row.last_limit_up_time),
        reason: typeof row.reason_type === 'string' && row.reason_type.trim() ? row.reason_type.trim() : null,
        boardType: limitBoardType(row.limit_up_type), breaks: count(row.open_num) ? Number(row.open_num) : null,
        turnover: typeof row.turnover_rate === 'number' && Number.isFinite(row.turnover_rate) && row.turnover_rate >= 0 ? row.turnover_rate : null }
    })
    const issues: string[] = []
    const today = object(summary?.today) ? summary.today : null
    const yesterday = object(summary?.yesterday) ? summary.yesterday : null
    if (today?.num !== stocks.length) throw new Error('同花顺涨停池汇总数量不一致')
    // A complete same-day batch can supply board types even when its N-day/M-board counts cannot build the ladder.
    for (const stock of stocks) details.set(stock.code, { reason: stock.reason, boardType: stock.boardType })
    // Valid N-day/M-board data is a capability gap, not a failed source request.
    if (ambiguousBoards) return undefined
    const promotion = count(yesterday?.num) ? { eligible: Number(yesterday!.num), promoted: stocks.filter(row => row.boards > 1).length } : null
    if (promotion !== null && promotion.promoted > promotion.eligible) throw new Error('同花顺晋级样本不一致')
    const broken = count(today?.open_num) ? Number(today!.open_num) : null
    if (promotion === null) issues.push('昨日涨停样本缺失，晋级率不可用')
    if (broken === null) issues.push('炸板统计缺失，炸板率不可用')
    if (stocks.some(row => row.reason === null)) issues.push('部分涨停股缺少题材归因')
    const yesterdayPerformance = await this.previousPerformance(date, promotion?.eligible ?? null)
    if (this.quotes && yesterdayPerformance === null) issues.push('昨日涨停今日表现获取失败')
    return { method: LADDER_BOARD_TYPE_METHOD, yesterdayPerformance, date, stocks: this.sorted(stocks), promotion, broken, issues, meta: this.meta(date, 'ths-limit-reason', '同花顺涨停池') }
  }
  private async thsRows(date: string) {
    const rows: Record<string, unknown>[] = []
    const codes = new Set<string>()
    let summary: Record<string, unknown> | null = null
    for (let page = 1; page <= 3; page++) {
      const params = new URLSearchParams({ page: String(page), limit: '200', field: '199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004', filter: 'HS,GEM2STAR', order_field: '330324', order_type: '0', date: date.replaceAll('-', '') })
      const response = await fetchJson<unknown>(this.http, `https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool?${params}`, { timeoutMs: this.timeoutMs, headers: { Referer: 'https://data.10jqka.com.cn/' } })
      const root = response.data
      if (!response.ok || !object(root) || root.status_code !== 0 || !object(root.data)) throw new Error('同花顺涨停池响应无效')
      const data = root.data
      if (String(data.date).replaceAll('-', '') !== date.replaceAll('-', '') || !Array.isArray(data.info) || !object(data.page) || !count(data.page.total)) throw new Error('同花顺涨停池日期或分页无效')
      if (page === 1 && object(data.limit_up_count)) summary = data.limit_up_count
      for (const row of data.info as unknown[]) {
        if (!object(row) || typeof row.code !== 'string' || !/^\d{6}$/.test(row.code) || codes.has(row.code) || typeof row.name !== 'string' || !row.name.trim()) throw new Error('同花顺涨停池股票无效')
        const first = Number(row.first_limit_up_time), last = Number(row.last_limit_up_time)
        if (![first, last].every(time => Number.isFinite(time) && beijingMarketDate(time * 1000) === date)) throw new Error('同花顺封板日期不匹配')
        rows.push(row)
        codes.add(row.code)
      }
      if (rows.length === data.page.total) break
      if (data.info.length < 200 || page === 3) throw new Error('同花顺涨停池数量不完整')
    }
    if (!object(summary?.today) || summary.today.num !== rows.length) throw new Error('同花顺涨停池汇总数量不一致')
    return { rows, summary }
  }
  private async previousPerformance(date: string, expectedSample: number | null): Promise<YesterdayLimitPerformance | null> {
    if (!this.quotes) return null
    try {
      return await this.circuit.run('ths-limit-previous', async () => {
        const day = new Date(`${date}T00:00:00Z`)
        do { day.setUTCDate(day.getUTCDate() - 1) } while ([0, 6].includes(day.getUTCDay()))
        const { rows } = await this.thsRows(day.toISOString().slice(0, 10))
        if (expectedSample !== null && rows.length !== expectedSample) throw new Error('昨日涨停样本数量不一致')
        if (rows.length === 0) return summarizeYesterday([], this.meta(date, 'ths-limit-previous', '同花顺昨日涨停池'))!
        const quote = await this.quotes!(rows.map(row => `${String(row.code).startsWith('6') ? '1' : '0'}.${row.code}`))
        const byCode = new Map(quote.quotes.map(row => [row.code, row]))
        const changes = rows.map(row => {
          const value = byCode.get(String(row.code))
          if (!value?.meta?.sourceTimestamp || marketDateFromMeta(value.meta) !== date || value.price === null || value.meta.cacheState === 'unavailable') throw new Error('昨日样本缺少当日行情')
          if (!isMarketOpen(new Date(this.clock.now())) && Date.parse(value.meta.sourceTimestamp) < Date.parse(`${date}T15:00:00+08:00`)) throw new Error('昨日样本尚无收盘行情')
          return value.changePct
        })
        const performance = summarizeYesterday(changes, { ...quote.meta, providerId: 'ths-limit-previous', sourceName: `同花顺昨日涨停池 / ${quote.meta.sourceName}` })
        if (performance === null) throw new Error('昨日样本涨幅不完整')
        return performance
      })
    } catch {
      try {
        return await this.circuit.run('eastmoney-limit-previous', async () => {
          const rows = await this.pool('getYesterdayZTPool', date)
          if (expectedSample !== null && rows.length !== expectedSample) throw new Error('昨日涨停样本数量不一致')
          const result = summarizeYesterday(rows.map(row => row.zdp), this.meta(date, 'eastmoney-limit-previous', '东方财富昨日涨停池（兜底）'))
          if (result === null) throw new Error('昨日样本涨幅不完整')
          return result
        })
      } catch { return null }
    }
  }
  private sorted(stocks: LimitUpStock[]) {
    return stocks.sort((a, b) => b.boards - a.boards || a.firstSeal.localeCompare(b.firstSeal) || a.code.localeCompare(b.code))
  }
  private async eastmoney(date: string, details: Map<string, Pick<LimitUpStock, 'reason' | 'boardType'>>): Promise<MarketLadderData> {
    const [current, previous, broken, reasons] = await Promise.allSettled([
      this.pool('getTopicZTPool', date),
      this.circuit.run('eastmoney-limit-previous', () => this.pool('getYesterdayZTPool', date)),
      this.circuit.run('eastmoney-limit-broken', () => this.pool('getTopicZBPool', date)),
      details.size > 0 && [...details.values()].every(row => row.reason !== null)
        ? Promise.resolve(new Map([...details].map(([code, row]) => [code, row.reason]))) : this.hotReasons(date),
    ])
    if (current.status !== 'fulfilled') throw current.reason
    const stocks: LimitUpStock[] = current.value.map(row => {
      if (typeof row.n !== 'string' || !row.n.trim() || !count(row.lbc) || Number(row.lbc) < 1 || Number(row.lbc) > 100 || !count(row.zbc)) throw new Error('涨停梯队字段无效')
      return { code: String(row.c), name: row.n, boards: Number(row.lbc), industry: typeof row.hybk === 'string' && row.hybk.trim() ? row.hybk : '未分类',
        reason: reasons.status === 'fulfilled' ? reasons.value.get(String(row.c)) ?? null : null, boardType: details.get(String(row.c))?.boardType ?? null,
        firstSeal: sealTime(row.fbt), lastSeal: sealTime(row.lbt), breaks: Number(row.zbc),
        turnover: typeof row.hs === 'number' && Number.isFinite(row.hs) && row.hs >= 0 ? row.hs : null }
    })
    const issues: string[] = []
    if (stocks.some(stock => stock.reason === null)) issues.push('部分涨停股缺少题材归因')
    let promotion: MarketLadderData['promotion'] = null
    if (previous.status === 'fulfilled') {
      const codes = new Set(previous.value.map(row => String(row.c)))
      promotion = { eligible: codes.size, promoted: stocks.filter(row => codes.has(row.code)).length }
    } else issues.push('昨日涨停池获取失败，晋级率不可用')
    let brokenCount: number | null = null
    if (broken.status === 'fulfilled') {
      const sealed = new Set(stocks.map(row => row.code))
      if (broken.value.some(row => sealed.has(String(row.c)))) issues.push('涨停与炸板池状态不一致，炸板率不可用')
      else brokenCount = broken.value.length
    } else issues.push('炸板池获取失败，炸板率不可用')
    const yesterdayPerformance = previous.status === 'fulfilled' ? summarizeYesterday(previous.value.map(row => row.zdp), this.meta(date, 'eastmoney-limit-previous', '东方财富昨日涨停池（兜底）')) : null
    if (yesterdayPerformance === null) issues.push('昨日涨停今日表现获取失败')
    return { method: LADDER_BOARD_TYPE_METHOD, yesterdayPerformance, date, stocks: this.sorted(stocks), promotion, broken: brokenCount, issues, meta: this.meta(date, 'eastmoney-limit-up', '东方财富涨停池（兜底）') }
  }
  private hotReasons(date: string): Promise<Map<string, string | null>> {
    return this.circuit.run('ths-hot-reason', async () => {
      const response = await fetchJson<unknown>(this.http, `http://zx.10jqka.com.cn/event/api/getharden/date/${date}/orderby/date/orderway/desc/charset/GBK/`, { timeoutMs: this.timeoutMs, responseEncoding: 'gb18030', headers: { Referer: 'https://data.10jqka.com.cn/' } })
      const root = response.data
      if (!response.ok || !object(root) || root.errocode !== 0 || !Array.isArray(root.data)) throw new Error('热点归因响应无效')
      const found = new Map<string, string | null>()
      for (const row of root.data as unknown[]) {
        if (!object(row) || typeof row.code !== 'string' || !/^\d{6}$/.test(row.code) || row.date !== date) throw new Error('热点归因日期或股票无效')
        found.set(row.code, typeof row.reason === 'string' && row.reason.trim() ? row.reason.trim() : null)
      }
      return found
    })
  }
  private async pool(endpoint: string, date: string): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams({ ut: '7eea3edcaed734bea9cbfc24409ed989', dpt: 'wz.ztzt', Pageindex: '0', pagesize: '10000', sort: endpoint === 'getYesterdayZTPool' ? 'zs:desc' : 'fbt:asc', date: date.replaceAll('-', '') })
    const result = await fetchJson<unknown>(this.http, `https://push2ex.eastmoney.com/${endpoint}?${params}`, { timeoutMs: this.timeoutMs, headers: { Referer: 'https://quote.eastmoney.com/' } })
    const root = result.data
    if (!result.ok || !object(root) || root.rc !== 0 || !object(root.data)) throw new Error('涨停池请求失败')
    const data = root.data
    if (String(data.qdate) !== date.replaceAll('-', '') || !Array.isArray(data.pool) || data.pool.length !== data.tc) throw new Error('涨停池日期或数量不完整')
    const codes = new Set<string>()
    for (const row of data.pool) {
      if (!object(row) || typeof row.c !== 'string' || !/^\d{6}$/.test(row.c) || codes.has(row.c)) throw new Error('涨停池股票代码无效或重复')
      codes.add(row.c)
    }
    return data.pool as Record<string, unknown>[]
  }
}

export function summarizeYesterday(values: unknown[], meta: ProviderMeta): YesterdayLimitPerformance | null {
  if (!values.every((value): value is number => typeof value === 'number' && Number.isFinite(value))) return null
  const sorted = (values as number[]).slice().sort((a, b) => a - b)
  const n = sorted.length
  return { sample: n, average: n === 0 ? null : sorted.reduce((a, b) => a + b, 0) / n,
    median: n === 0 ? null : (sorted[Math.floor((n - 1) / 2)]! + sorted[Math.floor(n / 2)]!) / 2,
    up: sorted.filter(value => value > 0).length, down: sorted.filter(value => value < 0).length, flat: sorted.filter(value => value === 0).length, meta }
}
