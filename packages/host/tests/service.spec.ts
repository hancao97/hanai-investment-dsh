import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DefaultModelSelection, ProviderMeta, StockDetail } from '../../contracts/src/index.ts'
import { HanaiDatabase } from '../../domain/src/database.ts'
import { ensureHanaiLayout, resolveHanaiPaths } from '../../domain/src/paths.ts'
import { ReportStore } from '../../domain/src/reports.ts'
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
    getDashboard: async () => { throw new Error('unused') },
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
    syncSecurities: async () => ({ count: 0, updatedAt: null }),
    searchSecurities: async () => [],
  }
  const reports = new ReportStore(paths, assets, minChars)
  const openDirectory = vi.fn(async (_directory: string): Promise<void> => {})
  const service = new HanaiService({
    paths, database, reports, sessions, defaultModel, market, version: 'test', openDirectory,
  })
  return { database, defaultModel, market, openDirectory, paths, reports, service, sessions }
}

function completed(turn = 1): SessionEvent {
  return { type: 'turn/end', seq: turn, time: Date.now(), data: { turn, reason: { kind: 'completed' } } }
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
      type: 'turn/start', seq: 2, time: Date.now(), data: { turn: 2 },
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
      seq: 1,
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
    database.close()
  })
})

describe('HanaiService parity endpoints and diagnostics', () => {
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
