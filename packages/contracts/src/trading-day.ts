/** Contracts for the intraday trading-data panel on the "今日市场" page. */

import type { DashboardData } from './index.ts'

export type TradingDayStatus = 'complete' | 'partial'
export type TradingDaySourceState = 'fresh' | 'cached' | 'stale' | 'unavailable'

export interface TradingDaySource {
  key: string
  label: string
  state: TradingDaySourceState
  error: string | null
}

export interface TradingDayIndex {
  code: string
  name: string
  price: number | null
  changePct: number | null
  amount: number | null
}

export interface TradingDayTrendPoint {
  time: string
  price: number
  avgPrice: number | null
  volume: number | null
}

export interface TradingDayTrend {
  code: string
  name: string
  date: string | null
  prevClose: number | null
  points: TradingDayTrendPoint[]
}

/** 行业板块分时异动信号：在指数分时图上叠加显示。 */
export interface TradingDaySectorSignal {
  /** 触发时间，格式 "YYYY-MM-DD HH:mm"，与指数分时 time 对齐。 */
  time: string
  /** 板块名称，如 "机器人"。 */
  name: string
  /** 板块代码，如同花顺 886069。 */
  code: string
  /** 触发时板块涨跌幅（相对昨收），百分比；来源未提供时为 null。 */
  changePct: number | null
  /** 异动方向：来源只给出定性描述时用于着色。 */
  direction?: 'up' | 'down'
}

export interface TradingDayTurnover {
  amount: number | null
  previousAmount: number | null
  previousTradeDate: string | null
  changePct: number | null
}

export interface TradingDayMargin {
  tradeDate: string | null
  total: number | null
  previousTotal: number | null
  change: number | null
  changePct: number | null
  /** 两市（沪市 + 深市）融资余额合计，单位亿元。 */
  marketTotal?: number | null
  marketPreviousTotal?: number | null
  marketChange?: number | null
  marketChangePct?: number | null
}

export interface TradingDayContextData {
  tradeDate: string
  generatedAt: string
  status: TradingDayStatus
  indices: TradingDayIndex[]
  trend: TradingDayTrend | null
  /** 各指数分时；旧快照可能没有该字段。 */
  trends?: TradingDayTrend[]
  /** 行业板块分时异动信号，用于叠加在上证分时图上。 */
  sectorSignals?: TradingDaySectorSignal[]
  turnover: TradingDayTurnover | null
  margin: TradingDayMargin | null
  sources: TradingDaySource[]
}

export interface TradingDayLimitStock {
  code: string
  name: string
  price: number | null
  changePct: number | null
  amount: number | null
  turnoverRate: number | null
  marketCap: number | null
  boardCount: number | null
  firstLimitTime: string | null
  lastLimitTime: string | null
  reason: string | null
  boardType: string | null
  theme: string | null
}

export interface TradingDayLadderGroup {
  board: number
  label: string
  count: number
  stocks: TradingDayLimitStock[]
}

export interface TradingDayLimitStats {
  limitUp: number | null
  limitDown: number | null
  broken: number | null
  sealRate: number | null
  breakRate: number | null
  firstBoard: number | null
  lianban: number | null
  maxBoard: number | null
  promotionRate: number | null
}

export interface TradingDayYesterdayPerformance {
  sample: number | null
  promoted: number | null
  avgChangePct: number | null
  medianChangePct: number | null
  upRate: number | null
}

export interface TradingDayLimitPoolsData {
  tradeDate: string
  generatedAt: string
  status: TradingDayStatus
  stats: TradingDayLimitStats
  ladder: TradingDayLadderGroup[]
  yesterdayPerformance: TradingDayYesterdayPerformance
  sources: TradingDaySource[]
}

export interface TradingDayTheme {
  name: string
  count: number
  maxBoard: number
  leaders: string[]
}

export interface TradingDayDrive {
  tag: string
  count: number
  maxBoard: number
  leaders: string[]
}

export interface TradingDayThemesData {
  tradeDate: string
  generatedAt: string
  status: TradingDayStatus
  themes: TradingDayTheme[]
  drives: TradingDayDrive[]
  sources: TradingDaySource[]
}

export interface TradingDayDragonTigerEntry {
  code: string
  name: string
  reason: string | null
  netBuy: number | null
  changePct: number | null
  turnoverRate: number | null
}

export interface TradingDayDragonTigerData {
  tradeDate: string
  generatedAt: string
  status: TradingDayStatus
  entries: TradingDayDragonTigerEntry[]
  sources: TradingDaySource[]
}

export interface TradingDayAxis {
  key: string
  label: string
  value: string
  detail: string
  evidence: string[]
  missing: string[]
}

export type TradingDayMainlineGrade = 'A' | 'B' | 'C' | 'unknown'

export interface TradingDayMainline {
  name: string
  grade: TradingDayMainlineGrade
  score: number | null
  stage: string
  height: number | null
  width: number | null
  depth: number | null
  evidence: string[]
  missing: string[]
}

export type TradingDayRoleKind = 'leader' | 'center' | 'follow' | 'unknown'

export interface TradingDayRole {
  code: string
  name: string
  role: TradingDayRoleKind
  boardCount: number | null
  rs5: number | null
  rs20: number | null
  marketCap: number | null
  note: string
}

export interface TradingDayVerdict {
  stage: string | null
  position: string | null
  temperature: string | null
  confidence: number | null
  summary: string
  gaps: string[]
}

export type TradingDayScenarioKind = 'above' | 'match' | 'below'

export interface TradingDayScenario {
  kind: TradingDayScenarioKind
  title: string
  trigger: string
  response: string
}

export interface TradingDayCoverage {
  analyzed: number
  total: number
  skipped: number
}

export interface TradingDayAnalysisData {
  tradeDate: string
  generatedAt: string
  status: TradingDayStatus
  axes: TradingDayAxis[]
  mainlines: TradingDayMainline[]
  leaders: TradingDayRole[]
  centerCandidates: TradingDayRole[]
  roles: TradingDayRole[]
  verdict: TradingDayVerdict
  scenarios: TradingDayScenario[]
  coverage: TradingDayCoverage
  missingReasons: string[]
  sources: TradingDaySource[]
}

export interface TradingDaySnapshotPayload {
  context: TradingDayContextData | null
  limitPools: TradingDayLimitPoolsData | null
  themes: TradingDayThemesData | null
  dragonTiger: TradingDayDragonTigerData | null
  analysis: TradingDayAnalysisData | null
  dashboard: DashboardData | null
}

export interface TradingDaySnapshotRecord {
  tradeDate: string
  capturedAt: string
  status: TradingDayStatus
  schemaVersion: number
  payload: TradingDaySnapshotPayload
}

export interface TradingDaySnapshotSummary {
  tradeDate: string
  capturedAt: string
  status: TradingDayStatus
}

export interface TradingDayGroupRequest {
  /** Persist this successful group into the trading-day snapshot. Timers and history reads pass false. */
  save?: boolean
}
