import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Judgement } from '../../contracts/src/index.ts'
import { getMasterPersona } from '../../masters/src/index.ts'
import { ensureHanaiLayout, resolveHanaiPaths } from '../src/paths.ts'
import { ReportStore, ReportValidationError } from '../src/reports.ts'

const roots: string[] = []
const assets = resolve(dirname(fileURLToPath(import.meta.url)), '../../masters/assets')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hanai-dsh-report-'))
  roots.push(root)
  const paths = resolveHanaiPaths(root)
  ensureHanaiLayout(paths)
  return { paths, store: new ReportStore(paths, assets, 100) }
}

const judgement: Judgement = {
  id: 'report-test', secId: '1.600519', code: '600519', stockName: '贵州茅台',
  masterId: 'munger-perspective', masterName: '查理·芒格', masterVersion: 'v1',
  dshSessionId: 'hanai-report-test', reportStatus: 'verifying', turnStatus: 'idle',
  latestReportVersion: null, modelProvider: 'deepseek-official', model: 'deepseek-chat',
  reasoningEffort: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  completedAt: null, errorCode: null, errorMessage: null,
}

describe('ReportStore', () => {
  it('snapshots the master, validates, seals, and idempotently recovers the same version', () => {
    const { store } = fixture()
    const master = getMasterPersona('munger-perspective')!
    const workspace = store.prepareWorkspace(judgement.id, master)
    expect(readFileSync(join(workspace.workspace, 'AGENTS.md'), 'utf8')).toContain('整段 Session')
    const content = `# 贵州茅台逆向研判\n\n${'事实、推断与风险边界。'.repeat(20)}`
    writeFileSync(workspace.workingReport, content)
    const first = store.seal(judgement, 1)
    const recovered = store.seal(judgement, 1)
    expect(recovered).toEqual(first)
    expect(store.read(first.relativePath)).toBe(content)
  })

  it('rejects incomplete model output and paths outside the data root', () => {
    const { store } = fixture()
    const workspace = store.prepareWorkspace(judgement.id, getMasterPersona('munger-perspective')!)
    writeFileSync(workspace.workingReport, '# 太短')
    expect(() => store.validateWorkingReport(judgement.id)).toThrow(ReportValidationError)
    expect(() => store.read('../../etc/passwd')).toThrow('超出')
  })
})
