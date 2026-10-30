import { MarketHistoryStore } from '../../domain/src/market-history.ts'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DashboardData, DefaultModelSelection, ProviderMeta, StockDetail } from '../../contracts/src/index.ts'
import { MARKET_HISTORY_PANELS, marketHistoryPanel } from '../../contracts/src/market-history.ts'
import { MACRO_ETFS, MACRO_GENERATION_PANELS } from '../../contracts/src/market-macro.ts'
import { GLOBAL_INDICES } from '../../contracts/src/market-indices.ts'
import { HanaiDatabase } from '../../domain/src/database.ts'
import { ensureHanaiLayout, resolveHanaiPaths } from '../../domain/src/paths.ts'
import { ReportStore } from '../../domain/src/reports.ts'
import { ExpertChatStore } from '../../domain/src/expert-chats.ts'
import {
  HanaiService,
  type DefaultModelFacade,
  type MarketFacade,
  type SessionFacade,
} from '../src/service.ts'

const roots: string[] = []
const assets = resolve(dirname(fileURLToPath(import.meta.url)), '../../masters/assets')

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

class FakeSessions implements SessionFacade {
  prompts: Array<{ sessionId: string; text: string }> = []
  archived: string[] = []
  running = false

  async create(judgementId: string): Promise<string> { return `hanai-${judgementId}` }
  async archive(sessionId: string): Promise<void> { this.archived.push(sessionId) }
  async prompt(sessionId: string, text: string): Promise<void> { this.prompts.push({ sessionId, text }) }
  async isRunning(): Promise<boolean> { return this.running }
}

class FakeDefaultModel implements DefaultModelFacade {
  selection: DefaultModelSelection = {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
  }

  currentSelection() { return { ...this.selection } }

  async saveSelection(next: Parameters<DefaultModelFacade['saveSelection']>[0]): Promise<void> {
    this.selection = {
      provider: next.provider,
      model: next.model,
      ...(next.reasoningEffort === undefined ? {} : { reasoningEffort: next.reasoningEffort }),
    }
  }
}

function stockDetail(): StockDetail {
  return {
    security: { secId: '1.600519', code: '600519', name: '贵州茅台', exchange: 'SH', pinyinFull: 'guizhoumaotai', pinyinInitial: 'gzmt' },
    quote: null, metrics: null, trend: [], trendPrevClose: null,
    daily: [], weekly: [], monthly: [], valuation: null,
    sources: { quote: null, metrics: null, trend: null, daily: null, weekly: null, monthly: null, valuation: null },
  }
}

function fixture(minChars = 100) {
  const root = mkdtempSync(join(tmpdir(), 'hanai-dsh-service-'))
  roots.push(root)
  const paths = resolveHanaiPaths(root)
  ensureHanaiLayout(paths)
  const database = new HanaiDatabase(paths.databasePath)
  const sessions = new FakeSessions()
  const defaultModel = new FakeDefaultModel()
  const meta = {
    providerId: 'fake', sourceName: 'fake', sourceTimestamp: null,
    fetchedAt: new Date(0).toISOString(), cacheState: 'fresh' as const,
  }
  const market: MarketFacade = {
    getMacroInputs: () => null,
    getMacroAllDaily: async () => null,
    getMacroAllEtfs: async () => null,
    getMacroCapital: async () => null,
    getMacroDaily: async () => null,
    getMacroEtfs: async () => null,
    getMacroIndex: async () => null,
    getMarketIntraday: async () => null,
    getMarketSignals: async () => null,
    getGlobalIndices: async () => ({ indices: [], meta }),
    getDashboard: async () => { throw new Error('unused') },
    getMarketBreadth: async () => null,
    getSectorStocks: async () => ({ stocks: [], meta }),
    getStockDetail: async () => stockDetail(),
    getStockQuoteMetrics: async () => ({
      quote: null,
      metrics: null,
      sources: { quote: null, metrics: null },
    }),
    getTrend: async () => ({ trend: [], trendPrevClose: null, meta: null }),
    getKline: async (_secId, period) => ({ period, bars: [], meta: null, hasMore: period === 'daily' }),
    getValuation: async () => ({ valuation: null, meta: null }),
    getQuotes: async () => ({ quotes: [], meta }),
    clearMarketCache: () => 0,
    getSourceDiagnostics: () => [],
    syncSecurities: async () => ({ count: 0, updatedAt: null }),
    searchSecurities: async () => [],
  }
  const reports = new ReportStore(paths, assets, minChars)
  const expertChats = new ExpertChatStore(paths, assets)
  const openDirectory = vi.fn(async (_directory: string): Promise<void> => {})
  const service = new HanaiService({
    paths, database, reports, expertChats, sessions, defaultModel, market, version: 'test', openDirectory,
  })
  return { database, defaultModel, expertChats, market, openDirectory, paths, reports, service, sessions }
}

function completed(turn = 1): SessionEvent {
  return { type: 'turn/end', seq: SessionSeq(turn), time: Date.now(), data: { turn, reason: { kind: 'completed' } } }
}

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { assertion(); return } catch (error) { last = error }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw last
}

describe('HanaiService report lifecycle', () => {
  it('keeps existing frozen charts intact while new updates only merge time-series observations', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-28T18:00:00+08:00'))
    const f = fixture()
    const { database, market, service } = f
    const meta: ProviderMeta = { providerId: 'test', sourceName: '公开数据', sourceTimestamp: '2026-09-30', fetchedAt: new Date().toISOString(), cacheState: 'fresh' }
    const cap = { points: [{ date: '2026-09-30', floatCap: 500000 }], checkedMonths: ['202609'], complete: true, meta }
    const daily = { points: [{ date: '2026-10-27', assets: 400 }], expectedDays: 1, complete: true, meta: { ...meta, sourceTimestamp: '2026-10-27' } }
    const capital = vi.spyOn(market, 'getMacroCapital').mockResolvedValue(cap)
    const sizes = vi.spyOn(market, 'getMacroDaily').mockResolvedValue(daily)
    const prices = vi.spyOn(market, 'getMacroIndex').mockResolvedValue({ points: [{ date: '2026-10-28', close: 4083 }], meta: { ...meta, sourceTimestamp: '2026-10-28' } })
    const signal = new AbortController().signal
    try {
      const generatedAt = new Date().toISOString()
      const yesterday = { date: '2026-10-28', generatedAt, capital: cap, daily, index: await market.getMacroIndex(), etfs: null, allEtfs: null, allDaily: null,
        task: { state: 'partial', startedAt: generatedAt, finishedAt: generatedAt, availableAt: 0, panels: MACRO_GENERATION_PANELS.map(panel => ({ ...panel, state: 'completed', checked: 1, total: 1, missing: 0, error: null })) },
        meta: { ...meta, providerId: 'macro-generation', sourceName: '旧整图快照', sourceTimestamp: generatedAt, fetchedAt: generatedAt } }
      new MarketHistoryStore(database.sqlite).save('macro.chart', yesterday, yesterday.meta, yesterday.date)
      vi.advanceTimersByTime(24 * 3_600_000)
      capital.mockResolvedValue({ ...cap, points: [{ date: '2026-09-30', floatCap: 600000 }], meta: { ...meta, fetchedAt: new Date().toISOString() } })
      sizes.mockResolvedValue({ ...daily, points: [{ date: '2026-10-28', assets: 550 }], meta: { ...meta, sourceTimestamp: '2026-10-28', fetchedAt: new Date().toISOString() } })
      prices.mockResolvedValue({ points: [{ date: '2026-10-29', close: 4150 }], meta: { ...meta, sourceTimestamp: '2026-10-29', fetchedAt: new Date().toISOString() } })
      await service.call('market.macro.generate', {}, signal)
      await vi.waitFor(async () => expect((await service.call('market.macro.generation', {}, signal)).state).toBe('partial'))
      const today = (await service.call('market.macro.query', { range: { from: '2026-09-01', to: '2026-10-29' } }, signal)).data
      expect(today.daily?.points[0]?.assets).toBe(550)
      expect(today.capital?.points[0]?.floatCap).toBe(600000)
      expect(marketHistoryPanel(await service.call('market.history.get', { date: '2026-10-29' }, signal), 'macro.chart')).toBeNull()
      expect(marketHistoryPanel(await service.call('market.history.get', { date: '2026-10-28' }, signal), 'macro.chart')).toEqual(yesterday)
      capital.mockResolvedValue(null); sizes.mockResolvedValue(null); prices.mockResolvedValue(null)
      vi.advanceTimersByTime(61_000)
      await service.call('market.macro.generate', {}, signal)
      await vi.waitFor(async () => expect((await service.call('market.macro.generation', {}, signal)).state).toBe('failed'))
      expect((await service.call('market.macro.query', { range: { from: '2026-09-01', to: '2026-10-29' } }, signal)).data.daily).toEqual(today.daily)
      await service.call('cache.clear', { scope: 'market' }, signal)
      const reloaded = new HanaiService({ ...f, version: 'test' })
      expect(marketHistoryPanel(await reloaded.call('market.history.get', { date: '2026-10-28' }, signal), 'macro.chart')).toEqual(yesterday)
      reloaded.dispose()
    } finally { service.dispose(); database.close(); vi.useRealTimers() }
  })
  it('keeps macro work in the host after the caller disconnects and archives subsequent batches', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-28T10:00:00+08:00'))
    const { database, market, service } = fixture()
    const meta: ProviderMeta = { providerId: 'test', sourceName: '日频数据', sourceTimestamp: '2026-10-27', fetchedAt: new Date().toISOString(), cacheState: 'fresh' }
    const first = { points: [{ date: '2026-10-27', assets: 400 }], expectedDays: 2, complete: false, meta }
    let release!: (value: typeof first) => void
    const load = vi.spyOn(market, 'getMacroDaily').mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      .mockResolvedValue({ ...first, points: [{ date: '2026-10-26', assets: 390 }, ...first.points], complete: true, meta: { ...meta, fetchedAt: new Date(Date.now() + 1000).toISOString() } })
    const caller = new AbortController()
    const reader = new AbortController().signal
    try {
      expect((await service.call('market.macro.generate', {}, caller.signal)).state).toBe('running')
      caller.abort()
      await service.call('market.macro.generate', {}, reader)
      expect(load).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1000)
      release(first)
      await vi.waitFor(async () => expect((await service.call('market.macro.generation', {}, reader)).state).not.toBe('running'))
      expect(load).toHaveBeenCalledTimes(2)
      expect(load).toHaveBeenLastCalledWith(first, null, { from: '2021-10-27', to: '2026-10-27' })
      const saved = marketHistoryPanel(await service.call('market.history.get', { date: '2026-10-01' }, reader), 'macro.series')?.daily
      expect(saved?.points).toHaveLength(2)
      const count = load.mock.calls.length
      await service.call('market.macro.generation', {}, reader)
      expect(load).toHaveBeenCalledTimes(count)
    } finally { service.dispose(); database.close(); vi.useRealTimers() }
  })
  it('archives raw ETF inputs and daily totals together, resumes both and never erases them on failure or cache clearing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-28T10:00:00+08:00'))
    const { database, market, service } = fixture()
    const meta: ProviderMeta = { providerId: 'test', sourceName: '公开原始数据', sourceTimestamp: '2026-10-27', fetchedAt: new Date().toISOString(), cacheState: 'fresh' }
    const raw = { funds: MACRO_ETFS.map(fund => ({ code: fund.code, navFetchedAt: meta.fetchedAt, navs: [{ date: '2026-10-27', value: 4 }], shares: [{ date: '2026-10-27', value: 100000, fetchedAt: meta.fetchedAt }] })), meta }
    const total = { funds: MACRO_ETFS.map(fund => ({ code: fund.code, name: fund.name, listedOn: '2012-01-01' })), universeAsOf: '2026-10-28',
      points: [{ date: '2026-10-27', assets: 160, fourAssets: 160, otherAssets: 0 }], missingDates: [], expectedDays: 1, complete: true, meta }
    const load = vi.spyOn(market, 'getMacroAllDaily').mockResolvedValue(total)
    vi.spyOn(market, 'getMacroInputs').mockReturnValue(raw)
    const signal = new AbortController().signal
    try {
      await service.call('market.history.list', {}, signal)
      expect(load).not.toHaveBeenCalled()
      await service.call('market.macro.allDaily', { retryMissing: true }, signal)
      expect(load).toHaveBeenLastCalledWith(null, null, true)
      const snapshot = await service.call('market.history.get', { date: '2026-10-27' }, signal)
      expect(marketHistoryPanel(snapshot, 'macro.etf.inputs')).toEqual(raw)
      expect(marketHistoryPanel(snapshot, 'macro.etf.all.daily')).toEqual(total)
      load.mockResolvedValue(null)
      await service.call('market.macro.allDaily', {}, signal)
      expect(load).toHaveBeenLastCalledWith(total, raw, undefined)
      await service.call('cache.clear', { scope: 'market' }, signal)
      expect(await service.call('market.history.get', { date: '2026-10-27' }, signal)).toEqual(snapshot)
    } finally { database.close(); vi.useRealTimers() }
  })
  it('archives macro tradable caps by their report date, resumes saved months and never fetches them from history reads', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-28T10:00:00+08:00'))
    const { database, market, service } = fixture()
    const meta: ProviderMeta = { providerId: 'sse-statistics', sourceName: '上交所统计月报', sourceTimestamp: '2026-09-30', fetchedAt: new Date().toISOString(), cacheState: 'fresh' }
    const first = { points: [{ date: '2026-09-30', floatCap: 500000 }], checkedMonths: ['202609', '202610'], complete: false, meta }
    const load = vi.spyOn(market, 'getMacroCapital').mockResolvedValue(first)
    const signal = new AbortController().signal
    try {
      await service.call('market.history.list', {}, signal)
      expect(load).not.toHaveBeenCalled()
      await service.call('market.macro.capital', {}, signal)
      expect(load).toHaveBeenLastCalledWith(null, undefined)
      const snapshot = await service.call('market.history.get', { date: '2026-09-30' }, signal)
      expect(marketHistoryPanel(snapshot, 'macro.capital')).toEqual(first)
      expect(await service.call('market.history.get', { date: '2026-10-28' }, signal)).toBeNull()
      vi.advanceTimersByTime(1000)
      const next = { ...first, checkedMonths: ['202608', ...first.checkedMonths], meta: { ...meta, fetchedAt: new Date().toISOString() } }
      load.mockResolvedValue(next)
      await service.call('market.macro.capital', {}, signal)
      expect(load).toHaveBeenLastCalledWith(first, undefined)
      const saved = await service.call('market.history.get', { date: '2026-09-30' }, signal)
      expect(marketHistoryPanel(saved, 'macro.capital')).toEqual(next)
      load.mockResolvedValue(null)
      await service.call('market.macro.capital', {}, signal)
      await service.call('cache.clear', { scope: 'market' }, signal)
      expect(await service.call('market.history.get', { date: '2026-09-30' }, signal)).toEqual(saved)
    } finally { database.close(); vi.useRealTimers() }
  })
  it('persists composite cap provenance at the latest source date and reads it without reconstruction requests', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-29T10:00:00+08:00'))
    const { database, market, service } = fixture()
    const fetchedAt = new Date().toISOString()
    const officialMeta: ProviderMeta = { providerId: 'sse-statistics', sourceName: '上交所月报', sourceTimestamp: '2026-09-30', fetchedAt: '2026-10-28T02:00:00Z', cacheState: 'fresh' }
    const capital = { points: [{ date: '2026-09-30', floatCap: 500000 }], checkedMonths: ['202609'], complete: true, officialMeta,
      reference: { points: [{ date: '2026-10-28', floatCap: 487032.31, membershipDate: '2026-10-26' }], checkedDates: ['2026-10-28'], missingDates: [], expectedDays: 1, complete: true,
        meta: { ...officialMeta, providerId: 'baostock-eastmoney', sourceName: '重建参考', sourceTimestamp: '2026-10-28', fetchedAt } },
      meta: { ...officialMeta, providerId: 'macro-capital', sourceName: '月报＋重建参考', sourceTimestamp: '2026-10-28', fetchedAt } }
    const load = vi.spyOn(market, 'getMacroCapital').mockResolvedValue(capital)
    const signal = new AbortController().signal
    try {
      await service.call('market.macro.capital', { retryMissing: true }, signal)
      expect(load).toHaveBeenLastCalledWith(null, true)
      expect(await service.call('market.history.get', { date: '2026-09-30' }, signal)).toBeNull()
      await service.call('cache.clear', { scope: 'market' }, signal)
      expect(marketHistoryPanel(await service.call('market.history.get', { date: '2026-10-28' }, signal), 'macro.capital')).toEqual(capital)
      expect(load).toHaveBeenCalledOnce()
    } finally { service.dispose(); database.close(); vi.useRealTimers() }
  })
  it('persists incremental daily ETF history and passes saved progress back to the provider without changing its source date', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-28T10:00:00+08:00'))
    const { database, market, service } = fixture()
    const meta: ProviderMeta = { providerId: 'exchange-etf-nav', sourceName: '日份额×单位净值', sourceTimestamp: '2026-10-27', fetchedAt: new Date().toISOString(), cacheState: 'fresh' }
    const first = { points: [{ date: '2026-10-27', assets: 3403.3 }], expectedDays: 2, complete: false, meta }
    const load = vi.spyOn(market, 'getMacroDaily').mockResolvedValue(first)
    const signal = new AbortController().signal
    try {
      await service.call('market.macro.daily', {}, signal)
      expect(load).toHaveBeenLastCalledWith(null, null)
      expect(marketHistoryPanel(await service.call('market.history.get', { date: '2026-10-27' }, signal), 'macro.etf.daily')).toEqual(first)
      expect(await service.call('market.history.get', { date: '2026-10-28' }, signal)).toBeNull()
      vi.advanceTimersByTime(1000)
      const second = { ...first, complete: true, points: [{ date: '2026-10-26', assets: 3390.8 }, ...first.points], meta: { ...meta, fetchedAt: new Date().toISOString() } }
      load.mockResolvedValue(second)
      await service.call('market.macro.daily', {}, signal)
      expect(load).toHaveBeenLastCalledWith(first, null)
      const snapshot = await service.call('market.history.get', { date: '2026-10-27' }, signal)
      expect(marketHistoryPanel(snapshot, 'macro.etf.daily')).toEqual(second)
      load.mockResolvedValue(null)
      await service.call('market.macro.daily', {}, signal)
      await service.call('cache.clear', { scope: 'market' }, signal)
      expect(await service.call('market.history.get', { date: '2026-10-27' }, signal)).toEqual(snapshot)
    } finally { database.close(); vi.useRealTimers() }
  })
  it('archives macro series independently by their source dates and retains them after failure and cache clearing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-27T18:00:00+08:00'))
    const { database, market, service } = fixture()
    const meta: ProviderMeta = { providerId: 'eastmoney-fund', sourceName: '基金季报', sourceTimestamp: '2026-09-30', fetchedAt: new Date().toISOString(), cacheState: 'fresh' }
    const etfs = { funds: MACRO_ETFS.map(fund => ({ code: fund.code, points: [{ date: '2026-09-30', assets: 100 }] })), meta }
    const allEtfs = { ...etfs, universeAsOf: '2026-10-27', funds: etfs.funds.map(fund => ({ ...fund, name: fund.code, inceptionDate: '2013-01-01' })) }
    const index = { points: [{ date: '2026-10-26', close: 4000 }], meta: { ...meta, sourceTimestamp: '2026-10-26' } }
    const funds = vi.spyOn(market, 'getMacroEtfs').mockResolvedValue(etfs)
    const allFunds = vi.spyOn(market, 'getMacroAllEtfs').mockResolvedValue(allEtfs)
    const prices = vi.spyOn(market, 'getMacroIndex').mockResolvedValue(index)
    const dashboard = vi.spyOn(market, 'getDashboard')
    const signal = new AbortController().signal
    try {
      await service.call('market.macro.etf', {}, signal)
      await service.call('market.macro.all', {}, signal)
      await service.call('market.macro.index', {}, signal)
      const quarter = await service.call('market.history.get', { date: '2026-09-30' }, signal)
      const day = await service.call('market.history.get', { date: '2026-10-26' }, signal)
      expect(marketHistoryPanel(quarter, 'macro.etf')).toEqual(etfs)
      expect(marketHistoryPanel(quarter, 'macro.etf.all.quarter')).toEqual(allEtfs)
      expect(marketHistoryPanel(day, 'macro.index')).toEqual(index)
      expect(await service.call('market.history.get', { date: '2026-10-27' }, signal)).toBeNull()
      funds.mockResolvedValue(null)
      allFunds.mockResolvedValue(null)
      prices.mockResolvedValue({ ...index, meta: { ...index.meta, cacheState: 'stale' } })
      await service.call('market.macro.etf', {}, signal)
      await service.call('market.macro.all', {}, signal)
      await service.call('market.macro.index', {}, signal)
      await service.call('cache.clear', { scope: 'market' }, signal)
      expect(await service.call('market.history.get', { date: '2026-09-30' }, signal)).toEqual(quarter)
      expect(await service.call('market.history.get', { date: '2026-10-26' }, signal)).toEqual(day)
      expect(dashboard).not.toHaveBeenCalled()
    } finally { database.close(); vi.useRealTimers() }
  })
  it('archives intraday and news independently by source day and preserves them after failed retries', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-27T18:00:00+08:00'))
    const { database, market, service } = fixture()
    const meta: ProviderMeta = { providerId: 'test', sourceName: '分时', sourceTimestamp: '2026-10-26T07:00:00Z', fetchedAt: '2026-10-27T10:00:00Z', cacheState: 'fresh' }
    const trend = { date: '2026-10-26', points: [{ time: '15:00', price: 3500, avgPrice: null, volume: 0 }], prevClose: 3600, meta }
    const news = { date: trend.date, signals: [], meta: { ...meta, sourceTimestamp: trend.date } }
    const prices = vi.spyOn(market, 'getMarketIntraday').mockResolvedValue(trend)
    const signals = vi.spyOn(market, 'getMarketSignals').mockResolvedValue(news)
    const dashboard = vi.spyOn(market, 'getDashboard')
    const signal = new AbortController().signal
    try {
      await service.call('market.intraday', {}, signal)
      let snapshot = await service.call('market.history.get', { date: trend.date }, signal)
      expect(marketHistoryPanel(snapshot, 'intraday')).toEqual(trend)
      expect(marketHistoryPanel(snapshot, 'signals')).toBeNull()
      await service.call('market.signals', {}, signal)
      snapshot = await service.call('market.history.get', { date: trend.date }, signal)
      expect(marketHistoryPanel(snapshot, 'signals')).toEqual(news)
      prices.mockResolvedValue(null)
      signals.mockResolvedValue({ ...news, meta: { ...news.meta, cacheState: 'stale' } })
      await service.call('market.intraday', {}, signal)
      await service.call('market.signals', {}, signal)
      expect(await service.call('market.history.get', { date: trend.date }, signal)).toEqual(snapshot)
      expect(await service.call('market.history.get', { date: '2026-10-27' }, signal)).toBeNull()
      expect(dashboard).not.toHaveBeenCalled()
    } finally { database.close(); vi.useRealTimers() }
  })
  it('archives the independent ladder by its source date and preserves it on a failed retry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-30T18:00:00+08:00'))
    const { database, market, service } = fixture()
    const meta: ProviderMeta = { providerId: 'ths-limit-reason', sourceName: '同花顺涨停池', sourceTimestamp: '2026-10-29', fetchedAt: '2026-10-30T08:00:00Z', cacheState: 'fresh' }
    const data = { date: '2026-10-29', stocks: [], promotion: null, broken: null, issues: [], meta }
    const fetch = vi.fn().mockResolvedValue(data)
    market.getMarketLadder = fetch
    const signal = new AbortController().signal
    try {
      await service.call('market.ladder', {}, signal)
      const saved = await service.call('market.history.get', { date: data.date }, signal)
      expect(marketHistoryPanel(saved, 'ladder')).toEqual(data)
      expect(await service.call('market.history.get', { date: '2026-10-30' }, signal)).toBeNull()
      fetch.mockResolvedValue({ ...data, meta: { ...meta, cacheState: 'stale' } })
      await service.call('market.ladder', {}, signal)
      expect(await service.call('market.history.get', { date: data.date }, signal)).toEqual(saved)
    } finally { database.close(); vi.useRealTimers() }
  })
  it('archives independent overseas indices by observation date without rewriting their market dates', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-27T14:00:00+08:00'))
    const { database, market, service } = fixture()
    const meta: ProviderMeta = { providerId: 'global-indices', sourceName: '海外指数汇总', sourceTimestamp: null, fetchedAt: new Date().toISOString(), cacheState: 'fresh' }
    const data = { meta, indices: GLOBAL_INDICES.map(item => ({ code: item.code, name: item.name, price: 100, change: 0, changePct: 0, amount: null, upCount: null, downCount: null, flatCount: null,
      marketDate: item.code === 'IXIC' ? '2026-10-26' : '2026-10-27', meta: { ...meta, sourceTimestamp: item.code === 'IXIC' ? '2026-10-26T20:00:00Z' : '2026-10-27T05:59:00Z' } })) }
    const fetchIndices = vi.spyOn(market, 'getGlobalIndices').mockResolvedValue(data)
    const dashboard = vi.spyOn(market, 'getDashboard')
    const signal = new AbortController().signal
    try {
      expect(await service.call('market.indices', {}, signal)).toEqual(data)
      expect(fetchIndices).toHaveBeenCalledWith(false)
      expect(dashboard).not.toHaveBeenCalled()
      const record = await service.call('market.history.get', { date: '2026-10-27' }, signal)
      expect(marketHistoryPanel(record, 'global.indices')).toEqual(data)
      expect(await service.call('market.history.get', { date: '2026-10-26' }, signal)).toBeNull()
      vi.setSystemTime(new Date('2026-10-28T00:01:00+08:00'))
      vi.spyOn(market, 'getGlobalIndices').mockResolvedValue({ ...data, meta: { ...meta, cacheState: 'cached' } })
      const cached = await service.call('market.indices', {}, signal)
      expect(cached.meta.cacheState).toBe('cached')
      expect(cached.meta.fetchedAt).toBe(meta.fetchedAt)
      expect(fetchIndices).toHaveBeenCalledTimes(1)
      expect(await service.call('market.history.get', { date: '2026-10-28' }, signal)).toBeNull()
    } finally { database.close(); vi.useRealTimers() }
  })
  it('requests only memory cache for overseas indices when resting without an archive', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-28T00:01:00+08:00'))
    const { database, market, service } = fixture()
    const fetchIndices = vi.spyOn(market, 'getGlobalIndices')
    try {
      await service.call('market.indices', {}, new AbortController().signal)
      expect(fetchIndices).toHaveBeenCalledWith(true)
    } finally { database.close(); vi.useRealTimers() }
  })
  it('never rebinds undated boards, ranks or sector caches to a different market day', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-27T10:00:00+08:00'))
    const { database, market, service } = fixture()
    const quoteMeta: ProviderMeta = { providerId: 'tencent', sourceName: '腾讯', sourceTimestamp: '2026-10-26T15:00:00+08:00', fetchedAt: new Date().toISOString(), cacheState: 'stale' }
    const boardMeta: ProviderMeta = { providerId: 'sina', sourceName: '新浪', sourceTimestamp: null, fetchedAt: new Date().toISOString(), cacheState: 'fresh' }
    const data: DashboardData = {
      overview: { indices: [{ code: '000001', name: '上证', price: 100, change: 0, changePct: 0, amount: 10, upCount: null, downCount: null, flatCount: null }],
        breadth: { up: null, down: null, flat: null, limitUp: null, limitDown: null, totalAmount: null }, meta: quoteMeta, marketStatus: 'trading' },
      industry: { type: 'industry', sectors: [], meta: boardMeta }, concept: { type: 'concept', sectors: [], meta: boardMeta },
      ranks: { gainers: [], losers: [], amount: [], turnover: [] },
      rankSources: { gainers: boardMeta, losers: boardMeta, amount: boardMeta, turnover: boardMeta },
    }
    vi.spyOn(market, 'getDashboard').mockImplementation(async () => data)
    vi.spyOn(market, 'getSectorStocks').mockResolvedValue({ stocks: [], meta: boardMeta })
    const signal = new AbortController().signal
    try {
      await service.call('dashboard.get', {}, signal)
      await service.call('sector.stocks', { sectorCode: 'SINA:new_blhy' }, signal)
      expect((await service.call('market.history.get', { date: '2026-10-26' }, signal))?.panels).toEqual(['overview'])
      expect(await service.call('market.history.get', { date: '2026-10-27' }, signal)).toBeNull()
      quoteMeta.sourceTimestamp = '2026-10-27T09:25:00+08:00'
      quoteMeta.cacheState = 'fresh'
      boardMeta.cacheState = 'cached'
      for (const fetchedAt of ['2026-10-26T23:59:59+08:00', '2026-10-27T09:24:59+08:00']) {
        boardMeta.fetchedAt = fetchedAt
        await service.call('dashboard.get', {}, signal)
        await service.call('sector.stocks', { sectorCode: 'SINA:new_blhy' }, signal)
        expect((await service.call('market.history.get', { date: '2026-10-27' }, signal))?.panels).toEqual(['overview'])
      }
      boardMeta.cacheState = 'fresh'
      boardMeta.fetchedAt = new Date().toISOString()
      await service.call('dashboard.get', {}, signal)
      await service.call('sector.stocks', { sectorCode: 'SINA:new_blhy' }, signal)
      const saved = await service.call('market.history.get', { date: '2026-10-27' }, signal)
      expect(saved?.panels).toEqual(expect.arrayContaining(['industry', 'concept', 'rank.gainers', 'rank.losers', 'rank.amount', 'rank.turnover', 'sector:SINA:new_blhy']))
      quoteMeta.cacheState = 'unavailable'
      data.overview.indices = []
      vi.advanceTimersByTime(60_000)
      boardMeta.fetchedAt = new Date().toISOString()
      await service.call('dashboard.get', {}, signal)
      await service.call('sector.stocks', { sectorCode: 'SINA:new_blhy' }, signal)
      expect(await service.call('market.history.get', { date: '2026-10-27' }, signal)).toEqual(saved)
    } finally { database.close(); vi.useRealTimers() }
  })

  it('archives all market panels on ordinary reads, preserving source dates, independent breadth and sector drills', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-26T16:00:00+08:00'))
    const { database, market, service } = fixture()
    const meta: ProviderMeta = { providerId: 'fake', sourceName: '测试', sourceTimestamp: '2026-10-26T15:00:00+08:00', fetchedAt: new Date().toISOString(), cacheState: 'stale' }
    const summaryMeta = { ...meta, sourceTimestamp: null, cacheState: 'fresh' as const }
    const data: DashboardData = {
      overview: { indices: [{ code: '000001', name: '上证指数', price: 3500, change: 0, changePct: 0, amount: 100, upCount: null, downCount: null, flatCount: null }],
        breadth: { up: null, down: null, flat: null, limitUp: null, limitDown: null, totalAmount: 100 }, meta, marketStatus: 'closed' },
      industry: { type: 'industry', sectors: [], meta: summaryMeta }, concept: { type: 'concept', sectors: [], meta: summaryMeta },
      ranks: { gainers: [], losers: [], amount: [], turnover: [] },
      rankSources: { gainers: summaryMeta, losers: summaryMeta, amount: summaryMeta, turnover: summaryMeta },
    }
    const width = { up: 100, down: 200, flat: 3, limitUp: 4, limitDown: 5, qdate: '2026-10-26', meta }
    const dashboardRead = vi.spyOn(market, 'getDashboard').mockResolvedValue(data)
    const breadthRead = vi.spyOn(market, 'getMarketBreadth').mockResolvedValue(width)
    const sectorRead = vi.spyOn(market, 'getSectorStocks').mockResolvedValue({ stocks: [], meta: summaryMeta })
    const signal = new AbortController().signal
    try {
      await service.call('market.breadth', {}, signal)
      await service.call('dashboard.get', { refresh: false }, signal)
      await service.call('sector.stocks', { sectorCode: 'SINA:new_blhy' }, signal)
      const store = new MarketHistoryStore(database.sqlite)
      store.save('macro.index', { points: [{ date: '2026-10-01', close: 4000 }], meta: summaryMeta }, summaryMeta, '2026-10-01')
      store.save('macro.index', { points: [{ date: '2026-10-26', close: 4000 }], meta: summaryMeta }, summaryMeta, '2026-10-26')
      const snapshot = await service.call('market.history.get', { date: '2026-10-26' }, signal)
      expect(snapshot?.panels).toEqual(expect.arrayContaining([...MARKET_HISTORY_PANELS.filter(key => !key.startsWith('macro.') && !['global.indices', 'intraday', 'signals', 'arms', 'distribution', 'ladder'].includes(key)), 'sector:SINA:new_blhy']))
      expect(marketHistoryPanel(snapshot, 'overview')).toMatchObject({ indices: [{ ...data.overview.indices[0], meta }], meta })
      expect(marketHistoryPanel(snapshot, 'breadth')).toEqual(width)
      expect(marketHistoryPanel(snapshot, 'industry')).toEqual(data.industry)
      expect(await service.call('market.history.get', { date: '2026-10-27' }, signal)).toBeNull()
      await service.call('cache.clear', { scope: 'market' }, signal)
      const dates = await service.call('market.history.list', {}, signal)
      expect(dates.snapshots.map(row => row.date)).toEqual(['2026-10-26'])
      expect(dates.snapshots[0]?.panels.some(key => key.startsWith('macro.'))).toBe(false)
      expect(marketHistoryPanel(store.get('2026-10-01'), 'macro.index')).not.toBeNull()
      expect(await service.call('market.history.get', { date: '2026-10-26' }, signal)).toEqual(snapshot)
      expect(dashboardRead).toHaveBeenCalledTimes(1)
      expect(breadthRead).toHaveBeenCalledTimes(1)
      expect(sectorRead).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(60_000)
      const failed = { ...meta, cacheState: 'unavailable' as const, fetchedAt: new Date().toISOString() }
      dashboardRead.mockResolvedValue({ ...data, overview: { ...data.overview, indices: [], meta: failed },
        industry: { ...data.industry, meta: failed }, concept: { ...data.concept, meta: failed },
        rankSources: { gainers: failed, losers: failed, amount: failed, turnover: failed } })
      await service.call('dashboard.get', { refresh: true }, signal)
      expect(await service.call('market.history.get', { date: '2026-10-26' }, signal)).toEqual(snapshot)
    } finally { database.close(); vi.useRealTimers() }
  })

  it('archives the arms snapshot by its market date and does not overwrite it on failure', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-26T15:06:00+08:00'))
    const { database, market, service } = fixture()
    const meta = { providerId: '88ai-arms', sourceName: '88AI', sourceTimestamp: '2026-10-26T07:00:00.000Z', fetchedAt: new Date().toISOString(), cacheState: 'fresh' as const }
    const arms = { meta, point: { date: '2026-10-26', time: '15:00', upCount: 100, downCount: 200, flatCount: 3, upAmount: 300, downAmount: 200, trin: 1 / 3, adRatio: 0.5, amountRatio: 1.5, estimated: false } }
    market.getMarketArms = vi.fn().mockResolvedValueOnce(arms).mockResolvedValueOnce(null)
    try {
      const signal = new AbortController().signal
      await service.call('market.arms', {}, signal)
      await service.call('market.arms', {}, signal)
      const snapshot = await service.call('market.history.get', { date: '2026-10-26' }, signal)
      expect(marketHistoryPanel(snapshot, 'arms')).toEqual(arms)
    } finally { database.close(); vi.useRealTimers() }
  })

  it('archives undated distribution only after confirming the market date and preserves it on failure', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-30T16:00:00+08:00'))
    const { database, market, service } = fixture()
    const meta: ProviderMeta = { providerId: 'sina-distribution', sourceName: '新浪涨跌分布', sourceTimestamp: null, fetchedAt: new Date().toISOString(), cacheState: 'fresh' }
    const data = { total: 9, counts: { down10: 1, down5: 1, down2: 1, down0: 1, flat: 1, up0: 1, up2: 1, up5: 1, up10: 1 }, meta }
    const read = vi.fn().mockResolvedValue(data)
    market.getMarketDistribution = read
    const overviewMeta = { ...meta, sourceTimestamp: '2026-10-30T15:00:00+08:00' }
    market.getDashboard = vi.fn().mockResolvedValue({
      overview: { indices: [{ code: '000001', name: '上证', price: 3500, change: 0, changePct: 0, amount: 10, upCount: null, downCount: null, flatCount: null }], breadth: { totalAmount: 10 }, marketStatus: 'closed', meta: overviewMeta },
      industry: { type: 'industry', sectors: [], meta }, concept: { type: 'concept', sectors: [], meta }, ranks: { gainers: [], losers: [], amount: [], turnover: [] },
    })
    const signal = new AbortController().signal
    try {
      await service.call('market.distribution', {}, signal)
      expect(marketHistoryPanel(await service.call('market.history.get', { date: '2026-10-30' }, signal), 'distribution')).toBeNull()
      await service.call('dashboard.get', {}, signal)
      await service.call('market.distribution', {}, signal)
      const saved = marketHistoryPanel(await service.call('market.history.get', { date: '2026-10-30' }, signal), 'distribution')
      expect(saved).toEqual(data)
      read.mockResolvedValue(null)
      await service.call('market.distribution', {}, signal)
      expect(marketHistoryPanel(await service.call('market.history.get', { date: '2026-10-30' }, signal), 'distribution')).toEqual(saved)
    } finally { database.close(); vi.useRealTimers() }
  })

  it('serves independent breadth without running the dashboard and preserves both source records', async () => {
    const { database, market, service } = fixture()
    const quoteMeta: ProviderMeta = { providerId: 'tencent', sourceName: '腾讯行情', sourceTimestamp: null,
      fetchedAt: '2026-10-27T06:40:00.000Z', cacheState: 'fresh' }
    const width = { up: 100, down: 200, flat: 3, limitUp: 4, limitDown: 5, qdate: '2026-10-27',
      meta: { ...quoteMeta, providerId: 'legu-breadth', sourceName: '乐咕乐股（AKShare 同源）' } }
    database.setSetting('market.latestSuccess.sources', JSON.stringify([quoteMeta]))
    const dashboard = vi.spyOn(market, 'getDashboard')
    vi.spyOn(market, 'getMarketBreadth').mockResolvedValue(width)
    try {
      expect(await service.call('market.breadth', {}, new AbortController().signal)).toEqual(width)
      expect(dashboard).not.toHaveBeenCalled()
      const diagnostics = await service.call('diagnostics.get', {}, new AbortController().signal)
      expect(diagnostics.marketSources).toEqual([quoteMeta, width.meta])
      expect(diagnostics.latestMarketSuccess).toBe(width.meta.fetchedAt)
    } finally { database.close() }
  })

  it('keeps screening sessions, universe snapshots and deletion separate from research and experts', async () => {
    const { database, paths, service, sessions } = fixture()
    const signal = new AbortController().signal
    try {
      database.sqlite.prepare('INSERT INTO security_master VALUES (?, ?, ?, ?, ?, ?, ?)').run('1.600000', '600000', '浦发银行', 'SH', 'pufayinhang', 'pfyh', '2026-10-30T07:00:00Z')
      const research = await service.call('research-chat.create', {}, signal)
      const expert = await service.call('expert-chat.create', { masterId: 'sun-yuchen-perspective' }, signal)
      const chat = await service.call('screener.create', { openingMessage: '低估值银行股', model: { provider: 'test', model: 'screen-model' } }, signal)
      expect(chat).toMatchObject({ masterId: 'ai-stock-screener', masterName: 'AI选股', title: '低估值银行股', model: 'screen-model', turnStatus: 'queued' })
      expect(sessions.prompts.at(-1)?.text).toBe('低估值银行股')
      expect(await service.call('screener.list', {}, signal)).toEqual([chat])
      expect(await service.call('research-chat.list', {}, signal)).toEqual([research])
      expect(await service.call('expert-chat.list', {}, signal)).toEqual([expert])
      const workspace = join(paths.expertChatsDir, chat.id, 'workspace')
      expect(JSON.parse(readFileSync(join(workspace, 'candidate-universe.json'), 'utf8')).securities).toEqual(database.screeningUniverse())
      expect(database.screeningUniverse()).toEqual([{ secId: '1.600000', code: '600000', name: '浦发银行', exchange: 'SH', updatedAt: '2026-10-30T07:00:00Z' }])
      expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf8')).toContain('当前会话：AI选股')
      for (const endpoint of ['research-chat.get', 'research-chat.remove', 'expert-chat.get', 'expert-chat.remove'] as const) await expect(service.call(endpoint, { id: chat.id }, signal)).rejects.toThrow('不存在')
      await expect(service.call('research-chat.upload', { id: chat.id, name: 'x.txt', data: 'eA==' }, signal)).rejects.toThrow('不存在')
      await expect(service.call('screener.rename', { id: research.id, title: 'x' }, signal)).rejects.toThrow('不存在')
      await expect(service.call('screener.get', { id: expert.id }, signal)).rejects.toThrow('不存在')
      expect((await service.call('screener.rename', { id: chat.id, title: '新条件' }, signal)).title).toBe('新条件')
      sessions.running = true
      await expect(service.call('screener.remove', { id: chat.id }, signal)).rejects.toThrow('正在回答')
      sessions.running = false
      expect(await service.call('screener.remove', { id: chat.id }, signal)).toEqual([])
      expect(existsSync(workspace)).toBe(false)
      expect(database.getExpertChat(research.id)).not.toBeNull()
      expect(database.getExpertChat(expert.id)).not.toBeNull()
    } finally { database.close() }
  })
  it('turns a completed DSH screening plan into a frozen source-backed result and blocks deletion while scanning', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T10:00:00+08:00'))
    const { database, service, market, paths } = fixture()
    const signal = new AbortController().signal
    let release: (value: import('../../contracts/src/market-scan.ts').MarketScanData) => void = () => {}
    let requested: import('../../contracts/src/market-scan.ts').MarketScanQuery | undefined
    market.getMarketScan = vi.fn(query => { requested = query; return new Promise<import('../../contracts/src/market-scan.ts').MarketScanData>(resolve => { release = resolve }) })
    try {
      const question = '市值100亿元以上，ROE不低于15%'
      const chat = await service.call('screener.create', { openingMessage: question }, signal)
      expect((await service.call('screener.result', { id: chat.id }, signal))?.status).toBe('parsing')
      writeFileSync(join(paths.expertChatsDir, chat.id, 'workspace', 'screening-plan.json'), JSON.stringify({ question, interpretation: '按市值和ROE查询', query: { search: '', page: 1, ranges: { marketCap: { min: 100 }, roe: { min: 15 } }, sort: 'marketCap', order: 'desc' }, assumptions: [], unsupported: [] }))
      service.handleSessionEvent(chat.dshSessionId!, completed())
      await expect(service.call('screener.remove', { id: chat.id }, signal)).rejects.toThrow('扫描正在进行')
      release({ query: requested!, total: 0, stocks: [], snapshotDate: '2026-10-30', collectedOn: '2026-10-30', meta: { providerId: 'fake', sourceName: 'test', sourceTimestamp: '2026-10-30', fetchedAt: new Date().toISOString(), cacheState: 'fresh' } })
      await vi.advanceTimersByTimeAsync(1)
      const result = await service.call('screener.result', { id: chat.id }, signal)
      expect(result?.status).toBe('ready'); expect(result?.result?.data?.query.ranges).toEqual({ roe: { min: 15 }, marketCap: { min: 100 } })
      expect(market.getMarketScan).toHaveBeenCalledTimes(1)
      await service.call('screener.remove', { id: chat.id }, signal)
      expect(database.getSetting(`ai-screener.run.${chat.id}`)).toBeNull()
    } finally { database.close(); vi.useRealTimers() }
  })
  it('marks a screening task interrupted before session binding as failed instead of polling forever', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T10:00:00+08:00'))
    const { database, service } = fixture()
    try {
      const chat = database.createExpertChat({ id: 'unbound-screen', title: '解析中断', masterId: 'ai-stock-screener', masterName: 'AI选股', masterVersion: '1' })
      database.setSetting(`ai-screener.run.${chat.id}`, JSON.stringify({ question: 'ROE不低于15%', status: 'parsing', plan: null, result: null, error: null, startedAt: new Date().toISOString(), finishedAt: null }))
      await service.recover()
      const run = await service.call('screener.result', { id: chat.id }, new AbortController().signal)
      expect(run?.status).toBe('failed'); expect(run?.error).toContain('会话绑定前中断')
    } finally { database.close(); vi.useRealTimers() }
  })
  it('retains a failed screening query in its own history when model creation fails', async () => {
    const { database, service, sessions } = fixture()
    const signal = new AbortController().signal
    try {
      vi.spyOn(sessions, 'create').mockRejectedValueOnce(new Error('model unavailable'))
      await expect(service.call('screener.create', { openingMessage: '高分红银行股' }, signal)).rejects.toThrow('model unavailable')
      const saved = await service.call('screener.list', {}, signal)
      expect(saved).toHaveLength(1)
      expect(saved[0]).toMatchObject({ title: '高分红银行股', turnStatus: 'failed', errorCode: 'screener-chat-start-failed' })
      expect(await service.call('research-chat.list', {}, signal)).toEqual([])
      expect(await service.call('expert-chat.list', {}, signal)).toEqual([])
    } finally { database.close() }
  })
  it('creates an independent research assistant, scopes its endpoints, persists attachments, and removes its workspace', async () => {
    const { database, paths, service, sessions } = fixture()
    const signal = new AbortController().signal
    try {
      const chat = await service.call('research-chat.create', { openingMessage: '研究存储产业链', model: { provider: 'test', model: 'research-model' } }, signal)
      expect(chat).toMatchObject({ masterId: 'ai-research-assistant', masterName: 'AI研究助手', title: '研究存储产业链', model: 'research-model', turnStatus: 'queued' })
      expect(sessions.prompts.at(-1)?.text).toBe('研究存储产业链')
      expect(await service.call('research-chat.list', {}, signal)).toEqual([chat])
      expect(await service.call('expert-chat.list', {}, signal)).toEqual([])
      expect((await service.call('bootstrap', {}, signal)).expertChats).toEqual([])
      await expect(service.call('expert-chat.get', { id: chat.id }, signal)).rejects.toThrow('不存在')
      const expert = await service.call('expert-chat.create', { masterId: 'sun-yuchen-perspective' }, signal)
      await expect(service.call('research-chat.get', { id: expert.id }, signal)).rejects.toThrow('不存在')
      await expect(service.call('research-chat.upload', { id: expert.id, name: 'x.txt', data: 'eA==' }, signal)).rejects.toThrow('不存在')
      await expect(service.call('research-chat.rename', { id: expert.id, title: '不能跨类型改名' }, signal)).rejects.toThrow('不存在')
      const workspace = join(paths.expertChatsDir, chat.id, 'workspace')
      expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf8')).toContain('AI研究助手')
      expect(JSON.parse(readFileSync(join(workspace, 'market-context.json'), 'utf8'))).toBeNull()
      const file = await service.call('research-chat.upload', { id: chat.id, name: '公告.txt', data: Buffer.from('公告原文').toString('base64') }, signal)
      expect(readFileSync(join(workspace, file.path), 'utf8')).toBe('公告原文')
      const renamed = await service.call('research-chat.rename', { id: chat.id, title: '新的研究标题' }, signal)
      expect(renamed.title).toBe('新的研究标题')
      sessions.running = true
      await expect(service.call('research-chat.remove', { id: chat.id }, signal)).rejects.toThrow('正在回答')
      sessions.running = false
      expect(await service.call('research-chat.remove', { id: chat.id }, signal)).toEqual([])
      expect(existsSync(workspace)).toBe(false)
      expect(database.getExpertChat(expert.id)).not.toBeNull()
    } finally { database.close() }
  })
  it('creates a stock-independent expert chat, tracks DSH turns, and removes its workspace safely', async () => {
    const { database, paths, service, sessions } = fixture()
    const created = await service.call('expert-chat.create', {
      masterId: 'sun-yuchen-perspective',
      openingMessage: '“永远缺存储”要看哪些供需信号？',
    }, new AbortController().signal)

    expect(created).toMatchObject({
      masterId: 'sun-yuchen-perspective',
      masterName: '孙宇晨',
      title: '“永远缺存储”要看哪些供需信号？',
      turnStatus: 'queued',
    })
    expect(created.dshSessionId).toBe(`hanai-chat-${created.id}`)
    expect(sessions.prompts).toEqual([{
      sessionId: created.dshSessionId,
      text: '“永远缺存储”要看哪些供需信号？',
    }])
    const workspace = join(paths.expertChatsDir, created.id, 'workspace')
    expect(existsSync(join(workspace, '.agents', 'skills', 'sun-yuchen-perspective', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(workspace, 'REPORT.md'))).toBe(false)
    expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf8')).toContain('专家开放对谈工作区')

    service.handleSessionEvent(created.dshSessionId!, {
      type: 'turn/start', seq: SessionSeq(1), time: Date.now(), data: { turn: 1 },
    })
    expect(database.getExpertChat(created.id)?.turnStatus).toBe('running')
    service.handleSessionEvent(created.dshSessionId!, completed())
    expect(database.getExpertChat(created.id)).toMatchObject({
      turnStatus: 'idle', errorCode: null, errorMessage: null,
    })

    await expect(service.call('expert-chat.remove', {
      id: created.id,
    }, new AbortController().signal)).resolves.toEqual([])
    expect(sessions.archived).toEqual([created.dshSessionId])
    expect(database.getExpertChat(created.id)).toBeNull()
    expect(existsSync(join(paths.expertChatsDir, created.id))).toBe(false)
    database.close()
  })

  it('creates a blank expert chat without injecting a synthetic user message', async () => {
    const { database, service, sessions } = fixture()
    const created = await service.call('expert-chat.create', {
      masterId: 'munger-perspective',
    }, new AbortController().signal)

    expect(created).toMatchObject({ title: '与查理·芒格开放对谈', turnStatus: 'idle' })
    expect(sessions.prompts).toEqual([])
    database.close()
  })

  it('enforces chat-only expert capability at the Host boundary', async () => {
    const { database, market, service } = fixture()
    const stockLookup = vi.spyOn(market, 'getStockDetail')
    await expect(service.call('judgement.create', {
      secId: '1.600519', masterId: 'sun-yuchen-perspective',
    }, new AbortController().signal)).rejects.toThrow('仅支持开放对谈')
    expect(stockLookup).not.toHaveBeenCalled()
    expect(database.listJudgements()).toEqual([])
    database.close()
  })

  it('starts Sanhu Yi in both research and open-chat modes with its own complete Skill snapshot', async () => {
    const { database, paths, service, sessions } = fixture()
    const signal = new AbortController().signal
    const masterId = 'sanhu-yi-perspective'
    const judgement = await service.call('judgement.create', {
      secId: '1.600519', masterId,
    }, signal)
    const chat = await service.call('expert-chat.create', { masterId }, signal)

    expect(judgement).toMatchObject({ masterId, masterName: '散户乙', reportStatus: 'generating' })
    expect(chat).toMatchObject({ masterId, masterName: '散户乙', turnStatus: 'idle' })
    expect(chat.dshSessionId).not.toBe(judgement.dshSessionId)
    expect(sessions.prompts).toHaveLength(1)
    expect(sessions.prompts[0]!.sessionId).toBe(judgement.dshSessionId)
    for (const workspace of [
      join(paths.judgementsDir, judgement.id, 'workspace'),
      join(paths.expertChatsDir, chat.id, 'workspace'),
    ]) {
      const skillRoot = join(workspace, '.agents', 'skills', masterId)
      expect(readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')).toContain('name: sanhu-yi-perspective')
      expect(readFileSync(join(skillRoot, 'references', 'provenance.md'), 'utf8')).toContain('493')
      expect(readFileSync(join(skillRoot, 'references', 'valuation-worked-example.md'), 'utf8')).toContain('ROE')
    }
    const chatWorkspace = join(paths.expertChatsDir, chat.id, 'workspace')
    expect(readFileSync(join(chatWorkspace, 'AGENTS.md'), 'utf8')).toContain('不代表散户乙本人观点')
    expect(existsSync(join(chatWorkspace, 'REPORT.md'))).toBe(false)
    database.close()
  })

  it('runs Dong Taishan in both modes and seals the research report without leaking it into open chat', async () => {
    const { database, paths, reports, service, sessions } = fixture()
    const signal = new AbortController().signal
    const masterId = 'dong-taishan-perspective'
    const openingMessage = '估值便宜和产业拐点怎样分开判断？'
    const judgement = await service.call('judgement.create', { secId: '1.600519', masterId }, signal)
    const chat = await service.call('expert-chat.create', { masterId, openingMessage }, signal)

    expect(judgement).toMatchObject({ masterId, masterName: '东泰山', masterVersion: '2026.10.01-v6', reportStatus: 'generating' })
    expect(chat).toMatchObject({ masterId, masterName: '东泰山', masterVersion: '2026.10.01-v6', turnStatus: 'queued' })
    expect(chat.dshSessionId).not.toBe(judgement.dshSessionId)
    expect(sessions.prompts).toEqual([
      { sessionId: judgement.dshSessionId, text: expect.stringContaining('以东泰山大师的方法论') },
      { sessionId: chat.dshSessionId, text: openingMessage },
    ])
    for (const workspace of [
      join(paths.judgementsDir, judgement.id, 'workspace'),
      join(paths.expertChatsDir, chat.id, 'workspace'),
    ]) {
      const skillRoot = join(workspace, '.agents', 'skills', masterId)
      expect(readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')).toContain('name: dong-taishan-perspective')
      expect(readFileSync(join(skillRoot, 'references', 'source-manifest.md'), 'utf8')).toContain('P22')
    }
    const chatWorkspace = join(paths.expertChatsDir, chat.id, 'workspace')
    expect(readFileSync(join(chatWorkspace, 'AGENTS.md'), 'utf8')).toContain('不代表本人当前观点')
    const report = `# 东泰山研判\n\n${'估值位置与产业位置分别判断，盈利质量需核验，列出反证与下一次验证条件。'.repeat(8)}`
    writeFileSync(reports.workingReportPath(judgement.id), report)
    service.handleSessionEvent(judgement.dshSessionId!, completed())
    service.handleSessionEvent(chat.dshSessionId!, completed())
    await eventually(() => expect(database.getJudgement(judgement.id)?.reportStatus).toBe('ready'))
    expect(database.listReportRows(judgement.id)).toHaveLength(1)
    expect(database.getExpertChat(chat.id)?.turnStatus).toBe('idle')
    expect(existsSync(join(chatWorkspace, 'REPORT.md'))).toBe(false)
    database.close()
  })

  it('deletes only a settled judgement, archives its session, and removes local report files', async () => {
    const { database, paths, service, sessions } = fixture()
    const created = await service.call('judgement.create', {
      secId: '1.600519', masterId: 'munger-perspective',
    }, new AbortController().signal)
    const judgementDirectory = join(paths.judgementsDir, created.id)
    expect(existsSync(judgementDirectory)).toBe(true)

    await expect(service.call(
      'judgement.remove',
      { id: created.id },
      new AbortController().signal,
    )).rejects.toThrow('仍在进行中')
    expect(database.getJudgement(created.id)).not.toBeNull()
    expect(sessions.archived).toEqual([])

    database.updateJudgement(created.id, { reportStatus: 'failed', turnStatus: 'failed' })
    await expect(service.call(
      'judgement.remove',
      { id: created.id },
      new AbortController().signal,
    )).resolves.toEqual([])
    expect(sessions.archived).toEqual([created.dshSessionId])
    expect(database.getJudgement(created.id)).toBeNull()
    expect(existsSync(judgementDirectory)).toBe(false)
    database.close()
  })

  it('creates one persistent DSH session, seals report v1, and keeps ordinary chat out of report versions', async () => {
    const { database, reports, service, sessions } = fixture()
    const created = await service.call('judgement.create', {
      secId: '1.600519', masterId: 'munger-perspective', prompt: '重点检查永久损失风险',
    }, new AbortController().signal)
    expect(created.dshSessionId).toBe(`hanai-${created.id}`)
    expect(sessions.prompts).toHaveLength(1)
    expect(sessions.prompts[0]?.text).toContain('永久损失风险')
    expect(sessions.prompts[0]?.text).toContain('主动联网检索公司公告、财报、监管披露')
    expect(sessions.prompts[0]?.text).toContain('不要向用户提问，也不要等待用户补充材料')
    expect(sessions.prompts[0]?.text).toContain('关键事实注明来源链接和日期')
    expect(sessions.prompts[0]?.text).toContain('严禁编造数据、来源或引文')
    expect(sessions.prompts[0]?.text).toContain('证据不足时明确标记不确定性')
    expect(sessions.prompts[0]?.text).toContain('只用一句话向用户确认报告已经完成')
    expect(sessions.prompts[0]?.text).toContain('不要在回复中重复整份报告')
    writeFileSync(reports.workingReportPath(created.id), `# 正式研判\n\n${'事实、推断、风险与验证条件。'.repeat(20)}`)
    service.handleSessionEvent(created.dshSessionId!, completed())
    await eventually(() => expect(database.getJudgement(created.id)?.reportStatus).toBe('ready'))
    expect(database.listReportRows(created.id)).toHaveLength(1)

    service.handleSessionEvent(created.dshSessionId!, {
      type: 'turn/start', seq: SessionSeq(2), time: Date.now(), data: { turn: 2 },
    })
    service.handleSessionEvent(created.dshSessionId!, completed(2))
    expect(database.getJudgement(created.id)?.turnStatus).toBe('idle')
    expect(database.listReportRows(created.id)).toHaveLength(1)
    database.close()
  })

  it('uses exactly one automatic repair turn before sealing a valid report', async () => {
    const { database, reports, service, sessions } = fixture(180)
    const created = await service.call('judgement.create', {
      secId: '1.600519', masterId: 'warren-buffett-perspective',
    }, new AbortController().signal)
    writeFileSync(reports.workingReportPath(created.id), '# 太短')
    service.handleSessionEvent(created.dshSessionId!, completed())
    await eventually(() => expect(database.getJudgement(created.id)?.reportStatus).toBe('repairing'))
    expect(database.getRepairAttempts(created.id)).toBe(1)
    expect(sessions.prompts).toHaveLength(2)
    expect(sessions.prompts[1]?.text).toContain('唯一一次自动修复机会')

    writeFileSync(reports.workingReportPath(created.id), `# 修复后的正式报告\n\n${'所有者收益、安全边际、反方证据与验证条件。'.repeat(20)}`)
    service.handleSessionEvent(created.dshSessionId!, completed(2))
    await eventually(() => expect(database.getJudgement(created.id)?.reportStatus).toBe('ready'))
    expect(database.listReportRows(created.id)).toHaveLength(1)
    expect(database.getRepairAttempts(created.id)).toBe(0)

    await service.call('judgement.revise', {
      id: created.id,
      instruction: '补充最新估值与反方证据',
    }, new AbortController().signal)
    expect(database.getRepairAttempts(created.id)).toBe(0)
    writeFileSync(reports.workingReportPath(created.id), '# 第二版仍然太短')
    service.handleSessionEvent(created.dshSessionId!, completed(3))
    await eventually(() => expect(database.getJudgement(created.id)?.reportStatus).toBe('repairing'))
    expect(database.getRepairAttempts(created.id)).toBe(1)

    writeFileSync(reports.workingReportPath(created.id), `# 修复后的第二版报告\n\n${'估值、反方证据、风险与验证条件。'.repeat(20)}`)
    service.handleSessionEvent(created.dshSessionId!, completed(4))
    await eventually(() => expect(database.getJudgement(created.id)?.reportStatus).toBe('ready'))
    expect(database.getJudgement(created.id)?.latestReportVersion).toBe(2)
    expect(database.getRepairAttempts(created.id)).toBe(0)
    expect(database.listReportRows(created.id)).toHaveLength(2)
    database.close()
  })

  it('keeps the concrete DSH failure message when an initial report turn crashes', async () => {
    const { database, service } = fixture()
    const created = await service.call('judgement.create', {
      secId: '1.600519', masterId: 'duan-yongping-perspective',
    }, new AbortController().signal)

    service.handleSessionEvent(created.dshSessionId!, {
      type: 'turn/end',
      seq: SessionSeq(1),
      time: Date.now(),
      data: {
        turn: 1,
        reason: {
          kind: 'error',
          error: { code: 'UNKNOWN', message: "Cannot read properties of undefined (reading 'prepare')" },
        },
      },
    })

    expect(database.getJudgement(created.id)).toMatchObject({
      reportStatus: 'failed',
      turnStatus: 'failed',
      errorCode: 'turn-error',
      errorMessage: "DSH 回合未完成：Cannot read properties of undefined (reading 'prepare')",
    })
    database.close()
  })

  it('keeps the sealed report ready when a revision exhausts repair and permits another revision', async () => {
    const { database, reports, service, sessions } = fixture(180)
    const created = await service.call('judgement.create', {
      secId: '1.600519', masterId: 'munger-perspective',
    }, new AbortController().signal)
    writeFileSync(reports.workingReportPath(created.id), `# 第一版正式报告\n\n${'事实、推断、风险与验证条件。'.repeat(24)}`)
    service.handleSessionEvent(created.dshSessionId!, completed())
    await eventually(() => expect(database.getJudgement(created.id)?.reportStatus).toBe('ready'))

    await service.call('judgement.revise', {
      id: created.id, instruction: '生成第二版',
    }, new AbortController().signal)
    writeFileSync(reports.workingReportPath(created.id), '# 第二版太短')
    service.handleSessionEvent(created.dshSessionId!, completed(2))
    await eventually(() => expect(database.getJudgement(created.id)?.reportStatus).toBe('repairing'))
    service.handleSessionEvent(created.dshSessionId!, completed(3))
    await eventually(() => expect(database.getJudgement(created.id)?.turnStatus).toBe('failed'))

    expect(database.getJudgement(created.id)).toMatchObject({
      reportStatus: 'ready',
      latestReportVersion: 1,
      turnStatus: 'failed',
      errorCode: 'report-too-short',
    })
    expect(database.getRepairAttempts(created.id)).toBe(0)
    expect(database.listReportRows(created.id)).toHaveLength(1)

    await expect(service.call('judgement.revise', {
      id: created.id, instruction: '重新生成第二版',
    }, new AbortController().signal)).resolves.toMatchObject({
      reportStatus: 'revising',
      latestReportVersion: 1,
      errorCode: null,
    })
    expect(sessions.prompts.at(-1)?.text).toContain('重新生成第二版')
    database.close()
  })

  it('restores ready state when submitting a revision prompt fails', async () => {
    const { database, reports, service, sessions } = fixture()
    const created = await service.call('judgement.create', {
      secId: '1.600519', masterId: 'munger-perspective',
    }, new AbortController().signal)
    writeFileSync(reports.workingReportPath(created.id), `# 第一版正式报告\n\n${'事实、推断、风险与验证条件。'.repeat(24)}`)
    service.handleSessionEvent(created.dshSessionId!, completed())
    await eventually(() => expect(database.getJudgement(created.id)?.reportStatus).toBe('ready'))

    vi.spyOn(sessions, 'prompt').mockRejectedValueOnce(new Error('prompt submission failed'))
    await expect(service.call('judgement.revise', {
      id: created.id, instruction: '本次提交会失败',
    }, new AbortController().signal)).rejects.toThrow('prompt submission failed')
    expect(database.getJudgement(created.id)).toMatchObject({
      reportStatus: 'ready',
      latestReportVersion: 1,
      turnStatus: 'failed',
      errorCode: 'revision-start-failed',
    })

    await expect(service.call('judgement.revise', {
      id: created.id, instruction: '再次修订',
    }, new AbortController().signal)).resolves.toMatchObject({ reportStatus: 'revising' })
    database.close()
  })

  it('marks a preparing judgement recoverably failed after a host restart', async () => {
    const { database, service } = fixture()
    const judgement = database.createJudgement({
      id: 'interrupted-before-session-binding',
      secId: '1.600519',
      code: '600519',
      stockName: '贵州茅台',
      masterId: 'munger-perspective',
      masterName: '查理·芒格',
      masterVersion: 'v1',
    })
    expect(judgement.reportStatus).toBe('preparing')

    await service.recover()

    expect(database.getJudgement(judgement.id)).toMatchObject({
      reportStatus: 'failed',
      turnStatus: 'failed',
      errorCode: 'recovery-preparing-interrupted',
      errorMessage: expect.stringContaining('重新发起研判'),
    })
    database.close()
  })

  it('recovers interrupted expert chat turns without hiding a prior failure', async () => {
    const { database, service } = fixture()
    const interrupted = database.createExpertChat({
      id: 'chat-interrupted',
      title: '中断的开放对谈',
      masterId: 'munger-perspective',
      masterName: '查理·芒格',
      masterVersion: 'v1',
    })
    database.updateExpertChat(interrupted.id, {
      dshSessionId: 'session-interrupted',
      turnStatus: 'running',
    })
    const failed = database.createExpertChat({
      id: 'chat-failed',
      title: '失败的开放对谈',
      masterId: 'sun-yuchen-perspective',
      masterName: '孙宇晨',
      masterVersion: 'v1',
    })
    database.updateExpertChat(failed.id, {
      dshSessionId: 'session-failed',
      turnStatus: 'failed',
      errorCode: 'chat-turn-error',
      errorMessage: '保留这条错误',
    })

    await service.recover()

    expect(database.getExpertChat(interrupted.id)).toMatchObject({
      turnStatus: 'idle', errorCode: null, errorMessage: null,
    })
    expect(database.getExpertChat(failed.id)).toMatchObject({
      turnStatus: 'failed', errorCode: 'chat-turn-error', errorMessage: '保留这条错误',
    })
    database.close()
  })

  it('archives a DSH session when database binding fails', async () => {
    const { database, service, sessions } = fixture()
    const update = database.updateJudgement.bind(database)
    vi.spyOn(database, 'updateJudgement').mockImplementation((id, patch) => {
      if ('dshSessionId' in patch && patch.dshSessionId !== null) throw new Error('database binding failed')
      return update(id, patch)
    })

    await expect(service.call('judgement.create', {
      secId: '1.600519', masterId: 'munger-perspective',
    }, new AbortController().signal)).rejects.toThrow('database binding failed')

    expect(sessions.archived).toHaveLength(1)
    expect(sessions.archived[0]).toMatch(/^hanai-/)
    expect(database.listJudgements()).toEqual([
      expect.objectContaining({
        dshSessionId: null,
        reportStatus: 'failed',
        turnStatus: 'failed',
        errorCode: 'judgement-start-failed',
      }),
    ])
    database.close()
  })

  it('persists successful market and valuation timestamps without regressing them', async () => {
    const { database, market, service } = fixture()
    const marketMeta: ProviderMeta = {
      providerId: 'eastmoney',
      sourceName: '东方财富',
      sourceTimestamp: '2026-08-15T01:00:00.000Z',
      fetchedAt: '2026-08-15T01:02:00.000Z',
      cacheState: 'fresh',
    }
    const valuationMeta: ProviderMeta = {
      providerId: 'gurufocus',
      sourceName: 'GuruFocus',
      sourceTimestamp: null,
      fetchedAt: '2026-08-15T01:03:00.000Z',
      cacheState: 'cached',
    }
    market.getStockDetail = async () => ({
      ...stockDetail(),
      trend: [{ time: '09:30', price: 10, avgPrice: 10, volume: 100 }],
      trendPrevClose: 9.8,
      valuation: {
        stockId: 'SHSE:600519', ivDcf: null, medps: 10, gfScore: null, valuationRank: null,
        dimensions: {
          financialStrength: null, profitability: null, growth: null, gfValue: null, momentum: null,
        },
        series: { price: [], medps: [] },
        meta: valuationMeta,
      },
      sources: {
        ...stockDetail().sources,
        trend: marketMeta,
        valuation: valuationMeta,
      },
    })

    await service.call('security.detail', { secId: '1.600519' }, new AbortController().signal)
    expect(database.getSetting('market.latestSuccess')).toBe('2026-08-15T01:02:00.000Z')
    expect(database.getSetting('valuation.latestSuccess')).toBe('2026-08-15T01:03:00.000Z')

    market.getStockDetail = async () => ({
      ...stockDetail(),
      trend: [{ time: '09:30', price: 10, avgPrice: 10, volume: 100 }],
      trendPrevClose: 9.8,
      valuation: {
        stockId: 'SHSE:600519', ivDcf: null, medps: 10, gfScore: null, valuationRank: null,
        dimensions: {
          financialStrength: null, profitability: null, growth: null, gfValue: null, momentum: null,
        },
        series: { price: [], medps: [] },
        meta: { ...valuationMeta, fetchedAt: '2026-08-14T01:03:00.000Z' },
      },
      sources: {
        ...stockDetail().sources,
        trend: { ...marketMeta, fetchedAt: '2026-08-14T01:02:00.000Z' },
        valuation: { ...valuationMeta, fetchedAt: '2026-08-14T01:03:00.000Z' },
      },
    })
    await service.call('security.detail', { secId: '1.600519' }, new AbortController().signal)
    const diagnostics = await service.call('diagnostics.get', {}, new AbortController().signal)
    expect(diagnostics.latestMarketSuccess).toBe('2026-08-15T01:02:00.000Z')
    expect(diagnostics.latestValuationSuccess).toBe('2026-08-15T01:03:00.000Z')
    expect(diagnostics.marketSources).toEqual([marketMeta])
    expect(diagnostics.valuationSources).toEqual([valuationMeta])
    database.close()
  })
})

describe('HanaiService parity endpoints and diagnostics', () => {
  it('enforces the shared manual security cooldown until the exact 60-second boundary', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-26T10:00:00+08:00'))
    const { database, market, service } = fixture()
    try {
      const sync = vi.spyOn(market, 'syncSecurities').mockResolvedValue({ count: 5576, updatedAt: null })
      const signal = new AbortController().signal
      await service.call('security.sync', { force: true }, signal)
      expect((await service.call('diagnostics.get', {}, signal)).securitySyncAvailableAt).toBe('2026-10-26T02:01:00.000Z')
      await expect(service.call('security.sync', {}, signal)).rejects.toThrow('60 秒后重试')
      vi.advanceTimersByTime(59_999)
      await expect(service.call('security.sync', { force: true }, signal)).rejects.toThrow('1 秒后重试')
      expect(sync).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1)
      await service.call('security.sync', { force: true }, signal)
      expect(sync).toHaveBeenCalledTimes(2)
    } finally { database.close(); vi.useRealTimers() }
  })

  it('retains cooldown after failure and service recreation while leaving automatic bootstrap sync independent', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-26T10:00:00+08:00'))
    const setup = fixture()
    try {
      const sync = vi.spyOn(setup.market, 'syncSecurities').mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue({ count: 0, updatedAt: null })
      const signal = new AbortController().signal
      await expect(setup.service.call('security.sync', { force: true }, signal)).rejects.toThrow('offline')
      const restarted = new HanaiService({ ...setup, version: 'test' })
      await expect(restarted.call('security.sync', { force: true }, signal)).rejects.toThrow('冷却中')
      await restarted.call('bootstrap', {}, signal)
      expect(sync).toHaveBeenCalledTimes(2)
      expect(sync.mock.calls[1]?.[1]).toBe(false)
      vi.advanceTimersByTime(60_000)
      await setup.service.call('security.sync', { force: true }, signal)
      expect(sync).toHaveBeenCalledTimes(3)
    } finally { setup.database.close(); vi.useRealTimers() }
  })

  it('blocks overlapping manual syncs even when a running request outlasts its cooldown', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-26T10:00:00+08:00'))
    const { database, market, service } = fixture()
    let finish!: (value: { count: number; updatedAt: string | null }) => void
    const pending = new Promise<{ count: number; updatedAt: string | null }>(resolve => { finish = resolve })
    const sync = vi.spyOn(market, 'syncSecurities').mockReturnValue(pending)
    const signal = new AbortController().signal
    const active = service.call('security.sync', { force: true }, signal)
    try {
      vi.advanceTimersByTime(61_000)
      await expect(service.call('security.sync', { force: true }, signal)).rejects.toThrow('正在同步')
      expect(sync).toHaveBeenCalledTimes(1)
    } finally {
      finish({ count: 5576, updatedAt: null })
      await active
      database.close()
      vi.useRealTimers()
    }
  })

  it('keeps security provenance separate from market success and exposes diagnostics without fetching prices', async () => {
    const { database, market, service } = fixture()
    try {
      database.setSetting('market.latestSuccess', '2026-10-26T01:00:00.000Z')
      market.syncSecurities = async () => {
        database.setSetting('security.master.syncedAt', '2026-10-26T02:00:00.000Z')
        database.setSetting('security.master.source', '新浪')
        return { count: 5576, updatedAt: '2026-10-26T02:00:00.000Z' }
      }
      const history = [{ source: 'sina', sourceName: '新浪', scope: 'security' as const, lastAttemptAt: null,
        lastSuccessAt: null, lastError: null, failures: 0, openUntil: null }]
      market.getSourceDiagnostics = () => history
      const quotes = vi.spyOn(market, 'getQuotes')
      await service.call('security.sync', { force: true }, new AbortController().signal)
      await service.call('bootstrap', {}, new AbortController().signal)
      const diagnostics = await service.call('diagnostics.get', {}, new AbortController().signal)
      expect(diagnostics).toMatchObject({ latestMarketSuccess: '2026-10-26T01:00:00.000Z', marketSources: [],
        securitySource: '新浪', latestSecuritySuccess: '2026-10-26T02:00:00.000Z', sourceAttempts: history })
      expect(quotes).not.toHaveBeenCalled()
    } finally { database.close() }
  })

  it('reads unique watch securities locally even when market providers are unavailable', async () => {
    const { database, market, service } = fixture()
    try {
      const security = stockDetail().security!
      database.sqlite.prepare(`
        INSERT INTO security_master(sec_id, code, name, exchange, pinyin_full, pinyin_initial, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(security.secId, security.code, security.name, security.exchange, security.pinyinFull, security.pinyinInitial, new Date().toISOString())
      const group = database.listWatchGroups()[0]!
      const second = database.createWatchGroup('观察组')
      database.addWatchItem(group.id, security.secId, null)
      database.addWatchItem(second.id, security.secId, null)
      database.addWatchItem(second.id, '0.000001', null)
      const quotes = vi.spyOn(market, 'getQuotes').mockRejectedValue(new Error('offline'))
      const search = vi.spyOn(market, 'searchSecurities').mockRejectedValue(new Error('offline'))

      await expect(service.call('watch.securities', {}, new AbortController().signal)).resolves.toEqual([security])
      expect(quotes).not.toHaveBeenCalled()
      expect(search).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it('loads daily watch valuations as one resilient group batch', async () => {
    const { database, market, service } = fixture()
    const group = database.listWatchGroups()[0]!
    database.addWatchItem(group.id, '1.600519', 100)
    database.addWatchItem(group.id, '0.000001', 10)
    const valuationMeta: ProviderMeta = {
      providerId: 'gurufocus-cn-prototype',
      sourceName: '价值大师网',
      sourceTimestamp: '2026-08-15',
      fetchedAt: '2026-08-15T01:03:00.000Z',
      cacheState: 'cached',
    }
    vi.spyOn(market, 'getValuation').mockImplementation(async (secId) => {
      if (secId === '0.000001') throw new Error('single valuation unavailable')
      return {
        valuation: {
          stockId: 'SHSE:600519', ivDcf: null, medps: 123.45, gfScore: null, valuationRank: 4,
          dimensions: { financialStrength: null, profitability: null, growth: null, gfValue: null, momentum: null },
          series: { price: [], medps: [] },
          meta: valuationMeta,
        },
        meta: valuationMeta,
      }
    })

    await expect(service.call(
      'watch.valuations',
      { groupId: group.id },
      new AbortController().signal,
    )).resolves.toEqual({
      valuations: [
        { secId: '0.000001', fairValue: null, valuationRank: null, meta: null },
        { secId: '1.600519', fairValue: 123.45, valuationRank: 4, meta: valuationMeta },
      ],
      meta: valuationMeta,
    })
    expect(database.getSetting('valuation.latestSuccess')).toBe('2026-08-15T01:03:00.000Z')
    database.close()
  })

  it('reads and writes the DSH-owned default model without a Hanai settings copy', async () => {
    const { database, defaultModel, service } = fixture()

    await expect(service.call(
      'model.default.get',
      {},
      new AbortController().signal,
    )).resolves.toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    })

    await expect(service.call(
      'model.default.set',
      { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      new AbortController().signal,
    )).resolves.toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    expect(defaultModel.currentSelection()).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    database.close()
  })

  it('fails loudly when DSH exposes only the composition default and cannot persist', async () => {
    const { database, defaultModel, service } = fixture()
    vi.spyOn(defaultModel, 'saveSelection').mockResolvedValueOnce()

    await expect(service.call(
      'model.default.set',
      { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      new AbortController().signal,
    )).rejects.toThrow('未提供可写的默认模型设置')
    expect(defaultModel.currentSelection()).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    })
    database.close()
  })

  it('opens only the isolated data root through the injected platform launcher', async () => {
    const { database, openDirectory, paths, service } = fixture()

    await expect(service.call(
      'storage.openDataRoot',
      {},
      new AbortController().signal,
    )).resolves.toEqual({ opened: true, dataRoot: paths.root })
    expect(openDirectory).toHaveBeenCalledOnce()
    expect(openDirectory).toHaveBeenCalledWith(paths.root)

    openDirectory.mockRejectedValueOnce(new Error('Finder launch failed'))
    await expect(service.call(
      'storage.openDataRoot',
      {},
      new AbortController().signal,
    )).rejects.toThrow('Finder launch failed')
    database.close()
  })

  it('refreshes stock-detail surfaces independently instead of refetching the aggregate detail', async () => {
    const { database, market, service } = fixture()
    const aggregate = vi.spyOn(market, 'getStockDetail')
    const quote = vi.spyOn(market, 'getStockQuoteMetrics')
    const trendMeta: ProviderMeta = {
      providerId: 'eastmoney', sourceName: '东方财富', sourceTimestamp: null,
      fetchedAt: '2026-08-15T01:01:00.000Z', cacheState: 'fresh',
    }
    const trend = vi.spyOn(market, 'getTrend').mockResolvedValue({
      trend: [{ time: '09:30', price: 10, avgPrice: 10, volume: 100 }],
      trendPrevClose: 9.8,
      meta: trendMeta,
    })
    const kline = vi.spyOn(market, 'getKline')
    const valuation = vi.spyOn(market, 'getValuation')

    await service.call('security.quote', { secId: '1.600519' }, new AbortController().signal)
    expect(quote).toHaveBeenCalledOnce()
    expect(aggregate).not.toHaveBeenCalled()
    expect(trend).not.toHaveBeenCalled()
    expect(kline).not.toHaveBeenCalled()
    expect(valuation).not.toHaveBeenCalled()

    const refreshedTrend = await service.call(
      'security.trend',
      { secId: '1.600519' },
      new AbortController().signal,
    )
    expect(refreshedTrend.trendPrevClose).toBe(9.8)
    expect(trend).toHaveBeenCalledOnce()
    expect(aggregate).not.toHaveBeenCalled()
    expect(database.getSetting('market.latestSuccess')).toBe('2026-08-15T01:01:00.000Z')

    await service.call(
      'security.kline',
      { secId: '1.600519', period: 'daily', before: '2018-06-08' },
      new AbortController().signal,
    )
    expect(kline).toHaveBeenCalledWith('1.600519', 'daily', '2018-06-08')
    expect(aggregate).not.toHaveBeenCalled()
    database.close()
  })

  it('reports real storage categories and clears only the selected cache contents idempotently', async () => {
    const { database, market, paths, service } = fixture()
    const clearMemory = vi.spyOn(market, 'clearMarketCache').mockReturnValue(3)
    const nestedMarket = join(paths.marketCacheDir, 'nested')
    const nestedJudgement = join(paths.judgementsDir, 'archive')
    mkdirSync(nestedMarket)
    mkdirSync(nestedJudgement)
    writeFileSync(join(paths.marketCacheDir, 'quote.json'), Buffer.alloc(4))
    writeFileSync(join(nestedMarket, 'board.json'), Buffer.alloc(3))
    writeFileSync(join(paths.valuationCacheDir, 'value.json'), Buffer.alloc(5))
    writeFileSync(join(nestedJudgement, 'report.md'), Buffer.alloc(6))
    writeFileSync(join(paths.root, 'keep.txt'), Buffer.alloc(8))

    const before = await service.call('diagnostics.get', {}, new AbortController().signal)
    expect(before.storage).toMatchObject({
      marketCacheBytes: 7,
      valuationCacheBytes: 5,
      cacheBytes: 12,
      judgementsBytes: 6,
    })
    expect(before.storage.totalBytes).toBeGreaterThanOrEqual(26)

    const cleared = await service.call(
      'cache.clear',
      { scope: 'market' },
      new AbortController().signal,
    )
    expect(cleared).toEqual({ scope: 'market', removedFiles: 2, freedBytes: 7 })
    expect(clearMemory).toHaveBeenCalledOnce()
    expect(existsSync(paths.marketCacheDir)).toBe(true)
    expect(existsSync(join(paths.root, 'keep.txt'))).toBe(true)
    expect(existsSync(join(paths.valuationCacheDir, 'value.json'))).toBe(true)
    expect(existsSync(join(nestedJudgement, 'report.md'))).toBe(true)

    await expect(service.call(
      'cache.clear',
      { scope: 'market' },
      new AbortController().signal,
    )).resolves.toEqual({ scope: 'market', removedFiles: 0, freedBytes: 0 })
    database.close()
  })

  it('rejects a dedicated cache directory replaced by a symlink and leaves its target untouched', async () => {
    const { database, paths, service } = fixture()
    const outside = mkdtempSync(join(tmpdir(), 'hanai-dsh-cache-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'sentinel.txt'), 'do-not-delete')
    rmSync(paths.marketCacheDir, { recursive: true })
    symlinkSync(outside, paths.marketCacheDir, 'dir')

    await expect(service.call(
      'cache.clear',
      { scope: 'market' },
      new AbortController().signal,
    )).rejects.toThrow('符号链接')
    expect(existsSync(join(outside, 'sentinel.txt'))).toBe(true)
    database.close()
  })
})
