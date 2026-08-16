import type { EChartsCoreOption } from 'echarts/core'
import type {
  KLineBar,
  SectorBoard,
  ThemeId,
  TrendPoint,
  ValuationSummary,
} from '../../contracts/src/index.ts'

export interface ChartPalette {
  axisLine: string
  axisLabel: string
  splitLine: string
  tooltipBackground: string
  tooltipBorder: string
  tooltipText: string
  legendText: string
  up: string
  down: string
  flat: string
  upBar: string
  downBar: string
  flatBar: string
  gold: string
  averageBlue: string
  priceBlue: string
  goldArea: string
  sliderBackground: string
  treemapBorder: string
  treemapLabel: string
  treemapOther: string
  radarSplit: string
  radarAxis: string
  radarArea: string
  overvaluedNear: string
  overvaluedFar: string
  undervaluedNear: string
  undervaluedFar: string
  heatNull: string
  heatFlat: string
  heatUpStart: readonly [number, number, number]
  heatUpDelta: readonly [number, number, number]
  heatDownStart: readonly [number, number, number]
  heatDownDelta: readonly [number, number, number]
}

export const DARK_CHART_PALETTE: ChartPalette = {
  axisLine: 'rgba(255,255,255,0.12)',
  axisLabel: '#5c6474',
  splitLine: 'rgba(255,255,255,0.045)',
  tooltipBackground: '#161b26',
  tooltipBorder: 'rgba(255,255,255,0.14)',
  tooltipText: '#e8eaf0',
  legendText: '#9aa3b5',
  up: '#f04a55',
  down: '#2fac74',
  flat: '#9aa3b5',
  upBar: 'rgba(240,74,85,0.68)',
  downBar: 'rgba(47,172,116,0.68)',
  flatBar: 'rgba(139,147,167,0.5)',
  gold: '#e0b34c',
  averageBlue: '#5b8def',
  priceBlue: '#7ab3f5',
  goldArea: 'rgba(224,179,76,0.08)',
  sliderBackground: 'rgba(255,255,255,0.04)',
  treemapBorder: 'rgba(11,14,20,0.9)',
  treemapLabel: 'rgba(255,255,255,0.92)',
  treemapOther: '#262b36',
  radarSplit: 'rgba(255,255,255,0.08)',
  radarAxis: 'rgba(255,255,255,0.1)',
  radarArea: 'rgba(224,179,76,0.22)',
  overvaluedNear: 'rgba(240,74,85,0.07)',
  overvaluedFar: 'rgba(240,74,85,0.16)',
  undervaluedNear: 'rgba(47,172,116,0.07)',
  undervaluedFar: 'rgba(47,172,116,0.16)',
  heatNull: '#2a2f3a',
  heatFlat: '#333a47',
  heatUpStart: [58, 48, 58],
  heatUpDelta: [165, -12, -4],
  heatDownStart: [42, 58, 58],
  heatDownDelta: [-14, 100, 42],
}

export const LIGHT_CHART_PALETTE: ChartPalette = {
  axisLine: 'rgba(15,23,42,0.16)',
  axisLabel: '#64748b',
  splitLine: 'rgba(15,23,42,0.07)',
  tooltipBackground: '#ffffff',
  tooltipBorder: 'rgba(15,23,42,0.16)',
  tooltipText: '#1f2937',
  legendText: '#64748b',
  up: '#d9364e',
  down: '#188a5a',
  flat: '#64748b',
  upBar: 'rgba(217,54,78,0.68)',
  downBar: 'rgba(24,138,90,0.68)',
  flatBar: 'rgba(100,116,139,0.5)',
  gold: '#b7791f',
  averageBlue: '#3972ce',
  priceBlue: '#2563eb',
  goldArea: 'rgba(183,121,31,0.09)',
  sliderBackground: 'rgba(15,23,42,0.05)',
  treemapBorder: 'rgba(255,255,255,0.92)',
  treemapLabel: 'rgba(255,255,255,0.96)',
  treemapOther: '#64748b',
  radarSplit: 'rgba(15,23,42,0.11)',
  radarAxis: 'rgba(15,23,42,0.13)',
  radarArea: 'rgba(183,121,31,0.18)',
  overvaluedNear: 'rgba(217,54,78,0.07)',
  overvaluedFar: 'rgba(217,54,78,0.16)',
  undervaluedNear: 'rgba(24,138,90,0.07)',
  undervaluedFar: 'rgba(24,138,90,0.16)',
  heatNull: '#94a3b8',
  heatFlat: '#7c8799',
  heatUpStart: [160, 82, 94],
  heatUpDelta: [65, -42, -35],
  heatDownStart: [72, 130, 104],
  heatDownDelta: [-42, 48, 25],
}

export function getChartPalette(theme: ThemeId): ChartPalette {
  return theme === 'light' ? LIGHT_CHART_PALETTE : DARK_CHART_PALETTE
}

export interface TreemapLegendStop {
  value: number
  color: string
  title: string
}

const TREEMAP_LEGEND_VALUES = [6, 3, 1, 0, -1, -3, -6] as const

export function treemapLegendStops(palette: ChartPalette = DARK_CHART_PALETTE): TreemapLegendStop[] {
  return TREEMAP_LEGEND_VALUES.map((value) => ({
    value,
    color: heatColor(value, palette),
    title: `${value}%`,
  }))
}

/** Red means up and green means down, following the conventional A-share palette. */
export function heatColor(pct: number | null, palette: ChartPalette = DARK_CHART_PALETTE): string {
  if (pct === null || !Number.isFinite(pct)) return palette.heatNull
  const t = Math.max(-1, Math.min(1, pct / 6))
  if (Math.abs(t) < 0.03) return palette.heatFlat
  const start = t > 0 ? palette.heatUpStart : palette.heatDownStart
  const delta = t > 0 ? palette.heatUpDelta : palette.heatDownDelta
  const k = Math.pow(Math.abs(t), 0.7)
  const channels = start.map((channel, index) => Math.round(channel + (delta[index] ?? 0) * k))
  return `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`
}

export interface TreemapClickTarget {
  sectorCode: string
  name: string
}

export function treemapTargetFromEvent(params: unknown): TreemapClickTarget | null {
  if (!isRecord(params) || !isRecord(params.data)) return null
  const sectorCode = params.data.sectorCode
  if (typeof sectorCode !== 'string' || sectorCode.length === 0) return null
  return {
    sectorCode,
    name: typeof params.data.name === 'string' ? params.data.name : '',
  }
}

export function buildTreemapOption(
  board: SectorBoard | null | undefined,
  palette: ChartPalette = DARK_CHART_PALETTE,
): EChartsCoreOption | null {
  if (!board) return null
  const valid = board.sectors
    .filter((sector) => sector.amount !== null && Number.isFinite(sector.amount) && sector.amount > 0)
    .slice()
    .sort((left, right) => (right.amount ?? 0) - (left.amount ?? 0))
  const totalAmount = valid.reduce((sum, sector) => sum + (sector.amount ?? 0), 0)
  const majors = valid.filter((sector, index) => index < 40 && (sector.amount ?? 0) / totalAmount >= 0.004)
  const minors = valid.slice(majors.length)
  const majorAmount = majors.reduce((sum, sector) => sum + (sector.amount ?? 0), 0)
  const data: Array<Record<string, unknown>> = majors.map((sector) => ({
    name: sector.name,
    value: sector.amount,
    changePct: sector.changePct,
    upCount: sector.upCount,
    downCount: sector.downCount,
    leaderName: sector.leaderName,
    leaderChangePct: sector.leaderChangePct,
    sectorCode: sector.code,
    itemStyle: { color: heatColor(sector.changePct, palette) },
    label: {
      formatter: (params: { name: string; data: { changePct: number | null } }): string => {
        const pct = params.data.changePct
        return `${params.name}\n${pct === null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`}`
      },
    },
  }))

  if (minors.length > 0) {
    const otherLayoutValue = majorAmount > 0 ? majorAmount * 0.035 / 0.965 : 1
    const minorSectors = minors.map((sector) => ({
      code: sector.code,
      name: sector.name,
      amount: sector.amount,
      changePct: sector.changePct,
    }))
    data.push({
      name: `其他 ${minors.length} 个板块`,
      value: otherLayoutValue,
      changePct: null,
      upCount: minors.filter((sector) => (sector.changePct ?? 0) > 0).length,
      downCount: minors.filter((sector) => (sector.changePct ?? 0) < 0).length,
      leaderName: null,
      leaderChangePct: null,
      sectorCode: null,
      isOthers: true,
      minorSectors,
      itemStyle: { color: palette.treemapOther },
      label: { formatter: (): string => `其他 ${minors.length} 个` },
    })
  }

  return {
    tooltip: {
      ...tooltipBase(palette, 12),
      renderMode: 'html',
      enterable: true,
      confine: true,
      hideDelay: 500,
      transitionDuration: 0,
      position: treemapTooltipPosition,
      formatter: (params: unknown): string => treemapTooltip(params, palette),
    },
    series: [{
      type: 'treemap',
      roam: false,
      nodeClick: false,
      sort: false,
      breadcrumb: { show: false },
      width: '100%',
      height: '100%',
      itemStyle: {
        borderColor: palette.treemapBorder,
        borderWidth: 1.5,
        gapWidth: 1.5,
        borderRadius: 3,
      },
      label: {
        show: true,
        color: palette.treemapLabel,
        fontSize: 11,
        lineHeight: 15,
        fontWeight: 600,
      },
      upperLabel: { show: false },
      levels: [{ itemStyle: { borderWidth: 0, gapWidth: 1.5 } }],
      data,
    }],
  }
}

export function buildTrendOption(
  points: TrendPoint[],
  prevClose: number | null = null,
  palette: ChartPalette = DARK_CHART_PALETTE,
): EChartsCoreOption | null {
  if (points.length === 0) return null
  const base = prevClose !== null && Number.isFinite(prevClose) ? prevClose : null
  const axis = axisStyle(palette)
  return {
    tooltip: {
      trigger: 'axis',
      ...tooltipBase(palette, 11),
      formatter: (params: unknown): string => {
        const index = tooltipDataIndex(params)
        const point = index === null ? null : points[index]
        if (!point) return ''
        const lines = [
          `<b>${escapeHtml(point.time)}</b>`,
          `<span style="color:${palette.gold}">●</span> 价格 <b>${fmtNum(point.price)} 元</b>`,
        ]
        if (point.avgPrice !== null) {
          lines.push(`<span style="color:${palette.averageBlue}">●</span> 均价 <b>${fmtNum(point.avgPrice)} 元</b>`)
        }
        lines.push(`<span style="color:${palette.flat}">●</span> 成交量 <b>${fmtHands(point.volume)}</b>`)
        return lines.join('<br/>')
      },
    },
    grid: priceGrids(),
    xAxis: [
      { type: 'category', data: points.map((point) => point.time), gridIndex: 0, ...axis },
      { type: 'category', data: points.map((point) => point.time), gridIndex: 1, ...axis, axisLabel: { show: false } },
    ],
    yAxis: [
      { scale: true, gridIndex: 0, ...axis },
      { gridIndex: 1, axisLabel: { show: false }, splitLine: { show: false } },
    ],
    series: [
      {
        name: '价格',
        type: 'line',
        data: points.map((point) => point.price),
        showSymbol: false,
        lineStyle: { color: palette.gold, width: 1.4 },
        areaStyle: { color: palette.goldArea },
        markLine: base !== null
          ? {
              symbol: 'none',
              label: { show: false },
              lineStyle: { color: palette.axisLabel, type: 'dashed', width: 1 },
              data: [{ yAxis: base }],
            }
          : undefined,
      },
      {
        name: '均价',
        type: 'line',
        data: points.map((point) => point.avgPrice),
        showSymbol: false,
        lineStyle: { color: palette.averageBlue, width: 1 },
        xAxisIndex: 0,
        yAxisIndex: 0,
      },
      {
        name: '成交量',
        type: 'bar',
        data: points.map((point, index) => {
          const previousPrice = index === 0 ? base : points[index - 1]?.price
          const color = previousPrice === null || previousPrice === undefined || point.price === previousPrice
            ? palette.flatBar
            : point.price > previousPrice ? palette.upBar : palette.downBar
          return { value: point.volume, itemStyle: { color } }
        }),
        xAxisIndex: 1,
        yAxisIndex: 1,
      },
    ],
  }
}

export function buildKlineOption(
  bars: KLineBar[],
  palette: ChartPalette = DARK_CHART_PALETTE,
): EChartsCoreOption | null {
  if (bars.length === 0) return null
  const axis = axisStyle(palette)
  return {
    tooltip: {
      trigger: 'axis',
      ...tooltipBase(palette, 11),
      formatter: (params: unknown): string => {
        const index = tooltipDataIndex(params)
        const bar = index === null ? null : bars[index]
        if (!bar) return ''
        const previousClose = index !== null && index > 0 ? bars[index - 1]?.close : null
        const changePct = previousClose !== null && previousClose !== undefined && previousClose !== 0
          ? (bar.close - previousClose) / previousClose * 100
          : null
        const lines = [
          `<b>${escapeHtml(bar.date)}</b>`,
          `开盘 <b>${fmtNum(bar.open)} 元</b>`,
          `收盘 <b>${fmtNum(bar.close)} 元</b>`,
          `最高 <b>${fmtNum(bar.high)} 元</b>`,
          `最低 <b>${fmtNum(bar.low)} 元</b>`,
          `成交量 <b>${fmtHands(bar.volume)}</b>`,
        ]
        if (changePct !== null) {
          const color = changePct > 0 ? palette.up : changePct < 0 ? palette.down : palette.flat
          lines.splice(2, 0, `涨跌幅 <b style="color:${color}">${fmtPct(changePct)}</b>`)
        }
        if (bar.amount !== null) lines.push(`成交额 <b>${fmtAmount(bar.amount)}</b>`)
        return lines.join('<br/>')
      },
    },
    grid: priceGrids(),
    xAxis: [
      { type: 'category', data: bars.map((bar) => bar.date), gridIndex: 0, ...axis },
      { type: 'category', data: bars.map((bar) => bar.date), gridIndex: 1, ...axis, axisLabel: { show: false } },
    ],
    yAxis: [
      { scale: true, gridIndex: 0, ...axis },
      { gridIndex: 1, axisLabel: { show: false }, splitLine: { show: false } },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], start: 55, end: 100 },
      {
        type: 'slider',
        xAxisIndex: [0, 1],
        top: '95%',
        height: 14,
        borderColor: 'transparent',
        backgroundColor: palette.sliderBackground,
      },
    ],
    series: [
      {
        name: 'K 线',
        type: 'candlestick',
        data: bars.map((bar) => [bar.open, bar.close, bar.low, bar.high]),
        itemStyle: {
          color: palette.up,
          color0: palette.down,
          borderColor: palette.up,
          borderColor0: palette.down,
        },
      },
      {
        name: '成交量',
        type: 'bar',
        data: bars.map((bar) => ({
          value: bar.volume,
          itemStyle: { color: bar.close >= bar.open ? palette.upBar : palette.downBar },
        })),
        xAxisIndex: 1,
        yAxisIndex: 1,
      },
    ],
  }
}

export function buildValuationOption(
  valuation: Pick<ValuationSummary, 'series'> | null | undefined,
  palette: ChartPalette = DARK_CHART_PALETTE,
): EChartsCoreOption | null {
  if (!valuation || (valuation.series.price.length === 0 && valuation.series.medps.length === 0)) return null
  const medps = valuation.series.medps
  const bandSeries = (
    name: string,
    fromRatio: number,
    toRatio: number,
    color: string,
  ): Array<Record<string, unknown>> => [
    {
      name: `${name}-base`,
      type: 'line',
      data: medps.map(([time, value]) => [time, value * fromRatio]),
      stack: name,
      showSymbol: false,
      silent: true,
      lineStyle: { opacity: 0 },
      areaStyle: { opacity: 0 },
      tooltip: { show: false },
    },
    {
      name: `${name}-fill`,
      type: 'line',
      data: medps.map(([time, value]) => [time, value * (toRatio - fromRatio)]),
      stack: name,
      showSymbol: false,
      silent: true,
      lineStyle: { opacity: 0 },
      areaStyle: { color },
      tooltip: { show: false },
    },
  ]
  const axis = axisStyle(palette)
  return {
    tooltip: {
      trigger: 'axis',
      ...tooltipBase(palette, 11),
      formatter: (rawParams: unknown): string => valuationTooltip(
        rawParams,
        palette,
        valuation.series.price,
        medps,
      ),
    },
    legend: {
      data: ['价格', '大师价值线'],
      textStyle: { color: palette.legendText, fontSize: 11 },
      top: 0,
      right: 0,
    },
    grid: { left: 56, right: 16, top: 28, bottom: 24 },
    xAxis: { type: 'time', ...axis },
    yAxis: {
      scale: true,
      ...axis,
      axisLabel: { ...axis.axisLabel, formatter: (value: number) => value.toFixed(0) },
    },
    series: [
      ...bandSeries('band+30', 1.1, 1.3, palette.overvaluedFar),
      ...bandSeries('band+10', 1, 1.1, palette.overvaluedNear),
      ...bandSeries('band-10', 0.9, 1, palette.undervaluedNear),
      ...bandSeries('band-30', 0.7, 0.9, palette.undervaluedFar),
      {
        name: '大师价值线',
        type: 'line',
        data: medps,
        showSymbol: false,
        z: 3,
        lineStyle: { color: palette.gold, width: 1.8 },
      },
      {
        name: '价格',
        type: 'line',
        data: valuation.series.price,
        showSymbol: false,
        z: 4,
        lineStyle: { color: palette.priceBlue, width: 1.3 },
      },
    ],
  }
}

export type RadarDimensions = ValuationSummary['dimensions']

export function buildRadarOption(
  dimensions: RadarDimensions | null | undefined,
  palette: ChartPalette = DARK_CHART_PALETTE,
): EChartsCoreOption | null {
  if (!dimensions) return null
  const values = [
    dimensions.gfValue,
    dimensions.growth,
    dimensions.momentum,
    dimensions.profitability,
    dimensions.financialStrength,
  ]
  if (values.every((value) => value === null)) return null
  return {
    radar: {
      indicator: [
        { name: '价值', max: 10 },
        { name: '成长', max: 10 },
        { name: '动量', max: 10 },
        { name: '盈利', max: 10 },
        { name: '财务', max: 10 },
      ],
      radius: '68%',
      splitNumber: 5,
      axisName: { color: palette.legendText, fontSize: 11 },
      splitLine: { lineStyle: { color: palette.radarSplit } },
      splitArea: { show: false },
      axisLine: { lineStyle: { color: palette.radarAxis } },
    },
    series: [{
      type: 'radar',
      data: [{
        value: values.map((value) => value ?? 0),
        areaStyle: { color: palette.radarArea },
        lineStyle: { color: palette.gold },
        itemStyle: { color: palette.gold },
      }],
    }],
  }
}

function axisStyle(palette: ChartPalette) {
  return {
    axisLine: { lineStyle: { color: palette.axisLine } },
    axisLabel: { color: palette.axisLabel, fontSize: 10.5 },
    splitLine: { lineStyle: { color: palette.splitLine } },
  }
}

function tooltipBase(palette: ChartPalette, fontSize: number) {
  return {
    backgroundColor: palette.tooltipBackground,
    borderColor: palette.tooltipBorder,
    textStyle: { color: palette.tooltipText, fontSize },
  }
}

function priceGrids() {
  return [
    { left: 52, right: 16, top: 12, height: '62%' },
    { left: 52, right: 16, top: '76%', height: '18%' },
  ]
}

function tooltipDataIndex(rawParams: unknown): number | null {
  const first = Array.isArray(rawParams) ? rawParams[0] : rawParams
  if (!isRecord(first)) return null
  const index = Number(first.dataIndex)
  return Number.isInteger(index) && index >= 0 ? index : null
}

function treemapTooltipPosition(
  point: [number, number],
  params: unknown,
  _element: unknown,
  _rect: { x: number; y: number; width: number; height: number } | null,
  size: { contentSize: [number, number]; viewSize: [number, number] },
): [number, number] {
  const [contentWidth, contentHeight] = size.contentSize
  const [viewWidth, viewHeight] = size.viewSize
  if (isRecord(params) && isRecord(params.data) && params.data.isOthers === true) {
    const rightOverlap = Math.min(96, viewWidth * 0.1)
    return [
      Math.max(8, viewWidth - contentWidth - rightOverlap),
      Math.max(8, viewHeight - contentHeight - 8),
    ]
  }
  const gap = 12
  const left = point[0] + gap + contentWidth <= viewWidth ? point[0] + gap : point[0] - contentWidth - gap
  const top = point[1] + gap + contentHeight <= viewHeight ? point[1] + gap : point[1] - contentHeight - gap
  return [Math.max(0, left), Math.max(0, top)]
}

function treemapTooltip(params: unknown, palette: ChartPalette): string {
  if (!isRecord(params) || !isRecord(params.data)) return ''
  const data = params.data
  const name = typeof params.name === 'string' ? params.name : ''
  const changePct = finiteNumberOrNull(data.changePct)
  const pct = changePct === null ? '—' : `${changePct > 0 ? '+' : ''}${changePct.toFixed(2)}%`
  if (data.isOthers === true) {
    const sectors = Array.isArray(data.minorSectors) ? data.minorSectors : []
    const rows = sectors.map((rawSector, index) => {
      const sector = isRecord(rawSector) ? rawSector : {}
      const sectorChange = finiteNumberOrNull(sector.changePct)
      const sectorPct = sectorChange === null ? '—' : `${sectorChange > 0 ? '+' : ''}${sectorChange.toFixed(2)}%`
      const stateClass = sectorChange === null || sectorChange === 0 ? 'is-flat' : sectorChange > 0 ? 'is-up' : 'is-down'
      const code = typeof sector.code === 'string' ? sector.code : ''
      const sectorName = typeof sector.name === 'string' ? sector.name : ''
      return `<button type="button" class="other-tooltip-row" data-sector-code="${escapeHtml(code)}" data-sector-name="${escapeHtml(sectorName)}"><span class="other-tooltip-rank">${index + 1}</span><span class="other-tooltip-name">${escapeHtml(sectorName)}</span><span class="other-tooltip-amount">${fmtAmount(finiteNumberOrNull(sector.amount))}</span><span class="other-tooltip-pct ${stateClass}">${sectorPct}</span></button>`
    }).join('')
    return `<div class="other-tooltip"><div class="other-tooltip-head"><b>${escapeHtml(name)}</b><span>按成交额排序</span></div><div class="other-tooltip-summary">上涨 ${displayCount(data.upCount)} 个 · 下跌 ${displayCount(data.downCount)} 个</div><div class="other-tooltip-columns"><span>#</span><span>板块</span><span>成交额</span><span>涨跌幅</span></div><div class="other-tooltip-list">${rows}</div><div class="other-tooltip-hint">点击板块下钻成分股</div></div>`
  }
  const upCount = displayCount(data.upCount)
  const downCount = displayCount(data.downCount)
  const leaderName = typeof data.leaderName === 'string' ? data.leaderName : ''
  const leaderChange = finiteNumberOrNull(data.leaderChangePct)
  const leader = leaderName.length > 0
    ? `领涨 ${escapeHtml(leaderName)} ${leaderChange === null ? '' : `${leaderChange > 0 ? '+' : ''}${leaderChange.toFixed(2)}%`}`
    : ''
  return [
    `<b>${escapeHtml(name)}</b>&nbsp;&nbsp;<span style="color:${changePct !== null && changePct > 0 ? palette.up : palette.down}">${pct}</span>`,
    `成交额 ${fmtAmount(finiteNumberOrNull(params.value))}`,
    `上涨 ${upCount} 家 / 下跌 ${downCount} 家`,
    leader,
    `<span style="color:${palette.axisLabel}">东方财富 · 点击下钻成分股</span>`,
  ].filter(Boolean).join('<br/>')
}

type ValuationPoint = ValuationSummary['series']['price'][number]

function valuationTooltip(
  rawParams: unknown,
  palette: ChartPalette,
  priceSeries: ValuationPoint[],
  fairSeries: ValuationPoint[],
): string {
  if (!Array.isArray(rawParams)) return ''
  const allRows = rawParams.filter(isRecord)
  const rows = allRows.filter((row) => row.seriesName === '价格' || row.seriesName === '大师价值线')
  const anchor = rows[0] ?? allRows[0]
  if (!anchor) return ''
  const axisValue = tooltipAxisValue(anchor)
  const date = formatChartDate(anchor.axisValueLabel ?? axisValue)
  const pricePoint = nearestSeriesPoint(priceSeries, axisValue)
  const fairPoint = nearestSeriesPoint(fairSeries, axisValue)
  if (!pricePoint && !fairPoint) return ''
  const lines = [`<b>${escapeHtml(date)}</b>`]
  if (pricePoint) {
    lines.push(`${tooltipMarker(rows, '价格', palette.priceBlue)} 股价${sourceDateSuffix(pricePoint[0], axisValue)} <b>${fmt2(pricePoint[1])}</b>`)
  }
  if (fairPoint) {
    lines.push(`${tooltipMarker(rows, '大师价值线', palette.gold)} 大师价值${sourceDateSuffix(fairPoint[0], axisValue)} <b>${fmt2(fairPoint[1])}</b>`)
    if (pricePoint && fairPoint[1] > 0) {
      const deviation = (pricePoint[1] - fairPoint[1]) / fairPoint[1] * 100
      lines.push(`<span style="color:${deviation > 0 ? palette.up : palette.down}">偏离 ${deviation > 0 ? '+' : ''}${deviation.toFixed(2)}%</span>`)
    }
  }
  return lines.join('<br/>')
}

function tooltipAxisValue(row: Record<string, unknown>): unknown {
  if (row.axisValue !== null && row.axisValue !== undefined) return row.axisValue
  if (Array.isArray(row.value)) return row.value[0]
  return row.axisValueLabel
}

function nearestSeriesPoint(series: ValuationPoint[], target: unknown): ValuationPoint | null {
  if (series.length === 0) return null
  const targetDate = formatChartDate(target)
  const exact = series.find(([date, value]) => Number.isFinite(value) && formatChartDate(date) === targetDate)
  if (exact) return exact
  const targetTime = chartTimestamp(target)
  if (targetTime === null) return null
  let best: ValuationPoint | null = null
  let bestTime = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (const point of series) {
    if (!Number.isFinite(point[1])) continue
    const pointTime = chartTimestamp(point[0])
    if (pointTime === null) continue
    const distance = Math.abs(pointTime - targetTime)
    const preferEarlierOnTie = distance === bestDistance && pointTime <= targetTime && bestTime > targetTime
    if (distance < bestDistance || preferEarlierOnTie) {
      best = point
      bestTime = pointTime
      bestDistance = distance
    }
  }
  return best
}

function tooltipMarker(rows: Record<string, unknown>[], seriesName: string, color: string): string {
  const row = rows.find((candidate) => candidate.seriesName === seriesName)
  return typeof row?.marker === 'string' && row.marker.length > 0
    ? row.marker
    : `<span style="color:${color}">●</span>`
}

function sourceDateSuffix(sourceDate: string, axisValue: unknown): string {
  return formatChartDate(sourceDate) === formatChartDate(axisValue)
    ? ''
    : `（${escapeHtml(formatChartDate(sourceDate))}）`
}

function formatChartDate(value: unknown): string {
  if (typeof value === 'string') {
    const date = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(value)
    if (date) return `${date[1]}-${String(date[2]).padStart(2, '0')}-${String(date[3]).padStart(2, '0')}`
    return value.slice(0, 10)
  }
  const timestamp = chartTimestamp(value)
  if (timestamp === null) return ''
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function chartTimestamp(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value instanceof Date) {
    const timestamp = value.getTime()
    return Number.isFinite(timestamp) ? timestamp : null
  }
  if (typeof value !== 'string') return null
  const localDate = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}))?(?::(\d{1,2}))?(?::(\d{1,2}))?$/.exec(value)
  if (localDate) {
    return new Date(
      Number(localDate[1]),
      Number(localDate[2]) - 1,
      Number(localDate[3]),
      Number(localDate[4] ?? 0),
      Number(localDate[5] ?? 0),
      Number(localDate[6] ?? 0),
    ).getTime()
  }
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function finiteNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function displayCount(value: unknown): string {
  const number = finiteNumberOrNull(value)
  return number === null ? '—' : String(number)
}

function fmtNum(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits)
}

function fmtPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function fmtAmount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const absolute = Math.abs(value)
  if (absolute >= 1e12) return `${(value / 1e12).toFixed(2)}万亿`
  if (absolute >= 1e8) return `${(value / 1e8).toFixed(2)}亿`
  if (absolute >= 1e4) return `${(value / 1e4).toFixed(2)}万`
  return value.toFixed(0)
}

function fmtHands(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const absolute = Math.abs(value)
  if (absolute >= 1e8) return `${(value / 1e8).toFixed(2)}亿手`
  if (absolute >= 1e4) return `${(value / 1e4).toFixed(2)}万手`
  return `${value.toFixed(0)}手`
}

function fmt2(value: number | null): string {
  return value === null ? '—' : value.toFixed(2)
}

function escapeHtml(value: string): string {
  const characters: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }
  return value.replace(/[&<>"']/g, (character) => characters[character] ?? character)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
