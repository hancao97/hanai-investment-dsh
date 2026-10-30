import type { MarketLadderData } from './market-ladder.ts'
import { isMarketScanData, type MarketScanData } from './market-scan.ts'
import type { MarketBreadthData, MarketOverview, ProviderMeta, RankEntry, SectorBoard, StockQuote } from './index.ts'
import { MACRO_GENERATION_PANELS, MACRO_ETFS, type MacroChartData, type MacroEtfInputs, type MacroAllDailyData, macroAllTotals, type MacroAllEtfData, type MacroCapitalData, type MacroEtfData, type MacroIndexData, type MacroDailyEtfData } from './market-macro.ts'
import type { GlobalIndicesData } from './market-indices.ts'
import type { MarketIntradayData, MarketSignalsData } from './market-activity.ts'
import { isMacroRange } from './macro-range.ts'
import type { MacroSeriesData } from './macro-series.ts'
import { MACRO_INDICATORS } from './macro-indicators.ts'
import type { MarketArmsData } from './market-arms.ts'
import { DISTRIBUTION_BINS, type MarketDistributionData } from './market-distribution.ts'

export const MARKET_HISTORY_PANELS = ['ladder', 'overview', 'breadth', 'arms', 'distribution', 'industry', 'concept', 'rank.gainers', 'rank.losers', 'rank.amount', 'rank.turnover', 'global.indices', 'intraday', 'signals', 'macro.etf', 'macro.index', 'macro.etf.daily', 'macro.capital', 'macro.etf.all.quarter', 'macro.etf.inputs', 'macro.etf.all.daily', 'macro.chart', 'macro.series'] as const

export interface MarketPanelPayloads {
  ladder: MarketLadderData
  distribution: MarketDistributionData
  arms: MarketArmsData
  'macro.series': MacroSeriesData
  'macro.chart': MacroChartData
  'macro.etf.inputs': MacroEtfInputs
  'macro.etf.all.daily': MacroAllDailyData
  'macro.etf.all.quarter': MacroAllEtfData
  'macro.capital': MacroCapitalData
  'macro.etf.daily': MacroDailyEtfData
  'macro.etf': MacroEtfData
  'macro.index': MacroIndexData
  intraday: MarketIntradayData
  signals: MarketSignalsData
  'global.indices': GlobalIndicesData
  overview: MarketOverview
  breadth: MarketBreadthData
  industry: SectorBoard
  concept: SectorBoard
  'rank.gainers': { entries: RankEntry[]; meta: ProviderMeta }
  'rank.losers': { entries: RankEntry[]; meta: ProviderMeta }
  'rank.amount': { entries: RankEntry[]; meta: ProviderMeta }
  'rank.turnover': { entries: RankEntry[]; meta: ProviderMeta }
}

export interface MarketPanelSnapshot {
  key: string
  version: number
  capturedAt: string
  meta: ProviderMeta
  data: unknown
}

export interface MarketHistorySummary {
  date: string
  capturedAt: string
  panels: string[]
}

export interface MarketHistorySnapshot extends MarketHistorySummary {
  records: Record<string, MarketPanelSnapshot>
}

export function isMarketDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const timestamp = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
}

export function beijingMarketDate(timestamp = Date.now()): string {
  return new Date(timestamp + 8 * 3_600_000).toISOString().slice(0, 10)
}

export function marketDateFromMeta(meta: ProviderMeta): string | null {
  const timestamp = meta.sourceTimestamp ?? meta.fetchedAt
  if (isMarketDate(timestamp)) return timestamp
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? beijingMarketDate(parsed) : null
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const numberOrNull = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value))
const namedRows = (value: unknown, fields: readonly string[]) => Array.isArray(value) && value.every(row => object(row)
  && typeof row.name === 'string' && typeof row.code === 'string' && fields.every(field => numberOrNull(row[field])))

export function isMarketProviderMeta(value: unknown): value is ProviderMeta {
  return object(value) && typeof value.providerId === 'string' && typeof value.sourceName === 'string'
    && typeof value.fetchedAt === 'string' && Number.isFinite(Date.parse(value.fetchedAt))
    && (value.sourceTimestamp === null || (typeof value.sourceTimestamp === 'string' && Number.isFinite(Date.parse(value.sourceTimestamp))))
    && ['fresh', 'cached', 'stale', 'unavailable'].includes(String(value.cacheState))
}

function isCapitalReference(value: unknown, fetchedAt: string): boolean {
  if (!object(value) || !isMarketProviderMeta(value.meta) || !Array.isArray(value.points) || !Array.isArray(value.checkedDates) || !Array.isArray(value.missingDates)
    || !Number.isSafeInteger(value.expectedDays) || Number(value.expectedDays) < value.checkedDates.length || typeof value.complete !== 'boolean'
    || value.complete !== (value.checkedDates.length === value.expectedDays) || Date.parse(value.meta.fetchedAt) > Date.parse(fetchedAt)) return false
  const checked: unknown[] = value.checkedDates
  const fetchedDate = beijingMarketDate(Date.parse(value.meta.fetchedAt))
  return checked.every((date, i) => typeof date === 'string' && isMarketDate(date) && date <= fetchedDate && (i === 0 || String(checked[i - 1]) < date))
    && value.points.every((point, i, rows) => object(point) && typeof point.date === 'string' && checked.includes(point.date)
      && (i === 0 || (object(rows[i - 1]) && String(rows[i - 1].date) < point.date))
      && typeof point.floatCap === 'number' && Number.isFinite(point.floatCap) && point.floatCap > 0
      && typeof point.membershipDate === 'string' && isMarketDate(point.membershipDate) && point.membershipDate <= point.date && Date.parse(point.date) - Date.parse(point.membershipDate) <= 7 * 86_400_000)
    && value.missingDates.every((row, i, rows) => object(row) && typeof row.date === 'string' && checked.includes(row.date) && typeof row.reason === 'string' && row.reason.length > 0
      && (i === 0 || (object(rows[i - 1]) && String(rows[i - 1].date) < row.date)) && !(value.points as unknown[]).some(point => object(point) && point.date === row.date))
    && checked.length === value.points.length + value.missingDates.length
    && value.meta.sourceTimestamp === (value.points.length === 0 ? null : (value.points.at(-1) as { date: string }).date)
}

/** Validate stored version-1 payloads before charts consume them; unknown panel keys remain extensible. */
export function isMarketPanelPayload(key: string, value: unknown): boolean {
  if (key.startsWith('scan:')) return isMarketScanData(value) && isMarketProviderMeta(value.meta)
  if (!object(value)) return false
  if (key === 'ladder') return (value.method === undefined || value.method === 'source-board-types-v1') && isMarketProviderMeta(value.meta) && typeof value.date === 'string' && isMarketDate(value.date)
    && (value.yesterdayPerformance === undefined || value.yesterdayPerformance === null || (object(value.yesterdayPerformance)
      && isMarketProviderMeta(value.yesterdayPerformance.meta) && marketDateFromMeta(value.yesterdayPerformance.meta) === value.date
      && ['sample', 'up', 'down', 'flat'].every(key => Number.isSafeInteger((value.yesterdayPerformance as Record<string, unknown>)[key]) && Number((value.yesterdayPerformance as Record<string, unknown>)[key]) >= 0)
      && Number(value.yesterdayPerformance.up) + Number(value.yesterdayPerformance.down) + Number(value.yesterdayPerformance.flat) === value.yesterdayPerformance.sample
      && ['average', 'median'].every(key => numberOrNull((value.yesterdayPerformance as Record<string, unknown>)[key]))
      && (value.yesterdayPerformance.sample === 0 ? value.yesterdayPerformance.average === null && value.yesterdayPerformance.median === null : value.yesterdayPerformance.average !== null && value.yesterdayPerformance.median !== null)))
    && marketDateFromMeta(value.meta) === value.date && Array.isArray(value.stocks) && value.stocks.length <= 10000
    && value.stocks.every((row, i, rows) => object(row) && typeof row.code === 'string' && /^\d{6}$/.test(row.code)
      && !rows.slice(0, i).some(previous => object(previous) && previous.code === row.code)
      && ['reason', 'boardType'].every(key => row[key] === null || typeof row[key] === 'string')
      && typeof row.name === 'string' && row.name.trim() !== '' && typeof row.industry === 'string' && row.industry.trim() !== ''
      && Number.isSafeInteger(row.boards) && Number(row.boards) >= 1 && Number(row.boards) <= 100
      && (row.breaks === null || (Number.isSafeInteger(row.breaks) && Number(row.breaks) >= 0))
      && [row.firstSeal, row.lastSeal].every(time => typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time))
      && numberOrNull(row.turnover) && (row.turnover === null || Number(row.turnover) >= 0))
    && (value.promotion === null || (object(value.promotion) && ['eligible', 'promoted'].every(key => Number.isSafeInteger((value.promotion as Record<string, unknown>)[key]) && Number((value.promotion as Record<string, unknown>)[key]) >= 0)
      && Number(value.promotion.promoted) <= Number(value.promotion.eligible) && Number(value.promotion.promoted) <= value.stocks.length))
    && (value.broken === null || (Number.isSafeInteger(value.broken) && Number(value.broken) >= 0))
    && Array.isArray(value.issues) && value.issues.every(issue => typeof issue === 'string')
  if (key === 'distribution') return isMarketProviderMeta(value.meta) && object(value.counts)
    && Number.isSafeInteger(value.total) && Number(value.total) > 0
    && DISTRIBUTION_BINS.every(([key]) => Number.isSafeInteger((value.counts as Record<string, unknown>)[key]) && Number((value.counts as Record<string, unknown>)[key]) >= 0)
    && DISTRIBUTION_BINS.reduce((sum, [key]) => sum + Number((value.counts as Record<string, unknown>)[key]), 0) === value.total
  if (key === 'arms') {
    const point = value.point
    return isMarketProviderMeta(value.meta) && object(point)
      && typeof point.date === 'string' && isMarketDate(point.date)
      && (point.time === null || (typeof point.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(point.time)))
      && ['upCount', 'downCount', 'flatCount'].every(field => Number.isSafeInteger(point[field]) && Number(point[field]) >= 0)
      && ['upAmount', 'downAmount', 'trin', 'adRatio', 'amountRatio'].every(field => numberOrNull(point[field]) && (point[field] === null || Number(point[field]) >= 0))
      && typeof point.estimated === 'boolean'
  }
  if (key === 'macro.series') return isMacroRange(value.range) && isMarketProviderMeta(value.meta)
    && (value.indicators === undefined || (object(value.indicators) && Object.entries(value.indicators).every(([id, data]) => {
      const definition = MACRO_INDICATORS.find(row => row.id === id)
      return definition !== undefined && object(data) && data.id === id && isMacroRange(data.checkedRange) && isMarketProviderMeta(data.meta)
        && Array.isArray(data.points) && data.points.every((point, i, rows) => object(point) && typeof point.date === 'string' && isMarketDate(point.date)
          && isMacroRange(value.range) && point.date >= value.range.from && point.date <= value.range.to && (i === 0 || String(rows[i - 1].date) < point.date)
          && (point.estimated === undefined || typeof point.estimated === 'boolean')
          && (point.armsDetails === undefined || (object(point.armsDetails) && ['upCount', 'downCount'].every(field => Number.isSafeInteger((point.armsDetails as Record<string, unknown>)[field]) && Number((point.armsDetails as Record<string, unknown>)[field]) >= 0) && ['upAmount', 'downAmount'].every(field => numberOrNull((point.armsDetails as Record<string, unknown>)[field]) && ((point.armsDetails as Record<string, unknown>)[field] === null || Number((point.armsDetails as Record<string, unknown>)[field]) >= 0))))
          && object(point.values) && Object.keys(point.values).length === definition.columns.length
          && definition.columns.every(column => object(point.values) && numberOrNull(point.values[column.key])))
    })))
    && [['etfs', 'macro.etf'], ['index', 'macro.index'], ['daily', 'macro.etf.daily'], ['capital', 'macro.capital'], ['allEtfs', 'macro.etf.all.quarter'], ['allDaily', 'macro.etf.all.daily']]
      .every(([field, panel]) => value[field!] === null || isMarketPanelPayload(panel!, value[field!]))
  if (key === 'macro.chart') return typeof value.date === 'string' && isMarketDate(value.date)
    && typeof value.generatedAt === 'string' && Number.isFinite(Date.parse(value.generatedAt)) && beijingMarketDate(Date.parse(value.generatedAt)) === value.date
    && isMarketProviderMeta(value.meta) && value.meta.sourceTimestamp === value.generatedAt && value.meta.fetchedAt === value.generatedAt
    && object(value.task) && ['completed', 'partial'].includes(String(value.task.state)) && value.task.finishedAt === value.generatedAt
    && typeof value.task.startedAt === 'string' && Number.isFinite(Date.parse(value.task.startedAt)) && Date.parse(value.task.startedAt) <= Date.parse(value.generatedAt)
    && typeof value.task.availableAt === 'number' && Number.isFinite(value.task.availableAt)
    && (value.task.archiveError === undefined || typeof value.task.archiveError === 'string')
    && Array.isArray(value.task.panels) && value.task.panels.length === MACRO_GENERATION_PANELS.length
    && MACRO_GENERATION_PANELS.every(expected => (value.task as { panels: unknown[] }).panels.filter(panel => object(panel) && panel.endpoint === expected.endpoint).length === 1)
    && value.task.panels.every(panel => object(panel) && typeof panel.label === 'string' && ['completed', 'partial', 'failed'].includes(String(panel.state))
      && [panel.checked, panel.total, panel.missing].every(n => Number.isSafeInteger(n) && Number(n) >= 0)
      && (panel.error === null || typeof panel.error === 'string'))
    && [['etfs', 'macro.etf'], ['index', 'macro.index'], ['daily', 'macro.etf.daily'], ['capital', 'macro.capital'], ['allEtfs', 'macro.etf.all.quarter'], ['allDaily', 'macro.etf.all.daily']]
      .every(([field, panel]) => value[field!] === null || (isMarketPanelPayload(panel!, value[field!])
        && marketDateFromMeta((value[field!] as { meta: ProviderMeta }).meta)! <= String(value.date)
        && Date.parse((value[field!] as { meta: ProviderMeta }).meta.fetchedAt) <= Date.parse(String(value.generatedAt))))
    && [value.etfs, value.index, value.daily, value.capital, value.allEtfs, value.allDaily].some(panel => panel !== null)
  if (key === 'macro.etf.inputs') return isMarketProviderMeta(value.meta) && Array.isArray(value.funds) && value.funds.length > 0 && value.funds.length <= 100
    && value.funds.every((fund, i, funds) => object(fund) && typeof fund.code === 'string' && /^\d{6}$/.test(fund.code)
      && !funds.slice(0, i).some(previous => object(previous) && previous.code === fund.code)
      && typeof fund.navFetchedAt === 'string' && Number.isFinite(Date.parse(fund.navFetchedAt))
      && Array.isArray(fund.navs) && fund.navs.length > 0 && Array.isArray(fund.shares)
      && [fund.navs, fund.shares].every(rows => rows.every((row, j) => object(row) && typeof row.date === 'string' && isMarketDate(row.date)
        && (j === 0 || (object(rows[j - 1]) && String(rows[j - 1].date) < row.date))
        && typeof row.value === 'number' && Number.isFinite(row.value) && row.value > 0))
      && fund.shares.every(row => object(row) && typeof row.fetchedAt === 'string' && Number.isFinite(Date.parse(row.fetchedAt))))
    && (value.funds as MacroEtfInputs['funds']).flatMap(fund => [...fund.navs, ...fund.shares].map(row => row.date)).sort().at(-1) === value.meta.sourceTimestamp
  if (key === 'macro.etf.all.daily') return isMarketProviderMeta(value.meta) && typeof value.universeAsOf === 'string' && isMarketDate(value.universeAsOf)
    && Array.isArray(value.funds) && value.funds.length >= 4 && value.funds.length <= 100
    && MACRO_ETFS.every(etf => (value.funds as unknown[]).some(fund => object(fund) && fund.code === etf.code))
    && value.funds.every((fund, i, funds) => object(fund) && typeof fund.code === 'string' && /^(5\d{5}|159\d{3})$/.test(fund.code)
      && !funds.slice(0, i).some(previous => object(previous) && previous.code === fund.code)
      && typeof fund.name === 'string' && fund.name.trim() !== '' && typeof fund.listedOn === 'string' && isMarketDate(fund.listedOn)
      && (fund.inactiveFrom === undefined || (typeof fund.inactiveFrom === 'string' && isMarketDate(fund.inactiveFrom) && fund.inactiveFrom > fund.listedOn))
      && (fund.delistedOn === undefined || (typeof fund.delistedOn === 'string' && isMarketDate(fund.delistedOn) && fund.delistedOn >= String(fund.inactiveFrom ?? fund.listedOn))))
    && Array.isArray(value.points) && Array.isArray(value.missingDates) && value.points.length + value.missingDates.length > 0
    && Number.isSafeInteger(value.expectedDays) && Number(value.expectedDays) >= value.points.length + value.missingDates.length
    && typeof value.complete === 'boolean' && value.complete === (value.points.length === value.expectedDays)
    && value.points.every((point, i, points) => object(point) && typeof point.date === 'string' && isMarketDate(point.date) && point.date <= String(value.universeAsOf)
      && (i === 0 || (object(points[i - 1]) && String(points[i - 1].date) < point.date))
      && typeof point.assets === 'number' && Number.isFinite(point.assets) && point.assets > 0
      && typeof point.fourAssets === 'number' && Number.isFinite(point.fourAssets) && point.fourAssets > 0
      && typeof point.otherAssets === 'number' && Number.isFinite(point.otherAssets) && point.otherAssets >= 0
      && Math.abs(point.assets - point.fourAssets - point.otherAssets) <= 0.021)
    && value.missingDates.every((row, i, rows) => object(row) && typeof row.date === 'string' && isMarketDate(row.date) && row.date <= String(value.universeAsOf)
      && (i === 0 || (object(rows[i - 1]) && String(rows[i - 1].date) < row.date))
      && !(value.points as Array<{ date: string }>).some(point => point.date === row.date) && typeof row.reason === 'string' && row.reason.trim() !== '')
    && [...(value.points as Array<{ date: string }>), ...(value.missingDates as Array<{ date: string }>)].map(row => row.date).sort().at(-1) === value.meta.sourceTimestamp
  if (key === 'macro.etf.all.quarter') return isMarketProviderMeta(value.meta) && typeof value.universeAsOf === 'string' && isMarketDate(value.universeAsOf)
    && Array.isArray(value.funds) && value.funds.length >= 4 && value.funds.length <= 60
    && MACRO_ETFS.every(etf => (value.funds as unknown[]).some(fund => object(fund) && fund.code === etf.code))
    && value.funds.every((fund, i, funds) => object(fund) && typeof fund.code === 'string' && /^\d{6}$/.test(fund.code)
      && !funds.slice(0, i).some(previous => object(previous) && previous.code === fund.code)
      && typeof fund.name === 'string' && fund.name.trim() !== '' && typeof fund.inceptionDate === 'string' && isMarketDate(fund.inceptionDate)
      && Array.isArray(fund.points) && fund.points.every((point, j, points) => object(point) && typeof point.date === 'string' && isMarketDate(point.date)
        && /-(03-31|06-30|09-30|12-31)$/.test(point.date) && point.date >= String(fund.inceptionDate) && point.date <= String(value.universeAsOf)
        && (j === 0 || (object(points[j - 1]) && String(points[j - 1].date) < point.date))
        && typeof point.assets === 'number' && Number.isFinite(point.assets) && point.assets > 0))
    && macroAllTotals(value as unknown as MacroAllEtfData).at(-1)?.date === value.meta.sourceTimestamp
  if (key === 'macro.capital') return isMarketProviderMeta(value.meta) && Array.isArray(value.points) && value.points.length > 0
    && (value.reference === undefined || (isCapitalReference(value.reference, value.meta.fetchedAt) && (!value.complete || (object(value.reference) && value.reference.complete === true))))
    && (value.referenceError === undefined || (typeof value.referenceError === 'string' && value.complete === false))
    && (value.officialMeta === undefined || (isMarketProviderMeta(value.officialMeta) && object(value.points.at(-1))
      && value.officialMeta.sourceTimestamp === value.points.at(-1).date && Date.parse(value.officialMeta.fetchedAt) <= Date.parse(value.meta.fetchedAt)))
    && typeof value.complete === 'boolean' && Array.isArray(value.checkedMonths)
    && value.checkedMonths.every((month, i, months) => typeof month === 'string' && /^\d{4}(0[1-9]|1[0-2])$/.test(month) && (i === 0 || String(months[i - 1]) < month))
    && (value.refreshMonths === undefined || (Array.isArray(value.refreshMonths)
      && value.refreshMonths.every((month, i, months) => typeof month === 'string' && /^\d{4}(0[1-9]|1[0-2])$/.test(month) && (i === 0 || String(months[i - 1]) < month))
      && (!value.complete || value.refreshMonths.length === 0)))
    && object(value.points.at(-1)) && value.meta.sourceTimestamp === (value.officialMeta === undefined ? value.points.at(-1).date
      : [String(value.points.at(-1).date), object(value.reference) && Array.isArray(value.reference.points) && object(value.reference.points.at(-1)) ? String(value.reference.points.at(-1).date) : ''].sort().at(-1))
    && value.points.every((point, i, points) => object(point) && typeof point.date === 'string' && isMarketDate(point.date)
      && (value.checkedMonths as unknown[]).includes(point.date.slice(0, 7).replace('-', ''))
      && (i === 0 || (object(points[i - 1]) && String(points[i - 1].date) < point.date))
      && typeof point.floatCap === 'number' && Number.isFinite(point.floatCap) && point.floatCap > 0)
  if (key === 'macro.etf.daily') return isMarketProviderMeta(value.meta) && Array.isArray(value.points) && value.points.length > 0
    && Number.isSafeInteger(value.expectedDays) && Number(value.expectedDays) >= value.points.length && typeof value.complete === 'boolean'
    && value.complete === (value.points.length === value.expectedDays)
    && object(value.points.at(-1)) && value.meta.sourceTimestamp === value.points.at(-1).date
    && value.points.every((point, i, points) => object(point) && typeof point.date === 'string' && isMarketDate(point.date)
      && (i === 0 || (object(points[i - 1]) && String(points[i - 1].date) < point.date))
      && typeof point.assets === 'number' && Number.isFinite(point.assets) && point.assets > 0)
  if (key === 'macro.index') return isMarketProviderMeta(value.meta) && Array.isArray(value.points) && value.points.length > 0
    && value.points.every(point => object(point) && typeof point.date === 'string' && isMarketDate(point.date)
      && typeof point.close === 'number' && Number.isFinite(point.close) && point.close > 0)
  if (key === 'macro.etf') return isMarketProviderMeta(value.meta) && Array.isArray(value.funds) && value.funds.length === MACRO_ETFS.length
    && MACRO_ETFS.every(etf => (value.funds as unknown[]).filter(fund => object(fund) && fund.code === etf.code).length === 1)
    && value.funds.every(fund => object(fund) && Array.isArray(fund.points) && fund.points.length > 0
      && fund.points.every(point => object(point) && typeof point.date === 'string' && isMarketDate(point.date)
        && typeof point.assets === 'number' && Number.isFinite(point.assets) && point.assets > 0))
  if (key === 'intraday' || key === 'signals') {
    if (typeof value.date !== 'string' || !isMarketDate(value.date) || !isMarketProviderMeta(value.meta)) return false
    if (key === 'intraday') return numberOrNull(value.prevClose) && Array.isArray(value.points) && value.points.length > 0
      && value.points.every(point => object(point) && typeof point.time === 'string' && /^(09|10|11|13|14|15):[0-5]\d$/.test(point.time)
        && typeof point.price === 'number' && Number.isFinite(point.price) && point.price > 0 && numberOrNull(point.avgPrice)
        && typeof point.volume === 'number' && Number.isFinite(point.volume) && point.volume >= 0)
    return (value.method === undefined || value.method === 'ths-sector-events-v2') && Array.isArray(value.signals) && value.signals.every(signal => object(signal)
      && typeof signal.time === 'string' && /^\d{2}:\d{2}$/.test(signal.time) && typeof signal.name === 'string'
      && typeof signal.code === 'string' && typeof signal.title === 'string' && ['up', 'down'].includes(String(signal.direction)))
  }
  if (key === 'global.indices') return namedRows(value.indices, ['price', 'change', 'changePct', 'amount']) && isMarketProviderMeta(value.meta)
    && (value.indices as Array<Record<string, unknown>>).every(row => isMarketProviderMeta(row.meta)
      && (row.marketDate === null || (typeof row.marketDate === 'string' && isMarketDate(row.marketDate))))
  if (key === 'overview') return namedRows(value.indices, ['price', 'change', 'changePct', 'amount'])
    && (value.indices as Array<Record<string, unknown>>).every(row => row.meta === undefined || isMarketProviderMeta(row.meta))
    && object(value.breadth) && numberOrNull(value.breadth.totalAmount) && isMarketProviderMeta(value.meta)
    && ['pre', 'trading', 'break', 'closed', 'unknown'].includes(String(value.marketStatus))
  if (key === 'breadth') return isMarketProviderMeta(value.meta) && typeof value.qdate === 'string' && isMarketDate(value.qdate)
    && ['up', 'down', 'flat', 'limitUp', 'limitDown'].every(field => Number.isSafeInteger(value[field]) && Number(value[field]) >= 0)
  if (key === 'industry' || key === 'concept') return value.type === key && namedRows(value.sectors, ['changePct', 'amount']) && isMarketProviderMeta(value.meta)
  if (key.startsWith('rank.')) return namedRows(value.entries, ['price', 'changePct', 'amount', 'turnoverRate'])
    && (value.entries as Array<Record<string, unknown>>).every(row => typeof row.secId === 'string') && isMarketProviderMeta(value.meta)
  if (key.startsWith('sector:')) return namedRows(value.stocks, ['price', 'changePct', 'amount', 'turnoverRate', 'marketCap'])
    && (value.stocks as Array<Record<string, unknown>>).every(row => typeof row.secId === 'string') && isMarketProviderMeta(value.meta)
  return true
}

export function marketHistoryPanel<K extends keyof MarketPanelPayloads>(snapshot: MarketHistorySnapshot | null, key: K): MarketPanelPayloads[K] | null
export function marketHistoryPanel(snapshot: MarketHistorySnapshot | null, key: `sector:${string}`): { stocks: StockQuote[]; meta: ProviderMeta } | null
export function marketHistoryPanel(snapshot: MarketHistorySnapshot | null, key: `scan:${string}`): MarketScanData | null
export function marketHistoryPanel(snapshot: MarketHistorySnapshot | null, key: string): unknown {
  const panel = snapshot?.records[key]
  return panel?.version === 1 && isMarketPanelPayload(key, panel.data) ? panel.data : null
}
