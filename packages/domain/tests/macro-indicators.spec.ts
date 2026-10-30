import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { MacroIndicatorProvider, parseMacroIndicator } from '../src/providers/macro-indicators.ts'
import { SourceCircuit } from '../src/providers/source-circuit.ts'
import { systemClock } from '../src/http.ts'

const range = { from: '2026-01-01', to: '2026-10-28' }
const fetched = '2026-10-29T10:00:00Z'
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(fetched)) })
afterEach(() => vi.useRealTimers())
it('maps actual monthly fields, preserves zero/negative/null, and dates periods at month end', () => {
  const data = parseMacroIndicator('cpi', [{ REPORT_DATE: '2026-02-01 00:00:00', NATIONAL_SAME: -0.2, NATIONAL_SEQUENTIAL: 0 }, { REPORT_DATE: '2026-01-01', NATIONAL_SAME: null, NATIONAL_SEQUENTIAL: '0.5' }], range, fetched)
  expect(data.points).toEqual([{ date: '2026-01-31', values: { yoy: null, mom: 0.5 } }, { date: '2026-02-28', values: { yoy: -0.2, mom: 0 } }])
  expect(parseMacroIndicator('social', [{ date: '202602', tiosfs: -300 }], range, fetched).points[0]).toEqual({ date: '2026-02-28', values: { increment: -300 } })
  expect(parseMacroIndicator('industry', [{ REPORT_DATE: '2026-02-01', BASE_SAME: null, BASE_ACCUMULATE: 5 }], range, fetched).points[0]?.values).toEqual({ yoy: null, ytd: 5 })
})
it('rejects malformed reports and does not manufacture success from empty/all-null rows', () => {
  for (const rows of [[], [{ REPORT_DATE: 'invalid', NATIONAL_SAME: 1, NATIONAL_SEQUENTIAL: 2 }], [{ REPORT_DATE: '2026-02-01', NATIONAL_SAME: 1 }], [{ REPORT_DATE: '2026-02-01', NATIONAL_SAME: null, NATIONAL_SEQUENTIAL: null }]]) expect(() => parseMacroIndicator('cpi', rows, range, fetched)).toThrow()
})
it('retrieves every treasury page through the public token-free endpoint and preserves historical dates', async () => {
  const request = vi.fn(async (url: string) => {
    const params = new URL(url).searchParams
    expect(params.has('token')).toBe(false)
    expect(params.get('filter')).toContain('2026-01-01')
    const page = Number(params.get('pageNumber'))
    return { status: 200, body: JSON.stringify({ success: true, result: { pages: 2, data: [{ SOLAR_DATE: page === 1 ? '2026-10-28' : '2026-01-02', EMM00588704: 1, EMM00166462: 2, EMM00166466: 3, EMM00166469: 4 }] } }) }
  })
  const provider = new MacroIndicatorProvider({ request }, systemClock, new SourceCircuit())
  const data = await provider.get('yields', range)
  expect(request).toHaveBeenCalledTimes(2)
  expect(data.points.map(row => row.date)).toEqual(['2026-01-02', '2026-10-28'])
  expect(data.points[1]?.values).toEqual({ y2: 1, y5: 2, y10: 3, y30: 4 })
})
it('records failures in the existing source circuit and honors Host cancellation', async () => {
  const request = vi.fn(async () => ({ status: 503, body: '' }))
  const circuit = new SourceCircuit()
  const provider = new MacroIndicatorProvider({ request }, systemClock, circuit)
  for (let i = 0; i < 4; i++) await expect(provider.get('pmi', range)).rejects.toThrow()
  expect(request).toHaveBeenCalledTimes(3)
  expect(circuit.isOpen('eastmoney-macro')).toBe(true)
})
