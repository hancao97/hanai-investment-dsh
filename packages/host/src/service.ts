import { randomUUID } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  BootstrapData,
  DashboardData,
  Diagnostics,
  HanaiEndpoint,
  HanaiRequest,
  HanaiResponse,
  Judgement,
  JudgementDetail,
  ProviderMeta,
  SearchResult,
  StockDetail,
  StockQuote,
  WatchQuote,
} from '../../contracts/src/index.ts'
import { getMasterPersona, listMasters } from '../../masters/src/index.ts'
import { HanaiDatabase } from '../../domain/src/database.ts'
import type { HanaiPaths } from '../../domain/src/paths.ts'
import { ReportStore, ReportValidationError } from '../../domain/src/reports.ts'

const MARKET_SUCCESS_SETTING = 'market.latestSuccess'
const VALUATION_SUCCESS_SETTING = 'valuation.latestSuccess'

export interface MarketFacade {
  getDashboard(refresh?: boolean): Promise<DashboardData>
  getSectorStocks(sectorCode: string): Promise<{ stocks: StockQuote[]; meta: ProviderMeta }>
  getStockDetail(secId: string, security?: ReturnType<HanaiDatabase['getSecurity']>): Promise<StockDetail>
  getQuotes(secIds: readonly string[]): Promise<{ quotes: StockQuote[]; meta: ProviderMeta }>
  syncSecurities(database: HanaiDatabase, force?: boolean): Promise<{ count: number; updatedAt: string | null }>
  searchSecurities(database: HanaiDatabase, query: string): Promise<SearchResult[]>
}

export interface SessionFacade {
  create(judgementId: string, cwd: string, model?: import('../../contracts/src/index.ts').ModelSelectionInput): Promise<string>
  archive(sessionId: string): Promise<void>
  prompt(sessionId: string, text: string, mode?: 'queue' | 'steer'): Promise<void>
  isRunning(sessionId: string): Promise<boolean>
}

export interface HanaiServiceOptions {
  paths: HanaiPaths
  database: HanaiDatabase
  reports: ReportStore
  sessions: SessionFacade
  market: MarketFacade
  version: string
}

/** Coordinates Hanai business state while DSH remains the sole owner of conversation history. */
export class HanaiService {
  private readonly paths: HanaiPaths
  private readonly database: HanaiDatabase
  private readonly reports: ReportStore
  private readonly sessions: SessionFacade
  private readonly market: MarketFacade
  private readonly version: string
  private readonly reportJobs = new Map<string, Promise<void>>()

  constructor(options: HanaiServiceOptions) {
    this.paths = options.paths
    this.database = options.database
    this.reports = options.reports
    this.sessions = options.sessions
    this.market = options.market
    this.version = options.version
  }

  async call<K extends HanaiEndpoint>(
    endpoint: K,
    request: HanaiRequest<K>,
    signal: AbortSignal,
  ): Promise<HanaiResponse<K>> {
    signal.throwIfAborted()
    const response = await this.dispatch(endpoint, request, signal)
    signal.throwIfAborted()
    return response as HanaiResponse<K>
  }

  async recover(): Promise<void> {
    for (const judgement of this.database.listJudgements()) {
      if (judgement.reportStatus === 'preparing') {
        this.failReportAttempt(
          judgement,
          'recovery-preparing-interrupted',
          '上次启动在 DSH Session 完成绑定前中断，请重新发起研判。',
        )
        continue
      }
      if (!isReportInFlight(judgement)) continue
      if (judgement.dshSessionId === null) {
        this.failReportAttempt(
          judgement,
          'recovery-session-missing',
          '未找到本次报告对应的 DSH Session，请重新发起研判。',
        )
        continue
      }
      if (await this.sessions.isRunning(judgement.dshSessionId)) {
        this.database.updateJudgement(judgement.id, { turnStatus: 'running' })
        continue
      }
      this.enqueueReportJob(judgement.id)
    }
  }

  handleSessionEvent(sessionId: string, event: SessionEvent): void {
    const judgement = this.database.getJudgementBySession(sessionId)
    if (judgement === null) return
    if (event.type === 'turn/start') {
      this.database.updateJudgement(judgement.id, { turnStatus: 'running', errorCode: null, errorMessage: null })
      return
    }
    if (event.type !== 'turn/end') return
    if (isReportInFlight(judgement)) {
      if (event.data.reason.kind === 'completed' || event.data.reason.kind === 'max-tokens') {
        this.enqueueReportJob(judgement.id)
      } else {
        this.failReportAttempt(
          judgement,
          `turn-${event.data.reason.kind}`,
          `DSH 回合未完成：${event.data.reason.kind}`,
        )
      }
      return
    }
    this.database.updateJudgement(judgement.id, {
      turnStatus: event.data.reason.kind === 'error' ? 'failed' : 'idle',
      ...(event.data.reason.kind === 'error'
        ? { errorCode: 'chat-turn-error', errorMessage: event.data.reason.error.message }
        : { errorCode: null, errorMessage: null }),
    })
  }

  private async dispatch(
    endpoint: HanaiEndpoint,
    request: HanaiRequest<HanaiEndpoint>,
    signal: AbortSignal,
  ): Promise<unknown> {
    switch (endpoint) {
      case 'bootstrap': return this.bootstrap()
      case 'dashboard.get': {
        const input = request as HanaiRequest<'dashboard.get'>
        const result = await this.market.getDashboard(input.refresh)
        this.recordProviderSuccess(MARKET_SUCCESS_SETTING, [
          result.overview.meta,
          result.industry.meta,
          result.concept.meta,
        ])
        return result
      }
      case 'sector.stocks': {
        const result = await this.market.getSectorStocks(
          (request as HanaiRequest<'sector.stocks'>).sectorCode,
        )
        this.recordProviderSuccess(MARKET_SUCCESS_SETTING, [result.meta])
        return result
      }
      case 'security.sync': {
        const input = request as HanaiRequest<'security.sync'>
        const result = await this.market.syncSecurities(this.database, input.force)
        if (result.count > 0 && result.updatedAt !== null) {
          this.recordSuccessTimestamp(MARKET_SUCCESS_SETTING, result.updatedAt)
        }
        return result
      }
      case 'security.search': {
        const input = request as HanaiRequest<'security.search'>
        return this.market.searchSecurities(this.database, input.query)
      }
      case 'security.detail': {
        const input = request as HanaiRequest<'security.detail'>
        const detail = await this.market.getStockDetail(input.secId, this.database.getSecurity(input.secId))
        this.recordStockDetailSuccess(detail)
        return detail
      }
      case 'watch.list': return this.database.listWatchGroups()
      case 'watch.quotes': return this.watchQuotes((request as HanaiRequest<'watch.quotes'>).groupId)
      case 'watch.group.create': return this.database.createWatchGroup(
        (request as HanaiRequest<'watch.group.create'>).name,
      )
      case 'watch.group.rename': {
        const input = request as HanaiRequest<'watch.group.rename'>
        this.database.renameWatchGroup(input.id, input.name)
        return this.database.listWatchGroups()
      }
      case 'watch.group.remove': {
        this.database.removeWatchGroup((request as HanaiRequest<'watch.group.remove'>).id)
        return this.database.listWatchGroups()
      }
      case 'watch.item.add': return this.addWatchItem(request as HanaiRequest<'watch.item.add'>)
      case 'watch.item.remove': {
        const input = request as HanaiRequest<'watch.item.remove'>
        this.database.removeWatchItem(input.groupId, input.secId)
        return this.database.listWatchGroups()
      }
      case 'watch.item.move': {
        const input = request as HanaiRequest<'watch.item.move'>
        this.database.moveWatchItem(input.fromGroupId, input.toGroupId, input.secId)
        return this.database.listWatchGroups()
      }
      case 'judgement.list': return this.database.listJudgements()
      case 'judgement.create': return this.createJudgement(request as HanaiRequest<'judgement.create'>, signal)
      case 'judgement.get': return this.getJudgementDetail((request as HanaiRequest<'judgement.get'>).id)
      case 'judgement.revise': return this.reviseJudgement(request as HanaiRequest<'judgement.revise'>)
      case 'theme.set': {
        const { theme } = request as HanaiRequest<'theme.set'>
        this.database.setTheme(theme)
        return { theme }
      }
      case 'diagnostics.get': return this.diagnostics()
      default: return assertNever(endpoint)
    }
  }

  private async bootstrap(): Promise<BootstrapData> {
    if (this.database.securityCount() === 0) {
      try {
        const result = await this.market.syncSecurities(this.database, false)
        if (result.count > 0 && result.updatedAt !== null) {
          this.recordSuccessTimestamp(MARKET_SUCCESS_SETTING, result.updatedAt)
        }
      } catch {
        // First-run market access may be offline; the workbench still boots and exposes manual retry.
      }
    }
    return {
      theme: this.database.getTheme(),
      masters: listMasters(),
      groups: this.database.listWatchGroups(),
      judgements: this.database.listJudgements(),
      diagnostics: this.diagnostics(),
    }
  }

  private diagnostics(): Diagnostics {
    return {
      dataRoot: this.paths.root,
      databasePath: this.paths.databasePath,
      dshHomeOwnedByHost: true,
      securityCount: this.database.securityCount(),
      masterCount: listMasters().length,
      judgementCount: this.database.judgementCount(),
      latestMarketSuccess: this.database.getSetting('market.latestSuccess'),
      latestValuationSuccess: this.database.getSetting('valuation.latestSuccess'),
      version: this.version,
    }
  }

  private recordStockDetailSuccess(detail: StockDetail): void {
    this.recordProviderSuccess(MARKET_SUCCESS_SETTING, [
      detail.sources.quote,
      detail.sources.metrics,
      detail.sources.trend,
      detail.sources.daily,
      detail.sources.weekly,
      detail.sources.monthly,
    ])
    this.recordProviderSuccess(VALUATION_SUCCESS_SETTING, [detail.sources.valuation])
  }

  private recordProviderSuccess(setting: string, values: ReadonlyArray<ProviderMeta | null>): void {
    const newest = values
      .filter((value): value is ProviderMeta => value !== null
        && value.cacheState !== 'unavailable'
        && !value.providerId.includes('memory-cache'))
      .map(value => value.fetchedAt)
      .filter(value => Number.isFinite(Date.parse(value)))
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0]
    if (newest !== undefined) this.recordSuccessTimestamp(setting, newest)
  }

  private recordSuccessTimestamp(setting: string, timestamp: string): void {
    const next = Date.parse(timestamp)
    if (!Number.isFinite(next)) return
    const previousValue = this.database.getSetting(setting)
    const previous = previousValue === null ? NaN : Date.parse(previousValue)
    if (Number.isFinite(previous) && previous >= next) return
    this.database.setSetting(setting, new Date(next).toISOString())
  }

  private async watchQuotes(groupId: string): Promise<HanaiResponse<'watch.quotes'>> {
    const group = this.database.listWatchGroups().find(candidate => candidate.id === groupId)
    if (group === undefined) throw new Error('分组不存在')
    let quotes: StockQuote[] = []
    let meta: ProviderMeta = unavailableMarketMeta()
    try {
      const result = await this.market.getQuotes(group.secIds)
      quotes = result.quotes
      meta = result.meta
      if (quotes.length > 0) this.recordProviderSuccess(MARKET_SUCCESS_SETTING, [meta])
    } catch {
      // A watch list remains structurally usable during a provider outage.
    }
    const quoteMap = new Map(quotes.map(quote => [quote.secId, quote]))
    const watchQuotes = group.items.map((item) => {
      const security = this.database.getSecurity(item.secId)
      const quote = quoteMap.get(item.secId) ?? emptyQuote(item.secId, security?.code ?? item.secId.slice(2), security?.name ?? '未知证券')
      return {
        ...quote,
        groupId,
        addedAt: item.addedAt,
        basePrice: item.basePrice,
        sinceAddedPct: quote.price !== null && item.basePrice !== null && item.basePrice > 0
          ? (quote.price / item.basePrice - 1) * 100
          : null,
      }
    })
    return { quotes: watchQuotes, meta }
  }

  private async addWatchItem(input: HanaiRequest<'watch.item.add'>): Promise<ReturnType<HanaiDatabase['listWatchGroups']>> {
    let basePrice: number | null = null
    try {
      const result = await this.market.getQuotes([input.secId])
      basePrice = result.quotes[0]?.price ?? null
      if (result.quotes.length > 0) this.recordProviderSuccess(MARKET_SUCCESS_SETTING, [result.meta])
    } catch {
      // Adding a stock must not depend on the quote provider being online.
    }
    this.database.addWatchItem(input.groupId, input.secId, basePrice)
    return this.database.listWatchGroups()
  }

  private async createJudgement(
    input: HanaiRequest<'judgement.create'>,
    signal: AbortSignal,
  ): Promise<Judgement> {
    const master = getMasterPersona(input.masterId)
    if (master === null) throw new Error('大师不存在')
    const detail = await this.market.getStockDetail(input.secId, this.database.getSecurity(input.secId))
    this.recordStockDetailSuccess(detail)
    signal.throwIfAborted()
    const code = detail.security?.code ?? detail.quote?.code
    const stockName = detail.security?.name ?? detail.quote?.name
    if (code === undefined || stockName === undefined) throw new Error('无法识别证券名称，请先同步证券主数据')
    const id = randomUUID()
    let judgement = this.database.createJudgement({
      id,
      secId: input.secId,
      code,
      stockName,
      masterId: master.id,
      masterName: master.name,
      masterVersion: master.version,
      ...(input.model === undefined ? {} : {
        modelProvider: input.model.provider,
        model: input.model.model,
        ...(input.model.reasoningEffort === undefined ? {} : { reasoningEffort: input.model.reasoningEffort }),
      }),
    })
    let createdSessionId: string | null = null
    let sessionBound = false
    try {
      const workspace = this.reports.prepareWorkspace(id, master)
      this.reports.writeResearchContext(workspace.workspace, detail)
      const sessionId = await this.sessions.create(id, workspace.workspace, input.model)
      createdSessionId = sessionId
      judgement = this.database.updateJudgement(id, {
        dshSessionId: sessionId,
        reportStatus: 'generating',
        turnStatus: 'queued',
        repairAttempts: 0,
      })
      sessionBound = true
      await this.sessions.prompt(sessionId, initialReportPrompt(master.name, code, stockName, input.prompt))
      return judgement
    } catch (error) {
      let failure = error
      if (createdSessionId !== null && !sessionBound) {
        try {
          await this.sessions.archive(createdSessionId)
        } catch (cleanupError) {
          failure = new Error(
            `${messageOf(error)}；未绑定 Session 归档失败：${messageOf(cleanupError)}`,
            { cause: error },
          )
        }
      }
      this.failReportAttempt(judgement, 'judgement-start-failed', messageOf(failure))
      throw failure
    }
  }

  private getJudgementDetail(id: string): JudgementDetail {
    const judgement = this.database.getJudgement(id)
    if (judgement === null) throw new Error('研判不存在')
    const reports = this.database.listReportRows(id).map(row => ({
      judgementId: row.judgement_id,
      version: row.version,
      content: this.reports.read(row.relative_path),
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
      sealedAt: row.sealed_at,
      modelProvider: row.model_provider,
      model: row.model,
    }))
    return { judgement, reports }
  }

  private async reviseJudgement(input: HanaiRequest<'judgement.revise'>): Promise<Judgement> {
    const judgement = this.database.getJudgement(input.id)
    if (judgement === null) throw new Error('研判不存在')
    if (judgement.reportStatus !== 'ready' || judgement.dshSessionId === null) throw new Error('当前研判尚不可修订')
    if (await this.sessions.isRunning(judgement.dshSessionId)) throw new Error('大师正在回答，请稍后再修订报告')
    const updated = this.database.updateJudgement(judgement.id, {
      reportStatus: 'revising',
      turnStatus: 'queued',
      repairAttempts: 0,
      errorCode: null,
      errorMessage: null,
    })
    try {
      await this.sessions.prompt(judgement.dshSessionId, revisionPrompt(input.instruction))
      return updated
    } catch (error) {
      this.failReportAttempt(updated, 'revision-start-failed', messageOf(error))
      throw error
    }
  }

  private enqueueReportJob(judgementId: string): void {
    const previous = this.reportJobs.get(judgementId) ?? Promise.resolve()
    const next = previous.then(() => this.finalizeReport(judgementId))
      .catch((error) => this.failReportAttempt(judgementId, 'report-finalize-failed', messageOf(error)))
      .finally(() => {
        if (this.reportJobs.get(judgementId) === next) this.reportJobs.delete(judgementId)
      })
    this.reportJobs.set(judgementId, next)
  }

  private async finalizeReport(judgementId: string): Promise<void> {
    let judgement = this.database.getJudgement(judgementId)
    if (judgement === null || !isReportInFlight(judgement) || judgement.dshSessionId === null) return
    const sessionId = judgement.dshSessionId
    judgement = this.database.updateJudgement(judgementId, { reportStatus: 'verifying', turnStatus: 'idle' })
    try {
      const version = (judgement.latestReportVersion ?? 0) + 1
      const sealed = this.reports.seal(judgement, version)
      this.database.commitReportVersion({
        judgement_id: judgement.id,
        version: sealed.version,
        relativePath: sealed.relativePath,
        sha256: sealed.sha256,
        size_bytes: sealed.sizeBytes,
        sealed_at: sealed.sealedAt,
        model_provider: sealed.modelProvider,
        model: sealed.model,
      })
    } catch (error) {
      if (!(error instanceof ReportValidationError)) throw error
      const attempts = this.database.getRepairAttempts(judgement.id)
      if (attempts >= 1) {
        this.failReportAttempt(judgement, error.code, error.message)
        return
      }
      this.database.updateJudgement(judgement.id, {
        reportStatus: 'repairing',
        turnStatus: 'queued',
        repairAttempts: attempts + 1,
        errorCode: error.code,
        errorMessage: error.message,
      })
      await this.sessions.prompt(sessionId, repairPrompt(error.message))
    }
  }

  private failReportAttempt(judgement: Judgement | string, code: string, message: string): void {
    try {
      const current = typeof judgement === 'string' ? this.database.getJudgement(judgement) : judgement
      if (current === null) return
      this.database.updateJudgement(current.id, {
        // A failed revision must never hide or invalidate an already sealed report.
        reportStatus: current.latestReportVersion === null ? 'failed' : 'ready',
        turnStatus: 'failed',
        repairAttempts: 0,
        errorCode: code,
        errorMessage: message,
      })
    } catch {
      // The original failure is more useful than a secondary missing-row failure.
    }
  }
}

function isReportInFlight(judgement: Judgement): boolean {
  return ['generating', 'verifying', 'repairing', 'revising'].includes(judgement.reportStatus)
}

function initialReportPrompt(
  masterName: string,
  code: string,
  stockName: string,
  customPrompt?: string,
): string {
  return `你是 Hanai Investment 绑定的${masterName}大师。请先完整读取当前工作区的 AGENTS.md、你的 SKILL.md 和 RESEARCH_CONTEXT.md。\n\n`
    + `现在为 ${stockName}（${code}）完成首次正式研判。你可以使用可用工具补充并核验公开资料；明确区分事实、推断和未知项。`
    + `请把完整中文 Markdown 报告覆盖写入工作区根目录 REPORT.md，必须包含一级标题、核心结论、关键依据、估值或交易条件、反方证据、风险与待验证清单，篇幅要充分。`
    + `写入成功后，再向用户简短说明报告已经完成。\n\n`
    + (customPrompt === undefined ? '' : `用户补充要求：\n${customPrompt}\n`)
}

function revisionPrompt(instruction: string): string {
  return `用户明确要求创建一版新的正式报告。请保持当前大师方法论，重新读取现有 REPORT.md 与研究上下文，按以下要求完整修订，`
    + `并把完整 Markdown 覆盖写回 REPORT.md。不要只输出补丁或摘要。\n\n修订要求：\n${instruction}`
}

function repairPrompt(reason: string): string {
  return `上一轮 REPORT.md 未通过产品校验：${reason}。这是唯一一次自动修复机会。请立即重新读取大师能力包与研究上下文，`
    + `生成结构完整、内容充分、带一级标题的中文研判报告，覆盖写入 REPORT.md；完成后简短确认。`
}

function emptyQuote(secId: string, code: string, name: string): StockQuote {
  return {
    secId, code, name,
    price: null, change: null, changePct: null, amount: null, volume: null,
    turnoverRate: null, marketCap: null, floatCap: null, pe: null, pb: null,
    high: null, low: null, open: null, prevClose: null,
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertNever(value: never): never {
  throw new Error(`未知 Hanai endpoint：${String(value)}`)
}

function unavailableMarketMeta(): ProviderMeta {
  return {
    providerId: 'unavailable',
    sourceName: '行情暂不可用',
    sourceTimestamp: null,
    fetchedAt: new Date().toISOString(),
    cacheState: 'unavailable',
  }
}
