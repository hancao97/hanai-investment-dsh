import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketMacroAllProvider, parseMacroEtfDirectory } from '../../src/providers/market-macro-all.ts'
import { SourceCircuit } from '../../src/providers/source-circuit.ts'
import { FakeClock, HandlerHttpClient, jsonResponse } from '../helpers.ts'
import { MACRO_ETFS, macroAllTotals, type MacroAllEtfData } from '../../../contracts/src/market-macro.ts'
import { isMarketPanelPayload } from '../../../contracts/src/market-history.ts'

const NOW = Date.parse('2026-10-28T10:00:00+08:00')
const directory = MACRO_ETFS.map(fund => ({ indexCode: '000300', productCode: String(fund.code), fundName: String(fund.name), fundType: 'ETF', exchange: fund.code.startsWith('5') ? '上海证券交易所' : '深圳证券交易所', inceptionDate: '2013-01-01' }))
const response = (rows = directory) => ({ code: '200', data: rows })
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(() => vi.useRealTimers())

describe('CSI currently listed CSI300 ETF quarter reference', () => {
  it('excludes feeder, enhanced, overseas and other-index products; rejects duplicate codes and incomplete directories', () => {
    const base = directory[0]!
    const rows = [...directory, { ...base, productCode: '000001', fundType: '联接基金' }, { ...base, productCode: '000002', fundType: '增强ETF' },
      { ...base, productCode: '3188 HK Equity', exchange: '香港交易所' }, { ...base, productCode: '510500', indexCode: '000905' }]
    expect(parseMacroEtfDirectory(response(rows))).toHaveLength(4)
    expect(() => parseMacroEtfDirectory(response([...directory, base]))).toThrow('代码')
    expect(() => parseMacroEtfDirectory(response(directory.slice(1)))).toThrow('缺失')
  })

  it('does not treat missing active funds as zero or include a fund before inception', () => {
    const funds = directory.map(fund => ({ code: fund.productCode, name: fund.fundName, inceptionDate: fund.inceptionDate,
      points: ['2026-03-31', '2026-06-30', '2026-09-30'].map(date => ({ date, assets: 100 })) }))
    funds.push({ code: '510320', name: '新ETF', inceptionDate: '2026-05-01', points: [{ date: '2026-09-30', assets: 200 }] })
    const data: MacroAllEtfData = { funds, universeAsOf: '2026-10-28', meta: { providerId: 'test', sourceName: 'test', sourceTimestamp: '2026-09-30', fetchedAt: new Date(NOW).toISOString(), cacheState: 'fresh' } }
    expect(macroAllTotals(data)).toEqual([{ date: '2026-03-31', assets: 400 }, { date: '2026-09-30', assets: 600 }])
    expect(isMarketPanelPayload('macro.etf.all.quarter', data)).toBe(true)
    expect(isMarketPanelPayload('macro.etf.all.quarter', { ...data, funds: [...funds, funds[0]] })).toBe(false)
    expect(isMarketPanelPayload('macro.etf.all.quarter', { ...data, meta: { ...data.meta, sourceTimestamp: '2026-10-28' } })).toBe(false)
  })

  it('fetches dated quarter tables instead of undated directory AUM and retains old values on source failure', async () => {
    const clock = new FakeClock(NOW)
    let fail = false
    const http = new HandlerHttpClient(url => {
      if (url.includes('csindex.com.cn')) return jsonResponse(response([...directory, { ...directory[0]!, productCode: '510320', inceptionDate: '2026-10-01' }]))
      return { status: fail ? 503 : 200, body: '<th>期末净资产（亿元）</th><tr><td>2026-09-30</td><td>1</td><td>1</td><td>1</td><td>100</td><td>1%</td></tr>' }
    })
    const provider = new MarketMacroAllProvider(http, clock, new SourceCircuit({ clock }))
    const first = (await provider.get())!
    expect(first.funds).toHaveLength(5)
    expect(first.funds.find(fund => fund.code === '510320')?.points).toEqual([])
    expect(macroAllTotals(first)).toEqual([{ date: '2026-09-30', assets: 400 }])
    expect(first.meta.sourceTimestamp).toBe('2026-09-30')
    expect(first.universeAsOf).toBe('2026-10-28')
    expect(http.requests).toHaveLength(5)
    expect(isMarketPanelPayload('macro.etf.all.quarter', first)).toBe(true)
    await provider.get()
    expect(http.requests).toHaveLength(5)
    fail = true
    clock.advance(6 * 3_600_000 + 1)
    const stale = await provider.get()
    expect(stale?.funds).toEqual(first.funds)
    expect(stale?.meta).toMatchObject({ cacheState: 'stale', sourceTimestamp: '2026-09-30', fetchedAt: first.meta.fetchedAt })
  })
})
