import { defaultMacroRange, isMacroRange, macroFiveYearsBefore, type MacroRange } from '../../contracts/src/macro-range.ts'
import { selectMacroSeries, type MacroSeriesData } from '../../contracts/src/macro-series.ts'
import { beijingMarketDate, isMarketPanelPayload, marketHistoryPanel } from '../../contracts/src/market-history.ts'
import type { MacroGenerationStatus } from '../../contracts/src/market-macro.ts'
import type { MarketHistoryStore } from '../../domain/src/market-history.ts'
import type { HanaiDatabase } from '../../domain/src/database.ts'
import type { MarketFacade } from './service.ts'
import { MacroGeneration } from './macro-generation.ts'

const STATE_KEY = 'macro.series.work'
const required = ['market.macro.index', 'market.macro.daily', 'market.macro.capital', 'market.macro.allDaily']
const fields = { 'market.macro.etf': 'etfs', 'market.macro.index': 'index', 'market.macro.daily': 'daily', 'market.macro.capital': 'capital', 'market.macro.all': 'allEtfs', 'market.macro.allDaily': 'allDaily' } as const
const panels = { etfs: 'macro.etf', index: 'macro.index', daily: 'macro.etf.daily', capital: 'macro.capital', allEtfs: 'macro.etf.all.quarter', allDaily: 'macro.etf.all.daily' } as const
const blank = (range: MacroRange): MacroSeriesData => ({ range, etfs: null, index: null, daily: null, capital: null, allEtfs: null, allDaily: null,
  meta: { providerId: 'macro-series', sourceName: '宏观范围缓存（各分项保留实际来源时间）', sourceTimestamp: range.to, fetchedAt: new Date().toISOString(), cacheState: 'fresh' } })

export interface MacroSeriesQuery {
  data: MacroSeriesData
  task: MacroGenerationStatus
  taskRange: MacroRange | null
  activeRange: MacroRange | null
  queued: MacroRange[]
}

/** Persistent range work belongs to the Host, never the observing browser. */
export class MacroSeries {
  private queue: MacroRange[] = []
  private attempts: Array<{ range: MacroRange; at: number }> = []
  private slot = ''
  private retry: MacroRange[] = []
  private active: MacroRange | null = null
  private taskRange: MacroRange | null = null
  private job = new MacroGeneration(async () => null)
  private timer: ReturnType<typeof setInterval> | undefined
  private disposed = false

  constructor(private readonly market: MarketFacade, private readonly history: MarketHistoryStore,
    private readonly settings: Pick<HanaiDatabase, 'getSetting' | 'setSetting'>,
    private readonly tickIndicators: (slot: string) => void = () => {}) {
    try {
      const saved: unknown = JSON.parse(settings.getSetting(STATE_KEY) ?? 'null')
      if (saved !== null && typeof saved === 'object' && 'queue' in saved && Array.isArray(saved.queue)) this.queue = saved.queue.filter(row => isMacroRange(row))
      if (saved !== null && typeof saved === 'object' && 'slot' in saved && typeof saved.slot === 'string') this.slot = saved.slot
      if (saved !== null && typeof saved === 'object' && 'retry' in saved && Array.isArray(saved.retry)) this.retry = saved.retry.filter(row => isMacroRange(row))
      if (saved !== null && typeof saved === 'object' && 'attempts' in saved && Array.isArray(saved.attempts)) this.attempts = saved.attempts.filter(row => row !== null && typeof row === 'object' && isMacroRange(row.range) && Number.isFinite(row.at))
    } catch { /* Invalid scheduling metadata must not hide the actual saved observations. */ }
  }

  start(): void {
    if (this.timer !== undefined || this.disposed) return
    const tick = () => { try { this.tick() } catch (error) { console.error('[hanai] macro scheduler failed; saved data retained', error) } }
    tick()
    this.timer = setInterval(tick, 60_000)
    this.timer.unref?.()
  }

  private persist(): void { this.settings.setSetting(STATE_KEY, JSON.stringify({ queue: this.queue, attempts: this.attempts, slot: this.slot, retry: this.retry })) }

  private records(): MacroSeriesData[] {
    const result: MacroSeriesData[] = []
    const legacy = blank(defaultMacroRange())
    const found = new Set<string>()
    const summaries = this.history.list()
    const needed = new Set(summaries.filter(row => row.panels.includes('macro.series')).map(row => row.date))
    for (const panel of Object.values(panels)) {
      const latest = summaries.find(row => row.panels.includes(panel))
      if (latest !== undefined) needed.add(latest.date)
    }
    for (const summary of summaries.filter(row => needed.has(row.date))) {
      const snapshot = this.history.get(summary.date)
      const series = marketHistoryPanel(snapshot, 'macro.series')
      if (series !== null) result.push(series)
      for (const [field, panel] of Object.entries(panels)) {
        if (found.has(field)) continue
        const data = marketHistoryPanel(snapshot, panel)
        if (data !== null) { Object.assign(legacy, { [field]: data }); found.add(field) }
      }
    }
    if (found.size > 0) {
      legacy.meta.fetchedAt = Object.keys(panels).flatMap(field => legacy[field as keyof typeof panels]?.meta.fetchedAt ?? []).sort().at(-1)!
      result.push(legacy)
    }
    return result
  }

  query(range: MacroRange, refresh = false): MacroSeriesQuery {
    if (!isMacroRange(range)) throw new Error('请选择有效日期范围，最长五年，结束日期不能晚于今天')
    const data = selectMacroSeries(this.records(), range)
    const dates = data.index?.points.map(point => point.date) ?? []
    const incomplete = dates.length === 0 || Date.parse(dates[0]!) - Date.parse(range.from) > 14 * 86_400_000
      || Date.parse(range.to) - Date.parse(dates.at(-1)!) > 14 * 86_400_000 || dates.some(date => !data.allDaily?.points.some(row => row.date === date)
      || !(data.capital?.points.some(row => row.date === date) || data.capital?.reference?.points.some(row => row.date === date)))
    if (refresh || incomplete) this.enqueue(range, refresh)
    return { data, task: this.status(), taskRange: this.taskRange, activeRange: this.active, queued: this.queue.slice(this.active === null ? 0 : 1) }
  }

  status(): MacroGenerationStatus {
    const task = this.job.get()
    if (task.state === 'partial' && !task.archiveError && task.panels.filter(panel => required.includes(panel.endpoint)).every(panel => panel.state === 'completed')) task.state = 'completed'
    return task
  }

  private enqueue(range: MacroRange, force = false): boolean {
    if (this.disposed) return false
    if (this.queue.some(row => row.from <= range.from && row.to >= range.to)) return true
    const cooldown = force ? 60_000 : 6 * 3_600_000
    if (this.attempts.some(row => row.range.from <= range.from && row.range.to >= range.to && Date.now() - row.at < cooldown)) return false
    const merge = this.queue.findIndex((row, i) => (this.active === null || i > 0) && row.from <= range.to && row.to >= range.from
      && [row.from, range.from].sort()[0]! >= macroFiveYearsBefore([row.to, range.to].sort().at(-1)!))
    if (merge >= 0) {
      const row = this.queue[merge]!
      this.queue[merge] = { from: [row.from, range.from].sort()[0]!, to: [row.to, range.to].sort().at(-1)! }
    } else this.queue.push(range)
    this.attempts = [...this.attempts.filter(row => Date.now() - row.at < 6 * 3_600_000), { range, at: Date.now() }]
    this.persist()
    this.pump()
    return true
  }

  private tick(): void {
    if (this.disposed) return
    const bj = new Date(Date.now() + 8 * 3_600_000)
    const slot = beijingMarketDate(Date.now() - (bj.getUTCHours() < 20 ? 86_400_000 : 0))
    this.tickIndicators(slot)
    if (slot !== this.slot) {
      this.slot = slot
      const current = defaultMacroRange()
      const retry = this.retry
      this.retry = []
      const scheduled = this.enqueue(current, true)
      const before = new Date(Date.parse(current.from) - 86_400_000).toISOString().slice(0, 10)
      const after = new Date(Date.parse(current.to) + 86_400_000).toISOString().slice(0, 10)
      for (const range of retry) {
        if (!scheduled) { this.retry.push(range); continue }
        if (range.from < current.from) this.retry.push({ from: range.from, to: range.to < before ? range.to : before })
        if (range.to > current.to) this.retry.push({ from: range.from > after ? range.from : after, to: range.to })
      }
      for (const range of this.retry) this.enqueue(range)
      this.persist()
    }
    this.pump()
  }

  private pump(): void {
    if (this.disposed || this.active !== null || this.queue.length === 0) return
    const range = this.queue[0]!
    this.active = range
    this.taskRange = range
    const seed = selectMacroSeries(this.records(), range)
    const working = blank(range)
    this.job = new MacroGeneration(async (endpoint, first, signal) => {
      signal.throwIfAborted()
      const field = fields[endpoint]
      const previous = working[field] ?? seed[field]
      const raw = this.history.list().find(row => row.panels.includes('macro.etf.inputs'))
      const inputs = raw === undefined ? null : marketHistoryPanel(this.history.get(raw.date), 'macro.etf.inputs')
      const value = endpoint === 'market.macro.index' ? await this.market.getMacroIndex(range)
        : endpoint === 'market.macro.etf' ? await this.market.getMacroEtfs(range)
        : endpoint === 'market.macro.all' ? await this.market.getMacroAllEtfs(range)
        : endpoint === 'market.macro.daily' ? await this.market.getMacroDaily(previous as typeof working.daily, inputs, range)
        : endpoint === 'market.macro.allDaily' ? await this.market.getMacroAllDaily(previous as typeof working.allDaily, inputs, first, range)
        : await this.market.getMacroCapital(previous as typeof working.capital, first, range)
      signal.throwIfAborted()
      const rawInputs = this.market.getMacroInputs()
      if (rawInputs !== null) this.history.save('macro.etf.inputs', rawInputs, rawInputs.meta)
      if (value !== null && !['stale', 'unavailable'].includes(value.meta.cacheState)) {
        if (!isMarketPanelPayload(panels[field], value)) throw new Error('宏观来源返回的数据未通过校验，保留原数据')
        Object.assign(working, { [field]: value })
        working.meta = { ...blank(range).meta }
        this.saveSeries(working)
      }
      return value
    }, task => {
      this.retry = this.retry.filter(row => !(row.from === range.from && row.to === range.to))
      if (task.panels.some(panel => required.includes(panel.endpoint) && panel.state !== 'completed')) this.retry.push(range)
      this.active = null
      this.queue.shift()
      this.persist()
      // Yield so observers can see terminal status and avoid recursively starting another job.
      queueMicrotask(() => this.pump())
    })
    this.job.start()
  }

  private saveSeries(working: MacroSeriesData): void {
    const dates = [
      ...[working.index, working.daily, working.allDaily, working.capital].flatMap(data => data?.points.map(row => row.date) ?? []),
      ...(working.capital?.reference?.points.map(row => row.date) ?? []),
      ...(working.allDaily?.missingDates.map(row => row.date) ?? []),
      ...[working.etfs, working.allEtfs].flatMap(data => data?.funds.flatMap(fund => fund.points.map(row => row.date)) ?? []),
    ].filter(date => date >= working.range.from && date <= working.range.to)
    for (const month of new Set(dates.map(date => date.slice(0, 7)))) {
      const key = `${month}-01`
      const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10)
      const to = end < working.range.to ? end : working.range.to
      const old = marketHistoryPanel(this.history.get(key), 'macro.series')
      const range = { from: key, to: old !== null && old.range.to > to ? old.range.to : to }
      const bucket = selectMacroSeries(old === null ? [working] : [old, working], range)
      // A reference-only month retains one actual preceding official anchor for provenance.
      if (bucket.capital !== null && bucket.capital.points.length === 0) {
        const anchor = [...(old?.capital?.points ?? []), ...(working.capital?.points ?? [])].filter(row => row.date < key).sort((a, b) => a.date.localeCompare(b.date)).at(-1)
        if (anchor !== undefined) {
          bucket.capital.points = [anchor]
          bucket.capital.meta = { ...bucket.capital.meta, sourceTimestamp: [anchor.date, bucket.capital.reference?.points.at(-1)?.date ?? ''].sort().at(-1)! }
          bucket.capital.officialMeta = { ...(bucket.capital.officialMeta ?? bucket.capital.meta), sourceTimestamp: anchor.date }
        } else bucket.capital = null
      }
      if (bucket.capital !== null) {
        bucket.capital.checkedMonths = [...new Set(bucket.capital.points.map(row => row.date.slice(0, 7).replace('-', '')))].sort()
        bucket.capital.refreshMonths = []
      }
      bucket.meta = working.meta
      this.history.save('macro.series', bucket, bucket.meta, key)
    }
  }

  dispose(): void { this.disposed = true; clearInterval(this.timer); this.job.dispose() }
}
