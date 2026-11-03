import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { HanaiDatabase } from '../../domain/src/database.ts'
import type { StockQuoteMetricsData, ProviderMeta } from '../../contracts/src/index.ts'
import { SCAN_FIELDS, normalizeScanQuery, scanQueryError, type ScreeningFact, type MarketScanQuery, type MarketScanStock, type MarketScanData, type MarketScanResult } from '../../contracts/src/market-scan.ts'
import { beijingMarketDate, isMarketDate } from '../../contracts/src/market-history.ts'
import { defaultMacroRange } from '../../contracts/src/macro-range.ts'

const fields = [...Object.keys(SCAN_FIELDS), 'price', 'changePct', 'industry']
const factSchema = z.object({ value: z.union([z.number().finite(), z.string().min(1)]), source: z.string().min(1),
  date: z.string().refine(isMarketDate), reportDate: z.string().refine(isMarketDate).nullable(), fetchedAt: z.string().datetime() }).strict()
export const factsSchema = z.record(z.string().refine(key => fields.includes(key)), factSchema).refine(value => Object.entries(value).every(([key, fact]) => key === 'industry' ? typeof fact.value === 'string' : typeof fact.value === 'number'))
type Facts = z.infer<typeof factsSchema>
const key = (code: string) => `stock-data.metrics.${code}`
const quoteFields = new Set(['pe', 'pb', 'marketCap', 'dividendYield', 'price', 'changePct'])
const currentFact = (field: string, fact: ScreeningFact, asOf: string) => Date.parse(fact.fetchedAt) <= Date.now()
  && beijingMarketDate(Date.parse(fact.fetchedAt)) >= asOf && (!quoteFields.has(field) || fact.date >= asOf)

/** Screening reads owned facts; only the durable data-preparation queue contacts providers. */
export class LocalScreening {
  readonly local = true
  private cached: { key: string; data: MarketScanData } | undefined
  private preparedAt = 0
  private preparing: Promise<void> | undefined
  constructor(private readonly db: HanaiDatabase, private readonly prepare?: () => Promise<void>) {}

  readyCodes(asOf: string): Set<string> {
    const required = fields.filter(field => field !== 'netInflow5d')
    const ready = new Set<string>()
    const rows = this.db.sqlite.prepare("SELECT key,value FROM app_settings WHERE key LIKE 'stock-data.metrics.%'").all() as Array<{ key: string; value: string }>
    for (const row of rows) {
      try {
        const facts = factsSchema.parse(JSON.parse(row.value))
        if (required.every(field => facts[field] && currentFact(field, facts[field]!, asOf)
          && Date.now() - Date.parse(facts[field]!.fetchedAt) < 6 * 3600000)) ready.add(row.key.slice('stock-data.metrics.'.length))
      } catch { /* Invalid local facts are a preparation gap, not a reusable success. */ }
    }
    return ready
  }

  write(code: string, input: StockQuoteMetricsData | null, primary: Record<string, ScreeningFact> = {}): void {
    if (!/^\d{6}$/.test(code)) throw new Error('本地指标代码无效')
    const saved = this.db.getSetting(key(code))
    let facts: Facts = {}
    if (saved) {
      try { facts = factsSchema.parse(JSON.parse(saved)) }
      catch { /* Keep the saved value unless a validated new response can replace the invalid facts. */ }
    }
    let updates = 0
    const add = (field: string, value: number | string | null | undefined, meta: ProviderMeta | null | undefined, reportDate: string | null = null) => {
      if (value == null || !meta || !['fresh', 'cached'].includes(meta.cacheState) || !meta.sourceTimestamp || !Number.isFinite(Date.parse(meta.fetchedAt))) return
      const date = meta.sourceTimestamp.slice(0, 10)
      if (Date.parse(meta.fetchedAt) > Date.now() || !isMarketDate(date) || date > beijingMarketDate(Date.now()) || (reportDate !== null && !isMarketDate(reportDate))) return
      const fact = factSchema.parse({ value, source: meta.providerId, date, reportDate, fetchedAt: meta.fetchedAt })
      if (facts[field]?.source === 'baostock' && facts[field]!.date >= fact.date
        && Date.now() - Date.parse(facts[field]!.fetchedAt) < 6 * 3600000) { updates++; return }
      if (!facts[field] || facts[field]!.fetchedAt <= fact.fetchedAt) { facts[field] = fact; updates++ }
    }
    const q = input?.quote, m = input?.metrics
    if ((q && q.code !== code) || (m && m.code !== code)) throw new Error('本地指标股票标识不匹配')
    const quoteMeta = input?.sources.quote ?? q?.meta
    add('price', q?.price, quoteMeta); add('changePct', q?.changePct, quoteMeta)
    add('marketCap', q?.marketCap == null ? null : q.marketCap / 1e8, quoteMeta)
    add('pb', q?.pb, quoteMeta)
    if (m) {
      const report = m.reportDate ?? null, meta = input?.sources.metrics ?? m.meta
      const industryMeta = input?.sources.industry
      // Classification has an observation time, not a quarterly financial-report period.
      add('industry', m.industry, industryMeta ? { ...industryMeta, sourceTimestamp: industryMeta.fetchedAt } : null)
      for (const [field, value] of Object.entries({ roe: m.roe, profitGrowth: m.netProfitYoy, revenueGrowth: m.revenueYoy,
        grossMargin: m.grossMargin, netMargin: m.netMargin })) { if (report) add(field, value, meta, report) }
      // TTM valuation and dividend yield also depend on a dated quote, not only a report.
      if (quoteMeta && meta && ['fresh', 'cached'].includes(meta.cacheState)) {
        const valuationMeta = { ...quoteMeta, providerId: `${quoteMeta.providerId}+${meta.providerId}` }
        add('pe', m.peTtm, valuationMeta, report); add('dividendYield', m.dividendYield, valuationMeta)
      }
    }
    for (const [field, fact] of Object.entries(factsSchema.parse(primary))) {
      if (fact.source !== 'baostock' || Date.parse(fact.fetchedAt) > Date.now() || fact.date > beijingMarketDate(Date.now())) throw new Error('BaoStock 主源事实来源或时间无效')
      if (!facts[field] || facts[field]!.date <= fact.date) { facts[field] = fact; updates++ }
    }
    if (!updates) throw new Error('未取得可持久化的有效指标，保留已有数据')
    this.db.setSetting(key(code), JSON.stringify(facts))
  }

  async query(input: MarketScanQuery): Promise<MarketScanResult> {
    const invalid = scanQueryError(input); if (invalid) throw new Error(invalid)
    const query = normalizeScanQuery(input)
    if (query.ranges.netInflow5d) throw new Error('本地尚无可核实的5日主力净流序列，不能执行该条件')
    let result = this.read(query)
    if (query.page === 1 && this.prepare && (!result || !this.baseline().ready || (result.data?.coverage?.unverified ?? 0) > 0)
      && (!this.baseline().ready || Date.now() - this.preparedAt >= 6 * 3600000)) {
      this.preparing ??= this.prepare().then(() => { this.preparedAt = Date.now() }).finally(() => { this.preparing = undefined })
      await this.preparing
      result = this.read(query)
    }
    return result ?? { data: null, historical: false, error: '本地证券名录为空，请在设置与诊断同步选股数据' }
  }

  private read(query: MarketScanQuery): MarketScanResult | null {
    const universe = this.db.screeningUniverse()
    if (!universe.length) return null
    const { asOf } = this.baseline()
    const snapshots = new Map((this.db.sqlite.prepare("SELECT key, value FROM app_settings WHERE key LIKE 'stock-data.metrics.%' ORDER BY key").all() as Array<{ key: string; value: string }>).map(row => [row.key, row.value]))
    const revision = createHash('sha256').update(JSON.stringify(universe)).update(JSON.stringify([...snapshots])).digest('hex')
    const cacheKey = JSON.stringify({ ...query, page: 1, asOf, revision, day: beijingMarketDate(Date.now()) })
    if (this.cached?.key === cacheKey) return this.page(this.cached.data, query)
    let unverified = 0, sortMissing = 0
    const stocks: MarketScanStock[] = [], missing = new Set<string>()
    const used = universe.filter(row => !query.search || row.code.includes(query.search) || row.name.includes(query.search))
    for (const identity of used) {
      const saved = snapshots.get(key(identity.code)), facts = saved ? factsSchema.parse(JSON.parse(saved)) : {}
      const stock = { ...Object.fromEntries(fields.map(field => [field, null])), ...identity } as unknown as MarketScanStock
      for (const [field, fact] of Object.entries(facts)) {
        // Old facts remain stored, but cannot silently become this round's current input.
        if (currentFact(field, fact, asOf)) (stock as unknown as Record<string, unknown>)[field] = fact.value
      }
      stock.facts = Object.fromEntries(Object.entries(facts).filter(([key]) => (stock as unknown as Record<string, unknown>)[key] != null))
      const required = [...Object.keys(query.ranges), ...(query.industries?.length ? ['industry'] : [])]
      const absent = required.filter(field => (stock as unknown as Record<string, unknown>)[field] == null)
      if (absent.length) { unverified++; absent.forEach(field => missing.add(field)); continue }
      if (query.industries?.length && !query.industries.includes(stock.industry!)) continue
      if (Object.entries(query.ranges).some(([field, range]) => {
        const value = stock[field as keyof typeof SCAN_FIELDS]!
        return (range.min !== undefined && value < range.min) || (range.max !== undefined && value > range.max)
      })) continue
      if (stock[query.sort] == null) sortMissing++
      stocks.push(stock)
    }
    stocks.sort((a, b) => {
      const av = a[query.sort], bv = b[query.sort]
      if (av == null || bv == null) return av == null && bv == null ? a.code.localeCompare(b.code) : av == null ? 1 : -1
      const order = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))
      return (query.order === 'asc' ? order : -order) || a.code.localeCompare(b.code)
    })
    const catalogueAt = universe.map(row => row.updatedAt).sort().at(-1)!
    const data: MarketScanData = { query, total: stocks.length, stocks,
      revision, snapshotDate: beijingMarketDate(Date.parse(catalogueAt)), collectedOn: beijingMarketDate(Date.now()),
      coverage: { universe: used.length, unverified, missingFields: [...missing].sort(), sortMissing },
      meta: { providerId: 'local-screening', sourceName: '本地证券名录＋公开报价/财报；ROE及增长率为最新报告累计口径',
        sourceTimestamp: catalogueAt, fetchedAt: new Date().toISOString(), cacheState: 'cached' } }
    this.cached = { key: cacheKey, data }
    return this.page(data, query)
  }
  private page(data: MarketScanData, query: MarketScanQuery): MarketScanResult {
    return { error: null, historical: false, data: { ...data, query, stocks: data.stocks.slice((query.page - 1) * 100, query.page * 100) } }
  }
  private baseline(): { asOf: string; ready: boolean } {
    const through = defaultMacroRange().to, saved = this.db.getSetting('stock-data.calendar')
    if (saved) {
      try {
        const data = z.object({ through: z.string().refine(isMarketDate), dates: z.array(z.string().refine(isMarketDate)).min(1).max(1000) }).parse(JSON.parse(saved))
        const dates = data.dates.filter(date => date <= through), asOf = dates.at(-1)
        if (data.through >= through && asOf && Date.parse(through) - Date.parse(asOf) <= 15 * 86400000
          && dates.every((date, i) => !i || date > dates[i - 1]!)) return { asOf, ready: true }
      } catch { /* Preparation repairs invalid local calendars. */ }
    }
    return { asOf: through, ready: false }
  }
}
