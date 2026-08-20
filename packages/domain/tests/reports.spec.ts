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

function validReport(title = '贵州茅台逆向研判') {
  return `# ${title}

## 执行摘要
结论先行，并区分事实、推断和假设。

## 信息时点与来源
研究截止日期：2026-08-20。[公司年报](https://example.com/annual-report)

## 证据账本
| 关键主张 | 类型 | 来源 | 日期 | 置信度 |
| --- | --- | --- | --- | --- |
| 收入稳定 | 事实 | [公司年报](https://example.com/annual-report) | 2026-03-31 | 高 |

## 反方证据与核心风险
需求下降会使当前判断失效。

## 乐观、基准、悲观情景
- 乐观：份额提升。
- 基准：经营稳定。
- 悲观：需求下滑。

## 待持续验证清单
- [ ] 复核下一季度现金流。

${'事实、推断、风险与验证条件。'.repeat(20)}`
}

describe('ReportStore', () => {
  it('snapshots the master, validates, seals, and idempotently recovers the same version', () => {
    const { store } = fixture()
    const master = getMasterPersona('munger-perspective')!
    const workspace = store.prepareWorkspace(judgement.id, master)
    const instructions = readFileSync(join(workspace.workspace, 'AGENTS.md'), 'utf8')
    expect(instructions).toContain('# Hanai Worth · 值见 研判工作区')
    expect(instructions).toContain('整段 Session')
    const content = validReport()
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

  it('rejects long prose that misses the trustworthy report structure', () => {
    const { store } = fixture()
    const workspace = store.prepareWorkspace(judgement.id, getMasterPersona('munger-perspective')!)
    writeFileSync(workspace.workingReport, `# 只有长度的报告\n\n${'这是一段没有日期、来源、反证或跟踪清单的观点。'.repeat(30)}`)
    expect(() => store.validateWorkingReport(judgement.id)).toThrow(/可信研究结构门/)
    try {
      store.validateWorkingReport(judgement.id)
    } catch (error) {
      expect(error).toMatchObject({ code: 'report-quality-gate' })
    }
  })

  it('rejects a decorative evidence table with no traceable claims', () => {
    const { store } = fixture()
    const workspace = store.prepareWorkspace(judgement.id, getMasterPersona('munger-perspective')!)
    const withoutEvidence = validReport().replace(
      '| 收入稳定 | 事实 | [公司年报](https://example.com/annual-report) | 2026-03-31 | 高 |',
      '',
    )
    writeFileSync(workspace.workingReport, withoutEvidence)
    expect(() => store.validateWorkingReport(judgement.id)).toThrow(/至少需要一条/)
  })
})
