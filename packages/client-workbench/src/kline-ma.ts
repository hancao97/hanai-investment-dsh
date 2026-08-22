import type { KLineBar } from '../../contracts/src/index.ts'

export type KlineMaMode = 'short' | 'medium'
export type KlineMaPeriod = 5 | 10 | 20 | 60

export const KLINE_TURNING_STUDY_CUTOFF = '2026-08-20'

export interface KlineMaStudy {
  periods: readonly [KlineMaPeriod, KlineMaPeriod]
  averages: Record<number, Array<number | null>>
}

export type KlineTurningMarkerKind =
  | 'post-rise-huge-volume'
  | 'post-rise-huge-volume-weak'
  | 'deep-decline-huge-volume'
  | 'deep-decline-huge-volume-strong'
  | 'deep-decline-huge-volume-lower-shadow'
  | 'deep-decline-reclaim-ma5'

export interface KlineTurningEvidence {
  label: string
  outcome: '上涨' | '走弱' | '下跌'
  horizon: 10 | 20
  rate: number
  sampleSize: number
  averageReturnPct: number
  limited?: boolean
}

export interface KlineTurningMarker {
  index: number
  date: string
  kind: KlineTurningMarkerKind
  label: string
  glyph: '分' | '弱' | '深' | '强' | '影' | '稳'
  description: string
  tone: 'risk' | 'up'
  position: 'above' | 'below'
  volumeRatio: number
  priorRise20Pct: number | null
  drawdown60Pct: number | null
  shapes: string[]
  evidence: KlineTurningEvidence[]
}

export interface KlineTurningStudy {
  markers: KlineTurningMarker[]
  byIndex: KlineTurningMarker[][]
}

export interface KlineSnapshot {
  index: number
  bar: KLineBar
  changePct: number | null
  periods: readonly [KlineMaPeriod, KlineMaPeriod]
  averages: readonly [number | null, number | null]
  turningMarkers: KlineTurningMarker[]
}

export interface KlineSnapshotStudies {
  ma?: KlineMaStudy
  /** Pass null when the current surface does not expose daily research markers. */
  turning?: KlineTurningStudy | null
}

const MA_PERIODS: Record<KlineMaMode, readonly [KlineMaPeriod, KlineMaPeriod]> = {
  short: [5, 10],
  medium: [20, 60],
}

// The frozen studies started evaluating events after 121 completed bars so
// product markers stay inside the same seasoned-history domain.
const TURNING_STUDY_WARMUP_BARS = 121

const POST_RISE_EVIDENCE: KlineTurningEvidence = {
  label: '上涨后巨量',
  outcome: '走弱',
  horizon: 10,
  rate: 67.4,
  sampleSize: 356,
  averageReturnPct: -1.54,
}

const POST_RISE_WEAK_EVIDENCE: KlineTurningEvidence = {
  label: '巨量且弱收',
  outcome: '下跌',
  horizon: 10,
  rate: 64.9,
  sampleSize: 222,
  averageReturnPct: -1.32,
}

const DEEP_VOLUME_EVIDENCE: KlineTurningEvidence = {
  label: '深跌区巨量',
  outcome: '上涨',
  horizon: 20,
  rate: 64,
  sampleSize: 125,
  averageReturnPct: 5.13,
}

const DEEP_STRONG_EVIDENCE: KlineTurningEvidence = {
  label: '强收盘',
  outcome: '上涨',
  horizon: 20,
  rate: 68,
  sampleSize: 25,
  averageReturnPct: 8.73,
  limited: true,
}

const DEEP_LOWER_SHADOW_EVIDENCE: KlineTurningEvidence = {
  label: '长下影',
  outcome: '上涨',
  horizon: 20,
  rate: 66.7,
  sampleSize: 18,
  averageReturnPct: -0.03,
  limited: true,
}

const DEEP_RECLAIM_EVIDENCE: KlineTurningEvidence = {
  label: '深跌巨量后站回 MA5',
  outcome: '上涨',
  horizon: 10,
  rate: 63.1,
  sampleSize: 65,
  averageReturnPct: 2.77,
}

/** Builds close-price moving averages without deriving trading signals. */
export function buildKlineMaStudy(bars: KLineBar[], mode: KlineMaMode): KlineMaStudy {
  const periods = MA_PERIODS[mode]
  return {
    periods,
    averages: {
      [periods[0]]: movingAverage(bars.map(bar => bar.close), periods[0]),
      [periods[1]]: movingAverage(bars.map(bar => bar.close), periods[1]),
    },
  }
}

/**
 * Builds close-confirmed observation markers from the current K-line period.
 * These are historical-observation markers, not buy/sell instructions.
 */
export function buildKlineTurningStudy(bars: KLineBar[]): KlineTurningStudy {
  const byIndex = bars.map((): KlineTurningMarker[] => [])
  if (bars.length === 0) return { markers: [], byIndex }

  const closes = bars.map(bar => bar.close)
  const volumes = bars.map(bar => bar.volume)
  const ma5 = movingAverage(closes, 5)
  const ma10 = movingAverage(closes, 10)
  const ma20 = movingAverage(closes, 20)
  const vma20 = movingAverage(volumes, 20)
  const deepSetups = bars.map(() => false)
  const markers: KlineTurningMarker[] = []
  let lastPostRise = -100_000
  let lastDeep = -100_000
  let lastReclaim = -100_000

  const add = (marker: KlineTurningMarker) => {
    markers.push(marker)
    byIndex[marker.index]?.push(marker)
  }

  for (let index = TURNING_STUDY_WARMUP_BARS; index < bars.length; index += 1) {
    const bar = bars[index]
    const previous = bars[index - 1]
    const fast5 = ma5[index]
    const slow10 = ma10[index]
    const oldSlow10 = ma10[index - 3]
    const previousFast5 = ma5[index - 1]
    const average20 = ma20[index]
    const volumeAverage20 = vma20[index]
    if (bar === undefined || previous === undefined || fast5 == null || slow10 == null
      || oldSlow10 == null || previousFast5 == null || average20 == null
      || volumeAverage20 == null || volumeAverage20 <= 0) continue

    const volumeRatio = bar.volume / volumeAverage20
    const location = closeLocation(bar)
    const width = bar.high - bar.low
    const lowerShadowRatio = width > 0
      ? (Math.min(bar.open, bar.close) - bar.low) / width
      : 0
    const strongClose = bar.close > bar.open && location >= 0.70
    const weakClose = location <= 0.35
    const longLowerShadow = lowerShadowRatio >= 0.45 && location >= 0.55

    const riseBase = bars[index - 21]?.close
    const priorRise20 = riseBase !== undefined && riseBase > 0
      ? previous.close / riseBase - 1
      : null
    const postRiseHuge = fast5 > slow10
      && slow10 > oldSlow10
      && priorRise20 !== null
      && priorRise20 >= 0.15
      && previous.close > previousFast5
      && volumeRatio >= 2.50
    if (postRiseHuge && index - lastPostRise > 10) {
      add({
        index,
        date: bar.date,
        kind: 'post-rise-huge-volume',
        label: '巨量分歧',
        glyph: '分',
        description: `MA5 高于 MA10 且 MA10 向上，此前 20 周期上涨 ${formatRulePct(priorRise20 * 100)}，本周期量能为 VMA20 的 ${volumeRatio.toFixed(2)} 倍。`,
        tone: 'risk',
        position: 'above',
        volumeRatio,
        priorRise20Pct: priorRise20 * 100,
        drawdown60Pct: null,
        shapes: [],
        evidence: [POST_RISE_EVIDENCE],
      })
      if (weakClose) add({
        index,
        date: bar.date,
        kind: 'post-rise-huge-volume-weak',
        label: '巨量弱收',
        glyph: '弱',
        description: `同时命中巨量分歧，且收盘位置为本周期振幅的 ${Math.round(location * 100)}%（不高于 35%）。`,
        tone: 'risk',
        position: 'above',
        volumeRatio,
        priorRise20Pct: priorRise20 * 100,
        drawdown60Pct: null,
        shapes: [],
        evidence: [POST_RISE_WEAK_EVIDENCE],
      })
      lastPostRise = index
    }

    const priorHigh60 = Math.max(...bars.slice(index - 60, index).map(item => item.high))
    const drawdown60 = priorHigh60 > 0 ? bar.close / priorHigh60 - 1 : null
    const belowMa20Days = bars.slice(index - 20, index).reduce((count, item, offset) => {
      const value = ma20[index - 20 + offset]
      return count + (value != null && item.close < value ? 1 : 0)
    }, 0)
    const deepBase = drawdown60 !== null
      && drawdown60 <= -0.25
      && belowMa20Days >= 10
      && bar.close <= average20
    const deepHuge = deepBase && volumeRatio >= 2.50
    deepSetups[index] = deepHuge
    if (deepHuge && index - lastDeep > 20) {
      add({
        index,
        date: bar.date,
        kind: 'deep-decline-huge-volume',
        label: '深跌放量',
        glyph: '深',
        description: `收盘距此前 60 周期高点回撤 ${formatRulePct(drawdown60 * 100)}，此前 20 周期有 ${belowMa20Days} 期位于 MA20 下方，本周期量能为 VMA20 的 ${volumeRatio.toFixed(2)} 倍。`,
        tone: 'up',
        position: 'below',
        volumeRatio,
        priorRise20Pct: null,
        drawdown60Pct: drawdown60 * 100,
        shapes: [],
        evidence: [DEEP_VOLUME_EVIDENCE],
      })
      if (strongClose) add({
        index,
        date: bar.date,
        kind: 'deep-decline-huge-volume-strong',
        label: '深跌强收',
        glyph: '强',
        description: `同时命中深跌放量，且本周期收阳，收盘位置为本周期振幅的 ${Math.round(location * 100)}%（不低于 70%）。`,
        tone: 'up',
        position: 'below',
        volumeRatio,
        priorRise20Pct: null,
        drawdown60Pct: drawdown60 * 100,
        shapes: [],
        evidence: [DEEP_STRONG_EVIDENCE],
      })
      if (longLowerShadow) add({
        index,
        date: bar.date,
        kind: 'deep-decline-huge-volume-lower-shadow',
        label: '深跌长影',
        glyph: '影',
        description: `同时命中深跌放量，下影线占本周期振幅 ${Math.round(lowerShadowRatio * 100)}%（不低于 45%），且收盘位置不低于 55%。`,
        tone: 'up',
        position: 'below',
        volumeRatio,
        priorRise20Pct: null,
        drawdown60Pct: drawdown60 * 100,
        shapes: [],
        evidence: [DEEP_LOWER_SHADOW_EVIDENCE],
      })
      lastDeep = index
    }

    const recentDeepHuge = deepSetups.slice(Math.max(0, index - 5), index).some(Boolean)
    const reclaimMa5 = recentDeepHuge
      && previous.close <= previousFast5
      && bar.close > fast5
      && bar.close > bar.open
      && location >= 0.65
    if (reclaimMa5 && index - lastReclaim > 10) {
      add({
        index,
        date: bar.date,
        kind: 'deep-decline-reclaim-ma5',
        label: '放量回稳',
        glyph: '稳',
        description: `最近 5 周期内出现深跌放量；上一周期收盘不高于 MA5，本周期以阳线站回 MA5，收盘位置为本周期振幅的 ${Math.round(location * 100)}%。`,
        tone: 'up',
        position: 'below',
        volumeRatio,
        priorRise20Pct: null,
        drawdown60Pct: drawdown60 === null ? null : drawdown60 * 100,
        shapes: [],
        evidence: [DEEP_RECLAIM_EVIDENCE],
      })
      lastReclaim = index
    }
  }

  return { markers, byIndex }
}

/** Builds the fixed inspector payload for the hovered bar, falling back to the latest bar. */
export function buildKlineSnapshot(
  bars: KLineBar[],
  mode: KlineMaMode,
  requestedIndex?: number | null,
  studies?: KlineSnapshotStudies,
): KlineSnapshot | null {
  if (bars.length === 0) return null
  const index = requestedIndex !== null
    && requestedIndex !== undefined
    && Number.isInteger(requestedIndex)
    && requestedIndex >= 0
    && requestedIndex < bars.length
    ? requestedIndex
    : bars.length - 1
  const bar = bars[index]
  if (bar === undefined) return null
  const previousClose = index > 0 ? bars[index - 1]?.close ?? null : null
  const study = studies?.ma ?? buildKlineMaStudy(bars, mode)
  const turningStudy = studies?.turning === null
    ? null
    : studies?.turning ?? buildKlineTurningStudy(bars)
  const [fastPeriod, slowPeriod] = study.periods
  return {
    index,
    bar,
    changePct: previousClose === null || previousClose === 0
      ? null
      : (bar.close - previousClose) / previousClose * 100,
    periods: study.periods,
    averages: [
      study.averages[fastPeriod]?.[index] ?? null,
      study.averages[slowPeriod]?.[index] ?? null,
    ],
    turningMarkers: turningStudy?.byIndex[index] ?? [],
  }
}

function closeLocation(bar: KLineBar): number {
  const width = bar.high - bar.low
  return width > 0 ? (bar.close - bar.low) / width : 0.5
}

function formatRulePct(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`
}

export function movingAverage(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = Array.from({ length: values.length }, () => null)
  if (!Number.isInteger(period) || period <= 0) return result
  let sum = 0
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index] ?? 0
    if (index >= period) sum -= values[index - period] ?? 0
    if (index >= period - 1) result[index] = sum / period
  }
  return result
}
