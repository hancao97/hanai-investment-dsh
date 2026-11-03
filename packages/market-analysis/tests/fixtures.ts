/** 内联测试夹具：不访问网络，字段形状与上游解析结果一致。 */
import type {
  RawDragonTigerRow,
  RawLimitPool,
  RawLimitReason,
  RawLeaderStrengthRow,
  RawMarginRow,
  RawPoolRow,
  RawReasonRow,
  RawTencentQuoteRow,
  TradingDayRawInput,
} from '../src/types.ts'

const TRADE_DATE = '20261021'
const UPDATED_AT = '20261021153000'

const codeAt = (index: number): string => String(600000 + index)

interface PoolSeed {
  code: string
  board: number
  hybk: string
  amount: number
}

function buildPoolRows(): RawPoolRow[] {
  const seeds: PoolSeed[] = []
  for (let index = 0; index < 2; index += 1) seeds.push({ code: codeAt(index), board: 5, hybk: '机器人', amount: (index + 1) * 4e8 })
  for (let index = 2; index < 5; index += 1) seeds.push({ code: codeAt(index), board: 3, hybk: '半导体', amount: (index + 1) * 4e8 })
  for (let index = 5; index < 10; index += 1) seeds.push({ code: codeAt(index), board: 2, hybk: '算力', amount: (index + 1) * 4e8 })
  for (let index = 10; index < 45; index += 1) seeds.push({ code: codeAt(index), board: 1, hybk: '机器人', amount: (index + 1) * 4e8 })
  for (let index = 45; index < 55; index += 1) seeds.push({ code: codeAt(index), board: 1, hybk: '半导体', amount: (index + 1) * 4e8 })
  for (let index = 55; index < 60; index += 1) seeds.push({ code: codeAt(index), board: 1, hybk: '算力', amount: (index + 1) * 4e8 })
  for (let index = 60; index < 62; index += 1) seeds.push({ code: codeAt(index), board: 1, hybk: '农业', amount: (index + 1) * 4e8 })
  for (let index = 62; index < 65; index += 1) seeds.push({ code: codeAt(index), board: 1, hybk: '其他', amount: (index + 1) * 4e8 })

  return seeds.map((seed) => {
    const index = Number(seed.code) - 600000
    return {
      c: seed.code,
      n: `股票${String(index).padStart(3, '0')}`,
      p: 10 + index / 100,
      zdp: 10,
      amount: seed.amount,
      hs: 5,
      tshare: (index === 10 ? 2000 : 100 + index) * 1e8,
      lbc: seed.board,
      fbt: '093000',
      lbt: '143000',
      hybk: seed.hybk,
      zttj: { days: seed.board, ct: seed.board },
    }
  })
}

function buildReasonRows(pool: RawPoolRow[]): RawReasonRow[] {
  const tags = ['机器人', '减速器', '人形机器人', '芯片', '光刻机', '算力', '液冷', '服务器', '农业', '并购重组']
  return pool.map((row, index) => ({
    code: String(row.c),
    name: String(row.n),
    reason: tags[index % tags.length] ?? '机器人',
    boardType: '换手板',
    highDays: `${Number(row.lbc)}天${Number(row.lbc)}板`,
    sealSuccessRate: 70,
    openTimes: 1,
    sealAmount: 1.2,
    turnoverRate: 5,
  }))
}

export function makePool(
  source: string,
  total: number,
  rows: RawPoolRow[],
  tradeDate = TRADE_DATE,
): RawLimitPool {
  return { source, tradeDate, total, rows }
}

function buildIndices(): import('../src/types.ts').RawTencentQuotes {
  const rows: RawTencentQuoteRow[] = [
    ['sh000001', '上证指数', '000001', 3240.2, 1.2, 3.5e7],
    ['sz399001', '深证成指', '399001', 10800.5, 1.5, 2.5e7],
    ['sz399006', '创业板指', '399006', 2200.1, 2.1, 1.2e7],
    ['sh000300', '沪深300', '000300', 3900.8, 1.1, 8e6],
    ['sh000688', '科创50', '000688', 980.4, 0.9, 6e6],
    ['bj899050', '北证50', '899050', 1200.6, 0.5, 2e6],
  ].map(([ticker, name, code, price, changePct, amountWan]) => ({
    ticker: String(ticker),
    name: String(name),
    code: String(code),
    price: Number(price),
    previousClose: Number(price) - 30,
    open: Number(price) - 20,
    updatedAt: UPDATED_AT,
    tradeDate: TRADE_DATE,
    change: 30,
    changePct: Number(changePct),
    high: Number(price) + 10,
    low: Number(price) - 40,
    amountWan: Number(amountWan),
  }))
  return {
    source: '腾讯财经',
    tradeDate: TRADE_DATE,
    rows,
    amount: 6000,
    indexChange: 1.2,
  }
}

function buildYesterday(): RawLimitPool {
  const rows: RawPoolRow[] = []
  for (let index = 0; index < 10; index += 1) {
    rows.push({ c: codeAt(index), n: `昨日${index}`, zdp: 6 })
  }
  for (let index = 0; index < 20; index += 1) {
    rows.push({ c: String(600100 + index), n: `昨日其他${index}`, zdp: index < 10 ? -4 : 0 })
  }
  return makePool('东方财富昨日涨停池', 30, rows)
}

function buildDragonTigerRows(): RawDragonTigerRow[] {
  return Array.from({ length: 15 }, (_, index) => ({
    code: String(600200 + index),
    name: `龙虎${index}`,
    changePct: round2(5 - index * 0.2),
    turnoverRate: round2(10 + index),
    netBuy: round2(1.5 - index * 0.05),
    buyAmount: round2(2 - index * 0.05),
    sellAmount: round2(0.5),
    reason: `上榜原因${index}`,
    note: '',
  }))
}

function round2(value: number): number {
  return Number(value.toFixed(2))
}

function buildLeaderStrength(pool: RawPoolRow[]): import('../src/types.ts').RawLeaderStrength {
  const rows: RawLeaderStrengthRow[] = pool.map((row) => {
    const index = Number(row.c) - 600000
    const core = index === 10
    return {
      code: String(row.c),
      name: String(row.n),
      marketCap: core ? 2000 : 100 + index,
      rs5: core ? 1 : index % 5 - 2,
      rs20: core ? 4 : index % 7 - 3,
    }
  })
  return {
    source: '腾讯财经',
    tradeDate: '',
    total: rows.length,
    rows,
    byCode: Object.fromEntries(rows.map((row) => [row.code, row])),
  }
}

export function makeFullInput(): TradingDayRawInput {
  const limitUp = buildPoolRows()
  const reasonRows = buildReasonRows(limitUp)
  const marginRows: RawMarginRow[] = [
    { opDate: TRADE_DATE, rzye: 6e11 },
    { opDate: TRADE_DATE, rzye: 6e11 },
    { opDate: TRADE_DATE, rzye: 3e11 },
  ]
  const limitReason: RawLimitReason = {
    source: '同花顺涨停揭秘',
    tradeDate: TRADE_DATE,
    total: limitUp.length,
    downLimit: 4,
    tradeStatus: 'closed',
    rows: reasonRows,
  }
  return {
    indices: buildIndices(),
    breadth: {
      source: '东方财富',
      total: 5000,
      upCount: 3000,
      downCount: 1800,
      flatCount: 200,
      distribution: { up10: 50, up5: 100, up2: 250, up0: 2600, flat: 200, down0: 1200, down2: 350, down5: 180, down10: 70 },
    },
    limitUp: makePool('东方财富涨停池', limitUp.length, limitUp),
    broken: makePool('东方财富炸板池', 15, []),
    limitDown: makePool('东方财富跌停池', 4, []),
    yesterday: buildYesterday(),
    limitReason,
    dragonTiger: {
      source: '东方财富龙虎榜',
      tradeDate: TRADE_DATE,
      total: 15,
      rows: buildDragonTigerRows(),
    },
    marginSH: {
      source: '上交所（仅沪市）',
      tradeDate: TRADE_DATE,
      total: 3,
      rows: marginRows,
      balance: 15000,
      previousBalance: 14800,
      previousTradeDate: '20261020',
      change: 200,
      changePct: 1.35,
    },
    marginAll: {
      source: '东方财富两融数据',
      tradeDate: TRADE_DATE,
      balance: 24500,
      previousBalance: 24300,
      change: 200,
      changePct: 0.82,
    },
    leaderStrength: buildLeaderStrength(limitUp),
    marketHistory: {
      source: '东方财富指数日线',
      tradeDate: TRADE_DATE,
      amount: 12000,
      previousAmount: 11000,
      amountChangePct: 9.1,
    },
    trend: {
      source: '东方财富指数分时',
      tradeDate: TRADE_DATE,
      preClose: 3200,
      points: [
        { time: '2026-10-21 09:30', price: 3201.5, changePct: 0.05, volume: 1000, amount: 1e8, average: 3200.8 },
        { time: '2026-10-21 15:00', price: 3240.2, changePct: 1.26, volume: 2000, amount: 2e8, average: 3220.1 },
      ],
    },
    indexTrends: null,
  }
}
