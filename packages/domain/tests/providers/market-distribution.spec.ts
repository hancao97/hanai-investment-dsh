import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { fetchDistribution, summarizeDistribution } from '../../src/providers/market-distribution.ts'
import { MarketDataService } from '../../src/providers/index.ts'
import { FakeClock, HandlerHttpClient, jsonResponse } from '../helpers.ts'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T10:00:00+08:00')) })
afterEach(() => vi.useRealTimers())

const values = [20, 10, 9.99, 5, 4.99, 2, 0.01, 0, -0.01, -2, -4.99, -5, -9.99, -10, -20]
const rows = Array.from({ length: 1200 }, (_, index) => values[Math.floor(index / 80)]!)
function setup(failSina = false, invalid = false) {
  const clock = new FakeClock(Date.now())
  const http = new HandlerHttpClient(url => {
    if (url.includes('finance.qq.com')) return jsonResponse({}, 503)
    const page = Number(new URL(url).searchParams.get('page') ?? new URL(url).searchParams.get('pn'))
    const slice = rows.slice((page - 1) * 100, page * 100)
    if (url.includes('sina.com.cn')) {
      if (failSina) return jsonResponse({}, 503)
      if (url.includes('StockCount')) return jsonResponse('1200')
      return jsonResponse(slice.map(value => ({ changepercent: invalid ? '-' : String(value) })))
    }
    return jsonResponse({ rc: 0, data: { total: 1200, diff: slice.map(f3 => ({ f3 })) } })
  })
  return { clock, http, service: new MarketDataService({ http, clock }) }
}

it('counts all exact boundary values in nine disjoint buckets', async () => {
  const result = await summarizeDistribution(values.length, 4, async page => values.slice((page - 1) * 4, page * 4))
  expect(result).toEqual({ up10: 2, up5: 2, up2: 2, up0: 1, flat: 1, down0: 2, down2: 2, down5: 2, down10: 1 })
})

function tencentHttp(suspended = 6, badSuspended = false) {
  const all = [...rows.map((zdf, index) => ({ code: `sz${String(index).padStart(6, '0')}`, state: '', zdf: String(zdf) })),
    ...Array.from({ length: suspended }, (_, index) => ({ code: `sh${String(index).padStart(6, '0')}`, state: 'S', zdf: badSuspended ? '-' : '0.00' }))]
  return new HandlerHttpClient(url => {
    if (!url.includes('finance.qq.com')) return jsonResponse({}, 503)
    const params = new URL(url).searchParams
    expect(params.get('board_code')).toBe('aStock')
    expect(params.get('sort_type')).toBe('priceRatio')
    const offset = Number(params.get('offset'))
    return jsonResponse({ code: 0, data: { offset, total: all.length, rank_list: all.slice(offset, offset + Number(params.get('count'))) } })
  })
}

it('uses Tencent full-market rankings first and counts explicit suspended zeroes as flat', async () => {
  const clock = new FakeClock(Date.now()), http = tencentHttp()
  const service = new MarketDataService({ clock, http })
  const result = await service.getMarketDistribution()
  expect(result?.meta.providerId).toBe('tencent-distribution')
  expect(result?.total).toBe(1206)
  expect(result?.counts.flat).toBe(86)
  expect(Object.values(result!.counts).reduce((a, b) => a + b)).toBe(1206)
  expect(http.requests.every(({ url }) => url.includes('finance.qq.com'))).toBe(true)
})

it('handles suspended stocks spanning multiple tail pages and rejects missing changes', async () => {
  const clock = new FakeClock(Date.now())
  const result = await fetchDistribution(tencentHttp(120), clock, 'tencent', 1000)
  expect(result.total).toBe(1320)
  expect(result.counts.flat).toBe(200)
  await expect(fetchDistribution(tencentHttp(6, true), clock, 'tencent', 1000)).rejects.toThrow('无效涨幅')
})

it('falls through Tencent to Sina and skips Tencent during its circuit cooldown', async () => {
  const { clock, service, http } = setup()
  for (let i = 0; i < 3; i++) {
    expect((await service.getMarketDistribution())?.meta.providerId).toBe('sina-distribution')
    clock.advance(26_000)
  }
  const calls = () => http.requests.filter(({ url }) => url.includes('finance.qq.com')).length
  expect(calls()).toBe(3)
  await service.getMarketDistribution()
  expect(calls()).toBe(3)
  clock.advance(5 * 60_000)
  await service.getMarketDistribution()
  expect(calls()).toBe(4)
})

it('searches boundary pages once, coalesces requests and reuses the cache', async () => {
  const { http, service } = setup()
  const [a, b] = await Promise.all([service.getMarketDistribution(), service.getMarketDistribution()])
  expect(a).toEqual(b)
  expect(a?.total).toBe(1200)
  expect(Object.values(a!.counts).reduce((a, b) => a + b)).toBe(1200)
  const urls = http.requests.map(row => row.url)
  expect(new Set(urls).size).toBe(urls.length)
  const calls = urls.length
  expect((await service.getMarketDistribution())?.meta.cacheState).toBe('cached')
  expect(http.requests).toHaveLength(calls)
})

it('falls back to Eastmoney and rejects invalid values instead of converting them to zero', async () => {
  const { service } = setup(true)
  expect((await service.getMarketDistribution())?.meta.providerId).toBe('eastmoney-distribution')
  const { clock, http } = setup(false, true)
  await expect(fetchDistribution(http, clock, 'sina', 1000)).rejects.toThrow('无效涨幅')
})

it('accepts small overlaps between individually sorted live pages as prices move', async () => {
  const clock = new FakeClock(Date.now())
  const all = Array.from({ length: 1200 }, (_, index) => 15 - index / 200)
  const http = new HandlerHttpClient(url => {
    if (url.includes('StockCount')) return jsonResponse('1200')
    const page = Number(new URL(url).searchParams.get('page'))
    const values = all.slice((page - 1) * 100, page * 100)
    // Page 12 overtakes the previously observed end of page 11, without crossing a bucket boundary.
    if (page === 12) values[0] = all[1099]! + 0.01
    return jsonResponse(values.map(changepercent => ({ changepercent })))
  })
  const result = await fetchDistribution(http, clock, 'sina', 1000)
  const expected = await summarizeDistribution(1200, 100, async page => all.slice((page - 1) * 100, page * 100))
  expect(result.counts).toEqual(expected)
  expect(http.requests.some(({ url }) => new URL(url).searchParams.get('page') === '12')).toBe(true)
})

it('uses fewer pages than a full scan on a 5600 stock universe', async () => {
  const all = Array.from({ length: 5600 }, (_, index) => 15 - index / 200)
  const cache = new Map<number, number[]>()
  const load = vi.fn(async (page: number) => {
    if (!cache.has(page)) cache.set(page, all.slice((page - 1) * 100, page * 100))
    return cache.get(page)!
  })
  const result = await summarizeDistribution(5600, 100, load)
  expect(Object.values(result).reduce((a, b) => a + b)).toBe(5600)
  expect(cache.size).toBeLessThan(30)
})

it('retains the successful snapshot when both sources fail after expiration', async () => {
  const { service, http, clock } = setup()
  const saved = await service.getMarketDistribution()
  clock.advance(26_000)
  vi.spyOn(http, 'request').mockRejectedValue(new Error('offline'))
  const next = await service.getMarketDistribution()
  expect(next?.counts).toEqual(saved?.counts)
  expect(next?.meta).toEqual({ ...saved?.meta, cacheState: 'stale' })
})
