/**
 * 纯文本 / JSON 解析函数。
 *
 * 这些函数只接收上游响应字符串或已解析的 JSON，不发任何网络请求。
 * 规则与字段映射逐一对应源项目 src/market-review.js 中的 parse* 与 fetch* 内的解析逻辑。
 */
import type {
  RawBreadthDistribution,
  RawDailyBar,
  RawDragonTiger,
  RawDragonTigerRow,
  RawIndexTrend,
  RawLimitPool,
  RawLimitReason,
  RawMarginSH,
  RawPoolRow,
  RawReasonRow,
  RawTencentKline,
  RawTencentQuoteRow,
  RawTrendPoint,
} from './types.ts'

/** 与源项目一致的数值格式化：非有限值返回 null。 */
export const round = (value: number, digits = 1): number | null =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null

/** 百分比，分母无效时返回 null，避免用 0 伪造。 */
export const pct = (part: number | null, total: number | null): number | null =>
  part !== null && total !== null && Number.isFinite(part) && Number.isFinite(total) && total > 0
    ? round(part / total * 100, 1)
    : null

/** 紧凑日期 YYYYMMDD。 */
export const compactDate = (value: unknown): string => String(value || '').replace(/-/g, '').slice(0, 8)

/** 展示日期 YYYY-MM-DD。 */
export const displayDate = (value: unknown): string =>
  compactDate(value).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')

/** 空字符串/缺省值视为 null。 */
export const optionalNumber = (value: unknown): number | null => {
  if (value === '' || value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** 去除首尾空白，非字符串返回空串。 */
export const trimmed = (value: unknown): string =>
  typeof value === 'string' && value.trim() ? value.trim() : ''

/** 按除数缩放并保留指定小数位。 */
export const scaled = (value: unknown, divisor: number, digits = 2): number | null => {
  const parsed = optionalNumber(value)
  return parsed === null ? null : round(parsed / divisor, digits)
}

/** 代码到腾讯 ticker 的映射，与源项目一致：仅沪深。 */
export const toTicker = (code: unknown): string => {
  const value = String(code || '')
  if (/^6\d{5}$/.test(value)) return `sh${value}`
  if (/^[03]\d{5}$/.test(value)) return `sz${value}`
  return ''
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : []

/**
 * 腾讯指数/个股行情。格式：v_sh000001="1~上证指数~000001~...";
 * 返回值与源项目 parseTencentQuotes 一致（仅 rows）。
 */
export function parseTencentQuotes(source: string): RawTencentQuoteRow[] {
  const rows: RawTencentQuoteRow[] = []
  for (const part of String(source).split(';')) {
    const match = part.match(/v_([a-z0-9]+)="([^"]*)"/i)
    if (!match) continue
    const ticker = match[1] ?? ''
    const fields = (match[2] ?? '').split('~')
    const updatedAt = fields[30] ?? ''
    rows.push({
      ticker,
      name: fields[1] || ticker,
      code: fields[2] || '',
      price: Number(fields[3]) || null,
      previousClose: Number(fields[4]) || null,
      open: Number(fields[5]) || null,
      updatedAt,
      tradeDate: compactDate(updatedAt),
      change: Number(fields[31]) || 0,
      changePct: Number(fields[32]) || 0,
      high: Number(fields[33]) || null,
      low: Number(fields[34]) || null,
      amountWan: Number(fields[37]) || 0,
    })
  }
  if (!rows.length) throw new Error('腾讯指数响应为空或字段格式变化')
  return rows
}

/**
 * 东方财富涨停/炸板/跌停/昨日涨停池。
 * 对应源项目 fetchPool 中的校验与日期匹配逻辑。
 */
export function parseEastmoneyPool(source: string | unknown, date: string): RawLimitPool {
  const value = typeof source === 'string' ? JSON.parse(source) as unknown : source
  const root = asRecord(value)
  const data = asRecord(root?.['data'])
  const total = optionalNumber(data?.['tc'])
  const pool = asArray(data?.['pool'])
  if (!data || total === null || !Array.isArray(data['pool'])) {
    throw new Error('涨跌停池未发布或响应格式变化')
  }
  const tradeDate = compactDate(data['qdate'] || date)
  if (tradeDate !== compactDate(date)) throw new Error(`涨跌停池日期不匹配：${tradeDate}`)
  return {
    source: '东方财富',
    tradeDate,
    total,
    rows: pool as RawPoolRow[],
  }
}

const reasonRow = (row: Record<string, unknown>): RawReasonRow => ({
  code: String(row['code'] || ''),
  name: trimmed(row['name']),
  reason: trimmed(row['reason_type'] ?? row['reason']),
  boardType: trimmed(row['limit_up_type']) || null,
  highDays: trimmed(row['high_days']) || null,
  sealSuccessRate: optionalNumber(row['limit_up_suc_rate']) === null
    ? null
    : round(Number(row['limit_up_suc_rate']) * 100, 1),
  openTimes: optionalNumber(row['open_num']),
  sealAmount: scaled(row['order_amount'], 1e8),
  turnoverRate: optionalNumber(row['turnover_rate']),
})

/** 同花顺涨停揭秘，对应源项目 parseThsLimitReason。 */
export function parseThsLimitReason(source: string | unknown, date: string): RawLimitReason {
  const value = typeof source === 'string' ? JSON.parse(source) as unknown : source
  const root = asRecord(value)
  if (Number(root?.['status_code']) !== 0) {
    throw new Error(`同花顺涨停揭秘返回异常：${String(root?.['status_msg'] ?? root?.['status_code'])}`)
  }
  const data = asRecord(root?.['data'])
  const info = data?.['info']
  if (!Array.isArray(info)) throw new Error('同花顺涨停揭秘响应格式变化')
  const reported = compactDate(data?.['date'])
  if (reported && reported !== compactDate(date)) {
    throw new Error(`同花顺涨停揭秘日期不匹配：${reported}`)
  }
  const rows = info
    .map((item) => reasonRow(asRecord(item) ?? {}))
    .filter((item) => item.code)
  return {
    source: '同花顺涨停揭秘',
    tradeDate: reported || compactDate(date),
    total: optionalNumber(data?.['limit_up_count']) ?? info.length,
    downLimit: optionalNumber(data?.['limit_down_count']),
    tradeStatus: trimmed(data?.['trade_status']),
    rows,
  }
}

/** 同花顺热点归因（备用源），对应源项目 parseThsHotReason。 */
export function parseThsHotReason(source: string | unknown, date: string): RawLimitReason {
  const value = typeof source === 'string' ? JSON.parse(source) as unknown : source
  const root = asRecord(value)
  if (Number(root?.['errocode']) !== 0) {
    throw new Error(`同花顺热点归因返回异常：${String(root?.['errormsg'] ?? root?.['errocode'])}`)
  }
  const rows = root?.['data']
  if (!Array.isArray(rows)) throw new Error('同花顺热点归因响应格式变化')
  const reported = compactDate(root?.['date'])
  if (reported && reported !== compactDate(date)) {
    throw new Error(`同花顺热点归因日期不匹配：${reported}`)
  }
  return {
    source: '同花顺热点归因（备用）',
    tradeDate: reported || compactDate(date),
    total: rows.length,
    downLimit: null,
    tradeStatus: '',
    rows: rows.map((item) => {
      const row = asRecord(item) ?? {}
      return {
        code: String(row['code'] || ''),
        name: trimmed(row['name']),
        reason: trimmed(row['reason']),
        boardType: null,
        highDays: null,
        sealSuccessRate: null,
        openTimes: null,
        sealAmount: null,
        turnoverRate: null,
      }
    }).filter((item) => item.code),
  }
}

/** 东方财富龙虎榜，对应源项目 parseDragonTiger（按净买额取前 20）。 */
export function parseDragonTiger(source: string | unknown, date: string): RawDragonTiger {
  const value = typeof source === 'string' ? JSON.parse(source) as unknown : source
  const result = asRecord(asRecord(value)?.['result'])
  const rows = result?.['data']
  if (!Array.isArray(rows)) throw new Error('东方财富龙虎榜响应格式变化')
  const tradeDate = compactDate(date)
  const picked: RawDragonTigerRow[] = rows
    .map((item) => asRecord(item) ?? {})
    .filter((row) => compactDate(row['TRADE_DATE']) === tradeDate)
    .map((row) => ({
      code: String(row['SECURITY_CODE'] || ''),
      name: trimmed(row['SECURITY_NAME_ABBR']),
      changePct: optionalNumber(row['CHANGE_RATE']) === null ? null : round(Number(row['CHANGE_RATE']), 2),
      turnoverRate: optionalNumber(row['TURNOVERRATE']) === null ? null : round(Number(row['TURNOVERRATE']), 2),
      netBuy: scaled(row['BILLBOARD_NET_AMT'], 1e8),
      buyAmount: scaled(row['BILLBOARD_BUY_AMT'], 1e8),
      sellAmount: scaled(row['BILLBOARD_SELL_AMT'], 1e8),
      reason: trimmed(row['EXPLANATION']),
      note: trimmed(row['EXPLAIN']),
    }))
    .filter((row) => row.code)
  if (!picked.length) throw new Error(`东方财富龙虎榜未发布 ${displayDate(tradeDate)}`)
  return {
    source: '东方财富龙虎榜',
    tradeDate,
    total: optionalNumber(result?.['total']) ?? picked.length,
    rows: picked.sort((left, right) => (right.netBuy ?? -Infinity) - (left.netBuy ?? -Infinity)).slice(0, 20),
  }
}

/** 腾讯日 K，对应源项目 parseTencentKline。 */
export function parseTencentKline(source: string | unknown, ticker: string): RawTencentKline {
  const value = typeof source === 'string' ? JSON.parse(source) as unknown : source
  const data = asRecord(asRecord(value)?.['data'])
  const node = asRecord(data?.[ticker])
  const series = node?.['qfqday'] ?? node?.['day']
  if (!Array.isArray(series) || !series.length) throw new Error(`腾讯日K不可用：${ticker}`)
  const rows = series.map((line) => {
    const parts = asArray(line)
    return {
      tradeDate: compactDate(parts[0]),
      open: optionalNumber(parts[1]),
      close: optionalNumber(parts[2]),
    }
  }).filter((row) => /^\d{8}$/.test(row.tradeDate) && row.close !== null)
  if (!rows.length) throw new Error(`腾讯日K无有效收盘价：${ticker}`)
  const qt = asRecord(node?.['qt'])
  const quote = asRecord(qt?.[ticker]) ?? {}
  return { ticker, rows, marketCap: scaled(quote['45'], 1, 2) }
}

/**
 * 相对强度：个股区间涨幅减去指数区间涨幅，单位为百分点。
 * 参数语义与源项目 relativeStrength 完全一致。
 */
export function relativeStrength(closes: number[], benchmarks: number[], days = 5): number | null {
  const stock = Array.isArray(closes) ? closes.slice(-(days + 1)) : []
  const benchmark = Array.isArray(benchmarks) ? benchmarks.slice(-(days + 1)) : []
  if (stock.length !== days + 1 || benchmark.length !== days + 1) return null
  const base = stock[0]
  const latest = stock.at(-1)
  const indexBase = benchmark[0]
  const indexLatest = benchmark.at(-1)
  if (base === undefined || latest === undefined || indexBase === undefined || indexLatest === undefined) return null
  if (![base, latest, indexBase, indexLatest].every(Number.isFinite) || !base || !indexBase) return null
  return round((latest / base - 1) * 100 - (indexLatest / indexBase - 1) * 100, 2)
}

/** 上交所两融，对应源项目 parseMarginSH。 */
export function parseMarginSH(source: string | unknown, date: string): RawMarginSH {
  const value = typeof source === 'string' ? JSON.parse(source) as unknown : source
  const pageHelp = asRecord(asRecord(value)?.['pageHelp'])
  const rows = pageHelp?.['data']
  if (!Array.isArray(rows)) throw new Error('上交所两融响应格式变化')
  const tradeDate = compactDate(date)
  const dated = rows
    .filter((row) => compactDate(asRecord(row)?.['opDate']) === tradeDate)
    .map((row) => asRecord(row) ?? {})
  if (!dated.length) throw new Error(`上交所两融未发布 ${displayDate(tradeDate)}`)
  return {
    source: '上交所（仅沪市）',
    tradeDate,
    total: optionalNumber(pageHelp?.['total']) ?? dated.length,
    rows: dated,
  }
}

/** 东方财富指数日线，对应源项目 fetchDailySeries 中的 rows 解析。 */
export function parseEastmoneyKline(source: string | unknown): RawDailyBar[] {
  const value = typeof source === 'string' ? JSON.parse(source) as unknown : source
  const data = asRecord(asRecord(value)?.['data'])
  const klines = asArray(data?.['klines'])
  const rows = klines.map((line) => {
    const parts = String(line).split(',')
    return {
      tradeDate: compactDate(parts[0]),
      open: Number(parts[1]),
      close: Number(parts[2]),
      high: Number(parts[3]),
      low: Number(parts[4]),
      volume: Number(parts[5]),
      amount: Number(parts[6]),
      amplitude: Number(parts[7]),
      changePct: Number(parts[8]),
      change: Number(parts[9]),
      turnover: Number(parts[10]),
    }
  }).filter((row) => /^\d{8}$/.test(row.tradeDate))
  if (!rows.length) throw new Error('指数日线数据不可用')
  return rows
}

/** 东方财富指数分时，对应源项目 fetchIndexTrend 中的 points 解析。 */
export function parseEastmoneyTrend(source: string | unknown, date: string): RawIndexTrend {
  const value = typeof source === 'string' ? JSON.parse(source) as unknown : source
  const data = asRecord(asRecord(value)?.['data'])
  const preClose = optionalNumber(data?.['preClose'])
  const trends = asArray(data?.['trends'])
  const points: RawTrendPoint[] = trends.map((line) => {
    const parts = String(line).split(',')
    const close = Number(parts[2])
    return {
      time: String(parts[0] ?? ''),
      price: close,
      changePct: preClose ? round((close - preClose) / preClose * 100, 2) : null,
      volume: optionalNumber(parts[5]),
      amount: optionalNumber(parts[6]),
      average: optionalNumber(parts[7]),
    }
  }).filter((item) => Number.isFinite(item.price))
  if (!points.length) throw new Error('指数分时数据不可用')
  const first = points[0]
  const tradeDate = compactDate(first ? first.time.slice(0, 10) : '')
  if (tradeDate !== compactDate(date)) {
    throw new Error(`指数分时只提供最新交易日（${displayDate(tradeDate)}）`)
  }
  return {
    source: '东方财富指数分时',
    tradeDate,
    preClose,
    points,
  }
}

/** 东方财富涨跌分布单页，返回 total 与按涨跌幅降序的 f3 列表。 */
export function parseEastmoneyBreadthPage(source: string | unknown): { total: number | null; rows: number[] } {
  const value = typeof source === 'string' ? JSON.parse(source) as unknown : source
  const data = asRecord(asRecord(value)?.['data'])
  const diff = asArray(data?.['diff'])
  const rows = diff
    .map((row) => optionalNumber(asRecord(row)?.['f3']))
    .filter((value): value is number => value !== null)
  if (!rows.length) throw new Error('东方财富涨跌分布页为空')
  return { total: optionalNumber(data?.['total']) ?? rows.length, rows }
}

/**
 * 对完整、按涨跌幅降序排列的全市场数据计算涨跌分布。
 * 等价于源项目 summarizeSortedBreadth 的二分统计结果，但不发请求。
 */
export function summarizeBreadth(values: number[], total = values.length): {
  total: number
  upCount: number
  downCount: number
  flatCount: number
  distribution: RawBreadthDistribution
} {
  const sorted = [...values].sort((left, right) => right - left)
  const countAtLeast = (threshold: number): number =>
    sorted.filter((value) => value >= threshold).length
  const at10 = countAtLeast(10)
  const at5 = countAtLeast(5)
  const at2 = countAtLeast(2)
  const positive = countAtLeast(Number.EPSILON)
  const nonNegative = countAtLeast(0)
  const atMinus2 = countAtLeast(-2)
  const atMinus5 = countAtLeast(-5)
  const atMinus10 = countAtLeast(-10)
  return {
    total,
    upCount: positive,
    downCount: total - nonNegative,
    flatCount: nonNegative - positive,
    distribution: {
      up10: at10,
      up5: at5 - at10,
      up2: at2 - at5,
      up0: positive - at2,
      flat: nonNegative - positive,
      down0: atMinus2 - nonNegative,
      down2: atMinus5 - atMinus2,
      down5: atMinus10 - atMinus5,
      down10: total - atMinus10,
    },
  }
}
