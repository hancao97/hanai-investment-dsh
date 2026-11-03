import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchArms, parseArmsPoint } from '../../src/providers/market-arms.ts'
import { MacroIndicatorProvider } from '../../src/providers/macro-indicators.ts'
import { SourceCircuit } from '../../src/providers/source-circuit.ts'
import { FakeClock, HandlerHttpClient, jsonResponse } from '../helpers.ts'

const now = Date.parse('2026-10-30T10:20:00+08:00')
const row = (t: string, approx = false) => ({ t, up_count: 200, down_count: 100, flat_count: 10, up_amount: 400, down_amount: 100, approx })
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now) })
afterEach(() => { vi.useRealTimers() })

describe('88AI 成交额版市场广度', () => {
  it('calculates ratios from the same raw input and retains estimated status', () => {
    expect(parseArmsPoint({ ...row('10:15'), trin: 0.53 }, '2026-10-30', true).trin).toBe(0.53)
    expect(parseArmsPoint({ ...row('10:15'), trin: null }, '2026-10-30', true).trin).toBe(0.5)
    expect(parseArmsPoint({ ...row('10:15'), trin: null, up_amount: null }, '2026-10-30', true).trin).toBeNull()
    expect(() => parseArmsPoint({ ...row('10:15'), trin: -1 }, '2026-10-30', true)).toThrow()
    expect(parseArmsPoint(row('10:15', true), '2026-10-30', true)).toMatchObject({ trin: 0.5, adRatio: 2, amountRatio: 4, estimated: true })
    expect(parseArmsPoint({ ...row('10:15'), up_amount: 0 }, '2026-10-30', true).trin).toBeNull()
    expect(() => parseArmsPoint({ ...row('10:15'), down_count: -1 }, '2026-10-30', true)).toThrow()
  })
  it('fetches intraday data with its own date and source time', async () => {
    const http = new HandlerHttpClient(() => jsonResponse({ view: 'intraday', trade_date: '2026-10-30', points: [row('10:15')] }))
    const result = await fetchArms(http, new FakeClock(now), 'intraday')
    expect(result.meta.sourceTimestamp).toBe('2026-10-30T02:15:00.000Z')
    expect(result.points[0]?.trin).toBe(0.5)
  })
  it('rejects an outdated intraday snapshot during the trading session', async () => {
    const http = new HandlerHttpClient(() => jsonResponse({ view: 'intraday', trade_date: '2026-10-30', points: [row('09:30')] }))
    await expect(fetchArms(http, new FakeClock(now), 'intraday')).rejects.toThrow('数据已过期')
  })
  it('does not put an unfinished current day into daily history', async () => {
    const clock = new FakeClock(now)
    const http = new HandlerHttpClient(() => jsonResponse({ view: 'daily', trade_date: '2026-10-30', points: [row('2026-10-29', true), row('2026-10-30')] }))
    const provider = new MacroIndicatorProvider(http, clock, new SourceCircuit({ clock }))
    const data = await provider.get('arms', { from: '2026-10-01', to: '2026-10-30' })
    expect(data.points).toEqual([{ date: '2026-10-29', values: { trin: 0.5, adRatio: 2, amountRatio: 4 }, estimated: true, armsDetails: { upCount: 200, downCount: 100, upAmount: 400, downAmount: 100 } }])
    expect(data.checkedRange.to).toBe('2026-10-29')
    expect(http.requests[0]?.url).toContain('view=daily&days=250')
  })
})
