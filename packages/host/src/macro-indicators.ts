import { firstMacroIndicatorGap, selectMacroIndicators, MACRO_INDICATORS, type EconomicTopic, type MacroIndicatorData, type MacroIndicatorId, type MacroIndicatorQuery, type MacroIndicatorTask } from '../../contracts/src/macro-indicators.ts'
import { defaultMacroRange, isMacroRange, macroFiveYearsBefore, type MacroRange } from '../../contracts/src/macro-range.ts'
import { selectMacroSeries, type MacroSeriesData } from '../../contracts/src/macro-series.ts'
import { marketHistoryPanel } from '../../contracts/src/market-history.ts'
import type { MarketHistoryStore } from '../../domain/src/market-history.ts'
import type { HanaiDatabase } from '../../domain/src/database.ts'

interface Work { topic: EconomicTopic; range: MacroRange }
interface Attempt extends Work { at: number; tasks: MacroIndicatorTask[] }
const needsRetry = (attempt: Attempt) => attempt.tasks.some(task => task.state === 'failed' || task.state === 'partial')
const KEY = 'macro.indicators.work'
const validWork = (value: unknown): value is Work => value !== null && typeof value === 'object' && 'topic' in value && ['credit', 'activity', 'prices', 'breadth'].includes(String(value.topic)) && 'range' in value && isMacroRange(value.range)
const contains = (a: MacroRange, b: MacroRange) => a.from <= b.from && a.to >= b.to

/** Shares the ETF scheduler's tick and canonical macro.series buckets; observations are independent. */
export class MacroIndicators {
  private queue: Work[] = []
  private attempts: Attempt[] = []
  private slot = ''
  private active: Work | null = null
  private tasks: MacroIndicatorTask[] = []
  private controller = new AbortController()
  private disposed = false
  constructor(private readonly load: (id: MacroIndicatorId, range: MacroRange, signal: AbortSignal) => Promise<MacroIndicatorData>,
    private readonly history: MarketHistoryStore, private readonly settings: Pick<HanaiDatabase, 'getSetting' | 'setSetting'>) {
    try {
      const saved = JSON.parse(settings.getSetting(KEY) ?? 'null')
      if (saved && Array.isArray(saved.queue)) this.queue = saved.queue.filter(validWork)
      if (saved && typeof saved.slot === 'string') this.slot = saved.slot
      if (saved && Array.isArray(saved.attempts)) this.attempts = saved.attempts.filter((row: unknown): row is Attempt => validWork(row) && 'at' in row && Number.isFinite(row.at) && 'tasks' in row && Array.isArray(row.tasks) && row.tasks.every(task => task && MACRO_INDICATORS.some(def => def.id === task.id) && ['completed', 'partial', 'failed'].includes(task.state) && (task.error === null || typeof task.error === 'string')))
    } catch { /* Damaged scheduling metadata must not hide saved business observations. */ }
  }
  private persist() { this.settings.setSetting(KEY, JSON.stringify({ queue: this.queue, attempts: this.attempts, slot: this.slot })) }
  private records(): MacroSeriesData[] {
    return this.history.list().filter(row => row.panels.includes('macro.series')).flatMap(row => marketHistoryPanel(this.history.get(row.date), 'macro.series') ?? [])
  }
  query(topic: EconomicTopic, range: MacroRange, refresh = false): MacroIndicatorQuery {
    if (!validWork({ topic, range })) throw new Error('无效宏观主题或日期范围（最长五年）')
    const series = selectMacroSeries(this.records(), range)
    const data = series.indicators ?? {}
    const missing = MACRO_INDICATORS.filter(row => row.topic === topic).some(row => {
      const value = data[row.id]
      return !value || !contains(value.checkedRange, range) || value.points.length === 0 || firstMacroIndicatorGap(row.id, value, range) !== null
    })
    if (refresh || missing) {
      const yearAgo = new Date(`${range.to}T00:00:00Z`)
      yearAgo.setUTCFullYear(yearAgo.getUTCFullYear() - 1)
      const from = yearAgo.toISOString().slice(0, 10)
      this.enqueue({ topic, range: topic === 'breadth' && from < range.from ? { from, to: range.to } : range }, refresh)
    }
    const applies = (work: Work) => work.topic === topic && work.range.from <= range.to && work.range.to >= range.from
    const attempt = this.attempts.filter(applies).at(-1)
    const running = this.active !== null && applies(this.active)
    return { range, ...(topic === 'breadth' ? { tradingDates: series.index?.points.map(point => point.date) ?? [] } : {}), data: Object.fromEntries(Object.entries(data).filter(([id]) => MACRO_INDICATORS.some(row => row.id === id && row.topic === topic))),
      tasks: structuredClone(running ? this.tasks : attempt?.tasks ?? []), running, queued: this.queue.some(work => work !== this.active && applies(work)) }
  }
  private enqueue(work: Work, force = false): void {
    if (this.disposed || this.queue.some(row => row.topic === work.topic && contains(row.range, work.range))) return
    const delay = force ? 60_000 : 6 * 3_600_000
    if (this.attempts.some(row => row.topic === work.topic && contains(row.range, work.range) && Date.now() - row.at < delay)) return
    const pending = this.queue.find(row => row !== this.active && row.topic === work.topic && row.range.from <= work.range.to && row.range.to >= work.range.from
      && [row.range.from, work.range.from].sort()[0]! >= macroFiveYearsBefore([row.range.to, work.range.to].sort().at(-1)!))
    if (pending) pending.range = { from: [pending.range.from, work.range.from].sort()[0]!, to: [pending.range.to, work.range.to].sort().at(-1)! }
    else this.queue.push(work)
    this.persist()
    this.pump()
  }
  /** Called by the existing Host scheduler, never by a mounted chart. */
  tick(slot: string): void {
    if (this.disposed) return
    if (slot !== this.slot) {
      this.slot = slot
      for (const topic of ['credit', 'activity', 'prices', 'breadth'] as const) this.enqueue({ topic, range: defaultMacroRange() }, true)
      this.persist()
    }
    for (const attempt of [...this.attempts]) if (needsRetry(attempt) && Date.now() - attempt.at >= 6 * 3_600_000) this.enqueue({ topic: attempt.topic, range: attempt.range })
    this.pump()
  }
  private pump(): void {
    if (this.disposed || this.active || this.queue.length === 0) return
    const work = this.queue[0]!
    this.active = work
    this.tasks = MACRO_INDICATORS.filter(row => row.topic === work.topic).map(row => ({ id: row.id, state: 'pending', error: null }))
    const tasks = this.tasks
    const seed = selectMacroSeries(this.records(), work.range).indicators ?? {}
    const at = Date.now()
    void Promise.all(tasks.map(async task => {
      task.state = 'running'
      try {
        const old = seed[task.id]
        const range = { ...work.range }
        if (old && old.checkedRange.from <= range.from && old.checkedRange.to >= range.from && old.points.length > 0) {
          const lookback = task.id === 'yields' || task.id === 'arms' ? new Date(Date.parse(old.points.at(-1)!.date) - 10 * 86_400_000).toISOString().slice(0, 10)
            : new Date(Date.UTC(Number(range.to.slice(0, 4)) - 1, Number(range.to.slice(5, 7)) - 1, 1)).toISOString().slice(0, 10)
          const recent = lookback < old.checkedRange.to ? lookback : old.checkedRange.to
          if (recent > range.from) range.from = recent
          const gap = firstMacroIndicatorGap(task.id, old, work.range)
          if (gap !== null && gap < range.from) range.from = gap
        }
        const data = await this.load(task.id, range, this.controller.signal)
        this.controller.signal.throwIfAborted()
        if (data.id !== task.id || ['stale', 'unavailable'].includes(data.meta.cacheState)) throw new Error('来源未返回本指标有效数据')
        this.save(task.id === 'arms' ? data : { ...data, checkedRange: work.range })
        const merged = selectMacroIndicators([seed, { [task.id]: data }], work.range)[task.id]!
        const gap = firstMacroIndicatorGap(task.id, merged, work.range)
        const incomplete = task.id === 'arms' && !contains(data.checkedRange, work.range)
        task.state = gap === null && !incomplete ? 'completed' : 'partial'
        if (gap !== null || incomplete) task.error = gap !== null ? `${gap}起仍有缺口，已保存可用数据，后续后台更新重试` : '来源未覆盖完整范围，已保存可用数据'
      } catch (error) { task.state = 'failed'; task.error = error instanceof Error ? error.message : '取数失败，保留本地数据' }
    })).then(() => {
      if (this.disposed) return
      const before = new Date(Date.parse(work.range.from) - 86_400_000).toISOString().slice(0, 10)
      const after = new Date(Date.parse(work.range.to) + 86_400_000).toISOString().slice(0, 10)
      this.attempts = this.attempts.flatMap(row => {
        if (row.topic !== work.topic || row.range.to < work.range.from || row.range.from > work.range.to) return needsRetry(row) || Date.now() - row.at < 6 * 3_600_000 ? [row] : []
        // A rolling window replaces only its overlap, retaining uncovered historical retries.
        return [row.range.from < work.range.from ? { ...row, range: { from: row.range.from, to: before } } : null,
          row.range.to > work.range.to ? { ...row, range: { from: after, to: row.range.to } } : null].filter((value): value is Attempt => value !== null && (needsRetry(value) || Date.now() - value.at < 6 * 3_600_000))
      })
      this.attempts.push({ ...work, at, tasks })
      this.queue.shift(); this.active = null
      this.persist()
      queueMicrotask(() => this.pump())
    }).catch(error => { console.error('[hanai] macro indicator scheduling failed; saved data retained', error) })
  }
  private save(data: MacroIndicatorData): void {
    // Keep even a checked-empty response, so unsupported historical periods are visible and backed off.
    const months = new Set(data.points.map(point => point.date.slice(0, 7)))
    if (months.size === 0) months.add(data.checkedRange.to.slice(0, 7))
    for (const month of months) {
      const key = `${month}-01`
      const monthEnd = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10)
      const old = marketHistoryPanel(this.history.get(key), 'macro.series')
      const range = { from: key, to: monthEnd > data.checkedRange.to ? data.checkedRange.to : monthEnd }
      if (old && old.range.to > range.to) range.to = old.range.to
      const incoming: MacroSeriesData = { range, etfs: null, index: null, daily: null, capital: null, allEtfs: null, allDaily: null, indicators: { [data.id]: data }, meta: data.meta }
      const merged = selectMacroSeries(old ? [old, incoming] : [incoming], range)
      merged.meta = { ...data.meta, sourceTimestamp: null }
      this.history.save('macro.series', merged, merged.meta, key)
    }
  }
  dispose(): void { this.disposed = true; this.controller.abort() }
}
