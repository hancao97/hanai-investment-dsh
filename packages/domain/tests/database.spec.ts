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
    db.close()
  })

  it('never replaces securities with a partial snapshot', () => {
    const { db } = database()
    expect(() => db.replaceSecuritySnapshot([])).toThrow('不完整')
    expect(db.securityCount()).toBe(0)
    db.close()
  })
})
