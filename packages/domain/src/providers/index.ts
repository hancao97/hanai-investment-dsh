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
} from '../../../contracts/src/index.ts'
import type { HanaiDatabase } from '../database.ts'
import { NodeFetchHttpClient, systemClock, type Clock, type HttpClient } from '../http.ts'
import { SecuritiesService } from '../securities.ts'
import { EastmoneyProvider, type EastmoneyProviderOptions } from './eastmoney.ts'
import {
  FileValuationCache,
  GuruFocusProvider,
  MemoryValuationCache,
  type GuruFocusProviderOptions,
} from './gurufocus.ts'
import { TencentProvider } from './tencent.ts'

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

export interface MarketDataServiceOptions {
  http?: HttpClient
  clock?: Clock
  valuationCacheDir?: string
  timeoutMs?: number
  eastmoney?: Omit<EastmoneyProviderOptions, 'clock' | 'tencent'>
  gurufocus?: Omit<GuruFocusProviderOptions, 'clock' | 'cache'>
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
  private readonly clock: Clock

  constructor(options: MarketDataServiceOptions = {}) {
    const http = options.http ?? new NodeFetchHttpClient()
    this.clock = options.clock ?? systemClock
    this.tencent = new TencentProvider(http, this.clock, options.timeoutMs ?? 10_000)
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
  }

  async getDashboard(): Promise<DashboardData> {
    const [overview, industry, concept, gainers, losers, amount, turnover] = await Promise.all([
      this.eastmoney.getMarketOverview(),
      this.eastmoney.getSectorBoard('industry'),
      this.eastmoney.getSectorBoard('concept'),
      this.eastmoney.getRankList('gainers'),
      this.eastmoney.getRankList('losers'),
      this.eastmoney.getRankList('amount'),
      this.eastmoney.getRankList('turnover'),
    ])
    return {
      overview,
      industry,
      concept,
      ranks: {
        gainers: gainers.entries,
        losers: losers.entries,
        amount: amount.entries,
        turnover: turnover.entries,
      },
    }
  }

  getSectorStocks(sectorCode: string): Promise<{ stocks: StockQuote[]; meta: ProviderMeta }> {
    return this.eastmoney.getSectorStocks(sectorCode)
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
    const [quotes, metrics] = await Promise.all([
      optional(this.eastmoney.getQuotes([secId])),
      optional(this.eastmoney.getStockMetrics(secId)),
    ])
    return {
      quote: quotes?.quotes.find(item => item.secId === secId) ?? null,
      metrics,
      sources: {
        quote: quotes?.meta ?? null,
        metrics: metrics?.meta ?? null,
      },
    }
  }

  async getTrend(secId: string): Promise<StockTrendData> {
    const result = await optional(this.eastmoney.getTrend(secId))
    return {
      trend: result?.points ?? [],
      trendPrevClose: result?.prevClose ?? null,
      meta: result?.meta ?? null,
    }
  }

  async getKline(secId: string, period: KLinePeriod, before?: string): Promise<StockKLineData> {
    const klt = period === 'daily' ? '101' : period === 'weekly' ? '102' : '103'
    const result = await optional(this.eastmoney.getKline(secId, klt, before))
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

  getQuotes(secIds: readonly string[]): Promise<{ quotes: StockQuote[]; meta: ProviderMeta }> {
    return this.eastmoney.getQuotes(secIds)
  }

  clearMarketCache(): number {
    return this.eastmoney.clearQuoteCache()
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
