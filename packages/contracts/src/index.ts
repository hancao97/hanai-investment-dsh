import type { ResearchAttachment } from './research-assistant.ts'
import type { ScreeningRun } from './ai-screener.ts'
import type { MarketScanQuery, MarketScanResult } from './market-scan.ts'
import type { MarketLadderData } from './market-ladder.ts'
import type { MacroRange } from './macro-range.ts'
import type { MacroSeriesData } from './macro-series.ts'
import type { EconomicTopic, MacroIndicatorQuery } from './macro-indicators.ts'
/** JSON-safe contracts shared by the Hanai Host and browser client. */
import type { MarketHistorySnapshot, MarketHistorySummary } from './market-history.ts'
import type { MacroGenerationStatus, MacroAllDailyData, MacroAllEtfData, MacroCapitalData, MacroEtfData, MacroIndexData, MacroDailyEtfData } from './market-macro.ts'
import type { GlobalIndicesData } from './market-indices.ts'
import type { MarketIntradayData, MarketSignalsData } from './market-activity.ts'
import type { MarketArmsData } from './market-arms.ts'
import type { MarketDistributionData } from './market-distribution.ts'

/** Conventional application appearance. Theme changes must not alter layout or product semantics. */
export type ThemeId = 'light' | 'dark'
export type MarketStatus = 'pre' | 'trading' | 'break' | 'closed' | 'unknown'
export type CacheState = 'fresh' | 'cached' | 'stale' | 'unavailable'

export interface ProviderMeta {
  providerId: string
  sourceName: string
  sourceTimestamp: string | null
  fetchedAt: string
  cacheState: CacheState
}

export interface IndexQuote {
  meta?: ProviderMeta
  code: string
  name: string
  price: number | null
  change: number | null
  changePct: number | null
  amount: number | null
  upCount: number | null
  downCount: number | null
  flatCount: number | null
}

export interface MarketBreadthData {
  up: number
  down: number
  flat: number
  limitUp: number
  limitDown: number
  qdate: string
  meta: ProviderMeta
}

export interface MarketOverview {
  indices: IndexQuote[]
  breadth: {
    up: number | null
    down: number | null
    flat: number | null
    limitUp: number | null
    limitDown: number | null
    totalAmount: number | null
  }
  marketStatus: MarketStatus
  meta: ProviderMeta
}

export interface SectorItem {
  code: string
  name: string
  changePct: number | null
  amount: number | null
  upCount: number | null
  downCount: number | null
  leaderName: string | null
  leaderCode: string | null
  leaderChangePct: number | null
}

export interface SectorBoard {
  type: 'industry' | 'concept'
  sectors: SectorItem[]
  meta: ProviderMeta
}

export interface StockQuote {
  secId: string
  code: string
  name: string
  price: number | null
  change: number | null
  changePct: number | null
  amount: number | null
  volume: number | null
  turnoverRate: number | null
  marketCap: number | null
  floatCap: number | null
  pe: number | null
  pb: number | null
  high: number | null
  low: number | null
  open: number | null
  prevClose: number | null
  meta?: ProviderMeta
}

export interface RankEntry {
  secId: string
  code: string
  name: string
  price: number | null
  changePct: number | null
  amount: number | null
  turnoverRate: number | null
}

export interface KLineBar {
  date: string
  open: number
  close: number
  high: number
  low: number
  volume: number
  amount: number | null
}

export interface TrendPoint {
  time: string
  price: number
  avgPrice: number | null
  volume: number
}

export type KLinePeriod = 'daily' | 'weekly' | 'monthly'

export interface StockMetrics {
  secId: string
  code: string
  name: string
  price: number | null
  change: number | null
  changePct: number | null
  open: number | null
  high: number | null
  low: number | null
  prevClose: number | null
  volume: number | null
  amount: number | null
  averagePrice: number | null
  amplitude: number | null
  mainNetInflow: number | null
  turnoverRate: number | null
  volumeRatio: number | null
  marketCap: number | null
  floatCap: number | null
  totalShares: number | null
  floatShares: number | null
  peDynamic: number | null
  peTtm: number | null
  peStatic: number | null
  psTtm: number | null
  pb: number | null
  roe: number | null
  totalRevenue: number | null
  revenueYoy: number | null
  netProfit: number | null
  netProfitYoy: number | null
  grossMargin: number | null
  netMargin: number | null
  debtRatio: number | null
  dividendYield: number | null
  eps: number | null
  bvps: number | null
  listingDate: string | null
  industry: string | null
  /** The financial values are cumulative within this fiscal report period; valuations use current quotes. */
  reportDate?: string | null
  reportName?: string | null
  meta: ProviderMeta
}

export interface SecurityMaster {
  secId: string
  code: string
  name: string
  exchange: 'SH' | 'SZ' | 'BJ'
  pinyinFull: string
  pinyinInitial: string
}

export interface SearchResult extends SecurityMaster {
  price: number | null
  changePct: number | null
}

export interface WatchItem {
  secId: string
  addedAt: string
  basePrice: number | null
}

export interface WatchGroup {
  id: string
  name: string
  isDefault: boolean
  secIds: string[]
  items: WatchItem[]
}

export interface WatchQuote extends StockQuote {
  groupId: string
  addedAt: string
  basePrice: number | null
  sinceAddedPct: number | null
}

/** A lightweight, watch-list-safe projection of the daily valuation surface. */
export interface WatchValuation {
  secId: string
  fairValue: number | null
  valuationRank: number | null
  meta: ProviderMeta | null
}

export interface ValuationSummary {
  stockId: string
  ivDcf: number | null
  medps: number | null
  gfScore: number | null
  valuationRank: number | null
  dimensions: {
    financialStrength: number | null
    profitability: number | null
    growth: number | null
    gfValue: number | null
    momentum: number | null
  }
  series: {
    price: [string, number][]
    medps: [string, number][]
  }
  meta: ProviderMeta
}

export interface MasterPersona {
  id: string
  name: string
  shortName: string
  description: string
  color: string
  roleTag: string
  tags: string[]
  defaultPrompt: string
  version: string
  /** Open-chat-only experts stay visible in the expert center but never enter stock-report launchers. */
  chatOnly?: boolean
  /** Persistent UI disclosure for a perspective simulation of a real person. */
  personaDisclaimer?: string
  /** Optional conversation starters shown before the first open-chat message. */
  chatStarters?: string[]
}

export type ReportStatus =
  | 'preparing'
  | 'generating'
  | 'verifying'
  | 'repairing'
  | 'ready'
  | 'revising'
  | 'failed'

export type TurnStatus = 'idle' | 'queued' | 'running' | 'cancelling' | 'failed'

export interface Judgement {
  id: string
  secId: string
  code: string
  stockName: string
  masterId: string
  masterName: string
  masterVersion: string
  dshSessionId: string | null
  reportStatus: ReportStatus
  turnStatus: TurnStatus
  latestReportVersion: number | null
  modelProvider: string | null
  model: string | null
  reasoningEffort: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  errorCode: string | null
  errorMessage: string | null
}

export interface ReportVersion {
  judgementId: string
  version: number
  content: string
  sha256: string
  sizeBytes: number
  sealedAt: string
  modelProvider: string | null
  model: string | null
}

export interface JudgementDetail {
  judgement: Judgement
  reports: ReportVersion[]
}

/** Business metadata for an expert conversation. DSH remains the sole owner of all messages and turns. */
export interface ExpertChat {
  id: string
  title: string
  masterId: string
  masterName: string
  masterVersion: string
  dshSessionId: string | null
  turnStatus: TurnStatus
  modelProvider: string | null
  model: string | null
  reasoningEffort: string | null
  createdAt: string
  updatedAt: string
  errorCode: string | null
  errorMessage: string | null
}

export interface StockDetail {
  security: SecurityMaster | null
  quote: StockQuote | null
  metrics: StockMetrics | null
  trend: TrendPoint[]
  /** The trend provider's own previous close; it remains available when the quote request fails. */
  trendPrevClose: number | null
  daily: KLineBar[]
  weekly: KLineBar[]
  monthly: KLineBar[]
  valuation: ValuationSummary | null
  /** Per-surface provenance; the UI must not present delayed or fallback data as live. */
  sources: {
    quote: ProviderMeta | null
    metrics: ProviderMeta | null
    trend: ProviderMeta | null
    daily: ProviderMeta | null
    weekly: ProviderMeta | null
    monthly: ProviderMeta | null
    valuation: ProviderMeta | null
  }
}

/** Independently refreshable stock-detail surfaces. Each response is JSON-safe and carries provenance. */
export interface StockQuoteMetricsData {
  quote: StockQuote | null
  metrics: StockMetrics | null
  sources: {
    quote: ProviderMeta | null
    metrics: ProviderMeta | null
    industry?: ProviderMeta | null
  }
}

export interface StockTrendData {
  trend: TrendPoint[]
  trendPrevClose: number | null
  meta: ProviderMeta | null
}

export interface StockKLineData {
  period: KLinePeriod
  bars: KLineBar[]
  meta: ProviderMeta | null
  /** Whether an earlier page may exist. Only daily K-line is incrementally paged. */
  hasMore: boolean
}

export interface StockValuationData {
  valuation: ValuationSummary | null
  meta: ProviderMeta | null
}

export interface DashboardData {
  overview: MarketOverview
  industry: SectorBoard
  concept: SectorBoard
  ranks: Record<'gainers' | 'losers' | 'amount' | 'turnover', RankEntry[]>
  rankSources?: Record<'gainers' | 'losers' | 'amount' | 'turnover', ProviderMeta>
}

export interface SourceDiagnostic {
  source: string
  sourceName: string
  scope: 'market' | 'security' | 'valuation' | 'breadth' | 'indices'
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  failures: number
  openUntil: string | null
}

export interface Diagnostics {
  dataRoot: string
  databasePath: string
  dshHomeOwnedByHost: true
  securityCount: number
  masterCount: number
  judgementCount: number
  expertChatCount: number
  latestMarketSuccess: string | null
  latestValuationSuccess: string | null
  marketSources: ProviderMeta[]
  valuationSources: ProviderMeta[]
  securitySource: string | null
  latestSecuritySuccess: string | null
  securitySyncAvailableAt: string | null
  sourceAttempts: SourceDiagnostic[]
  storage: {
    totalBytes: number
    cacheBytes: number
    marketCacheBytes: number
    valuationCacheBytes: number
    judgementsBytes: number
    expertChatsBytes: number
  }
  version: string
}

export interface CacheClearResult {
  scope: 'market' | 'valuation'
  removedFiles: number
  freedBytes: number
}

export interface BootstrapData {
  theme: ThemeId
  masters: MasterPersona[]
  groups: WatchGroup[]
  judgements: Judgement[]
  expertChats: ExpertChat[]
  diagnostics: Diagnostics
}

export interface ModelSelectionInput {
  provider: string
  model: string
  reasoningEffort?: string
}

/**
 * Process-wide DSH model selection used when a new Agent has no session-local
 * override. Hanai transports this value but never owns a parallel setting.
 */
export type DefaultModelSelection = ModelSelectionInput

export interface CreateJudgementInput {
  secId: string
  masterId: string
  prompt?: string
  model?: ModelSelectionInput
}

export interface CreateExpertChatInput {
  masterId: string
  openingMessage?: string
  model?: ModelSelectionInput
}

export interface HanaiEndpointMap {
  'bootstrap': { request: Record<string, never>; response: BootstrapData }
  'dashboard.get': { request: { refresh?: boolean }; response: DashboardData }
  'market.scan.query': { request: { query: MarketScanQuery; date?: string; refresh?: boolean }; response: MarketScanResult }
  'market.scan.history': { request: { query: MarketScanQuery }; response: MarketHistorySummary[] }
  'market.breadth': { request: Record<string, never>; response: MarketBreadthData | null }
  'market.arms': { request: Record<string, never>; response: MarketArmsData | null }
  'market.ladder': { request: Record<string, never>; response: MarketLadderData | null }
  'market.distribution': { request: Record<string, never>; response: MarketDistributionData | null }
  'market.indices': { request: Record<string, never>; response: GlobalIndicesData }
  'market.macro.query': { request: { range: MacroRange; refresh?: boolean }; response: { data: MacroSeriesData; task: MacroGenerationStatus; taskRange: MacroRange | null; activeRange: MacroRange | null; queued: MacroRange[] } }
  'market.macro.indicators': { request: { topic: EconomicTopic; range: MacroRange; refresh?: boolean }; response: MacroIndicatorQuery }
  'market.macro.generate': { request: Record<string, never>; response: MacroGenerationStatus }
  'market.macro.generation': { request: Record<string, never>; response: MacroGenerationStatus }
  'market.macro.allDaily': { request: { retryMissing?: boolean }; response: MacroAllDailyData | null }
  'market.macro.all': { request: Record<string, never>; response: MacroAllEtfData | null }
  'market.macro.capital': { request: { retryMissing?: boolean }; response: MacroCapitalData | null }
  'market.macro.daily': { request: Record<string, never>; response: MacroDailyEtfData | null }
  'market.macro.etf': { request: Record<string, never>; response: MacroEtfData | null }
  'market.macro.index': { request: Record<string, never>; response: MacroIndexData | null }
  'market.intraday': { request: Record<string, never>; response: MarketIntradayData | null }
  'market.signals': { request: Record<string, never>; response: MarketSignalsData | null }
  'market.history.list': { request: Record<string, never>; response: { snapshots: MarketHistorySummary[] } }
  'market.history.get': { request: { date: string }; response: MarketHistorySnapshot | null }
  'sector.stocks': { request: { sectorCode: string }; response: { stocks: StockQuote[]; meta: ProviderMeta } }
  'stock-data.status': { request: Record<string, never>; response: import('./stock-data.ts').StockDataStatus }
  'stock-data.sync': { request: Record<string, never>; response: import('./stock-data.ts').StockDataStatus }
  'stock-data.pause': { request: Record<string, never>; response: import('./stock-data.ts').StockDataStatus }
  'security.sync': { request: { force?: boolean }; response: { count: number; updatedAt: string | null } }
  'security.search': { request: { query: string }; response: SearchResult[] }
  'security.detail': { request: { secId: string }; response: StockDetail }
  'security.quote': { request: { secId: string }; response: StockQuoteMetricsData }
  'security.trend': { request: { secId: string }; response: StockTrendData }
  'security.kline': { request: { secId: string; period: KLinePeriod; before?: string }; response: StockKLineData }
  'security.valuation': { request: { secId: string }; response: StockValuationData }
  'watch.list': { request: Record<string, never>; response: WatchGroup[] }
  'watch.securities': { request: Record<string, never>; response: SecurityMaster[] }
  'watch.quotes': {
    request: { groupId: string }
    response: { quotes: WatchQuote[]; meta: ProviderMeta }
  }
  'watch.valuations': {
    request: { groupId: string }
    response: { valuations: WatchValuation[]; meta: ProviderMeta | null }
  }
  'watch.group.create': { request: { name: string }; response: WatchGroup }
  'watch.group.rename': { request: { id: string; name: string }; response: WatchGroup[] }
  'watch.group.remove': { request: { id: string }; response: WatchGroup[] }
  'watch.item.add': { request: { groupId: string; secId: string }; response: WatchGroup[] }
  'watch.item.remove': { request: { groupId: string; secId: string }; response: WatchGroup[] }
  'watch.item.move': { request: { fromGroupId: string; toGroupId: string; secId: string }; response: WatchGroup[] }
  'judgement.list': { request: Record<string, never>; response: Judgement[] }
  'judgement.create': { request: CreateJudgementInput; response: Judgement }
  'judgement.get': { request: { id: string }; response: JudgementDetail }
  'judgement.revise': { request: { id: string; instruction: string }; response: Judgement }
  'judgement.remove': { request: { id: string }; response: Judgement[] }
  'research-chat.list': { request: Record<string, never>; response: ExpertChat[] }
  'screener.list': { request: Record<string, never>; response: ExpertChat[] }
  'screener.result': { request: { id: string }; response: ScreeningRun | null }
  'screener.execute': { request: { id: string }; response: ScreeningRun }
  'screener.create': { request: Omit<CreateExpertChatInput, 'masterId'>; response: ExpertChat }
  'screener.get': { request: { id: string }; response: ExpertChat }
  'screener.remove': { request: { id: string }; response: ExpertChat[] }
  'screener.rename': { request: { id: string; title: string }; response: ExpertChat }
  'research-chat.create': { request: Omit<CreateExpertChatInput, 'masterId'>; response: ExpertChat }
  'research-chat.get': { request: { id: string }; response: ExpertChat }
  'research-chat.remove': { request: { id: string }; response: ExpertChat[] }
  'research-chat.rename': { request: { id: string; title: string }; response: ExpertChat }
  'research-chat.upload': { request: { id: string; name: string; data: string }; response: ResearchAttachment }
  'expert-chat.list': { request: Record<string, never>; response: ExpertChat[] }
  'expert-chat.create': { request: CreateExpertChatInput; response: ExpertChat }
  'expert-chat.get': { request: { id: string }; response: ExpertChat }
  'expert-chat.remove': { request: { id: string }; response: ExpertChat[] }
  'model.default.get': {
    request: Record<string, never>
    response: DefaultModelSelection
  }
  'model.default.set': {
    request: DefaultModelSelection
    response: DefaultModelSelection
  }
  'theme.set': { request: { theme: ThemeId }; response: { theme: ThemeId } }
  'diagnostics.get': { request: Record<string, never>; response: Diagnostics }
  'cache.clear': { request: { scope: 'market' | 'valuation' }; response: CacheClearResult }
  'storage.openDataRoot': {
    request: Record<string, never>
    response: { opened: true; dataRoot: string }
  }
}

export type HanaiEndpoint = keyof HanaiEndpointMap
export type HanaiRequest<K extends HanaiEndpoint> = HanaiEndpointMap[K]['request']
export type HanaiResponse<K extends HanaiEndpoint> = HanaiEndpointMap[K]['response']
