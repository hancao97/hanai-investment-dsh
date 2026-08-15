import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderMeta, StockDetail } from '../../contracts/src/index.ts'
import { HanaiDatabase } from '../../domain/src/database.ts'
import { ensureHanaiLayout, resolveHanaiPaths } from '../../domain/src/paths.ts'
import { ReportStore } from '../../domain/src/reports.ts'
import { HanaiService, type MarketFacade, type SessionFacade } from '../src/service.ts'

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

function stockDetail(): StockDetail {
  return {
    security: { secId: '1.600519', code: '600519', name: '贵州茅台', exchange: 'SH', pinyinFull: 'guizhoumaotai', pinyinInitial: 'gzmt' },
    quote: null, metrics: null, trend: [], daily: [], weekly: [], monthly: [], valuation: null,
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
  const meta = {
    providerId: 'fake', sourceName: 'fake', sourceTimestamp: null,
    fetchedAt: new Date(0).toISOString(), cacheState: 'fresh' as const,
  }
  const market: MarketFacade = {
    getDashboard: async () => { throw new Error('unused') },
    getSectorStocks: async () => ({ stocks: [], meta }),
    getStockDetail: async () => stockDetail(),
    getQuotes: async () => ({ quotes: [], meta }),
    syncSecurities: async () => ({ count: 0, updatedAt: null }),
    searchSecurities: async () => [],
  }
  const reports = new ReportStore(paths, assets, minChars)
  const service = new HanaiService({ paths, database, reports, sessions, market, version: 'test' })
  return { database, market, paths, reports, service, sessions }
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
  it('creates one persistent DSH session, seals report v1, and keeps ordinary chat out of report versions', async () => {
    const { database, reports, service, sessions } = fixture()
    const created = await service.call('judgement.create', {
      secId: '1.600519', masterId: 'munger-perspective', prompt: '重点检查永久损失风险',
    }, new AbortController().signal)
    expect(created.dshSessionId).toBe(`hanai-${created.id}`)
    expect(sessions.prompts).toHaveLength(1)
    expect(sessions.prompts[0]?.text).toContain('永久损失风险')
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
      sources: {
        ...stockDetail().sources,
        quote: marketMeta,
        valuation: valuationMeta,
      },
    })

    await service.call('security.detail', { secId: '1.600519' }, new AbortController().signal)
    expect(database.getSetting('market.latestSuccess')).toBe('2026-08-15T01:02:00.000Z')
    expect(database.getSetting('valuation.latestSuccess')).toBe('2026-08-15T01:03:00.000Z')

    market.getStockDetail = async () => ({
      ...stockDetail(),
      sources: {
        ...stockDetail().sources,
        quote: { ...marketMeta, fetchedAt: '2026-08-14T01:02:00.000Z' },
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
