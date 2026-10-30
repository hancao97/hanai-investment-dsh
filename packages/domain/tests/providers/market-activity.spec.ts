import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketActivityProvider } from '../../src/providers/market-activity.ts'
import { SourceCircuit } from '../../src/providers/source-circuit.ts'
import { HandlerHttpClient, FakeClock, jsonResponse } from '../helpers.ts'

const NOW = Date.parse('2026-10-27T16:00:00+08:00')
const meta = { providerId: 'tencent', sourceName: '腾讯行情', sourceTimestamp: '20261027', fetchedAt: new Date(NOW).toISOString(), cacheState: 'fresh' as const }
const trend = { trend: [{ time: '09:30', price: 3600, avgPrice: null, volume: 0 }, { time: '15:00', price: 3700, avgPrice: null, volume: 100 }], trendPrevClose: 3590, meta }
const item = (time: string, title: string, name = '机器人') => ({ ctime: Date.parse(`2026-10-27T${time}:00+08:00`) / 1000, title, field: [{ name, stockCode: '886069' }] })
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(() => vi.useRealTimers())

describe('market activity', () => {
  it.each([
    ['tencent', '20261028', '09:48', true],
    ['tencent', '20261028', '09:49', false],
    ['tencent', '20261029', '09:30', false],
    ['eastmoney', '2026-10-28', '09:48', false],
  ])('validates minute labels for %s %s %s', async (providerId, date, time, accepted) => {
    const now = Date.parse('2026-10-28T09:47:51+08:00')
    vi.setSystemTime(now)
    const clock = new FakeClock(now)
    const provider = new MarketActivityProvider(new HandlerHttpClient(() => jsonResponse({})), clock, new SourceCircuit({ clock }), async () => ({
      ...trend, trend: [{ time, price: 3672.97, avgPrice: null, volume: 0 }],
      meta: { ...meta, providerId, sourceTimestamp: date, fetchedAt: new Date(now).toISOString() },
    }))
    const result = await provider.getIntraday()
    if (accepted) expect(result).toMatchObject({ date: '2026-10-28', points: [{ time }], meta: { sourceTimestamp: '2026-10-28T01:48:00.000Z' } })
    else expect(result).toBeNull()
  })

  it('replaces yesterday with the current minute and fetches news for the new trading day', async () => {
    const clock = new FakeClock(NOW)
    const http = new HandlerHttpClient(() => jsonResponse({ code: 200, data: { list: [
      { ...item('09:34', '机器人板块走强'), ctime: Date.parse('2026-10-28T09:34:00+08:00') / 1000 },
    ] } }))
    const load = vi.fn(async () => trend)
    const provider = new MarketActivityProvider(http, clock, new SourceCircuit({ clock }), load)
    expect((await provider.getIntraday())?.date).toBe('2026-10-27')
    const now = Date.parse('2026-10-28T09:47:51+08:00')
    clock.advance(now - NOW)
    vi.setSystemTime(now)
    load.mockResolvedValue({ ...trend, trend: [{ time: '09:48', price: 3672.97, avgPrice: null, volume: 100 }],
      meta: { ...meta, sourceTimestamp: '20261028', fetchedAt: new Date(now).toISOString() } })
    expect(await provider.getIntraday()).toMatchObject({ date: '2026-10-28', meta: { cacheState: 'fresh' } })
    expect(await provider.getSignals()).toMatchObject({ date: '2026-10-28', signals: [{ name: '机器人' }] })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('uses the actual trend date, preserves zero volume and retains repeat afternoon events', async () => {
    const clock = new FakeClock(NOW)
    const http = new HandlerHttpClient(() => jsonResponse({ code: '200', data: { list: [item('14:30', '机器人板块拉升'), item('09:30', '机器人板块走强'), item('10:01', '港股机器人板块上涨'), item('12:01', '机器人板块走强'), item('09:31', '银行板块下挫', '银行')] } }))
    const load = vi.fn(async () => trend)
    const provider = new MarketActivityProvider(http, clock, new SourceCircuit({ clock }), load)
    const [prices, news] = await Promise.all([provider.getIntraday(), provider.getSignals()])
    expect(prices).toMatchObject({ date: '2026-10-27', meta: { sourceTimestamp: '2026-10-27T07:00:00.000Z' } })
    expect(prices?.points[0]?.volume).toBe(0)
    expect(news?.signals).toMatchObject([{ time: '09:30', name: '机器人', direction: 'up' }, { time: '09:31', name: '银行', direction: 'down' }, { time: '14:30', name: '机器人', direction: 'up' }])
    expect(news?.method).toBe('ths-sector-events-v2')
    expect(load).toHaveBeenCalledTimes(1)
    expect(http.requests).toHaveLength(1)
    await provider.getSignals()
    expect(http.requests).toHaveLength(1)
  })

  it('keeps more than eight events and takes the board name and direction from the board clause', async () => {
    const clock = new FakeClock(NOW)
    const rows = Array.from({ length: 9 }, (_, index) => item(`09:${String(30 + index)}`, `行业${index}板块上涨`))
    rows.push(item('14:30', '机器人板块拉升，多只个股跌超5%', '其它概念'))
    rows.push(item('14:31', '机器人板块走低，某某股份涨停'))
    rows.push(item('11:30', 'A股午评：沪指下跌，电机、零售、银行板块涨幅居前'))
    rows.push(item('15:00', 'A股收评：沪指下跌，软件开发板块跌幅居前'))
    rows.push(item('10:49', '银行板块震荡走高', '银行'))
    rows.push(rows[0]!)
    const http = new HandlerHttpClient(() => jsonResponse({ code: 200, data: { list: rows } }))
    const data = await new MarketActivityProvider(http, clock, new SourceCircuit({ clock }), async () => trend).getSignals()
    expect(data?.signals).toHaveLength(12)
    expect(data?.signals.find(row => row.name === '银行')).toMatchObject({ time: '10:49', direction: 'up' })
    expect(data?.signals.at(-2)).toMatchObject({ time: '14:30', name: '机器人', code: '', direction: 'up' })
    expect(data?.signals.at(-1)).toMatchObject({ time: '14:31', name: '机器人', direction: 'down' })
  })

  it('does not turn unrelated or incomplete news into a successful empty day and uses the shared circuit', async () => {
    const clock = new FakeClock(NOW)
    const http = new HandlerHttpClient(() => jsonResponse({ code: 200, data: { list: [item('10:00', '机器人板块走强')].map(row => ({ ...row, ctime: Number(row.ctime) - 86400 })) } }))
    const circuit = new SourceCircuit({ clock })
    const provider = new MarketActivityProvider(http, clock, circuit, async () => trend)
    for (let attempt = 0; attempt < 3; attempt += 1) { expect(await provider.getSignals()).toBeNull(); clock.advance(60_001) }
    expect(circuit.isOpen('ths-news')).toBe(true)
    await provider.getSignals()
    expect(http.requests).toHaveLength(3)
    expect((await provider.getIntraday())?.points).toEqual(trend.trend)
  })

  it('retains the old snapshot and date after failure and allows a confirmed day without matching news', async () => {
    const clock = new FakeClock(NOW)
    let online = true
    const http = new HandlerHttpClient(() => online ? jsonResponse({ code: 200, data: { list: [item('10:00', '个股涨停')] } }) : jsonResponse({}, 503))
    const load = vi.fn(async () => trend)
    const provider = new MarketActivityProvider(http, clock, new SourceCircuit({ clock }), load)
    const first = await provider.getSignals()
    expect(first?.signals).toEqual([])
    online = false
    clock.advance(6 * 3600_000 + 1)
    load.mockRejectedValue(new Error('offline'))
    const failed = await provider.getSignals()
    expect(failed).toMatchObject({ date: first!.date, meta: { fetchedAt: first!.meta.fetchedAt, cacheState: 'stale' } })
    expect((await provider.getIntraday())?.meta.cacheState).toBe('stale')
  })
})
