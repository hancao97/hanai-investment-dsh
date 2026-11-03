import { describe, expect, it } from 'vitest'
import type { HttpResponse } from '../../src/http.ts'
import { TradingDayProvider } from '../../src/providers/trading-day.ts'
import { FakeClock, HandlerHttpClient, jsonResponse } from '../helpers.ts'

const TRADE_DATE = '20261021'
const PREVIOUS_DATE = '20261020'
const CLOCK_AT = Date.UTC(2026, 9, 21, 7, 0, 0)

const INDEX_TICKERS = ['sh000001', 'sz399001', 'sz399006', 'sh000300', 'sh000688', 'bj899050']

function quoteBody(date = TRADE_DATE, amountWan = 3.5e7): string {
  return INDEX_TICKERS.map((ticker, index) => {
    const fields = new Array<string>(50).fill('')
    fields[0] = '1'
    fields[1] = `${ticker}指数`
    fields[2] = ticker.slice(2)
    fields[3] = String(3200 + index)
    fields[4] = String(3190 + index)
    fields[5] = String(3195 + index)
    fields[30] = `${date}150000`
    fields[31] = '10'
    fields[32] = '1.2'
    fields[33] = String(3210 + index)
    fields[34] = String(3180 + index)
    fields[37] = String(amountWan)
    return `v_${ticker}="${fields.join('~')}";`
  }).join('\n')
}

function poolBody(date: string, total: number, rows: unknown[]): unknown {
  return { data: { tc: total, qdate: date, pool: rows } }
}

function poolRow(index: number, board: number): Record<string, unknown> {
  return {
    c: String(600000 + index),
    n: `股票${String(index).padStart(3, '0')}`,
    p: 10,
    zdp: 10,
    amount: (65 - index) * 1e8,
    hs: 5,
    tshare: 100 * 1e8,
    lbc: board,
    fbt: '093000',
    lbt: '143000',
    hybk: board >= 3 ? '机器人' : '半导体',
  }
}

function limitUpRows(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (let index = 0; index < 65; index += 1) {
    const board = index < 2 ? 5 : index < 5 ? 3 : index < 10 ? 2 : 1
    rows.push(poolRow(index, board))
  }
  return rows
}

function reasonBody(rows: Record<string, unknown>[], date = TRADE_DATE): unknown {
  return {
    status_code: 0,
    status_msg: 'ok',
    data: {
      date,
      limit_up_count: rows.length,
      limit_down_count: 2,
      trade_status: 'closed',
      info: rows.map((row, index) => ({
        code: row['c'],
        name: row['n'],
        reason_type: index % 2 === 0 ? '机器人' : '半导体',
        limit_up_type: '换手板',
        high_days: `${String(row['lbc'])}天${String(row['lbc'])}板`,
        limit_up_suc_rate: 0.7,
        open_num: 1,
        order_amount: 1.2e8,
        turnover_rate: 5,
      })),
    },
  }
}

function dragonTigerBody(date = TRADE_DATE): unknown {
  return {
    result: {
      total: 15,
      data: Array.from({ length: 15 }, (_, index) => ({
        TRADE_DATE: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)} 00:00:00`,
        SECURITY_CODE: String(601000 + index),
        SECURITY_NAME_ABBR: `龙虎${index}`,
        CHANGE_RATE: 5 - index * 0.2,
        TURNOVERRATE: 10 + index,
        BILLBOARD_NET_AMT: (2 - index * 0.1) * 1e8,
        BILLBOARD_BUY_AMT: 3e8,
        BILLBOARD_SELL_AMT: 1e8,
        EXPLANATION: `上榜原因${index}`,
        EXPLAIN: '',
      })),
    },
  }
}

function marginBody(date: string): unknown {
  return {
    pageHelp: {
      total: 500,
      data: Array.from({ length: 500 }, () => ({ opDate: date, rzye: 1e8 })),
    },
  }
}

function klineBody(secid: string): unknown {
  const rows = secid === '1.000001' || secid === '0.399001'
    ? [
        `${PREVIOUS_DATE},3200,3230,3240,3190,100,550000000000,1.5,0.9,30,1.2`,
        `${TRADE_DATE},3230,3240,3250,3220,100,600000000000,1.2,1.2,10,1.1`,
      ]
    : []
  return { data: { klines: rows } }
}

function trendBody(date = '2026-10-21'): unknown {
  return {
    data: {
      preClose: 3200,
      trends: [
        `${date} 09:30,3200,3201,3202,3199,1000,100000000,3200.5`,
        `${date} 15:00,3201,3240,3241,3198,2000,200000000,3220.1`,
      ],
    },
  }
}

function tencentKlineBody(ticker: string): unknown {
  const bars = Array.from({ length: 25 }, (_, index) => [
    `2026-09-${String(index + 1).padStart(2, '0')}`,
    10 + index * 0.1,
    10 + index * 0.12,
  ])
  return {
    data: {
      [ticker]: {
        qfqday: bars,
        qt: { [ticker]: { 45: '2000' } },
      },
    },
  }
}

function createProvider(
  handler: (url: string) => HttpResponse | Promise<HttpResponse>,
  options: { clock?: FakeClock; cacheTtlMs?: number } = {},
): {
  provider: TradingDayProvider
  http: HandlerHttpClient
  clock: FakeClock
} {
  const http = new HandlerHttpClient(handler)
  const clock = options.clock ?? new FakeClock(CLOCK_AT)
  const provider = new TradingDayProvider(http, {
    clock,
    ...(options.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }),
  })
  return { provider, http, clock }
}

function healthyHandler(url: string): HttpResponse {
  if (url.includes('qt.gtimg.cn')) return { status: 200, body: quoteBody() }
  if (url.includes('getTopicZTPool')) return jsonResponse(poolBody(TRADE_DATE, 65, limitUpRows()))
  if (url.includes('getTopicZBPool')) return jsonResponse(poolBody(TRADE_DATE, 5, []))
  if (url.includes('getTopicDTPool')) return jsonResponse(poolBody(TRADE_DATE, 2, []))
  if (url.includes('getYesterdayZTPool')) {
    return jsonResponse(poolBody(TRADE_DATE, 3, [
      { c: '600000', n: '股票000', zdp: 6 },
      { c: '600001', n: '股票001', zdp: -3 },
      { c: '600002', n: '股票002', zdp: 0 },
    ]))
  }
  if (url.includes('getTopicZDFenBu')) {
    return jsonResponse({ data: { fenbu: [{ 10: 10, 5: 20, 1: 30, 0: 50, '-2': 15, '-5': 5 }] } })
  }
  if (url.includes('data.10jqka.com.cn')) return jsonResponse(reasonBody(limitUpRows()))
  if (url.includes('datacenter-web.eastmoney.com')) return jsonResponse(dragonTigerBody())
  if (url.includes('query.sse.com.cn')) {
    const date = new URL(url).searchParams.get('detailsDate') ?? TRADE_DATE
    return jsonResponse(marginBody(date))
  }
  if (url.includes('push2his.eastmoney.com/api/qt/stock/kline/get')) {
    return jsonResponse(klineBody(new URL(url).searchParams.get('secid') ?? ''))
  }
  if (url.includes('push2his.eastmoney.com/api/qt/stock/trends2/get')) return jsonResponse(trendBody())
  if (url.includes('web.ifzq.gtimg.cn')) {
    const param = new URL(url).searchParams.get('param') ?? ''
    return jsonResponse(tencentKlineBody(param.split(',')[0] ?? ''))
  }
  return { status: 404, body: 'not found' }
}

describe('TradingDayProvider', () => {
  it('组装上下文：指数、分时、成交额与沪市融资余额', async () => {
    const { provider } = createProvider(healthyHandler)
    const context = await provider.tradingDayContext()

    expect(context.tradeDate).toBe('2026-10-21')
    expect(context.status).toBe('complete')
    expect(context.indices).toHaveLength(6)
    expect(context.trend?.points).toHaveLength(2)
    expect(context.turnover?.amount).toBe(12000)
    expect(context.turnover?.previousAmount).toBe(11000)
    expect(context.margin?.total).toBe(500)
    expect(context.sources.every((source) => source.state === 'fresh')).toBe(true)
  })

  it('组装涨跌停池、题材与龙虎榜', async () => {
    const { provider } = createProvider(healthyHandler)
    const [pools, themes, dragonTiger] = await Promise.all([
      provider.tradingDayLimitPools(),
      provider.tradingDayThemes(),
      provider.tradingDayDragonTiger(),
    ])

    expect(pools.status).toBe('complete')
    expect(pools.stats.limitUp).toBe(65)
    expect(pools.stats.broken).toBe(5)
    expect(pools.stats.limitDown).toBe(2)
    expect(pools.ladder.length).toBeGreaterThan(0)
    expect(themes.status).toBe('complete')
    expect(themes.themes[0]?.name).toBeTruthy()
    expect(dragonTiger.status).toBe('complete')
    expect(dragonTiger.entries).toHaveLength(15)
  })

  it('分析覆盖最多 60 只，缺失部分计入 skipped', async () => {
    const { provider, http } = createProvider(healthyHandler)
    const analysis = await provider.tradingDayAnalysis()

    expect(analysis.status).toBe('complete')
    expect(analysis.coverage).toEqual({ analyzed: 60, total: 65, skipped: 5 })
    const klineRequests = http.requests.filter((item) => item.url.includes('web.ifzq.gtimg.cn'))
    expect(klineRequests).toHaveLength(61)
  })

  it('同一时刻的并发分组只请求一次涨停池', async () => {
    const { provider, http } = createProvider(healthyHandler)
    await Promise.all([
      provider.tradingDayContext(),
      provider.tradingDayLimitPools(),
      provider.tradingDayThemes(),
      provider.tradingDayDragonTiger(),
    ])
    expect(http.requests.filter((item) => item.url.includes('getTopicZTPool'))).toHaveLength(1)
  })

  it('缓存过期后重新抓取', async () => {
    const { provider, http, clock } = createProvider(healthyHandler)
    await provider.tradingDayContext()
    const first = http.requests.filter((item) => item.url.includes('qt.gtimg.cn')).length
    await provider.tradingDayContext()
    expect(http.requests.filter((item) => item.url.includes('qt.gtimg.cn'))).toHaveLength(first)

    clock.advance(26_000)
    await provider.tradingDayContext()
    expect(http.requests.filter((item) => item.url.includes('qt.gtimg.cn'))).toHaveLength(first + 1)
  })

  it('全部数据源失败时返回 partial，不抛错也不伪造 0', async () => {
    const { provider } = createProvider(() => ({ status: 500, body: 'upstream error' }))

    const context = await provider.tradingDayContext()
    expect(context.status).toBe('partial')
    expect(context.indices).toEqual([])
    expect(context.trend).toBeNull()
    expect(context.turnover).toBeNull()
    expect(context.margin).toBeNull()

    const pools = await provider.tradingDayLimitPools()
    expect(pools.status).toBe('partial')
    expect(pools.stats.limitUp).toBeNull()
    expect(pools.stats.sealRate).toBeNull()

    const analysis = await provider.tradingDayAnalysis()
    expect(analysis.status).toBe('partial')
    expect(analysis.tradeDate).toBe('')
    expect(analysis.coverage).toEqual({ analyzed: 0, total: 0, skipped: 0 })
  })

  it('涨跌停池日期与交易日不一致时整组降级', async () => {
    const { provider } = createProvider((url) => {
      if (url.includes('getTopicZTPool')) return jsonResponse(poolBody(PREVIOUS_DATE, 65, limitUpRows()))
      return healthyHandler(url)
    })

    const pools = await provider.tradingDayLimitPools()
    expect(pools.tradeDate).toBe('2026-10-21')
    expect(pools.status).toBe('partial')
    expect(pools.stats.limitUp).toBeNull()
    expect(pools.ladder).toEqual([])
  })

  it('跨上海自然日立即重新抓取指数与涨跌分布', async () => {
    const clock = new FakeClock(Date.UTC(2026, 9, 21, 15, 59, 30))
    const { provider, http } = createProvider(
      (url) => {
        if (url.includes('getTopicZDFenBu')) {
          return jsonResponse({ data: { fenbu: [{ 1: 30, 0: 50, '-1': 15 }] } })
        }
        return healthyHandler(url)
      },
      { clock, cacheTtlMs: 10 * 60_000 },
    )

    await provider.tradingDayAnalysis()
    clock.advance(40_000)
    await provider.tradingDayAnalysis()

    expect(http.requests.filter((item) => item.url.includes('qt.gtimg.cn'))).toHaveLength(2)
    expect(http.requests.filter((item) => item.url.includes('getTopicZDFenBu'))).toHaveLength(2)
  })

  it('clearCache 丢弃正在飞行的请求，旧结果不回写缓存', async () => {
    let release: ((response: HttpResponse) => void) | undefined
    let quoteCalls = 0
    const { provider, http } = createProvider((url) => {
      if (url.includes('qt.gtimg.cn')) {
        quoteCalls += 1
        if (quoteCalls === 1) {
          return new Promise<HttpResponse>((resolve) => {
            release = resolve
          })
        }
      }
      return healthyHandler(url)
    })

    const first = provider.tradingDayContext()
    provider.clearCache()
    const second = provider.tradingDayContext()
    expect(quoteCalls).toBe(2)

    release?.({ status: 200, body: quoteBody() })
    const [firstContext, secondContext] = await Promise.all([first, second])
    expect(firstContext.tradeDate).toBe('2026-10-21')
    expect(secondContext.tradeDate).toBe('2026-10-21')

    await provider.tradingDayContext()
    expect(http.requests.filter((item) => item.url.includes('qt.gtimg.cn'))).toHaveLength(2)
  })
})
