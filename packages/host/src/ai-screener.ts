import { z } from 'zod'
import type { ScreeningPlan, ScreeningRun } from '../../contracts/src/ai-screener.ts'
import { isMarketScanData, normalizeScanQuery } from '../../contracts/src/market-scan.ts'
import { isMarketProviderMeta } from '../../contracts/src/market-history.ts'
import type { HanaiDatabase } from '../../domain/src/database.ts'
import type { ResearchWorkspace } from '../../domain/src/research-assistant.ts'
import type { MarketScanQuery, MarketScanResult as ScannerResult } from '../../contracts/src/market-scan.ts'
export interface ScreeningScanner { readonly local?: boolean; query(query: MarketScanQuery): Promise<ScannerResult> }
import { parseHanaiRequest } from './rpc.ts'
import { technicalFormulaSchema, technicalProgressSchema } from '../../contracts/src/technical-screen.ts'
import { TechnicalScreener, type TechnicalSource } from './technical-screener.ts'

const planSchema = z.object({ question: z.string().min(1).max(4000), interpretation: z.string().trim().min(1).max(3000), query: z.unknown(), assumptions: z.array(z.string().trim().min(1).max(500)).max(20), unsupported: z.array(z.string().trim().min(1).max(500)).max(20), technical: technicalFormulaSchema.optional() }).strict()
export function parseScreeningPlan(raw: unknown, question: string): ScreeningPlan {
  if (raw === null) throw new Error('DSH未生成 screening-plan.json，请展开解析对话检查工具权限，或更换模型后重新提问')
  const value = planSchema.parse(raw)
  if (value.question !== question) throw new Error('选股计划与原始问题不一致')
  const query = normalizeScanQuery(parseHanaiRequest('market.scan.query', { query: value.query }).query)
  if (query.page !== 1) throw new Error('AI选股必须从第一页开始，不能偷偷缩小候选范围')
  return { ...value, query }
}
const key = (id: string) => `ai-screener.run.${id}`
const runSchema = z.object({ question: z.string().min(1).max(4000), status: z.enum(['parsing', 'needs-confirmation', 'scanning', 'ready', 'failed']), plan: z.unknown(), result: z.unknown(), error: z.string().nullable(), startedAt: z.string().datetime(), finishedAt: z.string().datetime().nullable(), progress: technicalProgressSchema.optional() }).strict()
/** Stores business results outside the model workspace; DSH still owns all chat messages. */
export class AiScreener {
  private readonly pending = new Map<string, Promise<ScreeningRun>>()
  private disposed = false
  private readonly technical: TechnicalScreener | undefined
  dispose() { this.disposed = true; this.technical?.dispose() }
  constructor(private readonly database: HanaiDatabase, private readonly workspace: ResearchWorkspace, private readonly scan: ScreeningScanner, source?: TechnicalSource) {
    this.technical = source ? new TechnicalScreener(database, scan, source) : undefined
  }
  busy(id: string) { return this.pending.has(id) || Boolean(this.technical?.busy(id)) }
  has(id: string) { return this.database.getSetting(key(id)) !== null }
  get(id: string): ScreeningRun | null {
    const saved = this.database.getSetting(key(id)); if (saved === null) return null
    const raw = runSchema.parse(JSON.parse(saved))
    const plan = raw.plan == null ? null : parseScreeningPlan(raw.plan, raw.question)
    let result: ScreeningRun['result'] = null
    if (raw.result != null) {
      const value = z.object({ data: z.unknown(), error: z.string().nullable(), historical: z.boolean() }).strict().parse(raw.result)
      if (value.data !== null && (!isMarketScanData(value.data) || !isMarketProviderMeta(value.data.meta))) throw new Error('本地选股结果损坏')
      result = value as ScreeningRun['result']
    }
    if (raw.status === 'ready' && (!plan || !result?.data)) throw new Error('本地选股结果缺少已执行计划或候选数据')
    if (plan && result?.data && JSON.stringify(normalizeScanQuery(result.data.query)) !== JSON.stringify(plan.query)) throw new Error('本地选股结果与计划条件不一致')
    if (plan?.technical && raw.status === 'ready' && (!raw.progress || raw.progress.phase !== 'finished' || raw.progress.checked !== raw.progress.total || raw.progress.matched !== result?.data?.total || raw.progress.asOf !== result?.data?.snapshotDate)) throw new Error('技术扫描完成状态或覆盖信息不一致')
    return { ...raw, plan, result }
  }
  private save(id: string, run: ScreeningRun): ScreeningRun { if (!this.disposed) this.database.setSetting(key(id), JSON.stringify(run)); return run }
  start(id: string, question: string) { return this.save(id, { question, status: 'parsing', plan: null, result: null, error: null, startedAt: new Date().toISOString(), finishedAt: null }) }
  fail(id: string, error: string) {
    const run = this.get(id); if (!run) return null
    if (run.status === 'ready') return run
    return this.save(id, { ...run, status: 'failed', error, finishedAt: new Date().toISOString() })
  }
  remove(id: string) { this.technical?.remove(id); this.database.removeSetting(key(id)) }
  complete(id: string): Promise<ScreeningRun> { return this.job(id, false) }
  execute(id: string): Promise<ScreeningRun> {
    const job = this.job(id, true)
    if (this.scan.local) {
      void job.catch(cause => { if (!this.disposed) console.error('[hanai] local screening failed', cause) })
      const run = this.get(id)
      if (run) return Promise.resolve(run)
    }
    return job
  }
  private job(id: string, confirmed: boolean): Promise<ScreeningRun> {
    const running = this.pending.get(id); if (running) return running
    const promise = this.process(id, confirmed).catch(cause => {
      if (this.disposed) throw cause
      const failed = this.fail(id, cause instanceof Error ? cause.message : String(cause))
      if (failed) return failed
      throw cause
    }).finally(() => this.pending.delete(id))
    this.pending.set(id, promise); return promise
  }
  private async process(id: string, confirmed: boolean): Promise<ScreeningRun> {
    let run = this.get(id); if (!run) throw new Error('该旧版对话没有结构化选股任务，请重新提问')
    if (!confirmed && !['parsing', 'scanning'].includes(run.status)) return run
    if (confirmed && !['needs-confirmation', 'failed'].includes(run.status)) return run
    if (confirmed && !run.plan) throw new Error('尚无已校验的可确认计划，请重新提问')
    const continuing = run.status === 'scanning'
    const plan = (confirmed || continuing) && run.plan ? run.plan : parseScreeningPlan(this.workspace.readScreeningPlan(id), run.question)
    const meaningful = Boolean(plan.technical) || Object.keys(plan.query.ranges).length > 0 || plan.query.search !== '' || Boolean(plan.query.industries?.length)
    run = { ...run, plan, error: null, finishedAt: null }
    if (!meaningful || (!confirmed && !continuing && (plan.technical || plan.assumptions.length > 0 || plan.unsupported.length > 0))) return this.save(id, { ...run, status: 'needs-confirmation', error: meaningful ? null : '没有可执行条件，请补充数值、名称代码或精确行业后重新提问' })
    if (plan.technical) {
      if (!this.technical) throw new Error('宿主未提供技术扫描能力，请更新并重启DSH')
      const next = this.save(id, { ...run, status: 'scanning' })
      this.technical.enqueue(id, plan, (progress, result) => {
        const current = this.get(id)
        if (current && !this.disposed) this.save(id, { ...current, progress, ...(result ? { result, status: 'ready', finishedAt: new Date().toISOString() } : {}) })
      }, cause => { this.fail(id, cause instanceof Error ? cause.message : String(cause)) })
      return next
    }
    this.save(id, { ...run, status: 'scanning' })
    const result = await this.scan.query(plan.query)
    return this.save(id, { ...run, status: result.data === null || result.error !== null ? 'failed' : 'ready', result, error: result.error, finishedAt: new Date().toISOString() })
  }
}
