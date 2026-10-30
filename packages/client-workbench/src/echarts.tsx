import { useEffect, useRef, type CSSProperties } from 'react'
import type { ECharts, EChartsCoreOption } from 'echarts/core'
import styles from './echarts.module.css'

type EChartsRuntime = typeof import('echarts/core')

let runtimePromise: Promise<EChartsRuntime> | null = null

/**
 * Do not evaluate ECharts while the DSH client factory is materialized.
 * zrender inspects browser globals at module evaluation time, whereas a DSH
 * factory is also validated in a pure Node context. Dynamic imports keep that
 * work behind React's browser-only mount boundary while still giving the
 * bundler statically-known, tree-shakeable modules.
 */
function loadEChartsRuntime(): Promise<EChartsRuntime> {
  runtimePromise ??= Promise.all([
    import('echarts/core'),
    import('echarts/charts'),
    import('echarts/components'),
    import('echarts/renderers'),
    import('echarts/features'),
  ]).then(([echarts, charts, components, renderers, features]) => {
    echarts.use([
      charts.TreemapChart,
      charts.LineChart,
      charts.ScatterChart,
      features.LabelLayout,
      charts.BarChart,
      charts.CandlestickChart,
      charts.RadarChart,
      components.TooltipComponent,
      components.GridComponent,
      components.LegendComponent,
      components.DataZoomComponent,
      components.AxisPointerComponent,
      components.MarkLineComponent,
      components.MarkPointComponent,
      renderers.CanvasRenderer,
    ])
    return echarts
  })
  return runtimePromise
}

export interface EChartProps {
  option: EChartsCoreOption | null
  /** Opt in to coalesced series/axis updates; change this key when date or chart structure changes. */
  mergeKey?: string
  className?: string
  style?: CSSProperties
  ariaLabel?: string
  onChartClick?: (params: unknown) => void
  onDataZoom?: (params: unknown) => void
  onAxisPointerUpdate?: (params: unknown) => void
  onPointerLeave?: () => void
}

/** A lifecycle-safe, tree-shaken ECharts canvas for the workbench. */
export function EChart({
  option,
  mergeKey,
  className,
  style,
  ariaLabel = '数据图表',
  onChartClick,
  onDataZoom,
  onAxisPointerUpdate,
  onPointerLeave,
}: EChartProps) {
  const elementRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<ECharts | null>(null)
  const clickHandlerRef = useRef(onChartClick)
  const dataZoomHandlerRef = useRef(onDataZoom)
  const axisPointerHandlerRef = useRef(onAxisPointerUpdate)
  const optionRef = useRef(option)
  const mergeKeyRef = useRef(mergeKey)
  const appliedMergeKey = useRef<string | undefined>(undefined)
  clickHandlerRef.current = onChartClick
  dataZoomHandlerRef.current = onDataZoom
  axisPointerHandlerRef.current = onAxisPointerUpdate
  optionRef.current = option
  mergeKeyRef.current = mergeKey

  useEffect(() => {
    const element = elementRef.current
    if (!element || typeof window === 'undefined') return
    let cancelled = false
    let dispose: (() => void) | null = null

    void loadEChartsRuntime().then((echarts) => {
      if (cancelled) return
      const chart = echarts.init(element)
      chartRef.current = chart
      const currentOption = optionRef.current
      if (currentOption) chart.setOption(currentOption, { notMerge: true })
      else chart.clear()
      appliedMergeKey.current = currentOption ? mergeKeyRef.current : undefined
      const handleChartClick = (params: unknown) => clickHandlerRef.current?.(params)
      const handleDataZoom = (params: unknown) => dataZoomHandlerRef.current?.(params)
      const handleAxisPointerUpdate = (params: unknown) => axisPointerHandlerRef.current?.(params)
      const handleContainerClick = (event: MouseEvent) => {
        const target = event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-sector-code]')
          : null
        const sectorCode = target?.dataset.sectorCode
        if (!sectorCode) return
        event.stopPropagation()
        clickHandlerRef.current?.({
          data: {
            sectorCode,
            name: target.dataset.sectorName ?? '',
          },
        })
      }
      chart.on('click', handleChartClick)
      const chartEvents = chart as unknown as {
        on: (event: string, handler: (params: unknown) => void) => void
        off: (event: string, handler: (params: unknown) => void) => void
      }
      chartEvents.on('datazoom', handleDataZoom)
      chartEvents.on('updateAxisPointer', handleAxisPointerUpdate)
      element.addEventListener('click', handleContainerClick)
      const resizeObserver = typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => chart.resize())
      resizeObserver?.observe(element)
      dispose = () => {
        resizeObserver?.disconnect()
        element.removeEventListener('click', handleContainerClick)
        chart.off('click', handleChartClick)
        chartEvents.off('datazoom', handleDataZoom)
        chartEvents.off('updateAxisPointer', handleAxisPointerUpdate)
        chart.dispose()
        if (chartRef.current === chart) chartRef.current = null
      }
    }).catch((error: unknown) => {
      if (!cancelled) console.error('Hanai ECharts runtime failed to load', error)
    })

    return () => {
      cancelled = true
      dispose?.()
    }
  }, [])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    if (!option) {
      chart.clear()
      appliedMergeKey.current = undefined
    } else if (mergeKey === undefined || mergeKey !== appliedMergeKey.current) {
      chart.setOption(option, { notMerge: true })
      appliedMergeKey.current = mergeKey
    } else {
      // Keep user zoom/legend state and coalesce nearby trend/news responses into one paint.
      const timer = window.setTimeout(() => chart.setOption({ xAxis: option.xAxis, series: option.series, tooltip: option.tooltip }, { replaceMerge: ['series'], lazyUpdate: true }), 80)
      return () => window.clearTimeout(timer)
    }
  }, [option, mergeKey])

  return (
    <div
      ref={elementRef}
      className={[styles['chart'], className].filter(Boolean).join(' ')}
      style={style}
      role="img"
      aria-label={ariaLabel}
      onMouseLeave={onPointerLeave}
    />
  )
}

export default EChart
