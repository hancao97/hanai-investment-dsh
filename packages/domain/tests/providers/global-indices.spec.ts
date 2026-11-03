import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GlobalIndexProvider } from '../../src/providers/global-indices.ts'
import { isGlobalMarketOpen, isGlobalSnapshotCurrent } from '../../../contracts/src/market-indices.ts'
import { HandlerHttpClient, jsonResponse, FakeClock } from '../helpers.ts'

const NOW = Date.parse('2026-10-27T10:00:00Z')
const qq = (symbol: string, code: string, time: string) => {
  const fields = Array<string>(34).fill('0')
  fields[2] = code; fields[3] = '26000'; fields[30] = time; fields[31] = '-12.5'; fields[32] = '-0.05'
  return `v_${symbol}="${fields.join('~')}";`
}
const tencent = qq('hkHSI', 'HSI', '2026/10/27 16:10:00') + qq('usIXIC', '.IXIC', '2026-10-26 16:00:00')
const sina = ['b_FTXIN9', 'b_KOSPI', 'b_NKY'].map((symbol, i) => `var hq_str_${symbol}="指数,${13000 + i},-10,-0.1,,,2026-10-27,${i === 0 ? '15:00:00' : '14:30:00'},0";`).join('\n')
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(() => vi.useRealTimers())

describe('independent global index batches', () => {
  it('returns cached quotes without HTTP even after their TTL expires, and does not fetch on an empty cache-only read', async () => {
    const clock = new FakeClock(NOW)
    const http = new HandlerHttpClient(url => ({ status: 200, body: url.includes('qt.gtimg') ? tencent : sina }))
    const provider = new GlobalIndexProvider(http, clock)
    expect((await provider.get(true)).meta.cacheState).toBe('unavailable')
    expect(http.requests).toHaveLength(0)
    const initial = await provider.get()
    const calls = http.requests.length
    clock.advance(24 * 3_600_000)
    const cached = await provider.get(true)
    expect(http.requests).toHaveLength(calls)
    expect(cached.meta.cacheState).toBe('cached')
    expect(cached.meta.fetchedAt).toBe(initial.meta.fetchedAt)
    expect(cached.indices.map(row => row.meta.sourceTimestamp)).toEqual(initial.indices.map(row => row.meta.sourceTimestamp))
    await provider.get()
    expect(http.requests.length).toBeGreaterThan(calls)
  })
  it('loads five exact cash indices in two requests and preserves market dates and New York DST', async () => {
    const clock = new FakeClock(NOW)
    const http = new HandlerHttpClient(url => ({ status: 200, body: url.includes('qt.gtimg') ? tencent : sina }))
    const provider = new GlobalIndexProvider(http, clock)
    const result = await provider.get()
    expect(result.indices).toHaveLength(5)
    expect(result.indices.every(row => row.price !== null && row.meta.cacheState === 'fresh')).toBe(true)
    expect(result.indices.find(row => row.code === 'IXIC')).toMatchObject({ marketDate: '2026-10-26', meta: { sourceTimestamp: '2026-10-26T20:00:00.000Z' } })
    expect(result.indices.find(row => row.code === 'N225')?.meta.sourceTimestamp).toBe('2026-10-27T06:30:00.000Z')
    expect(result.indices.find(row => row.code === 'XIN9')?.price).toBe(13000)
    expect(http.requests).toHaveLength(2)
    expect(http.requests[1]?.url).toContain('b_FTXIN9')
    expect(http.requests.some(item => /CHA50CFD|hf_GC|hf_CL/.test(item.url))).toBe(false)
    const cached = await provider.get()
    expect(http.requests).toHaveLength(2)
    expect(cached.indices[0]?.meta.cacheState).toBe('cached')
    expect(cached.indices[0]?.meta.fetchedAt).toBe(result.indices[0]?.meta.fetchedAt)
    expect(isGlobalSnapshotCurrent(cached, NOW)).toBe(true)
  })

  it('falls back only for missing rows, retaining good Tencent results', async () => {
    const http = new HandlerHttpClient(url => {
      if (url.includes('qt.gtimg')) return { status: 200, body: qq('hkHSI', 'HSI', '2026/10/27 16:10:00') }
      if (url.includes('hq.sinajs')) return { status: 200, body: sina }
      return jsonResponse({ data: { diff: [{ f12: 'NDX', f13: 100, f2: 26001, f3: 1, f4: 250, f124: Date.parse('2026-10-26T20:00:00Z') / 1000 }] } })
    })
    const result = await new GlobalIndexProvider(http, new FakeClock(NOW)).get()
    expect(result.indices.find(row => row.code === 'HSI')?.meta.providerId).toBe('tencent-global')
    expect(result.indices.find(row => row.code === 'IXIC')?.meta.providerId).toBe('eastmoney-global-fallback')
    expect(new URL(http.requests[2]!.url).searchParams.get('secids')).toBe('100.NDX')
    expect(http.requests).toHaveLength(3)
  })

  it('opens the common circuit after three failures and retries after five minutes', async () => {
    const clock = new FakeClock(NOW)
    const http = new HandlerHttpClient(() => jsonResponse({}, 503))
    const provider = new GlobalIndexProvider(http, clock)
    for (let attempt = 0; attempt < 3; attempt += 1) { await provider.get(); clock.advance(60_001) }
    const failures = await provider.get()
    expect(failures.indices.every(row => row.price === null && row.meta.cacheState === 'unavailable')).toBe(true)
    expect(http.requests).toHaveLength(9)
    expect(provider.circuit.isOpen('sina')).toBe(true)
    clock.advance(300_001)
    await provider.get()
    expect(http.requests).toHaveLength(12)
  })

  it('uses the US quote field rather than Sina acquisition time and rejects malformed dates', async () => {
    const fields = Array<string>(27).fill('0')
    fields[0] = '纳斯达克'; fields[1] = '26000'; fields[2] = '0.82'; fields[3] = '2026-10-27 09:38:41'; fields[4] = '214'; fields[25] = 'Oct 26 04:00PM EDT'
    const http = new HandlerHttpClient(url => {
      if (url.includes('qt.gtimg')) return { status: 200, body: qq('hkHSI', 'HSI', '2026/02/30 16:00:00') }
      if (url.includes('hq.sinajs')) return { status: 200, body: sina + `\nvar hq_str_gb_ixic="${fields.join(',')}";` }
      return jsonResponse({}, 503)
    })
    const data = await new GlobalIndexProvider(http, new FakeClock(NOW)).get()
    expect(data.indices.find(row => row.code === 'IXIC')).toMatchObject({ marketDate: '2026-10-26', meta: { providerId: 'sina-global', sourceTimestamp: '2026-10-26T20:00:00.000Z' } })
    expect(data.indices.find(row => row.code === 'HSI')).toMatchObject({ price: null, meta: { cacheState: 'unavailable' } })
  })

  it('keeps prior rows with their original times when the next batch fails', async () => {
    const clock = new FakeClock(NOW)
    let online = true
    const http = new HandlerHttpClient(url => online ? { status: 200, body: url.includes('qt.gtimg') ? tencent : sina } : jsonResponse({}, 503))
    const provider = new GlobalIndexProvider(http, clock)
    const first = await provider.get()
    clock.advance(6 * 3_600_000 + 1)
    online = false
    const stale = await provider.get()
    expect(stale.indices.map(row => row.price)).toEqual(first.indices.map(row => row.price))
    expect(stale.indices.every(row => row.meta.cacheState === 'stale')).toBe(true)
    expect(stale.indices[0]?.meta.fetchedAt).toBe(first.indices[0]?.meta.fetchedAt)
  })

  it('uses winter New York time and polls US hours independently of the A-share close', async () => {
    const now = Date.parse('2026-11-03T10:00:00Z')
    const http = new HandlerHttpClient(url => ({ status: 200, body: url.includes('qt.gtimg') ? qq('usIXIC', '.IXIC', '2026-11-02 16:00:00') : '' }))
    const data = await new GlobalIndexProvider(http, new FakeClock(now)).get()
    expect(data.indices.find(row => row.code === 'IXIC')?.meta.sourceTimestamp).toBe('2026-11-02T21:00:00.000Z')
    expect(isGlobalMarketOpen(Date.parse('2026-10-27T14:00:00Z'))).toBe(true)
    expect(isGlobalMarketOpen(Date.parse('2026-11-03T14:00:00Z'))).toBe(false)
    expect(isGlobalMarketOpen(Date.parse('2026-11-03T15:00:00Z'))).toBe(true)
    expect(isGlobalMarketOpen(Date.parse('2026-10-31T10:00:00Z'))).toBe(false)
  })
})
