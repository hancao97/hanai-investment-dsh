import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketMacroProvider, parseEtfAssets } from '../../src/providers/market-macro.ts'
import { SourceCircuit } from '../../src/providers/source-circuit.ts'
import { FakeClock, HandlerHttpClient, jsonResponse } from '../helpers.ts'
import { MACRO_ETFS } from '../../../contracts/src/market-macro.ts'

const NOW = Date.parse('2026-10-27T16:00:00+08:00')
const meta = { providerId: 'tencent', sourceName: '腾讯', sourceTimestamp: '2026-10-27', fetchedAt: new Date(NOW).toISOString(), cacheState: 'fresh' as const }
const row = (date: string, assets = '1,000.25') => `<tr><td>${date}</td><td>20</td><td>10</td><td>100</td><td>${assets}</td><td>1%</td></tr>`
const table = (...rows: string[]) => `var gmbd_apidata={content:"<table><th>期末净资产（亿元）</th>${rows.join('')}</table>"};`
const bar = (date: string, close = 4000) => ({ date, close, open: close, high: close, low: close, volume: 100, amount: null })
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(() => vi.useRealTimers())

describe('macro public data', () => {
  it('queries older short windows independently and never appends newer quotes beyond the selected end', async () => {
    const clock = new FakeClock(NOW)
    const http = new HandlerHttpClient(url => {
      const date = new URL(url).searchParams.get('startDate')!
      return jsonResponse({ code: 200, data: [{ indexCode: '000300', tradeDate: date, close: 3000 }] })
    })
    const recent = vi.fn(async () => ({ period: 'daily' as const, bars: [bar('2026-10-27')], meta, hasMore: false }))
    const provider = new MarketMacroProvider(http, clock, new SourceCircuit({ clock }), recent)
    expect((await provider.getIndex({ from: '2019-10-08', to: '2019-10-09' }))?.points).toEqual([{ date: '2019-10-08', close: 3000 }])
    expect((await provider.getIndex({ from: '2020-10-08', to: '2020-10-09' }))?.points[0]?.date).toBe('2020-10-08')
    expect(http.requests).toHaveLength(2)
    expect(recent).toHaveBeenCalledWith('2019-10-10')
    expect(http.requests[0]?.url).toContain('endDate=20191009')
  })
  it('excludes intraday bars on fallback and rejects an exhausted but truncated history', async () => {
    const clock = new FakeClock(Date.parse('2026-10-27T10:00:00+08:00'))
    const unavailable = new HandlerHttpClient(() => ({ status: 503, body: '' }))
    const load = vi.fn(async () => ({ period: 'daily' as const, bars: [bar('2021-10-27'), bar('2026-10-26'), bar('2026-10-27', 4200)], meta, hasMore: false }))
    const provider = new MarketMacroProvider(unavailable, clock, new SourceCircuit({ clock }), load)
    const result = await provider.getIndex()
    expect(result?.points.at(-1)).toEqual({ date: '2026-10-26', close: 4000 })
    expect(result?.meta.sourceTimestamp).toBe('2026-10-26')
    const truncated = new MarketMacroProvider(unavailable, clock, new SourceCircuit({ clock }),
      async () => ({ period: 'daily' as const, bars: [bar('2024-01-02'), bar('2026-10-26')], meta, hasMore: false }))
    expect(await truncated.getIndex()).toBeNull()
  })
  it('uses official five-year closes, appends consistent recent closes, and keeps official history if recent quotes fail', async () => {
    const clock = new FakeClock(NOW)
    const dates = Array.from({ length: 1826 }, (_, i) => new Date(Date.parse('2021-10-27') + i * 86_400_000).toISOString().slice(0, 10)).filter(date => date <= '2026-10-26')
    const http = new HandlerHttpClient(() => jsonResponse({ code: 200, data: dates.map(date => ({ indexCode: '000300', tradeDate: date.replace(/-/g, ''), close: 4000 })) }))
    const recent = vi.fn(async () => ({ period: 'daily' as const, bars: [bar('2026-10-26'), bar('2026-10-27', 4100)], meta, hasMore: true }))
    const provider = new MarketMacroProvider(http, clock, new SourceCircuit({ clock }), recent)
    const result = await provider.getIndex()
    expect(result?.points.at(-1)).toEqual({ date: '2026-10-27', close: 4100 })
    expect(result?.meta.providerId).toBe('csi-index+tencent')
    expect(recent).toHaveBeenCalledTimes(1)
    expect(http.requests[0]?.url).toContain('csindex-home/perf/index-perf')
    recent.mockRejectedValue(new Error('offline'))
    clock.advance(6 * 3_600_000 + 1)
    expect((await provider.getIndex())?.meta).toMatchObject({ providerId: 'csi-index', sourceTimestamp: '2026-10-26' })
  })
  it('parses real quarter assets, excluding future, missing, malformed and out-of-range rows', () => {
    const body = table(row('2026-09-30'), row('2026-06-30', '0'), row('2026-02-30'), row('2027-03-31'), row('2020-12-31'), row('2026-03-31', '--'))
    expect(parseEtfAssets(body, '2021-10-27', '2026-10-27')).toEqual([{ date: '2026-09-30', assets: 1000.25 }])
    expect(() => parseEtfAssets('<table></table>', '2021-10-27', '2026-10-27')).toThrow('字段')
  })

  it('fetches four bounded public tables, aligns report periods and preserves source date through caching and failures', async () => {
    const clock = new FakeClock(NOW)
    let fail = false
    const http = new HandlerHttpClient(url => ({ status: fail ? 503 : 200,
      body: table(row('2026-06-30'), ...(url.includes('159919') ? [] : [row('2026-09-30')])) }))
    const circuit = new SourceCircuit({ clock })
    const provider = new MarketMacroProvider(http, clock, circuit, async () => ({ period: 'daily' as const, bars: [], meta: null, hasMore: false }))
    const first = await provider.getEtfs()
    expect(first?.funds.map(fund => fund.code)).toEqual(MACRO_ETFS.map(fund => fund.code))
    expect(first?.meta.sourceTimestamp).toBe('2026-06-30')
    expect(first?.funds.every(fund => fund.points.at(-1)?.date === '2026-06-30')).toBe(true)
    expect(http.requests).toHaveLength(4)
    await provider.getEtfs()
    expect(http.requests).toHaveLength(4)
    fail = true
    clock.advance(6 * 3_600_000 + 1)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const old = await provider.getEtfs()
      expect(old?.funds).toEqual(first?.funds)
      expect(old?.meta).toMatchObject({ sourceTimestamp: '2026-06-30', fetchedAt: first?.meta.fetchedAt, cacheState: 'stale' })
      clock.advance(60_001)
    }
    expect(circuit.isOpen('eastmoney-fund')).toBe(true)
  })

  it('loads five-year index pages via the existing kline chain and rejects stalled pagination', async () => {
    const clock = new FakeClock(NOW)
    const load = vi.fn(async (before?: string) => ({ period: 'daily' as const, bars: before === undefined ? [bar('2024-01-02'), bar('2026-10-27')] : [bar('2021-10-26'), bar('2021-10-28')], meta, hasMore: true }))
    const provider = new MarketMacroProvider(new HandlerHttpClient(() => ({ status: 503, body: '' })), clock, new SourceCircuit({ clock }), load)
    const index = await provider.getIndex()
    expect(index?.points.map(point => point.date)).toEqual(['2021-10-28', '2024-01-02', '2026-10-27'])
    expect(load.mock.calls).toEqual([[undefined], ['2024-01-02']])
    expect(await provider.getEtfs()).toBeNull()
    expect(await provider.getIndex()).toMatchObject({ meta: { sourceTimestamp: '2026-10-27', cacheState: 'cached' } })
    const stalled = new MarketMacroProvider(new HandlerHttpClient(() => ({ status: 503, body: '' })), clock, new SourceCircuit({ clock }),
      async () => ({ period: 'daily' as const, bars: [bar('2024-01-02')], meta, hasMore: true }))
    expect(await stalled.getIndex()).toBeNull()
  })
})
