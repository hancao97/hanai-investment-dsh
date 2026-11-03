import { describe, expect, it } from 'vitest'
import {
  analyzeTradingDay,
  buildContext,
  buildDragonTiger,
  buildLimitPools,
  buildThemes,
} from '../src/index.ts'
import { makeFullInput } from './fixtures.ts'

describe('builders · 完整输入', () => {
  it('构建上下文并映射指数、成交额与沪市融资余额', () => {
    const context = buildContext(makeFullInput())

    expect(context.status).toBe('complete')
    expect(context.tradeDate).toBe('2026-10-21')
    expect(context.indices).toHaveLength(6)
    expect(context.indices[0]).toEqual({
      code: 'sh000001',
      name: '上证指数',
      price: 3240.2,
      changePct: 1.2,
      amount: 3500,
    })
    expect(context.trend?.code).toBe('sh000001')
    expect(context.trend?.prevClose).toBe(3200)
    expect(context.trend?.points).toHaveLength(2)
    expect(context.trend?.points[0]?.avgPrice).toBe(3200.8)
    expect(context.trends?.map((item) => item.code)).toEqual(['sh000001'])
    expect(context.turnover).toEqual({
      amount: 12000,
      previousAmount: 11000,
      previousTradeDate: null,
      changePct: 9.1,
    })
    expect(context.margin).toEqual({
      tradeDate: '2026-10-21',
      total: 15000,
      previousTotal: 14800,
      change: 200,
      changePct: 1.35,
      marketTotal: 24500,
      marketPreviousTotal: 24300,
      marketChange: 200,
      marketChangePct: 0.82,
    })
    expect(context.sources.map((item) => item.state)).toEqual(['fresh', 'fresh', 'fresh', 'fresh'])
  })

  it('涨停梯队每档最多 10 只、count 保留真实总数，统计口径与源项目一致', () => {
    const pools = buildLimitPools(makeFullInput())

    expect(pools.status).toBe('complete')
    expect(pools.stats).toEqual({
      limitUp: 65,
      limitDown: 4,
      broken: 15,
      sealRate: 81.3,
      breakRate: 18.8,
      firstBoard: 55,
      lianban: 10,
      maxBoard: 5,
      promotionRate: 33.3,
    })

    const top = pools.ladder.find((group) => group.board === 5)
    expect(top?.count).toBe(2)
    expect(top?.label).toBe('5板')

    const first = pools.ladder.find((group) => group.board === 1)
    expect(first?.count).toBe(55)
    expect(first?.stocks).toHaveLength(10)
    expect(first?.stocks[0]?.boardCount).toBe(1)
    expect(first?.stocks[0]?.theme).toBe('机器人')

    expect(pools.yesterdayPerformance).toEqual({
      sample: 30,
      promoted: 10,
      avgChangePct: 0.67,
      medianChangePct: 0,
      upRate: 33.3,
    })
  })

  it('题材按涨停原因取前 8、每个题材最多 3 个龙头；驱动榜保留源项目前 12', () => {
    const themes = buildThemes(makeFullInput())

    expect(themes.status).toBe('complete')
    expect(themes.themes).toHaveLength(8)
    expect(themes.themes[0]).toEqual({
      name: '机器人',
      count: 7,
      maxBoard: 5,
      leaders: ['股票000', '股票010', '股票020'],
    })
    for (const theme of themes.themes) expect(theme.leaders.length).toBeLessThanOrEqual(3)
    expect(themes.drives).toHaveLength(10)
    expect(themes.drives[0]?.tag).toBe('机器人')
  })

  it('龙虎榜只保留净买额前 20', () => {
    const dragon = buildDragonTiger(makeFullInput())

    expect(dragon.status).toBe('complete')
    expect(dragon.entries).toHaveLength(15)
    expect(dragon.entries[0]).toMatchObject({ code: '600200', netBuy: 1.5, reason: '上榜原因0' })
    expect(dragon.entries.at(-1)).toMatchObject({ code: '600214', netBuy: 0.8 })
  })

  it('覆盖率：总池 65 只，相对强度最多覆盖 60 只', () => {
    const analysis = analyzeTradingDay(makeFullInput())

    expect(analysis.coverage).toEqual({ analyzed: 60, total: 65, skipped: 5 })
  })
})

describe('builders · 关键来源缺失', () => {
  it('炸板池缺失时 status=partial，炸板与封板率均为 null 而不是 0', () => {
    const input = { ...makeFullInput(), broken: null }
    const pools = buildLimitPools(input)

    expect(pools.status).toBe('partial')
    expect(pools.stats.broken).toBeNull()
    expect(pools.stats.sealRate).toBeNull()
    expect(pools.stats.breakRate).toBeNull()
    expect(pools.stats.limitUp).toBe(65)
    expect(pools.sources.find((item) => item.key === 'broken')?.state).toBe('unavailable')
  })

  it('涨停原因缺失时题材为空数组、梯队原因留 null', () => {
    const input = { ...makeFullInput(), limitReason: null }
    const themes = buildThemes(input)
    const pools = buildLimitPools(input)

    expect(themes.status).toBe('partial')
    expect(themes.themes).toEqual([])
    expect(themes.drives).toEqual([])
    expect(pools.ladder[0]?.stocks.every((stock) => stock.reason === null)).toBe(true)
  })

  it('龙虎榜缺失时 entries 为空数组且 status=partial', () => {
    const dragon = buildDragonTiger({ ...makeFullInput(), dragonTiger: null })

    expect(dragon.status).toBe('partial')
    expect(dragon.entries).toEqual([])
  })

  it('融资余额缺失时 margin=null；仅指数可用时成交额回退指数口径', () => {
    const input = { ...makeFullInput(), marginSH: null, marketHistory: null }
    const context = buildContext(input)

    expect(context.status).toBe('partial')
    expect(context.margin).toBeNull()
    expect(context.turnover).toEqual({
      amount: 6000,
      previousAmount: null,
      previousTradeDate: null,
      changePct: null,
    })
  })

  it('跌停池缺失时 limitDown 为 null', () => {
    const pools = buildLimitPools({ ...makeFullInput(), limitDown: null })

    expect(pools.stats.limitDown).toBeNull()
    expect(pools.status).toBe('partial')
  })
})
