import type { ProviderMeta } from './index.ts'
import { macroAllTotals, type MacroAllEtfData, type MacroChartData } from './market-macro.ts'
import type { MacroRange } from './macro-range.ts'
import { selectMacroIndicators, type MacroIndicatorMap } from './macro-indicators.ts'

export type MacroSeriesData = Pick<MacroChartData, 'etfs' | 'index' | 'daily' | 'capital' | 'allEtfs' | 'allDaily'> & {
  range: MacroRange
  meta: ProviderMeta
  indicators?: MacroIndicatorMap
}

/** Merge observations, oldest acquisition first; a new request never deletes cached dates. */
export function selectMacroSeries(records: MacroSeriesData[], range: MacroRange): MacroSeriesData {
  const ordered = [...records].sort((a, b) => a.meta.fetchedAt.localeCompare(b.meta.fetchedAt))
  const within = (date: string) => date >= range.from && date <= range.to
  const rows = <T extends { date: string }>(values: T[][]) => [...new Map(values.flat().filter(row => within(row.date)).map(row => [row.date, row])).values()].sort((a, b) => a.date.localeCompare(b.date))
  const values = <K extends 'etfs' | 'index' | 'daily' | 'capital' | 'allEtfs' | 'allDaily'>(key: K) => ordered.map(record => record[key]).filter((value): value is NonNullable<MacroSeriesData[K]> => value !== null).sort((a, b) => a.meta.fetchedAt.localeCompare(b.meta.fetchedAt))
  const latest = <K extends 'etfs' | 'index' | 'daily' | 'capital' | 'allEtfs' | 'allDaily'>(key: K) => values(key).at(-1) ?? null
  const index = latest('index'), daily = latest('daily'), capital = latest('capital'), allDaily = latest('allDaily')
  const indexPoints = rows(values('index').map(value => value.points ?? []))
  const dailyPoints = rows(values('daily').map(value => value.points ?? []))
  const allPoints = rows(values('allDaily').map(value => value.points ?? []))
  const official = rows(values('capital').map(value => value.points ?? []))
  // A month with only reconstructed daily values still needs its last official month-end anchor.
  if (official.length === 0) {
    const anchor = values('capital').flatMap(value => value.points).filter(point => point.date < range.from).sort((a, b) => a.date.localeCompare(b.date)).at(-1)
    if (anchor) official.push(anchor)
  }
  const reference = values('capital').flatMap(value => value.reference ?? []).at(-1)
  const refPoints = rows(values('capital').map(value => value.reference?.points ?? [])).filter(point => !official.some(row => row.date === point.date))
  const expectedDays = indexPoints.length
  const allGaps = rows(values('allDaily').map(value => value.missingDates ?? [])).filter(row => !allPoints.some(point => point.date === row.date))
  const refGaps = rows(values('capital').map(value => value.reference?.missingDates ?? [])).filter(row => !refPoints.some(point => point.date === row.date) && !official.some(point => point.date === row.date))
  const refChecked = [...refPoints, ...refGaps].map(row => row.date).sort()
  const refExpected = Math.max(refChecked.length, indexPoints.filter(point => point.date > (official.at(-1)?.date ?? '')).length)
  const capSource = [official.at(-1)?.date ?? '', refPoints.at(-1)?.date ?? ''].sort().at(-1) || null
  const sourceMeta = (meta: ProviderMeta, date: string | undefined) => ({ ...meta, sourceTimestamp: date ?? null })
  const quarters = (key: 'etfs' | 'allEtfs') => {
    const last = latest(key)
    if (last === null) return null
    const funds = new Map(last.funds.map(fund => [fund.code, { ...fund, points: rows(values(key).flatMap(value => value.funds.filter(row => row.code === fund.code).map(row => row.points))) }]))
    const mergedFunds = [...funds.values()]
    const common = key === 'allEtfs' ? macroAllTotals({ ...last, funds: mergedFunds } as MacroAllEtfData) : mergedFunds[0]?.points.filter(point => mergedFunds.every(fund => fund.points.some(row => row.date === point.date))) ?? []
    if (common.length === 0) return null
    return { ...last, funds: mergedFunds, meta: sourceMeta(last.meta, common.at(-1)?.date) }
  }
  return {
    indicators: selectMacroIndicators(ordered.map(record => record.indicators ?? {}), range),
    range, meta: ordered.at(-1)?.meta ?? { providerId: 'macro-series', sourceName: '本地宏观时间序列', sourceTimestamp: null, fetchedAt: new Date().toISOString(), cacheState: 'unavailable' },
    etfs: quarters('etfs') as MacroSeriesData['etfs'], allEtfs: quarters('allEtfs') as MacroSeriesData['allEtfs'],
    index: index === null || indexPoints.length === 0 ? null : { ...index, points: indexPoints, meta: { ...index.meta, sourceTimestamp: indexPoints.at(-1)?.date ?? null } },
    daily: daily === null || dailyPoints.length === 0 ? null : { ...daily, points: dailyPoints, meta: { ...daily.meta, sourceTimestamp: dailyPoints.at(-1)?.date ?? null }, expectedDays: Math.max(expectedDays, dailyPoints.length), complete: dailyPoints.length === Math.max(expectedDays, dailyPoints.length) },
    allDaily: allDaily === null ? null : { ...allDaily, points: allPoints, missingDates: allGaps, meta: sourceMeta(allDaily.meta, [...allPoints, ...allGaps].map(row => row.date).sort().at(-1)), expectedDays: Math.max(expectedDays, allPoints.length + allGaps.length), complete: allPoints.length === Math.max(expectedDays, allPoints.length + allGaps.length) },
    capital: capital === null ? null : { ...capital, points: official, complete: capital.complete && (reference === undefined || refChecked.length === refExpected),
      checkedMonths: [...new Set(ordered.flatMap(record => record.capital?.checkedMonths ?? []))].sort(),
      meta: { ...capital.meta, sourceTimestamp: capSource },
      officialMeta: sourceMeta(capital.officialMeta ?? capital.meta, official.at(-1)?.date),
      ...(reference === undefined || refExpected === 0 ? { reference: undefined } : { reference: { ...reference, points: refPoints, missingDates: refGaps, checkedDates: refChecked, expectedDays: refExpected, complete: refChecked.length === refExpected, meta: sourceMeta(reference.meta, refPoints.at(-1)?.date) } }) },
  }
}
