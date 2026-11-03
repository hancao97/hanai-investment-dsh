import { DEFAULT_SCAN_QUERY, normalizeScanQuery, scanQueryError, type MarketScanData, type MarketScanQuery, type MarketScanStock, type ScanMetric, type ScanSort } from '../../../contracts/src/market-scan.ts'
import { beijingMarketDate, isMarketDate } from '../../../contracts/src/market-history.ts'
import { isMarketOpen } from '../../../contracts/src/market-hours.ts'
import { isoNow, type Clock, type HttpClient } from '../http.ts'
import { ProviderCache } from './cache.ts'
import { SourceCircuit } from './source-circuit.ts'

const fields: Record<ScanMetric, string> = { pe: 'pe', pb: 'pb', roe: 'roe', profitGrowth: 'net_profit_yoy', revenueGrowth: 'revenue_yoy', marketCap: 'market_cap', dividendYield: 'dv_ratio', netInflow5d: 'main_net_inflow_5d', netMargin: 'net_margin', grossMargin: 'gross_margin' }
const sortFields: Record<ScanSort, string> = { ...fields, pe: 'pe_ttm', dividendYield: 'dividend_yield', code: 'ticker', price: 'current_price', changePct: 'change_percent' }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const metric = (value: unknown): number | null => {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('88AI 扫描指标不是有效数值')
  return value
}
export function scanParameters(input: MarketScanQuery): URLSearchParams {
  const error = scanQueryError(input); if (error) throw new Error(error)
  const query = normalizeScanQuery(input)
  const params = new URLSearchParams({ sort_by: sortFields[query.sort], sort_order: query.order, limit: '100', offset: String((query.page - 1) * 100) })
  if (query.search) params.set('search', query.search)
  if (query.industries?.length) params.set('industries', query.industries.join(','))
  for (const [key, range] of Object.entries(query.ranges)) for (const side of ['min', 'max'] as const) {
    if (range[side] !== undefined) params.set(`${side}_${fields[key as ScanMetric]}`, String(range[side]! * (key === 'marketCap' ? 1e8 : key === 'netInflow5d' ? 1e4 : 1)))
  }
  return params
}
export function parseMarketScan(raw: unknown, query: MarketScanQuery, clock: Clock): MarketScanData {
  if (!object(raw) || raw.status !== 'ready' || raw.initializing !== false || raw.error_code != null || !Number.isSafeInteger(raw.total) || Number(raw.total) < 0 || Number(raw.total) > 100_000
    || raw.limit !== 100 || raw.offset !== (query.page - 1) * 100 || !Array.isArray(raw.stocks) || raw.stocks.length !== Math.min(100, Math.max(0, Number(raw.total) - Number(raw.offset)))) throw new Error('88AI 扫描尚未就绪或返回不完整')
  const collectedOn = beijingMarketDate(clock.now())
  const date = raw.snapshot_date == null ? null : raw.snapshot_date
  if (date !== null && (typeof date !== 'string' || !isMarketDate(date) || date > collectedOn)) throw new Error('88AI 扫描快照日期无效')
  const ids = new Set<string>()
  const stocks: MarketScanStock[] = raw.stocks.map(value => {
    if (!object(value) || typeof value.ticker !== 'string' || !/^\d{6}$/.test(value.ticker) || typeof value.name !== 'string' || !value.name.trim() || ids.has(value.ticker)) throw new Error('88AI 扫描股票标识无效或重复')
    ids.add(value.ticker)
    const code = value.ticker
    const stock: MarketScanStock = { secId: `${code.startsWith('6') ? '1' : '0'}.${code}`, code, name: value.name, industry: typeof value.industry === 'string' ? value.industry : null,
      price: metric(value.current_price), changePct: metric(value.change_percent), pe: metric(value.pe_ttm), pb: metric(value.pb), roe: metric(value.roe), profitGrowth: metric(value.net_profit_yoy), revenueGrowth: metric(value.revenue_yoy),
      marketCap: metric(value.market_cap) === null ? null : Number(value.market_cap) / 1e8, dividendYield: metric(value.dividend_yield), netInflow5d: metric(value.main_net_inflow_5d) === null ? null : Number(value.main_net_inflow_5d) / 1e4,
      netMargin: metric(value.net_margin), grossMargin: metric(value.gross_margin) }
    for (const [key, range] of Object.entries(query.ranges)) {
      const actual = stock[key as ScanMetric]
      if (actual === null || (range.min !== undefined && actual < range.min - 1e-8) || (range.max !== undefined && actual > range.max + 1e-8)) throw new Error('88AI 返回了不满足筛选条件的记录')
    }
    if (query.industries?.length && (stock.industry === null || !query.industries.includes(stock.industry))) throw new Error('88AI 返回了不满足行业条件的记录')
    return stock
  })
  return { query: normalizeScanQuery(query), total: Number(raw.total), stocks, collectedOn, snapshotDate: date as string | null,
    meta: { providerId: '88ai-scan', sourceName: '88AI投 · A股财务汇总 · 非逐份财报核验', sourceTimestamp: date === null ? null : String(date), fetchedAt: isoNow(clock), cacheState: 'fresh' } }
}
/** Only the public aggregate source has this contract; failures must not fall back to rank samples. */
export class MarketScanProvider {
  private readonly cache: ProviderCache<MarketScanData>
  constructor(private readonly http: HttpClient, private readonly clock: Clock, readonly circuit: SourceCircuit) {
    this.cache = new ProviderCache(clock, () => isMarketOpen(new Date(clock.now())) ? 25_000 : 6 * 3_600_000)
  }
  get(input: MarketScanQuery = DEFAULT_SCAN_QUERY, refresh = false): Promise<MarketScanData | null> {
    const params = scanParameters(input), query = normalizeScanQuery(input)
    if (refresh) this.cache.clear()
    return this.cache.get(JSON.stringify(query), () => this.circuit.run('88ai-scan', async () => {
      const response = await this.http.request(`https://88aitou.com/api/market/scan?${params}`, { timeoutMs: 12_000 })
      if (response.status !== 200) throw new Error(`88AI 扫描 HTTP ${response.status}`)
      return parseMarketScan(JSON.parse(response.body), query, this.clock)
    }))
  }
  clear(): number { return this.cache.clear() }
}
