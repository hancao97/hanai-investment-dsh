import { MarketLadderProvider } from './market-ladder.ts'
import { TechnicalScreenProvider } from './technical-screen.ts'
import { PacedHttpClient } from './paced-http.ts'
import { BaoStockProvider } from './baostock.ts'
import type { MacroRange } from '../../../contracts/src/macro-range.ts'
import type { MacroIndicatorId } from '../../../contracts/src/macro-indicators.ts'
import { MacroIndicatorProvider } from './macro-indicators.ts'
import { fetchArms } from './market-arms.ts'
import { fetchDistribution } from './market-distribution.ts'
import type { MarketDistributionData } from '../../../contracts/src/market-distribution.ts'
import type { MarketArmsData } from '../../../contracts/src/market-arms.ts'
import type {
  DashboardData,
  KLinePeriod,
  MarketOverview,
  ProviderMeta,
  SearchResult,
  SourceDiagnostic,
  SecurityMaster,
  StockDetail,
  StockKLineData,
  StockQuoteMetricsData,
  StockQuote,
  StockTrendData,
  StockValuationData,
} from '../../../contracts/src/index.ts'
import type { HanaiDatabase } from '../database.ts'
import { isoNow, NodeFetchHttpClient, systemClock, type Clock, type HttpClient } from '../http.ts'
import { SecuritiesService, SECURITY_SOURCE_SETTING } from '../securities.ts'
import { EastmoneyProvider, type EastmoneyProviderOptions, type EastmoneySecurityRow } from './eastmoney.ts'
import {
  FileValuationCache,
  GuruFocusProvider,
  MemoryValuationCache,
  type GuruFocusProviderOptions,
} from './gurufocus.ts'
import { TencentProvider } from './tencent.ts'
import { SinaProvider } from './sina.ts'
import { EastmoneyFinancialProvider } from './financials.ts'
import { ProviderCache } from './cache.ts'
import { leguBreadth, type BreadthSnapshot } from './market-breadth.ts'
import { SourceCircuit, type SourceCircuitOptions, type SourceId } from './source-circuit.ts'
import { DOMESTIC_INDICES } from '../../../contracts/src/market-indices.ts'
import { GlobalIndexProvider } from './global-indices.ts'
import { MarketMacroInputs } from './market-macro-inputs.ts'
import { MarketMacroAllDailyProvider } from './market-macro-all-daily.ts'
import { MarketMacroAllProvider } from './market-macro-all.ts'
import { MarketMacroCapitalProvider } from './market-macro-capital.ts'
import { MarketMacroCapitalReferenceProvider } from './market-macro-capital-reference.ts'
import { MarketMacroDailyProvider } from './market-macro-daily.ts'
import type { MacroAllDailyData, MacroEtfInputs, MacroCapitalData, MacroDailyEtfData } from '../../../contracts/src/market-macro.ts'
import { MarketMacroProvider } from './market-macro.ts'
import { MarketActivityProvider } from './market-activity.ts'
import { MarketScanProvider } from './market-scan.ts'
import type { MarketScanQuery } from '../../../contracts/src/market-scan.ts'

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
  readonly technicalScreen: TechnicalScreenProvider
  getTechnicalCalendar(through: string, signal: AbortSignal) { return this.technicalScreen.calendar(through, signal) }
  getTechnicalBars(code: string, adjust: 'qfq' | 'none', asOf: string, signal: AbortSignal) { return this.technicalScreen.bars(code, adjust, asOf, signal) }
  getTechnicalHistory(code: string, adjust: 'qfq' | 'none', asOf: string, signal: AbortSignal, limit?: number) { return this.technicalScreen.history(code, adjust, asOf, signal, limit) }
  private readonly scan: MarketScanProvider
  getMarketScan(query: MarketScanQuery, refresh = false) { return this.scan.get(query, refresh) }
  private readonly macroIndicators: MacroIndicatorProvider
  getMacroIndicator(id: MacroIndicatorId, range: MacroRange, signal?: AbortSignal) { return this.macroIndicators.get(id, range, signal) }
  readonly macroInputs: MarketMacroInputs
  readonly macroAllDaily: MarketMacroAllDailyProvider
  readonly macroAll: MarketMacroAllProvider
  readonly macroCapital: MarketMacroCapitalProvider
  readonly macroDaily: MarketMacroDailyProvider
  readonly macro: MarketMacroProvider
  readonly activity: MarketActivityProvider
  readonly ladder: MarketLadderProvider
  readonly globalIndices: GlobalIndexProvider
  readonly eastmoney: EastmoneyProvider
  readonly tencent: TencentProvider
  readonly gurufocus: GuruFocusProvider
  readonly sina: SinaProvider
  readonly financials: EastmoneyFinancialProvider
  readonly baostock: BaoStockProvider
  private readonly preparationTencent: TencentProvider
  private readonly preparationEastmoney: EastmoneyProvider
  private readonly clock: Clock
  private readonly circuit: SourceCircuit
  private readonly securitiesCircuit: SourceCircuit
  private readonly breadthCache: ProviderCache<BreadthSnapshot>
  private readonly armsCache: ProviderCache<MarketArmsData>
  private readonly distributionCache: ProviderCache<MarketDistributionData>
  private readonly http: HttpClient
  private readonly breadthTimeoutMs: number

  constructor(options: MarketDataServiceOptions = {}) {
    const http = options.http ?? new NodeFetchHttpClient()
    const preparationHttp = new PacedHttpClient(http, options.clock ?? systemClock)
    this.http = http
    this.ladder = new MarketLadderProvider(preparationHttp, options.clock ?? systemClock, Math.min(options.timeoutMs ?? 5000, 5000), secIds => this.getQuotes(secIds))
    this.globalIndices = new GlobalIndexProvider(http, options.clock ?? systemClock, Math.min(options.timeoutMs ?? 5000, 5000), options.circuit)
    this.breadthTimeoutMs = options.timeoutMs ?? 10_000
    this.clock = options.clock ?? systemClock
    this.circuit = new SourceCircuit({ ...options.circuit, clock: this.clock })
    this.baostock = new BaoStockProvider(this.clock, this.circuit)
    this.technicalScreen = new TechnicalScreenProvider(preparationHttp, this.clock, this.circuit, this.baostock)
    this.scan = new MarketScanProvider(http, this.clock, this.circuit)
    this.macroInputs = new MarketMacroInputs(http, this.clock, this.circuit)
    this.macroIndicators = new MacroIndicatorProvider(http, this.clock, this.circuit)
    this.macroAll = new MarketMacroAllProvider(http, this.clock, this.circuit)
    this.macroCapital = new MarketMacroCapitalProvider(http, this.clock, this.circuit, new MarketMacroCapitalReferenceProvider(http, this.clock, this.circuit, range => this.macro.getIndex(range)))
    this.macroDaily = new MarketMacroDailyProvider(http, this.clock, this.circuit, range => this.macro.getIndex(range), this.macroInputs)
    this.macroAllDaily = new MarketMacroAllDailyProvider(http, this.clock, this.circuit, this.macroAll, this.macroInputs, range => this.macro.getIndex(range))
    this.macro = new MarketMacroProvider(http, this.clock, this.circuit, before => this.getKline('1.000300', 'daily', before))
    this.activity = new MarketActivityProvider(http, this.clock, this.circuit, () => this.getTrend('1.000001'))
    this.breadthCache = new ProviderCache(this.clock, () => {
      const beijing = new Date(this.clock.now() + 8 * 3_600_000)
      const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
      const open = beijing.getUTCDay() > 0 && beijing.getUTCDay() < 6 && minutes >= 565 && minutes <= 905
      return open ? 25_000 : 6 * 60 * 60_000
    })
    const domesticTtl = () => {
      const bj = new Date(this.clock.now() + 8 * 3_600_000)
      const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
      return bj.getUTCDay() > 0 && bj.getUTCDay() < 6 && minutes >= 565 && minutes <= 905 ? 25_000 : 6 * 3_600_000
    }
    this.armsCache = new ProviderCache(this.clock, domesticTtl)
    this.distributionCache = new ProviderCache(this.clock, domesticTtl)
    // 行情成功不能重置主数据列表的失败次数。
    this.securitiesCircuit = new SourceCircuit({ ...options.circuit, clock: this.clock })
    this.tencent = new TencentProvider(http, this.clock, options.timeoutMs ?? 10_000)
    this.sina = new SinaProvider(http, this.clock, options.timeoutMs ?? 10_000)
    this.financials = new EastmoneyFinancialProvider(preparationHttp, this.clock, options.timeoutMs ?? 10_000, this.circuit)
    this.eastmoney = new EastmoneyProvider(http, {
      ...options.eastmoney,
      clock: this.clock,
      tencent: this.tencent,
      timeoutMs: options.eastmoney?.timeoutMs ?? options.timeoutMs ?? 8_000,
    })
    this.preparationTencent = new TencentProvider(preparationHttp, this.clock, options.timeoutMs ?? 10_000)
    this.preparationEastmoney = new EastmoneyProvider(preparationHttp, {
      ...options.eastmoney, clock: this.clock, tencent: this.preparationTencent,
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

  /** 包住单个数据源调用：熔断期间直接跳过，异常计入该源失败次数。 */
  private async callSource<T>(source: SourceId, task: () => Promise<T>): Promise<T | null> {
    try {
      return await this.circuit.run(source, async () => {
        const value = await task()
        if (value !== null && typeof value === 'object' && 'meta' in value) {
          const meta = value.meta as ProviderMeta | null
          if (meta?.cacheState === 'unavailable') throw new Error('本次调用未返回可用数据')
        }
        return value
      })
    } catch {
      return null
    }
  }

  getSourceDiagnostics(): SourceDiagnostic[] {
    const sources = [
      ['tencent', '腾讯', 'market'], ['sina', '新浪', 'market'],
      ['eastmoney-push2his', '东方财富（行情 / K线调用链）', 'market'],
      ['tencent-daily', '腾讯（选股日线）', 'market'], ['eastmoney-daily', '东方财富（选股日线）', 'market'],
      ['tencent-calendar', '腾讯（指数交易日）', 'market'], ['eastmoney-calendar', '东方财富（指数交易日）', 'market'],
      ['eastmoney-financials', '东方财富（财报）', 'market'], ['eastmoney-dividends', '东方财富（分红）', 'market'],
      ['baostock-transport', 'BaoStock（匿名连接）', 'market'], ['baostock-daily', 'BaoStock（选股日线）', 'market'],
      ['baostock-calendar', 'BaoStock（交易日历）', 'market'], ['baostock-securities', 'BaoStock（在市证券）', 'market'],
      ['gurufocus', '价值大师网', 'valuation'],
      ['sina', '新浪', 'security'], ['eastmoney-push2', '东方财富', 'security'],
      ['legu', '乐咕乐股（AKShare 同源）', 'breadth'],
      ['88ai-arms', '88AI投（成交额版阿姆氏指标）', 'breadth'],
      ['88ai-scan', '88AI投（公开财务扫描汇总）', 'market'],
      ['sina', '新浪涨跌分布', 'breadth'],
      ['tencent', '腾讯涨跌分布', 'breadth'],
      ['eastmoney-push2', '东方财富涨跌分布（兜底）', 'breadth'],
      ['sse-etf', '上交所ETF日份额', 'market'],
      ['szse-etf', '深交所ETF日份额', 'market'],
      ['eastmoney-fund', '东方财富基金规模', 'market'],
      ['eastmoney-macro', '东方财富宏观经济与国债', 'market'],
      ['mofcom-macro', '商务部社融（原始来源：人民银行）', 'market'],
      ['ths-news', '同花顺板块异动快讯', 'market'],
      ['eastmoney-push2ex', '东方财富 push2ex（兜底）', 'breadth'],
    ] as const
    return [...sources.map(([source, sourceName, scope]) => ({
      source, sourceName, scope,
      ...(scope === 'security' ? this.securitiesCircuit : this.circuit).snapshot(source),
    })), ...(['ths-limit-reason', 'ths-limit-previous', 'ths-hot-reason', 'eastmoney-limit-up', 'eastmoney-limit-previous', 'eastmoney-limit-broken'] as const).map(source => ({ source, sourceName: `${source}（涨停梯队）`, scope: 'market' as const, ...this.ladder.circuit.snapshot(source) })), ...(['tencent', 'sina', 'eastmoney-push2'] as const).map(source => ({ source, sourceName: `${source}（海外指数）`, scope: 'indices' as const, ...this.globalIndices.circuit.snapshot(source) }))]
  }

  getMacroAllEtfs(range?: MacroRange) { return this.macroAll.get(range) }
  getMacroCapital(previous: MacroCapitalData | null, retryMissing = false, range?: MacroRange) { return this.macroCapital.get(previous, retryMissing, range) }
  getMacroInputs() { return this.macroInputs.snapshot() }
  getMacroAllDaily(previous: MacroAllDailyData | null, inputs: MacroEtfInputs | null, retryMissing = false, range?: MacroRange) { return this.macroAllDaily.get(previous, inputs, retryMissing, range) }
  getMacroDaily(previous: MacroDailyEtfData | null, inputs: MacroEtfInputs | null = null, range?: MacroRange) { return this.macroDaily.get(previous, inputs, range) }
  getMacroEtfs(range?: MacroRange) { return this.macro.getEtfs(range) }
  getMacroIndex(range?: MacroRange) { return this.macro.getIndex(range) }
  getGlobalIndices(cacheOnly = false) { return this.globalIndices.get(cacheOnly) }
  getMarketIntraday() { return this.activity.getIntraday() }
  getMarketSignals() { return this.activity.getSignals() }

  getMarketBreadth(): Promise<BreadthSnapshot | null> {
    return this.breadthCache.get('market', async () => {
      const primary = await this.callSource('legu', () => leguBreadth(this.http, this.clock, this.breadthTimeoutMs))
      if (primary !== null) return primary
      const fallback = await this.callSource('eastmoney-push2ex', () => this.eastmoney.getBreadth())
      if (fallback === null) throw new Error('完整市场宽度数据源均不可用')
      return fallback
    })
  }

  getMarketLadder(date?: string) { return this.ladder.get(date) }
  getTechnicalLimitPool(date: string) { return this.ladder.historicalPool(date) }
  getScreeningFacts(code: string, asOf: string, signal: AbortSignal) { return this.baostock.facts(code, asOf, signal) }
  dispose(): void { this.baostock.close() }

  getMarketDistribution(): Promise<MarketDistributionData | null> {
    return this.distributionCache.get('market', async () => {
      const result = await this.circuit.first([
        { source: 'tencent', run: () => fetchDistribution(this.http, this.clock, 'tencent', this.breadthTimeoutMs) },
        { source: 'sina', run: () => fetchDistribution(this.http, this.clock, 'sina', this.breadthTimeoutMs) },
        { source: 'eastmoney-push2', run: () => fetchDistribution(this.http, this.clock, 'eastmoney', this.breadthTimeoutMs) },
      ])
      if (result === null) throw new Error('涨跌分布来源均不可用')
      return result
    })
  }

  getMarketArms(): Promise<MarketArmsData | null> {
    return this.armsCache.get('market', async () => {
      const result = await this.circuit.run('88ai-arms', () => fetchArms(this.http, this.clock, 'intraday'))
      return { point: result.points.at(-1)!, meta: result.meta }
    })
  }

  private async getMarketOverview(): Promise<MarketOverview> {
    const ids = DOMESTIC_INDICES.map(item => item.secId)
    const result = await this.getQuotes(ids)
    const byId = new Map(result.quotes.map(quote => [quote.secId, quote]))
    const indices = ids.flatMap(id => {
      const quote = byId.get(id)
      return quote === undefined ? [] : [{ ...quote, upCount: null, downCount: null, flatCount: null }]
    })
    const shanghai = indices.find(quote => quote.code === '000001')
    const shenzhen = indices.find(quote => quote.code === '399001')
    const totalAmount = shanghai?.amount != null && shenzhen?.amount != null ? shanghai.amount + shenzhen.amount : null
    return {
      indices,
      breadth: { up: null, down: null, flat: null, limitUp: null, limitDown: null, totalAmount },
      marketStatus: this.eastmoney.marketStatus(result.meta.sourceTimestamp?.slice(0, 10) ?? null),
      meta: indices.length > 0 ? result.meta : this.unavailableMeta(),
    }
  }

  async getDashboard(): Promise<DashboardData> {
    const [overview, industry, concept, gainers, losers, amount, turnover] = await Promise.all([
      optional(this.getMarketOverview()),
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
    const primary = await this.callSource('sina', () => this.sina.getSectorBoard(type))
    if (primary !== null && primary.sectors.some(sector => sector.amount !== null && sector.amount > 0)) return primary
    return await this.callSource('eastmoney-push2his', () => this.eastmoney.getSectorBoard(type)) ?? primary
  }

  private async getRankList(kind: 'gainers' | 'losers' | 'amount' | 'turnover') {
    const primary = await this.callSource('sina', () => this.sina.getRankList(kind))
    if (primary !== null && primary.entries.length > 0) return primary
    return await this.callSource('eastmoney-push2his', () => this.eastmoney.getRankList(kind)) ?? primary
  }

  async getSectorStocks(sectorCode: string): Promise<{ stocks: StockQuote[]; meta: ProviderMeta }> {
    if (sectorCode.startsWith('SINA:')) {
      return await this.callSource('sina', () => this.sina.getSectorStocks(sectorCode))
        ?? { stocks: [], meta: this.unavailableMeta('sina', '新浪行情') }
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

  async getStockQuoteMetrics(secId: string, preparation = false): Promise<StockQuoteMetricsData> {
    const tencent = preparation ? this.preparationTencent : this.tencent
    const eastmoney = preparation ? this.preparationEastmoney : this.eastmoney
    const [quotes, primaryMetrics] = await Promise.all([
      optional(this.getQuotes([secId], preparation)),
      this.callSource('eastmoney-push2his', () => eastmoney.getStockMetrics(secId)),
    ])
    const quote = quotes?.quotes.find(item => item.secId === secId) ?? null
    if (primaryMetrics === null && quote !== null && quote.meta?.providerId !== 'tencent') {
      await this.callSource('tencent', () => tencent.getQuotes([secId]))
    }
    const base = primaryMetrics ?? (quote === null ? null : tencent.getQuoteMetrics(secId))
    const metrics = await this.financials.getStockMetrics(secId, quote, base)
    return {
      quote,
      metrics,
      sources: {
        quote: quote === null ? null : quote.meta ?? quotes?.meta ?? null,
        metrics: metrics?.meta ?? null,
        ...(base?.industry ? { industry: base.meta } : {}),
      },
    }
  }

  async getTrend(secId: string): Promise<StockTrendData> {
    const result = await this.callSource('tencent', () => this.tencent.getTrend(secId))
      ?? await this.callSource('eastmoney-push2his', () => this.eastmoney.getTrend(secId))
    return {
      trend: result?.points ?? [],
      trendPrevClose: result?.prevClose ?? null,
      meta: result?.meta ?? null,
    }
  }

  async getKline(secId: string, period: KLinePeriod, before?: string): Promise<StockKLineData> {
    const klt = period === 'daily' ? '101' : period === 'weekly' ? '102' : '103'
    const result = await this.callSource('tencent', () => before === undefined && klt !== '101'
      ? this.tencent.getFullKline(secId, klt) : this.tencent.getKline(secId, klt, before))
      ?? await this.callSource('eastmoney-push2his', () => this.eastmoney.getKline(secId, klt, before))
    return {
      period,
      bars: result?.bars ?? [],
      meta: result?.meta ?? null,
      hasMore: period === 'daily' && (result?.hasMore ?? true),
    }
  }

  async getValuation(secId: string, security?: SecurityMaster | null): Promise<StockValuationData> {
    const identity = security ?? inferredSecurity(secId)
    const valuation = await this.callSource('gurufocus', () => this.gurufocus.getValuation(identity.exchange, identity.code))
    return {
      valuation,
      meta: valuation?.meta ?? null,
    }
  }

  async getQuotes(secIds: readonly string[], preparation = false): Promise<{ quotes: StockQuote[]; meta: ProviderMeta }> {
    const tencent = preparation ? this.preparationTencent : this.tencent
    const eastmoney = preparation ? this.preparationEastmoney : this.eastmoney
    if (secIds.length === 0) return { quotes: [], meta: this.unavailableMeta() }
    const primary = await this.callSource('tencent', () => tencent.getQuotes(secIds))
    const available = new Map((primary?.quotes ?? []).map(quote => [quote.secId, quote]))
    const missing = secIds.filter(id => available.get(id)?.price == null || primary?.meta.providerId.includes('memory-cache'))
    if (missing.length === 0 && primary !== null) return primary
    const fallback = await this.callSource('eastmoney-push2his', () => eastmoney.getQuotes(missing))
      ?? { quotes: [], meta: this.unavailableMeta() }
    if (fallback.quotes.length === 0) return primary ?? { quotes: [], meta: this.unavailableMeta() }
    for (const quote of fallback.quotes) available.set(quote.secId, { ...quote, meta: quote.meta ?? fallback.meta })
    const quotes = secIds.flatMap(id => available.has(id) ? [available.get(id)!] : [])
    if (quotes.every(quote => quote.meta?.providerId === fallback.meta.providerId)) return { quotes, meta: fallback.meta }
    return {
      quotes,
      meta: {
        ...fallback.meta,
        providerId: 'eastmoney-tencent-mixed',
        sourceName: '腾讯行情 / 东方财富兜底',
        cacheState: primary?.meta.cacheState === 'fresh' && fallback.meta.cacheState === 'fresh' ? 'fresh' : 'stale',
      },
    }
  }

  private unavailableMeta(providerId = 'eastmoney', sourceName = '东方财富'): ProviderMeta {
    return { providerId, sourceName, sourceTimestamp: null, fetchedAt: isoNow(this.clock), cacheState: 'unavailable' }
  }

  clearMarketCache(): number {
    return this.preparationTencent.clearQuoteMetrics() + this.preparationEastmoney.clearQuoteCache() + this.baostock.clearCache() + this.scan.clear() + this.ladder.clear() + this.eastmoney.clearQuoteCache() + this.breadthCache.clear() + this.armsCache.clear() + this.distributionCache.clear() + this.tencent.clearQuoteMetrics() + this.sina.clearCache() + this.financials.clearCache() + this.globalIndices.clear() + this.activity.clear() + this.macro.clear() + this.macroDaily.clear() + this.macroCapital.clear() + this.macroAll.clear()
  }

  async syncSecurities(
    database: HanaiDatabase,
    force = false,
    signal?: AbortSignal,
  ): Promise<{ count: number; updatedAt: string | null }> {
    let sourceName: string | null = null
    const result = await new SecuritiesService(database, {
      getAllSecurities: async () => {
        const snapshot = await this.getSecuritySnapshot()
        sourceName = snapshot?.sourceName ?? null
        return snapshot?.rows ?? []
      },
      getQuotes: secIds => this.getQuotes(secIds),
    }, { clock: this.clock }).sync(force, signal)
    signal?.throwIfAborted()
    if (sourceName !== null) database.setSetting(SECURITY_SOURCE_SETTING, sourceName)
    return result
  }

  async syncScreeningSecurities(database: HanaiDatabase, signal: AbortSignal, force = true): Promise<{ count: number; updatedAt: string | null }> {
    let sourceName: string | null = null
    const result = await new SecuritiesService(database, {
      getAllSecurities: async () => {
        let primary: EastmoneySecurityRow[] | null = null
        try { primary = await this.baostock.securities(signal) } catch { signal.throwIfAborted() }
        // BaoStock's universe does not establish complete coverage of all current A-share markets.
        const supplement = await this.getSecuritySnapshot()
        signal.throwIfAborted()
        if (!primary) { sourceName = supplement?.sourceName ?? null; return supplement?.rows ?? [] }
        if (!supplement) throw new Error('BaoStock 名录已获取，但全A范围补缺失败；保留本地名录')
        const rows = new Map(supplement.rows.map(row => [`${row.market}.${row.code}`, row]))
        for (const row of primary) rows.set(`${row.market}.${row.code}`, row)
        sourceName = `BaoStock主源＋${supplement.sourceName}范围补缺`
        return [...rows.values()]
      }, getQuotes: ids => this.getQuotes(ids),
    }, { clock: this.clock }).sync(force, signal)
    signal.throwIfAborted()
    if (sourceName !== null) database.setSetting(SECURITY_SOURCE_SETTING, sourceName)
    return result
  }

  async getAllSecurities(): Promise<EastmoneySecurityRow[]> {
    return (await this.getSecuritySnapshot())?.rows ?? []
  }

  private getSecuritySnapshot(): Promise<{ rows: EastmoneySecurityRow[]; sourceName: string } | null> {
    const attempts = [
      { source: 'sina' as const, name: '新浪', run: () => this.sina.getAllSecurities() },
      { source: 'eastmoney-push2' as const, name: '东方财富', run: () => this.eastmoney.getAllSecurities() },
    ]
    return this.securitiesCircuit.first(attempts.map(attempt => ({
      source: attempt.source,
      run: async () => {
        const rows = await attempt.run()
        const valid = rows.filter(row => /^[01]$/.test(String(row.market)) && /^\d{6}$/.test(row.code) && row.name.trim() !== '')
        if (new Set(valid.map(row => `${row.market}.${row.code}`)).size < 1000) throw new Error('主数据不足 1000 条有效证券')
        return { rows: valid, sourceName: attempt.name }
      },
    })))
  }

  searchSecurities(database: HanaiDatabase, query: string): Promise<SearchResult[]> {
    return new SecuritiesService(database, this.eastmoney, { clock: this.clock }).search(query)
  }
}
