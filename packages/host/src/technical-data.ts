import { z } from 'zod'
import { isMarketDate } from '../../contracts/src/market-history.ts'
import type { HanaiDatabase } from '../../domain/src/database.ts'
import { TechnicalHistoryStore } from '../../domain/src/technical-history.ts'
import type { TechnicalBar, TechnicalHistoryInput, HistoricalLimitPool } from '../../contracts/src/technical-screen.ts'
import type { MarketLadderData } from '../../contracts/src/market-ladder.ts'

export interface TechnicalSource {
  calendar(through: string, signal: AbortSignal): Promise<string[]>
  bars(code: string, adjust: 'qfq' | 'none', asOf: string, signal: AbortSignal, limit?: number): Promise<TechnicalBar[] | TechnicalHistoryInput>
  pool(date: string): Promise<MarketLadderData | null>
  limitPool?(date: string, signal: AbortSignal): Promise<HistoricalLimitPool | null>
}

/** One data boundary for background sync and on-demand screening, with two shared download slots. */
export class TechnicalData implements TechnicalSource {
  private readonly history: TechnicalHistoryStore
  private readonly lifetime = new AbortController()
  private readonly inflight = new Map<string, Promise<TechnicalHistoryInput>>()
  private readonly pools = new Map<string, Promise<HistoricalLimitPool | null>>()
  private readonly waiting: Array<{ run: () => Promise<void>; reject: (cause: unknown) => void }> = []
  private active = 0
  constructor(private readonly db: HanaiDatabase, private readonly source: TechnicalSource) { this.history = new TechnicalHistoryStore(db.sqlite) }
  sources() { return this.history.sources() }
  readyCodes(asOf: string) { this.lifetime.signal.throwIfAborted(); return this.history.readyCodes(asOf) }
  localBars(code: string, adjust: 'qfq' | 'none', asOf: string): TechnicalBar[] | null {
    this.lifetime.signal.throwIfAborted()
    return this.history.read(code, adjust, asOf)
  }
  async calendar(through: string, signal: AbortSignal): Promise<string[]> {
    signal.throwIfAborted(); this.lifetime.signal.throwIfAborted()
    const cached = this.localCalendar(through)
    if (cached) return cached
    const dates = await this.source.calendar(through, signal)
    signal.throwIfAborted(); this.lifetime.signal.throwIfAborted()
    if (!dates.length || dates.some((date, i) => !isMarketDate(date) || date > through || (i > 0 && date <= dates[i - 1]!))) throw new Error('技术交易日历无效')
    this.db.setSetting('stock-data.calendar', JSON.stringify({ through, dates, fetchedAt: new Date().toISOString(), source: 'public-index-calendar' }))
    return dates
  }
  localCalendar(through: string): string[] | null {
    if (!isMarketDate(through)) throw new Error('技术截止日期无效')
    const saved = this.db.getSetting('stock-data.calendar')
    if (saved) {
      let data: { through: string; dates: string[] } | null = null
      try { data = z.object({ through: z.string().refine(isMarketDate), dates: z.array(z.string().refine(isMarketDate)).min(1).max(1000) }).parse(JSON.parse(saved)) } catch { /* Invalid local input is repaired by the public preparation source. */ }
      if (data && data.through >= through && Array.isArray(data.dates)) {
        const dates = data.dates.filter(date => date <= through)
        if (dates.length && dates.every((date, i) => isMarketDate(date) && (!i || date > dates[i - 1]!)) && Date.parse(through) - Date.parse(dates.at(-1)!) <= 15 * 86400000) return dates
      }
    }
    return null
  }
  pool(date: string) { return this.source.pool(date) }
  async limitPool(date: string, signal: AbortSignal): Promise<HistoricalLimitPool | null> {
    this.lifetime.signal.throwIfAborted(); signal.throwIfAborted()
    const saved = this.history.limitPool(date)
    if (saved && Date.now() - Date.parse(saved.fetchedAt) < 6 * 3600000) return saved
    let pending = this.pools.get(date)
    if (!pending) {
      pending = (async () => {
        let result: HistoricalLimitPool | null
        if (this.source.limitPool) result = await this.source.limitPool(date, this.lifetime.signal)
        else {
          const pool = await this.source.pool(date)
          result = pool && pool.date === date && ['fresh', 'cached'].includes(pool.meta.cacheState)
            ? { date, codes: pool.stocks.map(row => row.code), source: pool.meta.providerId, fetchedAt: pool.meta.fetchedAt, scope: 'source-pool-positive-only' } : null
        }
        this.lifetime.signal.throwIfAborted()
        if (result) {
          if (result.date !== date) throw new Error('历史涨停池日期不一致')
          this.history.writeLimitPool(result)
          return result
        }
        return saved
      })().catch(cause => { if (saved && !this.lifetime.signal.aborted) return saved; throw cause }).finally(() => this.pools.delete(date))
      this.pools.set(date, pending)
    }
    const result = await pending
    signal.throwIfAborted()
    return result
  }
  async bars(code: string, adjust: 'qfq' | 'none', asOf: string, signal: AbortSignal): Promise<TechnicalBar[] | TechnicalHistoryInput> {
    this.lifetime.signal.throwIfAborted(); signal.throwIfAborted()
    const cached = this.history.read(code, adjust, asOf)
    if (cached) return cached
    const key = `${code}:${adjust}:${asOf}`
    let job = this.inflight.get(key)
    if (!job) {
      job = new Promise<TechnicalHistoryInput>((resolve, reject) => {
        this.waiting.push({ reject, run: async () => {
          try {
            const latest = this.history.latestDate(code, adjust)
            const gap = latest ? (Date.parse(asOf) - Date.parse(latest)) / 86400000 : Infinity
            const input = adjust === 'none' && gap > 0 && gap <= 14
              ? await this.source.bars(code, adjust, asOf, this.lifetime.signal, 40)
              : await this.source.bars(code, adjust, asOf, this.lifetime.signal)
            this.lifetime.signal.throwIfAborted()
            const data = Array.isArray(input) ? { bars: input, source: 'technical-source-unattributed', fetchedAt: new Date().toISOString() } : input
            this.history.write(code, adjust, asOf, data.bars, data.source, data.fetchedAt)
            resolve(data)
          } catch (cause) { reject(cause) }
        } })
      }).finally(() => this.inflight.delete(key))
      this.inflight.set(key, job)
      this.drain()
    }
    // Cancelling an observer must not cancel another task's shared download.
    const result = await job
    signal.throwIfAborted()
    return result
  }
  private drain(): void {
    while (this.active < 2 && this.waiting.length && !this.lifetime.signal.aborted) {
      const next = this.waiting.shift()!
      this.active++
      void next.run().finally(() => { this.active--; this.drain() })
    }
  }
  dispose(): void {
    this.lifetime.abort()
    for (const task of this.waiting.splice(0)) task.reject(this.lifetime.signal.reason)
  }
}
