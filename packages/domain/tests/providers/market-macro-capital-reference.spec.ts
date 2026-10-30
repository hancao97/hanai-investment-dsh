import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketMacroCapitalReferenceProvider } from '../../src/providers/market-macro-capital-reference.ts'
import { MarketMacroCapitalProvider } from '../../src/providers/market-macro-capital.ts'
import { SourceCircuit } from '../../src/providers/source-circuit.ts'
import { FakeClock, HandlerHttpClient, jsonResponse } from '../helpers.ts'
import { isMarketPanelPayload } from '../../../contracts/src/market-history.ts'
import type { MacroCapitalData } from '../../../contracts/src/market-macro.ts'

const NOW = Date.parse('2026-10-29T10:00:00+08:00')
const codes = Array.from({ length: 300 }, (_, i) => String(600000 + i))
const meta = { providerId: 'test', sourceName: 'test', sourceTimestamp: '2026-09-30', fetchedAt: new Date(NOW).toISOString(), cacheState: 'fresh' as const }
const members = async () => ({ updatedOn: '2026-10-26', codes })
const index = async () => ({ points: ['2026-10-26', '2026-10-27', '2026-10-28'].map(date => ({ date, close: 4000 })), meta })
const previous: MacroCapitalData = { points: [{ date: '2026-09-30', floatCap: 500000 }], checkedMonths: Array.from({ length: 61 }, (_, i) => new Date(Date.UTC(2021, 9 + i, 1)).toISOString().slice(0, 7).replace('-', '')), complete: true, meta }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(() => vi.useRealTimers())

function fixture(badDate = '') {
  const clock = new FakeClock(NOW)
  const http = new HandlerHttpClient(url => {
    const params = new URL(url).searchParams
    const date = /TRADE_DATE='(.*?)'/.exec(params.get('filter')!)![1]!
    const page = Number(params.get('pageNumber'))
    return jsonResponse({ success: true, result: { count: 300, pages: 3, data: codes.slice((page - 1) * 100, page * 100 - (date === badDate && page === 3 ? 1 : 0)).map(SECURITY_CODE => ({ SECURITY_CODE, TRADE_DATE: `${date} 00:00:00`, NOTLIMITED_MARKETCAP_A: 1e8 })) } })
  })
  const circuit = new SourceCircuit({ clock })
  return { clock, http, circuit, provider: new MarketMacroCapitalReferenceProvider(http, clock, circuit, index, members) }
}

describe('historical constituent reference denominator', () => {
  it('excludes the open session but includes today after the shared daily-close cutoff', async () => {
    const { clock, http, circuit } = fixture()
    const currentIndex = async () => ({ points: [{ date: '2026-10-29', close: 4000 }], meta })
    const provider = new MarketMacroCapitalReferenceProvider(http, clock, circuit, currentIndex, members)
    const open = await provider.get(undefined, '2026-10-28', false)
    expect(open.expectedDays).toBe(0)
    expect(http.requests).toHaveLength(0)
    clock.advance(5 * 3_600_000 + 5 * 60_000)
    const closed = await provider.get(open, '2026-10-28', false)
    expect(closed.points).toEqual([{ date: '2026-10-29', floatCap: 300, membershipDate: '2026-10-26' }])
    expect(closed.complete).toBe(true)
  })
  it('uses reference while the current report is empty, then adopts published official values on the next manual generation', async () => {
    const { clock, http, circuit } = fixture()
    let published = false
    const transport = new HandlerHttpClient(url => new URL(url).hostname === 'query.sse.com.cn'
      ? jsonResponse({ result: published && new URL(url).searchParams.get('MDATE') === '202610' ? [{ MDATE: '20261028', CPT_NGT: '510000' }] : [] })
      : http.request(url))
    const reference = new MarketMacroCapitalReferenceProvider(transport, clock, circuit, index, members)
    const provider = new MarketMacroCapitalProvider(transport, clock, circuit, reference)
    const initial = (await provider.get(previous, true))!
    expect(initial.reference?.points).toHaveLength(3)
    expect(initial.points.at(-1)?.date).toBe('2026-09-30')
    const frozen = structuredClone(initial)
    published = true
    clock.advance(6 * 3_600_000 + 1)
    const updated = (await provider.get(initial, true))!
    expect(updated.points.at(-1)).toEqual({ date: '2026-10-28', floatCap: 510000 })
    expect(updated.reference).toBeUndefined()
    expect(updated.officialMeta?.sourceTimestamp ?? updated.meta.sourceTimestamp).toBe('2026-10-28')
    expect(initial).toEqual(frozen)
    expect(isMarketPanelPayload('macro.capital', updated)).toBe(true)
  })
  it('sums only all 300 same-day values, persists provenance and retries gaps only on the next manual generation', async () => {
    const { provider, http } = fixture('2026-10-27')
    const first = await provider.get(undefined, '2026-09-30', false)
    expect(first.points).toEqual(['2026-10-26', '2026-10-28'].map(date => ({ date, floatCap: 300, membershipDate: '2026-10-26' })))
    expect(first.complete).toBe(true)
    expect(first.missingDates).toEqual([{ date: '2026-10-27', reason: '缺少成分股同日流通市值' }])
    expect(isMarketPanelPayload('macro.capital', { ...previous, reference: first, meta: { ...meta, fetchedAt: first.meta.fetchedAt } })).toBe(true)
    const calls = http.requests.length
    expect(await provider.get(first, '2026-09-30', false)).toBe(first)
    expect(http.requests).toHaveLength(calls)
    await provider.get(first, '2026-09-30', true)
    expect(http.requests).toHaveLength(calls + 3)
    expect((await provider.get(first, '2026-10-27', false)).points.map(point => point.date)).toEqual(['2026-10-28'])
    const invalid = { ...first, points: [{ ...first.points[0]!, membershipDate: '2026-10-29' }] }
    expect(isMarketPanelPayload('macro.capital', { ...previous, reference: invalid })).toBe(false)
  })

  it('rejects duplicate, wrong-date, zero and incomplete member records without inventing caps', async () => {
    for (const kind of ['duplicate', 'date', 'zero', 'members']) {
      const { clock, circuit } = fixture()
      const http = new HandlerHttpClient(() => jsonResponse({ success: true, result: { pages: 1, count: 300, data: codes.map((code, i) => ({ SECURITY_CODE: kind === 'duplicate' && i === 299 ? codes[0] : code, TRADE_DATE: kind === 'date' ? '2026-10-27 00:00:00' : '2026-10-28 00:00:00', NOTLIMITED_MARKETCAP_A: kind === 'zero' ? 0 : 1e8 })) } }))
      const provider = new MarketMacroCapitalReferenceProvider(http, clock, circuit, async () => ({ points: [{ date: '2026-10-28', close: 4000 }], meta }), async () => ({ updatedOn: '2026-10-26', codes: kind === 'members' ? codes.slice(1) : codes }))
      const result = await provider.get(undefined, '2026-09-30', false)
      expect(result.points).toEqual([])
      expect(result.missingDates).toHaveLength(1)
    }
  })

  it('bounds work to eight days, resumes across instances, and replaces reference days when monthly data arrives', async () => {
    const { clock, circuit, http } = fixture()
    const days = Array.from({ length: 10 }, (_, i) => `2026-10-${String(i + 12).padStart(2, '0')}`)
    const loadIndex = async () => ({ points: days.map(date => ({ date, close: 4000 })), meta })
    const loadMembers = async (date: string) => ({ codes, updatedOn: date })
    const first = await new MarketMacroCapitalReferenceProvider(http, clock, circuit, loadIndex, loadMembers).get(undefined, '2026-09-30', false)
    expect(first.checkedDates).toHaveLength(8)
    expect(first.complete).toBe(false)
    const next = await new MarketMacroCapitalReferenceProvider(http, clock, circuit, loadIndex, loadMembers).get(first, '2026-09-30', false)
    expect(next.points).toHaveLength(10)
    expect(next.complete).toBe(true)
    const ref = new MarketMacroCapitalReferenceProvider(http, clock, circuit, index, members)
    const capital = new MarketMacroCapitalProvider(http, clock, circuit, ref)
    const official = (await new MarketMacroCapitalProvider(http, clock, circuit).get(previous))!
    const result = (await capital.get(official))!
    expect(result.points.at(-1)).toEqual(previous.points.at(-1))
    expect(result.reference?.points).toHaveLength(3)
    expect(isMarketPanelPayload('macro.capital', result)).toBe(true)
    expect(result.officialMeta?.fetchedAt).toBe(official.meta.fetchedAt)
    expect(result.meta.sourceTimestamp).toBe('2026-10-28')
    const published = { ...result, points: [...result.points, { date: '2026-10-28', floatCap: 510000 }], officialMeta: { ...meta, sourceTimestamp: '2026-10-28' }, meta: { ...result.meta, sourceTimestamp: '2026-10-28' } }
    const replaced = (await capital.get(published))!
    expect(replaced.reference).toBeUndefined()
    expect(replaced.points.at(-1)?.floatCap).toBe(510000)
  })
})
