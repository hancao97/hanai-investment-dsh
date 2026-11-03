import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketMacroDailyProvider, parseShanghaiShares, parseUnitNav } from '../../src/providers/market-macro-daily.ts'
import { MACRO_ETFS } from '../../../contracts/src/market-macro.ts'
import { SourceCircuit } from '../../src/providers/source-circuit.ts'
import { FakeClock, HandlerHttpClient, jsonResponse } from '../helpers.ts'

const NOW = Date.parse('2026-10-28T10:00:00+08:00')
const dates = ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26', '2026-10-27']
const meta = { providerId: 'tencent', sourceName: '腾讯', sourceTimestamp: '2026-10-27', fetchedAt: new Date(NOW).toISOString(), cacheState: 'fresh' as const }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(() => vi.useRealTimers())
const navBody = (rows: unknown) => `var Data_netWorthTrend = ${JSON.stringify(rows)};`
const shRows = (date: string) => MACRO_ETFS.slice(0, 3).map(fund => ({ SEC_CODE: fund.code, STAT_DATE: date, TOT_VOL: '100,000' }))

function setup() {
  const clock = new FakeClock(NOW)
  let offline = false
  let missingSz = false
  const http = new HandlerHttpClient(url => {
    if (offline) return jsonResponse({}, 503)
    if (url.includes('pingzhongdata')) return { status: 200, body: navBody([...dates, '2026-10-18'].map(date => ({ x: Date.parse(`${date}T00:00:00+08:00`), y: 4 }))) }
    if (url.includes('/f10/lsjz')) return jsonResponse({ TotalCount: 0, Data: { LSJZList: [] } })
    const query = new URL(url).searchParams
    if (url.includes('szse.cn')) {
      const rows = dates.filter(date => date >= query.get('txtStart')! && date <= query.get('txtEnd')!)
        .filter(date => !missingSz || date !== '2026-10-27').map(date => ({ size_date: date, fund_code: '159919', current_size: '100,000' }))
      return jsonResponse([{ metadata: { pagecount: 1, pageno: 1, recordcount: rows.length }, data: rows, error: null }])
    }
    if (url.includes('query.sse.com.cn')) return jsonResponse({ pageHelp: { total: 3, pageCount: 1 }, result: shRows(query.get('STAT_DATE')!) })
    throw new Error(url)
  })
  const circuit = new SourceCircuit({ clock })
  const index = vi.fn<() => Promise<import('../../../contracts/src/market-macro.ts').MacroIndexData>>(async () => ({ points: dates.map(date => ({ date, close: 4000 })), meta }))
  const provider = new MarketMacroDailyProvider(http, clock, circuit, index)
  return { http, provider, clock, circuit, index, offline: () => { offline = true }, missing: () => { missingSz = true } }
}

describe('daily ETF size', () => {
  it('computes genuine daily assets from four same-date shares and NAV, backfills in bounded resumable batches', async () => {
    const { provider, http } = setup()
    const first = await provider.get(null)
    expect(first?.points).toEqual(dates.slice(2).map(date => ({ date, assets: 160 })))
    expect(first).toMatchObject({ expectedDays: 10, complete: false, meta: { sourceTimestamp: '2026-10-27' } })
    expect(http.requests.filter(item => item.url.includes('query.sse.com.cn'))).toHaveLength(8)
    const second = await provider.get(first)
    expect(second?.points).toEqual(dates.map(date => ({ date, assets: 160 })))
    expect(second?.complete).toBe(true)
    expect(http.requests.filter(item => item.url.includes('query.sse.com.cn'))).toHaveLength(10)
    expect(http.requests.filter(item => item.url.includes('pingzhongdata'))).toHaveLength(4)
    const count = http.requests.length
    expect(await provider.get(second)).toEqual(second)
    expect(http.requests).toHaveLength(count)
  })

  it('retains persisted progress and original source times on failures, including after cache clearing', async () => {
    const { provider, offline, clock } = setup()
    const first = await provider.get(null)
    offline()
    clock.advance(61_000)
    const stale = await provider.get(first)
    expect(stale).toEqual({ ...first, meta: { ...first!.meta, cacheState: 'stale' } })
    provider.clear()
    expect((await provider.get(first))?.points).toEqual(first?.points)
  })

  it('does not mark a stale index calendar as a complete current history and rechecks old latest shares', async () => {
    const { provider, http, clock, index } = setup()
    const first = await provider.get(null)
    const complete = await provider.get(first)
    const count = http.requests.filter(row => row.url.includes('query.sse.com.cn')).length
    clock.advance(6 * 3_600_000 + 1)
    await provider.get(complete)
    expect(http.requests.filter(row => row.url.includes('query.sse.com.cn'))).toHaveLength(count + 1)
    index.mockResolvedValue({ points: dates.map(date => ({ date, close: 4000 })), meta: { ...meta, cacheState: 'stale' } })
    expect((await provider.get(complete))?.meta.cacheState).toBe('stale')
  })

  it('does not fabricate a fourth fund when shares are missing', async () => {
    const { provider, missing } = setup()
    missing()
    expect(await provider.get(null)).toBeNull()
  })

  it('rejects wrong-date or incomplete exchange records and unsafe NAV values without executing scripts', () => {
    const raw = { pageHelp: { total: 3, pageCount: 1 }, result: shRows('2026-10-27') }
    expect(parseShanghaiShares(raw, '2026-10-27').get('510300')).toBe(100000)
    expect(() => parseShanghaiShares(raw, '2026-10-26')).toThrow('日期')
    expect(() => parseShanghaiShares({ ...raw, pageHelp: { total: 4, pageCount: 2 } }, '2026-10-27')).toThrow('完整')
    expect(() => parseUnitNav('var Data_netWorthTrend = runCode();', dates[0]!, dates.at(-1)!)).toThrow()
    expect(() => parseUnitNav(navBody([{ x: NOW, y: true }]), dates[0]!, '2026-10-28')).toThrow()
    const point = { x: Date.parse('2026-10-27T00:00:00+08:00'), y: 4 }
    expect(() => parseUnitNav(navBody([point, point]), dates[0]!, dates.at(-1)!)).toThrow('重复')
  })
})
