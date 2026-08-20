/** JSON-safe contracts shared by the Hanai Host and browser client. */

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

export type WatchResearchState = 'active' | 'current' | 'stale' | 'failed' | 'uncovered'

/** Research coverage projected onto one watch-list row without loading full reports. */
export interface WatchResearchCoverage {
  secId: string
  state: WatchResearchState
  judgementId: string | null
  masterId: string | null
  masterName: string | null
  latestReportAt: string | null
  latestReportVersion: number | null
  ageDays: number | null
  reportVersionCount: number
  openFollowUpCount: number
  overdueFollowUpCount: number
  nextFollowUpDueDate: string | null
  pendingPredictionCount: number
  duePredictionCount: number
  nextPredictionDueDate: string | null
}

export interface WatchResearchCoverageBatch {
  items: WatchResearchCoverage[]
  staleAfterDays: number
  generatedAt: string
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
  audit: ReportAudit
}

export type ReportAuditCheckId =
  | 'conclusion'
  | 'information-date'
  | 'sources'
  | 'evidence-ledger'
  | 'counter-evidence'
  | 'scenarios'
  | 'monitoring'

export type ReportAuditCheckState = 'met' | 'partial' | 'missing'

export interface ReportAuditCheck {
  id: ReportAuditCheckId
  label: string
  state: ReportAuditCheckState
  detail: string
  weight: number
}

export interface ReportSourceReference {
  url: string
  domain: string
  label: string | null
}

export type ReportEvidenceKind = 'fact' | 'inference' | 'assumption' | 'unknown'
export type ReportEvidenceConfidence = 'high' | 'medium' | 'low' | 'unknown'

/** A mechanically parsed row from the report's evidence ledger table. */
export interface ReportEvidenceItem {
  claim: string
  kind: ReportEvidenceKind
  sourceLabel: string | null
  sourceUrl: string | null
  sourceDate: string | null
  confidence: ReportEvidenceConfidence
}

/** Deterministic structural audit. It measures traceability, never investment correctness. */
export interface ReportAudit {
  score: number
  rating: 'strong' | 'review' | 'thin'
  checks: ReportAuditCheck[]
  sources: ReportSourceReference[]
  evidence: ReportEvidenceItem[]
  stats: {
    characters: number
    headings: number
    tables: number
    links: number
  }
}

export type ResearchFollowUpStatus = 'open' | 'done'

/** A local research promise that survives report replacement or deletion. */
export interface ResearchFollowUp {
  id: string
  secId: string
  judgementId: string | null
  reportVersion: number | null
  title: string
  dueDate: string | null
  status: ResearchFollowUpStatus
  createdAt: string
  completedAt: string | null
}

/** A follow-up enriched for the cross-company research inbox. */
export interface ResearchInboxItem extends ResearchFollowUp {
  code: string
  stockName: string
  masterName: string | null
  reportAvailable: boolean
}

export interface ResearchInbox {
  items: ResearchInboxItem[]
  generatedAt: string
}

export type ResearchPredictionOutcome = 'pending' | 'occurred' | 'not-occurred' | 'invalid'

/** A falsifiable research claim used to calibrate confidence after its deadline. */
export interface ResearchPrediction {
  id: string
  secId: string
  judgementId: string | null
  reportVersion: number | null
  statement: string
  resolutionCriteria: string
  probabilityPct: number
  dueDate: string
  outcome: ResearchPredictionOutcome
  brierScore: number | null
  createdAt: string
  resolvedAt: string | null
}

/** A prediction enriched for the cross-company calibration desk. */
export interface ResearchPredictionInboxItem extends ResearchPrediction {
  code: string
  stockName: string
  masterName: string | null
}

export interface ResearchPredictionInbox {
  items: ResearchPredictionInboxItem[]
  generatedAt: string
}

/** A report-audit projection for triaging the whole research archive. */
export interface ResearchQualityItem {
  judgementId: string
  secId: string
  reportVersion: number
  sealedAt: string | null
  score: number | null
  rating: ReportAudit['rating'] | 'unavailable'
  sourceCount: number
  evidenceCount: number
  incompleteChecks: Array<Pick<ReportAuditCheck, 'id' | 'label' | 'state'>>
  error: string | null
}

export interface ResearchQualityBatch {
  items: ResearchQualityItem[]
  generatedAt: string
}

export interface ResearchComparisonReport {
  judgementId: string
  masterId: string
  masterName: string
  reportVersion: number
  sealedAt: string | null
  audit: ReportAudit | null
  error: string | null
}

/** Latest independent reports for one company, frozen for side-by-side review. */
export interface ResearchComparison {
  secId: string
  code: string
  stockName: string
  reports: ResearchComparisonReport[]
  generatedAt: string
}

export interface JudgementDetail {
  judgement: Judgement
  reports: ReportVersion[]
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
}

export interface Diagnostics {
  dataRoot: string
  databasePath: string
  dshHomeOwnedByHost: true
  securityCount: number
  masterCount: number
  judgementCount: number
  latestMarketSuccess: string | null
  latestValuationSuccess: string | null
  storage: {
    totalBytes: number
    cacheBytes: number
    marketCacheBytes: number
    valuationCacheBytes: number
    judgementsBytes: number
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

export interface HanaiEndpointMap {
  'bootstrap': { request: Record<string, never>; response: BootstrapData }
  'dashboard.get': { request: { refresh?: boolean }; response: DashboardData }
  'sector.stocks': { request: { sectorCode: string }; response: { stocks: StockQuote[]; meta: ProviderMeta } }
  'security.sync': { request: { force?: boolean }; response: { count: number; updatedAt: string | null } }
  'security.search': { request: { query: string }; response: SearchResult[] }
  'security.detail': { request: { secId: string }; response: StockDetail }
  'security.quote': { request: { secId: string }; response: StockQuoteMetricsData }
  'security.trend': { request: { secId: string }; response: StockTrendData }
  'security.kline': { request: { secId: string; period: KLinePeriod }; response: StockKLineData }
  'security.valuation': { request: { secId: string }; response: StockValuationData }
  'watch.list': { request: Record<string, never>; response: WatchGroup[] }
  'watch.quotes': {
    request: { groupId: string }
    response: { quotes: WatchQuote[]; meta: ProviderMeta }
  }
  'watch.valuations': {
    request: { groupId: string }
    response: { valuations: WatchValuation[]; meta: ProviderMeta | null }
  }
  'watch.researchCoverage': {
    request: { groupId: string }
    response: WatchResearchCoverageBatch
  }
  'watch.group.create': { request: { name: string }; response: WatchGroup }
  'watch.group.rename': { request: { id: string; name: string }; response: WatchGroup[] }
  'watch.group.remove': { request: { id: string }; response: WatchGroup[] }
  'watch.item.add': { request: { groupId: string; secId: string }; response: WatchGroup[] }
  'watch.item.remove': { request: { groupId: string; secId: string }; response: WatchGroup[] }
  'watch.item.move': { request: { fromGroupId: string; toGroupId: string; secId: string }; response: WatchGroup[] }
  'research.followup.list': { request: { secId: string }; response: ResearchFollowUp[] }
  'research.followup.create': {
    request: { secId: string; judgementId?: string; reportVersion?: number; title: string; dueDate?: string }
    response: ResearchFollowUp
  }
  'research.followup.update': {
    request: { id: string; completed?: boolean; title?: string; dueDate?: string | null }
    response: ResearchFollowUp
  }
  'research.followup.remove': { request: { id: string }; response: { id: string } }
  'research.inbox': {
    request: { status?: 'open' | 'done' | 'all' }
    response: ResearchInbox
  }
  'research.prediction.list': { request: { secId: string }; response: ResearchPrediction[] }
  'research.prediction.create': {
    request: {
      secId: string
      judgementId?: string
      reportVersion?: number
      statement: string
      resolutionCriteria: string
      probabilityPct: number
      dueDate: string
    }
    response: ResearchPrediction
  }
  'research.prediction.resolve': {
    request: { id: string; outcome: Exclude<ResearchPredictionOutcome, 'pending'> }
    response: ResearchPrediction
  }
  'research.prediction.inbox': {
    request: { status?: 'pending' | 'resolved' | 'all' }
    response: ResearchPredictionInbox
  }
  'research.quality': { request: Record<string, never>; response: ResearchQualityBatch }
  'research.compare': { request: { secId: string }; response: ResearchComparison }
  'judgement.list': { request: Record<string, never>; response: Judgement[] }
  'judgement.create': { request: CreateJudgementInput; response: Judgement }
  'judgement.get': { request: { id: string }; response: JudgementDetail }
  'judgement.revise': { request: { id: string; instruction: string }; response: Judgement }
  'judgement.remove': { request: { id: string }; response: Judgement[] }
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
