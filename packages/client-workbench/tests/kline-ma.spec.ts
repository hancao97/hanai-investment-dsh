import { describe, expect, it } from 'vitest'
import type { KLineBar } from '../../contracts/src/index.ts'
import {
  buildKlineMaStudy,
  buildKlineSnapshot,
  buildKlineTurningStudy,
  klineTurningEvidence,
  movingAverage,
} from '../src/kline-ma.ts'

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

  it('builds fixed inspector data for the hovered bar and falls back to the latest bar', () => {
    const source = bars(Array.from({ length: 12 }, (_, index) => index + 1))
    const hovered = buildKlineSnapshot(source, 'short', 10)
    const latest = buildKlineSnapshot(source, 'short', 99)

    expect(hovered).toMatchObject({
      index: 10,
      bar: { date: '2026-01-11', close: 11 },
      changePct: 10,
      periods: [5, 10],
      averages: [9, 6.5],
    })
    expect(latest).toMatchObject({ index: 11, bar: { date: '2026-01-12' } })
    expect(buildKlineSnapshot([], 'short')).toBeNull()
  })

  it('marks a close-confirmed post-rise huge-volume weak close without future bars', () => {
    const source = Array.from({ length: 140 }, (_, index): KLineBar => {
      const close = 10 * 1.01 ** index
      return {
        date: `2026-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String(index % 28 + 1).padStart(2, '0')}`,
        open: index === 139 ? close * 1.01 : close * 0.995,
        close,
        high: index === 139 ? close * 1.02 : close * 1.01,
        low: close * 0.99,
        volume: index === 139 ? 1_000 : 100,
        amount: null,
      }
    })

    const study = buildKlineTurningStudy(source)
    expect(study.markers).toHaveLength(2)
    expect(study.markers[0]).toMatchObject({
      index: 139,
      kind: 'post-rise-huge-volume',
      label: '巨量分歧',
      glyph: '分',
      evidence: [{ rate: 67.4, sampleSize: 356 }],
    })
    expect(study.markers[1]).toMatchObject({
      index: 139,
      kind: 'post-rise-huge-volume-weak',
      label: '巨量弱收',
      glyph: '弱',
      priorRise20Pct: expect.any(Number),
      shapes: [],
      evidence: [{ rate: 65.8, sampleSize: 222 }],
    })
    const baseMarker = study.markers[0]
    expect(baseMarker).toBeDefined()
    if (baseMarker === undefined) throw new Error('missing base marker')
    expect(klineTurningEvidence(baseMarker, 'weekly')).toEqual([expect.objectContaining({
      horizon: 2,
      horizonUnit: '周',
      rate: 58.75,
      sampleSize: 160,
    })])
    expect(klineTurningEvidence(baseMarker, 'monthly')).toEqual([expect.objectContaining({
      horizon: 1,
      horizonUnit: '月',
      rate: 50.94,
      sampleSize: 53,
    })])
    expect(buildKlineTurningStudy(source.slice(0, -1)).markers).toHaveLength(0)
  })

  it('marks deep-decline huge volume, shape evidence and a later MA5 reclaim', () => {
    const source = Array.from({ length: 142 }, (_, index): KLineBar => {
      const baseline = 100 - index * 0.6
      const close = index === 140 ? 15 : index === 141 ? 20 : baseline
      return {
        date: `2026-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String(index % 28 + 1).padStart(2, '0')}`,
        open: index === 139 ? close - 0.6 : index === 141 ? 15.5 : close + 0.2,
        close,
        high: index === 139 ? close + 1.4 : index === 141 ? 20.5 : close + 0.8,
        low: index === 139 ? close - 4.6 : index === 141 ? 15 : close - 0.8,
        volume: index === 139 ? 1_000 : 100,
        amount: null,
      }
    })

    const study = buildKlineTurningStudy(source)
    expect(study.markers.map(marker => marker.kind)).toEqual([
      'deep-decline-huge-volume',
      'deep-decline-huge-volume-strong',
      'deep-decline-huge-volume-lower-shadow',
      'deep-decline-reclaim-ma5',
    ])
    expect(study.byIndex[139]?.[0]).toMatchObject({
      label: '深跌放量',
      glyph: '深',
      shapes: [],
      evidence: [{ rate: 64, sampleSize: 125 }],
    })
    expect(study.byIndex[139]?.[1]).toMatchObject({
      label: '深跌强收',
      glyph: '强',
      evidence: [{ rate: 68, sampleSize: 25, limited: true }],
    })
    expect(study.byIndex[139]?.[2]).toMatchObject({
      label: '深跌长影',
      glyph: '影',
      evidence: [{ rate: 66.7, sampleSize: 18, limited: true }],
    })
    expect(study.byIndex[141]?.[0]).toMatchObject({
      label: '放量回稳',
      evidence: [{ rate: 63.1, sampleSize: 65 }],
    })

    const legacyKinds = new Set([
      'post-rise-huge-volume',
      'post-rise-huge-volume-weak',
      'deep-decline-huge-volume',
      'deep-decline-huge-volume-strong',
      'deep-decline-huge-volume-lower-shadow',
      'deep-decline-reclaim-ma5',
    ])
    const oldMarkersInsideExpandedDaily = buildKlineTurningStudy(source, 'daily').markers
      .filter(marker => legacyKinds.has(marker.kind))
    expect(oldMarkersInsideExpandedDaily).toEqual(study.markers)
  })

  it('adds the daily low bullish outside observation without changing weekly markers', () => {
    const source = Array.from({ length: 140 }, (_, index): KLineBar => {
      const close = 100 - index * 0.5
      return {
        date: `2026-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String(index % 28 + 1).padStart(2, '0')}`,
        open: index === 139 ? 29.5 : close + 0.1,
        close: index === 139 ? 32 : close,
        high: index === 139 ? 33 : close + 0.6,
        low: index === 139 ? 29 : close - 0.6,
        volume: index === 139 ? 150 : 100,
        amount: null,
      }
    })

    const daily = buildKlineTurningStudy(source, 'daily')
    expect(daily.markers).toEqual([
      expect.objectContaining({
        index: 139,
        kind: 'low-bullish-outside',
        label: '低位破低反包',
        glyph: '包',
        evidence: [expect.objectContaining({
          rate: 65.60,
          sampleSize: 3_581,
          matchedDirectionRate: 65.75,
          matchedDirectionUpliftPp: 0.29,
        })],
      }),
    ])
    expect(buildKlineTurningStudy(source.slice(0, -1), 'daily').markers).toHaveLength(0)
    expect(buildKlineTurningStudy(source, 'weekly').markers).toHaveLength(0)
  })

  it('adds the daily high-volume upper-shadow risk observation', () => {
    const source = Array.from({ length: 140 }, (_, index): KLineBar => {
      const close = 10 * 1.01 ** index
      const previousClose = 10 * 1.01 ** (index - 1)
      return {
        date: `2026-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String(index % 28 + 1).padStart(2, '0')}`,
        open: index === 139 ? previousClose * 1.02 : close * 0.995,
        close: index === 139 ? previousClose * 1.01 : close,
        high: index === 139 ? previousClose * 1.16 : close * 1.005,
        low: index === 139 ? previousClose * 0.995 : close * 0.995,
        volume: index === 139 ? 300 : 100,
        amount: null,
      }
    })

    const marker = buildKlineTurningStudy(source, 'daily').markers
      .find(item => item.kind === 'huge-upper-rejection')
    expect(marker).toMatchObject({
      index: 139,
      label: '高位巨量长上影',
      glyph: '拒',
      tone: 'risk',
      evidence: [{
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
      }],
    })
  })

  it('marks hammer observation and price confirmation on their actual close dates', () => {
    const source = Array.from({ length: 138 }, (_, index): KLineBar => {
      const close = 100 - index * 0.45
      return {
        date: `2026-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String(index % 28 + 1).padStart(2, '0')}`,
        open: index === 136 ? 39 : index === 137 ? 39.6 : close + 0.1,
        close: index === 136 ? 39.5 : index === 137 ? 41 : close,
        high: index === 136 ? 40 : index === 137 ? 41.5 : close + 0.5,
        low: index === 136 ? 36 : index === 137 ? 39 : close - 0.5,
        volume: 100,
        amount: null,
      }
    })

    const markers = buildKlineTurningStudy(source, 'daily').markers.filter(marker => (
      marker.kind === 'hammer-spring-anchor' || marker.kind === 'hammer-spring-confirmed'
    ))
    expect(markers).toEqual([
      expect.objectContaining({
        index: 136,
        kind: 'hammer-spring-anchor',
        glyph: '针',
        tone: 'research',
        evidence: [expect.objectContaining({ rate: 50.85, sampleSize: 18_937 })],
      }),
      expect.objectContaining({
        index: 137,
        kind: 'hammer-spring-confirmed',
        glyph: '确',
        tone: 'research',
        description: expect.stringContaining('确认标在本日，不回填到锚点'),
        evidence: [expect.objectContaining({ rate: 51.81, sampleSize: 10_650 })],
      }),
    ])
    expect(buildKlineTurningStudy(source.slice(0, -1), 'daily').markers
      .filter(marker => marker.kind.startsWith('hammer-spring')))
      .toEqual([expect.objectContaining({ kind: 'hammer-spring-anchor', index: 136 })])
  })
})
