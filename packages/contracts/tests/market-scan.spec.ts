import { expect, it } from 'vitest'
import { DEFAULT_SCAN_QUERY, SCAN_PRESETS, scanQueryError } from '../src/market-scan.ts'

it('keeps advanced preset conditions explicit, including dividend yield and market-cap units', () => {
  const dividend = SCAN_PRESETS.find(item => item.name === '高股息')!
  expect(dividend.ranges).toEqual({ roe: { min: 8 }, dividendYield: { min: 3 } })
  expect(SCAN_PRESETS.find(item => item.name === '优质低估')!.ranges.marketCap).toEqual({ min: 100 })
  for (const preset of SCAN_PRESETS) expect(scanQueryError({ ...DEFAULT_SCAN_QUERY, ranges: preset.ranges })).toBeNull()
})
it('rejects inverted, unbounded or unknown financial conditions while allowing real negative growth', () => {
  expect(scanQueryError({ ...DEFAULT_SCAN_QUERY, ranges: { profitGrowth: { min: -10 } } })).toBeNull()
  expect(scanQueryError({ ...DEFAULT_SCAN_QUERY, ranges: { pe: { min: 20, max: 10 } } })).toContain('下限')
  expect(scanQueryError({ ...DEFAULT_SCAN_QUERY, ranges: { roe: { min: Infinity } } })).toContain('数值')
  expect(scanQueryError({ ...DEFAULT_SCAN_QUERY, ranges: { marketCap: { min: -1 } } })).toContain('不能为负')
  expect(scanQueryError({ ...DEFAULT_SCAN_QUERY, ranges: { roe: {} } })).toContain('无效')
  expect(scanQueryError({ ...DEFAULT_SCAN_QUERY, ranges: JSON.parse('{"__proto__":{"min":1}}') })).toContain('无效')
})
