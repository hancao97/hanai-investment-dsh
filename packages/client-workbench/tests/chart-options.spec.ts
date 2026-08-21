import { describe, expect, it } from 'vitest'
import type {
  KLineBar,
  ProviderMeta,
  SectorBoard,
  SectorItem,
  TrendPoint,
  ValuationSummary,
} from '../../contracts/src/index.ts'
import {
  DARK_CHART_PALETTE,
  LIGHT_CHART_PALETTE,
  buildKlineOption,
  buildRadarOption,
  buildTreemapOption,
  buildTrendOption,
  buildValuationOption,
  getChartPalette,
  heatColor,
  treemapLegendStops,
  treemapTargetFromEvent,
} from '../src/chart-options.ts'

const META: ProviderMeta = {
  providerId: 'eastmoney',
  sourceName: '东方财富',
  sourceTimestamp: null,
  fetchedAt: '2026-08-15T00:00:00.000Z',
  cacheState: 'fresh',
}

interface InspectableOption {
  tooltip?: {
    formatter?: (params: unknown) => string
    position?: (...args: unknown[]) => [number, number]
    showContent?: boolean
    backgroundColor?: string
    axisPointer?: Record<string, unknown>
  }
  legend?: { data?: string[] }
  grid?: unknown[] | Record<string, unknown>
  xAxis?: Array<Record<string, unknown>> | Record<string, unknown>
  yAxis?: Array<Record<string, unknown>> | Record<string, unknown>
  dataZoom?: Array<Record<string, unknown>>
  axisPointer?: Record<string, unknown>
  radar?: Record<string, unknown>
  series?: Array<Record<string, unknown>>
}

function inspect(value: unknown): InspectableOption {
  return value as InspectableOption
}

function sector(code: string, name: string, amount: number, changePct: number | null): SectorItem {
  return {
    code,
    name,
    amount,
    changePct,
    upCount: 10,
    downCount: 5,
    leaderName: '领涨股',
    leaderCode: '000001',
    leaderChangePct: 3.25,
  }
}

describe('legacy-compatible chart options', () => {
  it('builds the sector treemap by turnover, with a stable 3.5% Other tile and drill metadata', () => {
    const sectors = [
      sector('minor-a', '<小板块>', 1, -2),
      sector('major-b', '板块 B', 500, -1),
      sector('minor-b', '小板块 B', 2, 2),
      sector('major-a', '板块 A', 1_000, 3),
    ]
    const board: SectorBoard = { type: 'industry', sectors, meta: META }
    const option = inspect(buildTreemapOption(board))
    const tree = option.series?.[0]
    const data = tree?.data as Array<Record<string, unknown>>

    expect(sectors.map((item) => item.code)).toEqual(['minor-a', 'major-b', 'minor-b', 'major-a'])
    expect(tree).toMatchObject({
      type: 'treemap',
      roam: false,
      nodeClick: false,
      sort: false,
      breadcrumb: { show: false },
    })
    expect(data.map((item) => item.name)).toEqual(['板块 A', '板块 B', '其他 2 个板块'])
    expect(data[0]).toMatchObject({ value: 1_000, sectorCode: 'major-a', changePct: 3 })
    expect(data[2]?.value).toBeCloseTo(1_500 * 0.035 / 0.965, 8)
    expect(data[2]).toMatchObject({
      isOthers: true,
      sectorCode: null,
      upCount: 1,
      downCount: 1,
    })
    expect((data[2]?.minorSectors as Array<{ code: string }>).map((item) => item.code)).toEqual(['minor-b', 'minor-a'])

    const label = (data[0]?.label as { formatter: (params: unknown) => string }).formatter({
      name: '板块 A',
      data: { changePct: 3 },
    })
    expect(label).toBe('板块 A\n+3.00%')

    const tooltip = option.tooltip?.formatter?.({
      name: data[2]?.name,
      value: data[2]?.value,
      data: data[2],
    }) ?? ''
    expect(tooltip).toContain('按成交额排序')
    expect(tooltip).toContain('data-sector-code="minor-b"')
    expect(tooltip).toContain('&lt;小板块&gt;')
    expect(tooltip.indexOf('小板块 B')).toBeLessThan(tooltip.indexOf('&lt;小板块&gt;'))

    const missingValueTooltip = option.tooltip?.formatter?.({
      name: '无涨跌数据',
      value: 100,
      data: { changePct: null, upCount: null, downCount: null, leaderName: null },
    }) ?? ''
    expect(missingValueTooltip).toContain('—')
    expect(missingValueTooltip).toContain('上涨 — 家 / 下跌 — 家')
  })

  it('keeps the old heat scale, legend order, theme variants, and click contract', () => {
    expect(heatColor(6)).toBe('rgb(223, 36, 54)')
    expect(heatColor(-6)).toBe('rgb(28, 158, 100)')
    expect(heatColor(0)).toBe('#333a47')
    expect(treemapLegendStops().map((stop) => stop.value)).toEqual([6, 3, 1, 0, -1, -3, -6])
    expect(getChartPalette('dark')).toBe(DARK_CHART_PALETTE)
    expect(getChartPalette('light')).toBe(LIGHT_CHART_PALETTE)
    expect(heatColor(3, LIGHT_CHART_PALETTE)).not.toBe(heatColor(3, DARK_CHART_PALETTE))
    expect(inspect(buildTreemapOption({ type: 'concept', sectors: [], meta: META }, LIGHT_CHART_PALETTE)).tooltip?.backgroundColor)
      .toBe('#ffffff')
    expect(treemapTargetFromEvent({ data: { sectorCode: 'BK001', name: '电子' } })).toEqual({
      sectorCode: 'BK001',
      name: '电子',
    })
    expect(treemapTargetFromEvent({ data: { sectorCode: null, name: '其他' } })).toBeNull()
  })

  it('recreates the intraday price, average, previous-close and directional volume series', () => {
    const points: TrendPoint[] = [
      { time: '09:30', price: 10, avgPrice: 9.98, volume: 1_000 },
      { time: '09:31', price: 10, avgPrice: null, volume: 2_000 },
      { time: '09:32', price: 9.9, avgPrice: 9.97, volume: 3_000 },
    ]
    const option = inspect(buildTrendOption(points, 9.8))
    const series = option.series ?? []

    expect(series).toHaveLength(3)
    expect(series[0]).toMatchObject({
      type: 'line',
      data: [10, 10, 9.9],
      showSymbol: false,
      markLine: { data: [{ yAxis: 9.8 }] },
    })
    expect(series[1]).toMatchObject({ type: 'line', data: [9.98, null, 9.97] })
    expect((series[2]?.data as Array<{ itemStyle: { color: string } }>).map((item) => item.itemStyle.color)).toEqual([
      DARK_CHART_PALETTE.upBar,
      DARK_CHART_PALETTE.flatBar,
      DARK_CHART_PALETTE.downBar,
    ])
    expect(option.tooltip?.formatter?.([{ dataIndex: 1 }])).toContain('09:31')
    expect(option.tooltip?.formatter?.([{ dataIndex: 1 }])).not.toContain('均价')
    expect(option.tooltip?.formatter?.([{ dataIndex: 1 }])).toContain('2000手')

    const zeroBase = inspect(buildTrendOption(points, 0))
    expect(zeroBase.series?.[0]).toMatchObject({ markLine: { data: [{ yAxis: 0 }] } })
  })

  it('uses every K-line bar, the old OHLC tuple, dual-grid zoom, volume colors and a content-free crosshair', () => {
    const bars: KLineBar[] = Array.from({ length: 100 }, (_, index) => ({
      date: `2026-01-${String(index + 1).padStart(2, '0')}`,
      open: 10 + index,
      close: 10 + index + (index % 2 === 0 ? 1 : -1),
      high: 12 + index,
      low: 9 + index,
      volume: 10_000 + index,
      amount: index === 1 ? null : 100_000 + index,
    }))
    const option = inspect(buildKlineOption(bars))
    const series = option.series ?? []
    const xAxes = option.xAxis as Array<Record<string, unknown>>
    const candleSeries = series.find(item => item.name === 'K 线')
    const volumeSeries = series.find(item => item.name === '成交量')

    expect((xAxes[0]?.data as unknown[])).toHaveLength(100)
    expect(candleSeries?.data).toHaveLength(100)
    expect((candleSeries?.data as number[][])[0]).toEqual([10, 11, 9, 12])
    expect(candleSeries?.markPoint).toBeUndefined()
    expect(series.map(item => item.name)).toEqual(['K 线', 'MA5', 'MA10', '成交量'])
    expect(option.axisPointer).toMatchObject({ link: [{ xAxisIndex: [0, 1] }] })
    expect(option.tooltip?.axisPointer).toMatchObject({ type: 'cross', snap: true })
    expect(option.tooltip?.showContent).toBe(false)
    expect(option.tooltip?.formatter).toBeUndefined()
    expect(option.tooltip?.position).toBeUndefined()
    expect(xAxes).toMatchObject([
      { axisPointer: { show: true, snap: true } },
      { axisPointer: { show: true, snap: true, label: { show: false } } },
    ])
    expect(option.dataZoom).toMatchObject([
      { type: 'inside', xAxisIndex: [0, 1], start: 55, end: 100 },
      { type: 'slider', xAxisIndex: [0, 1], start: 55, end: 100, top: '95%', height: 14 },
    ])
    expect((volumeSeries?.data as Array<{ itemStyle: { color: string } }>)[0]?.itemStyle.color).toBe(DARK_CHART_PALETTE.upBar)
    expect((volumeSeries?.data as Array<{ itemStyle: { color: string } }>)[1]?.itemStyle.color).toBe(DARK_CHART_PALETTE.downBar)

    const medium = inspect(buildKlineOption(bars, DARK_CHART_PALETTE, null, 'medium'))
    expect(medium.series?.map(item => item.name)).toEqual(['K 线', 'MA20', 'MA60', '成交量'])

    const preserved = inspect(buildKlineOption(bars, DARK_CHART_PALETTE, {
      startDate: bars[25]?.date ?? '',
      endDate: bars[70]?.date ?? '',
    }))
    expect(preserved.dataZoom).toMatchObject([
      { startValue: bars[25]?.date, endValue: bars[70]?.date },
      { startValue: bars[25]?.date, endValue: bars[70]?.date },
    ])
  })

  it('keeps valuation price and fair-value series on a true time axis and derives all four bands from fair value', () => {
    const valuation = valuationSummary({
      price: [['2026-01-01', 12], ['2026-01-02', 11], ['2026-02-14', 15]],
      medps: [['2026-01-01', 10], ['2026-02-14', 12]],
    })
    const option = inspect(buildValuationOption(valuation))
    const series = option.series ?? []

    expect(option.xAxis).toMatchObject({ type: 'time' })
    expect(option.legend?.data).toEqual(['价格', '大师价值线'])
    expect(series).toHaveLength(10)
    expect(series[0]).toMatchObject({ name: 'band+30-base', stack: 'band+30' })
    expect((series[0]?.data as Array<[string, number]>)[0]).toEqual(['2026-01-01', 11])
    expect((series[0]?.data as Array<[string, number]>)[1]?.[1]).toBeCloseTo(13.2, 12)
    expect(series[1]).toMatchObject({ name: 'band+30-fill', stack: 'band+30' })
    expect((series[1]?.data as Array<[string, number]>)[0]?.[0]).toBe('2026-01-01')
    expect((series[1]?.data as Array<[string, number]>)[0]?.[1]).toBeCloseTo(2, 12)
    expect((series[1]?.data as Array<[string, number]>)[1]?.[1]).toBeCloseTo(2.4, 12)
    expect(series[8]).toMatchObject({ name: '大师价值线', data: valuation.series.medps })
    expect(series[9]).toMatchObject({ name: '价格', data: valuation.series.price })

    const tooltip = option.tooltip?.formatter?.([
      { seriesName: 'band+10-fill', value: ['2026-01-01', 1], marker: '' },
      { seriesName: '价格', value: ['2026-01-01', 12], marker: '<price>' },
      { seriesName: '大师价值线', value: ['2026-01-01', 10], marker: '<fair>', axisValueLabel: '2026-01-01 00:00:00' },
    ]) ?? ''
    expect(tooltip).toContain('股价 <b>12.00</b>')
    expect(tooltip).toContain('大师价值 <b>10.00</b>')
    expect(tooltip).toContain('偏离 +20.00%')

    // ECharts time-axis triggering only returns the globally nearest series.
    // A daily price point therefore normally arrives without a sparse fair-value row.
    const priceOnlyTooltip = option.tooltip?.formatter?.([
      {
        seriesName: '价格',
        value: ['2026-01-02', 11],
        marker: '<price>',
        axisValue: '2026-01-02',
        axisValueLabel: '2026-01-02 00:00:00',
      },
    ]) ?? ''
    expect(priceOnlyTooltip).toContain('股价 <b>11.00</b>')
    expect(priceOnlyTooltip).toContain('大师价值（2026-01-01） <b>10.00</b>')
    expect(priceOnlyTooltip).toContain('偏离 +10.00%')
  })

  it('uses only real nearest source points in sparse valuation tooltips and prefers the prior point on a tie', () => {
    const valuation = valuationSummary({
      price: [['2026-01-02', 12], ['2026-02-13', 14]],
      medps: [['2026-01-01', 10], ['2026-01-03', 20], ['2026-02-14', 12]],
    })
    const option = inspect(buildValuationOption(valuation))

    const tiedTooltip = option.tooltip?.formatter?.([
      {
        seriesName: '价格',
        value: ['2026-01-02', 12],
        marker: '<price>',
        axisValue: '2026-01-02',
      },
    ]) ?? ''
    expect(tiedTooltip).toContain('大师价值（2026-01-01） <b>10.00</b>')
    expect(tiedTooltip).not.toContain('大师价值（2026-01-03）')
    expect(tiedTooltip).toContain('偏离 +20.00%')

    const fairOnlyTooltip = option.tooltip?.formatter?.([
      {
        seriesName: '大师价值线',
        value: ['2026-02-14', 12],
        marker: '<fair>',
        axisValue: '2026-02-14',
      },
    ]) ?? ''
    expect(fairOnlyTooltip).toContain('股价（2026-02-13） <b>14.00</b>')
    expect(fairOnlyTooltip).toContain('大师价值 <b>12.00</b>')
    expect(fairOnlyTooltip).toContain('偏离 +16.67%')

    const series = option.series ?? []
    expect(series[8]).toMatchObject({ data: valuation.series.medps })
    expect(series[9]).toMatchObject({ data: valuation.series.price })
  })

  it('keeps the five GuruFocus radar dimensions in their original order and treats partial nulls as zero', () => {
    const option = inspect(buildRadarOption({
      gfValue: 7,
      growth: 8,
      momentum: null,
      profitability: 9,
      financialStrength: 6,
    }))
    const indicator = option.radar?.indicator as Array<{ name: string }>
    const data = option.series?.[0]?.data as Array<{ value: number[] }>

    expect(indicator.map((item) => item.name)).toEqual(['价值', '成长', '动量', '盈利', '财务'])
    expect(data[0]?.value).toEqual([7, 8, 0, 9, 6])
    expect(buildRadarOption({
      gfValue: null,
      growth: null,
      momentum: null,
      profitability: null,
      financialStrength: null,
    })).toBeNull()
  })
})

function valuationSummary(series: ValuationSummary['series']): ValuationSummary {
  return {
    stockId: '0.000001',
    ivDcf: null,
    medps: null,
    gfScore: null,
    valuationRank: null,
    dimensions: {
      financialStrength: null,
      profitability: null,
      growth: null,
      gfValue: null,
      momentum: null,
    },
    series,
    meta: META,
  }
}
