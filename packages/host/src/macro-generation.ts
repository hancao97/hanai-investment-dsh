import { MACRO_GENERATION_PANELS, type MacroGenerationStatus, type MacroAllDailyData, type MacroDailyEtfData, type MacroCapitalData, type MacroEtfData, type MacroAllEtfData, type MacroIndexData } from '../../contracts/src/market-macro.ts'

type Endpoint = typeof MACRO_GENERATION_PANELS[number]['endpoint']
type Result = MacroAllDailyData | MacroDailyEtfData | MacroCapitalData | MacroEtfData | MacroAllEtfData | MacroIndexData | null

/** Host-owned work: browser disconnection only stops observing it. */
export class MacroGeneration {
  private status: MacroGenerationStatus = { state: 'idle', startedAt: null, finishedAt: null, availableAt: 0, panels: [] }
  private controller = new AbortController()
  private disposed = false
  constructor(private readonly load: (endpoint: Endpoint, first: boolean, signal: AbortSignal) => Promise<Result>,
    private readonly finish: (status: MacroGenerationStatus) => void = () => {}) {}

  get(): MacroGenerationStatus { return structuredClone(this.status) }

  start(): MacroGenerationStatus {
    if (this.disposed) throw new Error('宿主正在关闭')
    if (this.status.state === 'running' || Date.now() < this.status.availableAt) return this.get()
    this.controller = new AbortController()
    this.status = { state: 'running', startedAt: new Date().toISOString(), finishedAt: null, availableAt: Date.now() + 60_000,
      panels: MACRO_GENERATION_PANELS.map(panel => ({ ...panel, state: 'pending', checked: 0, total: 0, missing: 0, error: null })) }
    void this.run()
    return this.get()
  }

  private async run(): Promise<void> {
    await Promise.all(this.status.panels.map(async panel => {
      panel.state = 'running'
      let count = -1
      try {
        while (!this.controller.signal.aborted) {
          const result = await this.load(panel.endpoint, count === -1, this.controller.signal)
          this.controller.signal.throwIfAborted()
          if (result === null || ['stale', 'unavailable'].includes(result.meta.cacheState)) throw new Error('取数失败，保留已保存数据；后续后台更新重试，也可手动更新')
          panel.checked = 'checkedMonths' in result ? result.checkedMonths.length + (result.reference?.checkedDates.length ?? 0) : 'expectedDays' in result ? result.points.length + ('missingDates' in result ? result.missingDates.length : 0) : 1
          panel.total = 'expectedDays' in result ? result.expectedDays : 'checkedMonths' in result ? Math.max(panel.checked, result.checkedMonths.length + (result.reference?.expectedDays ?? 0), result.complete ? panel.checked : panel.checked + 1) : 1
          panel.missing = 'checkedMonths' in result ? result.reference?.missingDates.length ?? 0 : 'missingDates' in result ? result.missingDates.length : 0
          if ('referenceError' in result && result.referenceError) throw new Error(result.referenceError)
          if (!('complete' in result) || result.complete || ('expectedDays' in result && panel.checked >= result.expectedDays)) {
            panel.state = panel.missing > 0 ? 'partial' : 'completed'
            return
          }
          if (panel.checked <= count) throw new Error('未取得更多数据，保留进度，等待后续更新')
          count = panel.checked
        }
      } catch (error) {
        panel.state = 'failed'
        panel.error = error instanceof Error ? error.message : '生成失败'
      }
    }))
    if (this.disposed) return
    this.status.state = this.status.panels.every(panel => panel.state === 'completed') ? 'completed'
      : this.status.panels.every(panel => panel.state === 'failed') ? 'failed' : 'partial'
    this.status.finishedAt = new Date().toISOString()
    try { this.finish(this.get()) } catch (error) {
      this.status.state = 'partial'
      this.status.archiveError = error instanceof Error ? error.message : '数据保存失败'
    }
  }

  dispose(): void { this.disposed = true; this.controller.abort() }
}
