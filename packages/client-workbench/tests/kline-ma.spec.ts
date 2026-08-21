import { describe, expect, it } from 'vitest'
import type { KLineBar } from '../../contracts/src/index.ts'
import { buildKlineMaStudy, movingAverage } from '../src/kline-ma.ts'

function bars(closes: number[]): KLineBar[] {
  return closes.map((close, index) => ({
    date: `2026-01-${String(index + 1).padStart(2, '0')}`,
    open: close,
    close,
    high: close,
    low: close,
    volume: 100,
    amount: null,
  }))
}

describe('K-line moving averages', () => {
  it('calculates simple moving averages without reading future values', () => {
    expect(movingAverage([1, 2, 3, 4], 3)).toEqual([null, null, 2, 3])
    expect(movingAverage([1, 2], 0)).toEqual([null, null])
  })

  it('provides only the selected moving-average pair', () => {
    const source = bars(Array.from({ length: 60 }, (_, index) => index + 1))
    const short = buildKlineMaStudy(source, 'short')
    const medium = buildKlineMaStudy(source, 'medium')

    expect(short.periods).toEqual([5, 10])
    expect(short.averages[5]?.at(-1)).toBe(58)
    expect(short.averages[10]?.at(-1)).toBe(55.5)
    expect(medium.periods).toEqual([20, 60])
    expect(medium.averages[20]?.at(-1)).toBe(50.5)
    expect(medium.averages[60]?.at(-1)).toBe(30.5)
  })
})
