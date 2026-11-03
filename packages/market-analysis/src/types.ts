/**
 * 市场分析包的原始输入类型。
 *
 * 这里刻意保留上游接口（腾讯、东方财富、同花顺、上交所）的字段形状，
 * 由 parsers 负责文本/JSON 解析，由 builders 再转换成 contracts 中的契约类型。
 * 所有“缺失”都使用 null 表示，不使用 0 占位。
 */
import type { TradingDaySource, TradingDayStatus } from '../../contracts/src/trading-day.ts'

/** 分析包会用到、并且需要在分组 sources 中标注的数据源键。 */
export type MarketSourceKey =
  | 'indices'
  | 'breadth'
  | 'limitUp'
  | 'broken'
  | 'limitDown'
  | 'yesterday'
  | 'limitReason'
  | 'dragonTiger'
  | 'marginSH'
  | 'leaderStrength'
  | 'marketHistory'
  | 'trend'

/** 腾讯行情接口 q= 返回的单条记录。 */
export interface RawTencentQuoteRow {
  ticker: string
  name: string
  code: string
  price: number | null
  previousClose: number | null
  open: number | null
  updatedAt: string
  tradeDate: string
  change: number
  changePct: number
  high: number | null
  low: number | null
  amountWan: number
}

/** 腾讯指数/个股行情快照，对应源项目 fetchIndices 的返回值。 */
export interface RawTencentQuotes {
  source: string
  sourceUrl?: string
  tradeDate: string
  rows: RawTencentQuoteRow[]
  amount: number | null
  indexChange: number | null
}

/** 腾讯日 K 接口的单根数据。 */
export interface RawKlineRow {
  tradeDate: string
  open: number | null
  close: number | null
}

/** 腾讯日 K，marketCap 单位为亿元，与源项目 scaled(qt[45], 1, 2) 一致。 */
export interface RawTencentKline {
  ticker: string
  rows: RawKlineRow[]
  marketCap: number | null
}

/** 东方财富涨停/炸板/跌停/昨日涨停池的单条记录（字段按上游原样保留）。 */
export interface RawPoolRow {
  c?: string | number
  n?: string
  p?: number | string
  zdp?: number | string
  amount?: number | string
  hs?: number | string
  tshare?: number | string
  ltsz?: number | string
  lbc?: number | string
  fbt?: string
  lbt?: string
  hybk?: string
  zttj?: { days?: number | string; ct?: number | string }
  [key: string]: unknown
}

/** 东方财富涨跌停池，对应源项目 fetchPool 的返回值。 */
export interface RawLimitPool {
  source: string
  sourceUrl?: string
  tradeDate: string
  total: number
  rows: RawPoolRow[]
}

/** 同花顺涨停揭秘/热点归因的个股记录。 */
export interface RawReasonRow {
  code: string
  name: string
  reason: string
  boardType: string | null
  highDays: string | null
  sealSuccessRate: number | null
  openTimes: number | null
  sealAmount: number | null
  turnoverRate: number | null
}

/** 同花顺涨停揭秘，对应源项目 parseThsLimitReason。 */
export interface RawLimitReason {
  source: string
  sourceUrl?: string
  tradeDate: string
  total: number
  downLimit: number | null
  tradeStatus: string
  rows: RawReasonRow[]
  fallbackReason?: string
}

/** 同花顺热点归因（备用源），对应源项目 parseThsHotReason。 */
export interface RawHotReason {
  source: string
  sourceUrl?: string
  tradeDate: string
  total: number
  rows: RawReasonRow[]
  fallbackReason?: string
}

export type RawReasonSource = RawLimitReason | RawHotReason

/** 东方财富龙虎榜单条记录。netBuy/buyAmount/sellAmount 单位为亿元。 */
export interface RawDragonTigerRow {
  code: string
  name: string
  changePct: number | null
  turnoverRate: number | null
  netBuy: number | null
  buyAmount: number | null
  sellAmount: number | null
  reason: string
  note: string
}

/** 东方财富龙虎榜，对应源项目 parseDragonTiger。 */
export interface RawDragonTiger {
  source: string
  sourceUrl?: string
  tradeDate: string
  total: number
  rows: RawDragonTigerRow[]
}

/** 上交所两融原始行（opDate/rzye 等按上游原样保留）。 */
export interface RawMarginRow {
  opDate?: string | number
  rzye?: number | string
  [key: string]: unknown
}

/** 上交所融资余额，balance 单位为亿元。 */
export interface RawMarginSH {
  source: string
  sourceUrl?: string
  tradeDate: string
  total: number | null
  rows: RawMarginRow[]
  balance?: number | null
  previousBalance?: number | null
  previousTradeDate?: string | null
  change?: number | null
  changePct?: number | null
  fallbackReason?: string
}

/** 东方财富沪深两市融资余额，balance 单位为亿元。 */
export interface RawMarginAll {
  source: string
  sourceUrl?: string
  tradeDate: string
  balance: number | null
  previousBalance: number | null
  change: number | null
  changePct: number | null
}

/** 东方财富指数日线的单根数据。 */
export interface RawDailyBar {
  tradeDate: string
  open: number
  close: number
  high: number
  low: number
  volume: number
  amount: number
  amplitude: number
  changePct: number
  change: number
  turnover: number
}

/** 东方财富指数日线，对应源项目 fetchDailySeries 的返回值。 */
export interface RawIndexDailySeries {
  source: string
  sourceUrl?: string
  rows: RawDailyBar[]
}

/** 东方财富两市成交额对比，amount 单位为亿元。 */
export interface RawMarketHistory {
  source: string
  tradeDate: string
  amount: number | null
  previousAmount: number | null
  amountChangePct: number | null
}

/** 东方财富指数分时的单点。 */
export interface RawTrendPoint {
  time: string
  price: number
  changePct: number | null
  volume: number | null
  amount: number | null
  average: number | null
}

/** 东方财富指数分时，对应源项目 fetchIndexTrend 的返回值。 */
export interface RawIndexTrend {
  source: string
  sourceUrl?: string
  tradeDate: string
  preClose: number | null
  points: RawTrendPoint[]
}

/** 单个指数的分时，携带腾讯行情代码与名称。 */
export interface RawIndexTrendEntry {
  ticker: string
  name: string
  trend: RawIndexTrend
}

/** 全市场涨跌分布，对应源项目 fetchBreadth 的返回值。 */
export interface RawBreadthDistribution {
  up10: number
  up5: number
  up2: number
  up0: number
  flat: number
  down0: number
  down2: number
  down5: number
  down10: number
}

export interface RawBreadth {
  source: string
  sourceUrl?: string
  total: number
  upCount: number
  downCount: number
  flatCount: number
  distribution: RawBreadthDistribution
  fallbackReason?: string
}

/** 腾讯相对强度记录，rs5/rs20 为相对指数的超额涨幅（百分点）。 */
export interface RawLeaderStrengthRow {
  code: string
  name: string
  marketCap: number | null
  rs5: number | null
  rs20: number | null
}

/** 龙头相对强度，对应源项目 fetchLeaderStrength 的返回值。 */
export interface RawLeaderStrength {
  source: string
  tradeDate: string
  total: number
  rows: RawLeaderStrengthRow[]
  byCode: Record<string, RawLeaderStrengthRow>
  note?: string
}

/**
 * 构建与分析共用的原始输入。
 * 未取得的分区传 null；调用方也可以整体省略字段。
 */
export interface TradingDayRawInput {
  indices: RawTencentQuotes | null
  breadth: RawBreadth | null
  limitUp: RawLimitPool | null
  broken: RawLimitPool | null
  limitDown: RawLimitPool | null
  yesterday: RawLimitPool | null
  limitReason: RawReasonSource | null
  dragonTiger: RawDragonTiger | null
  marginSH: RawMarginSH | null
  marginAll: RawMarginAll | null
  leaderStrength: RawLeaderStrength | null
  marketHistory: RawMarketHistory | null
  trend: RawIndexTrend | null
  indexTrends: RawIndexTrendEntry[] | null
}

/** 原始输入的部分形态：缺失字段视为未取得。 */
export type PartialTradingDayRawInput = Partial<TradingDayRawInput>

/** builders / analyzeTradingDay 的公共选项。 */
export interface MarketAnalysisOptions {
  /** 展示日期 YYYY-MM-DD 或紧凑日期 YYYYMMDD；缺省时从原始数据推导。 */
  tradeDate?: string | null
  generatedAt?: string
  /** 外部已有的来源状态；缺省时根据原始数据是否存在推导。 */
  sources?: TradingDaySource[]
  /** 外部显式指定的分组状态；缺省时由 sources 推导。 */
  status?: TradingDayStatus
}
