#!/usr/bin/env tsx

/**
 * Reproducible daily/weekly/monthly outcome study for the product's frozen
 * K-line observation markers. The script consumes the audited BaoStock daily
 * cache and calls the same marker implementation used by the client.
 *
 * Historical conditional frequencies are descriptive observations, not
 * predictions, trading signals, or return guarantees.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { KLineBar } from '../../packages/contracts/src/index.ts'
import {
  KLINE_TURNING_STUDY_CUTOFF,
  buildKlineTurningCandidates,
  type KlineTurningMarkerKind,
} from '../../packages/client-workbench/src/kline-ma.ts'

type StudyPeriod = 'daily' | 'weekly' | 'monthly'
type SourceSegmentKey =
  | 'development'
  | 'validation'
  | 'recent_point_in_time'
  | 'adverse_confirmation'
type SegmentKey = SourceSegmentKey | 'product_evidence'

interface Baseline {
  metadata: {
    requested_start: string
    requested_end: string
    provider: string
    adjustment: string
  }
  cohorts: Record<string, { symbols: string[] }>
  universe: Record<string, {
    rows: number
    first_date: string
    last_date: string
    sha256: string
  }>
}

interface DailyBar extends KLineBar {
  code: string
}

interface Observation {
  symbol: string
  date: string
  rawReturn: number
}

const PERIODS: StudyPeriod[] = ['daily', 'weekly', 'monthly']
const KINDS: KlineTurningMarkerKind[] = [
  'post-rise-huge-volume',
  'post-rise-huge-volume-weak',
  'deep-decline-huge-volume',
  'deep-decline-huge-volume-strong',
  'deep-decline-huge-volume-lower-shadow',
  'deep-decline-reclaim-ma5',
]

const KIND_LABELS: Record<KlineTurningMarkerKind, string> = {
  'post-rise-huge-volume': '巨量分歧',
  'post-rise-huge-volume-weak': '巨量弱收',
  'deep-decline-huge-volume': '深跌放量',
  'deep-decline-huge-volume-strong': '深跌强收',
  'deep-decline-huge-volume-lower-shadow': '深跌长影',
  'deep-decline-reclaim-ma5': '放量回稳',
}

const BASE_DAILY_HORIZON: Record<KlineTurningMarkerKind, 10 | 20> = {
  'post-rise-huge-volume': 10,
  'post-rise-huge-volume-weak': 10,
  'deep-decline-huge-volume': 20,
  'deep-decline-huge-volume-strong': 20,
  'deep-decline-huge-volume-lower-shadow': 20,
  'deep-decline-reclaim-ma5': 10,
}

const PERIOD_HORIZONS: Record<StudyPeriod, Record<10 | 20, number>> = {
  daily: { 10: 10, 20: 20 },
  weekly: { 10: 2, 20: 4 },
  monthly: { 10: 1, 20: 2 },
}

const PERIOD_UNIT: Record<StudyPeriod, string> = {
  daily: '交易日',
  weekly: '周',
  monthly: '月',
}

const SOURCE_SEGMENTS: SourceSegmentKey[] = [
  'development',
  'validation',
  'recent_point_in_time',
  'adverse_confirmation',
]

const PRODUCT_SEGMENTS: Record<KlineTurningMarkerKind, SourceSegmentKey[]> = {
  'post-rise-huge-volume': ['recent_point_in_time', 'adverse_confirmation'],
  'post-rise-huge-volume-weak': ['recent_point_in_time', 'adverse_confirmation'],
  'deep-decline-huge-volume': SOURCE_SEGMENTS,
  'deep-decline-huge-volume-strong': SOURCE_SEGMENTS,
  'deep-decline-huge-volume-lower-shadow': SOURCE_SEGMENTS,
  'deep-decline-reclaim-ma5': SOURCE_SEGMENTS,
}

function parseArgs(): { baseline: string; cacheDir: string; output: string } {
  const values = new Map<string, string>()
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index]
    const value = process.argv[index + 1]
    if (key === undefined || value === undefined || !key.startsWith('--')) {
      throw new Error('Usage: --baseline <path> --cache-dir <path> --output <path>')
    }
    values.set(key.slice(2), value)
  }
  return {
    baseline: resolve(values.get('baseline') ?? 'docs/research-data/kline-signal-backtest-2026-08-21.json'),
    cacheDir: resolve(values.get('cache-dir') ?? '/tmp/hanai-kline-backtest-cache'),
    output: resolve(required(values, 'output')),
  }
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key)
  if (value === undefined || value === '') throw new Error(`Missing --${key}`)
  return value
}

function loadDailyBars(path: string): DailyBar[] {
  const rows = JSON.parse(readFileSync(path, 'utf8')) as string[][]
  return rows.flatMap((row): DailyBar[] => {
    if (row.length !== 12) return []
    const [date, code, open, high, low, close, preclose, volume, amount] = row
    const numbers = [open, high, low, close, preclose, volume].map(value => value === undefined || value === '' ? Number.NaN : Number(value))
    if (date === undefined || code === undefined || numbers.some(value => !Number.isFinite(value))) return []
    const [openValue, highValue, lowValue, closeValue, precloseValue, volumeValue] = numbers as [number, number, number, number, number, number]
    if (Math.min(openValue, highValue, lowValue, closeValue, precloseValue) <= 0) return []
    const amountValue = amount === undefined || amount === '' ? null : Number(amount)
    return [{
      date,
      code,
      open: openValue,
      high: highValue,
      low: lowValue,
      close: closeValue,
      volume: volumeValue,
      amount: amountValue !== null && Number.isFinite(amountValue) ? amountValue : null,
    }]
  })
}

function barManifest(bars: DailyBar[]): { rows: number; first_date: string | null; last_date: string | null; sha256: string } {
  const digest = createHash('sha256')
  for (const bar of bars) {
    digest.update(`${bar.date}|${bar.open.toFixed(8)}|${bar.high.toFixed(8)}|${bar.low.toFixed(8)}|${bar.close.toFixed(8)}|${bar.volume.toFixed(4)}\n`)
  }
  return {
    rows: bars.length,
    first_date: bars[0]?.date ?? null,
    last_date: bars.at(-1)?.date ?? null,
    sha256: digest.digest('hex'),
  }
}

function cachePath(cacheDir: string, symbol: string, baseline: Baseline): string {
  const safe = symbol.replaceAll('.', '-')
  return resolve(cacheDir, `${safe}-${baseline.metadata.requested_start}-${baseline.metadata.requested_end}-qfq.json`)
}

function isoWeekKey(value: string): string {
  const date = new Date(`${value}T00:00:00Z`)
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const isoYear = date.getUTCFullYear()
  const yearStart = new Date(Date.UTC(isoYear, 0, 1))
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${isoYear}-W${String(week).padStart(2, '0')}`
}

function aggregateBars(bars: DailyBar[], period: StudyPeriod): KLineBar[] {
  if (period === 'daily') return bars
  const groups = new Map<string, DailyBar[]>()
  for (const bar of bars) {
    const key = period === 'weekly' ? isoWeekKey(bar.date) : bar.date.slice(0, 7)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [bar])
    else group.push(bar)
  }
  return [...groups.values()].map(group => {
    const first = group[0]
    const last = group.at(-1)
    if (first === undefined || last === undefined) throw new Error('Unexpected empty aggregate group')
    const amounts = group.map(item => item.amount).filter((value): value is number => value !== null)
    return {
      date: last.date,
      open: first.open,
      high: Math.max(...group.map(item => item.high)),
      low: Math.min(...group.map(item => item.low)),
      close: last.close,
      volume: group.reduce((sum, item) => sum + item.volume, 0),
      amount: amounts.length === 0 ? null : amounts.reduce((sum, value) => sum + value, 0),
    }
  })
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = values.toSorted((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? null
}

function wilsonInterval(successes: number, total: number): [number, number] | null {
  if (total === 0) return null
  const z = 1.959963984540054
  const proportion = successes / total
  const denominator = 1 + z ** 2 / total
  const center = (proportion + z ** 2 / (2 * total)) / denominator
  const margin = z * Math.sqrt(proportion * (1 - proportion) / total + z ** 2 / (4 * total ** 2)) / denominator
  return [center - margin, center + margin]
}

function summarize(observations: Observation[], period: StudyPeriod, horizon: number) {
  const returns = observations.map(item => item.rawReturn)
  const up = returns.filter(value => value > 0).length
  const interval = wilsonInterval(up, returns.length)
  return {
    horizon,
    horizon_unit: PERIOD_UNIT[period],
    events: returns.length,
    symbols: new Set(observations.map(item => item.symbol)).size,
    positive_terminal_rate: returns.length === 0 ? null : up / returns.length,
    weak_terminal_rate: returns.length === 0 ? null : 1 - up / returns.length,
    positive_rate_wilson_95: interval,
    mean_terminal_return: returns.length === 0 ? null : returns.reduce((sum, value) => sum + value, 0) / returns.length,
    median_terminal_return: median(returns),
  }
}

function percent(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10_000) / 100
}

function compactSummary(summary: ReturnType<typeof summarize>) {
  return {
    horizon: summary.horizon,
    horizon_unit: summary.horizon_unit,
    events: summary.events,
    symbols: summary.symbols,
    up_rate_pct: percent(summary.positive_terminal_rate),
    weak_rate_pct: percent(summary.weak_terminal_rate),
    up_rate_wilson_95_pct: summary.positive_rate_wilson_95?.map(value => percent(value)) ?? null,
    mean_return_pct: percent(summary.mean_terminal_return),
    median_return_pct: percent(summary.median_terminal_return),
  }
}

function sourceSegmentsFor(
  symbol: string,
  date: string,
  cohorts: Record<string, Set<string>>,
  adverse: Set<string>,
): SourceSegmentKey[] {
  const year = Number(date.slice(0, 4))
  const result: SourceSegmentKey[] = []
  if (year >= 2015 && year <= 2020 && cohorts['2015']?.has(symbol)) result.push('development')
  if (year >= 2021 && year <= 2023 && cohorts['2021']?.has(symbol)) result.push('validation')
  if (year >= 2024 && year <= 2026 && cohorts[String(year)]?.has(symbol)) result.push('recent_point_in_time')
  if (year >= 2024 && year <= 2026 && adverse.has(symbol)) result.push('adverse_confirmation')
  return result
}

function main(): void {
  const args = parseArgs()
  const baseline = JSON.parse(readFileSync(args.baseline, 'utf8')) as Baseline
  if (baseline.metadata.requested_end !== KLINE_TURNING_STUDY_CUTOFF) {
    throw new Error(`Product cutoff ${KLINE_TURNING_STUDY_CUTOFF} does not match baseline ${baseline.metadata.requested_end}`)
  }

  const cohorts = Object.fromEntries(Object.entries(baseline.cohorts).map(([year, value]) => [year, new Set(value.symbols)]))
  const recentUnion = new Set(['2024', '2025', '2026'].flatMap(year => [...(cohorts[year] ?? [])]))
  const earlyUnion = new Set(['2015', '2021', '2022', '2023'].flatMap(year => [...(cohorts[year] ?? [])]))
  const adverse = new Set([...earlyUnion].filter(symbol => !recentUnion.has(symbol)))
  const barsBySymbol = new Map<string, DailyBar[]>()
  const mismatches: string[] = []

  for (const [symbol, expected] of Object.entries(baseline.universe).sort(([left], [right]) => left.localeCompare(right))) {
    const bars = loadDailyBars(cachePath(args.cacheDir, symbol, baseline))
    const actual = barManifest(bars)
    if (actual.rows !== expected.rows || actual.first_date !== expected.first_date
      || actual.last_date !== expected.last_date || actual.sha256 !== expected.sha256) {
      mismatches.push(symbol)
      continue
    }
    barsBySymbol.set(symbol, bars)
  }
  if (mismatches.length > 0) throw new Error(`Source manifest mismatch: ${mismatches.slice(0, 5).join(', ')}`)

  const study: Record<string, unknown> = {}
  for (const period of PERIODS) {
    const segmentObservations = Object.fromEntries(KINDS.map(kind => [
      kind,
      {
        development: [] as Observation[],
        validation: [] as Observation[],
        recent_point_in_time: [] as Observation[],
        adverse_confirmation: [] as Observation[],
        product_evidence: [] as Observation[],
      } satisfies Record<SegmentKey, Observation[]>,
    ])) as Record<KlineTurningMarkerKind, Record<SegmentKey, Observation[]>>
    const lastKept = Object.fromEntries(KINDS.map(kind => [
      kind,
      Object.fromEntries(SOURCE_SEGMENTS.map(segment => [segment, new Map<string, number>()])),
    ])) as Record<KlineTurningMarkerKind, Record<SourceSegmentKey, Map<string, number>>>

    for (const [symbol, dailyBars] of barsBySymbol) {
      const bars = aggregateBars(dailyBars, period)
      const markers = buildKlineTurningCandidates(bars)
      for (const marker of markers) {
        if (marker.date > baseline.metadata.requested_end) continue
        const horizon = PERIOD_HORIZONS[period][BASE_DAILY_HORIZON[marker.kind]]
        const entry = bars[marker.index + 1]?.open
        const target = bars[marker.index + horizon]?.close
        if (entry === undefined || target === undefined || entry <= 0) continue
        const observation = { symbol, date: marker.date, rawReturn: target / entry - 1 }
        for (const segment of sourceSegmentsFor(symbol, marker.date, cohorts, adverse)) {
          const previousIndex = lastKept[marker.kind][segment].get(symbol) ?? -100_000
          if (marker.index - previousIndex <= BASE_DAILY_HORIZON[marker.kind]) continue
          segmentObservations[marker.kind][segment].push(observation)
          lastKept[marker.kind][segment].set(symbol, marker.index)
        }
      }
    }

    for (const kind of KINDS) {
      const rows = segmentObservations[kind]
      for (const segment of PRODUCT_SEGMENTS[kind]) rows.product_evidence.push(...rows[segment])
    }

    study[period] = {
      label: period === 'daily' ? '日 K' : period === 'weekly' ? '周 K' : '月 K',
      aggregation: period === 'daily' ? 'source daily bars' : `${period} OHLCV aggregated from source daily bars`,
      events: Object.fromEntries(KINDS.map(kind => {
        const horizon = PERIOD_HORIZONS[period][BASE_DAILY_HORIZON[kind]]
        return [kind, {
          label: KIND_LABELS[kind],
          segments: Object.fromEntries(([...SOURCE_SEGMENTS, 'product_evidence'] as SegmentKey[]).map(segment => [
            segment,
            compactSummary(summarize(segmentObservations[kind][segment], period, horizon)),
          ])),
        }]
      })),
    }
  }

  const scriptPath = fileURLToPath(import.meta.url)
  const result = {
    metadata: {
      generated_at: new Date().toISOString(),
      purpose: 'period-specific historical outcome frequencies for frozen K-line observation markers',
      provider: baseline.metadata.provider,
      adjustment: baseline.metadata.adjustment,
      source_frequency: 'daily',
      requested_start: baseline.metadata.requested_start,
      requested_end: baseline.metadata.requested_end,
      outcome_clock: 'signal confirmed at period close; outcome starts at next period open and ends at the close of the configured future period',
      period_horizon_mapping: {
        daily: '10/20 trading days',
        weekly: '2/4 weeks (approximately 10/20 trading days)',
        monthly: '1/2 months (nearest completed-bar approximation to 10/20 trading days)',
      },
      population: 'post-rise markers use the disjoint 2024-2026 annual point-in-time and adverse cohorts; deep-decline markers additionally include the fixed 2015 development and 2021 validation cohorts',
      event_deduplication: 'each marker condition is independently deduplicated per symbol and source segment; 10-period cooldown for post-rise/reclaim markers and 20-period cooldown for deep-decline markers',
      product_rule_source: 'packages/client-workbench/src/kline-ma.ts',
      script_sha256: createHash('sha256').update(readFileSync(scriptPath)).digest('hex'),
      baseline_sha256: createHash('sha256').update(readFileSync(args.baseline)).digest('hex'),
      limitations: [
        'Weekly and monthly bars are aggregated from front-adjusted daily OHLCV and may differ slightly from a vendor native period series.',
        'Monthly samples are structurally smaller because the product requires 121 completed bars before showing markers.',
        'The daily row is a reproducibility cross-check; existing product daily evidence remains tied to its previously frozen studies.',
        'Historical conditional frequencies are descriptive and cannot guarantee future direction or magnitude.',
      ],
    },
    source_validation: {
      symbols: barsBySymbol.size,
      rows: [...barsBySymbol.values()].reduce((sum, bars) => sum + bars.length, 0),
      manifest_mismatches: mismatches,
    },
    study,
  }

  mkdirSync(dirname(args.output), { recursive: true })
  writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`)
  console.log(`wrote ${args.output}`)
}

main()
