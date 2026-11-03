import { z } from 'zod'
import { setImmediate } from 'node:timers/promises'
import type { StockDataStatus } from '../../contracts/src/stock-data.ts'
import { defaultMacroRange } from '../../contracts/src/macro-range.ts'
import { isMarketDate } from '../../contracts/src/market-history.ts'
import type { HanaiDatabase } from '../../domain/src/database.ts'
import { TechnicalData } from './technical-data.ts'
import { SourceCircuitOpenError } from '../../domain/src/providers/source-circuit.ts'
import type { TechnicalSource } from './technical-screener.ts'

const key = 'stock-data.work'
const savedSchema = z.object({
  taskOrigin: z.enum(['legacy', 'local']).default('legacy'),
  startedAt: z.string().datetime().nullable().default(null),
  previousError: z.object({ message: z.string().max(3000), recordedAt: z.string().datetime().nullable(), origin: z.enum(['legacy', 'local']) }).strict().nullable().default(null),
  phase: z.enum(['idle', 'queued', 'running', 'paused', 'finished', 'failed']),
  asOf: z.string().refine(isMarketDate).nullable(), latestCompleteDate: z.string().refine(isMarketDate).nullable(),
  through: z.string().refine(isMarketDate).nullable().default(null),
  codes: z.array(z.string().regex(/^\d{6}$/)).max(20000), cursor: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(), errors: z.record(z.string().regex(/^\d{6}$/), z.string().max(3000)),
  updatedAt: z.string().datetime().nullable(), availableAt: z.string().datetime().nullable(),
  attemptedAt: z.number().nonnegative(), error: z.string().max(3000).nullable(),
  metricsErrors: z.record(z.string(), z.string()).default({}), metricsCompleted: z.number().int().nonnegative().default(0),
  metricsDone: z.array(z.string().regex(/^\d{6}$/)).max(20000).default([]), prepared: z.boolean().default(false),
  reusedDaily: z.number().int().nonnegative().default(0), reusedMetrics: z.number().int().nonnegative().default(0),
  limitDates: z.array(z.string().refine(isMarketDate)).max(20).default([]),
  limitPools: z.object({ requested: z.number().int().min(0).max(20), available: z.number().int().min(0).max(20), missingDates: z.array(z.string().refine(isMarketDate)).max(20) }).strict().default({ requested: 0, available: 0, missingDates: [] }),
}).strict().refine(value => new Set(value.codes).size === value.codes.length && value.cursor <= value.codes.length
  && value.completed + Object.keys(value.errors).length === value.cursor)
type Work = z.infer<typeof savedSchema>
const empty = (): Work => ({ taskOrigin: 'local', startedAt: null, previousError: null, phase: 'idle', asOf: null, through: null, latestCompleteDate: null, codes: [], cursor: 0, completed: 0,
  errors: {}, metricsErrors: {}, metricsCompleted: 0, metricsDone: [], prepared: false, reusedDaily: 0, reusedMetrics: 0,
  updatedAt: null, availableAt: null, attemptedAt: 0, error: null, limitDates: [], limitPools: { requested: 0, available: 0, missingDates: [] } })

/** The durable sync queue belongs to the Host; settings only observes and controls it. */
export class StockDataSync {
  private readonly data: TechnicalData
  private readonly ownsData: boolean
  private work: Work = empty()
  private timer: ReturnType<typeof setInterval> | undefined
  private controller = new AbortController()
  private active: Promise<void> | undefined
  private disposed = false
  constructor(private readonly db: HanaiDatabase, private readonly source: TechnicalSource,
    private readonly syncUniverse?: (signal: AbortSignal) => Promise<void>,
    private readonly syncMetrics?: (code: string, signal: AbortSignal) => Promise<void>,
    private readonly metricsReady?: (asOf: string) => ReadonlySet<string>) {
    this.ownsData = !(source instanceof TechnicalData)
    this.data = source instanceof TechnicalData ? source : new TechnicalData(db, source)
    const saved = db.getSetting(key)
    if (saved) {
      try {
        const input = JSON.parse(saved)
        this.work = savedSchema.parse(input)
        if (!Array.isArray(input.metricsDone) && this.work.metricsCompleted > 0
          && this.work.metricsCompleted + Object.keys(this.work.metricsErrors).length === this.work.cursor) {
          this.work.metricsDone = this.work.codes.slice(0, this.work.cursor).filter(code => !(code in this.work.metricsErrors))
        }
        if (this.work.phase === 'running') this.work.phase = 'queued'
      } catch { this.work = { ...empty(), phase: 'failed', error: '同步任务记录损坏；已保存日线保留，请手动重新同步' } }
    }
  }
  status(): StockDataStatus {
    const { codes, cursor, errors, attemptedAt: _, through: _through, limitDates: _limitDates, metricsErrors, metricsCompleted, metricsDone: _done, prepared: _prepared,
      reusedDaily, reusedMetrics, taskOrigin, startedAt, previousError, ...rest } = this.work
    return { ...rest, task: { origin: taskOrigin, startedAt }, previousError,
      reused: { daily: reusedDaily, financial: reusedMetrics },
      financial: { checked: metricsCompleted + Object.keys(metricsErrors).length, completed: metricsCompleted, failed: Object.keys(metricsErrors).length, samples: Object.entries(metricsErrors).slice(0, 20).map(([code, reason]) => ({ code, reason })) }, sources: this.data.sources(), total: codes.length, checked: cursor, failed: Object.keys(errors).length,
      samples: Object.entries(errors).slice(0, 20).map(([code, reason]) => ({ code, reason })) }
  }
  start(): void {
    if (this.timer || this.disposed) return
    const tick = () => { try { this.tick() } catch (cause) { console.error('[hanai] stock-data scheduler failed; saved daily data retained', cause) } }
    tick()
    this.timer = setInterval(tick, 60_000)
    this.timer.unref?.()
  }
  private tick(): void {
    if (this.disposed || this.active || this.work.phase === 'paused') return
    if (this.work.phase === 'queued') { this.pump(); return }
    const bj = new Date(Date.now() + 8 * 3600000)
    // Before today's evening slot, catch up the last completed day's missed work.
    if (bj.getUTCHours() < 20) bj.setUTCDate(bj.getUTCDate() - 1)
    bj.setUTCHours(20, 0, 0, 0)
    const through = defaultMacroRange(bj.getTime() - 8 * 3600000).to
    if (this.work.phase === 'finished' && !this.work.error && !Object.keys(this.work.errors).length && !this.work.limitPools.missingDates.length && !Object.keys(this.work.metricsErrors).length
      && (!this.syncMetrics || this.work.metricsCompleted === this.work.codes.length) && this.work.through !== null && this.work.through >= through) return
    if ((Date.now() - this.work.attemptedAt < 6 * 3600000 && (!this.work.through || this.work.through >= through)) || (!this.db.securityCount() && !this.syncUniverse)) return
    try { this.queue(false) } catch (cause) {
      this.work.error = message(cause); this.work.phase = 'failed'; this.work.attemptedAt = Date.now(); this.persist()
    }
  }
  request(): StockDataStatus {
    if (this.disposed) throw new Error('宿主已停止')
    if (this.active || this.work.phase === 'queued') return this.status()
    if (Date.parse(this.work.availableAt ?? '') > Date.now()) throw new Error('日线同步冷却中，请稍后重试')
    this.queue(true)
    return this.status()
  }
  async ensure(): Promise<void> {
    if (this.work.phase === 'paused') throw new Error('选股数据同步已暂停，请在设置中继续同步')
    this.request()
    await this.active
    if (this.disposed) throw new Error('宿主已停止，数据准备将在重启后继续')
    if (this.status().phase === 'failed') throw new Error(this.work.error ?? '选股数据准备失败')
    if (this.status().phase === 'paused') throw new Error('选股数据准备已暂停')
  }
  pause(): StockDataStatus {
    if (this.disposed) throw new Error('宿主已停止')
    if (this.work.phase === 'running' || this.work.phase === 'queued') {
      this.work.phase = 'paused'; this.persist(); this.controller.abort()
    }
    return this.status()
  }
  private queue(manual: boolean): void {
    const codes = this.db.screeningUniverse().map(row => row.code)
    if (!codes.length && !this.syncUniverse) throw new Error('证券名录为空，请先同步证券名录')
    const previousError = this.work.error ? { message: this.work.error, recordedAt: this.work.updatedAt, origin: this.work.taskOrigin } : this.work.previousError
    const through = defaultMacroRange().to, dates = this.data.localCalendar(through), asOf = dates?.at(-1) ?? null
    const done = !this.metricsReady && this.work.asOf === asOf ? this.work.metricsDone : []
    this.work = { ...empty(), startedAt: new Date().toISOString(), previousError, latestCompleteDate: this.work.latestCompleteDate, phase: 'queued', codes,
      asOf, through: dates ? through : null, limitDates: dates?.slice(-20) ?? [], metricsDone: done,
      attemptedAt: Date.now(), availableAt: manual ? new Date(Date.now() + 60000).toISOString() : this.work.availableAt }
    this.planLocal(false)
    this.persist(); this.pump()
  }
  private planLocal(preserveAttempts: boolean): void {
    const asOf = this.work.asOf
    if (!asOf) return
    const ready = this.data.readyCodes(asOf), codes = this.work.codes
    const errors = preserveAttempts ? Object.fromEntries(Object.entries(this.work.errors).filter(([code]) => codes.includes(code) && !ready.has(code))) : {}
    const cached = codes.filter(code => ready.has(code))
    const failed = codes.filter(code => code in errors)
    this.work.codes = [...cached, ...failed, ...codes.filter(code => !ready.has(code) && !(code in errors))]
    this.work.completed = cached.length; this.work.cursor = cached.length + failed.length; this.work.errors = errors
    this.work.reusedDaily = cached.length
    const financial = new Set(this.metricsReady?.(asOf) ?? [])
    for (const code of this.work.metricsDone) financial.add(code)
    this.work.metricsDone = this.syncMetrics ? codes.filter(code => financial.has(code)) : []
    this.work.metricsCompleted = this.work.metricsDone.length
    this.work.metricsErrors = preserveAttempts ? Object.fromEntries(Object.entries(this.work.metricsErrors).filter(([code]) => codes.includes(code) && !financial.has(code))) : {}
    this.work.reusedMetrics = this.work.metricsCompleted
  }
  private pump(): void {
    if (this.active || this.disposed) return
    this.controller = new AbortController()
    this.active = this.run(this.controller.signal).catch(cause => {
      if (this.disposed || this.controller.signal.aborted) return
      this.work.phase = 'failed'; this.work.error = message(cause); this.work.attemptedAt = Date.now(); this.persist()
    }).finally(() => { this.active = undefined })
  }
  private async run(signal: AbortSignal): Promise<void> {
    if (this.work.taskOrigin === 'legacy') {
      if (this.work.error) this.work.previousError = { message: this.work.error, recordedAt: this.work.updatedAt, origin: 'legacy' }
      this.work.taskOrigin = 'local'; this.work.startedAt = new Date().toISOString(); this.work.error = null
    }
    this.work.phase = 'running'; this.persist()
    const previousAsOf = this.work.asOf
    if (!this.work.prepared) {
      if (this.syncUniverse) {
        try { await this.syncUniverse(signal) }
        catch (cause) {
          signal.throwIfAborted()
          if (!this.db.securityCount()) throw cause
          this.work.error = `证券名录更新失败，沿用本地范围；本轮不标记全量最新：${message(cause)}`
        }
        signal.throwIfAborted()
        this.work.codes = this.db.screeningUniverse().map(row => row.code)
        if (!this.work.codes.length) throw new Error('证券名录为空，不能把空范围当作已同步')
      }
      const through = defaultMacroRange().to
      const dates = await this.data.calendar(through, signal)
      signal.throwIfAborted()
      if (!dates.length || dates.some((date, i) => !isMarketDate(date) || date > through || (i > 0 && date <= dates[i - 1]!))) throw new Error('日线同步交易日历无效')
      this.work.asOf = dates.at(-1)!
      this.work.through = through
      this.work.limitDates = dates.slice(-20)
      this.work.prepared = true
    }
    if (previousAsOf !== this.work.asOf) { this.work.metricsDone = []; this.work.errors = {}; this.work.metricsErrors = {} }
    this.planLocal(true)
    this.persist()
    const asOf = this.work.asOf
    if (!asOf) throw new Error('尚未确认日线基准日')
    const missingDates: string[] = []
    for (const date of this.work.limitDates) {
      signal.throwIfAborted()
      try { if (!(await this.data.limitPool(date, signal))) missingDates.push(date) }
      catch { signal.throwIfAborted(); missingDates.push(date) }
    }
    signal.throwIfAborted()
    this.work.limitPools = { requested: this.work.limitDates.length, available: this.work.limitDates.length - missingDates.length, missingDates }
    this.persist()
    let blocked: SourceCircuitOpenError | undefined
    while (this.work.cursor < this.work.codes.length) {
      signal.throwIfAborted()
      const batch = this.work.codes.slice(this.work.cursor, this.work.cursor + 2)
      const results = await Promise.all(batch.map(async code => {
        try {
          for (const adjust of ['none', 'qfq'] as const) {
            await this.data.bars(code, adjust, asOf, signal)
          }
          return { code, error: null, blocked: undefined }
        } catch (cause) {
          signal.throwIfAborted()
          return { code, error: message(cause), blocked: cause instanceof SourceCircuitOpenError ? cause : undefined }
        }
      }))
      signal.throwIfAborted()
      for (const result of results) {
        this.work.cursor++
        if (result.error) this.work.errors[result.code] = result.error
        else this.work.completed++
      }
      this.persist()
      await setImmediate()
      blocked = results.find(row => row.blocked)?.blocked
      if (blocked) break
    }
    if (this.syncMetrics) {
      const done = new Set(this.work.metricsDone)
      const pending = this.work.codes.filter(code => !done.has(code) && !(code in this.work.metricsErrors))
      for (let index = 0; index < pending.length; index += 2) {
        signal.throwIfAborted()
        const results = await Promise.all(pending.slice(index, index + 2).map(async code => {
          try { await this.syncMetrics!(code, signal); signal.throwIfAborted(); return { code, error: null } }
          catch (cause) { signal.throwIfAborted(); return { code, error: message(cause) } }
        }))
        signal.throwIfAborted()
        for (const row of results) {
          if (row.error) this.work.metricsErrors[row.code] = row.error
          else { this.work.metricsDone.push(row.code); this.work.metricsCompleted++ }
        }
        this.persist()
        await setImmediate()
      }
    }
    signal.throwIfAborted()
    if (blocked) throw blocked
    this.work.phase = 'finished'
    if (this.work.error || Object.keys(this.work.errors).length || missingDates.length || Object.keys(this.work.metricsErrors).length
      || (this.syncMetrics && this.work.metricsCompleted + Object.keys(this.work.metricsErrors).length < this.work.codes.length)) this.work.attemptedAt = Date.now()
    if (!this.work.error && !Object.keys(this.work.errors).length) this.work.latestCompleteDate = asOf
    this.persist()
  }
  private persist(): void {
    if (this.disposed) return
    this.work.updatedAt = new Date().toISOString()
    this.db.setSetting(key, JSON.stringify(this.work))
  }
  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.work.phase === 'running') { this.work.phase = 'queued'; this.persist() }
    this.disposed = true; this.controller.abort()
    if (this.ownsData) this.data.dispose()
  }
}
function message(cause: unknown): string { return (cause instanceof Error ? cause.message : String(cause)).slice(0, 3000) }
