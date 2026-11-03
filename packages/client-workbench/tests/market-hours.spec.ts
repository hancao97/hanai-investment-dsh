import { describe, expect, it, vi } from 'vitest'
import { isMarketOpen, isMarketResting } from '../src/market-hours.ts'

describe('isMarketOpen', () => {
  it('uses resting cache through lunch and resumes at 13:00', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-30T11:29:00+08:00'))
      expect(isMarketResting()).toBe(false)
      vi.setSystemTime(new Date('2026-10-30T11:30:00+08:00'))
      expect(isMarketResting()).toBe(true)
      vi.setSystemTime(new Date('2026-10-30T13:00:00+08:00'))
      expect(isMarketResting()).toBe(false)
    } finally { vi.useRealTimers() }
  })
  it('treats Beijing trading hours on a weekday as open', () => {
    // 2026-10-23 周五；UTC 时刻对应北京时间 = UTC + 8。
    expect(isMarketOpen(new Date('2026-10-23T01:25:00Z'))).toBe(true) // 09:25
    expect(isMarketOpen(new Date('2026-10-23T02:00:00Z'))).toBe(true) // 10:00
    expect(isMarketOpen(new Date('2026-10-23T07:05:00Z'))).toBe(true) // 15:05
  })

  it('treats pre-open and post-close minutes as closed', () => {
    expect(isMarketOpen(new Date('2026-10-23T01:24:00Z'))).toBe(false) // 09:24
    expect(isMarketOpen(new Date('2026-10-23T07:06:00Z'))).toBe(false) // 15:06
    expect(isMarketOpen(new Date('2026-10-23T16:00:00Z'))).toBe(false) // 深夜
  })

  it('stays closed on weekends regardless of host timezone', () => {
    expect(isMarketOpen(new Date('2026-10-24T02:00:00Z'))).toBe(false) // 周六 10:00
    expect(isMarketOpen(new Date('2026-10-25T02:00:00Z'))).toBe(false) // 周日 10:00
  })
})
