import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_SCAN_QUERY } from '../../contracts/src/market-scan.ts'
import { MarketScanProvider, parseMarketScan, scanParameters } from '../src/providers/market-scan.ts'
import { SourceCircuit } from '../src/providers/source-circuit.ts'
import { systemClock } from '../src/http.ts'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T10:00:00+08:00')) })
afterEach(() => vi.useRealTimers())
const stock = { ticker: '000001', name: '平安银行', current_price: 10, pe_ttm: 12, pb: null, roe: 15, market_cap: 200e8, main_net_inflow_5d: 0 }
const response = () => ({ status: 'ready', initializing: false, error_code: null, total: 1, limit: 100, offset: 0, snapshot_date: '2026-10-30', stocks: [stock] })
it('maps supported conditions and units to the public server query, including dividend yield and page offsets', () => {
  const params = scanParameters({ ...DEFAULT_SCAN_QUERY, search: '银行', page: 2, ranges: { dividendYield: { min: 3 }, marketCap: { min: 100 }, netInflow5d: { min: -20 } } })
  expect(params.get('min_dv_ratio')).toBe('3'); expect(params.get('min_market_cap')).toBe('10000000000')
  expect(params.get('min_main_net_inflow_5d')).toBe('-200000'); expect(params.get('offset')).toBe('100')
  expect(params.get('search')).toBe('银行')
  expect(() => scanParameters({ ...DEFAULT_SCAN_QUERY, ranges: { grossMargin: { max: 5 } } })).toThrow('下限')
})
it('keeps real zeros and unknown metrics separate and does not fabricate report dates', () => {
  const data = parseMarketScan(response(), DEFAULT_SCAN_QUERY, systemClock)
  expect(data.stocks[0]).toMatchObject({ secId: '0.000001', netInflow5d: 0, pb: null, revenueGrowth: null, marketCap: 200 })
  expect(data.snapshotDate).toBe('2026-10-30'); expect(data.meta.sourceTimestamp).toBe('2026-10-30')
  expect(parseMarketScan({ ...response(), snapshot_date: null }, DEFAULT_SCAN_QUERY, systemClock).meta.sourceTimestamp).toBeNull()
})
it('rejects warming-up, partial, duplicate, wrong-offset and condition-violating results', () => {
  for (const raw of [{ ...response(), status: 'initializing', stocks: [], total: 0 }, { ...response(), total: 2 }, { ...response(), offset: 100 }, { ...response(), total: 2, stocks: [stock, stock] }, { ...response(), stocks: [{ ...stock, roe: 'bad' }] }]) expect(() => parseMarketScan(raw, DEFAULT_SCAN_QUERY, systemClock)).toThrow()
  expect(() => parseMarketScan(response(), { ...DEFAULT_SCAN_QUERY, ranges: { roe: { min: 20 } } }, systemClock)).toThrow('不满足')
  expect(parseMarketScan({ ...response(), total: 0, stocks: [] }, DEFAULT_SCAN_QUERY, systemClock).total).toBe(0)
})
it('coalesces equal queries and caches 25 seconds while open, then preserves stale data on failures', async () => {
  const request = vi.fn(async () => ({ status: 200, body: JSON.stringify(response()) }))
  const provider = new MarketScanProvider({ request }, systemClock, new SourceCircuit({ clock: systemClock }))
  await Promise.all([provider.get(), provider.get()]); expect(request).toHaveBeenCalledTimes(1)
  await provider.get(); expect(request).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(25_001); request.mockRejectedValue(new Error('offline'))
  const saved = await provider.get(); expect(saved?.meta.cacheState).toBe('stale'); expect(saved?.stocks).toHaveLength(1)
  expect(await provider.get({ ...DEFAULT_SCAN_QUERY, search: 'other' })).toBeNull()
})
it('uses the shared three-failure breaker and does not return a rank sample as fallback', async () => {
  const request = vi.fn(async () => { throw new Error('offline') })
  const circuit = new SourceCircuit({ clock: systemClock })
  const provider = new MarketScanProvider({ request }, systemClock, circuit)
  for (const search of ['a', 'b', 'c', 'd']) await provider.get({ ...DEFAULT_SCAN_QUERY, search })
  expect(request).toHaveBeenCalledTimes(3); expect(circuit.isOpen('88ai-scan')).toBe(true)
  await vi.advanceTimersByTimeAsync(5 * 60_000 + 1); await provider.get({ ...DEFAULT_SCAN_QUERY, search: 'e' })
  expect(request).toHaveBeenCalledTimes(4)
})
