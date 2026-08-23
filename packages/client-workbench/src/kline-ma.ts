import type { KLineBar, KLinePeriod } from '../../contracts/src/index.ts'

export type KlineMaMode = 'short' | 'medium'
export type KlineMaPeriod = 5 | 10 | 20 | 60

export const KLINE_TURNING_STUDY_CUTOFF = '2026-08-20'

export interface KlineMaStudy {
  periods: readonly [KlineMaPeriod, KlineMaPeriod]
  averages: Record<number, Array<number | null>>
}

export type LegacyKlineTurningMarkerKind =
  | 'post-rise-huge-volume'
  | 'post-rise-huge-volume-weak'
  | 'deep-decline-huge-volume'
  | 'deep-decline-huge-volume-strong'
  | 'deep-decline-huge-volume-lower-shadow'
  | 'deep-decline-reclaim-ma5'

export type FullMarketKlineTurningMarkerKind =
  | 'low-bullish-outside'
  | 'hammer-spring-anchor'
  | 'hammer-spring-confirmed'
  | 'huge-upper-rejection'

export type KlineTurningMarkerKind =
  | LegacyKlineTurningMarkerKind
  | FullMarketKlineTurningMarkerKind

export interface KlineTurningEvidence {
  label: string
  outcome: '上涨' | '走弱' | '下跌'
  horizon: number
  horizonUnit: '交易日' | '周' | '月'
  rate: number
  sampleSize: number
  averageReturnPct: number
  limited?: boolean
  matchedDirectionRate?: number
  matchedDirectionUpliftPp?: number
  matchedConclusion?: string
}

export interface KlineTurningMarker {
  index: number
  date: string
  kind: KlineTurningMarkerKind
  label: string
  glyph: '分' | '弱' | '深' | '强' | '影' | '稳' | '包' | '针' | '确' | '拒'
  description: string
  tone: 'risk' | 'up' | 'research'
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
  /** Pass null when the current surface does not expose observation markers. */
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
  horizonUnit: '交易日',
  rate: 67.4,
  sampleSize: 356,
  averageReturnPct: -1.54,
}

const POST_RISE_WEAK_EVIDENCE: KlineTurningEvidence = {
  label: '巨量且弱收',
  outcome: '下跌',
  horizon: 10,
  horizonUnit: '交易日',
  rate: 65.8,
  sampleSize: 222,
  averageReturnPct: -1.32,
}

const DEEP_VOLUME_EVIDENCE: KlineTurningEvidence = {
  label: '深跌区巨量',
  outcome: '上涨',
  horizon: 20,
  horizonUnit: '交易日',
  rate: 64,
  sampleSize: 125,
  averageReturnPct: 5.13,
}

const DEEP_STRONG_EVIDENCE: KlineTurningEvidence = {
  label: '强收盘',
  outcome: '上涨',
  horizon: 20,
  horizonUnit: '交易日',
  rate: 68,
  sampleSize: 25,
  averageReturnPct: 8.73,
  limited: true,
}

const DEEP_LOWER_SHADOW_EVIDENCE: KlineTurningEvidence = {
  label: '长下影',
  outcome: '上涨',
  horizon: 20,
  horizonUnit: '交易日',
  rate: 66.7,
  sampleSize: 18,
  averageReturnPct: -0.03,
  limited: true,
}

const DEEP_RECLAIM_EVIDENCE: KlineTurningEvidence = {
  label: '深跌巨量后站回 MA5',
  outcome: '上涨',
  horizon: 10,
  horizonUnit: '交易日',
  rate: 63.1,
  sampleSize: 65,
  averageReturnPct: 2.77,
}

const LOW_BULLISH_OUTSIDE_EVIDENCE: KlineTurningEvidence = {
  label: '低位破低反包',
  outcome: '上涨',
  horizon: 20,
  horizonUnit: '交易日',
  rate: 65.60,
  sampleSize: 3_581,
  averageReturnPct: 7.12,
  matchedDirectionRate: 65.75,
  matchedDirectionUpliftPp: 0.29,
  matchedConclusion: '形态增量未证实',
}

const HAMMER_SPRING_ANCHOR_EVIDENCE: KlineTurningEvidence = {
  label: '金针探底观察',
  outcome: '上涨',
  horizon: 20,
  horizonUnit: '交易日',
  rate: 50.85,
  sampleSize: 18_937,
  averageReturnPct: 1.74,
  matchedDirectionRate: 50.34,
  matchedDirectionUpliftPp: 0.52,
  matchedConclusion: '方向接近均衡',
}

const HAMMER_SPRING_CONFIRMED_EVIDENCE: KlineTurningEvidence = {
  label: '金针突破确认',
  outcome: '上涨',
  horizon: 20,
  horizonUnit: '交易日',
  rate: 51.81,
  sampleSize: 10_650,
  averageReturnPct: 1.53,
  matchedDirectionRate: 50.80,
  matchedDirectionUpliftPp: 1.02,
  matchedConclusion: '仍未达到高胜率门槛',
}

const HUGE_UPPER_REJECTION_EVIDENCE: KlineTurningEvidence = {
  label: '高位巨量长上影',
  outcome: '下跌',
  horizon: 5,
  horizonUnit: '交易日',
  rate: 56.58,
  sampleSize: 5_721,
  averageReturnPct: -0.15,
  matchedDirectionRate: 55.46,
  matchedDirectionUpliftPp: 0.99,
  matchedConclusion: '风险观察，不是卖点',
}

const WEEKLY_EVIDENCE: Record<LegacyKlineTurningMarkerKind, KlineTurningEvidence> = {
  'post-rise-huge-volume': {
    label: '上涨后巨量', outcome: '走弱', horizon: 2, horizonUnit: '周',
    rate: 58.75, sampleSize: 160, averageReturnPct: -0.32,
  },
  'post-rise-huge-volume-weak': {
    label: '巨量且弱收', outcome: '上涨', horizon: 2, horizonUnit: '周',
    rate: 53, sampleSize: 100, averageReturnPct: 0.84,
  },
  'deep-decline-huge-volume': {
    label: '深跌区巨量', outcome: '走弱', horizon: 4, horizonUnit: '周',
    rate: 52.44, sampleSize: 82, averageReturnPct: -0.25,
  },
  'deep-decline-huge-volume-strong': {
    label: '强收盘', outcome: '上涨', horizon: 4, horizonUnit: '周',
    rate: 50, sampleSize: 28, averageReturnPct: -0.84, limited: true,
  },
  'deep-decline-huge-volume-lower-shadow': {
    label: '长下影', outcome: '走弱', horizon: 4, horizonUnit: '周',
    rate: 55.56, sampleSize: 9, averageReturnPct: -0.43, limited: true,
  },
  'deep-decline-reclaim-ma5': {
    label: '深跌巨量后站回 MA5', outcome: '走弱', horizon: 2, horizonUnit: '周',
    rate: 62.86, sampleSize: 35, averageReturnPct: 0.99,
  },
}

const MONTHLY_EVIDENCE: Record<LegacyKlineTurningMarkerKind, KlineTurningEvidence> = {
  'post-rise-huge-volume': {
    label: '上涨后巨量', outcome: '走弱', horizon: 1, horizonUnit: '月',
    rate: 50.94, sampleSize: 53, averageReturnPct: 1.76,
  },
  'post-rise-huge-volume-weak': {
    label: '巨量且弱收', outcome: '走弱', horizon: 1, horizonUnit: '月',
    rate: 55.88, sampleSize: 34, averageReturnPct: -0.30,
  },
  'deep-decline-huge-volume': {
    label: '深跌区巨量', outcome: '走弱', horizon: 2, horizonUnit: '月',
    rate: 56.25, sampleSize: 16, averageReturnPct: 0.08, limited: true,
  },
  'deep-decline-huge-volume-strong': {
    label: '强收盘', outcome: '上涨', horizon: 2, horizonUnit: '月',
    rate: 66.67, sampleSize: 3, averageReturnPct: 3.57, limited: true,
  },
  'deep-decline-huge-volume-lower-shadow': {
    label: '长下影', outcome: '走弱', horizon: 2, horizonUnit: '月',
    rate: 100, sampleSize: 1, averageReturnPct: -2.89, limited: true,
  },
  'deep-decline-reclaim-ma5': {
    label: '深跌巨量后站回 MA5', outcome: '走弱', horizon: 1, horizonUnit: '月',
    rate: 75, sampleSize: 8, averageReturnPct: -6.25, limited: true,
  },
}

/** Returns independently measured historical evidence for the active K-line period. */
export function klineTurningEvidence(
  marker: KlineTurningMarker,
  period: KLinePeriod,
): KlineTurningEvidence[] {
  if (period === 'daily') return marker.evidence
  if (!isLegacyTurningMarker(marker.kind)) return []
  return [period === 'weekly' ? WEEKLY_EVIDENCE[marker.kind] : MONTHLY_EVIDENCE[marker.kind]]
}

function isLegacyTurningMarker(kind: KlineTurningMarkerKind): kind is LegacyKlineTurningMarkerKind {
  return kind === 'post-rise-huge-volume'
    || kind === 'post-rise-huge-volume-weak'
    || kind === 'deep-decline-huge-volume'
    || kind === 'deep-decline-huge-volume-strong'
    || kind === 'deep-decline-huge-volume-lower-shadow'
    || kind === 'deep-decline-reclaim-ma5'
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
 * Builds every close-confirmed candidate before product display cooldowns.
 *
 * The full-market V0 additions have only been independently measured on daily
 * bars, so callers must explicitly pass `daily` to enable them. Omitting the
 * period preserves the frozen six-marker research surface used by older
 * scripts and artifacts.
 */
export function buildKlineTurningCandidates(
  bars: KLineBar[],
  period?: KLinePeriod,
): KlineTurningMarker[] {
  if (bars.length === 0) return []

  const closes = bars.map(bar => bar.close)
  const volumes = bars.map(bar => bar.volume)
  const ma5 = movingAverage(closes, 5)
  const ma10 = movingAverage(closes, 10)
  const ma20 = movingAverage(closes, 20)
  const vma20 = movingAverage(volumes, 20)
  const priorVma20 = priorMovingAverage(volumes, 20)
  const trueRanges = bars.map((bar, index) => {
    const previousClose = bars[index - 1]?.close ?? bar.close
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    )
  })
  const priorAtr20 = priorMovingAverage(trueRanges, 20)
  const deepSetups = bars.map(() => false)
  const markers: KlineTurningMarker[] = []
  const hammerAnchors: Array<{
    index: number
    atr: number
    volumeRatio: number
    drawdown60Pct: number
  }> = []
  const includeFullMarketDaily = period === 'daily'
  const add = (marker: KlineTurningMarker) => markers.push(marker)

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
    if (postRiseHuge) {
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
    if (deepHuge) {
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
    }

    const recentDeepHuge = deepSetups.slice(Math.max(0, index - 5), index).some(Boolean)
    const reclaimMa5 = recentDeepHuge
      && previous.close <= previousFast5
      && bar.close > fast5
      && bar.close > bar.open
      && location >= 0.65
    if (reclaimMa5) {
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
    }

    if (includeFullMarketDaily) {
      const priorVolumeAverage20 = priorVma20[index]
      const priorAtr = priorAtr20[index]
      const prior10Base = bars[index - 11]?.close
      if (priorVolumeAverage20 != null && priorVolumeAverage20 > 0
        && priorAtr != null && priorAtr > 0
        && prior10Base !== undefined && prior10Base > 0) {
        const causalVolumeRatio = bar.volume / priorVolumeAverage20
        const causalTrueRange = trueRanges[index] ?? 0
        const priorHigh20 = Math.max(...bars.slice(index - 20, index).map(item => item.high))
        const priorLow20 = Math.min(...bars.slice(index - 20, index).map(item => item.low))
        const priorDecline10 = previous.close / prior10Base - 1
        const belowMa20IncludingCurrent = bars
          .slice(index - 19, index + 1)
          .reduce((count, item, offset) => {
            const value = ma20[index - 19 + offset]
            return count + (value != null && item.close < value ? 1 : 0)
          }, 0)
        const bodyRatio = width > 0 ? Math.abs(bar.close - bar.open) / width : 0
        const upperShadowRatio = width > 0
          ? (bar.high - Math.max(bar.open, bar.close)) / width
          : 0

        const lowBullishOutside = drawdown60 !== null
          && drawdown60 <= -0.15
          && priorDecline10 <= -0.10
          && belowMa20IncludingCurrent >= 10
          && bar.low < previous.low
          && bar.high > previous.high
          && bar.close > previous.high
          && bar.close > bar.open
          && location >= 0.75
          && causalTrueRange >= 1.20 * priorAtr
          && causalVolumeRatio >= 1.20
        if (lowBullishOutside) {
          add({
            index,
            date: bar.date,
            kind: 'low-bullish-outside',
            label: '低位破低反包',
            glyph: '包',
            description: `此前 10 日下跌 ${formatRulePct(priorDecline10 * 100)}；本日先破前低、再越前高并收于前高之上，收盘位置 ${Math.round(location * 100)}%，量能为 prior VMA20 的 ${causalVolumeRatio.toFixed(2)} 倍。`,
            tone: 'up',
            position: 'below',
            volumeRatio: causalVolumeRatio,
            priorRise20Pct: null,
            drawdown60Pct: drawdown60 * 100,
            shapes: ['破前低', '反包前高', '收盘确认'],
            evidence: [LOW_BULLISH_OUTSIDE_EVIDENCE],
          })
        }

        const hammerSpring = drawdown60 !== null
          && drawdown60 <= -0.20
          && belowMa20IncludingCurrent >= 10
          && bar.low <= priorLow20
          && bar.close >= priorLow20
          && lowerShadowRatio >= 0.50
          && location >= 0.65
          && bodyRatio <= 0.35
          && causalTrueRange >= 0.80 * priorAtr
        if (hammerSpring) {
          add({
            index,
            date: bar.date,
            kind: 'hammer-spring-anchor',
            label: '金针探底观察',
            glyph: '针',
            description: `本日刺破此前 20 日低点后收回，下影占振幅 ${Math.round(lowerShadowRatio * 100)}%，收盘位置 ${Math.round(location * 100)}%；这里只是观察锚点，尚未形成高胜率买点。`,
            tone: 'research',
            position: 'below',
            volumeRatio: causalVolumeRatio,
            priorRise20Pct: null,
            drawdown60Pct: drawdown60 * 100,
            shapes: ['破 20 日低点', '收回', '长下影'],
            evidence: [HAMMER_SPRING_ANCHOR_EVIDENCE],
          })
          hammerAnchors.push({
            index,
            atr: priorAtr,
            volumeRatio: causalVolumeRatio,
            drawdown60Pct: drawdown60 * 100,
          })
        }

        const hugeUpperRejection = priorRise20 !== null
          && priorRise20 >= 0.15
          && fast5 > slow10
          && slow10 > oldSlow10
          && previous.close > previousFast5
          && bar.high >= priorHigh20
          && causalVolumeRatio >= 2.50
          && upperShadowRatio >= 0.55
          && location <= 0.35
          && causalTrueRange >= priorAtr
        if (hugeUpperRejection) {
          add({
            index,
            date: bar.date,
            kind: 'huge-upper-rejection',
            label: '高位巨量长上影',
            glyph: '拒',
            description: `此前 20 日上涨 ${formatRulePct(priorRise20 * 100)}，本日创新高但长上影占振幅 ${Math.round(upperShadowRatio * 100)}%，收盘位置仅 ${Math.round(location * 100)}%，量能为 prior VMA20 的 ${causalVolumeRatio.toFixed(2)} 倍。`,
            tone: 'risk',
            position: 'above',
            volumeRatio: causalVolumeRatio,
            priorRise20Pct: priorRise20 * 100,
            drawdown60Pct: null,
            shapes: ['创新高', '巨量', '长上影'],
            evidence: [HUGE_UPPER_REJECTION_EVIDENCE],
          })
        }
      }
    }
  }

  if (includeFullMarketDaily) {
    for (const anchor of hammerAnchors) {
      const anchorBar = bars[anchor.index]
      if (anchorBar === undefined) continue
      const invalidation = anchorBar.low - 0.25 * anchor.atr
      for (let confirmIndex = anchor.index + 1;
        confirmIndex < Math.min(anchor.index + 4, bars.length);
        confirmIndex += 1) {
        const confirmBar = bars[confirmIndex]
        if (confirmBar === undefined) continue
        if (confirmBar.low < invalidation) break
        const confirmLocation = closeLocation(confirmBar)
        const confirmMa5 = ma5[confirmIndex]
        if (confirmMa5 != null
          && confirmBar.close > anchorBar.high
          && confirmBar.close > confirmMa5
          && confirmLocation >= 0.55) {
          add({
            index: confirmIndex,
            date: confirmBar.date,
            kind: 'hammer-spring-confirmed',
            label: '金针突破确认',
            glyph: '确',
            description: `金针锚点 ${anchorBar.date} 后首次收盘越过锚点高点并站上 MA5；确认标在本日，不回填到锚点。历史方向仍接近均衡。`,
            tone: 'research',
            position: 'below',
            volumeRatio: anchor.volumeRatio,
            priorRise20Pct: null,
            drawdown60Pct: anchor.drawdown60Pct,
            shapes: ['越过锚点高', '站上 MA5', '确认日'],
            evidence: [HAMMER_SPRING_CONFIRMED_EVIDENCE],
          })
          break
        }
      }
    }
  }

  return markers.sort((left, right) => left.index - right.index)
}

/**
 * Builds close-confirmed observation markers from the current K-line period.
 * These are historical-observation markers, not buy/sell instructions.
 */
export function buildKlineTurningStudy(
  bars: KLineBar[],
  period?: KLinePeriod,
): KlineTurningStudy {
  const byIndex = bars.map((): KlineTurningMarker[] => [])
  const candidates = buildKlineTurningCandidates(bars, period)
  const markers: KlineTurningMarker[] = []
  let lastPostRise = -100_000
  let lastDeep = -100_000
  let lastReclaim = -100_000
  let lastLowOutside = -100_000
  let lastHammerAnchor = -100_000
  let lastHammerConfirmed = -100_000
  let lastHugeUpperRejection = -100_000
  const selectedPostRise = new Set<number>()
  const selectedDeep = new Set<number>()

  const add = (marker: KlineTurningMarker) => {
    markers.push(marker)
    byIndex[marker.index]?.push(marker)
  }
  for (const marker of candidates) {
    if (marker.kind === 'post-rise-huge-volume') {
      if (marker.index - lastPostRise <= 10) continue
      add(marker)
      selectedPostRise.add(marker.index)
      lastPostRise = marker.index
      continue
    }
    if (marker.kind === 'post-rise-huge-volume-weak') {
      if (selectedPostRise.has(marker.index)) add(marker)
      continue
    }
    if (marker.kind === 'deep-decline-huge-volume') {
      if (marker.index - lastDeep <= 20) continue
      add(marker)
      selectedDeep.add(marker.index)
      lastDeep = marker.index
      continue
    }
    if (marker.kind === 'deep-decline-huge-volume-strong'
      || marker.kind === 'deep-decline-huge-volume-lower-shadow') {
      if (selectedDeep.has(marker.index)) add(marker)
      continue
    }
    if (marker.kind === 'deep-decline-reclaim-ma5') {
      if (marker.index - lastReclaim <= 10) continue
      add(marker)
      lastReclaim = marker.index
      continue
    }
    if (marker.kind === 'low-bullish-outside') {
      if (marker.index - lastLowOutside < 20) continue
      add(marker)
      lastLowOutside = marker.index
      continue
    }
    if (marker.kind === 'hammer-spring-anchor') {
      if (marker.index - lastHammerAnchor < 20) continue
      add(marker)
      lastHammerAnchor = marker.index
      continue
    }
    if (marker.kind === 'hammer-spring-confirmed') {
      if (marker.index - lastHammerConfirmed < 20) continue
      add(marker)
      lastHammerConfirmed = marker.index
      continue
    }
    if (marker.kind === 'huge-upper-rejection') {
      if (marker.index - lastHugeUpperRejection < 10) continue
      add(marker)
      lastHugeUpperRejection = marker.index
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

function priorMovingAverage(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = Array.from({ length: values.length }, () => null)
  if (!Number.isInteger(period) || period <= 0) return result
  let sum = 0
  for (let index = 0; index < values.length; index += 1) {
    if (index >= period) result[index] = sum / period
    sum += values[index] ?? 0
    if (index >= period) sum -= values[index - period] ?? 0
  }
  return result
}
