import type { KLineBar, ProviderMeta, StockMetrics, StockQuote, TrendPoint } from '../../../contracts/src/index.ts'
import { fetchJson, isoNow, systemClock, type Clock, type HttpClient } from '../http.ts'
import { metricsFromQuote } from './metrics.ts'

const SOURCE_NAME = '腾讯行情（备源）'
const HEADERS = { Referer: 'https://gu.qq.com/' }

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(number) ? number : null
}

function previousDate(before: string): string {
  const date = new Date(`${before}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

function quoteTimestamp(raw: string | undefined): string | null {
  if (raw === undefined || !/^\d{14}$/.test(raw)) return null
  const timestamp = Date.parse(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}+08:00`)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

function scaledNumber(raw: string | undefined, scale: number): number | null {
  const number = finiteNumber(raw)
  return number === null ? null : number * scale
}

export function tencentSymbol(secId: string): string {
  const [market, code = ''] = secId.split('.')
  if (market === '1') return `sh${code}`
  if (code.startsWith('4') || code.startsWith('8') || code.startsWith('9')) return `bj${code}`
  return `sz${code}`
}

interface TencentKlineResponse {
  code?: unknown
  data?: Record<string, Record<string, unknown>>
}

interface TencentMinuteResponse {
  code?: unknown
  data?: Record<
    string,
    {
      data?: { data?: unknown; date?: unknown }
      qt?: Record<string, unknown>
    }
  >
}

export class TencentProvider {
  private readonly quoteMetrics = new Map<string, StockMetrics>()
  constructor(
    private readonly http: HttpClient,
    private readonly clock: Clock = systemClock,
    private readonly timeoutMs = 10_000,
  ) {}

  private meta(sourceTimestamp: string | null = null): ProviderMeta {
    return {
      providerId: 'tencent-fallback',
      sourceName: SOURCE_NAME,
      sourceTimestamp,
      fetchedAt: isoNow(this.clock),
      cacheState: 'fresh',
    }
  }

  /** Tencent's text quotes are GBK encoded; parse data without evaluating the JavaScript envelope. */
  async getQuotes(secIds: readonly string[]): Promise<{ quotes: StockQuote[]; meta: ProviderMeta }> {
    const identities = new Map(secIds.map(secId => [tencentSymbol(secId), secId]))
    const quotes: StockQuote[] = []
    const symbols = [...identities.keys()]
    for (let offset = 0; offset < symbols.length; offset += 60) {
      try {
        const response = await this.http.request(`https://qt.gtimg.cn/q=${symbols.slice(offset, offset + 60).join(',')}`, {
          timeoutMs: this.timeoutMs,
          headers: HEADERS,
          responseEncoding: 'gb18030',
        })
        if (response.status < 200 || response.status >= 300) continue
        for (const match of response.body.matchAll(/\bv_([a-z]{2}\d{6})="([^"]*)"/g)) {
          const symbol = match[1]
          const secId = symbol === undefined ? undefined : identities.get(symbol)
          const fields = (match[2] ?? '').split('~')
          const price = finiteNumber(fields[3])
          if (secId === undefined || fields[2] !== secId.slice(2) || !fields[1] || price === null || price <= 0) continue
          const timestamp = quoteTimestamp(fields[30])
          const age = timestamp === null ? Infinity : this.clock.now() - Date.parse(timestamp)
          const quote: StockQuote = {
            secId,
            code: fields[2],
            name: fields[1],
            price,
            change: finiteNumber(fields[31]),
            changePct: finiteNumber(fields[32]),
            // Tencent reports amount in ten-thousand yuan and capitalization in hundred-million yuan.
            amount: scaledNumber(fields[37], 10_000),
            volume: finiteNumber(fields[6]),
            turnoverRate: finiteNumber(fields[38]),
            marketCap: scaledNumber(fields[45], 100_000_000),
            floatCap: scaledNumber(fields[44], 100_000_000),
            pe: finiteNumber(fields[39]),
            pb: finiteNumber(fields[46]),
            high: finiteNumber(fields[33]),
            low: finiteNumber(fields[34]),
            open: finiteNumber(fields[5]),
            prevClose: finiteNumber(fields[4]),
            meta: { ...this.meta(timestamp), cacheState: age >= 0 && age <= 5 * 60_000 ? 'fresh' : 'stale' },
          }
          quotes.push(quote)
          this.quoteMetrics.set(secId, {
            ...metricsFromQuote(secId, quote, quote.meta!),
            averagePrice: finiteNumber(fields[51]), amplitude: finiteNumber(fields[43]), volumeRatio: finiteNumber(fields[49]),
            totalShares: finiteNumber(fields[73]), floatShares: finiteNumber(fields[72]),
          })
        }
      } catch {
        // One unavailable batch must not discard quotes returned by another.
      }
    }
    const oldest = quotes.map(quote => quote.meta?.sourceTimestamp).filter((value): value is string => value != null).sort()[0]
    return {
      quotes,
      meta: {
        ...this.meta(oldest ?? null),
        cacheState: quotes.length === 0 ? 'unavailable' : quotes.every(quote => quote.meta?.cacheState === 'fresh') ? 'fresh' : 'stale',
      },
    }
  }

  getQuoteMetrics(secId: string): StockMetrics | null {
    return this.quoteMetrics.get(secId) ?? null
  }

  clearQuoteMetrics(): number {
    const count = this.quoteMetrics.size
    this.quoteMetrics.clear()
    return count
  }

  async getKline(
    secId: string,
    klt: '101' | '102' | '103',
    before?: string,
  ): Promise<{ bars: KLineBar[]; meta: ProviderMeta; hasMore: boolean } | null> {
    const symbol = tencentSymbol(secId)
    const period = klt === '101' ? 'day' : klt === '102' ? 'week' : 'month'
    const count = klt === '101' ? 800 : klt === '102' ? 2_000 : 800
    const end = before === undefined ? '' : previousDate(before)
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},${period},,${end},${count},qfq`
    const response = await fetchJson<TencentKlineResponse>(this.http, url, {
      timeoutMs: this.timeoutMs,
      headers: HEADERS,
    })
    if (!response.ok || finiteNumber(response.data?.code) !== 0) return null
    const stock = response.data?.data?.[symbol]
    if (stock === undefined) return null
    const rawRows = stock[`qfq${period}`] ?? stock[period]
    if (!Array.isArray(rawRows)) return null

    const bars: KLineBar[] = []
    for (const rawRow of rawRows) {
      if (!Array.isArray(rawRow) || rawRow.length < 6) continue
      const [rawDate, rawOpen, rawClose, rawHigh, rawLow, rawVolume] = rawRow
      const open = finiteNumber(rawOpen)
      const close = finiteNumber(rawClose)
      const high = finiteNumber(rawHigh)
      const low = finiteNumber(rawLow)
      const volume = finiteNumber(rawVolume)
      if (typeof rawDate !== 'string' || open === null || close === null || high === null || low === null || volume === null) {
        continue
      }
      bars.push({
        date: rawDate,
        open,
        close,
        high,
        low,
        volume,
        // 腾讯历史 K 线不提供可靠成交额；null 不能替换成 0。
        amount: null,
      })
    }
    const latest = bars.at(-1)
    if (latest === undefined) return before === undefined ? null : { bars: [], meta: this.meta(), hasMore: false }
    return { bars, meta: this.meta(latest.date), hasMore: klt === '101' }
  }

  /** Tencent caps one response at roughly 640 rows even when a larger count is requested. */
  async getFullKline(
    secId: string,
    klt: '102' | '103',
  ): Promise<{ bars: KLineBar[]; meta: ProviderMeta; hasMore: false } | null> {
    const byDate = new Map<string, KLineBar>()
    let before: string | undefined
    let latestMeta: ProviderMeta | null = null
    for (let page = 0; page < 12; page += 1) {
      const result = await this.getKline(secId, klt, before)
      if (result === null) break
      latestMeta ??= result.meta
      const cursor = before
      const older = cursor === undefined
        ? result.bars
        : result.bars.filter(bar => bar.date < cursor)
      if (older.length === 0) break
      for (const bar of older) byDate.set(bar.date, bar)
      const nextBefore = older[0]?.date
      if (nextBefore === undefined || nextBefore === before) break
      before = nextBefore
    }
    if (byDate.size === 0 || latestMeta === null) return null
    return {
      bars: [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date)),
      meta: latestMeta,
      hasMore: false,
    }
  }

  async getTrend(
    secId: string,
  ): Promise<{ points: TrendPoint[]; prevClose: number | null; meta: ProviderMeta } | null> {
    const symbol = tencentSymbol(secId)
    const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${symbol}`
    const response = await fetchJson<TencentMinuteResponse>(this.http, url, {
      timeoutMs: this.timeoutMs,
      headers: HEADERS,
    })
    if (!response.ok || finiteNumber(response.data?.code) !== 0) return null
    const entry = response.data?.data?.[symbol]
    const rawRows = entry?.data?.data
    if (!Array.isArray(rawRows)) return null

    const quoteRow = entry?.qt?.[symbol]
    const prevClose = Array.isArray(quoteRow) ? finiteNumber(quoteRow[4]) : null
    const points: TrendPoint[] = []
    let lastCumulativeVolume = 0
    let cumulativeAmount = 0
    for (const rawRow of rawRows) {
      if (typeof rawRow !== 'string') continue
      const parts = rawRow.trim().split(/\s+/)
      const rawTime = parts[0]
      const price = finiteNumber(parts[1])
      const cumulativeVolume = finiteNumber(parts[2])
      const amount = finiteNumber(parts[3])
      if (rawTime === undefined || rawTime.length < 4 || price === null || cumulativeVolume === null) continue
      if (amount !== null) cumulativeAmount = amount
      const averagePrice = cumulativeVolume > 0 && cumulativeAmount > 0
        ? cumulativeAmount / (cumulativeVolume * 100)
        : null
      points.push({
        time: `${rawTime.slice(0, 2)}:${rawTime.slice(2, 4)}`,
        price,
        avgPrice: averagePrice === null ? null : Number(averagePrice.toFixed(3)),
        volume: Math.max(0, cumulativeVolume - lastCumulativeVolume),
      })
      lastCumulativeVolume = cumulativeVolume
    }
    if (points.length === 0) return null
    const date = typeof entry?.data?.date === 'string' ? entry.data.date : null
    return { points, prevClose, meta: this.meta(date) }
  }
}
