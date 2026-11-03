import type { EChartsCoreOption } from 'echarts/core'
import { macroAllTotals, type MacroAllDailyData, type MacroAllEtfData, type MacroCapitalData, type MacroEtfData, type MacroIndexData, type MacroDailyEtfData } from '../../contracts/src/market-macro.ts'
import type { ChartPalette } from './chart-options.ts'

function referenceSegment(dates: string[], published: Map<string, number>, reference: Map<string, number>, stamp: (date: string) => number) {
  return dates.map((date, i) => [stamp(date), reference.get(date) ?? (i + 1 < dates.length && reference.has(dates[i + 1]!) ? published.get(date) ?? null : null)])
}

export function macroTooltip(params: unknown): string {
  if (!Array.isArray(params)) return ''
  const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
  const rows = params.filter(row => Array.isArray(row.value) && typeof row.value[1] === 'number' && Number.isFinite(row.value[1]))
  const published = new Set(rows.filter(row => !String(row.seriesName).includes('分母重建参考')).map(row => row.seriesName))
  const visible = rows.filter(row => !(row.seriesName === '四只ETF占比（分母重建参考）' && published.has('头部四只沪深300ETF占比（左轴）'))
    && !(row.seriesName === '在列ETF占比（分母重建参考）' && published.has('沪深300ETF占比（日频·已核实目录）')))
  if (visible.length === 0) return ''
  const date = new Date(Number(visible[0].value[0]) + 8 * 3_600_000).toISOString().slice(0, 10)
  return date + visible.map(row => `<div>${row.marker ?? ''}${escape(String(row.seriesName))}<b style="float:right;margin-left:20px">${row.value[1].toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></div>`).join('')
}

export function macroTotals(data: MacroEtfData | null): Array<{ date: string; assets: number }> {
  return data?.funds[0]?.points.flatMap(point => {
    const values = data.funds.map(fund => fund.points.find(row => row.date === point.date)?.assets)
    return values.every((value): value is number => value !== undefined) ? [{ date: point.date, assets: Math.round(values.reduce((sum, value) => sum + value, 0) * 100) / 100 }] : []
  }) ?? []
}

export function macroFourTotals(daily: MacroDailyEtfData | null, allDaily: MacroAllDailyData | null = null): Array<{ date: string; assets: number }> {
  const four = new Map(daily?.points.map(point => [point.date, point.assets]))
  for (const point of allDaily?.points ?? []) four.set(point.date, point.fourAssets)
  return [...four].sort(([a], [b]) => a.localeCompare(b)).map(([date, assets]) => ({ date, assets }))
}

export function macroRatios(daily: MacroDailyEtfData | null, capital: MacroCapitalData | null, allDaily: MacroAllDailyData | null = null): Array<{ date: string; ratio: number }> {
  const caps = new Map([...(capital?.reference?.points ?? []), ...(capital?.points ?? [])].map(point => [point.date, point.floatCap]))
  return macroFourTotals(daily, allDaily).flatMap(point => {
    const cap = caps.get(point.date)
    return cap === undefined ? [] : [{ date: point.date, ratio: point.assets / cap * 100 }]
  })
}

export function buildMacroOption(etfs: MacroEtfData | null, index: MacroIndexData | null, palette: ChartPalette, endDate: string, daily: MacroDailyEtfData | null = null, capital: MacroCapitalData | null = null, allEtfs: MacroAllEtfData | null = null, allDaily: MacroAllDailyData | null = null, startDate?: string): EChartsCoreOption {
  const stamp = (date: string) => Date.parse(`${date}T00:00:00+08:00`)
  const dailyAvailable = daily !== null || (allDaily?.points.length ?? 0) > 0
  const totals = dailyAvailable ? macroFourTotals(daily, allDaily) : macroTotals(etfs)
  const scaleName = dailyAvailable ? '四只沪深300ETF每日规模合计' : '四只ETF季末净资产合计（季度参考）'
  const from = startDate ?? `${Number(endDate.slice(0, 4)) - 5}${endDate.slice(4)}`
  const assetsByDate = new Map(totals.map(point => [point.date, point.assets]))
  const caps = new Map(capital?.points.map(point => [point.date, point.floatCap]))
  const referenceCaps = new Map(capital?.reference?.points.filter(point => !caps.has(point.date)).map(point => [point.date, point.floatCap]))
  const ratios = new Map((dailyAvailable ? totals : []).flatMap(point => caps.has(point.date) ? [[point.date, point.assets / caps.get(point.date)! * 100] as const] : []))
  const referenceRatios = new Map((dailyAvailable ? totals : []).flatMap(point => referenceCaps.has(point.date) ? [[point.date, point.assets / referenceCaps.get(point.date)! * 100] as const] : []))
  const allTotals = macroAllTotals(allEtfs)
  const quarterRatios = allTotals.map(point => [stamp(point.date), caps.has(point.date) ? point.assets / caps.get(point.date)! * 100 : null])
  const full = new Map(allDaily?.points.map(point => [point.date, point]))
  const hasAllDaily = full.size > 0
  const allDates = [...new Set([...(index?.points ?? []).map(point => point.date), ...full.keys()])].sort()
  const fullRatios = allDates.map(date => [stamp(date), full.has(date) && caps.has(date) ? full.get(date)!.assets / caps.get(date)! * 100 : null])
  const fullReferenceValues = new Map(allDates.flatMap(date => full.has(date) && referenceCaps.has(date) ? [[date, full.get(date)!.assets / referenceCaps.get(date)! * 100] as const] : []))
  const fullPublishedValues = new Map(allDates.flatMap(date => full.has(date) && caps.has(date) ? [[date, full.get(date)!.assets / caps.get(date)! * 100] as const] : []))
  const fullReferenceRatios = referenceSegment(allDates, fullPublishedValues, fullReferenceValues, stamp)
  const hasPublishedFullRatios = fullRatios.some(point => point[1] !== null)
  const hasReferenceFullRatios = fullReferenceValues.size > 0
  const hasFullRatios = hasPublishedFullRatios || hasReferenceFullRatios
  const fullName = '沪深300ETF占比（日频·已核实目录）'
  const hasQuarterRatios = !hasFullRatios && quarterRatios.some(point => point[1] !== null)
  const hasRatios = ratios.size > 0 || referenceRatios.size > 0 || hasQuarterRatios || hasFullRatios
  const quarterName = '中证在列沪深300ETF占比（季末参考）'
  const ratioName = '头部四只沪深300ETF占比（左轴）'
  const referenceRatioName = '四只ETF占比（分母重建参考）'
  const fullReferenceName = '在列ETF占比（分母重建参考）'
  const ratioDates = [...new Set([...(index?.points ?? []).map(point => point.date), ...totals.map(point => point.date)])].sort()
  const scaleDates = dailyAvailable && index !== null ? [...new Set([...index.points.map(point => point.date), ...totals.map(point => point.date)])].sort() : totals.map(point => point.date)
  const axis = { axisLabel: { color: palette.legendText }, axisLine: { lineStyle: { color: palette.axisLine } }, splitLine: { lineStyle: { color: palette.splitLine } } }
  return {
    animation: false,
    textStyle: { color: palette.legendText },
    tooltip: { trigger: 'axis', formatter: macroTooltip, backgroundColor: palette.tooltipBackground, borderColor: palette.tooltipBorder, textStyle: { color: palette.tooltipText } },
    legend: [
      { top: 8, left: 50, data: [...(ratios.size > 0 ? [ratioName] : []), ...(hasQuarterRatios ? [quarterName] : []), ...(hasPublishedFullRatios ? [fullName] : []), ...(referenceRatios.size > 0 ? [referenceRatioName] : []), ...(hasReferenceFullRatios ? [fullReferenceName] : []), '沪深300收盘点位（右轴）'], textStyle: { color: palette.legendText } },
      { top: '62%', left: 50, data: [scaleName, ...(hasAllDaily ? ['其它沪深300ETF规模（日频·已核实目录）'] : [])], textStyle: { color: palette.legendText } },
    ],
    grid: [{ left: 70, right: 75, top: 65, height: '44%' }, { left: 70, right: 75, top: '70%', bottom: 65 }],
    xAxis: [0, 1].map(gridIndex => ({ ...axis, gridIndex, type: 'time', min: stamp(from), max: stamp(endDate), splitLine: { show: false } })),
    yAxis: [
      { ...axis, type: 'value', name: hasRatios ? '占流通市值比重（%）' : '占比（不可用）', min: 0,
        axisLabel: { color: palette.legendText, show: hasRatios, formatter: '{value}%' }, axisLine: { show: hasRatios }, splitLine: { show: false } },
      { ...axis, type: 'value', name: '沪深300（点）', position: 'right', scale: true },
      { ...axis, gridIndex: 1, type: 'value', name: 'ETF规模（亿元）', min: 0 },
    ],
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1] }, { type: 'slider', xAxisIndex: [0, 1], bottom: 6, height: 20, borderColor: palette.axisLine }],
    series: [
      { name: '沪深300收盘点位（右轴）', type: 'line', yAxisIndex: 1, showSymbol: false, lineStyle: { color: palette.flat, width: 1.5 },
        data: (index?.points ?? []).map(point => [stamp(point.date), point.close]) },
      { name: scaleName, type: 'line', stack: hasAllDaily ? 'ETF规模' : undefined, xAxisIndex: 1, yAxisIndex: 2, showSymbol: !dailyAvailable, symbolSize: 5, connectNulls: false,
        lineStyle: { color: palette.up, width: 2, type: dailyAvailable ? 'solid' : 'dashed' }, itemStyle: { color: palette.up }, areaStyle: { color: palette.up, opacity: dailyAvailable ? 0.12 : 0 },
        data: scaleDates.map(date => [stamp(date), assetsByDate.get(date) ?? null]),
        markPoint: totals.length === 0 ? undefined : { data: [{ type: 'max', name: dailyAvailable ? '日规模峰值' : '报告期峰值' }], symbolSize: 38, label: { formatter: '{c}' } } },
      ...(ratios.size === 0 ? [] : [{ name: ratioName, type: 'line', yAxisIndex: 0, showSymbol: false, connectNulls: false,
        lineStyle: { color: palette.up, width: 2 }, itemStyle: { color: palette.up }, areaStyle: { color: palette.up, opacity: 0.08 },
        data: ratioDates.map(date => [stamp(date), ratios.get(date) ?? null]) }]),
      ...(hasPublishedFullRatios ? [{ name: fullName, type: 'line', yAxisIndex: 0, showSymbol: false, connectNulls: false,
        lineStyle: { color: palette.priceBlue, width: 1.5, type: 'dashed' }, itemStyle: { color: palette.priceBlue }, data: fullRatios }] : []),
      ...(referenceRatios.size === 0 ? [] : [{ name: referenceRatioName, type: 'line', yAxisIndex: 0, showSymbol: referenceRatios.size === 1, symbolSize: 4, connectNulls: false,
        lineStyle: { color: palette.up, width: 2, type: 'dashed' }, itemStyle: { color: palette.up }, areaStyle: { color: palette.up, opacity: 0.05 },
        data: referenceSegment(ratioDates, ratios, referenceRatios, stamp) }]),
      ...(hasReferenceFullRatios ? [{ name: fullReferenceName, type: 'line', yAxisIndex: 0, showSymbol: fullReferenceRatios.filter(point => point[1] !== null).length === 1, symbolSize: 4, connectNulls: false,
        lineStyle: { color: palette.priceBlue, width: 1.5, type: 'dotted' }, itemStyle: { color: palette.priceBlue }, data: fullReferenceRatios }] : []),
      ...(hasAllDaily ? [{ name: '其它沪深300ETF规模（日频·已核实目录）', type: 'line', xAxisIndex: 1, yAxisIndex: 2, stack: 'ETF规模', showSymbol: false, connectNulls: false,
        lineStyle: { color: palette.priceBlue, width: 1.5 }, itemStyle: { color: palette.priceBlue }, areaStyle: { color: palette.priceBlue, opacity: 0.18 },
        data: scaleDates.map(date => [stamp(date), full.get(date)?.otherAssets ?? null]) }] : []),
      ...(hasQuarterRatios ? [{ name: quarterName, type: 'line', yAxisIndex: 0, showSymbol: true, symbolSize: 6, connectNulls: false,
        lineStyle: { color: palette.priceBlue, width: 1.5, type: 'dashed' }, itemStyle: { color: palette.priceBlue }, data: quarterRatios }] : []),
    ],
  }
}
