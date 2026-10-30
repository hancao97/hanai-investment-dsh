import type { ProviderMeta } from './index.ts'

export const SCAN_FIELDS = {
  pe: { label: 'PE(TTM)', unit: '倍', advanced: false, maximum: true },
  pb: { label: 'PB', unit: '倍', advanced: false, maximum: true },
  roe: { label: 'ROE', unit: '%', advanced: false, maximum: true },
  profitGrowth: { label: '净利增长', unit: '%', advanced: false, maximum: false },
  revenueGrowth: { label: '营收增长', unit: '%', advanced: false, maximum: false },
  marketCap: { label: '总市值', unit: '亿元', advanced: true, maximum: true },
  dividendYield: { label: '股息率', unit: '%', advanced: true, maximum: false },
  netInflow5d: { label: '5日主力净流', unit: '万元', advanced: true, maximum: false },
  netMargin: { label: '净利率', unit: '%', advanced: true, maximum: false },
  grossMargin: { label: '毛利率', unit: '%', advanced: true, maximum: false },
} as const
export type ScanMetric = keyof typeof SCAN_FIELDS
export type ScanSort = ScanMetric | 'code' | 'price' | 'changePct'
export interface MarketScanQuery {
  search: string
  industries?: string[]
  page: number
  ranges: Partial<Record<ScanMetric, { min?: number; max?: number }>>
  sort: ScanSort
  order: 'asc' | 'desc'
}
export const DEFAULT_SCAN_QUERY: MarketScanQuery = { search: '', page: 1, ranges: {}, sort: 'marketCap', order: 'desc' }
export const SCAN_PRESETS: Array<{ name: string; ranges: MarketScanQuery['ranges'] }> = [
  { name: '优质低估', ranges: { pe: { min: 0, max: 20 }, roe: { min: 15 }, marketCap: { min: 100 } } },
  { name: '高成长', ranges: { pe: { min: 0, max: 50 }, roe: { min: 10 }, profitGrowth: { min: 20 } } },
  { name: '高股息', ranges: { roe: { min: 8 }, dividendYield: { min: 3 } } },
  { name: '小市值价值', ranges: { pe: { min: 0, max: 15 }, roe: { min: 10 }, marketCap: { max: 500 } } },
  { name: '蓝筹白马', ranges: { roe: { min: 10 }, marketCap: { min: 1000 } } },
]
export interface MarketScanStock {
  secId: string
  code: string
  name: string
  industry: string | null
  price: number | null
  changePct: number | null
  pe: number | null
  pb: number | null
  roe: number | null
  profitGrowth: number | null
  revenueGrowth: number | null
  marketCap: number | null
  dividendYield: number | null
  netInflow5d: number | null
  netMargin: number | null
  grossMargin: number | null
}
export interface MarketScanData {
  query: MarketScanQuery
  total: number
  stocks: MarketScanStock[]
  meta: ProviderMeta
  /** The acquisition day is not a financial report period or a confirmed trading date. */
  collectedOn: string
  snapshotDate: string | null
}
export interface MarketScanResult { data: MarketScanData | null; error: string | null; historical: boolean }

export function scanQueryError(query: MarketScanQuery): string | null {
  if (query.industries && (query.industries.length > 20 || query.industries.some(value => typeof value !== 'string' || !value.trim() || value.length > 40 || /[,\x00-\x1f]/.test(value)))) return '行业条件无效'
  if (!Number.isSafeInteger(query.page) || query.page < 1 || query.page > 1000) return '页码无效'
  if (query.search.length > 80 || !['asc', 'desc'].includes(query.order) || ![...Object.keys(SCAN_FIELDS), 'code', 'price', 'changePct'].includes(query.sort)) return '查询、排序或方向无效'
  for (const [field, range] of Object.entries(query.ranges)) {
    if (!Object.hasOwn(SCAN_FIELDS, field) || !range || (range.min === undefined && range.max === undefined)) return '存在无效筛选条件'
    if (range.max !== undefined && !SCAN_FIELDS[field as ScanMetric].maximum) return '该指标仅支持下限筛选'
    if ([range.min, range.max].some(value => value !== undefined && (!Number.isFinite(value) || Math.abs(value) > 1e12))) return '筛选数值无效或超出范围'
    if (range.min !== undefined && range.max !== undefined && range.min > range.max) return `${SCAN_FIELDS[field as ScanMetric].label}下限不能大于上限`
    if (['marketCap', 'dividendYield'].includes(field) && [range.min, range.max].some(value => value !== undefined && value < 0)) return '市值和股息率不能为负'
  }
  return null
}

export function normalizeScanQuery(query: MarketScanQuery): MarketScanQuery {
  return { search: query.search.trim(), ...(query.industries?.length ? { industries: [...new Set(query.industries.map(value => value.trim()))].sort() } : {}), page: query.page, ranges: Object.fromEntries(Object.keys(SCAN_FIELDS).flatMap(key => {
    const range = query.ranges[key as ScanMetric]
    return range ? [[key, { ...(range.min === undefined ? {} : { min: range.min }), ...(range.max === undefined ? {} : { max: range.max }) }]] : []
  })), sort: query.sort, order: query.order }
}

export function isMarketScanData(value: unknown): value is MarketScanData {
  const object = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || !object(value.query) || typeof value.query.search !== 'string' || !object(value.query.ranges) || typeof value.query.sort !== 'string' || typeof value.query.order !== 'string') return false
  if (value.query.industries !== undefined && (!Array.isArray(value.query.industries) || value.query.industries.some(item => typeof item !== 'string'))) return false
  for (const range of Object.values(value.query.ranges)) if (!object(range) || Object.keys(range).some(key => !['min', 'max'].includes(key)) || Object.values(range).some(item => typeof item !== 'number')) return false
  if (scanQueryError(value.query as unknown as MarketScanQuery) !== null || !Number.isSafeInteger(value.total) || Number(value.total) < 0 || !Array.isArray(value.stocks) || value.stocks.length > 100 || typeof value.collectedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.collectedOn)) return false
  if (value.snapshotDate !== null && (typeof value.snapshotDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.snapshotDate))) return false
  const validDate = (date: string) => Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
  if (!validDate(value.collectedOn) || (typeof value.snapshotDate === 'string' && !validDate(value.snapshotDate))) return false
  if (value.stocks.length !== Math.min(100, Math.max(0, Number(value.total) - (Number(value.query.page) - 1) * 100))) return false
  const codes = new Set<string>()
  const query = value.query as unknown as MarketScanQuery
  return value.stocks.every(row => {
    if (!object(row) || typeof row.code !== 'string' || !/^\d{6}$/.test(row.code) || codes.has(row.code) || row.secId !== `${row.code.startsWith('6') ? '1' : '0'}.${row.code}` || typeof row.name !== 'string' || !row.name || (row.industry !== null && typeof row.industry !== 'string')) return false
    codes.add(row.code)
    return [...Object.keys(SCAN_FIELDS), 'price', 'changePct'].every(key => row[key] === null || (typeof row[key] === 'number' && Number.isFinite(row[key])))
      && (!query.industries?.length || (typeof row.industry === 'string' && query.industries.includes(row.industry)))
      && Object.entries(query.ranges).every(([key, range]) => { const actual = row[key]; return typeof actual === 'number' && (range.min === undefined || actual >= range.min - 1e-8) && (range.max === undefined || actual <= range.max + 1e-8) })
  })
}
