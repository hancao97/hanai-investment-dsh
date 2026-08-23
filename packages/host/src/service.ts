import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { relative, resolve } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  BootstrapData,
  CacheClearResult,
  DashboardData,
  DefaultModelSelection,
  Diagnostics,
  ExpertChat,
  HanaiEndpoint,
  HanaiRequest,
  HanaiResponse,
  Judgement,
  JudgementDetail,
  KLinePeriod,
  ProviderMeta,
  SearchResult,
  StockDetail,
  StockKLineData,
  StockQuoteMetricsData,
  StockQuote,
  StockTrendData,
  StockValuationData,
  WatchQuote,
  WatchValuation,
} from '../../contracts/src/index.ts'
import { getMasterPersona, listMasters } from '../../masters/src/index.ts'
import { HanaiDatabase } from '../../domain/src/database.ts'
import type { HanaiPaths } from '../../domain/src/paths.ts'
import { ReportStore, ReportValidationError } from '../../domain/src/reports.ts'
import { ExpertChatStore } from '../../domain/src/expert-chats.ts'

const MARKET_SUCCESS_SETTING = 'market.latestSuccess'
const VALUATION_SUCCESS_SETTING = 'valuation.latestSuccess'

export interface MarketFacade {
  getDashboard(refresh?: boolean): Promise<DashboardData>
  getSectorStocks(sectorCode: string): Promise<{ stocks: StockQuote[]; meta: ProviderMeta }>
  getStockDetail(secId: string, security?: ReturnType<HanaiDatabase['getSecurity']>): Promise<StockDetail>
  getStockQuoteMetrics(secId: string): Promise<StockQuoteMetricsData>
  getTrend(secId: string): Promise<StockTrendData>
  getKline(secId: string, period: KLinePeriod, before?: string): Promise<StockKLineData>
  getValuation(
    secId: string,
    security?: ReturnType<HanaiDatabase['getSecurity']>,
  ): Promise<StockValuationData>
  getQuotes(secIds: readonly string[]): Promise<{ quotes: StockQuote[]; meta: ProviderMeta }>
  clearMarketCache(): number
  syncSecurities(database: HanaiDatabase, force?: boolean): Promise<{ count: number; updatedAt: string | null }>
  searchSecurities(database: HanaiDatabase, query: string): Promise<SearchResult[]>
}

export interface SessionFacade {
  create(judgementId: string, cwd: string, model?: import('../../contracts/src/index.ts').ModelSelectionInput): Promise<string>
  archive(sessionId: string): Promise<void>
  prompt(sessionId: string, text: string, mode?: 'queue' | 'steer'): Promise<void>
  isRunning(sessionId: string): Promise<boolean>
}

/** The formal DSH owner for the process-wide Agent default model. */
export interface DefaultModelFacade {
  currentSelection(): DefaultModelSelection
  saveSelection(next: DefaultModelSelection): Promise<void>
}

export interface HanaiServiceOptions {
  paths: HanaiPaths
  database: HanaiDatabase
  reports: ReportStore
  expertChats: ExpertChatStore
  sessions: SessionFacade
  defaultModel: DefaultModelFacade
  market: MarketFacade
  version: string
  /** Test seam and platform integration; the service always supplies paths.root itself. */
  openDirectory?: (directory: string) => Promise<void>
}

/** Coordinates Hanai business state while DSH remains the sole owner of conversation history. */
export class HanaiService {
  private readonly paths: HanaiPaths
  private readonly database: HanaiDatabase
  private readonly reports: ReportStore
  private readonly expertChats: ExpertChatStore
  private readonly sessions: SessionFacade
  private readonly defaultModel: DefaultModelFacade
  private readonly market: MarketFacade
  private readonly version: string
  private readonly openDirectory: (directory: string) => Promise<void>
  private readonly reportJobs = new Map<string, Promise<void>>()

  constructor(options: HanaiServiceOptions) {
    this.paths = options.paths
    this.database = options.database
    this.reports = options.reports
    this.expertChats = options.expertChats
    this.sessions = options.sessions
    this.defaultModel = options.defaultModel
    this.market = options.market
    this.version = options.version
    this.openDirectory = options.openDirectory ?? openDirectoryWithSystem
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
    for (const chat of this.database.listExpertChats()) {
      if (chat.dshSessionId === null) {
        this.database.updateExpertChat(chat.id, {
          turnStatus: 'failed',
          errorCode: 'recovery-session-missing',
          errorMessage: '上次启动在 DSH Session 完成绑定前中断，请删除后重新发起对谈。',
        })
        continue
      }
      if (await this.sessions.isRunning(chat.dshSessionId)) {
        this.database.updateExpertChat(chat.id, { turnStatus: 'running', errorCode: null, errorMessage: null })
      } else if (chat.turnStatus === 'queued' || chat.turnStatus === 'running' || chat.turnStatus === 'cancelling') {
        this.database.updateExpertChat(chat.id, { turnStatus: 'idle', errorCode: null, errorMessage: null })
      }
    }
  }

  handleSessionEvent(sessionId: string, event: SessionEvent): void {
    const judgement = this.database.getJudgementBySession(sessionId)
    if (judgement !== null) {
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
            event.data.reason.kind === 'error'
              ? `DSH 回合未完成：${event.data.reason.error.message}`
              : `DSH 回合未完成：${event.data.reason.kind}`,
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
      return
    }
    const chat = this.database.getExpertChatBySession(sessionId)
    if (chat === null) return
    if (event.type === 'turn/start') {
      this.database.updateExpertChat(chat.id, { turnStatus: 'running', errorCode: null, errorMessage: null })
      return
    }
    if (event.type !== 'turn/end') return
    this.database.updateExpertChat(chat.id, {
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
      case 'security.quote': {
        const input = request as HanaiRequest<'security.quote'>
        const result = await this.market.getStockQuoteMetrics(input.secId)
        this.recordProviderSuccess(MARKET_SUCCESS_SETTING, [
          result.quote === null ? null : result.sources.quote,
          result.metrics === null ? null : result.sources.metrics,
        ])
        return result
      }
      case 'security.trend': {
        const input = request as HanaiRequest<'security.trend'>
        const result = await this.market.getTrend(input.secId)
        this.recordProviderSuccess(MARKET_SUCCESS_SETTING, [
          result.trend.length === 0 && result.trendPrevClose === null ? null : result.meta,
        ])
        return result
      }
      case 'security.kline': {
        const input = request as HanaiRequest<'security.kline'>
        const result = await this.market.getKline(input.secId, input.period, input.before)
        this.recordProviderSuccess(MARKET_SUCCESS_SETTING, [result.bars.length === 0 ? null : result.meta])
        return result
      }
      case 'security.valuation': {
        const input = request as HanaiRequest<'security.valuation'>
        const result = await this.market.getValuation(input.secId, this.database.getSecurity(input.secId))
        this.recordProviderSuccess(VALUATION_SUCCESS_SETTING, [result.valuation === null ? null : result.meta])
        return result
      }
      case 'watch.list': return this.database.listWatchGroups()
      case 'watch.quotes': return this.watchQuotes((request as HanaiRequest<'watch.quotes'>).groupId)
      case 'watch.valuations': return this.watchValuations(
        (request as HanaiRequest<'watch.valuations'>).groupId,
      )
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
      case 'judgement.remove': return this.removeJudgement(
        (request as HanaiRequest<'judgement.remove'>).id,
      )
      case 'expert-chat.list': return this.database.listExpertChats()
      case 'expert-chat.create': return this.createExpertChat(request as HanaiRequest<'expert-chat.create'>)
      case 'expert-chat.get': return this.getExpertChat((request as HanaiRequest<'expert-chat.get'>).id)
      case 'expert-chat.remove': return this.removeExpertChat(
        (request as HanaiRequest<'expert-chat.remove'>).id,
      )
      case 'model.default.get': return this.currentDefaultModel()
      case 'model.default.set': return this.saveDefaultModel(
        request as HanaiRequest<'model.default.set'>,
      )
      case 'theme.set': {
        const { theme } = request as HanaiRequest<'theme.set'>
        this.database.setTheme(theme)
        return { theme }
      }
      case 'diagnostics.get': return this.diagnostics()
      case 'cache.clear': return this.clearCache((request as HanaiRequest<'cache.clear'>).scope)
      case 'storage.openDataRoot': {
        await this.openDirectory(this.paths.root)
        return { opened: true, dataRoot: this.paths.root }
      }
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
      expertChats: this.database.listExpertChats(),
      diagnostics: this.diagnostics(),
    }
  }

  private currentDefaultModel(): DefaultModelSelection {
    const selection = this.defaultModel.currentSelection()
    return {
      provider: String(selection.provider),
      model: String(selection.model),
      ...(selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: String(selection.reasoningEffort) }),
    }
  }

  private async saveDefaultModel(selection: DefaultModelSelection): Promise<DefaultModelSelection> {
    await this.defaultModel.saveSelection({
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selection.reasoningEffort }),
    })
    // Read through DSH again so the response reflects the settings owner's
    // committed value rather than echoing an unpersisted browser request.
    const committed = this.currentDefaultModel()
    if (committed.provider !== selection.provider
      || committed.model !== selection.model
      || committed.reasoningEffort !== selection.reasoningEffort) {
      // AgentDefaultModel deliberately no-ops when a composition mounts no
      // Settings provider. Treat that deployment shape as non-writable instead
      // of telling the browser that a selection was saved when it was not.
      throw new Error('DSH 当前未提供可写的默认模型设置')
    }
    return committed
  }

  private diagnostics(): Diagnostics {
    const total = directoryStats(this.paths.root)
    const cache = directoryStats(this.paths.cacheDir)
    const marketCache = directoryStats(this.paths.marketCacheDir)
    const valuationCache = directoryStats(this.paths.valuationCacheDir)
    const judgements = directoryStats(this.paths.judgementsDir)
    const expertChats = directoryStats(this.paths.expertChatsDir)
    return {
      dataRoot: this.paths.root,
      databasePath: this.paths.databasePath,
      dshHomeOwnedByHost: true,
      securityCount: this.database.securityCount(),
      masterCount: listMasters().length,
      judgementCount: this.database.judgementCount(),
      expertChatCount: this.database.expertChatCount(),
      latestMarketSuccess: this.database.getSetting('market.latestSuccess'),
      latestValuationSuccess: this.database.getSetting('valuation.latestSuccess'),
      storage: {
        totalBytes: total.bytes,
        cacheBytes: cache.bytes,
        marketCacheBytes: marketCache.bytes,
        valuationCacheBytes: valuationCache.bytes,
        judgementsBytes: judgements.bytes,
        expertChatsBytes: expertChats.bytes,
      },
      version: this.version,
    }
  }

  private clearCache(scope: CacheClearResult['scope']): CacheClearResult {
    const target = scope === 'market' ? this.paths.marketCacheDir : this.paths.valuationCacheDir
    assertDedicatedCacheTarget(this.paths.cacheDir, target, scope)
    if (scope === 'market') this.market.clearMarketCache()
    const before = directoryStats(target)
    if (existsSync(target)) {
      for (const entry of readdirSync(target)) {
        rmSync(resolve(target, entry), { recursive: true, force: true })
      }
    }
    const after = directoryStats(target)
    return {
      scope,
      removedFiles: Math.max(0, before.files - after.files),
      freedBytes: Math.max(0, before.bytes - after.bytes),
    }
  }

  private recordStockDetailSuccess(detail: StockDetail): void {
    this.recordProviderSuccess(MARKET_SUCCESS_SETTING, [
      detail.quote === null ? null : detail.sources.quote,
      detail.metrics === null ? null : detail.sources.metrics,
      detail.trend.length === 0 && detail.trendPrevClose === null ? null : detail.sources.trend,
      detail.daily.length === 0 ? null : detail.sources.daily,
      detail.weekly.length === 0 ? null : detail.sources.weekly,
      detail.monthly.length === 0 ? null : detail.sources.monthly,
    ])
    this.recordProviderSuccess(VALUATION_SUCCESS_SETTING, [
      detail.valuation === null ? null : detail.sources.valuation,
    ])
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

  private async watchValuations(groupId: string): Promise<HanaiResponse<'watch.valuations'>> {
    const group = this.database.listWatchGroups().find(candidate => candidate.id === groupId)
    if (group === undefined) throw new Error('分组不存在')

    const valuations = await mapWithConcurrency(group.items, 4, async (item): Promise<WatchValuation> => {
      try {
        const result = await this.market.getValuation(
          item.secId,
          this.database.getSecurity(item.secId),
        )
        return {
          secId: item.secId,
          fairValue: result.valuation?.medps ?? null,
          valuationRank: result.valuation?.valuationRank ?? null,
          meta: result.meta,
        }
      } catch {
        // One unavailable valuation must not delay or fail the remaining watch list.
        return { secId: item.secId, fairValue: null, valuationRank: null, meta: null }
      }
    })
    const metas = valuations.flatMap(item => item.meta === null ? [] : [item.meta])
    this.recordProviderSuccess(VALUATION_SUCCESS_SETTING, metas)
    return { valuations, meta: newestProviderMeta(metas) }
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

  private async createExpertChat(input: HanaiRequest<'expert-chat.create'>): Promise<ExpertChat> {
    const master = getMasterPersona(input.masterId)
    if (master === null) throw new Error('专家不存在')
    const id = randomUUID()
    let chat = this.database.createExpertChat({
      id,
      title: expertChatTitle(master.name, input.openingMessage),
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
      const workspace = this.expertChats.prepareWorkspace(id, master)
      const sessionId = await this.sessions.create(`chat-${id}`, workspace.workspace, input.model)
      createdSessionId = sessionId
      chat = this.database.updateExpertChat(id, {
        dshSessionId: sessionId,
        turnStatus: input.openingMessage === undefined ? 'idle' : 'queued',
        errorCode: null,
        errorMessage: null,
      })
      sessionBound = true
      if (input.openingMessage !== undefined) await this.sessions.prompt(sessionId, input.openingMessage)
      return chat
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
      this.database.updateExpertChat(chat.id, {
        turnStatus: 'failed',
        errorCode: 'expert-chat-start-failed',
        errorMessage: messageOf(failure),
      })
      throw failure
    }
  }

  private getExpertChat(id: string): ExpertChat {
    const chat = this.database.getExpertChat(id)
    if (chat === null) throw new Error('专家对谈不存在')
    return chat
  }

  private async removeExpertChat(id: string): Promise<HanaiResponse<'expert-chat.remove'>> {
    const chat = this.database.getExpertChat(id)
    if (chat === null) throw new Error('专家对谈不存在')
    if (chat.dshSessionId !== null) {
      if (await this.sessions.isRunning(chat.dshSessionId)) throw new Error('专家正在回答，暂时不能删除')
      await this.sessions.archive(chat.dshSessionId)
    }
    this.expertChats.remove(id)
    this.database.removeExpertChat(id)
    return this.database.listExpertChats()
  }

  private async createJudgement(
    input: HanaiRequest<'judgement.create'>,
    signal: AbortSignal,
  ): Promise<Judgement> {
    const master = getMasterPersona(input.masterId)
    if (master === null) throw new Error('大师不存在')
    if (master.chatOnly === true) throw new Error('该专家仅支持开放对谈，不能发起个股研判')
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

  private async removeJudgement(id: string): Promise<HanaiResponse<'judgement.remove'>> {
    const judgement = this.database.getJudgement(id)
    if (judgement === null) throw new Error('研判不存在')
    if (isReportInFlight(judgement) || this.reportJobs.has(id)) {
      throw new Error('研判仍在进行中，完成或失败后才能删除')
    }
    if (judgement.dshSessionId !== null) {
      if (await this.sessions.isRunning(judgement.dshSessionId)) {
        throw new Error('大师会话仍在运行，暂时不能删除')
      }
      await this.sessions.archive(judgement.dshSessionId)
    }
    this.database.removeJudgement(id)
    this.reports.removeJudgement(id)
    return this.database.listJudgements()
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

function expertChatTitle(masterName: string, openingMessage?: string): string {
  const normalized = openingMessage?.replace(/\s+/g, ' ').trim() ?? ''
  if (normalized === '') return `与${masterName}开放对谈`
  const characters = [...normalized]
  return characters.length > 28 ? `${characters.slice(0, 28).join('')}…` : normalized
}

function initialReportPrompt(
  masterName: string,
  code: string,
  stockName: string,
  customPrompt?: string,
): string {
  return `你正在 Hanai Worth · 值见的研判工作区中。请先完整读取当前工作区的 AGENTS.md、你的 SKILL.md 和 RESEARCH_CONTEXT.md。\n\n`
    + `现在请以${masterName}大师的方法论与表达方式，为 ${stockName}（${code}）完成首次正式研判。必须使用该大师能力包的分析框架、启发式和表达方式。`
    + `请主动联网检索公司公告、财报、监管披露、行业资料及其他必要的一手或可信来源，获取最新公开信息并交叉核验；不要向用户提问，也不要等待用户补充材料。`
    + `事实、推断、假设和未知项必须清楚分开；关键事实注明来源链接和日期，关键数字写明口径与日期。严禁编造数据、来源或引文，证据不足时明确标记不确定性。`
    + `请把完整中文 Markdown 报告覆盖写入工作区根目录 REPORT.md。报告必须可独立阅读，并至少包含一级标题、执行摘要、信息时点与来源、业务与护城河或竞争格局、财务质量、估值与关键假设或交易条件、催化剂、反方证据、核心风险、乐观/基准/悲观情景、待持续验证清单，以及符合该大师框架的最终研判。`
    + `不要给出收益承诺或伪造精确目标。写入成功后，只用一句话向用户确认报告已经完成，不要在回复中重复整份报告。\n\n`
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

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  project: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await project(items[index]!, index)
    }
  })
  await Promise.all(workers)
  return results
}

function newestProviderMeta(values: readonly ProviderMeta[]): ProviderMeta | null {
  let newest: ProviderMeta | null = null
  let newestTime = -Infinity
  for (const value of values) {
    const time = Date.parse(value.fetchedAt)
    if (newest === null || (Number.isFinite(time) && time > newestTime)) {
      newest = value
      newestTime = Number.isFinite(time) ? time : newestTime
    }
  }
  return newest
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

/** Open one directory using the operating system's standard file browser. */
export async function openDirectoryWithSystem(directory: string): Promise<void> {
  const invocation = process.platform === 'darwin'
    ? { command: 'open', args: [directory] }
    : process.platform === 'win32'
      ? { command: 'explorer', args: [directory] }
      : process.platform === 'linux'
        ? { command: 'xdg-open', args: [directory] }
        : null
  if (invocation === null) {
    throw new Error(`当前平台不支持打开数据目录：${process.platform}`)
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(invocation.command, invocation.args, {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', (error) => {
      rejectPromise(new Error(`无法启动文件浏览器 ${invocation.command}：${messageOf(error)}`, { cause: error }))
    })
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      const reason = code === null ? `signal ${signal ?? 'unknown'}` : `exit ${code}`
      rejectPromise(new Error(`文件浏览器 ${invocation.command} 打开数据目录失败（${reason}）`))
    })
  })
}

interface DirectoryStats {
  bytes: number
  files: number
}

/** Count file payloads without following symlinks outside the isolated data root. */
function directoryStats(path: string): DirectoryStats {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch {
    return { bytes: 0, files: 0 }
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return { bytes: stat.size, files: 1 }
  }
  let bytes = 0
  let files = 0
  for (const entry of readdirSync(path)) {
    const child = directoryStats(resolve(path, entry))
    bytes += child.bytes
    files += child.files
  }
  return { bytes, files }
}

function assertDedicatedCacheTarget(
  cacheRoot: string,
  target: string,
  scope: CacheClearResult['scope'],
): void {
  const expectedName = scope === 'market' ? 'market' : 'valuation'
  const normalizedRoot = resolve(cacheRoot)
  const normalizedTarget = resolve(target)
  if (normalizedTarget !== resolve(normalizedRoot, expectedName)) {
    throw new Error('拒绝清理非专用缓存目录')
  }
  if (existsSync(normalizedRoot) && lstatSync(normalizedRoot).isSymbolicLink()) {
    throw new Error('拒绝通过符号链接清理缓存目录')
  }
  if (!existsSync(normalizedTarget)) return
  if (lstatSync(normalizedTarget).isSymbolicLink()) {
    throw new Error('拒绝通过符号链接清理缓存目录')
  }
  const realRoot = realpathSync(normalizedRoot)
  const realTarget = realpathSync(normalizedTarget)
  const realRelative = relative(realRoot, realTarget)
  if (realRelative !== expectedName) {
    throw new Error('拒绝清理数据根目录之外的路径')
  }
}
