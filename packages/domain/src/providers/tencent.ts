import type { KLineBar, ProviderMeta, TrendPoint } from '../../../contracts/src/index.ts'
import { fetchJson, isoNow, systemClock, type Clock, type HttpClient } from '../http.ts'

const SOURCE_NAME = '腾讯行情（备源）'
const HEADERS = { Referer: 'https://gu.qq.com/' }

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(number) ? number : null
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

  async getKline(
    secId: string,
    klt: '101' | '102' | '103',
  ): Promise<{ bars: KLineBar[]; meta: ProviderMeta } | null> {
    const symbol = tencentSymbol(secId)
    const period = klt === '101' ? 'day' : klt === '102' ? 'week' : 'month'
    const count = klt === '101' ? 800 : klt === '102' ? 420 : 240
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},${period},,,${count},qfq`
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
    return latest === undefined ? null : { bars, meta: this.meta(latest.date) }
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
