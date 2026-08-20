import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HanaiDatabase } from '../src/database.ts'
import { ensureHanaiLayout, resolveHanaiPaths } from '../src/paths.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function database(): { db: HanaiDatabase; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'hanai-dsh-db-'))
  roots.push(root)
  const paths = resolveHanaiPaths(root)
  ensureHanaiLayout(paths)
  return { db: new HanaiDatabase(paths.databasePath), root }
}

describe('HanaiDatabase', () => {
  it('creates a private isolated layout and one default watch group', () => {
    const { db, root } = database()
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(statSync(db.path).mode & 0o777).toBe(0o600)
    expect(db.listWatchGroups()).toEqual([
      expect.objectContaining({ name: '默认分组', isDefault: true, items: [] }),
    ])
    expect(db.getTheme()).toBe('dark')
    db.close()
  })

  it('migrates historical ocean and jade settings to dark while persisting light and dark', () => {
    const { db } = database()
    const writeLegacyTheme = (value: string) => db.sqlite.prepare(`
      INSERT INTO app_settings(key, value, updated_at) VALUES('theme', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(value, new Date(0).toISOString())

    writeLegacyTheme('ocean')
    expect(db.getTheme()).toBe('dark')
    writeLegacyTheme('jade')
    expect(db.getTheme()).toBe('dark')

    db.setTheme('light')
    expect(db.getTheme()).toBe('light')
    db.setTheme('dark')
    expect(db.getTheme()).toBe('dark')
    db.close()

    const reopened = new HanaiDatabase(db.path)
    expect(reopened.getTheme()).toBe('dark')
    reopened.setTheme('light')
    reopened.close()
    const lightReopened = new HanaiDatabase(db.path)
    expect(lightReopened.getTheme()).toBe('light')
    lightReopened.close()
  })

  it('enforces group naming and moves deleted group items atomically to default', () => {
    const { db } = database()
    const defaultGroup = db.listWatchGroups()[0]!
    const research = db.createWatchGroup('研究池')
    expect(() => db.createWatchGroup('研究池')).toThrow('同名')
    expect(() => db.createWatchGroup('研究池'.toUpperCase())).toThrow('同名')
    db.addWatchItem(research.id, '1.600519', 1500)
    db.removeWatchGroup(research.id)
    const groups = db.listWatchGroups()
    expect(groups).toHaveLength(1)
    expect(groups[0]?.id).toBe(defaultGroup.id)
    expect(groups[0]?.items).toEqual([expect.objectContaining({ secId: '1.600519', basePrice: 1500 })])
    db.close()
  })

  it('commits an immutable report row and ready pointer in one transaction', () => {
    const { db } = database()
    db.createJudgement({
      id: 'judgement-1', secId: '1.600519', code: '600519', stockName: '贵州茅台',
      masterId: 'munger-perspective', masterName: '查理·芒格', masterVersion: 'v1',
    })
    db.updateJudgement('judgement-1', {
      dshSessionId: 'hanai-judgement-1', reportStatus: 'verifying', repairAttempts: 1,
    })
    const sealedAt = new Date().toISOString()
    const committed = db.commitReportVersion({
      judgement_id: 'judgement-1', version: 1, relativePath: 'judgements/judgement-1/reports/0001/report.md',
      sha256: 'a'.repeat(64), size_bytes: 1000, sealed_at: sealedAt, model_provider: null, model: null,
    })
    expect(committed).toMatchObject({ reportStatus: 'ready', latestReportVersion: 1, completedAt: sealedAt })
    expect(db.getRepairAttempts('judgement-1')).toBe(0)
    expect(db.listReportRows('judgement-1')).toHaveLength(1)
    expect(() => db.commitReportVersion({
      judgement_id: 'missing', version: 1, relativePath: 'x', sha256: 'b'.repeat(64),
      size_bytes: 1, sealed_at: sealedAt, model_provider: null, model: null,
    })).toThrow()
    expect(db.listReportRows('missing')).toHaveLength(0)
    db.removeJudgement('judgement-1')
    expect(db.getJudgement('judgement-1')).toBeNull()
    expect(db.listReportRows('judgement-1')).toEqual([])
    expect(() => db.removeJudgement('judgement-1')).toThrow('不存在')
    db.close()
  })

  it('persists, completes, reopens, and preserves local research follow-ups', () => {
    const { db } = database()
    db.createJudgement({
      id: 'judgement-followup', secId: '1.600519', code: '600519', stockName: '贵州茅台',
      masterId: 'munger-perspective', masterName: '查理·芒格', masterVersion: 'v1',
    })
    db.updateJudgement('judgement-followup', { reportStatus: 'ready', latestReportVersion: 1 })
    const created = db.createResearchFollowUp({
      secId: '1.600519', judgementId: 'judgement-followup', reportVersion: 1,
      title: '  核验下一季经营现金流  ', dueDate: '2026-09-30',
    })
    expect(created).toMatchObject({
      title: '核验下一季经营现金流', dueDate: '2026-09-30', status: 'open', completedAt: null,
    })
    expect(db.listAllResearchFollowUps('open')).toEqual([created])
    const completed = db.updateResearchFollowUp(created.id, { completed: true })
    expect(completed.status).toBe('done')
    expect(completed.completedAt).not.toBeNull()
    expect(db.listAllResearchFollowUps('open')).toEqual([])
    expect(db.listAllResearchFollowUps('done')).toEqual([completed])
    expect(db.updateResearchFollowUp(created.id, { completed: false })).toMatchObject({
      status: 'open', completedAt: null,
    })
    expect(() => db.createResearchFollowUp({
      secId: '1.600519', title: '日期错误', dueDate: '2026-02-30',
    })).toThrow('到期日无效')

    db.removeJudgement('judgement-followup')
    expect(db.getResearchFollowUp(created.id)).toMatchObject({
      judgementId: null, reportVersion: null, title: '核验下一季经营现金流',
    })
    expect(db.listAllResearchFollowUps()).toHaveLength(1)
    db.removeResearchFollowUp(created.id)
    expect(db.listResearchFollowUps('1.600519')).toEqual([])
    db.close()
  })

  it('stores falsifiable research predictions and scores resolved confidence without rewriting history', () => {
    const { db } = database()
    db.createJudgement({
      id: 'judgement-prediction', secId: '1.600519', code: '600519', stockName: '贵州茅台',
      masterId: 'munger-perspective', masterName: '查理·芒格', masterVersion: 'v1',
    })
    db.updateJudgement('judgement-prediction', { reportStatus: 'ready', latestReportVersion: 1 })
    const created = db.createResearchPrediction({
      secId: '1.600519', judgementId: 'judgement-prediction', reportVersion: 1,
      statement: ' 下一季度经营现金流同比改善 ',
      resolutionCriteria: ' 以公司下一季法定财报披露值为准 ',
      probabilityPct: 70,
      dueDate: '2026-10-31',
    })
    expect(created).toMatchObject({
      statement: '下一季度经营现金流同比改善',
      resolutionCriteria: '以公司下一季法定财报披露值为准',
      probabilityPct: 70,
      outcome: 'pending',
      brierScore: null,
      resolvedAt: null,
    })
    expect(db.listResearchPredictions('1.600519')).toEqual([created])
    expect(db.listAllResearchPredictions('pending')).toEqual([created])
    expect(db.listResearchPredictionsForSecurities(['1.600519', '1.600519', '0.000001'])).toEqual([created])

    const resolved = db.resolveResearchPrediction(created.id, 'occurred')
    expect(resolved).toMatchObject({ outcome: 'occurred', brierScore: 0.09 })
    expect(resolved.resolvedAt).not.toBeNull()
    expect(db.listAllResearchPredictions('pending')).toEqual([])
    expect(db.listResearchPredictionsForSecurities(['1.600519'])).toEqual([])
    expect(db.listAllResearchPredictions('resolved')).toEqual([resolved])
    expect(db.resolveResearchPrediction(created.id, 'occurred')).toEqual(resolved)
    expect(() => db.resolveResearchPrediction(created.id, 'not-occurred')).toThrow('不能覆盖历史结果')
    expect(() => db.createResearchPrediction({
      secId: '1.600519', statement: '概率错误', resolutionCriteria: '财报', probabilityPct: 100,
      dueDate: '2026-10-31',
    })).toThrow('1 到 99')

    db.removeJudgement('judgement-prediction')
    expect(db.getResearchPrediction(created.id)).toMatchObject({
      judgementId: null, reportVersion: null, outcome: 'occurred', brierScore: 0.09,
    })
    db.close()
  })

  it('never replaces securities with a partial snapshot', () => {
    const { db } = database()
    expect(() => db.replaceSecuritySnapshot([])).toThrow('不完整')
    expect(db.securityCount()).toBe(0)
    db.close()
  })
})
