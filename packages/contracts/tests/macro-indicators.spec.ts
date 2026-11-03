import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { firstMacroIndicatorGap, selectMacroIndicators, type MacroIndicatorData } from '../src/macro-indicators.ts'
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-29T20:00:00+08:00')) })
afterEach(() => vi.useRealTimers())

it('keeps both historical windows and latest known source period when an older range is fetched later', () => {
  const recent: MacroIndicatorData = { id: 'ppi', checkedRange: { from: '2021-10-29', to: '2026-10-29' }, points: [{ date: '2026-09-30', values: { yoy: 5 } }], meta: { providerId: 'eastmoney-macro', sourceName: '公开接口', sourceTimestamp: '2026-09-30', fetchedAt: '2026-10-29T10:00:00Z', cacheState: 'fresh' } }
  const older: MacroIndicatorData = { ...recent, checkedRange: { from: '2014-10-29', to: '2019-10-29' }, points: [{ date: '2019-09-30', values: { yoy: -1.2 } }], meta: { ...recent.meta, sourceTimestamp: '2019-09-30', fetchedAt: '2026-10-29T11:00:00Z' } }
  const values = [{ ppi: recent }, { ppi: older }]
  expect(selectMacroIndicators(values, recent.checkedRange).ppi?.points[0]?.values.yoy).toBe(5)
  expect(selectMacroIndicators(values, recent.checkedRange).ppi?.checkedRange).toEqual(recent.checkedRange)
  const selected = selectMacroIndicators(values, older.checkedRange).ppi!
  expect(selected.points[0]?.values.yoy).toBe(-1.2)
  expect(selected.meta.sourceTimestamp).toBe('2026-09-30')
  expect(selected.meta.fetchedAt).toBe('2026-10-29T11:00:00Z')
})
it('does not erase verified values with partial nulls and still accepts zero and negative revisions', () => {
  const range = { from: '2026-01-01', to: '2026-04-30' }
  const old: MacroIndicatorData = { id: 'money', checkedRange: range, points: [{ date: '2026-03-31', values: { m1: 2, m2: 5 } }], meta: { providerId: 'test', sourceName: 'test', sourceTimestamp: '2026-03-31', fetchedAt: '2026-10-29T10:00:00Z', cacheState: 'fresh' } }
  const next: MacroIndicatorData = { ...old, points: [{ date: '2026-03-31', values: { m1: null, m2: 0 } }, { date: '2026-04-30', values: { m1: null, m2: -1 } }], meta: { ...old.meta, fetchedAt: '2026-10-29T11:00:00Z' } }
  expect(selectMacroIndicators([{ money: old }, { money: next }], range).money?.points).toEqual([{ date: '2026-03-31', values: { m1: 2, m2: 0 } }, { date: '2026-04-30', values: { m1: null, m2: -1 } }])
})
it('recognizes combined reports but detects missing historical months, columns and end-month observations', () => {
  const range = { from: '2026-01-01', to: '2026-03-31' }
  const data: MacroIndicatorData = { id: 'industry', checkedRange: range, points: [{ date: '2026-02-28', values: { yoy: null, ytd: 6.3 } }, { date: '2026-03-31', values: { yoy: 5, ytd: 6 } }], meta: { providerId: 'test', sourceName: 'test', sourceTimestamp: '2026-03-31', fetchedAt: '2026-10-29T10:00:00Z', cacheState: 'fresh' } }
  expect(firstMacroIndicatorGap('industry', data, range)).toBeNull()
  expect(firstMacroIndicatorGap('retail', { ...data, id: 'retail' }, range)).toBeNull()
  expect(firstMacroIndicatorGap('industry', { ...data, points: data.points.slice(0, 1) }, range)).toBe('2026-03-31')
  expect(firstMacroIndicatorGap('industry', { ...data, points: [{ date: '2026-02-28', values: { yoy: null, ytd: null } }] }, range)).toBe('2026-02-28')
  expect(firstMacroIndicatorGap('money', { ...data, id: 'money' }, range)).toBe('2026-01-31')
})
