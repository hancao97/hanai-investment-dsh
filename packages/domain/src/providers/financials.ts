import type { ProviderMeta, StockMetrics, StockQuote } from '../../../contracts/src/index.ts'
import { fetchJson, isoNow, systemClock, type Clock, type HttpClient } from '../http.ts'
import { ProviderCache } from './cache.ts'
import { finiteNumber, metricsFromQuote } from './metrics.ts'
import { tencentSymbol } from './tencent.ts'

type Row = Record<string, unknown>
interface ReportData { rows: Row[]; count: number | null; meta: ProviderMeta }
interface Envelope { success?: boolean; result?: { data?: unknown; count?: unknown } | null }
const HEADERS = { Referer: 'https://data.eastmoney.com/' }

function reportDate(row: Row, field = 'REPORT_DATE'): string | null {
  const value = row[field]
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?: |$)/.test(value) ? value.slice(0, 10) : null
}

function divide(numerator: number | null, denominator: number | null): number | null {
  return numerator === null || denominator === null || denominator === 0 ? null : numerator / denominator
}

/** Financial reports use a separate data-center host, independent of realtime quote breakers. */
export class EastmoneyFinancialProvider {
  private readonly reports: ProviderCache<ReportData>
  private readonly dividends: ProviderCache<ReportData>

  constructor(private readonly http: HttpClient, private readonly clock: Clock = systemClock, private readonly timeoutMs = 10_000) {
    this.reports = new ProviderCache(clock, 6 * 60 * 60_000)
    this.dividends = new ProviderCache(clock, 6 * 60 * 60_000)
  }

  private async load(secId: string, dividend: boolean): Promise<ReportData> {
    const symbol = tencentSymbol(secId)
    const identity = `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`
    const params = new URLSearchParams({
      reportName: dividend ? 'RPT_SHAREBONUS_DET' : 'RPT_F10_FINANCE_MAINFINADATA', columns: 'ALL',
      filter: `(SECUCODE="${identity}")`, pageNumber: '1', pageSize: dividend ? '100' : '8',
      sortColumns: dividend ? 'EX_DIVIDEND_DATE' : 'REPORT_DATE', sortTypes: '-1', source: 'HSF10', client: 'PC',
    })
    const host = dividend ? 'https://datacenter-web.eastmoney.com/api/data/v1/get'
      : 'https://datacenter.eastmoney.com/securities/api/data/v1/get'
    const response = await fetchJson<Envelope>(this.http, `${host}?${params}`, { timeoutMs: this.timeoutMs, headers: HEADERS })
    if (!response.ok || response.data?.success !== true || !Array.isArray(response.data.result?.data)) throw new Error('财报接口不可用')
    const rows = response.data.result.data.filter((row): row is Row => row !== null && typeof row === 'object'
      && row.SECURITY_CODE === secId.slice(2) && row.SECUCODE === identity)
    if (rows.length !== response.data.result.data.length) throw new Error('财报股票标识不匹配')
    if (!dividend && rows.length === 0) throw new Error('未返回该股票财报')
    return {
      rows, count: finiteNumber(response.data.result.count),
      meta: { providerId: 'eastmoney-financials', sourceName: '东方财富财报',
        sourceTimestamp: rows[0] === undefined ? null : reportDate(rows[0]), fetchedAt: isoNow(this.clock), cacheState: 'fresh' },
    }
  }

  private trailing(rows: Row[], latest: Row, field: string): number | null {
    const date = reportDate(latest)
    const current = finiteNumber(latest[field])
    if (date === null || current === null) return null
    if (date.endsWith('12-31')) return current
    const previousYear = String(Number(date.slice(0, 4)) - 1)
    const annual = rows.find(row => reportDate(row) === `${previousYear}-12-31`)
    const prior = rows.find(row => reportDate(row) === `${previousYear}${date.slice(4)}`)
    const annualValue = finiteNumber(annual?.[field])
    const priorValue = finiteNumber(prior?.[field])
    return annualValue === null || priorValue === null ? null : current + annualValue - priorValue
  }

  private dividendYield(data: ReportData | null, price: number | null, asOf: string): number | null {
    if (data === null || price === null || price <= 0) return null
    const start = `${Number(asOf.slice(0, 4)) - 1}${asOf.slice(4)}`
    const events = data.rows.filter(row => row.ASSIGN_PROGRESS === '实施分配' && reportDate(row, 'EX_DIVIDEND_DATE') !== null
      && reportDate(row, 'EX_DIVIDEND_DATE')! <= asOf)
    // Refuse to infer zero when a truncated response cannot cover the trailing year.
    if (data.count !== null && data.count > data.rows.length && !events.some(row => reportDate(row, 'EX_DIVIDEND_DATE')! <= start)) return null
    let cash = 0
    for (const row of events) {
      const date = reportDate(row, 'EX_DIVIDEND_DATE')!
      if (date <= start) continue
      const perTenShares = finiteNumber(row.PRETAX_BONUS_RMB)
      if (perTenShares === null || perTenShares < 0) return null
      const splitFactor = events.filter(event => reportDate(event, 'EX_DIVIDEND_DATE')! > date).reduce((factor, event) =>
        factor * (1 + (finiteNumber(event.BONUS_RATIO) ?? 0) / 10 + (finiteNumber(event.IT_RATIO) ?? 0) / 10), 1)
      cash += perTenShares / 10 / splitFactor
    }
    return cash / price * 100
  }

  async getStockMetrics(secId: string, quote: StockQuote | null, base: StockMetrics | null): Promise<StockMetrics | null> {
    const [reports, dividends] = await Promise.all([
      this.reports.get(secId, () => this.load(secId, false)),
      this.dividends.get(secId, () => this.load(secId, true)),
    ])
    const rows = reports?.rows.filter(row => {
      const date = reportDate(row)
      return date !== null && /-(?:03-31|06-30|09-30|12-31)$/.test(date) && date <= isoNow(this.clock).slice(0, 10)
    }).sort((a, b) => reportDate(b)!.localeCompare(reportDate(a)!)) ?? []
    const latest = rows[0]
    if (reports === null || latest === undefined) return base
    const date = reportDate(latest)!
    const metrics = base ?? metricsFromQuote(secId, quote, reports.meta)
    const price = quote?.price ?? metrics.price
    const cap = quote?.marketCap ?? metrics.marketCap
    const annual = rows.find(row => reportDate(row) === `${Number(date.slice(0, 4)) - (date.endsWith('12-31') ? 0 : 1)}-12-31`)
    const profit = finiteNumber(latest.PARENTNETPROFIT)
    const quarter = Number(date.slice(5, 7)) / 3
    const annualized = profit === null ? null : profit * 4 / quarter
    return {
      ...metrics,
      name: typeof latest.SECURITY_NAME_ABBR === 'string' ? latest.SECURITY_NAME_ABBR : metrics.name,
      peDynamic: divide(cap, annualized), peStatic: divide(cap, finiteNumber(annual?.PARENTNETPROFIT)),
      peTtm: divide(cap, this.trailing(rows, latest, 'PARENTNETPROFIT')),
      psTtm: divide(cap, this.trailing(rows, latest, 'TOTALOPERATEREVE')),
      pb: quote?.pb ?? metrics.pb ?? divide(price, finiteNumber(latest.BPS)),
      totalShares: metrics.totalShares ?? finiteNumber(latest.TOTAL_SHARE),
      floatShares: metrics.floatShares ?? finiteNumber(latest.A_FREE_SHARE),
      eps: finiteNumber(latest.EPSJB), bvps: finiteNumber(latest.BPS), roe: finiteNumber(latest.ROEJQ),
      totalRevenue: finiteNumber(latest.TOTALOPERATEREVE), revenueYoy: finiteNumber(latest.TOTALOPERATEREVETZ),
      netProfit: profit, netProfitYoy: finiteNumber(latest.PARENTNETPROFITTZ),
      grossMargin: finiteNumber(latest.XSMLL), netMargin: finiteNumber(latest.XSJLL), debtRatio: finiteNumber(latest.ZCFZL),
      dividendYield: this.dividendYield(dividends, price, quote?.meta?.sourceTimestamp?.slice(0, 10) ?? isoNow(this.clock).slice(0, 10)),
      reportDate: date, reportName: typeof latest.REPORT_DATE_NAME === 'string' ? latest.REPORT_DATE_NAME : null,
      meta: { ...reports.meta, sourceTimestamp: date, cacheState: dividends?.meta.cacheState === 'stale' ? 'stale' : reports.meta.cacheState },
    }
  }

  clearCache(): number { return this.reports.clear() + this.dividends.clear() }
}
