/**
 * 原始数据 → 契约类型。
 *
 * 字段命名差异全部在这里完成转换，contracts 保持不变。
 * 缺失值一律为 null / 空数组，不使用 0 填充。
 */
import type {
  TradingDayContextData,
  TradingDayDragonTigerData,
  TradingDayDrive,
  TradingDayIndex,
  TradingDayLadderGroup,
  TradingDayLimitPoolsData,
  TradingDayLimitStats,
  TradingDayLimitStock,
  TradingDayMargin,
  TradingDaySource,
  TradingDayStatus,
  TradingDayTheme,
  TradingDayThemesData,
  TradingDayTrend,
  TradingDayTurnover,
  TradingDayYesterdayPerformance,
} from '../../contracts/src/trading-day.ts'
import type {
  MarketAnalysisOptions,
  MarketSourceKey,
  PartialTradingDayRawInput,
  RawIndexTrend,
  RawPoolRow,
  RawReasonRow,
} from './types.ts'
import { displayDate, optionalNumber, pct, round, trimmed } from './parsers.ts'

const CONTEXT_SOURCE_KEYS: MarketSourceKey[] = ['indices', 'trend', 'marketHistory', 'marginSH']
const LIMIT_POOL_SOURCE_KEYS: MarketSourceKey[] = ['limitUp', 'broken', 'limitDown', 'yesterday']
const THEME_SOURCE_KEYS: MarketSourceKey[] = ['limitUp', 'limitReason']
const DRAGON_TIGER_SOURCE_KEYS: MarketSourceKey[] = ['dragonTiger']

const SOURCE_LABELS: Record<MarketSourceKey, string> = {
  indices: '腾讯财经',
  breadth: '东方财富',
  limitUp: '东方财富涨停池',
  broken: '东方财富炸板池',
  limitDown: '东方财富跌停池',
  yesterday: '东方财富昨日涨停池',
  limitReason: '同花顺涨停揭秘',
  dragonTiger: '东方财富龙虎榜',
  marginSH: '上交所（仅沪市）',
  leaderStrength: '腾讯财经',
  marketHistory: '东方财富指数日线',
  trend: '东方财富指数分时',
}

/** 读取某个来源声明的 source 文案。 */
function rawSourceLabel(input: PartialTradingDayRawInput, key: MarketSourceKey): string {
  const raw = rawOf(input, key)
  if (raw && typeof raw === 'object' && 'source' in raw) {
    const source = (raw as { source?: unknown }).source
    if (typeof source === 'string' && source.trim()) return source
  }
  return SOURCE_LABELS[key]
}

/** 判断某个来源是否取得了数据（空池也算取得，因为 total 可能为 0）。 */
function hasRaw(input: PartialTradingDayRawInput, key: MarketSourceKey): boolean {
  return rawOf(input, key) !== null && rawOf(input, key) !== undefined
}

function rawOf(input: PartialTradingDayRawInput, key: MarketSourceKey): unknown {
  switch (key) {
    case 'indices': return input.indices
    case 'breadth': return input.breadth
    case 'limitUp': return input.limitUp
    case 'broken': return input.broken
    case 'limitDown': return input.limitDown
    case 'yesterday': return input.yesterday
    case 'limitReason': return input.limitReason
    case 'dragonTiger': return input.dragonTiger
    case 'marginSH': return input.marginSH
    case 'leaderStrength': return input.leaderStrength
    case 'marketHistory': return input.marketHistory
    case 'trend': return input.trend
  }
}

/**
 * 生成分组的 sources。
 * 调用方可通过 options.sources 注入真实抓取状态；否则按数据是否存在推导。
 */
export function resolveSources(
  input: PartialTradingDayRawInput,
  keys: MarketSourceKey[],
  options: MarketAnalysisOptions = {},
): TradingDaySource[] {
  return keys.map((key) => {
    const provided = options.sources?.find((item) => item.key === key)
    if (provided) return provided
    const available = hasRaw(input, key)
    return {
      key,
      label: rawSourceLabel(input, key),
      state: available ? 'fresh' : 'unavailable',
      error: available ? null : '数据未提供',
    }
  })
}

/** 任一分组来源不可用时整组为 partial。 */
export function resolveStatus(
  sources: TradingDaySource[],
  options: MarketAnalysisOptions = {},
): TradingDayStatus {
  if (options.status) return options.status
  return sources.every((item) => item.state !== 'unavailable') ? 'complete' : 'partial'
}

/** 统一推导交易日：优先选项，其次按原始数据的分区顺序回退。 */
export function resolveTradeDate(
  input: PartialTradingDayRawInput,
  options: MarketAnalysisOptions = {},
): string {
  if (options.tradeDate) return displayDate(options.tradeDate)
  const candidates = [
    input.indices?.tradeDate,
    input.marketHistory?.tradeDate,
    input.trend?.tradeDate,
    input.limitUp?.tradeDate,
    input.broken?.tradeDate,
    input.limitDown?.tradeDate,
    input.yesterday?.tradeDate,
    input.dragonTiger?.tradeDate,
    input.marginSH?.tradeDate,
    input.limitReason?.tradeDate,
  ]
  for (const candidate of candidates) {
    const value = displayDate(candidate)
    if (value) return value
  }
  return ''
}

const nowIso = (): string => new Date().toISOString()
const metricMeta = (input: PartialTradingDayRawInput, options: MarketAnalysisOptions, keys: MarketSourceKey[]) => {
  const sources = resolveSources(input, keys, options)
  return { sources, status: resolveStatus(sources, options) }
}

const positiveNumber = (value: unknown): number | null => {
  const parsed = optionalNumber(value)
  return parsed !== null && parsed > 0 ? parsed : null
}

const codeOf = (row: RawPoolRow): string => String(row.c ?? '').trim()
const nameOf = (row: RawPoolRow): string => trimmed(row.n)
const boardOf = (row: RawPoolRow, fallback: number): number =>
  positiveNumber(row.lbc) ?? positiveNumber(row.zttj?.ct) ?? fallback

const poolChangePct = (row: RawPoolRow): number | null => {
  const value = optionalNumber(row.zdp)
  return value === null ? null : round(value, 2)
}

/** 池内成交额单位从元转换为亿元。 */
const poolAmount = (row: RawPoolRow): number | null => {
  const value = optionalNumber(row.amount)
  return value === null ? null : round(value / 1e8, 2)
}

/** 池内总市值优先取 tshare，其次流通市值 ltsz；转换为亿元。 */
const poolMarketCap = (row: RawPoolRow): number | null => {
  const value = optionalNumber(row.tshare) ?? optionalNumber(row.ltsz)
  return value === null ? null : round(value / 1e8, 2)
}

const textOrNull = (value: unknown): string | null => trimmed(value) || null

/** 原始分时 → 契约分时，指数代码统一使用腾讯行情代码。 */
function toTrend(ticker: string, name: string, raw: RawIndexTrend): TradingDayTrend {
  return {
    code: ticker,
    name,
    date: displayDate(raw.tradeDate) || null,
    prevClose: raw.preClose,
    points: raw.points.map((point) => ({
      time: point.time,
      price: point.price,
      avgPrice: point.average,
      volume: point.volume,
    })),
  }
}

/** 上下文分组：指数、分时、成交额、沪市融资余额。 */
export function buildContext(
  input: PartialTradingDayRawInput,
  options: MarketAnalysisOptions = {},
): TradingDayContextData {
  const { sources, status } = metricMeta(input, options, CONTEXT_SOURCE_KEYS)
  const indices: TradingDayIndex[] = (input.indices?.rows ?? []).map((row) => ({
    code: row.ticker,
    name: row.name,
    price: row.price,
    changePct: row.changePct,
    amount: round(row.amountWan / 10000, 2),
  }))
  const trends: TradingDayTrend[] = (input.indexTrends ?? []).map((entry) => toTrend(entry.ticker, entry.name, entry.trend))
  const trend: TradingDayTrend | null = input.trend
    ? toTrend('sh000001', '上证指数', input.trend)
    : trends.find((item) => item.code === 'sh000001') ?? trends[0] ?? null
  if (trend !== null && trends.length === 0) trends.push(trend)

  const amount = input.marketHistory?.amount ?? input.indices?.amount ?? null
  const previousAmount = input.marketHistory?.previousAmount ?? null
  const amountChangePct = input.marketHistory?.amountChangePct ?? null
  // 源项目 marketHistory 只提供上一交易日成交额，没有上一交易日日期。
  const turnover: TradingDayTurnover | null = amount !== null || previousAmount !== null || amountChangePct !== null
    ? { amount, previousAmount, previousTradeDate: null, changePct: amountChangePct }
    : null

  return {
    tradeDate: resolveTradeDate(input, options),
    generatedAt: options.generatedAt ?? nowIso(),
    status,
    indices,
    trend,
    trends,
    turnover,
    margin: buildMargin(input),
    sources,
  }
}

/**
 * 沪市融资余额。
 * 契约只有 total / previousTotal，因此把源项目展示的 balance / previousBalance 映射进去；
 * 上游总行数（pageHelp.total）不作为余额，避免误导。
 */
function buildMargin(input: PartialTradingDayRawInput): TradingDayMargin | null {
  const raw = input.marginSH
  if (!raw) return null
  const sum = raw.rows.reduce((total, row) => total + (optionalNumber(row.rzye) ?? 0), 0)
  const computed = raw.rows.length ? round(sum / 1e8, 2) : null
  const balance = raw.balance ?? computed
  const previousBalance = raw.previousBalance ?? null
  const change = raw.change ?? (balance !== null && previousBalance !== null ? round(balance - previousBalance, 2) : null)
  const changePct = raw.changePct ?? (balance !== null && previousBalance ? round((balance - previousBalance) / previousBalance * 100, 2) : null)
  const all = input.marginAll
  return {
    tradeDate: displayDate(raw.tradeDate) || null,
    total: balance,
    previousTotal: previousBalance,
    change,
    changePct,
    marketTotal: all?.balance ?? null,
    marketPreviousTotal: all?.previousBalance ?? null,
    marketChange: all?.change ?? null,
    marketChangePct: all?.changePct ?? null,
  }
}

/** 涨跌停分组：统计、连板天梯、昨日涨停表现。 */
export function buildLimitPools(
  input: PartialTradingDayRawInput,
  options: MarketAnalysisOptions = {},
): TradingDayLimitPoolsData {
  const { sources, status } = metricMeta(input, options, LIMIT_POOL_SOURCE_KEYS)
  const limitRows = input.limitUp?.rows ?? []
  const reasonByCode = new Map<string, RawReasonRow>(
    (input.limitReason?.rows ?? []).map((row) => [String(row.code), row]),
  )
  const ladder = buildLadder(limitRows, reasonByCode)
  const upLimit = input.limitUp?.total ?? null
  const brokenCount = input.broken?.total ?? null
  const downLimit = input.limitDown?.total ?? null
  const totalWithBroken = upLimit !== null && brokenCount !== null ? upLimit + brokenCount : null
  const sealRate = totalWithBroken !== null && totalWithBroken > 0 ? pct(upLimit, totalWithBroken) : null
  const breakRate = totalWithBroken !== null && totalWithBroken > 0 ? pct(brokenCount, totalWithBroken) : null
  const promotion = buildPromotion(input)
  const yesterdayPerformance = buildYesterdayPerformance(input)

  const stats: TradingDayLimitStats = {
    limitUp: upLimit,
    limitDown: downLimit,
    broken: brokenCount,
    sealRate,
    breakRate,
    firstBoard: upLimit === null ? null : (ladder.find((group) => group.board === 1)?.count ?? 0),
    lianban: upLimit === null
      ? null
      : ladder.filter((group) => group.board >= 2).reduce((sum, group) => sum + group.count, 0),
    maxBoard: ladder[0]?.board ?? null,
    promotionRate: promotion.promotionRate,
  }

  return {
    tradeDate: resolveTradeDate(input, options),
    generatedAt: options.generatedAt ?? nowIso(),
    status,
    stats,
    ladder,
    yesterdayPerformance,
    sources,
  }
}

function buildLadder(
  rows: RawPoolRow[],
  reasonByCode: Map<string, RawReasonRow>,
): TradingDayLadderGroup[] {
  const groups = new Map<number, TradingDayLadderGroup>()
  for (const row of rows) {
    const board = boardOf(row, 1)
    const detail = reasonByCode.get(codeOf(row))
    const group = groups.get(board) ?? {
      board,
      label: board === 1 ? '首板' : `${board}板`,
      count: 0,
      stocks: [],
    }
    group.count += 1
    if (group.stocks.length < 10) {
      const stock: TradingDayLimitStock = {
        code: codeOf(row),
        name: nameOf(row),
        price: optionalNumber(row.p),
        changePct: poolChangePct(row),
        amount: poolAmount(row),
        turnoverRate: optionalNumber(row.hs),
        marketCap: poolMarketCap(row),
        boardCount: board,
        firstLimitTime: textOrNull(row.fbt),
        lastLimitTime: textOrNull(row.lbt),
        reason: textOrNull(detail?.reason),
        boardType: textOrNull(detail?.boardType),
        theme: trimmed(row.hybk) || '其他',
      }
      group.stocks.push(stock)
    }
    groups.set(board, group)
  }
  return [...groups.values()].sort((left, right) => right.board - left.board)
}

function buildPromotion(input: PartialTradingDayRawInput): { promoted: number; promotionRate: number | null; codes: number } {
  const todayCodes = new Set((input.limitUp?.rows ?? []).map(codeOf).filter(Boolean))
  const yesterdayCodes = [...new Set((input.yesterday?.rows ?? []).map(codeOf).filter(Boolean))]
  const promoted = yesterdayCodes.filter((code) => todayCodes.has(code)).length
  return {
    promoted,
    promotionRate: yesterdayCodes.length ? pct(promoted, yesterdayCodes.length) : null,
    codes: yesterdayCodes.length,
  }
}

function buildYesterdayPerformance(input: PartialTradingDayRawInput): TradingDayYesterdayPerformance {
  const rows = input.yesterday?.rows ?? []
  const changes = rows
    .map((row) => optionalNumber(row.zdp))
    .filter((value): value is number => value !== null)
  const promotion = buildPromotion(input)
  const upCount = changes.filter((value) => value > 0).length
  const downCount = changes.filter((value) => value < 0).length
  const sorted = [...changes].sort((left, right) => left - right)
  let median: number | null = null
  if (sorted.length) {
    const middle = Math.floor(sorted.length / 2)
    median = sorted.length % 2
      ? (sorted[middle] ?? null)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
  }
  return {
    sample: input.yesterday?.total ?? (rows.length || null),
    promoted: promotion.promoted,
    avgChangePct: changes.length
      ? round(changes.reduce((sum, value) => sum + value, 0) / changes.length, 2)
      : null,
    medianChangePct: median === null ? null : round(median, 2),
    upRate: changes.length ? pct(upCount, changes.length) : null,
  }
}

/** 题材/驱动分组：按涨停原因标签词频聚合。 */
export function buildThemes(
  input: PartialTradingDayRawInput,
  options: MarketAnalysisOptions = {},
): TradingDayThemesData {
  const { sources, status } = metricMeta(input, options, THEME_SOURCE_KEYS)
  const limitRows = input.limitUp?.rows ?? []
  const reasonRows = input.limitReason?.rows ?? []
  const themes: TradingDayTheme[] = groupLimitDrives(limitRows, reasonRows, 8).map((item) => ({
    name: item.tag,
    count: item.count,
    maxBoard: item.maxBoard,
    leaders: item.leaders.map((leader) => leader.name).filter(Boolean).slice(0, 3),
  }))
  const drives: TradingDayDrive[] = groupLimitDrives(limitRows, reasonRows, 12).map((item) => ({
    tag: item.tag,
    count: item.count,
    maxBoard: item.maxBoard,
    leaders: item.leaders.map((leader) => leader.name).filter(Boolean).slice(0, 3),
  }))
  return {
    tradeDate: resolveTradeDate(input, options),
    generatedAt: options.generatedAt ?? nowIso(),
    status,
    themes,
    drives,
    sources,
  }
}

/** 龙虎榜：净买额前 12。 */
export function buildDragonTiger(
  input: PartialTradingDayRawInput,
  options: MarketAnalysisOptions = {},
): TradingDayDragonTigerData {
  const { sources, status } = metricMeta(input, options, DRAGON_TIGER_SOURCE_KEYS)
  return {
    tradeDate: resolveTradeDate(input, options),
    generatedAt: options.generatedAt ?? nowIso(),
    status,
    entries: [...(input.dragonTiger?.rows ?? [])]
      .sort((left, right) => (right.netBuy ?? -Infinity) - (left.netBuy ?? -Infinity))
      .slice(0, 20)
      .map((row) => ({
        code: row.code,
        name: row.name,
        reason: row.reason || null,
        netBuy: row.netBuy,
        changePct: row.changePct,
        turnoverRate: row.turnoverRate,
      })),
    sources,
  }
}

/** 按行业板块聚合涨停股，供分析层做主线分级（源项目 groupMainlines）。 */
export interface LimitMainlineGroup {
  name: string
  count: number
  maxBoard: number
  leaders: Array<{ code: string; name: string; board: number; changePct: number }>
}

export function groupLimitMainlines(rows: RawPoolRow[] | null | undefined): LimitMainlineGroup[] {
  const groups = new Map<string, LimitMainlineGroup>()
  for (const row of rows ?? []) {
    const name = String(row.hybk || '其他').trim() || '其他'
    const current = groups.get(name) ?? { name, count: 0, maxBoard: 0, leaders: [] }
    current.count += 1
    current.maxBoard = Math.max(current.maxBoard, boardOf(row, 0))
    if (current.leaders.length < 4) {
      current.leaders.push({
        code: codeOf(row),
        name: nameOf(row),
        board: boardOf(row, 1),
        changePct: round(Number(row.zdp) || 0, 2) ?? 0,
      })
    }
    groups.set(name, current)
  }
  return [...groups.values()]
    .sort((left, right) => right.count - left.count || right.maxBoard - left.maxBoard)
    .slice(0, 6)
}

/** 按涨停原因标签聚合（源项目 groupDrives）。 */
export interface LimitDriveGroup {
  tag: string
  count: number
  maxBoard: number
  leaders: Array<{ code: string; name: string }>
}

export function groupLimitDrives(
  limitRows: RawPoolRow[] | null | undefined,
  reasonRows: RawReasonRow[] | null | undefined,
  limit = 12,
): LimitDriveGroup[] {
  const boardByCode = new Map<string, number>(
    (limitRows ?? []).map((row) => [codeOf(row), boardOf(row, 1)]),
  )
  const groups = new Map<string, LimitDriveGroup>()
  for (const row of reasonRows ?? []) {
    const tags = String(row.reason || '').split(/[+、,，]/).map((item) => item.trim()).filter(Boolean)
    for (const tag of tags) {
      const group = groups.get(tag) ?? { tag, count: 0, maxBoard: 0, leaders: [] }
      group.count += 1
      group.maxBoard = Math.max(group.maxBoard, boardByCode.get(String(row.code)) || 1)
      if (group.leaders.length < 3) group.leaders.push({ code: row.code, name: row.name })
      groups.set(tag, group)
    }
  }
  return [...groups.values()]
    .sort((left, right) => right.count - left.count || right.maxBoard - left.maxBoard)
    .slice(0, limit)
}
