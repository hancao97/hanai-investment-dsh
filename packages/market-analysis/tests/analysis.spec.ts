import { describe, expect, it } from 'vitest'
import { analyzeTradingDay } from '../src/index.ts'
import { makeFullInput } from './fixtures.ts'

describe('analyzeTradingDay · 完整输入', () => {
  it('四轴、主线分级、赚钱效应与结论文案', () => {
    const analysis = analyzeTradingDay(makeFullInput())

    expect(analysis.status).toBe('complete')
    expect(analysis.tradeDate).toBe('2026-10-21')
    expect(analysis.axes.map((axis) => axis.label)).toEqual(['市场环境', '周期位置', '情绪阶段', '预期 × 现实'])
    expect(analysis.axes[0]).toMatchObject({ key: 'marketEnvironment', value: '偏强/牛市策略', missing: [] })
    expect(analysis.axes[1]).toMatchObject({ key: 'cyclePosition', value: '上升周期 · 通', missing: [] })
    expect(analysis.axes[2]).toMatchObject({ key: 'emotionStage', value: '主升', missing: [] })
    expect(analysis.axes[3]).toMatchObject({ key: 'expectationReality', value: '分歧预期+强现实', missing: [] })

    expect(analysis.verdict.stage).toBe('主升')
    expect(analysis.verdict.position).toBe('20–40%，聚焦主线核心，单票不得超过总仓位 50%')
    expect(analysis.verdict.temperature).toBe('赚钱效应扩散（71/100）')
    expect(analysis.verdict.confidence).toBe(1)
    expect(analysis.verdict.gaps).toEqual([])
    expect(analysis.verdict.summary).toContain('情绪阶段“主升”')
    expect(analysis.verdict.summary).toContain('综合为“赚钱效应扩散”')
    expect(analysis.verdict.summary).toContain('预期现实组合为“分歧预期+强现实”')
    expect(analysis.missingReasons).toEqual([])
  })

  it('主线按连板高度/家数分级，龙头与中军角色被区分', () => {
    const analysis = analyzeTradingDay(makeFullInput())

    expect(analysis.mainlines).toHaveLength(5)
    expect(analysis.mainlines[0]).toMatchObject({
      name: '机器人',
      grade: 'A',
      score: 80,
      stage: '主升梯队',
      height: 5,
      width: 37,
      depth: null,
    })
    expect(analysis.mainlines[0]?.evidence).toContain('37 家涨停')

    expect(analysis.leaders).toHaveLength(15)
    expect(analysis.leaders[0]).toMatchObject({ code: '600000', role: 'leader', boardCount: 5, rs5: -2 })
    expect(analysis.centerCandidates).toHaveLength(3)
    expect(analysis.centerCandidates[0]).toMatchObject({ code: '600010', role: 'center', marketCap: 2000 })
    expect(analysis.roles.some((role) => role.role === 'leader')).toBe(true)
    expect(analysis.roles.some((role) => role.role === 'center')).toBe(true)
    expect(analysis.roles.some((role) => role.role === 'follow')).toBe(true)
    expect(new Set(analysis.roles.map((role) => role.code)).size).toBe(analysis.roles.length)
  })

  it('三套次日剧本与 coverage 完整输出', () => {
    const analysis = analyzeTradingDay(makeFullInput())

    expect(analysis.scenarios.map((item) => item.kind)).toEqual(['above', 'match', 'below'])
    expect(analysis.scenarios.map((item) => item.title)).toEqual(['超预期', '符合预期', '低于预期'])
    expect(analysis.scenarios[0]?.response).toBe('按仓位上限递进，只做核心分歧转一致')
    expect(analysis.scenarios[1]?.trigger).toBe('指数、赚钱效应和主线梯队维持当前结构')
    expect(analysis.coverage).toEqual({ analyzed: 60, total: 65, skipped: 5 })
  })
})

describe('analyzeTradingDay · 数据缺口', () => {
  it('缺失来源进入 missingReasons/gaps，组件不补 0', () => {
    const input = { ...makeFullInput(), breadth: null, broken: null, limitReason: null }
    const analysis = analyzeTradingDay(input)

    expect(analysis.status).toBe('partial')
    expect(analysis.missingReasons).toEqual(expect.arrayContaining(['breadth', 'broken', 'limitReason']))
    expect(analysis.verdict.gaps).toContain('部分数据不可用：breadth、broken、limitReason，结论已降级')
    expect(analysis.axes[0]?.missing).toEqual(expect.arrayContaining(['breadth']))
    expect(analysis.axes[0]?.evidence.join(' ')).not.toContain('涨跌广度')
    expect(analysis.mainlines[0]?.missing).toEqual(['涨停原因'])
    expect(analysis.verdict.stage).toBe('主升')
  })

  it('全部输入缺失时仍返回结构化结论', () => {
    const analysis = analyzeTradingDay({})

    expect(analysis.status).toBe('partial')
    expect(analysis.missingReasons).toHaveLength(7)
    expect(analysis.axes).toHaveLength(4)
    expect(analysis.mainlines).toEqual([])
    expect(analysis.leaders).toEqual([])
    expect(analysis.centerCandidates).toEqual([])
    expect(analysis.roles).toEqual([])
    expect(analysis.verdict.stage).toBe('数据不足')
    expect(analysis.verdict.position).toBe('0%，关键数据不足，不形成仓位判断')
    expect(analysis.verdict.temperature).toBe('数据不足')
    expect(analysis.verdict.confidence).toBeLessThanOrEqual(0.49)
    expect(analysis.coverage).toEqual({ analyzed: 0, total: 0, skipped: 0 })
    expect(analysis.scenarios).toHaveLength(3)
  })
})
