import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StockQuote } from '../../../contracts/src/index.ts'
import { eastmoneyBreadth, leguBreadth } from '../../src/providers/market-breadth.ts'
import { MarketDataService } from '../../src/providers/index.ts'
import { FakeClock, HandlerHttpClient, jsonResponse } from '../helpers.ts'

const NOW = Date.parse('2026-10-27T10:00:00+08:00')
const payload = { data: { qdate: 20261027, fenbu: [{ '11': 30 }, { '1': 2000 }, { '0': 100 }, { '-1': 2500 }, { '-11': 0 }] } }
// Structure captured from AKShare's public source, including easily confused subsidiary counts.
const html = (date = '2026-10-27 10:00:00') => `<table><tbody>
  <tr><td>上涨</td><td class="color-red">1,200</td><td>下跌</td><td>900</td><td>平盘</td><td>100</td></tr>
  <tr><td>涨停</td><td>30</td><td>跌停</td><td>0</td><td>停牌</td><td>5</td></tr>
  <tr><td>真实涨停</td><td>20</td><td>真实跌停</td><td>0</td></tr>
  <tr><td>st st*涨停</td><td>3</td><td>st st*跌停</td><td>0</td></tr>
</tbody></table><div class="market-activity-meta"><span class="market-activity-time">${date}</span><div id="star-btn"></div></div>`
const meta = { providerId: 'tencent', sourceName: '腾讯行情', sourceTimestamp: null, fetchedAt: new Date(NOW).toISOString(), cacheState: 'fresh' as const }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

function stock(secId: string, amount: number): StockQuote {
  return { secId, code: secId.slice(2), name: '测试证券', price: 10, prevClose: 10, volume: 100, amount,
    change: null, changePct: null, turnoverRate: null, marketCap: null, floatCap: null,
    pe: null, pb: null, high: null, low: null, open: null }
}

function setup(timestamp = NOW) {
  const clock = new FakeClock(timestamp)
  const state = { body: html(new Date(timestamp + 8 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ')), status: 200, eastmoneyStatus: 200 }
  const http = new HandlerHttpClient(url => {
    if (url.startsWith('https://legulegu.com/')) return { status: state.status, body: state.body }
    if (url.startsWith('https://push2ex.eastmoney.com/')) return jsonResponse(payload, state.eastmoneyStatus)
    return jsonResponse({}, 503)
  })
  const service = new MarketDataService({ clock, http })
  const sina = vi.spyOn(service.sina, 'getAllSecurities')
  const tencent = vi.spyOn(service.tencent, 'getQuotes')
  const eastmoney = vi.spyOn(service.eastmoney, 'getBreadth')
  const primaryCalls = () => http.requests.filter(({ url }) => url.startsWith('https://legulegu.com/'))
  return { clock, service, sina, tencent, eastmoney, http, state, primaryCalls }
}

describe('AKShare-source aggregate market breadth', () => {
  it('reads the complete first table with one request and keeps genuine zero values and vendor scope', async () => {
    const { service, http, sina, tencent, eastmoney } = setup()
    const result = await service.getMarketBreadth()
    expect(result).toMatchObject({ up: 1200, down: 900, flat: 100, limitUp: 30, limitDown: 0, qdate: '2026-10-27',
      meta: { providerId: 'legu-breadth', sourceName: '乐咕乐股（AKShare 同源）', sourceTimestamp: '2026-10-27T02:00:00.000Z', cacheState: 'fresh' } })
    expect(http.requests).toHaveLength(1)
    expect(sina).not.toHaveBeenCalled()
    expect(tencent).not.toHaveBeenCalled()
    expect(eastmoney).not.toHaveBeenCalled()
  })

  it('does not start or await breadth when serving dashboard indices and boards', async () => {
    const { service, sina, primaryCalls } = setup()
    const width = vi.spyOn(service, 'getMarketBreadth').mockReturnValue(new Promise(() => {}))
    vi.spyOn(service, 'getQuotes').mockResolvedValue({ quotes: [stock('1.000001', 100), stock('0.399001', 200)], meta })
    const dashboard = await service.getDashboard()
    expect(dashboard.overview.indices).toHaveLength(2)
    expect(dashboard.overview.breadth).toMatchObject({ up: null, limitUp: null, totalAmount: 300 })
    expect(width).not.toHaveBeenCalled()
    expect(sina).not.toHaveBeenCalled()
    expect(primaryCalls()).toHaveLength(0)
  })

  it('does not touch Eastmoney quote, trend or K-line endpoints when Tencent supplies the requested data', async () => {
    const { service, tencent } = setup()
    tencent.mockResolvedValue({ quotes: [stock('1.600000', 100)], meta })
    const quotes = vi.spyOn(service.eastmoney, 'getQuotes')
    const trend = vi.spyOn(service.eastmoney, 'getTrend')
    const kline = vi.spyOn(service.eastmoney, 'getKline')
    vi.spyOn(service.tencent, 'getTrend').mockResolvedValue({ points: [{ time: '10:00', price: 11, avgPrice: 11, volume: 100 }], prevClose: 10, meta })
    vi.spyOn(service.tencent, 'getFullKline').mockResolvedValue({ bars: [{ date: '2026-10-27', open: 10, close: 11, high: 11, low: 10, volume: 100, amount: null }], hasMore: false, meta })
    expect((await service.getQuotes(['1.600000'])).quotes).toHaveLength(1)
    expect((await service.getTrend('1.600000')).trend).toHaveLength(1)
    expect((await service.getKline('1.600000', 'weekly')).bars).toHaveLength(1)
    expect(quotes).not.toHaveBeenCalled()
    expect(trend).not.toHaveBeenCalled()
    expect(kline).not.toHaveBeenCalled()
  })

  it('coalesces refreshes and reuses an unexpired aggregate snapshot', async () => {
    const { service, primaryCalls, clock } = setup()
    const [first, second] = await Promise.all([service.getMarketBreadth(), service.getMarketBreadth()])
    expect(first).toEqual(second)
    expect(primaryCalls()).toHaveLength(1)
    clock.advance(24_999)
    expect((await service.getMarketBreadth())?.meta.cacheState).toBe('cached')
    expect(primaryCalls()).toHaveLength(1)
  })

  it('falls back to the complete Eastmoney distribution when the primary rejects access', async () => {
    const { service, state, eastmoney } = setup()
    state.status = 403
    expect(await service.getMarketBreadth()).toMatchObject({ up: 2030, down: 2500, flat: 100, limitUp: 30, limitDown: 0,
      meta: { providerId: 'eastmoney-breadth' } })
    expect(eastmoney).toHaveBeenCalledTimes(1)
    expect(service.getSourceDiagnostics().find(value => value.scope === 'breadth' && value.source === 'legu')?.lastError).toContain('HTTP 403')
  })

  it('uses the common circuit to skip three failed primary attempts for five minutes and then recover', async () => {
    const { service, state, clock, primaryCalls } = setup()
    state.status = 503
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) clock.advance(25_000)
      await service.getMarketBreadth()
    }
    const status = () => service.getSourceDiagnostics().find(value => value.scope === 'breadth' && value.source === 'legu')!
    expect(status().openUntil).toBe(new Date(clock.now() + 300_000).toISOString())
    clock.advance(30_000)
    await service.getMarketBreadth()
    expect(primaryCalls()).toHaveLength(3)
    state.status = 200
    clock.advance(270_000)
    expect((await service.getMarketBreadth())?.meta.providerId).toBe('legu-breadth')
    expect(status().openUntil).toBeNull()
  })

  it('preserves the full snapshot and original acquisition time when all sources fail', async () => {
    const { service, state, clock, eastmoney } = setup()
    const first = await service.getMarketBreadth()
    state.status = 503
    state.eastmoneyStatus = 503
    clock.advance(30_000)
    expect(await service.getMarketBreadth()).toMatchObject({ up: 1200, down: 900, flat: 100, limitUp: 30, limitDown: 0,
      meta: { fetchedAt: first!.meta.fetchedAt, cacheState: 'stale' } })
    await service.getMarketBreadth()
    expect(eastmoney).toHaveBeenCalledTimes(1)
  })

  it('returns unavailable without a prior snapshot when every source fails', async () => {
    const { service, state } = setup()
    state.status = 503
    state.eastmoneyStatus = 503
    expect(await service.getMarketBreadth()).toBeNull()
  })

  it('revalidates a closed-market six-hour snapshot when the session opens', async () => {
    const { service, clock, primaryCalls } = setup(Date.parse('2026-10-27T08:00:00+08:00'))
    await service.getMarketBreadth()
    clock.advance(60 * 60_000)
    expect((await service.getMarketBreadth())?.meta.cacheState).toBe('cached')
    expect(primaryCalls()).toHaveLength(1)
    clock.advance(26 * 60_000)
    expect((await service.getMarketBreadth())?.meta.cacheState).toBe('fresh')
    expect(primaryCalls()).toHaveLength(2)
  })

  it.each([
    ['missing-field', (body: string) => body.replace('<td>跌停</td><td>0</td>', '')],
    ['negative', (body: string) => body.replace('<td>900</td>', '<td>-1</td>')],
    ['fraction', (body: string) => body.replace('<td>900</td>', '<td>1.5</td>')],
    ['unsafe-number', (body: string) => body.replace('<td>900</td>', '<td>9007199254740992</td>')],
    ['non-number', (body: string) => body.replace('<td>900</td>', '<td>--</td>')],
    ['duplicate', (body: string) => body.replace('</tbody>', '<tr><td>上涨</td><td>10</td></tr></tbody>')],
    ['bad-limits', (body: string) => body.replace('<td>30</td>', '<td>9999</td>')],
    ['missing-time', (body: string) => body.replace('market-activity-meta', 'unknown-meta')],
    ['invalid-time', (body: string) => body.replace('2026-10-27', '2026-02-30')],
    ['future', (body: string) => body.replace('10:00:00', '11:00:00')],
    ['empty-market', () => html().replace(/>1,200<|>900<|>100<|>30</g, '>0<')],
    ['challenge-page', () => '<html>访问验证</html>'],
  ] as const)('rejects %s rather than manufacturing a success', async (_name, change) => {
    await expect(leguBreadth(new HandlerHttpClient(() => ({ status: 200, body: change(html()) })), new FakeClock(NOW), 1000)).rejects.toThrow('乐咕')
  })

  it.each([
    { data: null },
    { data: { ...payload.data, fenbu: [] } },
    { data: { ...payload.data, fenbu: [{ '1': 10 }, { '0': 2 }] } },
    { data: { ...payload.data, fenbu: [...payload.data.fenbu, { '1': 1 }] } },
  ])('rejects malformed fallback distributions: %j', async response => {
    await expect(eastmoneyBreadth(new HandlerHttpClient(() => jsonResponse(response)), new FakeClock(NOW), 1000)).rejects.toThrow('市场宽度')
  })
})
