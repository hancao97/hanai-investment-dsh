import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketMacroCapitalProvider, parseMacroCapital } from '../../src/providers/market-macro-capital.ts'
import { SourceCircuit } from '../../src/providers/source-circuit.ts'
import { FakeClock, HandlerHttpClient, jsonResponse } from '../helpers.ts'
import { isMarketPanelPayload } from '../../../contracts/src/market-history.ts'
import type { MacroCapitalData } from '../../../contracts/src/market-macro.ts'

const NOW = Date.parse('2026-10-28T10:00:00+08:00')
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(() => vi.useRealTimers())

describe('SSE CSI300 tradable market cap', () => {
  it('loads a preceding official anchor when the selected recent month is unpublished', async () => {
    const clock = new FakeClock(NOW)
    const http = new HandlerHttpClient(url => new URL(url).searchParams.get('MDATE') === '202609'
      ? jsonResponse({ result: [{ MDATE: '20260930', CPT_NGT: '500000' }] }) : jsonResponse({ result: [] }))
    const reference = { get: vi.fn(async () => ({ points: [{ date: '2026-10-08', floatCap: 490000, membershipDate: '2026-10-05' }], checkedDates: ['2026-10-08'], missingDates: [], expectedDays: 1, complete: true,
      meta: { providerId: 'test', sourceName: '重建参考', sourceTimestamp: '2026-10-08', fetchedAt: new Date(NOW).toISOString(), cacheState: 'fresh' as const } })) }
    const provider = new MarketMacroCapitalProvider(http, clock, new SourceCircuit({ clock }), reference as never)
    const range = { from: '2026-10-01', to: '2026-10-08' }
    const result = (await provider.get(null, false, range))!
    expect(result.reference?.points[0]?.date).toBe('2026-10-08')
    expect(result.points.at(-1)?.date).toBe('2026-09-30')
    expect(reference.get).toHaveBeenCalledWith(undefined, '2026-09-30', false, range)
    expect(isMarketPanelPayload('macro.capital', result)).toBe(true)
    expect(isMarketPanelPayload('macro.capital', (await provider.get(result, false, range))!)).toBe(true)
  })
  it('requests only months in an older chosen window', async () => {
    const clock = new FakeClock(NOW)
    const http = new HandlerHttpClient(url => {
      const month = new URL(url).searchParams.get('MDATE')!
      return jsonResponse({ result: [{ MDATE: `${month}08`, CPT_NGT: '500000' }] })
    })
    const provider = new MarketMacroCapitalProvider(http, clock, new SourceCircuit({ clock }))
    const result = await provider.get(null, false, { from: '2019-10-01', to: '2019-10-31' })
    expect(result?.points).toEqual([{ date: '2019-10-08', floatCap: 500000 }])
    expect(result?.checkedMonths).toEqual(['201910'])
    expect(result?.complete).toBe(true)
    expect(http.requests).toHaveLength(1)
  })
  it('supplements archives already marked complete from verified legacy reports without refetching or inventing recent values', async () => {
    const clock = new FakeClock(NOW)
    const http = new HandlerHttpClient(() => { throw new Error('must not fetch') })
    const checkedMonths = Array.from({ length: 61 }, (_, i) => { const date = new Date(Date.UTC(2021, 9 + i, 1)); return date.toISOString().slice(0, 7).replace('-', '') })
    const previous: MacroCapitalData = { points: [{ date: '2021-12-01', floatCap: 378027.78 }, { date: '2026-09-30', floatCap: 504119.48 }], checkedMonths, complete: true,
      meta: { providerId: 'sse-statistics', sourceName: '上交所统计月报', sourceTimestamp: '2026-09-30', fetchedAt: new Date(NOW - 1000).toISOString(), cacheState: 'fresh' } }
    const provider = new MarketMacroCapitalProvider(http, clock, new SourceCircuit({ clock }))
    const result = (await provider.get(previous))!
    expect(result.points).toHaveLength(26)
    expect(result.points[0]).toEqual({ date: '2021-10-28', floatCap: 379575.33 })
    expect(result.points.find(point => point.date === '2021-11-30')?.floatCap).toBe(376494.44)
    expect(result.points.at(-1)).toEqual(previous.points.at(-1))
    expect(result.meta.sourceName).toContain('PDF')
    expect(isMarketPanelPayload('macro.capital', result)).toBe(true)
    expect(await provider.get(result)).toEqual(result)
    expect(http.requests).toHaveLength(0)
    const partial = { ...previous, checkedMonths: checkedMonths.filter(month => month !== '202110' && month !== '202111'), complete: false }
    expect((await provider.get(partial))?.points).toEqual(result.points)
    expect(http.requests).toHaveLength(0)
    const corrected = { ...previous, points: [{ date: '2021-10-28', floatCap: 379575.34 }, ...previous.points] }
    expect((await provider.get(corrected))?.points[0]?.floatCap).toBe(379575.34)
    clock.advance(6 * 3_600_000 + 1)
    const enrichedBeforeRefresh = (await provider.get(previous))!
    expect(enrichedBeforeRefresh.points).toEqual(result.points)
    expect(enrichedBeforeRefresh.complete).toBe(false)
    expect(enrichedBeforeRefresh.refreshMonths).toEqual(['202609', '202610'])
    expect(enrichedBeforeRefresh.checkedMonths).toEqual(checkedMonths)
    expect(isMarketPanelPayload('macro.capital', enrichedBeforeRefresh)).toBe(true)
    expect(http.requests).toHaveLength(0)
    expect((await provider.get(enrichedBeforeRefresh))?.points).toEqual(result.points)
  })
  it('reads the explicit tradable cap field in hundred million yuan and rejects wrong dates, duplicates and substituted fields', () => {
    const row = { MDATE: '20260901', CPT_NGT: '527896.32', CLS: '4611.44' }
    expect(parseMacroCapital({ result: [row] }, '202609')).toEqual([{ date: '2026-09-01', floatCap: 527896.32 }])
    expect(parseMacroCapital({ result: [] }, '202610')).toEqual([])
    for (const rows of [[{ ...row, MDATE: '20260931' }], [row, row], [{ ...row, CPT_NGT: undefined, calMkvSum: 500000 }], [{ ...row, CPT_NGT: '0' }]]) {
      expect(() => parseMacroCapital({ result: rows }, '202609')).toThrow()
    }
    expect(() => parseMacroCapital({ result: [row] }, '202608')).toThrow('日期')
    expect(() => parseMacroCapital({ result: [], error: 'rate limited' }, '202609')).toThrow()
  })

  it('persists bounded monthly progress without filling unpublished days, resumes, and rechecks recent months on a later manual call', async () => {
    const clock = new FakeClock(NOW)
    let fail = false
    const http = new HandlerHttpClient(url => {
      const month = new URL(url).searchParams.get('MDATE')!
      return fail ? jsonResponse({}, 503) : jsonResponse({ result: month === '202610' ? [] : [{ MDATE: `${month}01`, CPT_NGT: '500000' }] })
    })
    const provider = new MarketMacroCapitalProvider(http, clock, new SourceCircuit({ clock }))
    const first = (await provider.get(null))!
    expect(first.checkedMonths).toEqual(['202605', '202606', '202607', '202608', '202609', '202610'])
    expect(first.points).toHaveLength(5)
    expect(first.meta.sourceTimestamp).toBe('2026-09-01')
    expect(first.complete).toBe(false)
    expect(http.requests).toHaveLength(6)
    expect(isMarketPanelPayload('macro.capital', first)).toBe(true)
    expect(isMarketPanelPayload('macro.capital', { ...first, points: [{ date: '2026-10-01', floatCap: 0 }] })).toBe(false)
    expect(isMarketPanelPayload('macro.capital', { ...first, meta: { ...first.meta, sourceTimestamp: '2026-10-28' } })).toBe(false)
    const next = (await provider.get(first))!
    expect(next.checkedMonths).toHaveLength(12)
    expect(next.points).toHaveLength(11)
    expect(next.meta.sourceTimestamp).toBe('2026-09-01')
    const calls = http.requests.length
    await provider.get(first)
    expect(http.requests).toHaveLength(calls)
    clock.advance(6 * 3_600_000 + 1)
    const refreshed = (await provider.get(next))!
    expect(http.requests.slice(calls, calls + 2).map(request => new URL(request.url).searchParams.get('MDATE'))).toEqual(['202610', '202609'])
    fail = true
    clock.advance(60_001)
    const fallback = await provider.get(refreshed)
    expect(fallback?.points).toEqual(refreshed.points)
    expect(fallback?.meta).toMatchObject({ cacheState: 'stale', sourceTimestamp: refreshed.meta.sourceTimestamp, fetchedAt: refreshed.meta.fetchedAt })
  })
})
