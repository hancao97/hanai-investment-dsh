import { describe, expect, it } from 'vitest'
import type { Judgement, ResearchFollowUp, ResearchPrediction } from '../../contracts/src/index.ts'
import { analyzeReport, buildWatchResearchCoverage, reportAuditBlockingReasons } from '../src/research.ts'

const base: Judgement = {
  id: 'base',
  secId: '1.600519',
  code: '600519',
  stockName: '贵州茅台',
  masterId: 'munger-perspective',
  masterName: '查理·芒格',
  masterVersion: 'v1',
  dshSessionId: 'session-base',
  reportStatus: 'ready',
  turnStatus: 'idle',
  latestReportVersion: 1,
  modelProvider: 'deepseek',
  model: 'deepseek-chat',
  reasoningEffort: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
  completedAt: '2026-08-10T00:00:00.000Z',
  errorCode: null,
  errorMessage: null,
}

describe('watch research coverage', () => {
  it('prioritizes active work and preserves latest sealed report context', () => {
    const active: Judgement = {
      ...base,
      id: 'active',
      reportStatus: 'generating',
      latestReportVersion: null,
      completedAt: null,
      updatedAt: '2026-08-19T00:00:00.000Z',
    }
    expect(buildWatchResearchCoverage(
      ['1.600519'],
      [base, active],
      new Date('2026-08-20T00:00:00.000Z'),
    )).toEqual([expect.objectContaining({
      secId: '1.600519',
      state: 'active',
      judgementId: 'active',
      latestReportVersion: 1,
      latestReportAt: base.completedAt,
      ageDays: 10,
      reportVersionCount: 1,
    })])
  })

  it('distinguishes current, stale, failed, and uncovered watch items in input order', () => {
    const stale: Judgement = {
      ...base,
      id: 'stale',
      secId: '0.000001',
      completedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const failed: Judgement = {
      ...base,
      id: 'failed',
      secId: '0.000002',
      reportStatus: 'failed',
      latestReportVersion: null,
      completedAt: null,
    }
    const followUps: ResearchFollowUp[] = [
      {
        id: 'overdue', secId: '1.600519', judgementId: base.id, reportVersion: 1,
        title: '复核现金流', dueDate: '2026-08-19', status: 'open',
        createdAt: '2026-08-01T00:00:00.000Z', completedAt: null,
      },
      {
        id: 'future', secId: '1.600519', judgementId: base.id, reportVersion: 1,
        title: '等待中报', dueDate: '2026-09-01', status: 'open',
        createdAt: '2026-08-01T00:00:00.000Z', completedAt: null,
      },
    ]
    const predictions: ResearchPrediction[] = [
      {
        id: 'due-prediction', secId: '1.600519', judgementId: base.id, reportVersion: 1,
        statement: '现金流改善', resolutionCriteria: '以下季法定报告为准', probabilityPct: 70,
        dueDate: '2026-08-20', outcome: 'pending', brierScore: null,
        createdAt: '2026-08-01T00:00:00.000Z', resolvedAt: null,
      },
      {
        id: 'future-prediction', secId: '1.600519', judgementId: base.id, reportVersion: 1,
        statement: '毛利率稳定', resolutionCriteria: '以年度法定报告为准', probabilityPct: 60,
        dueDate: '2026-09-30', outcome: 'pending', brierScore: null,
        createdAt: '2026-08-01T00:00:00.000Z', resolvedAt: null,
      },
      {
        id: 'resolved-prediction', secId: '1.600519', judgementId: base.id, reportVersion: 1,
        statement: '已判定命题', resolutionCriteria: '已判定', probabilityPct: 50,
        dueDate: '2026-08-01', outcome: 'occurred', brierScore: 0.25,
        createdAt: '2026-07-01T00:00:00.000Z', resolvedAt: '2026-08-02T00:00:00.000Z',
      },
    ]
    const result = buildWatchResearchCoverage(
      ['1.600519', '0.000001', '0.000002', '0.000003'],
      [base, stale, failed],
      new Date('2026-08-20T00:00:00.000Z'),
      90,
      followUps,
      predictions,
    )
    expect(result.map(item => item.state)).toEqual(['current', 'stale', 'failed', 'uncovered'])
    expect(result[1]?.ageDays).toBe(231)
    expect(result[0]).toEqual(expect.objectContaining({
      openFollowUpCount: 2, overdueFollowUpCount: 1, nextFollowUpDueDate: '2026-08-19',
      pendingPredictionCount: 2, duePredictionCount: 1, nextPredictionDueDate: '2026-08-20',
    }))
    expect(result[3]).toEqual(expect.objectContaining({ judgementId: null, reportVersionCount: 0 }))
  })
})

describe('report structural audit', () => {
  it('scores an auditable report and extracts unique source references', () => {
    const report = `# 公司研判

## 执行摘要
结论先行。

## 信息时点与来源
研究截止日期：2026-08-20。

## 证据账本
| 关键主张 | 类型 | 来源链接 | 来源日期 | 置信度 |
| --- | --- | --- | --- | --- |
| 收入增长 | 事实 | [年报](https://example.com/annual) | 2026-03-31 | 高 |
| 份额提升 | 推断 | [公告](https://disclosure.example.cn/a) | 2026-08-01 | 中 |
| 成本下降 | 假设 | [行业数据](https://industry.example.org/data) | 2026-07-01 | 低 |

## 反方证据与核心风险
需求可能下滑。

## 乐观、基准、悲观情景
- 乐观：份额提升。
- 基准：保持稳定。
- 悲观：需求下滑，判断失效。

## 待持续验证清单
- [ ] 下一季现金流。
`
    const audit = analyzeReport(report)
    expect(audit.rating).toBe('strong')
    expect(audit.score).toBe(100)
    expect(audit.sources.map(source => source.domain)).toEqual([
      'example.com', 'disclosure.example.cn', 'industry.example.org',
    ])
    expect(audit.checks.every(check => check.state === 'met')).toBe(true)
    expect(reportAuditBlockingReasons(audit)).toEqual([])
    expect(audit.evidence).toEqual([
      {
        claim: '收入增长', kind: 'fact', sourceLabel: '年报', sourceUrl: 'https://example.com/annual',
        sourceDate: '2026-03-31', confidence: 'high',
      },
      {
        claim: '份额提升', kind: 'inference', sourceLabel: '公告', sourceUrl: 'https://disclosure.example.cn/a',
        sourceDate: '2026-08-01', confidence: 'medium',
      },
      {
        claim: '成本下降', kind: 'assumption', sourceLabel: '行业数据', sourceUrl: 'https://industry.example.org/data',
        sourceDate: '2026-07-01', confidence: 'low',
      },
    ])
  })

  it('does not mistake length for traceability', () => {
    const audit = analyzeReport(`# 很长的观点\n\n${'只有判断，没有日期、来源或反证。'.repeat(100)}`)
    expect(audit.rating).toBe('thin')
    expect(audit.stats.characters).toBeGreaterThan(500)
    expect(audit.sources).toEqual([])
    expect(audit.evidence).toEqual([])
    expect(audit.checks.find(check => check.id === 'sources')?.state).toBe('missing')
    expect(reportAuditBlockingReasons(audit)).toEqual(expect.arrayContaining([
      '信息时点', '来源可追溯', '证据账本', '情景与失效条件', '持续跟踪清单',
    ]))
  })

  it('does not accept an empty evidence table or incomplete evidence rows as a complete ledger', () => {
    const empty = analyzeReport(`# 研判

## 执行摘要
结论。

## 信息时点与来源
研究截止日期：2026-08-20。[年报](https://example.com/report)

## 证据账本
| 关键主张 | 类型 | 来源 | 日期 | 置信度 |
| --- | --- | --- | --- | --- |

## 反方证据与核心风险
需求下滑。

## 乐观、基准、悲观情景
- 乐观：增长。
- 基准：稳定。
- 悲观：下滑。

## 待持续验证清单
- 复核现金流。
`)
    expect(empty.evidence).toEqual([])
    expect(empty.checks.find(check => check.id === 'evidence-ledger')?.state).toBe('missing')
    expect(reportAuditBlockingReasons(empty)).toContain('证据账本至少需要一条边界、来源链接、日期和置信度完整的主张')

    const incomplete = analyzeReport(`# 研判

## 证据账本
| 关键主张 | 类型 | 来源 | 日期 | 置信度 |
| --- | --- | --- | --- | --- |
| 利润改善 | 推断 | 公司年报 | 2026-03-31 | 中 |
`)
    expect(incomplete.evidence[0]).toMatchObject({
      claim: '利润改善', kind: 'inference', sourceLabel: '公司年报', sourceUrl: null,
      sourceDate: '2026-03-31', confidence: 'medium',
    })
    expect(incomplete.checks.find(check => check.id === 'evidence-ledger')?.state).toBe('partial')
  })

  it('requires a concrete, valid source date before evidence can pass the seal gate', () => {
    const audit = analyzeReport(`# 研判

## 证据账本
| 关键主张 | 类型 | 来源 | 日期 | 置信度 |
| --- | --- | --- | --- | --- |
| 利润改善 | 事实 | [公司年报](https://example.com/report) | 近期 | 高 |
| 收入增长 | 事实 | [公司公告](https://example.com/disclosure) | 2026-02-31 | 高 |
`)
    expect(audit.evidence.map(item => item.sourceDate)).toEqual(['近期', '2026-02-31'])
    expect(audit.checks.find(check => check.id === 'evidence-ledger')?.state).toBe('partial')
    expect(reportAuditBlockingReasons(audit)).toContain('证据账本至少需要一条边界、来源链接、日期和置信度完整的主张')

    const valid = analyzeReport(`# 研判

## 证据账本
| 关键主张 | 类型 | 来源 | 日期 | 置信度 |
| --- | --- | --- | --- | --- |
| 利润改善 | 事实 | [公司年报](https://example.com/report) | 2026年2月28日 | 高 |
`)
    expect(valid.checks.find(check => check.id === 'evidence-ledger')?.state).toBe('met')
  })
})
