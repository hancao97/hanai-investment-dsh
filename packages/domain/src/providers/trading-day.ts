/**
 * 今日交易数据：公开数据源抓取 + market-analysis 解析/构建。
 *
 * 网络、时间与缓存全部可注入，便于确定性测试。
 * 每个分区独立失败：某一路不可用时保留 null，由 builders 标记为 partial，不使用 0 占位。
 */
import type {
  TradingDayAnalysisData,
  TradingDayContextData,
  TradingDayDragonTigerData,
  TradingDayLimitPoolsData,
  TradingDaySectorSignal,
  TradingDayThemesData,
} from '../../../contracts/src/index.ts'
import type {
  PartialTradingDayRawInput,
  RawBreadth,
  RawBreadthDistribution,
  RawDragonTiger,
  RawIndexDailySeries,
  RawIndexTrend,
  RawIndexTrendEntry,
  RawLeaderStrength,
  RawLeaderStrengthRow,
  RawLimitPool,
  RawMarginAll,
  RawMarginRow,
  RawMarginSH,
  RawMarketHistory,
  RawPoolRow,
  RawReasonSource,
  RawTencentKline,
  RawTencentQuotes,
  RawTrendPoint,
} from '../../../market-analysis/src/types.ts'
import {
  analyzeTradingDay,
  buildContext,
  buildDragonTiger,
  buildLimitPools,
  buildThemes,
  compactDate,
  displayDate,
  optionalNumber,
  parseDragonTiger,
  parseEastmoneyKline,
  parseEastmoneyPool,
  parseEastmoneyTrend,
  parseMarginSH,
  parseTencentKline,
  parseTencentQuotes,
  parseThsHotReason,
  parseThsLimitReason,
  relativeStrength,
  round,
  trimmed,
} from '../../../market-analysis/src/index.ts'
import { systemClock, type Clock, type HttpClient, type HttpRequest } from '../http.ts'
import type { TradingDayFacade } from '../trading-day.ts'

const EASTMONEY_TOKEN = '7eea3edcaed734bea9cbfc24409ed989'
const INDEX_TICKERS = ['sh000001', 'sz399001', 'sz399006', 'sh000300', 'sh000688', 'bj899050']
const INDEX_NAMES: Record<string, string> = {
  sh000001: '上证指数',
  sz399001: '深证成指',
  sz399006: '创业板指',
  sh000300: '沪深300',
  sh000688: '科创50',
  bj899050: '北证50',
}
const TREND_SECIDS: Record<string, string> = {
  sh000001: '1.000001',
  sz399001: '0.399001',
  sz399006: '0.399006',
  sh000300: '1.000300',
  sh000688: '1.000688',
  bj899050: '0.899050',
}
const THS_LIMIT_FIELDS = '199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004'
const USER_AGENT = 'Mozilla/5.0 DSH Stock Review/0.4'
const LEADER_STRENGTH_LIMIT = 60

const BASE_HEADERS = { Accept: '*/*', 'User-Agent': USER_AGENT }
const EASTMONEY_HEADERS = { ...BASE_HEADERS, Referer: 'https://quote.eastmoney.com/' }
const TENCENT_HEADERS = { ...BASE_HEADERS, Referer: 'https://gu.qq.com/' }
const THS_HEADERS = { ...BASE_HEADERS, Referer: 'https://data.10jqka.com.cn/' }
const THS_NEWS_HEADERS = { ...BASE_HEADERS, Referer: 'https://news.10jqka.com.cn/' }
const SSE_HEADERS = { ...BASE_HEADERS, Referer: 'https://www.sse.com.cn/' }

const DEFAULT_CACHE_TTL_MS = 25_000
const HISTORY_CACHE_TTL_MS = 60_000
const MARGIN_CACHE_TTL_MS = 5 * 60_000
/** 分时类数据收盘后不再变化，缓存 6 小时，避免反复请求（也降低被上游限流的风险）。 */
const CLOSED_TREND_CACHE_TTL_MS = 6 * 60 * 60_000
/** 板块异动判定：观察窗口（分钟）与该窗口内的最小涨跌幅。 */
const SECTOR_WINDOW = 3
const SECTOR_MIN_WINDOW_CHANGE = 1.0
/** 概念板块榜中属于交易属性、而非题材的标签，需从异动池中剔除。 */
const EXCLUDED_CONCEPTS = ['标的', '股通', '融资融券', '转融券', '富时', 'MSCI', '标普', '同股同权']

export interface TradingDayProviderOptions {
  clock?: Clock
  timeoutMs?: number
  /** 行情类分区的默认缓存时间。 */
  cacheTtlMs?: number
}

interface RequestOptions {
  headers?: Readonly<Record<string, string>>
  timeoutMs?: number
  retries?: number
  encoding?: 'gb18030'
}

interface KlineWithSource extends RawTencentKline {
  source: string
  sourceUrl: string
}

/** 同花顺快讯条目（只列出异动解析需要的字段）。 */
interface ThsNewsItem {
  ctime?: unknown
  title?: unknown
  field?: Array<{ name?: unknown; stockCode?: unknown }>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function safe<T>(task: () => Promise<T>): Promise<T | null> {
  try {
    return await task()
  } catch {
    return null
  }
}

/** 限制并发的小工具：保持请求顺序稳定，避免一次性向腾讯发起 60 个请求。 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      const item = items[index]
      if (item === undefined) return
      results[index] = await task(item)
    }
  })
  await Promise.all(workers)
  return results
}

function subtractDays(value: string, days: number): string {
  const text = displayDate(value)
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T12:00:00Z`) : new Date()
  date.setUTCDate(date.getUTCDate() - days)
  return compactDate(date.toISOString().slice(0, 10))
}

const boardOf = (row: RawPoolRow): number =>
  optionalNumber(row.lbc) ?? optionalNumber(row.zttj?.ct) ?? 1

const codeOf = (row: RawPoolRow): string => String(row.c ?? '').trim()

const toTicker = (code: string): string => {
  if (/^6\d{5}$/.test(code)) return `sh${code}`
  if (/^[03]\d{5}$/.test(code)) return `sz${code}`
  return ''
}

/** "YYYY-MM-DD HH:mm" → 当日分钟数；用于判断窗口是否跨过午间休市。 */
function minutesOfClock(time: string): number {
  const hm = time.slice(-5)
  return Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5))
}

/** 九个涨跌幅档位，与 market-analysis 的 summarizeBreadth 阈值一致。 */
function emptyDistribution(): RawBreadthDistribution {
  return { up10: 0, up5: 0, up2: 0, up0: 0, flat: 0, down0: 0, down2: 0, down5: 0, down10: 0 }
}

/**
 * 东方财富涨跌分布接口按整数百分点分桶（-11 至 11），
 * 直接映射到九档分布，避免逐页拉取全市场。
 */
function distributionFromBuckets(buckets: unknown[]): {
  distribution: RawBreadthDistribution
  upCount: number
  downCount: number
  flatCount: number
} {
  const distribution = emptyDistribution()
  for (const bucket of buckets) {
    if (bucket === null || typeof bucket !== 'object' || Array.isArray(bucket)) continue
    for (const [rawKey, rawValue] of Object.entries(bucket)) {
      const key = Number(rawKey)
      const count = Number(rawValue)
      if (!Number.isFinite(key) || !Number.isFinite(count) || count <= 0) continue
      if (key >= 10) distribution.up10 += count
      else if (key >= 5) distribution.up5 += count
      else if (key >= 2) distribution.up2 += count
      else if (key >= 1) distribution.up0 += count
      else if (key === 0) distribution.flat += count
      else if (key >= -1) distribution.down0 += count
      else if (key >= -4) distribution.down2 += count
      else if (key >= -9) distribution.down5 += count
      else distribution.down10 += count
    }
  }
  const upCount = distribution.up10 + distribution.up5 + distribution.up2 + distribution.up0
  const downCount = distribution.down0 + distribution.down2 + distribution.down5 + distribution.down10
  return { distribution, upCount, downCount, flatCount: distribution.flat }
}

export class TradingDayProvider implements TradingDayFacade {
  private readonly clock: Clock
  private readonly timeoutMs: number
  private readonly cacheTtlMs: number
  private readonly cache = new Map<string, { at: number; value: unknown }>()
  private readonly inflight = new Map<string, Promise<unknown>>()
  private readonly lastRequestAt = new Map<string, number>()
  private queueTail: Promise<void> = Promise.resolve()
  private generation = 0

  constructor(
    private readonly http: HttpClient,
    options: TradingDayProviderOptions = {},
  ) {
    this.clock = options.clock ?? systemClock
    this.timeoutMs = options.timeoutMs ?? 12_000
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  }

  /** 清除行情缓存与正在飞行的请求，返回被丢弃的条目数。 */
  clearCache(): number {
    const size = this.cache.size + this.inflight.size
    this.generation += 1
    this.cache.clear()
    this.inflight.clear()
    return size
  }

  async tradingDayContext(): Promise<TradingDayContextData> {
    const tradeDate = await this.detectTradeDate()
    const input: PartialTradingDayRawInput = {}
    if (tradeDate !== null) {
      const [indices, indexTrends, marketHistory, marginSH, marginAll, sectorSignals] = await Promise.all([
        safe(() => this.indicesLatest()),
        safe(() => this.indexTrends(tradeDate)),
        safe(() => this.marketHistory(tradeDate)),
        safe(() => this.marginSH(tradeDate)),
        safe(() => this.marginAll(tradeDate)),
        safe(() => this.sectorAnomalies(tradeDate)),
      ])
      input.indices = indices
      input.indexTrends = indexTrends
      input.trend = indexTrends?.find((entry) => entry.ticker === 'sh000001')?.trend ?? null
      input.marketHistory = marketHistory
      input.marginSH = marginSH
      input.marginAll = marginAll
      // sectorSignals 不需要进 builders 的 raw input，直接在 buildContext 之后合并到 context
      const context = buildContext(input, { tradeDate })
      context.sectorSignals = sectorSignals ?? []
      return context
    }
    const context = buildContext(input, { tradeDate })
    context.sectorSignals = []
    return context
  }

  async tradingDayLimitPools(): Promise<TradingDayLimitPoolsData> {
    const tradeDate = await this.detectTradeDate()
    const input: PartialTradingDayRawInput = {}
    if (tradeDate !== null) {
      const [limitUp, broken, limitDown, yesterday, limitReason] = await Promise.all([
        safe(() => this.fetchPool('getTopicZTPool', tradeDate, 'fbt:asc')),
        safe(() => this.fetchPool('getTopicZBPool', tradeDate, 'fbt:asc')),
        safe(() => this.fetchPool('getTopicDTPool', tradeDate, 'fund:asc')),
        safe(() => this.fetchPool('getYesterdayZTPool', tradeDate, 'zs:desc')),
        safe(() => this.limitReason(tradeDate)),
      ])
      input.limitUp = limitUp
      input.broken = broken
      input.limitDown = limitDown
      input.yesterday = yesterday
      input.limitReason = limitReason
    }
    return buildLimitPools(input, { tradeDate })
  }

  async tradingDayThemes(): Promise<TradingDayThemesData> {
    const tradeDate = await this.detectTradeDate()
    const input: PartialTradingDayRawInput = {}
    if (tradeDate !== null) {
      const [limitUp, limitReason] = await Promise.all([
        safe(() => this.fetchPool('getTopicZTPool', tradeDate, 'fbt:asc')),
        safe(() => this.limitReason(tradeDate)),
      ])
      input.limitUp = limitUp
      input.limitReason = limitReason
    }
    return buildThemes(input, { tradeDate })
  }

  async tradingDayDragonTiger(): Promise<TradingDayDragonTigerData> {
    const tradeDate = await this.detectTradeDate()
    const input: PartialTradingDayRawInput = {}
    if (tradeDate !== null) input.dragonTiger = await safe(() => this.dragonTiger(tradeDate))
    return buildDragonTiger(input, { tradeDate })
  }

  async tradingDayAnalysis(): Promise<TradingDayAnalysisData> {
    const tradeDate = await this.detectTradeDate()
    const input: PartialTradingDayRawInput = {}
    if (tradeDate !== null) {
      const [indices, breadth, limitUp, broken, limitDown, yesterday, limitReason] = await Promise.all([
        safe(() => this.indicesLatest()),
        safe(() => this.breadth()),
        safe(() => this.fetchPool('getTopicZTPool', tradeDate, 'fbt:asc')),
        safe(() => this.fetchPool('getTopicZBPool', tradeDate, 'fbt:asc')),
        safe(() => this.fetchPool('getTopicDTPool', tradeDate, 'fund:asc')),
        safe(() => this.fetchPool('getYesterdayZTPool', tradeDate, 'zs:desc')),
        safe(() => this.limitReason(tradeDate)),
      ])
      input.indices = indices
      input.breadth = breadth
      input.limitUp = limitUp
      input.broken = broken
      input.limitDown = limitDown
      input.yesterday = yesterday
      input.limitReason = limitReason
      input.leaderStrength = limitUp === null ? null : await safe(() => this.leaderStrength(limitUp))
    }
    return analyzeTradingDay(input, { tradeDate })
  }

  private memo<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key)
    if (hit !== undefined && this.clock.now() - hit.at < ttlMs) return Promise.resolve(hit.value as T)
    const active = this.inflight.get(key)
    if (active !== undefined) return active as Promise<T>
    const generation = this.generation
    const promise: Promise<T> = loader()
      .then((value) => {
        // clearCache 之后返回的旧结果不再写入缓存。
        if (this.generation === generation) this.cache.set(key, { at: this.clock.now(), value })
        return value
      })
      .finally(() => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key)
      })
    this.inflight.set(key, promise)
    return promise
  }

  /** 同一时刻只发出一个请求，并按来源维持最小间隔。 */
  private async throttle(key: string, gapMs: number): Promise<void> {
    const previous = this.queueTail
    let release: () => void = () => {}
    this.queueTail = new Promise((resolve) => {
      release = resolve
    })
    await previous
    try {
      const wait = (this.lastRequestAt.get(key) ?? 0) + gapMs - this.clock.now()
      if (wait > 0) await this.clock.sleep(wait)
      this.lastRequestAt.set(key, this.clock.now())
    } finally {
      release()
    }
  }

  private async text(url: string, options: RequestOptions = {}): Promise<string> {
    const retries = options.retries ?? 1
    let lastError: unknown = null
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const request: HttpRequest = {
          timeoutMs: options.timeoutMs ?? this.timeoutMs,
          headers: { ...BASE_HEADERS, ...options.headers },
        }
        if (options.encoding !== undefined) request.responseEncoding = options.encoding
        const response = await this.http.request(url, request)
        if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`)
        return response.body
      } catch (error) {
        lastError = error
        if (attempt < retries) await this.clock.sleep(800 * (attempt + 1))
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private async json<T>(url: string, options: RequestOptions = {}): Promise<T> {
    const value = JSON.parse(await this.text(url, options)) as T
    if (value !== null && typeof value === 'object' && 'rc' in value) {
      const rc = (value as { rc?: unknown }).rc
      if (rc !== undefined && Number(rc) !== 0) throw new Error(`upstream rc=${String(rc)}`)
    }
    return value
  }

  private shanghaiToday(): string {
    const now = new Date(this.clock.now() + 8 * 60 * 60 * 1000)
    const month = String(now.getUTCMonth() + 1).padStart(2, '0')
    const day = String(now.getUTCDate()).padStart(2, '0')
    return `${now.getUTCFullYear()}-${month}-${day}`
  }

  /**
   * 分时类数据的缓存时长：盘中（15:00 前）保持短 TTL 以便实时刷新；
   * 已收盘或历史交易日的数据不再变化，改用长 TTL，避免无谓请求。
   */
  private trendTtlMs(date: string): number {
    const today = compactDate(this.shanghaiToday())
    if (date < today) return CLOSED_TREND_CACHE_TTL_MS
    const now = new Date(this.clock.now() + 8 * 60 * 60 * 1000)
    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
    return minutes >= 15 * 60 ? CLOSED_TREND_CACHE_TTL_MS : this.cacheTtlMs
  }

  /** 交易日优先取腾讯指数快照；失败时回退到东方财富指数日线的最后一根。 */
  private detectTradeDate(): Promise<string | null> {
    return this.memo(`trade-date:${this.shanghaiToday()}`, this.cacheTtlMs, async () => {
      try {
        const detected = compactDate((await this.indicesLatest()).tradeDate)
        if (/^\d{8}$/.test(detected)) return detected
      } catch {
        // 指数快照失败时继续尝试日线。
      }
      try {
        const series = await this.dailySeries('1.000001', this.shanghaiToday())
        const last = series.rows.at(-1)
        return last === undefined ? null : compactDate(last.tradeDate)
      } catch {
        return null
      }
    })
  }

  private indicesLatest(): Promise<RawTencentQuotes> {
    return this.memo(`indices:${this.shanghaiToday()}`, this.cacheTtlMs, async () => {
      const url = `https://qt.gtimg.cn/q=${INDEX_TICKERS.join(',')}`
      const rows = parseTencentQuotes(await this.text(url, {
        encoding: 'gb18030',
        timeoutMs: 10_000,
        headers: TENCENT_HEADERS,
      }))
      const byTicker = new Map(rows.map((row) => [row.ticker, row]))
      const shanghai = byTicker.get('sh000001')
      const shenzhen = byTicker.get('sz399001')
      const amount = ((shanghai?.amountWan ?? 0) + (shenzhen?.amountWan ?? 0)) / 10_000
      return {
        source: '腾讯财经',
        sourceUrl: url,
        tradeDate: rows[0]?.tradeDate ?? '',
        rows,
        amount: round(amount, 0),
        indexChange: shanghai?.changePct ?? null,
      }
    })
  }

  private fetchPool(
    endpoint: string,
    date: string,
    sort: string,
  ): Promise<RawLimitPool> {
    return this.memo(`pool:${endpoint}:${date}`, this.cacheTtlMs, async () => {
      const query = new URLSearchParams({
        ut: EASTMONEY_TOKEN,
        dpt: 'wz.ztzt',
        Pageindex: '0',
        pagesize: '10000',
        sort,
        date,
      })
      const url = `https://push2ex.eastmoney.com/${endpoint}?${query}`
      await this.throttle('eastmoney-realtime', 300)
      const value = await this.json<unknown>(url, {
        headers: EASTMONEY_HEADERS,
        timeoutMs: 12_000,
        retries: 2,
      })
      return { ...parseEastmoneyPool(value, date), sourceUrl: url }
    })
  }

  private limitReason(date: string): Promise<RawReasonSource> {
    return this.memo(`limit-reason:${date}`, this.cacheTtlMs, async () => {
      try {
        return await this.thsLimitReason(date)
      } catch (primaryError) {
        try {
          return { ...(await this.thsHotReason(date)), fallbackReason: messageOf(primaryError) }
        } catch (fallbackError) {
          throw new Error(`同花顺涨停揭秘与热点归因均不可用：${messageOf(primaryError)}；${messageOf(fallbackError)}`)
        }
      }
    })
  }

  private async thsLimitReason(date: string): Promise<RawReasonSource> {
    const pageUrl = (page: number): string => {
      const query = new URLSearchParams({
        page: String(page),
        limit: '200',
        field: THS_LIMIT_FIELDS,
        filter: 'HS,GEM2STAR',
        order_field: '330324',
        order_type: '0',
        date: compactDate(date),
      })
      return `https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool?${query}`
    }
    let merged: unknown = null
    for (let page = 1; page <= 3; page += 1) {
      await this.throttle('ths', 150)
      const part = await this.json<Record<string, unknown>>(pageUrl(page), {
        headers: THS_HEADERS,
        timeoutMs: 15_000,
      })
      if (page === 1) {
        merged = part
      } else {
        const mergedData = merged !== null && typeof merged === 'object'
          ? (merged as { data?: Record<string, unknown> }).data
          : undefined
        const partData = part['data'] !== null && typeof part['data'] === 'object'
          ? part['data'] as Record<string, unknown>
          : undefined
        const partInfo = partData?.['info']
        if (mergedData !== undefined && Array.isArray(partInfo)) {
          const existing = Array.isArray(mergedData['info']) ? mergedData['info'] : []
          mergedData['info'] = [...existing, ...partInfo]
        }
      }
      if (partDataInfoLength(part) < 200) break
    }
    return { ...parseThsLimitReason(merged, date), sourceUrl: pageUrl(1) }
  }

  private async thsHotReason(date: string): Promise<RawReasonSource> {
    const url = `http://zx.10jqka.com.cn/event/api/getharden/date/${displayDate(date)}/orderby/date/orderway/desc/charset/GBK/`
    await this.throttle('ths', 150)
    return {
      ...parseThsHotReason(await this.text(url, { headers: THS_HEADERS, timeoutMs: 15_000 }), date),
      sourceUrl: url,
    }
  }

  private dragonTiger(date: string): Promise<RawDragonTiger> {
    return this.memo(`dragon-tiger:${date}`, this.cacheTtlMs, async () => {
      const filter = encodeURIComponent(`(TRADE_DATE>='${displayDate(date)}')(TRADE_DATE<='${displayDate(date)}')`)
      const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=ALL&filter=${filter}&pageNumber=1&pageSize=200&sortColumns=BILLBOARD_NET_AMT&sortTypes=-1`
      await this.throttle('eastmoney-realtime', 300)
      return {
        ...parseDragonTiger(await this.json(url, { headers: EASTMONEY_HEADERS, timeoutMs: 15_000 }), date),
        sourceUrl: url,
      }
    })
  }

  private dailySeries(secid: string, date: string): Promise<RawIndexDailySeries> {
    return this.memo(`kline:${secid}:${compactDate(date)}`, HISTORY_CACHE_TTL_MS, async () => {
      const query = new URLSearchParams({
        secid,
        klt: '101',
        fqt: '1',
        beg: subtractDays(date, 24),
        end: compactDate(date),
        fields1: 'f1,f2,f3,f4,f5,f6',
        fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
      })
      const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?${query}`
      await this.throttle('eastmoney-history', 250)
      const rows = parseEastmoneyKline(await this.json(url, {
        headers: EASTMONEY_HEADERS,
        timeoutMs: 12_000,
      }))
      return { source: '东方财富指数日线', sourceUrl: url, rows }
    })
  }

  private marketHistory(date: string): Promise<RawMarketHistory> {
    return this.memo(`market-history:${date}`, HISTORY_CACHE_TTL_MS, async () => {
      const series: RawIndexDailySeries[] = []
      for (const secid of ['1.000001', '0.399001']) series.push(await this.dailySeries(secid, date))
      const targetDate = series[0]?.rows.at(-1)?.tradeDate
      if (targetDate === undefined || targetDate === '') throw new Error('指数日线数据不可用')
      const findAt = (item: RawIndexDailySeries, offset = 0) => {
        const index = item.rows.findIndex((row) => row.tradeDate === targetDate)
        return index >= 0 ? item.rows[index + offset] ?? null : null
      }
      const currentAmount = series.reduce((sum, item) => sum + (findAt(item)?.amount ?? 0), 0) / 1e8
      const previousAmount = series.reduce((sum, item) => sum + (findAt(item, -1)?.amount ?? 0), 0) / 1e8
      return {
        source: '东方财富指数日线',
        tradeDate: targetDate,
        amount: round(currentAmount, 0),
        previousAmount: round(previousAmount, 0),
        amountChangePct: previousAmount ? round((currentAmount - previousAmount) / previousAmount * 100, 1) : null,
      }
    })
  }

  private indexTrend(date: string, ticker = 'sh000001'): Promise<RawIndexTrend> {
    return this.memo(`trend:${ticker}:${date}`, this.trendTtlMs(date), async () => {
      const query = new URLSearchParams({
        secid: TREND_SECIDS[ticker] ?? '1.000001',
        fields1: 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13',
        fields2: 'f51,f52,f53,f54,f55,f56,f57,f58',
        iscr: '0',
        ndays: '1',
      })
      const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?${query}`
      await this.throttle('eastmoney-history', 250)
      try {
        return {
          ...parseEastmoneyTrend(await this.json(url, { headers: EASTMONEY_HEADERS, timeoutMs: 12_000 }), date),
          sourceUrl: url,
        }
      } catch {
        // 东方财富 trends2 对高频请求会做 IP 级临时封禁（socket hang up），回退腾讯分时。
        return this.indexTrendTencent(date, ticker)
      }
    })
  }

  /**
   * 腾讯指数分时（东方财富 trends2 不可用时的回退源）。
   * 数据格式：data[ticker].data.data = ["0930 3623.57 5108462 7549323737.40", ...]（时间 价格 量 额）。
   * 昨收取自同响应的 qt 数组（第 5 个字段）。均价线无法从指数量额推导，average 置 null。
   */
  private async indexTrendTencent(date: string, ticker: string): Promise<RawIndexTrend> {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${ticker}`
    await this.throttle('tencent', 60)
    const raw = await this.json<Record<string, unknown>>(url, { headers: TENCENT_HEADERS, timeoutMs: 12_000 })
    const root = raw?.['data']
    const entry = root !== null && typeof root === 'object'
      ? (root as Record<string, unknown>)[ticker]
      : undefined
    if (entry === null || typeof entry !== 'object') throw new Error('tencent minute empty')
    const holder = entry as Record<string, unknown>
    const dataNode = holder['data']
    const rows = dataNode !== null && typeof dataNode === 'object'
      ? (dataNode as Record<string, unknown>)['data']
      : undefined
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('tencent minute empty')
    const qtNode = holder['qt']
    const quote = qtNode !== null && typeof qtNode === 'object'
      ? (qtNode as Record<string, unknown>)[ticker]
      : undefined
    const prevClose = Array.isArray(quote) ? optionalNumber(quote[4]) : null
    // 腾讯的量、额都是当日累计值，图上需要每分钟增量：做相邻分钟差分，首点取累计值本身。
    const points: RawTrendPoint[] = []
    let prevVolume = 0
    let prevAmount = 0
    for (const line of rows) {
      const parts = String(line).trim().split(/\s+/)
      // 指数分时是「时间 价格 量 额」四段，板块分时只有「时间 价格 量」三段。
      if (parts.length < 3) continue
      const hm = parts[0] ?? ''
      const price = Number(parts[1])
      if (hm.length !== 4 || !Number.isFinite(price)) continue
      const cumulativeVolume = optionalNumber(parts[2])
      const cumulativeAmount = optionalNumber(parts[3])
      const volume = cumulativeVolume === null ? null : Math.max(0, cumulativeVolume - prevVolume)
      const amount = cumulativeAmount === null ? null : Math.max(0, cumulativeAmount - prevAmount)
      if (cumulativeVolume !== null) prevVolume = cumulativeVolume
      if (cumulativeAmount !== null) prevAmount = cumulativeAmount
      points.push({
        time: `${displayDate(date)} ${hm.slice(0, 2)}:${hm.slice(2)}`,
        price,
        changePct: prevClose !== null && prevClose > 0 ? round((price - prevClose) / prevClose * 100, 2) : null,
        volume,
        amount,
        average: null,
      })
    }
    if (points.length === 0) throw new Error('tencent minute empty')
    return {
      source: '腾讯指数分时',
      sourceUrl: url,
      tradeDate: date,
      preClose: prevClose,
      points,
    }
  }

  /** 指数分时：单个指数失败不影响其他指数。 */
  private indexTrends(date: string): Promise<RawIndexTrendEntry[]> {
    return this.memo(`trends:${date}`, this.trendTtlMs(date), async () => {
      const entries = await mapWithConcurrency(INDEX_TICKERS, 3, async (ticker): Promise<RawIndexTrendEntry | null> => {
        const trend = await safe(() => this.indexTrend(date, ticker))
        return trend === null ? null : { ticker, name: INDEX_NAMES[ticker] ?? ticker, trend }
      })
      return entries.filter((entry): entry is RawIndexTrendEntry => entry !== null)
    })
  }

  /** 单个板块分时（BKxxxx），返回分钟级序列。push2his 接口稳定。 */
  private sectorTrend(date: string, sectorCode: string): Promise<RawIndexTrend> {
    return this.memo(`sector-trend:${sectorCode}:${date}`, this.trendTtlMs(date), async () => {
      const query = new URLSearchParams({
        secid: `90.${sectorCode}`,
        fields1: 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13',
        fields2: 'f51,f52,f53,f54,f55,f56,f57,f58',
        iscr: '0',
        ndays: '1',
      })
      const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?${query}`
      await this.throttle('eastmoney-history', 250)
      return parseEastmoneyTrend(await this.json(url, { headers: EASTMONEY_HEADERS, timeoutMs: 12_000 }), date)
    })
  }

  /**
   * 腾讯板块排名：按成交额降序取前 limit 个。
   * boardType：hy = 行业板块，gn = 概念板块。
   */
  private sectorRankTencent(
    date: string,
    boardType: 'hy' | 'gn',
    limit: number,
  ): Promise<Array<{ code: string; name: string }>> {
    return this.memo(`sector-rank:${boardType}:${date}:${String(limit)}`, this.trendTtlMs(date), async () => {
      const url = `https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank?board_type=${boardType}&sort_type=turnover&direct=down&offset=0&count=${String(limit)}`
      await this.throttle('tencent', 60)
      const raw = await this.json<{ data?: { rank_list?: Array<{ code?: unknown; name?: unknown }> } }>(url, {
        headers: TENCENT_HEADERS,
        timeoutMs: 12_000,
      })
      return (raw.data?.rank_list ?? [])
        .map((row) => ({ code: String(row.code ?? ''), name: String(row.name ?? '') }))
        .filter((item) => /^pt\d+$/.test(item.code) && item.name !== '')
    })
  }

  /**
   * 异动识别的板块池：行业与概念各取成交额靠前的板块。
   * 概念榜里混有「深股通」「融资融券」这类交易属性标签，需剔除，否则它们会占满信号。
   */
  private async sectorPoolTencent(date: string): Promise<Array<{ code: string; name: string }>> {
    const [industry, concept] = await Promise.all([
      safe(() => this.sectorRankTencent(date, 'hy', 8)),
      safe(() => this.sectorRankTencent(date, 'gn', 20)),
    ])
    const filteredConcept = (concept ?? [])
      .filter((item) => !EXCLUDED_CONCEPTS.some((keyword) => item.name.includes(keyword)))
      .slice(0, 8)
    const seen = new Set<string>()
    const pool: Array<{ code: string; name: string }> = []
    for (const item of [...(industry ?? []), ...filteredConcept]) {
      if (seen.has(item.code)) continue
      seen.add(item.code)
      pool.push(item)
    }
    return pool
  }

  /** 腾讯板块分时（带缓存）；解析复用指数分时逻辑，昨收取自响应 qt 数组第 5 个字段。 */
  private sectorTrendTencent(date: string, code: string): Promise<RawIndexTrend> {
    return this.memo(`sector-trend-qt:${code}:${date}`, this.trendTtlMs(date), () => this.indexTrendTencent(date, code))
  }

  /**
   * 行业板块分时异动信号：
   * 板块池优先用腾讯行业成交额前 8（当前可用），失败时回退东方财富硬编码 BKxxxx 列表。
   * 判定规则：板块相对昨收涨幅绝对值 > 0.8% 且 > 上证同期绝对值的 2 倍，视为异动。
   * 同分钟内多个板块异动只保留涨幅最大的，最后取前 6 个信号。
   */
  private static readonly HARDCODED_SECTORS: ReadonlyArray<{ readonly code: string; readonly name: string }> = [
    { code: 'BK0475', name: '银行' },
    { code: 'BK0480', name: '有色金属' },
    { code: 'BK0493', name: '新能源' },
    { code: 'BK0447', name: '互联网服务' },
    { code: 'BK0500', name: '白酒' },
    { code: 'BK0548', name: '煤炭' },
    { code: 'BK0438', name: '家用电器' },
  ]

  /**
   * 板块异动：优先取同花顺「异动」快讯（tag=21111）中带板块名的 A 股盘中条目。
   * 同花顺的板块名来自其自身行业/概念体系，是东财之外的独立信号源；
   * 快讯只回溯最近数个交易日，取不到目标交易日时回退到腾讯板块分时的量化判定。
   */
  async sectorAnomalies(date: string): Promise<TradingDaySectorSignal[]> {
    const ths = await safe(() => this.sectorAnomaliesThs(date))
    if (ths !== null && ths.length > 0) return ths
    return this.sectorAnomaliesTencent(date)
  }

  private sectorAnomaliesThs(date: string): Promise<TradingDaySectorSignal[]> {
    return this.memo(`sector-signals-ths:${date}`, this.trendTtlMs(date), async () => {
      const tradeDay = displayDate(date)
      const startOfDay = Date.parse(`${tradeDay}T00:00:00+08:00`) / 1000
      const items: ThsNewsItem[] = []
      let earliest = Number.POSITIVE_INFINITY
      for (let page = 1; page <= 8; page += 1) {
        await this.throttle('ths-news', 150)
        const url = `https://news.10jqka.com.cn/tapp/news/push/stock/?page=${String(page)}&tag=21111&track=website&pagesize=100`
        const raw = await this.json<{ data?: { list?: ThsNewsItem[] } }>(url, {
          headers: THS_NEWS_HEADERS,
          timeoutMs: 12_000,
        })
        const list = raw.data?.list ?? []
        if (list.length === 0) break
        items.push(...list)
        for (const item of list) {
          const seconds = optionalNumber(item.ctime)
          if (seconds !== null && seconds < earliest) earliest = seconds
        }
        // 当天数据通常在第一页；翻到目标交易日之前即可停止。
        if (earliest < startOfDay) break
      }
      return this.parseThsSectorSignals(items, tradeDay)
    })
  }

  private parseThsSectorSignals(items: readonly ThsNewsItem[], tradeDay: string): TradingDaySectorSignal[] {
    const byName = new Map<string, TradingDaySectorSignal>()
    for (const item of items) {
      const title = String(item.title ?? '').trim()
      if (title === '' || !title.includes('板块')) continue
      // 排除外围市场与商品类快讯，只保留 A 股板块异动。
      if (/港股|美股|日韩|亚太|欧股|期货|债市|黄金|原油/.test(title)) continue
      const seconds = optionalNumber(item.ctime)
      if (seconds === null) continue
      const moment = new Date((seconds + 8 * 60 * 60) * 1000)
      if (moment.toISOString().slice(0, 10) !== tradeDay) continue
      const minutes = moment.getUTCHours() * 60 + moment.getUTCMinutes()
      // 集合竞价与收盘后不落在分时曲线上，直接丢弃。
      if (minutes < 9 * 60 + 30 || minutes > 15 * 60 + 5) continue
      const field = Array.isArray(item.field) ? item.field[0] : undefined
      const name = String(field?.name ?? '').trim() || /^(.{2,12}?)板块/.exec(title)?.[1]?.trim() || ''
      if (name === '') continue
      // 同一板块只保留当天第一次异动，避免同一题材反复占位。
      if (byName.has(name)) continue
      const up = !/(回落|下跌|走低|下挫|跳水|走弱|低开|跌停|跌幅)/.test(title)
      const hm = `${String(moment.getUTCHours()).padStart(2, '0')}:${String(moment.getUTCMinutes()).padStart(2, '0')}`
      byName.set(name, {
        time: `${tradeDay} ${hm}`,
        name,
        code: String(field?.stockCode ?? ''),
        changePct: null,
        direction: up ? 'up' : 'down',
      })
    }
    return [...byName.values()].sort((a, b) => a.time.localeCompare(b.time)).slice(0, 8)
  }

  /**
   * 腾讯板块分时量化判定（备源）：
   * 板块池取腾讯行业成交额前 8 + 概念前 8；滑动窗口内板块涨跌幅明显强于上证同期视为异动。
   * 跨午间休市的窗口必须跳过，否则 11:29→13:02 会被算成一次假异动。
   */
  private async sectorAnomaliesTencent(date: string): Promise<TradingDaySectorSignal[]> {
    const signals: TradingDaySectorSignal[] = []
    const shTrend = await safe(() => this.indexTrend(date, 'sh000001'))
    if (!shTrend) return signals

    // 构建上证分时索引：time → changePct（相对昨收）
    const shPrev = shTrend.preClose ?? 0
    const shByTime = new Map<string, number>()
    for (const pt of shTrend.points) {
      if (shPrev > 0) shByTime.set(pt.time, (pt.price - shPrev) / shPrev * 100)
    }

    // 板块池：腾讯行业 + 概念（当前可用）；失败时回退东方财富硬编码列表。
    const tencentSectors = await safe(() => this.sectorPoolTencent(date))
    const usingTencent = tencentSectors !== null && tencentSectors.length > 0
    const sectors: Array<{ code: string; name: string }> = usingTencent
      ? tencentSectors
      : TradingDayProvider.HARDCODED_SECTORS.map((item) => ({ code: item.code, name: item.name }))

    // 并行抓各板块分时：腾讯源与东方财富源共用同一套异动判定。
    const sectorResults = await mapWithConcurrency(sectors, 4, async (sector) => {
      const trend = await safe(() => usingTencent
        ? this.sectorTrendTencent(date, sector.code)
        : this.sectorTrend(date, sector.code))
      if (!trend) return null
      const prev = trend.preClose ?? 0
      if (prev <= 0) return null
      return { sector, trend, prev }
    })

    // 滑动窗口捕捉「突然异动」：板块在 SECTOR_WINDOW 分钟内的涨跌幅明显强于上证同期。
    // 用区间变化而不是相对昨收的涨幅，才能定位异动发生的时刻，而不是选出全天涨幅榜。
    const bySector = new Map<string, {
      time: string
      sector: { code: string; name: string }
      changePct: number
      strength: number
    }>()
    for (const result of sectorResults) {
      if (!result) continue
      const points = result.trend.points
      for (let index = SECTOR_WINDOW; index < points.length; index += 1) {
        const from = points[index - SECTOR_WINDOW]
        const to = points[index]
        if (from === undefined || to === undefined || from.price <= 0) continue
        // 腾讯板块分时在 13:00 复牌点相对 11:29 有明显跳空，跨午休的窗口一律丢弃。
        if (minutesOfClock(from.time) <= 11 * 60 + 30 && minutesOfClock(to.time) >= 13 * 60) continue
        const windowChange = (to.price - from.price) / from.price * 100
        const shWindow = (shByTime.get(to.time) ?? 0) - (shByTime.get(from.time) ?? 0)
        const strength = Math.abs(windowChange)
        if (strength < SECTOR_MIN_WINDOW_CHANGE) continue
        if (strength < Math.abs(shWindow) * 2) continue
        const existing = bySector.get(result.sector.code)
        if (!existing || strength > existing.strength) {
          bySector.set(result.sector.code, {
            time: to.time,
            sector: result.sector,
            changePct: (to.price - result.prev) / result.prev * 100,
            strength,
          })
        }
      }
    }

    // 每个板块只保留自身最剧烈的一次异动，取全天最强的 8 个，最后按时间排序输出。
    const sorted = [...bySector.values()]
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 8)
      .sort((a, b) => a.time.localeCompare(b.time))
    for (const entry of sorted) {
      signals.push({
        time: entry.time,
        name: entry.sector.name,
        code: entry.sector.code,
        changePct: Math.round(entry.changePct * 10) / 10,
      })
    }
    return signals
  }

  /** 两市（沪深）融资余额：东方财富两融数据，单位亿元。 */
  private marginAll(date: string): Promise<RawMarginAll> {
    return this.memo(`margin-all:${date}`, MARGIN_CACHE_TTL_MS, async () => {
      const query = new URLSearchParams({
        reportName: 'RPTA_RZRQ_LSHJ',
        columns: 'DIM_DATE,RZYE',
        pageNumber: '1',
        pageSize: '10',
        sortTypes: '-1',
        sortColumns: 'DIM_DATE',
        source: 'WEB',
        client: 'WEB',
      })
      const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?${query}`
      const value = await this.json<{ result?: { data?: { DIM_DATE?: unknown; RZYE?: unknown }[] } }>(url, {
        headers: EASTMONEY_HEADERS,
        timeoutMs: 15_000,
      })
      const rows = (value.result?.data ?? [])
        .map((row) => ({ date: compactDate(row.DIM_DATE), balance: optionalNumber(row.RZYE) }))
        .filter((row): row is { date: string; balance: number } => row.date !== '' && row.balance !== null)
      const target = compactDate(date)
      const index = rows.findIndex((row) => row.date <= target)
      if (index < 0) throw new Error(`两市融资余额未覆盖 ${displayDate(date)}`)
      const current = rows[index]!
      const previous = rows[index + 1] ?? null
      const balance = round(current.balance / 1e8, 2)
      const previousBalance = previous === null ? null : round(previous.balance / 1e8, 2)
      const rawChange = balance === null || previousBalance === null ? null : balance - previousBalance
      const rawChangePct = rawChange === null || previousBalance === null || previousBalance === 0 ? null : rawChange / previousBalance * 100
      return {
        source: '东方财富两融数据',
        sourceUrl: url,
        tradeDate: displayDate(current.date),
        balance,
        previousBalance,
        change: rawChange === null ? null : round(rawChange, 2),
        changePct: rawChangePct === null ? null : round(rawChangePct, 2),
      }
    })
  }

  private breadth(): Promise<RawBreadth> {
    return this.memo(`breadth:${this.shanghaiToday()}`, this.cacheTtlMs, async () => {
      try {
        return await this.eastmoneyBreadth()
      } catch (primaryError) {
        try {
          return { ...(await this.sinaBreadth()), fallbackReason: messageOf(primaryError) }
        } catch (fallbackError) {
          throw new Error(`东方财富与新浪财经涨跌分布均不可用：${messageOf(primaryError)}；${messageOf(fallbackError)}`)
        }
      }
    })
  }

  private async eastmoneyBreadth(): Promise<RawBreadth> {
    const url = `https://push2ex.eastmoney.com/getTopicZDFenBu?ut=${EASTMONEY_TOKEN}&dpt=wz.ztzt`
    await this.throttle('eastmoney-realtime', 300)
    const value = await this.json<{ data?: { fenbu?: unknown } }>(url, {
      headers: EASTMONEY_HEADERS,
      timeoutMs: 12_000,
      retries: 2,
    })
    const buckets = Array.isArray(value.data?.fenbu) ? value.data.fenbu : null
    if (buckets === null) throw new Error('东方财富涨跌分布不可用')
    const mapped = distributionFromBuckets(buckets)
    const total = mapped.upCount + mapped.downCount + mapped.flatCount
    if (total <= 0) throw new Error('东方财富涨跌分布为空')
    return {
      source: '东方财富',
      sourceUrl: url,
      total,
      upCount: mapped.upCount,
      downCount: mapped.downCount,
      flatCount: mapped.flatCount,
      distribution: mapped.distribution,
    }
  }

  private async sinaBreadth(): Promise<RawBreadth> {
    const pageSize = 100
    const pageCache = new Map<number, number[]>()
    const countUrl = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeStockCount?node=hs_a'
    const pageUrl = (page: number): string =>
      `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=${pageSize}&sort=changepercent&asc=0&node=hs_a&symbol=&_s_r_a=page`

    await this.throttle('sina', 120)
    const total = Number(await this.json<number | string>(countUrl, { timeoutMs: 12_000, retries: 2 }))
    if (!Number.isFinite(total) || total < 1000) throw new Error('新浪财经 A 股总数不可用')

    const fetchPage = async (page: number): Promise<number[]> => {
      const cached = pageCache.get(page)
      if (cached !== undefined) return cached
      await this.throttle('sina', 120)
      const value = await this.json<unknown>(pageUrl(page), { timeoutMs: 16_000, retries: 2 })
      const rows = Array.isArray(value)
        ? value
            .map((row) => optionalNumber((row as Record<string, unknown> | null)?.['changepercent']))
            .filter((item): item is number => item !== null)
        : []
      if (rows.length === 0) throw new Error(`新浪财经涨跌分布第 ${page} 页为空`)
      pageCache.set(page, rows)
      return rows
    }

    const pageCount = Math.ceil(total / pageSize)
    const countAtLeast = async (threshold: number): Promise<number> => {
      let low = 1
      let high = pageCount
      let lastFull = 0
      while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const rows = await fetchPage(middle)
        const first = rows[0]
        const last = rows.at(-1)
        if (first === undefined || last === undefined) return 0
        if (first < threshold) high = middle - 1
        else if (last >= threshold) {
          lastFull = middle
          low = middle + 1
        } else {
          return Math.min(total, (middle - 1) * pageSize + rows.filter((value) => value >= threshold).length)
        }
      }
      if (!lastFull) return 0
      if (lastFull >= pageCount) return total
      const rows = await fetchPage(lastFull + 1)
      return Math.min(total, lastFull * pageSize + rows.filter((value) => value >= threshold).length)
    }

    const at10 = await countAtLeast(10)
    const at5 = await countAtLeast(5)
    const at2 = await countAtLeast(2)
    const positive = await countAtLeast(Number.EPSILON)
    const nonNegative = await countAtLeast(0)
    const atMinus2 = await countAtLeast(-2)
    const atMinus5 = await countAtLeast(-5)
    const atMinus10 = await countAtLeast(-10)
    return {
      source: '新浪财经（备用）',
      sourceUrl: pageUrl(1),
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

  private marginSH(date: string): Promise<RawMarginSH> {
    return this.memo(`margin:${date}`, MARGIN_CACHE_TTL_MS, async () => {
      let current: { rows: RawMarginRow[]; total: number } | null = null
      let currentDate = ''
      for (const offset of [0, 1, 2, 3]) {
        const candidateDate = offset === 0 ? date : subtractDays(date, offset)
        const candidate = await this.marginRows(candidateDate)
        if (candidate.rows.length >= 500) {
          current = candidate
          currentDate = candidateDate
          break
        }
        await this.throttle('sse', 400)
      }
      if (current === null) throw new Error(`上交所两融未发布 ${displayDate(date)} 及前三个交易日（仅沪市）`)

      let previous: { rows: RawMarginRow[]; total: number } | null = null
      let previousDate = ''
      for (const offset of [1, 2, 3]) {
        const candidateDate = subtractDays(currentDate, offset)
        const candidate = await this.marginRows(candidateDate)
        if (candidate.rows.length >= 500) {
          previous = candidate
          previousDate = candidateDate
          break
        }
        await this.throttle('sse', 400)
      }

      const balance = round(sumMargin(current.rows) / 1e8, 2)
      const previousBalance = previous === null ? null : round(sumMargin(previous.rows) / 1e8, 2)
      return {
        source: '上交所（仅沪市）',
        sourceUrl: marginUrl(currentDate, 1),
        tradeDate: compactDate(currentDate),
        total: current.total,
        rows: current.rows,
        balance,
        previousBalance,
        previousTradeDate: previousDate,
        change: balance === null || previousBalance === null ? null : round(balance - previousBalance, 2),
        changePct: balance === null || previousBalance === null || previousBalance === 0
          ? null
          : round((balance - previousBalance) / previousBalance * 100, 2),
      }
    })
  }

  private async marginRows(date: string): Promise<{ rows: RawMarginRow[]; total: number }> {
    const rows: RawMarginRow[] = []
    let total = 0
    for (let page = 1; page <= 6; page += 1) {
      if (page > 1) await this.throttle('sse', 400)
      const value = await this.json<{ pageHelp?: { data?: unknown; total?: unknown } }>(marginUrl(date, page), {
        headers: SSE_HEADERS,
        timeoutMs: 20_000,
      })
      total = optionalNumber(value.pageHelp?.total) ?? total
      const part = Array.isArray(value.pageHelp?.data)
        ? value.pageHelp.data.filter((row): row is RawMarginRow => row !== null && typeof row === 'object')
        : []
      const dated = part.filter((row) => compactDate(row.opDate) === compactDate(date))
      rows.push(...dated)
      if (dated.length === 0 || total === 0 || rows.length >= total) break
    }
    return { rows, total }
  }

  private leaderStrength(limitUp: RawLimitPool): Promise<RawLeaderStrength> {
    return this.memo(`leader-strength:${limitUp.tradeDate}:${limitUp.rows.length}`, this.cacheTtlMs, async () => {
      const candidates = [...limitUp.rows]
        .filter((row) => codeOf(row) !== '')
        .sort((left, right) => {
          const boardDiff = boardOf(right) - boardOf(left)
          if (boardDiff !== 0) return boardDiff
          return (optionalNumber(right.amount) ?? -Infinity) - (optionalNumber(left.amount) ?? -Infinity)
        })
        .slice(0, LEADER_STRENGTH_LIMIT)
      if (candidates.length === 0) {
        return {
          source: '腾讯财经',
          tradeDate: '',
          total: 0,
          rows: [],
          byCode: {},
          note: '涨停池为空，未计算龙头相对强度',
        }
      }

      const benchmark = await this.tencentKline('sh000001')
      const benchmarkCloses = benchmark.rows
        .map((row) => row.close)
        .filter((value): value is number => value !== null)

      const entries = await mapWithConcurrency(candidates, 4, async (row): Promise<RawLeaderStrengthRow | null> => {
        const code = codeOf(row)
        const ticker = toTicker(code)
        if (ticker === '') return null
        try {
          const kline = await this.tencentKline(ticker)
          const closes = kline.rows
            .map((item) => item.close)
            .filter((value): value is number => value !== null)
          return {
            code,
            name: trimmed(row.n),
            marketCap: kline.marketCap,
            rs5: relativeStrength(closes, benchmarkCloses, 5),
            rs20: relativeStrength(closes, benchmarkCloses, 20),
          }
        } catch {
          return null
        }
      })
      const rows = entries.filter((row): row is RawLeaderStrengthRow => row !== null)
      const byCode: Record<string, RawLeaderStrengthRow> = Object.fromEntries(rows.map((row) => [row.code, row]))
      return { source: '腾讯财经', tradeDate: '', total: rows.length, rows, byCode }
    })
  }

  private tencentKline(ticker: string): Promise<KlineWithSource> {
    return this.memo(`tencent-kline:${ticker}`, this.cacheTtlMs, async () => {
      const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${ticker},day,,,60,qfq`
      await this.throttle('tencent', 60)
      return {
        source: '腾讯财经',
        sourceUrl: url,
        ...parseTencentKline(await this.json(url, { headers: TENCENT_HEADERS, timeoutMs: 12_000 }), ticker),
      }
    })
  }
}

function partDataInfoLength(value: Record<string, unknown>): number {
  const data = value['data']
  if (data === null || typeof data !== 'object') return 0
  const info = (data as Record<string, unknown>)['info']
  return Array.isArray(info) ? info.length : 0
}

const sumMargin = (rows: RawMarginRow[]): number =>
  rows.reduce((sum, row) => sum + (optionalNumber(row.rzye) ?? 0), 0)

function marginUrl(date: string, page: number): string {
  const query = new URLSearchParams({
    isPagination: 'true',
    tabType: 'mxtype',
    detailsDate: compactDate(date),
    'pageHelp.pageSize': '2000',
    'pageHelp.pageNo': String(page),
    'pageHelp.beginPage': String(page),
    'pageHelp.cacheSize': '1',
    'pageHelp.endPage': String(page),
  })
  return `https://query.sse.com.cn/marketdata/tradedata/queryMargin.do?${query}`
}
