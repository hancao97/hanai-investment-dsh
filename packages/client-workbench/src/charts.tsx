import { useId, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { KLineBar, TrendPoint } from '../../contracts/src/index.ts'
import styles from './styles.module.css'
import researchStyles from './research-surfaces.module.css'

const WIDTH = 760
const HEIGHT = 290
const LEFT = 54
const RIGHT = 16
const PRICE_TOP = 14
const PRICE_BOTTOM = 196
const VOLUME_TOP = 216
const VOLUME_BOTTOM = 258
const AXIS_Y = 280

interface AxisScale {
  min: number
  max: number
  y: (value: number) => number
}

interface TrendDatum {
  point: TrendPoint
  x: number
}

interface KlineDatum {
  bar: KLineBar
  x: number
  slot: number
}

export function Sparkline({ values, positive = true }: { values: number[]; positive?: boolean }) {
  const gradientId = `hanai-spark-${useId().replaceAll(':', '')}`
  const finiteValues = values.filter(Number.isFinite)
  if (finiteValues.length < 2) return <div className={styles['chartEmpty']}>暂无走势</div>
  const points = linePoints(finiteValues, 320, 100, 6)
  return (
    <svg className={styles['sparkline']} viewBox="0 0 320 100" preserveAspectRatio="none" role="img" aria-label="走势折线图">
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={positive ? 'var(--hanai-up)' : 'var(--hanai-down)'} stopOpacity=".24" />
          <stop offset="1" stopColor={positive ? 'var(--hanai-up)' : 'var(--hanai-down)'} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${points.path} L314,94 L6,94 Z`} fill={`url(#${gradientId})`} />
      <path d={points.path} fill="none" stroke={positive ? 'var(--hanai-up)' : 'var(--hanai-down)'} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/**
 * Intraday chart. `prevClose` is optional so existing callers remain source
 * compatible; the reference line is rendered only when a real upstream value
 * is available. It is never inferred from the first trade.
 */
export function TrendChart({ points, prevClose = null }: { points: TrendPoint[]; prevClose?: number | null }) {
  const descriptionId = `hanai-trend-help-${useId().replaceAll(':', '')}`
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const validPoints = points.filter(isValidTrendPoint)
  if (validPoints.length < 2) return <div className={styles['chartEmpty']}>暂无分时数据</div>

  const xPositions = temporalXPositions(validPoints.map(point => point.time))
  const data = validPoints.map((point, index): TrendDatum => ({ point, x: xPositions[index] ?? LEFT }))
  const averageValues = validPoints.flatMap(point => point.avgPrice !== null && Number.isFinite(point.avgPrice) ? [point.avgPrice] : [])
  const scaleValues = [...validPoints.map(point => point.price), ...averageValues]
  const realPrevClose = prevClose !== null && Number.isFinite(prevClose) ? prevClose : null
  if (realPrevClose !== null) scaleValues.push(realPrevClose)
  const priceScale = makeScale(scaleValues, PRICE_TOP, PRICE_BOTTOM)
  const maxVolume = Math.max(0, ...validPoints.map(point => Math.max(0, point.volume)))
  const pricePath = linePath(data.map(item => ({ x: item.x, y: priceScale.y(item.point.price) })))
  const averagePath = segmentedLinePath(data.map(item => ({
    x: item.x,
    value: item.point.avgPrice !== null && Number.isFinite(item.point.avgPrice) ? item.point.avgPrice : null,
  })), priceScale)
  const latest = validPoints.at(-1)?.price ?? 0
  const comparison = realPrevClose ?? validPoints[0]?.price ?? latest
  const positive = latest >= comparison
  const resolvedIndex = activeIndex === null ? null : Math.min(activeIndex, data.length - 1)
  const active = resolvedIndex === null ? null : data[resolvedIndex] ?? null
  const xTicks = sampledIndices(data.length)

  const moveFromPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.width <= 0) return
    const viewX = (event.clientX - bounds.left) / bounds.width * WIDTH
    setActiveIndex(nearestIndex(data.map(item => item.x), viewX))
  }

  return (
    <div className={researchStyles['chartFrame']} onPointerLeave={() => setActiveIndex(null)}>
      <svg
        className={`${styles['mainChart']} ${researchStyles['chartSvg']}`}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        tabIndex={0}
        aria-label="股票分时价格、均价与成交量图"
        aria-describedby={descriptionId}
        onFocus={() => setActiveIndex(current => current ?? data.length - 1)}
        onKeyDown={event => moveChartCursor(event, data.length, resolvedIndex, setActiveIndex)}
        onPointerMove={moveFromPointer}
      >
        <ChartGrid scale={priceScale} xPositions={xTicks.map(index => data[index]?.x ?? LEFT)} />
        <text className={researchStyles['axisTitle']} x="4" y="10">价格</text>
        {axisTicks(priceScale).map(tick => (
          <text key={tick} className={researchStyles['axisLabel']} x={LEFT - 7} y={priceScale.y(tick) + 3} textAnchor="end">
            {formatPrice(tick)}
          </text>
        ))}
        <line x1={LEFT} x2={WIDTH - RIGHT} y1={VOLUME_TOP} y2={VOLUME_TOP} stroke="var(--hanai-border)" vectorEffect="non-scaling-stroke" />
        <text className={researchStyles['axisTitle']} x="4" y={VOLUME_TOP + 8}>成交量</text>
        {maxVolume > 0 && <text className={researchStyles['axisLabel']} x={LEFT - 7} y={VOLUME_TOP + 8} textAnchor="end">{formatQuantity(maxVolume)}</text>}
        {data.map((item, index) => {
          const height = maxVolume <= 0 ? 0 : Math.max(0, item.point.volume) / maxVolume * (VOLUME_BOTTOM - VOLUME_TOP)
          const nextX = data[index + 1]?.x
          const previousX = data[index - 1]?.x
          const interval = Math.min(
            nextX === undefined ? Number.POSITIVE_INFINITY : nextX - item.x,
            previousX === undefined ? Number.POSITIVE_INFINITY : item.x - previousX,
          )
          const fallbackWidth = (WIDTH - LEFT - RIGHT) / data.length
          const barWidth = Math.max(1, Math.min(5, (Number.isFinite(interval) ? interval : fallbackWidth) * .66))
          return (
            <rect
              key={`${item.point.time}-${index}`}
              data-volume-bar="trend"
              x={item.x - barWidth / 2}
              y={VOLUME_BOTTOM - height}
              width={barWidth}
              height={height}
              fill="var(--hanai-primary)"
              opacity=".34"
            />
          )
        })}
        {realPrevClose !== null && (
          <g data-previous-close="true">
            <line x1={LEFT} x2={WIDTH - RIGHT} y1={priceScale.y(realPrevClose)} y2={priceScale.y(realPrevClose)} stroke="var(--hanai-muted)" strokeDasharray="4 4" opacity=".75" vectorEffect="non-scaling-stroke" />
            <text className={researchStyles['axisLabel']} x={WIDTH - RIGHT - 2} y={priceScale.y(realPrevClose) - 4} textAnchor="end">昨收 {formatPrice(realPrevClose)}</text>
          </g>
        )}
        {averagePath !== '' && <path data-series="average" d={averagePath} fill="none" stroke="var(--hanai-gold)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" opacity=".9" />}
        <path data-series="price" d={pricePath} fill="none" stroke={positive ? 'var(--hanai-up)' : 'var(--hanai-down)'} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {xTicks.map(index => {
          const item = data[index]
          if (item === undefined) return null
          return (
            <text key={`${item.point.time}-${index}`} className={researchStyles['axisLabel']} x={item.x} y={AXIS_Y} textAnchor={axisAnchor(index, data.length)}>
              {formatTimeLabel(item.point.time)}
            </text>
          )
        })}
        {active !== null && (
          <g aria-hidden="true">
            <line x1={active.x} x2={active.x} y1={PRICE_TOP} y2={VOLUME_BOTTOM} stroke="var(--hanai-primary)" strokeDasharray="3 3" opacity=".65" vectorEffect="non-scaling-stroke" />
            <circle cx={active.x} cy={priceScale.y(active.point.price)} r="3.5" fill="var(--hanai-panel-solid)" stroke="var(--hanai-primary)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </g>
        )}
      </svg>
      <p id={descriptionId} className={researchStyles['screenReaderOnly']}>聚焦图表后可使用左右方向键查看每个时点的真实数据。</p>
      {active !== null && <TrendTooltip item={active} />}
      <div className={researchStyles['legend']} aria-hidden="true">
        <Legend color={positive ? 'var(--hanai-up)' : 'var(--hanai-down)'} label="成交价" />
        {averagePath !== '' && <Legend color="var(--hanai-gold)" label="分时均价" />}
        <Legend color="var(--hanai-primary)" label="成交量" />
      </div>
    </div>
  )
}

export function KlineChart({ bars }: { bars: KLineBar[] }) {
  const descriptionId = `hanai-kline-help-${useId().replaceAll(':', '')}`
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const validBars = bars.filter(isValidKlineBar)
  const visible = validBars.slice(-72)
  if (visible.length === 0) return <div className={styles['chartEmpty']}>暂无 K 线数据</div>

  const slot = (WIDTH - LEFT - RIGHT) / visible.length
  const data = visible.map((bar, index): KlineDatum => ({ bar, slot, x: LEFT + index * slot + slot / 2 }))
  const priceScale = makeScale(visible.flatMap(bar => [bar.low, bar.high, bar.open, bar.close]), PRICE_TOP, PRICE_BOTTOM)
  const maxVolume = Math.max(0, ...visible.map(bar => Math.max(0, bar.volume)))
  const resolvedIndex = activeIndex === null ? null : Math.min(activeIndex, data.length - 1)
  const active = resolvedIndex === null ? null : data[resolvedIndex] ?? null
  const xTicks = sampledIndices(data.length)

  const moveFromPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.width <= 0) return
    const viewX = (event.clientX - bounds.left) / bounds.width * WIDTH
    setActiveIndex(nearestIndex(data.map(item => item.x), viewX))
  }

  return (
    <div className={researchStyles['chartFrame']} onPointerLeave={() => setActiveIndex(null)}>
      <svg
        className={`${styles['mainChart']} ${researchStyles['chartSvg']}`}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        tabIndex={0}
        aria-label="股票 K 线、成交量与开高低收数据图"
        aria-describedby={descriptionId}
        onFocus={() => setActiveIndex(current => current ?? data.length - 1)}
        onKeyDown={event => moveChartCursor(event, data.length, resolvedIndex, setActiveIndex)}
        onPointerMove={moveFromPointer}
      >
        <ChartGrid scale={priceScale} xPositions={xTicks.map(index => data[index]?.x ?? LEFT)} />
        <text className={researchStyles['axisTitle']} x="4" y="10">价格</text>
        {axisTicks(priceScale).map(tick => (
          <text key={tick} className={researchStyles['axisLabel']} x={LEFT - 7} y={priceScale.y(tick) + 3} textAnchor="end">
            {formatPrice(tick)}
          </text>
        ))}
        <line x1={LEFT} x2={WIDTH - RIGHT} y1={VOLUME_TOP} y2={VOLUME_TOP} stroke="var(--hanai-border)" vectorEffect="non-scaling-stroke" />
        <text className={researchStyles['axisTitle']} x="4" y={VOLUME_TOP + 8}>成交量</text>
        {maxVolume > 0 && <text className={researchStyles['axisLabel']} x={LEFT - 7} y={VOLUME_TOP + 8} textAnchor="end">{formatQuantity(maxVolume)}</text>}
        {data.map((item, index) => {
          const { bar } = item
          const up = bar.close >= bar.open
          const top = priceScale.y(Math.max(bar.open, bar.close))
          const bottom = priceScale.y(Math.min(bar.open, bar.close))
          const color = up ? 'var(--hanai-up)' : 'var(--hanai-down)'
          const candleWidth = Math.max(2, Math.min(9, item.slot * .62))
          const volumeHeight = maxVolume <= 0 ? 0 : Math.max(0, bar.volume) / maxVolume * (VOLUME_BOTTOM - VOLUME_TOP)
          return (
            <g key={`${bar.date}-${index}`}>
              <title>{klineAccessibleText(bar)}</title>
              <line x1={item.x} x2={item.x} y1={priceScale.y(bar.high)} y2={priceScale.y(bar.low)} stroke={color} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              <rect x={item.x - candleWidth / 2} y={top} width={candleWidth} height={Math.max(1, bottom - top)} fill={up ? 'transparent' : color} stroke={color} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              <rect data-volume-bar="kline" x={item.x - candleWidth / 2} y={VOLUME_BOTTOM - volumeHeight} width={candleWidth} height={volumeHeight} fill={color} opacity=".42" />
            </g>
          )
        })}
        {xTicks.map(index => {
          const item = data[index]
          if (item === undefined) return null
          return (
            <text key={`${item.bar.date}-${index}`} className={researchStyles['axisLabel']} x={item.x} y={AXIS_Y} textAnchor={axisAnchor(index, data.length)}>
              {formatDateLabel(item.bar.date)}
            </text>
          )
        })}
        {active !== null && (
          <g aria-hidden="true">
            <line x1={active.x} x2={active.x} y1={PRICE_TOP} y2={VOLUME_BOTTOM} stroke="var(--hanai-primary)" strokeDasharray="3 3" opacity=".65" vectorEffect="non-scaling-stroke" />
            <circle cx={active.x} cy={priceScale.y(active.bar.close)} r="3.5" fill="var(--hanai-panel-solid)" stroke="var(--hanai-primary)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </g>
        )}
      </svg>
      <p id={descriptionId} className={researchStyles['screenReaderOnly']}>聚焦图表后可使用左右方向键查看每个交易日的开、高、低、收与成交量。</p>
      {active !== null && <KlineTooltip item={active} />}
      <div className={researchStyles['legend']} aria-hidden="true">
        <Legend color="var(--hanai-up)" label="上涨" />
        <Legend color="var(--hanai-down)" label="下跌" />
        <Legend color="var(--hanai-muted)" label="成交量" />
      </div>
    </div>
  )
}

export function ValuationHistoryChart({
  price,
  medps,
}: {
  price: Array<[string, number]>
  medps: Array<[string, number]>
}) {
  const dates = [...new Set([...price.map(([date]) => date), ...medps.map(([date]) => date)])].sort()
  const priceByDate = new Map(price.filter(([, value]) => Number.isFinite(value)))
  const medpsByDate = new Map(medps.filter(([, value]) => Number.isFinite(value)))
  const values = [...priceByDate.values(), ...medpsByDate.values()]
  if (dates.length < 2 || values.length < 2) return <div className={styles['chartEmpty']}>暂无价格与价值历史</div>
  const scale = makeScale(values, PRICE_TOP, PRICE_BOTTOM)
  const xFor = (index: number) => equalX(index, dates.length)
  const pricePath = segmentedLinePath(dates.map((date, index) => ({ x: xFor(index), value: priceByDate.get(date) ?? null })), scale)
  const medpsPath = segmentedLinePath(dates.map((date, index) => ({ x: xFor(index), value: medpsByDate.get(date) ?? null })), scale)
  const ticks = sampledIndices(dates.length)
  return (
    <div className={researchStyles['chartFrame']}>
      <svg className={`${styles['mainChart']} ${researchStyles['chartSvg']}`} viewBox={`0 0 ${WIDTH} 225`} role="img" aria-label="历史价格与中位市销率价值对比图">
        <title>仅使用数据源返回的历史价格与价值序列，不对缺失时点插值</title>
        {axisTicks(scale).map(tick => <g key={tick}><line x1={LEFT} x2={WIDTH - RIGHT} y1={scale.y(tick)} y2={scale.y(tick)} stroke="var(--hanai-border)" vectorEffect="non-scaling-stroke" /><text className={researchStyles['axisLabel']} x={LEFT - 7} y={scale.y(tick) + 3} textAnchor="end">{formatPrice(tick)}</text></g>)}
        {pricePath !== '' && <path d={pricePath} fill="none" stroke="var(--hanai-primary)" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
        {medpsPath !== '' && <path d={medpsPath} fill="none" stroke="var(--hanai-gold)" strokeWidth="2" strokeDasharray="5 3" vectorEffect="non-scaling-stroke" />}
        {ticks.map(index => <text key={`${dates[index]}-${index}`} className={researchStyles['axisLabel']} x={xFor(index)} y="218" textAnchor={axisAnchor(index, dates.length)}>{formatDateLabel(dates[index] ?? '')}</text>)}
      </svg>
      <div className={researchStyles['legend']} aria-hidden="true">
        <Legend color="var(--hanai-primary)" label="市场价格" />
        <Legend color="var(--hanai-gold)" label="中位 PS 价值" />
      </div>
    </div>
  )
}

function TrendTooltip({ item }: { item: TrendDatum }) {
  const left = tooltipLeft(item.x)
  return (
    <div className={researchStyles['tooltip']} style={{ left }} role="status" aria-live="polite">
      <strong>{item.point.time}</strong>
      <div className={researchStyles['tooltipGrid']}>
        <span>价格 <b>{formatPrice(item.point.price)}</b></span>
        {item.point.avgPrice !== null && Number.isFinite(item.point.avgPrice) && <span>均价 <b>{formatPrice(item.point.avgPrice)}</b></span>}
        <span>成交量 <b>{formatQuantity(item.point.volume)}</b></span>
      </div>
    </div>
  )
}

function KlineTooltip({ item }: { item: KlineDatum }) {
  const { bar } = item
  return (
    <div className={researchStyles['tooltip']} style={{ left: tooltipLeft(item.x) }} role="status" aria-live="polite">
      <strong>{bar.date}</strong>
      <div className={researchStyles['tooltipGrid']}>
        <span>开 <b>{formatPrice(bar.open)}</b></span>
        <span>高 <b>{formatPrice(bar.high)}</b></span>
        <span>低 <b>{formatPrice(bar.low)}</b></span>
        <span>收 <b>{formatPrice(bar.close)}</b></span>
        <span>量 <b>{formatQuantity(bar.volume)}</b></span>
        {bar.amount !== null && Number.isFinite(bar.amount) && <span>额 <b>{formatMoney(bar.amount)}</b></span>}
      </div>
    </div>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span><i style={{ '--legend-color': color } as CSSProperties} />{label}</span>
}

function ChartGrid({ scale, xPositions }: { scale: AxisScale; xPositions: number[] }) {
  return (
    <>
      {axisTicks(scale).map(tick => <line key={`h-${tick}`} x1={LEFT} x2={WIDTH - RIGHT} y1={scale.y(tick)} y2={scale.y(tick)} stroke="var(--hanai-border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
      {xPositions.map((x, index) => <line key={`v-${index}-${x}`} x1={x} x2={x} y1={PRICE_TOP} y2={VOLUME_BOTTOM} stroke="var(--hanai-border)" strokeWidth="1" opacity=".58" vectorEffect="non-scaling-stroke" />)}
    </>
  )
}

function moveChartCursor(
  event: ReactKeyboardEvent<SVGSVGElement>,
  length: number,
  current: number | null,
  setActive: (index: number) => void,
) {
  if (length === 0) return
  const index = current ?? length - 1
  let next: number | null = null
  if (event.key === 'ArrowLeft') next = Math.max(0, index - 1)
  else if (event.key === 'ArrowRight') next = Math.min(length - 1, index + 1)
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = length - 1
  if (next === null) return
  event.preventDefault()
  setActive(next)
}

function isValidTrendPoint(point: TrendPoint): boolean {
  return point.time.trim() !== '' && Number.isFinite(point.price) && Number.isFinite(point.volume)
}

function isValidKlineBar(bar: KLineBar): boolean {
  return bar.date.trim() !== ''
    && Number.isFinite(bar.open)
    && Number.isFinite(bar.close)
    && Number.isFinite(bar.high)
    && Number.isFinite(bar.low)
    && Number.isFinite(bar.volume)
}

function makeScale(values: number[], top: number, bottom: number): AxisScale {
  const finite = values.filter(Number.isFinite)
  let min = Math.min(...finite)
  let max = Math.max(...finite)
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0
    max = 1
  } else if (min === max) {
    const expansion = Math.abs(min) * .005 || 1
    min -= expansion
    max += expansion
  } else {
    const padding = (max - min) * .045
    min -= padding
    max += padding
  }
  const range = max - min
  return {
    min,
    max,
    y: value => top + (max - value) / range * (bottom - top),
  }
}

function axisTicks(scale: AxisScale): number[] {
  return [0, 1, 2, 3, 4].map(index => scale.max - (scale.max - scale.min) * index / 4)
}

function temporalXPositions(labels: string[]): number[] {
  const parsed = labels.map(parseTimeOrdinal)
  const usable = parsed.every((value): value is number => value !== null)
    && parsed.every((value, index) => index === 0 || value >= (parsed[index - 1] ?? value))
    && (parsed.at(-1) ?? 0) > (parsed[0] ?? 0)
  if (!usable) return labels.map((_, index) => equalX(index, labels.length))
  const first = parsed[0] ?? 0
  const range = (parsed.at(-1) ?? first) - first
  return parsed.map(value => LEFT + (value - first) / range * (WIDTH - LEFT - RIGHT))
}

function parseTimeOrdinal(value: string): number | null {
  const match = /(?:^|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim())
  if (match === null) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3] ?? 0)
  if (hours > 23 || minutes > 59 || seconds > 59) return null
  return hours * 3600 + minutes * 60 + seconds
}

function equalX(index: number, length: number): number {
  return LEFT + index / Math.max(1, length - 1) * (WIDTH - LEFT - RIGHT)
}

function sampledIndices(length: number): number[] {
  if (length <= 1) return [0]
  return [...new Set([0, .25, .5, .75, 1].map(value => Math.round((length - 1) * value)))]
}

function nearestIndex(values: number[], target: number): number {
  let result = 0
  let distance = Number.POSITIVE_INFINITY
  for (const [index, value] of values.entries()) {
    const candidate = Math.abs(value - target)
    if (candidate < distance) {
      distance = candidate
      result = index
    }
  }
  return result
}

function axisAnchor(index: number, length: number): 'start' | 'middle' | 'end' {
  if (index === 0) return 'start'
  if (index === length - 1) return 'end'
  return 'middle'
}

function linePath(points: Array<{ x: number; y: number }>): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')
}

function segmentedLinePath(points: Array<{ x: number; value: number | null }>, scale: AxisScale): string {
  let drawing = false
  const segments: string[] = []
  for (const point of points) {
    if (point.value === null) {
      drawing = false
      continue
    }
    segments.push(`${drawing ? 'L' : 'M'}${point.x.toFixed(2)},${scale.y(point.value).toFixed(2)}`)
    drawing = true
  }
  return segments.join(' ')
}

function linePoints(values: number[], width: number, height: number, pad: number) {
  const scale = makeScale(values, pad, height - pad)
  const points = values.map((value, index) => ({
    x: pad + index / Math.max(1, values.length - 1) * (width - pad * 2),
    y: scale.y(value),
  }))
  return { path: linePath(points) }
}

function tooltipLeft(x: number): string {
  const percentage = x / WIDTH * 100
  return `${Math.max(13, Math.min(87, percentage)).toFixed(2)}%`
}

function formatPrice(value: number): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: Math.abs(value) < 10 ? 3 : 2,
    maximumFractionDigits: Math.abs(value) < 10 ? 3 : 2,
  })
}

function formatQuantity(value: number): string {
  const absolute = Math.abs(value)
  if (absolute >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`
  if (absolute >= 10_000) return `${(value / 10_000).toFixed(2)}万`
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
}

function formatMoney(value: number): string {
  const absolute = Math.abs(value)
  if (absolute >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`
  if (absolute >= 10_000) return `${(value / 10_000).toFixed(2)}万`
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

function formatTimeLabel(value: string): string {
  const match = /(\d{1,2}:\d{2})(?::\d{2})?$/.exec(value.trim())
  return match?.[1] ?? value
}

function formatDateLabel(value: string): string {
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value.trim())
  if (match === null) return value
  return `${match[2]?.padStart(2, '0')}-${match[3]?.padStart(2, '0')}`
}

function klineAccessibleText(bar: KLineBar): string {
  const amount = bar.amount !== null && Number.isFinite(bar.amount) ? `，成交额 ${formatMoney(bar.amount)}` : ''
  return `${bar.date}，开盘 ${formatPrice(bar.open)}，最高 ${formatPrice(bar.high)}，最低 ${formatPrice(bar.low)}，收盘 ${formatPrice(bar.close)}，成交量 ${formatQuantity(bar.volume)}${amount}`
}
