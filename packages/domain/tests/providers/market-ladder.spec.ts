import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MarketLadderProvider, summarizeYesterday } from '../../src/providers/market-ladder.ts'
import { HandlerHttpClient, FakeClock, jsonResponse } from '../helpers.ts'

const now = Date.parse('2026-10-30T10:30:00+08:00')
const epoch = Math.floor(now / 1000)
const row = { code: '001219', name: '青岛食品', high_days: '5天5板', first_limit_up_time: String(epoch), last_limit_up_time: String(epoch), open_num: 3, turnover_rate: 20, reason_type: '食品+食品+业绩增长', limit_up_type: '换手板' }
const ths = (info = [row]) => ({ status_code: 0, data: { date: '20261030', page: { total: info.length }, info, limit_up_count: { today: { num: info.length, open_num: 2 }, yesterday: { num: 4 } } } })
const pool = (rows: unknown[]) => jsonResponse({ rc: 0, data: { qdate: 20261030, tc: rows.length, pool: rows } })
const em = { c: '001219', n: '青岛食品', lbc: 5, zbc: 3, fbt: 93000, lbt: 103000, hs: 20, hybk: '食品' }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now) })
afterEach(() => vi.useRealTimers())

it('calculates yesterday sample averages, both median cases and flat counts without filling missing prices', () => {
  const meta = { providerId: 'test', sourceName: 'test', sourceTimestamp: '2026-10-30', fetchedAt: new Date(now).toISOString(), cacheState: 'fresh' as const }
  expect(summarizeYesterday([-2, 0, 4], meta)).toMatchObject({ sample: 3, average: 2 / 3, median: 0, up: 1, down: 1, flat: 1 })
  expect(summarizeYesterday([-2, -1, 1, 4], meta)?.median).toBe(0)
  expect(summarizeYesterday([], meta)).toMatchObject({ sample: 0, average: null, median: null })
  expect(summarizeYesterday([1, null, 2], meta)).toBeNull()
})

it('prefers THS yesterday candidates plus one current quote batch and never requests Eastmoney on success', async () => {
  const http = new HandlerHttpClient(url => {
    const historical = new URL(url).searchParams.get('date') === '20261029'
    const value = ths([{ ...row, high_days: '首板', first_limit_up_time: String(epoch - (historical ? 86400 : 0)), last_limit_up_time: String(epoch - (historical ? 86400 : 0)) }])
    if (historical) value.data.date = '20261029'
    value.data.limit_up_count.yesterday.num = 1
    return jsonResponse(value)
  })
  const meta = { providerId: 'tencent', sourceName: '腾讯行情', sourceTimestamp: new Date(now).toISOString(), fetchedAt: new Date(now).toISOString(), cacheState: 'fresh' as const }
  const quotes = vi.fn().mockResolvedValue({ meta, quotes: [{ code: row.code, price: 10, changePct: -2, meta }] })
  const data = await new MarketLadderProvider(http, new FakeClock(now), 5000, quotes).get()
  expect(data?.yesterdayPerformance).toMatchObject({ sample: 1, average: -2, median: -2, up: 0, down: 1, flat: 0 })
  expect(quotes).toHaveBeenCalledWith(['0.001219'])
  expect(http.requests).toHaveLength(2)
  expect(http.requests.every(row => row.url.includes('10jqka.com.cn'))).toBe(true)
})

it('uses a single THS batch without any Eastmoney calls and preserves missing break counts', async () => {
  const clock = new FakeClock(now)
  const http = new HandlerHttpClient(() => jsonResponse(ths([{ ...row, open_num: null as unknown as number }])))
  const provider = new MarketLadderProvider(http, clock)
  const data = await provider.get()
  expect(data?.stocks[0]).toMatchObject({ boards: 5, firstSeal: '10:30:00', breaks: null })
  expect(data?.promotion).toEqual({ eligible: 4, promoted: 1 })
  expect(data?.broken).toBe(2)
  expect(http.requests).toHaveLength(1)
  expect(http.requests[0]?.url).toContain('10jqka.com.cn')
  expect((await provider.get())?.meta.cacheState).toBe('cached')
  expect(http.requests).toHaveLength(1)
})

it('falls back to Eastmoney, opens the primary circuit after 3 failures, and retries after cooldown', async () => {
  const clock = new FakeClock(now)
  let online = false
  const http = new HandlerHttpClient(url => {
    if (url.includes('dataapi')) return online ? jsonResponse(ths()) : jsonResponse({}, 503)
    if (url.includes('getTopicZTPool')) return pool([em])
    if (url.includes('getYesterdayZTPool')) return pool([{ c: '001219' }, { c: '000001' }])
    if (url.includes('getTopicZBPool')) return pool([{ c: '600001' }])
    return jsonResponse({ errocode: 0, data: [{ code: '001219', reason: '食品', date: '2026-10-30' }] })
  })
  const provider = new MarketLadderProvider(http, clock)
  for (let i = 0; i < 3; i++) {
    expect((await provider.get())?.meta.providerId).toBe('eastmoney-limit-up')
    clock.advance(26_000)
  }
  expect(provider.circuit.snapshot('ths-limit-reason').openUntil).not.toBeNull()
  const calls = http.requests.filter(row => row.url.includes('dataapi')).length
  await provider.get()
  expect(http.requests.filter(row => row.url.includes('dataapi'))).toHaveLength(calls)
  clock.advance(5 * 60_000)
  online = true
  expect((await provider.get())?.meta.providerId).toBe('ths-limit-reason')
})

it('rejects an N-day M-board statistic as a consecutive ladder and keeps the last successful snapshot on total failure', async () => {
  const clock = new FakeClock(now)
  let healthy = true
  const http = new HandlerHttpClient(url => url.includes('dataapi') ? jsonResponse(ths(healthy ? [row] : [{ ...row, high_days: '5天3板' }])) : jsonResponse({}, 503))
  const provider = new MarketLadderProvider(http, clock)
  const first = await provider.get()
  healthy = false; clock.advance(26_000)
  const failed = await provider.get()
  expect(failed?.meta.cacheState).toBe('stale')
  expect(failed?.stocks).toEqual(first?.stocks)
  expect(failed?.meta.fetchedAt).toBe(first?.meta.fetchedAt)
})

it('rejects truncated or wrong-day fallback pools rather than returning an empty success', async () => {
  const clock = new FakeClock(now)
  const http = new HandlerHttpClient(url => url.includes('push2ex') ? jsonResponse({ rc: 0, data: { qdate: 20261029, tc: 3, pool: [] } }) : jsonResponse({}, 503))
  expect(await new MarketLadderProvider(http, clock).get()).toBeNull()
})
it('retains validated same-day THS board types when Eastmoney supplies the consecutive counts', async () => {
  const rows = ['T字板', '一字板', '换手板'].map((type, i) => ({ ...row, code: `60000${i}`, limit_up_type: type, high_days: i === 2 ? '3天2板' : '首板' }))
  const http = new HandlerHttpClient(url => {
    if (url.includes('dataapi')) return jsonResponse(ths(rows))
    if (url.includes('getTopicZTPool')) return pool(rows.map(row => ({ ...em, c: row.code, lbc: 1 })))
    return pool([])
  })
  const clock = new FakeClock(now)
  const provider = new MarketLadderProvider(http, clock)
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await provider.get()
    expect(result?.meta.providerId).toBe('eastmoney-limit-up')
    expect(result?.stocks.map(row => row.boardType)).toEqual(['T字板', '一字板', '换手板'])
    clock.advance(26_000)
  }
  expect(provider.circuit.snapshot('ths-limit-reason')).toMatchObject({ failures: 0, openUntil: null, lastError: null })
  expect(http.requests.some(row => row.url.includes('getharden'))).toBe(false)
})
it('counts invalid board strings as failures rather than a valid capability gap', async () => {
  const http = new HandlerHttpClient(url => url.includes('dataapi') ? jsonResponse(ths([{ ...row, high_days: '未知字段' }])) : jsonResponse({}, 503))
  const provider = new MarketLadderProvider(http, new FakeClock(now))
  expect(await provider.get()).toBeNull()
  expect(provider.circuit.snapshot('ths-limit-reason').failures).toBe(1)
})
it('opens the Eastmoney fallback circuit too and skips both sources during cooldown', async () => {
  const clock = new FakeClock(now)
  const http = new HandlerHttpClient(() => jsonResponse({}, 503))
  const provider = new MarketLadderProvider(http, clock)
  for (let i = 0; i < 3; i++) { expect(await provider.get()).toBeNull(); clock.advance(61_000) }
  expect(provider.circuit.snapshot('ths-limit-reason').openUntil).not.toBeNull()
  expect(provider.circuit.snapshot('eastmoney-limit-up').openUntil).not.toBeNull()
  const calls = http.requests.length
  expect(await provider.get()).toBeNull()
  expect(http.requests).toHaveLength(calls)
})
