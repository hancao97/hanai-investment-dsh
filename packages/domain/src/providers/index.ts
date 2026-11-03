import type {
  DashboardData,
  KLinePeriod,
  ProviderMeta,
  SearchResult,
  SecurityMaster,
  StockDetail,
  StockKLineData,
  StockQuoteMetricsData,
  StockQuote,
  StockTrendData,
  StockValuationData,
  TradingDayAnalysisData,
  TradingDayContextData,
  TradingDayDragonTigerData,
  TradingDayLimitPoolsData,
  TradingDayThemesData,
} from '../../../contracts/src/index.ts'
import type { HanaiDatabase } from '../database.ts'
import { isoNow, NodeFetchHttpClient, systemClock, type Clock, type HttpClient } from '../http.ts'
import { SecuritiesService } from '../securities.ts'
import { EastmoneyProvider, type EastmoneyProviderOptions } from './eastmoney.ts'
import {
  FileValuationCache,
  GuruFocusProvider,
  MemoryValuationCache,
  type GuruFocusProviderOptions,
} from './gurufocus.ts'
import { TencentProvider } from './tencent.ts'
import { SinaProvider } from './sina.ts'
import { EastmoneyFinancialProvider } from './financials.ts'
import { TradingDayProvider } from './trading-day.ts'
import { SourceCircuit, type SourceCircuitOptions, type SourceId } from './source-circuit.ts'

export { EastmoneyProvider, type EastmoneyProviderOptions } from './eastmoney.ts'
export {
  FileValuationCache,
  GuruFocusProvider,
  MemoryValuationCache,
  VALUATION_RANK_LABELS,
  type GuruFocusProviderOptions,
  type ValuationCache,
  type ValuationCacheEntry,
} from './gurufocus.ts'
export { TencentProvider, tencentSymbol } from './tencent.ts'
export { SinaProvider } from './sina.ts'
export { EastmoneyFinancialProvider } from './financials.ts'
export { TradingDayProvider, type TradingDayProviderOptions } from './trading-day.ts'
export { SourceCircuit, SourceCircuitOpenError, SOURCE_PRIORITY, type SourceId } from './source-circuit.ts'

export interface MarketDataServiceOptions {
  http?: HttpClient
  clock?: Clock
  valuationCacheDir?: string
  timeoutMs?: number
  eastmoney?: Omit<EastmoneyProviderOptions, 'clock' | 'tencent'>
  gurufocus?: Omit<GuruFocusProviderOptions, 'clock' | 'cache'>
  /** 数据源熔断参数；默认连续 3 次失败跳过 5 分钟。 */
  circuit?: Omit<SourceCircuitOptions, 'clock'>
}

function inferredSecurity(secId: string): Pick<SecurityMaster, 'exchange' | 'code'> {
  const [market, code = ''] = secId.split('.')
  const exchange = market === '1'
    ? 'SH'
    : code.startsWith('4') || code.startsWith('8') || code.startsWith('9') ? 'BJ' : 'SZ'
  return { exchange, code }
}

async function optional<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise
  } catch {
    return null
  }
}

/** Facade consumed by the Host; all external transport and time are injectable for deterministic tests. */
export class MarketDataService {
  readonly eastmoney: EastmoneyProvider
  readonly tencent: TencentProvider
  readonly gurufocus: GuruFocusProvider
  readonly sina: SinaProvider
  readonly financials: EastmoneyFinancialProvider
  readonly tradingDay: TradingDayProvider
  private readonly clock: Clock
  private readonly circuit: SourceCircuit

  constructor(options: MarketDataServiceOptions = {}) {
    const http = options.http ?? new NodeFetchHttpClient()
    this.clock = options.clock ?? systemClock
    this.circuit = new SourceCircuit({ ...options.circuit, clock: this.clock })
    this.tencent = new TencentProvider(http, this.clock, options.timeoutMs ?? 10_000)
    this.sina = new SinaProvider(http, this.clock, options.timeoutMs ?? 10_000)
    this.financials = new EastmoneyFinancialProvider(http, this.clock, options.timeoutMs ?? 10_000)
    this.eastmoney = new EastmoneyProvider(http, {
      ...options.eastmoney,
      clock: this.clock,
      tencent: this.tencent,
      timeoutMs: options.eastmoney?.timeoutMs ?? options.timeoutMs ?? 8_000,
    })
    const cache = options.valuationCacheDir === undefined
      ? new MemoryValuationCache()
      : new FileValuationCache(options.valuationCacheDir)
    this.gurufocus = new GuruFocusProvider(http, {
      ...options.gurufocus,
      clock: this.clock,
      cache,
      timeoutMs: options.gurufocus?.timeoutMs ?? options.timeoutMs ?? 15_000,
    })
    this.tradingDay = new TradingDayProvider(http, {
      clock: this.clock,
      timeoutMs: options.timeoutMs ?? 12_000,
    })
  }

  /** 包住单个数据源调用：熔断期间直接跳过，异常计入该源失败次数。 */
  private async callSource<T>(source: SourceId, task: () => Promise<T>): Promise<T | null> {
    try {
      return await this.circuit.run(source, task)
    } catch {
      return null
    }
  }

  async getDashboard(): Promise<DashboardData> {
    const [overview, industry, concept, gainers, losers, amount, turnover] = await Promise.all([
      this.callSource('eastmoney-push2his', () => this.eastmoney.getMarketOverview()),
      this.getSectorBoard('industry'),
      this.getSectorBoard('concept'),
      this.getRankList('gainers'),
      this.getRankList('losers'),
      this.getRankList('amount'),
      this.getRankList('turnover'),
    ])
    return {
      overview: overview ?? {
        indices: [],
        breadth: { up: null, down: null, flat: null, limitUp: null, limitDown: null, totalAmount: null },
        marketStatus: 'unknown',
        meta: this.unavailableMeta(),
      },
      industry: industry ?? { type: 'industry', sectors: [], meta: this.unavailableMeta() },
      concept: concept ?? { type: 'concept', sectors: [], meta: this.unavailableMeta() },
      ranks: {
        gainers: gainers?.entries ?? [],
        losers: losers?.entries ?? [],
        amount: amount?.entries ?? [],
        turnover: turnover?.entries ?? [],
      },
      rankSources: {
        gainers: gainers?.meta ?? this.unavailableMeta(), losers: losers?.meta ?? this.unavailableMeta(),
        amount: amount?.meta ?? this.unavailableMeta(), turnover: turnover?.meta ?? this.unavailableMeta(),
      },
    }
  }

  private async getSectorBoard(type: 'industry' | 'concept') {
    const primary = await this.callSource('eastmoney-push2his', () => this.eastmoney.getSectorBoard(type))
    if (primary !== null && primary.sectors.some(sector => sector.amount !== null && sector.amount > 0)) return primary
    return await this.callSource('sina', () => this.sina.getSectorBoard(type)) ?? primary
  }

  private async getRankList(kind: 'gainers' | 'losers' | 'amount' | 'turnover') {
    const primary = await this.callSource('eastmoney-push2his', () => this.eastmoney.getRankList(kind))
    if (primary !== null && primary.entries.length > 0) return primary
    return await this.callSource('sina', () => this.sina.getRankList(kind)) ?? primary
  }

  async getSectorStocks(sectorCode: string): Promise<{ stocks: StockQuote[]; meta: ProviderMeta }> {
    if (sectorCode.startsWith('SINA:')) {
      return await this.callSource('sina', () => this.sina.getSectorStocks(sectorCode))
        ?? { stocks: [], meta: this.unavailableMeta('sina-fallback', '新浪行情（备源）') }
    }
    return await this.callSource('eastmoney-push2his', () => this.eastmoney.getSectorStocks(sectorCode))
      ?? { stocks: [], meta: this.unavailableMeta() }
  }

  async getStockDetail(secId: string, security?: SecurityMaster | null): Promise<StockDetail> {
    const [quoteMetrics, trend, daily, weekly, monthly, valuation] = await Promise.all([
      optional(this.getStockQuoteMetrics(secId)),
      optional(this.getTrend(secId)),
      optional(this.getKline(secId, 'daily')),
      optional(this.getKline(secId, 'weekly')),
      optional(this.getKline(secId, 'monthly')),
      optional(this.getValuation(secId, security)),
    ])
    return {
      security: security ?? null,
      quote: quoteMetrics?.quote ?? null,
      metrics: quoteMetrics?.metrics ?? null,
      trend: trend?.trend ?? [],
      trendPrevClose: trend?.trendPrevClose ?? null,
      daily: daily?.bars ?? [],
      weekly: weekly?.bars ?? [],
      monthly: monthly?.bars ?? [],
      valuation: valuation?.valuation ?? null,
      sources: {
        quote: quoteMetrics?.sources.quote ?? null,
        metrics: quoteMetrics?.sources.metrics ?? null,
        trend: trend?.meta ?? null,
        daily: daily?.meta ?? null,
        weekly: weekly?.meta ?? null,
        monthly: monthly?.meta ?? null,
        valuation: valuation?.meta ?? null,
      },
    }
  }

  async getStockQuoteMetrics(secId: string): Promise<StockQuoteMetricsData> {
    const [quotes, primaryMetrics] = await Promise.all([
      optional(this.getQuotes([secId])),
      this.callSource('eastmoney-push2his', () => this.eastmoney.getStockMetrics(secId)),
    ])
    const quote = quotes?.quotes.find(item => item.secId === secId) ?? null
    if (primaryMetrics === null && quote !== null && quote.meta?.providerId !== 'tencent-fallback') {
      await this.tencent.getQuotes([secId])
    }
    const base = primaryMetrics ?? (quote === null ? null : this.tencent.getQuoteMetrics(secId))
    const metrics = await this.financials.getStockMetrics(secId, quote, base)
    return {
      quote,
      metrics,
      sources: {
        quote: quote === null ? null : quote.meta ?? quotes?.meta ?? null,
        metrics: metrics?.meta ?? null,
      },
    }
  }

  async getTrend(secId: string): Promise<StockTrendData> {
    // 东财不可用时按熔断顺序切到腾讯分时。
    const result = await this.callSource('eastmoney-push2his', () => this.eastmoney.getTrend(secId))
      ?? await this.callSource('tencent', () => this.tencent.getTrend(secId))
    return {
      trend: result?.points ?? [],
      trendPrevClose: result?.prevClose ?? null,
      meta: result?.meta ?? null,
    }
  }

  async getKline(secId: string, period: KLinePeriod, before?: string): Promise<StockKLineData> {
    const klt = period === 'daily' ? '101' : period === 'weekly' ? '102' : '103'
    // 东财不可用时按熔断顺序切到腾讯 K 线。
    const result = await this.callSource('eastmoney-push2his', () => this.eastmoney.getKline(secId, klt, before))
      ?? await this.callSource('tencent', () => this.tencent.getKline(secId, klt, before))
    return {
      period,
      bars: result?.bars ?? [],
      meta: result?.meta ?? null,
      hasMore: period === 'daily' && (result?.hasMore ?? true),
    }
  }

  async getValuation(secId: string, security?: SecurityMaster | null): Promise<StockValuationData> {
    const identity = security ?? inferredSecurity(secId)
    const valuation = await optional(this.gurufocus.getValuation(identity.exchange, identity.code))
    return {
      valuation,
      meta: valuation?.meta ?? null,
    }
  }

  async getQuotes(secIds: readonly string[]): Promise<{ quotes: StockQuote[]; meta: ProviderMeta }> {
    // 东财熔断时跳过主源，直接按顺序切到腾讯。
    const primary = await this.callSource('eastmoney-push2his', () => this.eastmoney.getQuotes(secIds))
    const available = new Map((primary?.quotes ?? []).map(quote => [quote.secId, quote]))
    const missing = secIds.filter(id => available.get(id)?.price == null || primary?.meta.providerId.includes('memory-cache'))
    if (missing.length === 0 && primary !== null) return primary
    const fallback = await this.callSource('tencent', () => this.tencent.getQuotes(missing))
      ?? { quotes: [], meta: this.unavailableMeta('tencent-fallback', '腾讯行情（备源）') }
    if (fallback.quotes.length === 0) return primary ?? { quotes: [], meta: this.unavailableMeta() }
    for (const quote of fallback.quotes) available.set(quote.secId, quote)
    const quotes = secIds.flatMap(id => available.has(id) ? [available.get(id)!] : [])
    if (quotes.every(quote => quote.meta?.providerId === fallback.meta.providerId)) return { quotes, meta: fallback.meta }
    return {
      quotes,
      meta: {
        ...fallback.meta,
        providerId: 'eastmoney-tencent-mixed',
        sourceName: '东方财富 / 腾讯行情（备源）',
        cacheState: primary?.meta.cacheState === 'fresh' && fallback.meta.cacheState === 'fresh' ? 'fresh' : 'stale',
      },
    }
  }

  private unavailableMeta(providerId = 'eastmoney', sourceName = '东方财富'): ProviderMeta {
    return { providerId, sourceName, sourceTimestamp: null, fetchedAt: isoNow(this.clock), cacheState: 'unavailable' }
  }

  clearMarketCache(): number {
    return this.eastmoney.clearQuoteCache() + this.tencent.clearQuoteMetrics() + this.sina.clearCache()
      + this.financials.clearCache() + this.tradingDay.clearCache()
  }

  tradingDayContext(): Promise<TradingDayContextData> {
    return this.tradingDay.tradingDayContext()
  }

  tradingDayLimitPools(): Promise<TradingDayLimitPoolsData> {
    return this.tradingDay.tradingDayLimitPools()
  }

  tradingDayThemes(): Promise<TradingDayThemesData> {
    return this.tradingDay.tradingDayThemes()
  }

  tradingDayDragonTiger(): Promise<TradingDayDragonTigerData> {
    return this.tradingDay.tradingDayDragonTiger()
  }

  tradingDayAnalysis(): Promise<TradingDayAnalysisData> {
    return this.tradingDay.tradingDayAnalysis()
  }

  syncSecurities(
    database: HanaiDatabase,
    force = false,
  ): Promise<{ count: number; updatedAt: string | null }> {
    return new SecuritiesService(database, this.eastmoney, { clock: this.clock }).sync(force)
  }

  searchSecurities(database: HanaiDatabase, query: string): Promise<SearchResult[]> {
    return new SecuritiesService(database, this.eastmoney, { clock: this.clock }).search(query)
  }
}
