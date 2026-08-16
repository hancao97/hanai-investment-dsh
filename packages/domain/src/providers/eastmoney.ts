import type {
  IndexQuote,
  KLineBar,
  MarketOverview,
  ProviderMeta,
  RankEntry,
  SectorBoard,
  SectorItem,
  StockMetrics,
  StockQuote,
  TrendPoint,
} from '../../../contracts/src/index.ts'
import { fetchJson, isoNow, systemClock, type Clock, type HttpClient } from '../http.ts'
import { TencentProvider } from './tencent.ts'

const HEADERS = { Referer: 'https://quote.eastmoney.com/' }
const STOCK_FIELDS = 'f2,f3,f4,f5,f6,f8,f9,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23'
const A_SHARE_FILTER = 'm:0+t:6+f:!2,m:0+t:80+f:!2,m:1+t:2+f:!2,m:1+t:23+f:!2,m:0+t:81+s:2048+f:!2'

const CORE_INDICES: ReadonlyArray<{ secId: string; name: string }> = [
  { secId: '1.000001', name: '上证指数' },
  { secId: '0.399001', name: '深证成指' },
  { secId: '0.399006', name: '创业板指' },
  { secId: '1.000300', name: '沪深300' },
  { secId: '1.000688', name: '科创50' },
  { secId: '0.899050', name: '北证50' },
]

type EastmoneySource = 'realtime' | 'delay'

interface ProviderValue<T> {
  value: T
  source: EastmoneySource
}

interface EastmoneyEnvelope<T> {
  data?: T | null
}

interface ClistResponse {
  total?: unknown
  diff?: unknown
}

interface IndexResponse {
  f43?: unknown
  f47?: unknown
  f48?: unknown
  f57?: unknown
  f58?: unknown
  f169?: unknown
  f170?: unknown
}

interface BreadthResponse {
  data?: {
    qdate?: unknown
    fenbu?: unknown
  } | null
}

interface KlineResponse {
  klines?: unknown
}

interface TrendResponse {
  trends?: unknown
  preClose?: unknown
}

export interface EastmoneySecurityRow {
  code: string
  name: string
  market: number
}

export interface EastmoneyProviderOptions {
  clock?: Clock
  tencent?: TencentProvider
  timeoutMs?: number
  minIntervalMs?: number
  realtimeFailureThreshold?: number
  realtimeCooldownMs?: number
  totalFailureThreshold?: number
  breakerOpenMs?: number
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function finiteNumberString(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function objectRows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object' && !Array.isArray(row))
    : []
}

function combineSource(current: EastmoneySource, next: EastmoneySource): EastmoneySource {
  return current === 'delay' || next === 'delay' ? 'delay' : 'realtime'
}

export class EastmoneyProvider {
  private readonly clock: Clock
  private readonly tencent: TencentProvider
  private readonly timeoutMs: number
  private readonly minIntervalMs: number
  private readonly realtimeFailureThreshold: number
  private readonly realtimeCooldownMs: number
  private readonly totalFailureThreshold: number
  private readonly breakerOpenMs: number

  private realtimeHostSequence = 0
  private historyHostSequence = 0
  private queueTail: Promise<void> = Promise.resolve()
  private lastRequestAt = 0
  private realtimeFailures = 0
  private realtimeBlockedUntil = 0
  private totalFailures = 0
  private breakerOpenUntil = 0
  private readonly quoteCache = new Map<string, StockQuote>()

  constructor(
    private readonly http: HttpClient,
    options: EastmoneyProviderOptions = {},
  ) {
    this.clock = options.clock ?? systemClock
    this.tencent = options.tencent ?? new TencentProvider(http, this.clock)
    this.timeoutMs = options.timeoutMs ?? 8_000
    this.minIntervalMs = options.minIntervalMs ?? 120
    this.realtimeFailureThreshold = options.realtimeFailureThreshold ?? 4
    this.realtimeCooldownMs = options.realtimeCooldownMs ?? 5 * 60_000
    this.totalFailureThreshold = options.totalFailureThreshold ?? 8
    this.breakerOpenMs = options.breakerOpenMs ?? 60_000
  }

  /** Clear only the provider's last-success quote fallback; network/rate-limit state is unchanged. */
  clearQuoteCache(): number {
    const removed = this.quoteCache.size
    this.quoteCache.clear()
    return removed
  }

  private nextRealtimeHost(): string {
    this.realtimeHostSequence = (this.realtimeHostSequence + 1) % 50
    return this.realtimeHostSequence === 0 ? 'push2.eastmoney.com' : `${this.realtimeHostSequence}.push2.eastmoney.com`
  }

  private nextHistoryHost(): string {
    this.historyHostSequence = (this.historyHostSequence + 1) % 20
    return this.historyHostSequence === 0 ? 'push2his.eastmoney.com' : `${this.historyHostSequence}.push2his.eastmoney.com`
  }

  private async throttle(): Promise<void> {
    const previous = this.queueTail
    let release: () => void = () => {}
    this.queueTail = new Promise(resolve => {
      release = resolve
    })
    await previous
    try {
      const wait = this.lastRequestAt + this.minIntervalMs - this.clock.now()
      if (wait > 0) await this.clock.sleep(wait)
      this.lastRequestAt = this.clock.now()
    } finally {
      release()
    }
  }

  private checkBreaker(): void {
    if (this.clock.now() >= this.breakerOpenUntil) return
    const seconds = Math.ceil((this.breakerOpenUntil - this.clock.now()) / 1000)
    throw new Error(`行情源限流熔断中，${seconds} 秒后自动重试`)
  }

  private reportRealtime(ok: boolean): void {
    if (ok) {
      this.realtimeFailures = 0
      return
    }
    this.realtimeFailures += 1
    if (this.realtimeFailures < this.realtimeFailureThreshold) return
    this.realtimeBlockedUntil = this.clock.now() + this.realtimeCooldownMs
    this.realtimeFailures = 0
  }

  private reportTotal(ok: boolean): void {
    if (ok) {
      this.totalFailures = 0
      return
    }
    this.totalFailures += 1
    if (this.totalFailures < this.totalFailureThreshold) return
    this.breakerOpenUntil = this.clock.now() + this.breakerOpenMs
    this.totalFailures = 0
  }

  private meta(
    source: EastmoneySource | 'cache' | 'unavailable',
    sourceTimestamp: string | null = null,
  ): ProviderMeta {
    if (source === 'cache') {
      return {
        providerId: 'eastmoney-memory-cache',
        sourceName: '东方财富（最近成功快照）',
        sourceTimestamp,
        fetchedAt: isoNow(this.clock),
        cacheState: 'stale',
      }
    }
    if (source === 'unavailable') {
      return {
        providerId: 'eastmoney',
        sourceName: '东方财富',
        sourceTimestamp,
        fetchedAt: isoNow(this.clock),
        cacheState: 'unavailable',
      }
    }
    return {
      providerId: source === 'delay' ? 'eastmoney-delay' : 'eastmoney',
      sourceName: source === 'delay' ? '东方财富（延迟行情）' : '东方财富',
      sourceTimestamp,
      fetchedAt: isoNow(this.clock),
      cacheState: source === 'delay' ? 'stale' : 'fresh',
    }
  }

  private async get<T>(
    path: string,
    params: Readonly<Record<string, string>>,
    history = false,
  ): Promise<ProviderValue<T> | null> {
    this.checkBreaker()
    const query = new URLSearchParams(params).toString()
    const hosts: Array<{ host: string; source: EastmoneySource }> = []
    if (this.clock.now() >= this.realtimeBlockedUntil) {
      hosts.push({ host: history ? this.nextHistoryHost() : this.nextRealtimeHost(), source: 'realtime' })
      if (history) hosts.push({ host: this.nextHistoryHost(), source: 'realtime' })
    }
    if (!history) hosts.push({ host: 'push2delay.eastmoney.com', source: 'delay' })

    for (const candidate of hosts) {
      await this.throttle()
      const response = await fetchJson<EastmoneyEnvelope<T>>(
        this.http,
        `https://${candidate.host}/${path}?${query}`,
        { timeoutMs: this.timeoutMs, headers: HEADERS },
      )
      const value = response.ok ? response.data?.data : null
      const ok = value !== null && value !== undefined
      if (candidate.source === 'realtime') this.reportRealtime(ok)
      if (ok) {
        this.reportTotal(true)
        return { value, source: candidate.source }
      }
    }
    this.reportTotal(false)
    return null
  }

  private async clist(
    params: Readonly<Record<string, string>>,
    maxItems = 100,
  ): Promise<ProviderValue<Array<Record<string, unknown>>>> {
    const rows: Array<Record<string, unknown>> = []
    let source: EastmoneySource = 'realtime'
    const pages = Math.ceil(maxItems / 100)
    for (let page = 1; page <= pages; page += 1) {
      const response = await this.get<ClistResponse>('api/qt/clist/get', {
        pn: String(page),
        pz: '100',
        po: '1',
        np: '1',
        fltt: '2',
        invt: '2',
        ...params,
      })
      if (response === null) break
      const pageRows = objectRows(response.value.diff)
      if (pageRows.length === 0) break
      source = combineSource(source, response.source)
      rows.push(...pageRows)
      const total = finiteNumber(response.value.total) ?? 0
      if (rows.length >= total || rows.length >= maxItems) break
    }
    return { value: rows.slice(0, maxItems), source }
  }

  private async getIndex(secId: string): Promise<ProviderValue<IndexQuote> | null> {
    const response = await this.get<IndexResponse>('api/qt/stock/get', {
      secid: secId,
      fltt: '2',
      invt: '2',
      fields: 'f43,f47,f48,f57,f58,f169,f170',
    })
    if (response === null) return null
    return {
      source: response.source,
      value: {
        code: String(response.value.f57 ?? ''),
        name: String(response.value.f58 ?? ''),
        price: finiteNumber(response.value.f43),
        change: finiteNumber(response.value.f169),
        changePct: finiteNumber(response.value.f170),
        amount: finiteNumber(response.value.f48),
        upCount: null,
        downCount: null,
        flatCount: null,
      },
    }
  }

  private async getBreadth(): Promise<{
    up: number | null
    down: number | null
    flat: number | null
    limitUp: number | null
    limitDown: number | null
    qdate: string | null
  }> {
    const response = await fetchJson<BreadthResponse>(
      this.http,
      'https://push2ex.eastmoney.com/getTopicZDFenBu?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt',
      { timeoutMs: this.timeoutMs, headers: HEADERS },
    )
    const buckets = response.ok && Array.isArray(response.data?.data?.fenbu)
      ? response.data.data.fenbu
      : null
    if (buckets === null) {
      return { up: null, down: null, flat: null, limitUp: null, limitDown: null, qdate: null }
    }
    let up = 0
    let down = 0
    let flat = 0
    let limitUp = 0
    let limitDown = 0
    for (const bucket of buckets) {
      if (bucket === null || typeof bucket !== 'object' || Array.isArray(bucket)) continue
      for (const [rawKey, rawValue] of Object.entries(bucket)) {
        const key = Number(rawKey)
        const value = finiteNumber(rawValue)
        if (!Number.isFinite(key) || value === null) continue
        if (key > 0) up += value
        else if (key < 0) down += value
        else flat += value
        if (key === 11) limitUp = value
        if (key === -11) limitDown = value
      }
    }
    const rawDate = String(response.data?.data?.qdate ?? '')
    const qdate = /^\d{8}$/.test(rawDate)
      ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
      : null
    return { up, down, flat, limitUp, limitDown, qdate }
  }

  private marketStatus(qdate: string | null): MarketOverview['marketStatus'] {
    // A-share sessions are always evaluated in Asia/Shanghai, independent of the Host machine timezone.
    const now = new Date(this.clock.now() + 8 * 60 * 60 * 1000)
    const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`
    if (qdate !== null && qdate !== today) return 'closed'
    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
    if (minutes < 9 * 60 + 15) return 'pre'
    if (minutes <= 11 * 60 + 30) return 'trading'
    if (minutes < 13 * 60) return 'break'
    if (minutes <= 15 * 60) return 'trading'
    return 'closed'
  }

  async getMarketOverview(): Promise<MarketOverview> {
    const [indices, breadth] = await Promise.all([
      Promise.all(CORE_INDICES.map(index => this.getIndex(index.secId))),
      this.getBreadth(),
    ])
    const valid = indices.filter((entry): entry is ProviderValue<IndexQuote> => entry !== null)
    const source = valid.some(entry => entry.source === 'delay') ? 'delay' : 'realtime'
    const quotes = valid.map(entry => entry.value)
    const shanghai = quotes.find(index => index.code === '000001')
    const shenzhen = quotes.find(index => index.code === '399001')
    const totalAmount = shanghai?.amount !== null && shanghai?.amount !== undefined
      && shenzhen?.amount !== null && shenzhen?.amount !== undefined
      ? shanghai.amount + shenzhen.amount
      : null
    return {
      indices: quotes,
      breadth: {
        up: breadth.up,
        down: breadth.down,
        flat: breadth.flat,
        limitUp: breadth.limitUp,
        limitDown: breadth.limitDown,
        totalAmount,
      },
      marketStatus: this.marketStatus(breadth.qdate),
      meta: this.meta(valid.length === 0 ? 'unavailable' : source, breadth.qdate),
    }
  }

  async getSectorBoard(type: 'industry' | 'concept'): Promise<SectorBoard> {
    const filter = type === 'industry' ? 'm:90+t:2+f:!50' : 'm:90+t:3+f:!50'
    const response = await this.clist(
      {
        fs: filter,
        fid: 'f3',
        fields: 'f2,f3,f4,f6,f8,f12,f14,f104,f105,f128,f140,f136',
      },
      type === 'industry' ? 500 : 600,
    )
    const sectors: SectorItem[] = response.value.map(row => ({
      code: String(row.f12 ?? ''),
      name: String(row.f14 ?? ''),
      changePct: finiteNumber(row.f3),
      amount: finiteNumber(row.f6),
      upCount: finiteNumber(row.f104),
      downCount: finiteNumber(row.f105),
      leaderName: typeof row.f128 === 'string' ? row.f128 : null,
      leaderCode: typeof row.f140 === 'string' ? row.f140 : null,
      leaderChangePct: finiteNumber(row.f136),
    }))
    return {
      type,
      sectors,
      meta: this.meta(sectors.length === 0 ? 'unavailable' : response.source),
    }
  }

  private quoteFromRow(row: Record<string, unknown>): StockQuote {
    const code = String(row.f12 ?? '')
    const market = finiteNumber(row.f13) ?? 0
    return {
      secId: `${market}.${code}`,
      code,
      name: String(row.f14 ?? ''),
      price: finiteNumber(row.f2),
      change: finiteNumber(row.f4),
      changePct: finiteNumber(row.f3),
      amount: finiteNumber(row.f6),
      volume: finiteNumber(row.f5),
      turnoverRate: finiteNumber(row.f8),
      marketCap: finiteNumber(row.f20),
      floatCap: finiteNumber(row.f21),
      pe: finiteNumber(row.f9),
      pb: finiteNumber(row.f23),
      high: finiteNumber(row.f15),
      low: finiteNumber(row.f16),
      open: finiteNumber(row.f17),
      prevClose: finiteNumber(row.f18),
    }
  }

  async getSectorStocks(sectorCode: string): Promise<{ stocks: StockQuote[]; meta: ProviderMeta }> {
    const response = await this.clist({ fs: `b:${sectorCode}+f:!50`, fid: 'f3', fields: STOCK_FIELDS }, 300)
    const stocks = response.value.map(row => this.quoteFromRow(row))
    return { stocks, meta: this.meta(stocks.length === 0 ? 'unavailable' : response.source) }
  }

  async getRankList(
    kind: 'gainers' | 'losers' | 'amount' | 'turnover',
  ): Promise<{ entries: RankEntry[]; meta: ProviderMeta }> {
    const field = kind === 'amount' ? 'f6' : kind === 'turnover' ? 'f8' : 'f3'
    const order = kind === 'losers' ? '0' : '1'
    const response = await this.clist(
      { fs: A_SHARE_FILTER, fid: field, po: order, fields: STOCK_FIELDS },
      100,
    )
    const entries = response.value.slice(0, 20).map(row => {
      const quote = this.quoteFromRow(row)
      return {
        secId: quote.secId,
        code: quote.code,
        name: quote.name,
        price: quote.price,
        changePct: quote.changePct,
        amount: quote.amount,
        turnoverRate: quote.turnoverRate,
      }
    })
    return { entries, meta: this.meta(entries.length === 0 ? 'unavailable' : response.source) }
  }

  async getAllSecurities(): Promise<EastmoneySecurityRow[]> {
    const securities: EastmoneySecurityRow[] = []
    let expectedTotal = 0
    for (let page = 1; page <= 80; page += 1) {
      let response: ProviderValue<ClistResponse> | null = null
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0) await this.clock.sleep(800 * attempt)
        response = await this.get<ClistResponse>('api/qt/clist/get', {
          pn: String(page),
          pz: '100',
          po: '1',
          np: '1',
          fltt: '2',
          invt: '2',
          fid: 'f12',
          fs: A_SHARE_FILTER,
          fields: 'f12,f13,f14',
        })
        if (objectRows(response?.value.diff).length > 0) break
      }
      const rows = objectRows(response?.value.diff)
      if (rows.length === 0) break
      expectedTotal = finiteNumber(response?.value.total) ?? expectedTotal
      for (const row of rows) {
        const code = String(row.f12 ?? '')
        const name = String(row.f14 ?? '')
        const market = finiteNumber(row.f13)
        if (code !== '' && name !== '' && market !== null) securities.push({ code, name, market })
      }
      if (securities.length >= expectedTotal) break
    }
    return expectedTotal > 0 && securities.length >= expectedTotal * 0.95 ? securities : []
  }

  private cachedQuotes(secIds: readonly string[]): { quotes: StockQuote[]; meta: ProviderMeta } {
    const quotes = secIds.flatMap(secId => {
      const quote = this.quoteCache.get(secId)
      return quote === undefined ? [] : [quote]
    })
    return { quotes, meta: this.meta('cache') }
  }

  async getQuotes(secIds: readonly string[]): Promise<{ quotes: StockQuote[]; meta: ProviderMeta }> {
    if (secIds.length === 0) return { quotes: [], meta: this.meta('realtime') }
    try {
      const response = await this.get<ClistResponse>('api/qt/ulist.np/get', {
        fltt: '2',
        invt: '2',
        secids: secIds.join(','),
        fields: STOCK_FIELDS,
        pn: '1',
        pz: String(secIds.length),
        po: '1',
        np: '1',
      })
      const rows = objectRows(response?.value.diff)
      if (response !== null && rows.length > 0) {
        const quotes = rows.map(row => this.quoteFromRow(row))
        for (const quote of quotes) this.quoteCache.set(quote.secId, quote)
        return { quotes, meta: this.meta(response.source) }
      }

      const quotes: StockQuote[] = []
      let source: EastmoneySource = 'realtime'
      for (let index = 0; index < secIds.length; index += 6) {
        const batch = await Promise.all(secIds.slice(index, index + 6).map(secId => this.getMetricsRaw(secId)))
        for (const metrics of batch) {
          if (metrics === null) continue
          source = combineSource(source, metrics.source)
          quotes.push(this.metricsToQuote(metrics.value))
        }
      }
      if (quotes.length > 0) {
        for (const quote of quotes) this.quoteCache.set(quote.secId, quote)
        return { quotes, meta: this.meta(source) }
      }
    } catch (error) {
      if (!secIds.some(secId => this.quoteCache.has(secId))) throw error
    }
    return this.cachedQuotes(secIds)
  }

  private async getMetricsRaw(secId: string): Promise<ProviderValue<Record<string, unknown> & { __secId: string }> | null> {
    const response = await this.get<Record<string, unknown>>('api/qt/stock/get', {
      secid: secId,
      fltt: '2',
      invt: '2',
      fields: 'f43,f44,f45,f46,f47,f48,f50,f55,f57,f58,f60,f71,f84,f85,f92,f105,f116,f117,f126,f127,f137,f162,f163,f164,f165,f167,f168,f169,f170,f171,f173,f183,f184,f185,f186,f187,f188,f189',
    })
    if (response === null || response.value.f57 === null || response.value.f57 === undefined) return null
    return { source: response.source, value: { ...response.value, __secId: secId } }
  }

  private metricsToQuote(row: Record<string, unknown> & { __secId: string }): StockQuote {
    return {
      secId: row.__secId,
      code: String(row.f57 ?? ''),
      name: String(row.f58 ?? ''),
      price: finiteNumber(row.f43),
      change: finiteNumber(row.f169),
      changePct: finiteNumber(row.f170),
      amount: finiteNumber(row.f48),
      volume: finiteNumber(row.f47),
      turnoverRate: finiteNumber(row.f168),
      marketCap: finiteNumber(row.f116),
      floatCap: finiteNumber(row.f117),
      pe: finiteNumber(row.f162),
      pb: finiteNumber(row.f167),
      high: finiteNumber(row.f44),
      low: finiteNumber(row.f45),
      open: finiteNumber(row.f46),
      prevClose: finiteNumber(row.f60),
    }
  }

  async getStockMetrics(secId: string): Promise<StockMetrics | null> {
    const response = await this.getMetricsRaw(secId)
    if (response === null) return null
    const row = response.value
    const rawListingDate = finiteNumber(row.f189)
    const listing = rawListingDate !== null && rawListingDate > 19_000_000 ? String(rawListingDate) : null
    return {
      secId,
      code: String(row.f57 ?? ''),
      name: String(row.f58 ?? ''),
      price: finiteNumber(row.f43),
      change: finiteNumber(row.f169),
      changePct: finiteNumber(row.f170),
      open: finiteNumber(row.f46),
      high: finiteNumber(row.f44),
      low: finiteNumber(row.f45),
      prevClose: finiteNumber(row.f60),
      volume: finiteNumber(row.f47),
      amount: finiteNumber(row.f48),
      averagePrice: finiteNumber(row.f71),
      amplitude: finiteNumber(row.f171),
      mainNetInflow: finiteNumber(row.f137),
      turnoverRate: finiteNumber(row.f168),
      volumeRatio: finiteNumber(row.f50),
      marketCap: finiteNumber(row.f116),
      floatCap: finiteNumber(row.f117),
      totalShares: finiteNumber(row.f84),
      floatShares: finiteNumber(row.f85),
      peDynamic: finiteNumber(row.f162),
      peTtm: finiteNumber(row.f164),
      peStatic: finiteNumber(row.f163),
      psTtm: finiteNumber(row.f165),
      pb: finiteNumber(row.f167),
      roe: finiteNumber(row.f173),
      totalRevenue: finiteNumber(row.f183),
      revenueYoy: finiteNumber(row.f184),
      netProfit: finiteNumber(row.f105),
      netProfitYoy: finiteNumber(row.f185),
      grossMargin: finiteNumber(row.f186),
      netMargin: finiteNumber(row.f187),
      debtRatio: finiteNumber(row.f188),
      dividendYield: finiteNumber(row.f126),
      eps: finiteNumber(row.f55),
      bvps: finiteNumber(row.f92),
      listingDate: listing === null ? null : `${listing.slice(0, 4)}-${listing.slice(4, 6)}-${listing.slice(6, 8)}`,
      industry: typeof row.f127 === 'string' ? row.f127 : null,
      meta: this.meta(response.source),
    }
  }

  async getKline(
    secId: string,
    klt: '101' | '102' | '103' = '101',
  ): Promise<{ bars: KLineBar[]; meta: ProviderMeta }> {
    const years = klt === '101' ? 3 : klt === '102' ? 8 : 20
    const begin = new Date(this.clock.now() + 8 * 60 * 60 * 1000)
    begin.setUTCFullYear(begin.getUTCFullYear() - years)
    const beginText = `${begin.getUTCFullYear()}${String(begin.getUTCMonth() + 1).padStart(2, '0')}${String(begin.getUTCDate()).padStart(2, '0')}`
    const response = await this.get<KlineResponse>(
      'api/qt/stock/kline/get',
      {
        secid: secId,
        klt,
        fqt: '1',
        beg: beginText,
        end: '20500101',
        fields1: 'f1,f2,f3,f4,f5,f6',
        fields2: 'f51,f52,f53,f54,f55,f56,f57',
      },
      true,
    )
    const rawLines = Array.isArray(response?.value.klines) ? response.value.klines : []
    const bars: KLineBar[] = rawLines.flatMap(rawLine => {
      if (typeof rawLine !== 'string') return []
      const [date, rawOpen, rawClose, rawHigh, rawLow, rawVolume, rawAmount] = rawLine.split(',')
      const open = finiteNumberString(rawOpen)
      const close = finiteNumberString(rawClose)
      const high = finiteNumberString(rawHigh)
      const low = finiteNumberString(rawLow)
      const volume = finiteNumberString(rawVolume)
      if (date === undefined || open === null || close === null || high === null || low === null || volume === null) return []
      return [{ date, open, close, high, low, volume, amount: finiteNumberString(rawAmount) }]
    })
    if (bars.length > 0 && response !== null) {
      return { bars, meta: this.meta(response.source, bars.at(-1)?.date ?? null) }
    }
    const fallback = await this.tencent.getKline(secId, klt)
    return fallback ?? { bars: [], meta: this.meta('unavailable') }
  }

  async getTrend(secId: string): Promise<{ points: TrendPoint[]; prevClose: number | null; meta: ProviderMeta }> {
    const response = await this.get<TrendResponse>('api/qt/stock/trends2/get', {
      secid: secId,
      ndays: '1',
      iscr: '0',
      fields1: 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13',
      fields2: 'f51,f53,f56,f58',
    })
    const rawLines = Array.isArray(response?.value.trends) ? response.value.trends : []
    const points: TrendPoint[] = rawLines.flatMap(rawLine => {
      if (typeof rawLine !== 'string') return []
      const [rawTime, rawPrice, rawVolume, rawAveragePrice] = rawLine.split(',')
      const price = finiteNumberString(rawPrice)
      const volume = finiteNumberString(rawVolume)
      if (rawTime === undefined || price === null || volume === null) return []
      return [{
        time: rawTime.split(' ')[1] ?? rawTime,
        price,
        avgPrice: finiteNumberString(rawAveragePrice),
        volume,
      }]
    })
    if (points.length > 0 && response !== null) {
      return {
        points,
        prevClose: finiteNumber(response.value.preClose),
        meta: this.meta(response.source),
      }
    }
    const fallback = await this.tencent.getTrend(secId)
    return fallback ?? { points: [], prevClose: null, meta: this.meta('unavailable') }
  }
}
