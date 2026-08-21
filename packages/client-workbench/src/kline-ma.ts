import type { KLineBar } from '../../contracts/src/index.ts'

export type KlineMaMode = 'short' | 'medium'
export type KlineMaPeriod = 5 | 10 | 20 | 60

export interface KlineMaStudy {
  periods: readonly [KlineMaPeriod, KlineMaPeriod]
  averages: Record<number, Array<number | null>>
}

export interface KlineSnapshot {
  index: number
  bar: KLineBar
  changePct: number | null
  periods: readonly [KlineMaPeriod, KlineMaPeriod]
  averages: readonly [number | null, number | null]
}

const MA_PERIODS: Record<KlineMaMode, readonly [KlineMaPeriod, KlineMaPeriod]> = {
  short: [5, 10],
  medium: [20, 60],
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

/** Builds the fixed inspector payload for the hovered bar, falling back to the latest bar. */
export function buildKlineSnapshot(
  bars: KLineBar[],
  mode: KlineMaMode,
  requestedIndex?: number | null,
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
  const study = buildKlineMaStudy(bars, mode)
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
  }
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
