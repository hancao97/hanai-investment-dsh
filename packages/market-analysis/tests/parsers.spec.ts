import { describe, expect, it } from 'vitest'
import {
  parseDragonTiger,
  parseEastmoneyKline,
  parseEastmoneyPool,
  parseEastmoneyTrend,
  parseMarginSH,
  parseTencentKline,
  parseTencentQuotes,
  parseThsLimitReason,
  relativeStrength,
  summarizeBreadth,
} from '../src/index.ts'

function tencentQuote(input: {
  ticker: string
  name: string
  code: string
  price: number
  previousClose: number
  open: number
  updatedAt: string
  change: number
  changePct: number
  high: number
  low: number
  amountWan: number
}): string {
  const fields = new Array<string>(39).fill('0')
  fields[1] = input.name
  fields[2] = input.code
  fields[3] = String(input.price)
  fields[4] = String(input.previousClose)
  fields[5] = String(input.open)
  fields[30] = input.updatedAt
  fields[31] = String(input.change)
  fields[32] = String(input.changePct)
  fields[33] = String(input.high)
  fields[34] = String(input.low)
  fields[37] = String(input.amountWan)
  return `v_${input.ticker}="${fields.join('~')}";`
}

describe('腾讯行情与日 K', () => {
  it('解析指数行情文本（脱敏片段）', () => {
    const source = [
      tencentQuote({
        ticker: 'sh000001', name: '上证指数', code: '000001', price: 3240.2, previousClose: 3210.2, open: 3215.5,
        updatedAt: '20261021153000', change: 30, changePct: 1.2, high: 3250, low: 3205, amountWan: 35000000,
      }),
      tencentQuote({
        ticker: 'sz399001', name: '深证成指', code: '399001', price: 10800.5, previousClose: 10640.1, open: 10680,
        updatedAt: '20261021153000', change: 160.4, changePct: 1.5, high: 10820, low: 10650, amountWan: 25000000,
      }),
    ].join('')

    const rows = parseTencentQuotes(source)

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      ticker: 'sh000001',
      name: '上证指数',
      code: '000001',
      price: 3240.2,
      changePct: 1.2,
      tradeDate: '20261021',
      amountWan: 35000000,
    })
    expect(rows[1]?.change).toBe(160.4)
    expect(() => parseTencentQuotes('not-a-quote')).toThrow('腾讯指数响应为空或字段格式变化')
  })

  it('解析腾讯日 K 与市值', () => {
    const source = JSON.stringify({
      data: {
        sh600000: {
          qfqday: [
            ['2026-10-20', '10.10', '10.50'],
            ['2026-10-21', '10.50', '10.80'],
            ['bad-date', '1', '2'],
          ],
          qt: { sh600000: { '45': '1234.5' } },
        },
      },
    })

    const kline = parseTencentKline(source, 'sh600000')

    expect(kline.rows).toEqual([
      { tradeDate: '20261020', open: 10.1, close: 10.5 },
      { tradeDate: '20261021', open: 10.5, close: 10.8 },
    ])
    expect(kline.marketCap).toBe(1234.5)
  })

  it('计算相对强度', () => {
    expect(relativeStrength([100, 101, 102, 103, 104, 105], [100, 100.5, 101, 101.5, 102, 102.5], 5)).toBe(2.5)
    expect(relativeStrength([100, 105], [100, 102], 5)).toBeNull()
  })
})

describe('东方财富数据', () => {
  it('解析涨跌停池并校验日期', () => {
    const source = JSON.stringify({
      data: {
        tc: 2,
        qdate: 20261021,
        pool: [
          { c: '600000', n: '浦发银行', zdp: 10.01, lbc: 2, hybk: '银行' },
          { c: '600001', n: '邯郸钢铁', zdp: 9.98, lbc: 1, hybk: '钢铁' },
        ],
      },
    })

    const pool = parseEastmoneyPool(source, '20261021')

    expect(pool.total).toBe(2)
    expect(pool.tradeDate).toBe('20261021')
    expect(pool.rows).toHaveLength(2)
    expect(pool.rows[0]?.['hybk']).toBe('银行')
    expect(() => parseEastmoneyPool(source, '20261020')).toThrow('涨跌停池日期不匹配：20261021')
  })

  it('解析指数日线与指数分时', () => {
    const kline = parseEastmoneyKline(JSON.stringify({
      data: {
        klines: [
          '2026-10-20,3200.00,3210.00,3220.00,3190.00,100000,300000000,0.94,0.31,10.00,1.10',
          '2026-10-21,3215.00,3240.20,3250.00,3205.00,120000,360000000,1.40,0.94,30.20,1.20',
        ],
      },
    }))
    expect(kline).toHaveLength(2)
    expect(kline[1]).toMatchObject({ tradeDate: '20261021', close: 3240.2, changePct: 0.94, amount: 360000000 })

    const trend = parseEastmoneyTrend(JSON.stringify({
      data: {
        preClose: 3200,
        trends: [
          '2026-10-21 09:30,3190,3210,3220,3180,100,1000000,3205',
          '2026-10-21 15:00,3210,3240,3250,3200,200,2000000,3220',
        ],
      },
    }), '20261021')
    expect(trend.tradeDate).toBe('20261021')
    expect(trend.preClose).toBe(3200)
    expect(trend.points[0]).toEqual({
      time: '2026-10-21 09:30',
      price: 3210,
      changePct: 0.31,
      volume: 100,
      amount: 1000000,
      average: 3205,
    })
  })

  it('解析龙虎榜并按净买额排序', () => {
    const source = JSON.stringify({
      result: {
        total: 3,
        data: [
          {
            TRADE_DATE: '2026-10-21 00:00:00', SECURITY_CODE: '600001', SECURITY_NAME_ABBR: 'A',
            CHANGE_RATE: 9.9, TURNOVERRATE: 12.3, BILLBOARD_NET_AMT: 150000000,
            BILLBOARD_BUY_AMT: 200000000, BILLBOARD_SELL_AMT: 50000000, EXPLANATION: '涨幅偏离', EXPLAIN: '三日',
          },
          {
            TRADE_DATE: '2026-10-21 00:00:00', SECURITY_CODE: '600002', SECURITY_NAME_ABBR: 'B',
            CHANGE_RATE: 10.0, TURNOVERRATE: 8.1, BILLBOARD_NET_AMT: 250000000,
            BILLBOARD_BUY_AMT: 300000000, BILLBOARD_SELL_AMT: 50000000, EXPLANATION: '换手率', EXPLAIN: '',
          },
          { TRADE_DATE: '2026-10-20 00:00:00', SECURITY_CODE: '600003', SECURITY_NAME_ABBR: 'C' },
        ],
      },
    })

    const dragon = parseDragonTiger(source, '20261021')

    expect(dragon.total).toBe(3)
    expect(dragon.rows.map((row) => row.code)).toEqual(['600002', '600001'])
    expect(dragon.rows[0]).toMatchObject({ netBuy: 2.5, changePct: 10, turnoverRate: 8.1, reason: '换手率' })
  })

  it('解析上交所两融并过滤交易日', () => {
    const source = JSON.stringify({
      pageHelp: {
        total: 5,
        data: [
          { opDate: '2026-10-21', rzye: 123456 },
          { opDate: '2026-10-20', rzye: 999999 },
        ],
      },
    })

    const margin = parseMarginSH(source, '20261021')

    expect(margin.total).toBe(5)
    expect(margin.tradeDate).toBe('20261021')
    expect(margin.rows).toHaveLength(1)
    expect(margin.rows[0]?.['rzye']).toBe(123456)
  })

  it('按完整降序样本汇总涨跌分布', () => {
    const summary = summarizeBreadth([10, 5, 2, 0, -2, -5, -10, -11], 8)

    expect(summary).toMatchObject({ total: 8, upCount: 3, downCount: 4, flatCount: 1 })
    expect(summary.distribution).toEqual({
      up10: 1, up5: 1, up2: 1, up0: 0, flat: 1, down0: 1, down2: 1, down5: 1, down10: 1,
    })
  })
})

describe('同花顺涨停原因', () => {
  it('解析涨停揭秘并换算封单额/封板成功率', () => {
    const source = JSON.stringify({
      status_code: 0,
      data: {
        date: '20261021',
        limit_up_count: 2,
        limit_down_count: 1,
        trade_status: 'closed',
        info: [
          {
            code: '600000', name: '浦发银行', reason_type: '金融', limit_up_type: '换手板',
            high_days: '2天2板', limit_up_suc_rate: 0.75, open_num: 1, order_amount: 123000000, turnover_rate: 3.2,
          },
          { code: '600001', name: '邯郸钢铁', reason_type: '钢铁', limit_up_type: '一字板' },
        ],
      },
    })

    const reason = parseThsLimitReason(source, '20261021')

    expect(reason.tradeDate).toBe('20261021')
    expect(reason.total).toBe(2)
    expect(reason.downLimit).toBe(1)
    expect(reason.tradeStatus).toBe('closed')
    expect(reason.rows[0]).toMatchObject({
      code: '600000',
      reason: '金融',
      boardType: '换手板',
      highDays: '2天2板',
      sealSuccessRate: 75,
      openTimes: 1,
      sealAmount: 1.23,
      turnoverRate: 3.2,
    })
    expect(reason.rows[1]?.sealSuccessRate).toBeNull()
    expect(() => parseThsLimitReason(source, '20261020')).toThrow('同花顺涨停揭秘日期不匹配')
  })
})
