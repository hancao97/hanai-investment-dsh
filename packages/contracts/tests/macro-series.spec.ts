import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { selectMacroSeries, type MacroSeriesData } from '../src/macro-series.ts'
import { isMarketPanelPayload } from '../src/market-history.ts'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-29T20:00:00+08:00')) })
afterEach(() => vi.useRealTimers())
const range = { from: '2026-09-30', to: '2026-10-09' }
function data(at: string, cap: number, reference = false): MacroSeriesData {
  const meta = { providerId: 'test', sourceName: '公开来源', sourceTimestamp: reference ? '2026-09-30' : '2026-10-08', fetchedAt: at, cacheState: 'fresh' as const }
  const value: MacroSeriesData = { range, meta, etfs: null, daily: null, allEtfs: null, allDaily: null,
    index: { points: [{ date: '2026-09-30', close: 4000 }, { date: '2026-10-08', close: 4100 }], meta },
    capital: { points: [{ date: reference ? '2026-09-30' : '2026-10-08', floatCap: cap }], checkedMonths: [reference ? '202609' : '202610'], complete: true, meta } }
  if (reference) value.capital!.reference = { points: [{ date: '2026-10-08', floatCap: 480000, membershipDate: '2026-10-05' }], checkedDates: ['2026-10-08'], missingDates: [], expectedDays: 1, complete: true, meta: { ...meta, sourceTimestamp: '2026-10-08' } }
  return value
}

it('uses acquisition order per component and lets official observations replace reference values', () => {
  const newer = data('2026-10-29T10:00:00Z', 500000)
  const old = data('2026-10-28T10:00:00Z', 470000)
  old.meta = { ...old.meta, fetchedAt: '2026-10-29T11:00:00Z' }
  const result = selectMacroSeries([newer, old, data('2026-10-29T09:00:00Z', 460000, true)], range)
  expect(result.capital?.points.find(row => row.date === '2026-10-08')?.floatCap).toBe(500000)
  expect(result.capital?.reference).toBeUndefined()
  expect(result.index?.points).toHaveLength(2)
})

it('clips every date series to the requested window and validates stored ranges and components', () => {
  const cached = data('2026-10-29T10:00:00Z', 500000)
  expect(isMarketPanelPayload('macro.series', cached)).toBe(true)
  expect(isMarketPanelPayload('macro.series', { ...cached, range: { from: '2010-01-01', to: '2026-10-09' } })).toBe(false)
  expect(isMarketPanelPayload('macro.series', { ...cached, capital: { ...cached.capital, points: [{ date: '2026-10-08', floatCap: -1 }] } })).toBe(false)
  const result = selectMacroSeries([cached], { from: '2026-10-08', to: '2026-10-09' })
  expect(result.index?.points.map(row => row.date)).toEqual(['2026-10-08'])
})

it('keeps the previous official month-end when a month has only reconstructed daily capital', () => {
  const existing = data('2026-10-29T10:00:00Z', 470000, true)
  const october = { from: '2026-10-01', to: '2026-10-09' }
  const merged = selectMacroSeries([existing], october)
  expect(merged.capital?.points).toEqual([{ date: '2026-09-30', floatCap: 470000 }])
  expect(merged.capital?.reference?.points[0]?.date).toBe('2026-10-08')
  expect(isMarketPanelPayload('macro.series', merged)).toBe(true)
})
