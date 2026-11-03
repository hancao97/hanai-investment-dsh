import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defaultMacroRange, isMacroRange, macroFiveYearsBefore } from '../src/macro-range.ts'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-29T20:00:00+08:00')) })
afterEach(() => vi.useRealTimers())

it('accepts past windows and caps each query at five calendar years', () => {
  expect(defaultMacroRange()).toEqual({ from: '2021-10-29', to: '2026-10-29' })
  expect(isMacroRange({ from: '2015-01-01', to: '2020-01-01' })).toBe(true)
  expect(isMacroRange({ from: '2014-12-31', to: '2020-01-01' })).toBe(false)
  expect(isMacroRange({ from: '2026-10-30', to: '2026-10-30' })).toBe(false)
  expect(isMacroRange({ from: '2020-02-30', to: '2020-03-01' })).toBe(false)
  expect(isMacroRange({ from: '2020-03-02', to: '2020-03-01' })).toBe(false)
  expect(macroFiveYearsBefore('2024-02-29')).toBe('2019-02-28')
})

it('defaults to the previous closed workday before close and on weekends', () => {
  expect(defaultMacroRange(Date.parse('2026-10-29T10:00:00+08:00')).to).toBe('2026-10-28')
  expect(defaultMacroRange(Date.parse('2026-10-31T20:00:00+08:00')).to).toBe('2026-10-30')
  expect(defaultMacroRange(Date.parse('2026-11-02T09:00:00+08:00')).to).toBe('2026-10-30')
})
