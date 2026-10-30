import type { StockTrendData } from '../../../contracts/src/index.ts'
import type { MarketIntradayData, MarketSectorSignal, MarketSignalsData } from '../../../contracts/src/market-activity.ts'
import { beijingMarketDate, isMarketDate } from '../../../contracts/src/market-history.ts'
import { marketLocalTime } from '../../../contracts/src/market-indices.ts'
import { isoNow, type Clock, type HttpClient } from '../http.ts'
import { ProviderCache } from './cache.ts'
import { SourceCircuit } from './source-circuit.ts'

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const inSession = (minutes: number) => (minutes >= 570 && minutes <= 690) || (minutes >= 780 && minutes <= 905)

/** Public news annotations, not a model that scans every stock or sector. */
export class MarketActivityProvider {
  private readonly trends: ProviderCache<MarketIntradayData>
  private readonly signals: ProviderCache<MarketSignalsData>
  constructor(private readonly http: HttpClient, private readonly clock: Clock, readonly circuit: SourceCircuit,
    private readonly trend: () => Promise<StockTrendData>) {
    const ttl = () => {
      const local = marketLocalTime(clock.now(), 'Asia/Shanghai')
      return local.weekday > 0 && local.weekday < 6 && local.minutes >= 565 && local.minutes <= 905 ? 25_000 : 6 * 3_600_000
    }
    this.trends = new ProviderCache(clock, ttl)
    this.signals = new ProviderCache(clock, ttl)
  }

  getIntraday(): Promise<MarketIntradayData | null> {
    return this.trends.get('sh000001', async () => {
      const result = await this.trend()
      if (result.meta === null || result.trend.length === 0 || result.meta.sourceTimestamp === null) throw new Error('上证分时暂不可用')
      const raw = result.meta.sourceTimestamp
      const date = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}`
        : isMarketDate(raw) ? raw : beijingMarketDate(Date.parse(raw))
      const points = result.trend.filter(point => /^\d{2}:[0-5]\d$/.test(point.time) && inSession(Number(point.time.slice(0, 2)) * 60 + Number(point.time.slice(3)))
        && Number.isFinite(point.price) && point.price > 0 && Number.isFinite(point.volume) && point.volume >= 0)
      if (!isMarketDate(date) || points.length === 0) throw new Error('上证分时日期或数据无效')
      const sourceTimestamp = new Date(`${date}T${points.at(-1)!.time}:00+08:00`).toISOString()
      // Tencent labels the in-progress minute by its end, up to one minute ahead.
      const minuteEnd = result.meta.providerId === 'tencent' && date === marketLocalTime(this.clock.now(), 'Asia/Shanghai').date ? 60_000 : 0
      if (Date.parse(sourceTimestamp) > this.clock.now() + minuteEnd) throw new Error('上证分时时间晚于当前时间')
      // Index turnover/volume is not an index-point average; Tencent does not supply that line.
      return { date, points: points.map(point => ({ ...point, avgPrice: result.meta!.providerId === 'tencent' ? null : point.avgPrice })), prevClose: result.trendPrevClose, meta: { ...result.meta, sourceTimestamp } }
    })
  }

  async getSignals(): Promise<MarketSignalsData | null> {
    const trend = await this.getIntraday()
    if (trend === null) return null
    return this.signals.get(trend.date, () => this.circuit.run('ths-news', () => this.news(trend.date)))
  }

  private async news(date: string): Promise<MarketSignalsData> {
    const events = new Map<string, MarketSectorSignal>()
    const start = Date.parse(`${date}T00:00:00+08:00`)
    const deadline = this.clock.now() + 6000
    let covered = false
    let complete = false
    for (let page = 1; page <= 8; page += 1) {
      const remaining = deadline - this.clock.now()
      if (remaining <= 0) throw new Error('异动快讯读取超时')
      const response = await this.http.request(`https://news.10jqka.com.cn/tapp/news/push/stock/?page=${page}&tag=21111&track=website&pagesize=100`,
        { timeoutMs: Math.min(remaining, 5000), headers: { Referer: 'https://news.10jqka.com.cn/' } })
      if (response.status !== 200) throw new Error(`异动快讯 HTTP ${response.status}`)
      const raw: unknown = JSON.parse(response.body)
      if (!record(raw) || Number(raw.code) !== 200 || !record(raw.data) || !Array.isArray(raw.data.list)) throw new Error('异动快讯格式无效')
      const items = raw.data.list
      let earliest = Infinity
      for (const item of items) {
        if (!record(item) || !/^\d{9,11}$/.test(String(item.ctime))) continue
        const time = Number(item.ctime) * 1000
        if (time > this.clock.now()) continue
        earliest = Math.min(earliest, time)
        const local = marketLocalTime(time, 'Asia/Shanghai')
        if (local.date !== date) continue
        covered = true
        const title = typeof item.title === 'string' ? item.title.trim() : ''
        if (!inSession(local.minutes) || !title.includes('板块') || /港股|美股|日韩|欧股|期货|债市|午评|收评|早评|复盘|盘点/.test(title)) continue
        const clause = title.split(/[，,；;。]/).find(value => value.includes('板块')) ?? ''
        const match = /^(.{2,30}?)板块(.*)$/.exec(clause)
        if (match === null) continue
        const down = !/跌幅收窄|止跌回升/.test(match[2]!) && /回落|下跌|走低|下挫|跳水|走弱|低开|跌停|跌幅|涨幅收窄/.test(match[2]!)
        if (!down && !/上涨|拉升|走高|走强|涨停|涨幅|冲高|活跃|高开|反弹|跌幅收窄|止跌回升/.test(match[2]!)) continue
        const name = match[1]!.replace(/^(?:A股|早盘|午后|盘中|尾盘|临近收盘|开盘)\s*/, '').trim()
        if (name === '') continue
        const field = Array.isArray(item.field) ? item.field.find(value => record(value) && value.name === name) : null
        const hm = `${String(Math.floor(local.minutes / 60)).padStart(2, '0')}:${String(local.minutes % 60).padStart(2, '0')}`
        const direction = down ? 'down' : 'up'
        events.set(`${hm}:${name}:${direction}`, { time: hm, name, code: record(field) ? String(field.stockCode ?? '') : '', title, direction })
      }
      if (earliest < start || items.length < 100) { complete = true; break }
    }
    if (!covered || !complete) throw new Error('异动快讯未完整覆盖分时交易日')
    return { date, method: 'ths-sector-events-v2', signals: [...events.values()].sort((a, b) => a.time.localeCompare(b.time)),
      meta: { providerId: 'ths-news', sourceName: '同花顺板块异动快讯', sourceTimestamp: date, fetchedAt: isoNow(this.clock), cacheState: 'fresh' } }
  }

  clear(): number { return this.trends.clear() + this.signals.clear() }
}
