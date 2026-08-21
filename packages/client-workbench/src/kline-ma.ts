import type { KLineBar } from '../../contracts/src/index.ts'

export type KlineMaMode = 'short' | 'medium'
export type KlineMaPeriod = 5 | 10 | 20 | 60

export interface KlineMaStudy {
  periods: readonly [KlineMaPeriod, KlineMaPeriod]
  averages: Record<number, Array<number | null>>
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
