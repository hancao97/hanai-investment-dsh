import { z } from 'zod'
import { factsSchema } from './local-screening.ts'
import { setImmediate } from 'node:timers/promises'
import type { HanaiDatabase } from '../../domain/src/database.ts'
import type { MarketScanQuery, MarketScanResult as ScannerResult } from '../../contracts/src/market-scan.ts'
export interface ScreeningScanner { readonly local?: boolean; query(query: MarketScanQuery): Promise<ScannerResult> }
import { evaluateTechnical } from '../../domain/src/technical-screen.ts'
import { TechnicalData, type TechnicalSource } from './technical-data.ts'
import { SourceCircuitOpenError } from '../../domain/src/providers/source-circuit.ts'
import { defaultMacroRange } from '../../contracts/src/macro-range.ts'
import { beijingMarketDate, isMarketDate } from '../../contracts/src/market-history.ts'
import { SCAN_FIELDS, type MarketScanStock, type MarketScanResult } from '../../contracts/src/market-scan.ts'
import type { ScreeningPlan } from '../../contracts/src/ai-screener.ts'
import { describeTechnicalRule, technicalProgressSchema, type TechnicalBar, type TechnicalProgress } from '../../contracts/src/technical-screen.ts'
export type { TechnicalSource } from './technical-data.ts'
const stockSchema = z.object({
  code: z.string().regex(/^\d{6}$/), secId: z.string().regex(/^[01]\.\d{6}$/), name: z.string().min(1), industry: z.string().nullable(),
  ...Object.fromEntries([...Object.keys(SCAN_FIELDS), 'price', 'changePct'].map(key => [key, z.number().finite().nullable()])) as Record<Exclude<keyof MarketScanStock, 'code' | 'secId' | 'name' | 'industry' | 'facts'>, z.ZodNullable<z.ZodNumber>>,
  facts: factsSchema.optional(),
}).passthrough()
const workSchema = z.object({
  local: z.boolean().default(false), revision: z.string().nullable().default(null),
  coverage: z.object({ universe: z.number().int().nonnegative(), unverified: z.number().int().nonnegative(), missingFields: z.array(z.string()), sortMissing: z.number().int().nonnegative() }).optional(),
  dates: z.array(z.string().refine(isMarketDate)).min(1).max(1000), through: z.string().refine(isMarketDate),
  nextPage: z.number().int().min(1).max(1001), catalogueTotal: z.number().int().min(0).max(20000).nullable(),
  universe: z.array(stockSchema).max(20000), hits: z.array(stockSchema).max(100),
  pools: z.record(z.string(), z.array(z.string().regex(/^\d{6}$/)).nullable()),
  unverifiedCodes: z.array(z.string().regex(/^\d{6}$/)).max(20000).default([]),
  unknownOutcomes: z.record(z.string().regex(/^\d{6}$/), z.array(z.boolean().nullable()).max(20)).default({}),
  progress: technicalProgressSchema,
}).strict()
type Work = Omit<z.infer<typeof workSchema>, 'universe' | 'hits'> & { universe: MarketScanStock[]; hits: MarketScanStock[] }

/** Checkpoints live outside page requests. One host queue runs bounded batches of three stocks. */
export class TechnicalScreener {
  private controller = new AbortController()
  private tail = Promise.resolve()
  private queued = new Set<string>()
  private readonly data: TechnicalData
  private readonly ownsData: boolean
  constructor(private readonly database: HanaiDatabase, private readonly scan: ScreeningScanner, private readonly source: TechnicalSource) {
    this.ownsData = !(source instanceof TechnicalData)
    this.data = source instanceof TechnicalData ? source : new TechnicalData(database, source)
  }
  private async bars(code: string, adjustment: 'qfq' | 'none', asOf: string, signal: AbortSignal): Promise<TechnicalBar[]> {
    const input = await this.data.bars(code, adjustment, asOf, signal)
    return Array.isArray(input) ? input : input.bars
  }
  busy(id: string) { return this.queued.has(id) }
  dispose() { this.controller.abort(); if (this.ownsData) this.data.dispose() }
  remove(id: string) {
    this.database.removeSetting(`ai-screener.technical.${id}`)
    this.database.removeSetting(`ai-screener.technical-universe.${id}`)
  }
  enqueue(id: string, plan: ScreeningPlan, update: (progress: TechnicalProgress, result?: MarketScanResult) => void, fail: (cause: unknown) => void): void {
    if (this.queued.has(id) || this.controller.signal.aborted) return
    this.queued.add(id)
    this.tail = this.tail.then(async () => {
      if (!this.controller.signal.aborted) await this.run(id, plan, update)
    }).catch(cause => { if (!this.controller.signal.aborted) fail(cause) }).finally(() => this.queued.delete(id))
  }
  async run(id: string, plan: ScreeningPlan, update: (progress: TechnicalProgress, result?: MarketScanResult) => void): Promise<void> {
    if (!plan.technical) throw new Error('技术公式缺失')
    const formula = plan.technical, signal = this.controller.signal, key = `ai-screener.technical.${id}`
    const catalogueKey = `ai-screener.technical-universe.${id}`
    const checkpoint = (work: Work) => {
      signal.throwIfAborted()
      // The frozen catalogue is written once, not copied on every three-stock checkpoint.
      this.database.setSetting(key, JSON.stringify({ ...work, universe: work.progress.phase === 'universe' ? work.universe : [] }))
      update(structuredClone(work.progress))
    }
    const saved = this.database.getSetting(key)
    let work: Work
    if (saved) {
      work = workSchema.parse(JSON.parse(saved)) as Work
      if (this.scan.local && !work.local) throw new Error('旧任务使用外部目录，请新建本地选股查询；原历史保留')
      if (work.progress.phase !== 'universe') {
        const stored = this.database.getSetting(catalogueKey)
        if (!stored) throw new Error('技术扫描冻结目录缺失')
        work.universe = z.array(stockSchema).max(20000).parse(JSON.parse(stored)) as MarketScanStock[]
      }
      if (work.progress.checked > work.universe.length || new Set(work.universe.map(row => row.code)).size !== work.universe.length || work.progress.asOf !== work.dates.at(-1)) throw new Error('技术扫描检查点损坏')
    } else {
      const through = defaultMacroRange().to
      const dates = await this.data.calendar(through, signal)
      if (!dates.length || dates.some((date, i) => !isMarketDate(date) || date > through || (i > 0 && date <= dates[i - 1]!))) throw new Error('技术扫描交易日历无效')
      work = { local: Boolean(this.scan.local), revision: null, through, dates, nextPage: 1, catalogueTotal: null, universe: [], hits: [], pools: {}, unverifiedCodes: [], unknownOutcomes: {}, progress: {
        phase: 'universe', asOf: dates.at(-1)!, catalogueDate: null, total: 0, checked: 0, matched: 0, unverified: 0, samples: [], evidence: {},
      } }
      checkpoint(work)
    }
    // Every catalogue page must describe the same source snapshot; no rank/top-N substitute.
    while (work.catalogueTotal === null || work.universe.length < work.catalogueTotal) {
      signal.throwIfAborted()
      const response = await this.scan.query({ ...plan.query, page: work.nextPage })
      const data = response.data
      if (response.error || !data || data.meta.cacheState === 'stale' || !data.snapshotDate) throw new Error(response.error ?? '股票目录无有效快照日期，拒绝不完整扫描')
      if (this.scan.local && work.revision !== null && work.revision !== (data.revision ?? data.meta.sourceTimestamp)) throw new Error('本地数据在枚举期间已更新，请重试新建查询')
      work.revision = data.revision ?? data.meta.sourceTimestamp
      if (data.coverage) work.coverage = data.coverage
      if (data.total === 0 && !data.coverage && !plan.query.search && !plan.query.industries?.length && !Object.keys(plan.query.ranges).length) throw new Error('全市场目录为空，不能冒充成功扫描')
      if (data.total > 20000) throw new Error('股票目录超过安全上限，未作截断扫描')
      if (work.catalogueTotal !== null && (work.catalogueTotal !== data.total || work.progress.catalogueDate !== data.snapshotDate)) throw new Error('股票目录分页期间快照或总数发生变化，请新建查询')
      work.catalogueTotal = data.total; work.progress.catalogueDate = data.snapshotDate; work.progress.total = data.total
      const known = new Set(work.universe.map(row => row.code))
      if (data.stocks.some(row => known.has(row.code)) || (!data.stocks.length && work.universe.length < data.total)) throw new Error('股票目录重复或分页缺失，拒绝样本冒充全市场')
      work.universe.push(...data.stocks); work.nextPage++; checkpoint(work)
    }
    const asOf = work.progress.asOf!
    signal.throwIfAborted()
    if (work.unverifiedCodes.length !== work.progress.unverified || !work.progress.funnel || work.progress.dataReady === undefined
      || work.unverifiedCodes.some(code => work.unknownOutcomes[code]?.length !== formula.rules.length)) {
      // Old checkpoints kept only twenty error samples, so their full retry set is unknowable.
      work.progress.checked = 0; work.progress.matched = 0; work.progress.unverified = 0
      work.progress.samples = []; work.progress.evidence = {}; work.hits = []; work.unverifiedCodes = []; work.unknownOutcomes = {}
      work.progress.dataReady = 0
      work.progress.funnel = formula.rules.map(rule => ({ formula: describeTechnicalRule(rule), passed: 0, rejected: 0, unverified: 0 }))
    }
    if (work.progress.funnel.length !== formula.rules.length || work.progress.funnel.some((step, i) => step.formula !== describeTechnicalRule(formula.rules[i]!))) throw new Error('技术公式与筛选统计不一致')
    const retryCodes = [...work.unverifiedCodes]
    const byCode = new Map(work.universe.map(stock => [stock.code, stock]))
    const rank = new Map(work.universe.map((stock, index) => [stock.code, index]))
    const checkedCodes = new Set(work.universe.slice(0, work.progress.checked).map(stock => stock.code))
    if (new Set(retryCodes).size !== retryCodes.length || retryCodes.some(code => !checkedCodes.has(code))) throw new Error('技术扫描重试检查点损坏')
    let retryIndex = 0
    if (work.progress.phase === 'universe') this.database.setSetting(catalogueKey, JSON.stringify(work.universe))
    const limitDays = Math.max(0, ...formula.rules.flatMap(rule => rule.kind === 'limit-up' ? [rule.days + (rule.offset ?? 0)] : []))
    work.progress.phase = limitDays ? 'history' : 'scanning'; checkpoint(work)
    for (const date of limitDays ? work.dates.slice(-limitDays) : []) {
      if (work.pools[date] !== undefined && work.pools[date] !== null) continue
      signal.throwIfAborted()
      try {
        const pool = await this.data.limitPool(date, signal)
        work.pools[date] = pool?.codes ?? null
      } catch { work.pools[date] = null }
      checkpoint(work)
    }
    if (limitDays) {
      const requested = work.dates.slice(-limitDays)
      const missingDates = requested.filter(date => work.pools[date] === null || work.pools[date] === undefined)
      work.progress.limitPools = { requested: requested.length, available: requested.length - missingDates.length, missingDates }
    }
    work.progress.phase = 'scanning'; checkpoint(work)
    while (retryIndex < retryCodes.length || work.progress.checked < work.universe.length) {
      signal.throwIfAborted()
      const retryBatch = retryCodes.slice(retryIndex, retryIndex + 3)
      const batch = [...retryBatch.map(code => byCode.get(code)!), ...work.universe.slice(work.progress.checked, work.progress.checked + 3 - retryBatch.length)]
      const decisions = await Promise.all(batch.map(async stock => {
        try {
          const bars = await this.bars(stock.code, formula.adjust, asOf, signal)
          const input = { dates: work.dates, bars, raw: limitDays ? this.data.localBars(stock.code, 'none', asOf) ?? [] : [] as TechnicalBar[],
            limitDates: Object.entries(work.pools).flatMap(([date, codes]) => codes?.includes(stock.code) ? [date] : []) }
          let decision = evaluateTechnical(formula, input)
          if (limitDays && !(formula.match === 'all' && decision.matched === false) && !(formula.match === 'any' && decision.matched === true)) {
            input.raw = formula.adjust === 'none' ? bars : await this.bars(stock.code, 'none', asOf, signal)
            input.limitDates = Object.entries(work.pools).flatMap(([date, codes]) => codes?.includes(stock.code) ? [date] : [])
            decision = evaluateTechnical(formula, input)
          }
          return { stock, decision }
        } catch (cause) {
          if (signal.aborted || cause instanceof SourceCircuitOpenError) throw cause
          return { stock, decision: { matched: null, evidence: [{ formula: '数据核验', matched: null, detail: cause instanceof Error ? cause.message : String(cause) }] } }
        }
      }))
      signal.throwIfAborted()
      for (const { stock, decision } of decisions) {
        const outcomes = formula.rules.map((rule, i) => decision.evidence[i]?.formula === describeTechnicalRule(rule) ? decision.evidence[i]!.matched : null)
        if (retryBatch.includes(stock.code)) {
          work.unknownOutcomes[stock.code]!.forEach((value, i) => { work.progress.funnel![i]![value === null ? 'unverified' : value ? 'passed' : 'rejected']-- })
          delete work.unknownOutcomes[stock.code]
          work.unverifiedCodes = work.unverifiedCodes.filter(code => code !== stock.code)
          work.progress.unverified--
          work.progress.samples = work.progress.samples.filter(sample => sample.code !== stock.code)
        } else work.progress.checked++
        outcomes.forEach((value, i) => { work.progress.funnel![i]![value === null ? 'unverified' : value ? 'passed' : 'rejected']++ })
        if (outcomes.every(value => value !== null)) work.progress.dataReady = (work.progress.dataReady ?? 0) + 1
        if (decision.matched) {
          work.progress.matched++
          const position = work.hits.findIndex(hit => rank.get(hit.code)! > rank.get(stock.code)!)
          if (position >= 0 || work.hits.length < 100) {
            work.hits.splice(position < 0 ? work.hits.length : position, 0, stock)
            work.progress.evidence[stock.code] = decision.evidence
            if (work.hits.length > 100) delete work.progress.evidence[work.hits.pop()!.code]
          }
        } else if (decision.matched === null) {
          work.progress.unverified++
          work.unverifiedCodes.push(stock.code)
          work.unknownOutcomes[stock.code] = outcomes
          if (work.progress.samples.length < 20) work.progress.samples.push({ code: stock.code, reason: [...new Set(decision.evidence.filter(row => row.matched === null).map(row => row.detail))].join('；').slice(0, 3000) })
        }
      }
      retryIndex += retryBatch.length
      checkpoint(work)
      await setImmediate()
    }
    work.progress.phase = 'finished'; checkpoint(work)
    const now = new Date().toISOString()
    update(work.progress, { historical: false, error: null, data: {
      query: plan.query, total: work.progress.matched, stocks: work.hits, ...(work.coverage ? { coverage: work.coverage } : {}),
      snapshotDate: asOf, collectedOn: beijingMarketDate(Date.now()),
      meta: { providerId: 'public-technical-local', sourceName: `公开日线＋宿主技术公式${limitDays ? '；历史涨停池交叉核验' : ''}；当前存续A股目录`, sourceTimestamp: asOf, fetchedAt: now, cacheState: 'fresh' },
    } })
  }
}
