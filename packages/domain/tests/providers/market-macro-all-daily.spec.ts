import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketMacroAllDailyProvider } from '../../src/providers/market-macro-all-daily.ts'
import { MarketMacroInputs, parseNavPage } from '../../src/providers/market-macro-inputs.ts'
import type { MarketMacroAllProvider } from '../../src/providers/market-macro-all.ts'
import { MACRO_ETFS } from '../../../contracts/src/market-macro.ts'
import { isMarketPanelPayload } from '../../../contracts/src/market-history.ts'
import { SourceCircuit } from '../../src/providers/source-circuit.ts'
import { FakeClock, HandlerHttpClient, jsonResponse } from '../helpers.ts'

const NOW = Date.parse('2026-10-28T10:00:00+08:00')
const dates = ['2023-06-09', '2023-06-14', '2026-10-26', '2026-10-27']
const meta = { providerId: 'test', sourceName: '测试夹具', sourceTimestamp: dates.at(-1)!, fetchedAt: new Date(NOW).toISOString(), cacheState: 'fresh' as const }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(() => vi.useRealTimers())

function setup() {
  const clock = new FakeClock(NOW)
  let missing = false
  const codes = [...MACRO_ETFS.map(fund => fund.code), '563000', '515930']
  const directory = [...MACRO_ETFS.map(fund => ({ ...fund, inceptionDate: '2012-01-01' })), { code: '563000', name: '新ETF', inceptionDate: '2026-10-25' }]
  const http = new HandlerHttpClient(url => {
    const query = new URL(url).searchParams
    if (url.includes('pingzhongdata')) return { status: 200, body: `var Data_netWorthTrend = ${JSON.stringify(dates.map(date => ({ x: Date.parse(`${date}T00:00:00+08:00`), y: 4 })))};` }
    if (url.includes('/f10/lsjz')) return jsonResponse({ TotalCount: 1, Data: { LSJZList: [{ FSRQ: '2026-10-27', DWJZ: '4.1' }] } })
    if (query.get('sqlId') === 'FUND_LIST') return jsonResponse({ pageHelp: { total: 4, pageCount: 1 }, result: directory.filter(fund => fund.code.startsWith('5')).map(fund => ({ fundCode: fund.code, INDEX_CODE: '000300', listingDate: fund.code === '563000' ? '20261027' : '20120528' })) })
    if (query.get('CATALOGID') === '1105') return jsonResponse([{ metadata: { pagecount: 1, pageno: 1, recordcount: 1 }, data: [{ sys_key: '<u>159919</u>', ssrq: '2012-05-28', jjlb: 'ETF' }] }])
    if (url.includes('szse.cn')) {
      const rows = dates.filter(date => date >= query.get('txtStart')! && date <= query.get('txtEnd')!).map(date => ({ fund_code: '159919', size_date: date, current_size: '100000' }))
      return jsonResponse([{ metadata: { pagecount: 1, pageno: 1, recordcount: rows.length }, data: rows }])
    }
    const date = query.get('STAT_DATE')!
    const rows = codes.filter(code => code.startsWith('5') && !(missing && code === '563000' && date === '2026-10-27')).map(code => ({ SEC_CODE: code, STAT_DATE: date, TOT_VOL: '100000' }))
    return jsonResponse({ pageHelp: { total: rows.length, pageCount: 1 }, result: rows })
  })
  const circuit = new SourceCircuit({ clock })
  const inputs = new MarketMacroInputs(http, clock, circuit)
  const provider = new MarketMacroAllDailyProvider(http, clock, circuit, { getDirectory: async () => directory } as MarketMacroAllProvider, inputs,
    async () => ({ points: dates.map(date => ({ date, close: 4000 })), meta }))
  return { provider, inputs, http, clock, circuit, missing: (value: boolean) => { missing = value } }
}

describe('full-directory ETF daily inputs', () => {
  it('fetches an older requested NAV window once and preserves already saved newer observations and shares', async () => {
    const clock = new FakeClock(NOW)
    const http = new HandlerHttpClient(() => ({ status: 200, body: `var Data_netWorthTrend = [{"x":${Date.parse('2019-10-08T00:00:00+08:00')},"y":3},{"x":${Date.parse('2026-10-27T00:00:00+08:00')},"y":4}];` }))
    const inputs = new MarketMacroInputs(http, clock, new SourceCircuit({ clock }))
    const fetchedAt = new Date(NOW).toISOString()
    inputs.restore({ funds: [{ code: '510300', navFetchedAt: fetchedAt, navs: [{ date: '2026-10-27', value: 4 }], shares: [{ date: '2026-10-27', value: 100, fetchedAt }] }], meta: { ...meta, fetchedAt } })
    const range = { from: '2019-10-08', to: '2019-10-11' }
    const navs = await inputs.nav('510300', range)
    expect(navs.get('2019-10-08')).toBe(3)
    expect(navs.get('2026-10-27')).toBe(4)
    inputs.clear()
    await inputs.nav('510300', range)
    expect(http.requests).toHaveLength(1)
    expect(inputs.snapshot()?.funds[0]?.shares).toHaveLength(1)
  })
  it('preserves raw business records when caches are cleared during an in-flight NAV request', async () => {
    const clock = new FakeClock(NOW)
    let release!: (value: { status: number; body: string }) => void
    const http = new HandlerHttpClient(() => new Promise(resolve => { release = resolve }))
    const inputs = new MarketMacroInputs(http, clock, new SourceCircuit({ clock }))
    const pending = inputs.nav('510300')
    inputs.clear()
    release({ status: 200, body: `var Data_netWorthTrend = [{"x":${Date.parse('2026-10-27T00:00:00+08:00')},"y":4}];` })
    await pending
    const saved = inputs.snapshot()
    expect(saved?.funds[0]).toMatchObject({ code: '510300', navs: [{ date: '2026-10-27', value: 4 }] })
    inputs.clear()
    expect(inputs.snapshot()).toEqual(saved)
    await inputs.nav('510300')
    expect(http.requests).toHaveLength(1)
  })
  it('uses listing and liquidation dates, sums matching raw inputs and resumes persisted raw data after restart', async () => {
    const { provider, inputs, http, clock, circuit } = setup()
    let result = await provider.get(null)
    expect(result?.points.map(row => row.assets)).toEqual([160, 200])
    result = await provider.get(result)
    expect(result?.points).toEqual([
      { date: dates[0], assets: 200, fourAssets: 160, otherAssets: 40 },
      { date: dates[1], assets: 160, fourAssets: 160, otherAssets: 0 },
      { date: dates[2], assets: 160, fourAssets: 160, otherAssets: 0 },
      { date: dates[3], assets: 200, fourAssets: 160, otherAssets: 40 },
    ])
    expect(result?.complete).toBe(true)
    expect(isMarketPanelPayload('macro.etf.all.daily', result)).toBe(true)
    const seed = inputs.snapshot()!
    expect(isMarketPanelPayload('macro.etf.inputs', seed)).toBe(true)
    const count = http.requests.length
    const restored = new MarketMacroInputs(http, clock, circuit)
    restored.restore(seed)
    await restored.nav('510300')
    await restored.shares(['510300', '159919'], dates.slice(2), dates.at(-1)!)
    expect(http.requests).toHaveLength(count)
    clock.advance(6 * 3_600_000 + 1)
    expect((await restored.nav('510300')).get('2026-10-27')).toBe(4.1)
    expect(http.requests.at(-1)?.url).toContain('/f10/lsjz?')
    expect((await restored.nav('510300')).get('2023-06-09')).toBe(4)
    expect(isMarketPanelPayload('macro.etf.all.daily', { ...result, points: result!.points.map(row => ({ ...row, otherAssets: 100 })) })).toBe(false)
  })

  it('records single-day gaps and continues older history, retries gaps only on another manual generation', async () => {
    const { provider, missing, clock } = setup()
    missing(true)
    const first = await provider.get(null)
    expect(first?.points).toHaveLength(1)
    expect(first?.missingDates).toEqual([{ date: '2026-10-27', reason: '缺同日份额或净值：563000' }])
    const older = await provider.get(first)
    expect(older?.points).toHaveLength(3)
    expect(older?.complete).toBe(false)
    expect(isMarketPanelPayload('macro.etf.all.daily', older)).toBe(true)
    missing(false)
    const retried = await provider.get(older, null, true)
    expect(retried?.points).toHaveLength(4)
    expect(retried?.missingDates).toEqual([])
    expect(retried?.complete).toBe(true)
  })

  it('rejects invalid NAV pages rather than turning missing or out-of-range records into zero', () => {
    expect(() => parseNavPage({ TotalCount: 1, Data: { LSJZList: [{ FSRQ: '2026-10-29', DWJZ: '1' }] } }, '2026-10-20', '2026-10-28')).toThrow()
    expect(() => parseNavPage({ TotalCount: 1, Data: { LSJZList: [{ FSRQ: '2026-10-27', DWJZ: '--' }] } }, '2026-10-20', '2026-10-28')).toThrow()
  })
})
