import type { ProviderMeta } from './index.ts'

export const MACRO_GENERATION_PANELS = [
  { endpoint: 'market.macro.allDaily', label: 'ETF日频总规模' },
  { endpoint: 'market.macro.daily', label: '四只ETF日规模' },
  { endpoint: 'market.macro.capital', label: '沪深300流通市值' },
  { endpoint: 'market.macro.all', label: '在列ETF季末规模' },
  { endpoint: 'market.macro.etf', label: '四只ETF季度规模' },
  { endpoint: 'market.macro.index', label: '沪深300指数' },
] as const

export interface MacroGenerationStatus {
  state: 'idle' | 'running' | 'completed' | 'partial' | 'failed'
  startedAt: string | null
  finishedAt: string | null
  availableAt: number
  archiveError?: string
  panels: Array<{ endpoint: typeof MACRO_GENERATION_PANELS[number]['endpoint']; label: string;
    state: 'pending' | 'running' | 'completed' | 'partial' | 'failed'; checked: number; total: number; missing: number; error: string | null }>
}

export const MACRO_ETFS = [
  { code: '510300', name: '华泰柏瑞沪深300ETF' },
  { code: '510310', name: '易方达沪深300ETF' },
  { code: '510330', name: '华夏沪深300ETF' },
  { code: '159919', name: '嘉实沪深300ETF' },
] as const

export interface MacroEtfData {
  funds: Array<{ code: string; points: Array<{ date: string; assets: number }> }>
  meta: ProviderMeta
}

export interface MacroIndexData {
  points: Array<{ date: string; close: number }>
  meta: ProviderMeta
}

export interface MacroCapitalData {
  /** SSE monthly report daily tradable market cap, in CNY 100 million. */
  points: Array<{ date: string; floatCap: number }>
  checkedMonths: string[]
  refreshMonths?: string[]
  complete: boolean
  reference?: MacroCapitalReference | undefined
  referenceError?: string | undefined
  officialMeta?: ProviderMeta
  meta: ProviderMeta
}

export interface MacroCapitalReference {
  /** Rebuilt from historical weekly constituents and same-day per-stock tradable caps, not SSE observations. */
  points: Array<{ date: string; floatCap: number; membershipDate: string }>
  checkedDates: string[]
  missingDates: Array<{ date: string; reason: string }>
  expectedDays: number
  complete: boolean
  meta: ProviderMeta
}

/** An observation saved on generation day; each component retains its original source date. */
export interface MacroChartData {
  date: string
  generatedAt: string
  etfs: MacroEtfData | null
  index: MacroIndexData | null
  daily: MacroDailyEtfData | null
  capital: MacroCapitalData | null
  allEtfs: MacroAllEtfData | null
  allDaily: MacroAllDailyData | null
  task: MacroGenerationStatus
  meta: ProviderMeta
}

export interface MacroAllEtfData {
  funds: Array<{ code: string; name: string; inceptionDate: string; points: Array<{ date: string; assets: number }> }>
  universeAsOf: string
  meta: ProviderMeta
}

export function macroAllTotals(data: MacroAllEtfData | null): Array<{ date: string; assets: number }> {
  if (data === null) return []
  const dates = [...new Set(data.funds.flatMap(fund => fund.points.map(point => point.date)))].sort()
  return dates.flatMap(date => {
    const active = data.funds.filter(fund => fund.inceptionDate <= date)
    const values = active.map(fund => fund.points.find(point => point.date === date)?.assets)
    return active.length > 0 && values.every((value): value is number => value !== undefined)
      ? [{ date, assets: Math.round(values.reduce((sum, value) => sum + value, 0) * 100) / 100 }] : []
  })
}

export interface MacroDailyEtfData {
  /** Same-day exchange shares multiplied by unadjusted unit NAV; assets in CNY 100 million. */
  points: Array<{ date: string; assets: number }>
  expectedDays: number
  complete: boolean
  meta: ProviderMeta
}

export interface MacroEtfInputs {
  funds: Array<{ code: string; navFetchedAt: string; navs: Array<{ date: string; value: number }>;
    shares: Array<{ date: string; value: number; fetchedAt: string }> }>
  meta: ProviderMeta
}

export interface MacroAllDailyData {
  funds: Array<{ code: string; name: string; listedOn: string; inactiveFrom?: string; delistedOn?: string }>
  universeAsOf: string
  points: Array<{ date: string; assets: number; fourAssets: number; otherAssets: number }>
  missingDates: Array<{ date: string; reason: string }>
  expectedDays: number
  complete: boolean
  meta: ProviderMeta
}
