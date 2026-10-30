import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { EChartsCoreOption } from 'echarts/core'
import type { MarketIntradayData, MarketSignalsData } from '../../contracts/src/market-activity.ts'
import type { MarketStatus } from '../../contracts/src/index.ts'
import { marketHistoryPanel, type MarketHistorySnapshot } from '../../contracts/src/market-history.ts'
import type { HanaiClient } from './api.ts'
import { buildTrendOption, type ChartPalette } from './chart-options.ts'
import { isClosingPanelCurrent } from './market-history.tsx'
import { isMarketOpen } from './market-hours.ts'
import { EChart } from './echarts.tsx'
import { number } from './format.ts'
import { PanelHead } from './panel-head.tsx'
import { MarketPanelStatus } from './market-panel-status.tsx'
import styles from './styles.module.css'

function latestTrend(previous: MarketIntradayData | null, incoming: MarketIntradayData): MarketIntradayData {
  return previous !== null && Date.parse(incoming.meta.sourceTimestamp ?? incoming.meta.fetchedAt) < Date.parse(previous.meta.sourceTimestamp ?? previous.meta.fetchedAt) ? previous : incoming
}

function latestSignals(previous: MarketSignalsData | null, incoming: MarketSignalsData): MarketSignalsData {
  return previous !== null && (incoming.date < previous.date || (incoming.date === previous.date && Date.parse(incoming.meta.fetchedAt) < Date.parse(previous.meta.fetchedAt))) ? previous : incoming
}

/** Reuses the price/average/volume chart; news labels are escaped by ECharts' plain-text labels. */
export function buildMarketActivityOption(trend: MarketIntradayData | null, signals: MarketSignalsData | null, palette: ChartPalette): EChartsCoreOption | null {
  if (trend === null) return null
  const option = buildTrendOption(trend.points, trend.prevClose, palette, '点')
  if (option === null || !Array.isArray(option.series)) return option
  const matching = signals?.date === trend.date ? signals.signals : []
  const data = matching.flatMap(signal => {
    const index = trend.points.findIndex(point => point.time === signal.time)
    if (index < 0) return []
    const color = signal.direction === 'up' ? palette.up : palette.down
    return [{ value: [index, trend.points[index]!.price], name: signal.name,
      itemStyle: { color }, label: { show: true, formatter: () => signal.name, color, fontSize: 10, position: signal.direction === 'up' ? 'top' : 'bottom', distance: 8 },
      tooltip: { formatter: () => `${signal.time} ${signal.title}`.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') } }]
  })
  return { ...option, series: [...option.series.map((series, index) => ({ ...series, id: ['price', 'average', 'volume'][index] })), { id: 'signals', type: 'scatter', name: '板块异动', data, symbolSize: 6, z: 10,
    label: { show: true },
    // Explicit positions let ECharts retain its overlap shifts instead of reattaching labels to symbols.
    labelLayout: ({ labelRect }: { labelRect: { x: number; y: number; width: number } }) => ({ x: labelRect.x + labelRect.width / 2, y: labelRect.y,
      align: 'center', verticalAlign: 'top', moveOverlap: 'shiftY', hideOverlap: false }),
    labelLine: { show: true, lineStyle: { color: palette.axisLabel, width: 0.5 } },
    tooltip: { trigger: 'item' } }] }
}

export function MarketActivityPanel({ client, snapshot, historical, marketStatus, palette, refreshVersion, onArchived }: {
  client: HanaiClient; snapshot: MarketHistorySnapshot | null; historical: boolean; marketStatus?: MarketStatus; palette: ChartPalette; refreshVersion: number; onArchived: () => Promise<void>
}) {
  const cardRef = useRef<HTMLElement | null>(null)
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [dialogStyle, setDialogStyle] = useState<CSSProperties>({})
  useLayoutEffect(() => {
    if (!expanded) return
    const dialog = dialogRef.current!
    const page = cardRef.current?.closest(`.${styles['page']}`) ?? cardRef.current!
    const measure = () => {
      const rect = page.getBoundingClientRect()
      const style = getComputedStyle(page)
      const left = rect.left + (parseFloat(style.paddingLeft) || 0)
      const width = Math.min(page.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0), window.innerWidth - 32)
      const top = Math.max(0, rect.top)
      const bottom = Math.min(window.innerHeight, rect.bottom)
      const height = Math.max(160, bottom - top - 32)
      setDialogStyle({ left, top: (top + bottom) / 2, width, maxHeight: height, '--activity-dialog-height': `${height}px` } as CSSProperties)
    }
    measure()
    dialog.showModal()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(page)
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); if (dialog.open) dialog.close() }
  }, [expanded])
  const [liveTrend, setTrend] = useState<{ data: MarketIntradayData; archived: boolean } | null>(null)
  const [liveSignals, setSignals] = useState<MarketSignalsData | null>(null)
  const trend = historical ? marketHistoryPanel(snapshot, 'intraday') : liveTrend?.data ?? null
  const signals = historical ? marketHistoryPanel(snapshot, 'signals') : liveSignals
  const [trendLoading, setTrendLoading] = useState(false)
  const [signalsLoading, setSignalsLoading] = useState(false)
  const [failed, setFailed] = useState({ trend: false, signals: false })
  useEffect(() => {
    if (historical) return
    const savedTrend = marketHistoryPanel(snapshot, 'intraday')
    const savedSignals = marketHistoryPanel(snapshot, 'signals')
    if (savedTrend !== null) setTrend(previous => previous !== null && latestTrend(previous.data, savedTrend) === previous.data ? previous : { data: savedTrend, archived: true })
    if (savedSignals !== null) setSignals(previous => latestSignals(previous, savedSignals))
    setFailed({ trend: false, signals: false })
    setTrendLoading(false)
    setSignalsLoading(false)
    const controller = new AbortController()
    let trendPending = false
    let signalsPending = false
    const loadTrend = async () => {
      if (trendPending) return
      trendPending = true
      setTrendLoading(true)
      try {
        const result = await client.call('market.intraday', {}, controller.signal)
        if (controller.signal.aborted) return
        setFailed(previous => ({ ...previous, trend: result === null || result.meta.cacheState === 'stale' }))
        if (result !== null) setTrend(previous => previous !== null && latestTrend(previous.data, result) === previous.data ? previous : { data: result, archived: false })
        void onArchived()
      } catch { if (!controller.signal.aborted) setFailed(previous => ({ ...previous, trend: true })) }
      finally { trendPending = false; if (!controller.signal.aborted) setTrendLoading(false) }
    }
    const loadSignals = async () => {
      if (signalsPending) return
      signalsPending = true
      setSignalsLoading(true)
      try {
        const result = await client.call('market.signals', {}, controller.signal)
        if (controller.signal.aborted) return
        setFailed(previous => ({ ...previous, signals: result === null || result.meta.cacheState === 'stale' }))
        if (result !== null) setSignals(previous => latestSignals(previous, result))
        void onArchived()
      } catch { if (!controller.signal.aborted) setFailed(previous => ({ ...previous, signals: true })) }
      finally { signalsPending = false; if (!controller.signal.aborted) setSignalsLoading(false) }
    }
    if (refreshVersion > 0 || isMarketOpen() || savedTrend === null || !isClosingPanelCurrent(savedTrend.meta)) void loadTrend()
    if (refreshVersion > 0 || isMarketOpen() || savedSignals === null || savedSignals.method !== 'ths-sector-events-v2' || !isClosingPanelCurrent(savedSignals.meta)) void loadSignals()
    const timer = window.setInterval(() => { if (isMarketOpen()) { void loadTrend(); void loadSignals() } }, 30_000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [client, snapshot, historical, refreshVersion, onArchived])
  const option = useMemo(() => buildMarketActivityOption(trend, signals, palette), [trend, signals, palette])
  const header = (zoomed: boolean) => <PanelHead title="大盘异动" hint="上证分时 · 板块异动" meta={<>
      <MarketPanelStatus historical={historical} items={[
        { label: '上证分时', meta: trend?.meta, failed: !historical && failed.trend },
        { label: '异动快讯', meta: signals?.meta, failed: !historical && failed.signals },
      ]} />
      {signals?.method !== 'ths-sector-events-v2' && signals !== null && <small>{historical ? '旧版异动快照，仅保存了部分事件' : '旧版异动数据，正在更新'}</small>}
    </>} extra={<span className={`${styles['metaText']} ${styles['activityActions']}`}>昨收 {number(trend?.prevClose ?? null)}
        <button className={styles['button']} aria-label={zoomed ? '缩小大盘异动' : '放大大盘异动'} aria-pressed={zoomed} autoFocus={zoomed} onClick={() => setExpanded(!zoomed)}>{zoomed ? '缩小' : '放大'}</button>
      </span>} />
  const content = <>
    {option === null ? <div className={styles['activityEmpty']}>{historical ? '该日期未保存大盘分时' : trendLoading ? '正在加载上证分时…' : '上证分时暂不可用'}</div>
      : <EChart option={option} mergeKey={`${historical ? 'history' : 'live'}:${trend?.date}:${trend?.prevClose}:${palette.tooltipBackground}`} className={styles['activityChart']!} ariaLabel="大盘异动分时走势图" />}
    {(signals === null || signals.date !== trend?.date || signals.signals.length === 0) && <div className={styles['activityNotice']}>{historical && signals === null ? '该日期未保存板块异动' : signalsLoading ? '正在读取异动快讯…' : signals === null || signals.date !== trend?.date ? '板块异动暂不可用' : '当日暂无匹配的板块异动快讯'}</div>}
  </>
  return <>
    <article ref={cardRef} className={`${styles['card']} ${styles['activityCard']}`} aria-label="大盘异动">{header(false)}{content}</article>
    <dialog ref={dialogRef} className={styles['activityDialog']} style={dialogStyle} aria-label="放大的大盘异动" onCancel={() => setExpanded(false)} onClose={() => setExpanded(false)}>
      {expanded && <>{header(true)}{content}</>}
    </dialog>
  </>
}
