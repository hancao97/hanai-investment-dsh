#!/usr/bin/env tsx

/**
 * Current-listed full-universe audit for every production K-line turning marker.
 *
 * The signal dates come from the exact client implementation. Daily, weekly,
 * and monthly bars are evaluated independently. Buy-side outcomes use the
 * next tradable open and a fixed round-trip friction model; risk markers remain
 * long-only risk observations and are never represented as short-sale returns.
 *
 * This study complements the frozen historical-universe artifact. Its cache is
 * current-listed only, so it is explicitly survivorship-biased and must not be
 * substituted for a point-in-time historical security master.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { KLineBar, KLinePeriod } from '../../packages/contracts/src/index.ts'
import {
  KLINE_TURNING_STUDY_CUTOFF,
  buildKlineTurningStudy,
  type KlineTurningMarkerKind,
} from '../../packages/client-workbench/src/kline-ma.ts'

type StudyPeriod = Extract<KLinePeriod, 'daily' | 'weekly' | 'monthly'>
type Side = 'buy' | 'risk'

interface SecurityRow {
  canonical: string
  code: string
  exchange: 'SH' | 'SZ' | 'BJ'
  board: 'SH_MAIN' | 'SZ_MAIN' | 'STAR' | 'CHINEXT' | 'BSE'
  name: string
}

interface UniverseFile {
  requested_start: string
  requested_end: string
  scope: string
  survivorship_warning: string
  security_master_total?: number
  exchange_filter?: string | null
  diagnostic_subset?: boolean
  securities: SecurityRow[]
}

interface DownloadManifest {
  universe?: number
  requested_start?: string
  requested_end?: string
  security_master_total?: number
  diagnostic_subset?: boolean
  results?: Array<{ symbol?: string; status?: string; rows?: number; error?: string }>
}

interface CachePayload {
  provider?: string
  fqt?: string | number
  factor_dates?: number
  klines?: unknown[]
}

interface SignalRule {
  label: string
  side: Side
  dailyHorizon: 5 | 10 | 20
  periods: StudyPeriod[]
}

interface EventRow {
  signal: KlineTurningMarkerKind
  label: string
  period: StudyPeriod
  side: Side
  symbol: string
  board: SecurityRow['board']
  signalDate: string
  entryDate: string
  exitDate: string
  horizon: number
  rawReturn: number
  netReturn: number
  signedReturn: number
  directionHit: boolean
  tradableEntry: boolean
  lockedLimitDownAtPlannedExit: boolean | null
  priorAmount20Median: number | null
  liquidityEligible: boolean
  contextKey: string | null
  coarseContextKey: string | null
  entryGap: number
  benchmarkRegime: 'uptrend' | 'downtrend' | 'neutral' | null
  benchmarkReturn20: number | null
}

interface BenchmarkState {
  regime: 'uptrend' | 'downtrend' | 'neutral'
  return20: number
}

interface Aggregate {
  count: number
  hits: number
  signed: number
}

interface ClusterResult {
  mean: number
  standard_error: number
  ci95: [number, number]
  one_sided_p_positive: number
  null_mean: number
  stock_clusters: number
  month_clusters: number
  stock_month_cells: number
  method: string
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_CACHE = '/tmp/hanai-current-production-turning-cache-v1'
const DEFAULT_OUTPUT = resolve(ROOT, 'docs/research-data/production-turning-point-full-backtest-2026-08-23.json')
const DEFAULT_LEDGER = resolve(ROOT, 'docs/research-data/production-turning-point-events-2026-08-23.jsonl.gz')

const PERIODS: StudyPeriod[] = ['daily', 'weekly', 'monthly']
const BUY_COMMISSION = 0.0003
const SELL_COMMISSION = 0.0003
const TRANSFER_FEE = 0.00001
const CURRENT_SELL_STAMP_DUTY = 0.0005
const HISTORICAL_SELL_STAMP_DUTY = 0.001
const SLIPPAGE = 0.001
const BUY_COST = BUY_COMMISSION + TRANSFER_FEE
const PRIMARY_LIQUIDITY = 30_000_000

const SIGNAL_RULES: Record<KlineTurningMarkerKind, SignalRule> = {
  'post-rise-huge-volume': {
    label: '巨量分歧', side: 'risk', dailyHorizon: 10, periods: PERIODS,
  },
  'post-rise-huge-volume-weak': {
    label: '巨量弱收', side: 'risk', dailyHorizon: 10, periods: PERIODS,
  },
  'deep-decline-huge-volume': {
    label: '深跌放量', side: 'buy', dailyHorizon: 20, periods: PERIODS,
  },
  'deep-decline-huge-volume-strong': {
    label: '深跌强收', side: 'buy', dailyHorizon: 20, periods: PERIODS,
  },
  'deep-decline-huge-volume-lower-shadow': {
    label: '深跌长影', side: 'buy', dailyHorizon: 20, periods: PERIODS,
  },
  'deep-decline-reclaim-ma5': {
    label: '放量回稳', side: 'buy', dailyHorizon: 10, periods: PERIODS,
  },
  'low-bullish-outside': {
    label: '低位破低反包', side: 'buy', dailyHorizon: 20, periods: ['daily'],
  },
  'hammer-spring-anchor': {
    label: '金针探底观察', side: 'buy', dailyHorizon: 20, periods: ['daily'],
  },
  'hammer-spring-confirmed': {
    label: '金针突破确认', side: 'buy', dailyHorizon: 20, periods: ['daily'],
  },
  'huge-upper-rejection': {
    label: '高位巨量长上影', side: 'risk', dailyHorizon: 5, periods: ['daily'],
  },
}

const PERIOD_HORIZONS: Record<StudyPeriod, Record<5 | 10 | 20, number>> = {
  daily: { 5: 5, 10: 10, 20: 20 },
  weekly: { 5: 1, 10: 2, 20: 4 },
  monthly: { 5: 1, 10: 1, 20: 2 },
}

function parseArgs(): {
  cacheDir: string
  output: string
  ledger: string
  maxSymbols: number | null
} {
  const values = new Map<string, string>()
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index]
    const value = process.argv[index + 1]
    if (key === undefined || value === undefined || !key.startsWith('--')) {
      throw new Error('Usage: [--cache-dir path] [--output path] [--ledger path] [--max-symbols n]')
    }
    values.set(key.slice(2), value)
  }
  const rawMax = values.get('max-symbols')
  const maxSymbols = rawMax === undefined ? null : Number(rawMax)
  if (maxSymbols !== null && (!Number.isInteger(maxSymbols) || maxSymbols <= 0)) {
    throw new Error('--max-symbols must be a positive integer')
  }
  return {
    cacheDir: resolve(values.get('cache-dir') ?? DEFAULT_CACHE),
    output: resolve(values.get('output') ?? DEFAULT_OUTPUT),
    ledger: resolve(values.get('ledger') ?? DEFAULT_LEDGER),
    maxSymbols,
  }
}

function cachePath(cacheDir: string, security: SecurityRow): string {
  return resolve(cacheDir, 'bars', `${security.canonical.replace('.', '-')}.json.gz`)
}

function nativeMonthCachePath(cacheDir: string, security: SecurityRow): string {
  return resolve(cacheDir, 'native-month', 'bars', `${security.canonical.replace('.', '-')}.json.gz`)
}

function loadDailyBars(path: string): KLineBar[] {
  const payload = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as CachePayload
  const bars: KLineBar[] = []
  for (const raw of payload.klines ?? []) {
    if (typeof raw !== 'string') continue
    const parts = raw.split(',')
    if (parts.length < 7) continue
    const [date] = parts
    const [open, close, high, low, volume, amount] = parts.slice(1, 7).map(Number)
    if (date === undefined || [open, close, high, low, volume, amount].some(value => !Number.isFinite(value))) continue
    if (Math.min(open ?? 0, close ?? 0, high ?? 0, low ?? 0, volume ?? 0, amount ?? 0) <= 0) continue
    if ((high ?? 0) < Math.max(open ?? 0, close ?? 0, low ?? 0)) continue
    if ((low ?? 0) > Math.min(open ?? 0, close ?? 0, high ?? 0)) continue
    bars.push({
      date,
      open: open as number,
      close: close as number,
      high: high as number,
      low: low as number,
      volume: volume as number,
      amount: amount as number,
    })
  }
  return bars.toSorted((left, right) => left.date.localeCompare(right.date))
}

function loadCacheMetadata(path: string): { provider: string; fqt: string; factorDates: number | null } {
  const payload = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as CachePayload
  return {
    provider: typeof payload.provider === 'string' ? payload.provider : 'unknown',
    fqt: typeof payload.fqt === 'string' || typeof payload.fqt === 'number' ? String(payload.fqt) : 'unknown',
    factorDates: typeof payload.factor_dates === 'number' ? payload.factor_dates : null,
  }
}

function loadBenchmarkStates(cacheDir: string, cutoff: string): {
  path: string
  states: Map<string, BenchmarkState>
} {
  const path = resolve(cacheDir, 'bars', 'sh-000300.json.gz')
  const states = new Map<string, BenchmarkState>()
  if (!existsSync(path)) return { path, states }
  const bars = loadDailyBars(path).filter(bar => bar.date <= cutoff)
  const ma20 = bars.map((_, index) => index < 19
    ? null
    : mean(bars.slice(index - 19, index + 1).map(item => item.close)))
  for (let index = 22; index < bars.length; index += 1) {
    const bar = bars[index]
    const current = ma20[index]
    const prior = ma20[index - 3]
    const base = bars[index - 20]?.close
    if (bar === undefined || current === null || current === undefined
      || prior === null || prior === undefined || base === undefined || base <= 0) continue
    const regime = bar.close > current && current > prior
      ? 'uptrend'
      : bar.close < current && current < prior ? 'downtrend' : 'neutral'
    states.set(bar.date, { regime, return20: bar.close / base - 1 })
  }
  return { path, states }
}

function isoWeekKey(value: string): string {
  const date = new Date(`${value}T00:00:00Z`)
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const year = date.getUTCFullYear()
  const start = new Date(Date.UTC(year, 0, 1))
  const week = Math.ceil(((date.getTime() - start.getTime()) / 86_400_000 + 1) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

function periodKey(date: string, period: StudyPeriod): string {
  if (period === 'daily') return date
  return period === 'weekly' ? isoWeekKey(date) : date.slice(0, 7)
}

function aggregateBars(dailyBars: KLineBar[], period: StudyPeriod, cutoff: string): KLineBar[] {
  if (period === 'daily') return dailyBars
  const groups = new Map<string, KLineBar[]>()
  for (const bar of dailyBars) {
    const key = periodKey(bar.date, period)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [bar])
    else group.push(bar)
  }
  // The frozen cutoff is Thursday 2026-08-20, so the active week/month is not
  // a completed historical period and must not be used as an exit observation.
  groups.delete(periodKey(cutoff, period))
  return [...groups.values()].map(group => {
    const first = group[0]
    const last = group.at(-1)
    if (first === undefined || last === undefined) throw new Error('empty aggregate group')
    const amounts = group.map(item => item.amount).filter((value): value is number => value !== null)
    return {
      date: last.date,
      open: first.open,
      close: last.close,
      high: Math.max(...group.map(item => item.high)),
      low: Math.min(...group.map(item => item.low)),
      volume: group.reduce((sum, item) => sum + item.volume, 0),
      // Keep the liquidity threshold comparable across periods: this field is
      // the mean daily amount within the week/month, not the period total.
      amount: amounts.length === 0 ? null : amounts.reduce((sum, value) => sum + value, 0) / amounts.length,
    }
  })
}

function nativeMonthlyBars(
  cacheDir: string, security: SecurityRow, dailyBars: KLineBar[], cutoff: string,
): KLineBar[] | null {
  const path = nativeMonthCachePath(cacheDir, security)
  if (!existsSync(path)) return null
  const native = loadDailyBars(path).filter(
    bar => bar.date <= cutoff && periodKey(bar.date, 'monthly') !== periodKey(cutoff, 'monthly'),
  )
  const dailyMonthly = aggregateBars(dailyBars, 'monthly', cutoff)
  const dailyAmount = new Map(dailyMonthly.map(bar => [periodKey(bar.date, 'monthly'), bar.amount]))
  return native.map(bar => ({
    ...bar,
    // Native monthly amount is only a proxy. Prefer the mean daily raw-price
    // amount from the daily cache wherever its shorter history overlaps.
    amount: dailyAmount.get(periodKey(bar.date, 'monthly')) ?? null,
  }))
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = values.toSorted((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? null
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null
  const sorted = values.toSorted((left, right) => left - right)
  const index = (sorted.length - 1) * quantile
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower] ?? null
  const weight = index - lower
  return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight
}

function priorAmountMedians(bars: KLineBar[]): Array<number | null> {
  return bars.map((_, index) => {
    if (index < 20) return null
    const values = bars.slice(index - 20, index)
      .map(item => item.amount)
      .filter((value): value is number => value !== null && Number.isFinite(value) && value > 0)
    return values.length === 20 ? median(values) : null
  })
}

function priorHigh60Series(bars: KLineBar[]): Array<number | null> {
  const result: Array<number | null> = Array.from({ length: bars.length }, () => null)
  const deque: number[] = []
  let head = 0
  for (let index = 0; index < bars.length; index += 1) {
    const entering = index - 1
    if (entering >= 0) {
      while (deque.length > head && bars[deque.at(-1) ?? 0]!.high <= bars[entering]!.high) deque.pop()
      deque.push(entering)
    }
    const minimum = index - 60
    while (deque.length > head && (deque[head] ?? Infinity) < minimum) head += 1
    if (index >= 60 && deque.length > head) result[index] = bars[deque[head] ?? 0]!.high
    if (head > 256 && head * 2 > deque.length) {
      deque.splice(0, head)
      head = 0
    }
  }
  return result
}

function priorReturn20(bars: KLineBar[], index: number): number | null {
  const base = bars[index - 21]?.close
  const previous = bars[index - 1]?.close
  return base === undefined || previous === undefined || base <= 0 ? null : previous / base - 1
}

function boardGroup(board: SecurityRow['board']): string {
  if (board === 'STAR' || board === 'CHINEXT') return 'GROWTH_20PCT'
  if (board === 'BSE') return 'BSE_30PCT'
  return 'MAIN_10PCT'
}

function contextKeys(
  bars: KLineBar[], index: number, side: Side, board: SecurityRow['board'], liquidity: number,
  high60: number | null,
): { exact: string; coarse: string } | null {
  const ret20 = priorReturn20(bars, index)
  if (high60 === null || ret20 === null || high60 <= 0) return null
  const dd60 = bars[index]!.close / high60 - 1
  const location = side === 'buy'
    ? dd60 <= -0.35 ? 'dd35' : dd60 <= -0.25 ? 'dd25' : dd60 <= -0.15 ? 'dd15' : 'dd0'
    : ret20 >= 0.25 ? 'up25' : ret20 >= 0.15 ? 'up15' : ret20 >= 0.10 ? 'up10' : 'up0'
  const liquidityTier = liquidity >= 100_000_000 ? 'liq100' : liquidity >= 50_000_000 ? 'liq50' : 'liq30'
  const coarse = `${side}|${location}|${boardGroup(board)}`
  return { exact: `${coarse}|${liquidityTier}`, coarse }
}

function limitRatio(board: SecurityRow['board'], date: string): number {
  if (board === 'BSE') return 0.30
  if (board === 'STAR') return 0.20
  if (board === 'CHINEXT' && date >= '2020-08-24') return 0.20
  return 0.10
}

function onePriceLimitUp(bars: KLineBar[], index: number, board: SecurityRow['board']): boolean {
  const signal = bars[index]
  const entry = bars[index + 1]
  if (signal === undefined || entry === undefined) return true
  const limit = signal.close * (1 + limitRatio(board, entry.date))
  const tolerance = Math.max(0.01, signal.close * 0.0008)
  return entry.low >= limit - tolerance
}

function onePriceLimitDown(bars: KLineBar[], index: number, board: SecurityRow['board']): boolean {
  const prior = bars[index - 1]
  const bar = bars[index]
  if (prior === undefined || bar === undefined) return false
  const limit = prior.close * (1 - limitRatio(board, bar.date))
  const tolerance = Math.max(0.01, prior.close * 0.0008)
  return bar.high <= limit + tolerance
}

function stampDuty(exitDate: string): number {
  return exitDate < '2023-08-28' ? HISTORICAL_SELL_STAMP_DUTY : CURRENT_SELL_STAMP_DUTY
}

function outcome(bars: KLineBar[], index: number, horizon: number): {
  raw: number
  net: number
  gap: number
} | null {
  const signal = bars[index]
  const entry = bars[index + 1]
  const exit = bars[index + horizon]
  if (signal === undefined || entry === undefined || exit === undefined || entry.open <= 0) return null
  const raw = exit.close / entry.open - 1
  const entryEffective = entry.open * (1 + SLIPPAGE) * (1 + BUY_COST)
  const sellCost = SELL_COMMISSION + TRANSFER_FEE + stampDuty(exit.date)
  const exitEffective = exit.close * (1 - SLIPPAGE) * (1 - sellCost)
  return { raw, net: exitEffective / entryEffective - 1, gap: entry.open / signal.close - 1 }
}

function addAggregate(map: Map<string, Aggregate>, key: string, hit: boolean, signed: number): void {
  const current = map.get(key) ?? { count: 0, hits: 0, signed: 0 }
  current.count += 1
  current.hits += Number(hit)
  current.signed += signed
  map.set(key, current)
}

function wilsonInterval(successes: number, total: number): [number, number] | null {
  if (total <= 0) return null
  const z = 1.959963984540054
  const rate = successes / total
  const denominator = 1 + z * z / total
  const center = (rate + z * z / (2 * total)) / denominator
  const radius = z * Math.sqrt(rate * (1 - rate) / total + z * z / (4 * total * total)) / denominator
  return [Math.max(0, center - radius), Math.min(1, center + radius)]
}

function erf(value: number): number {
  const sign = value < 0 ? -1 : 1
  const x = Math.abs(value)
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911
  const t = 1 / (1 + p * x)
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)
  return sign * y
}

function oneSidedPositiveP(meanValue: number, standardError: number): number {
  if (standardError === 0) return meanValue > 0 ? 0 : 1
  const z = meanValue / standardError
  return 0.5 * (1 - erf(z / Math.SQRT2))
}

function groupedSums(values: number[], labels: string[], centeredMean: number): number[] {
  const grouped = new Map<string, number>()
  for (let index = 0; index < values.length; index += 1) {
    const label = labels[index]
    if (label === undefined) continue
    grouped.set(label, (grouped.get(label) ?? 0) + (values[index] ?? 0) - centeredMean)
  }
  return [...grouped.values()]
}

function twoWayCluster(
  values: number[], symbols: string[], months: string[], nullMean = 0,
): ClusterResult | null {
  if (values.length < 2) return null
  const average = mean(values) ?? 0
  const stockSums = groupedSums(values, symbols, average)
  const monthSums = groupedSums(values, months, average)
  const cells = symbols.map((symbol, index) => `${symbol}|${months[index] ?? ''}`)
  const cellSums = groupedSums(values, cells, average)
  const component = (rows: number[]): number => {
    if (rows.length <= 1) return 0
    return rows.length / (rows.length - 1) * rows.reduce((sum, value) => sum + value * value, 0)
  }
  const variance = (
    component(stockSums) + component(monthSums) - component(cellSums)
  ) / (values.length * values.length)
  // The inclusion-exclusion estimator can be negative in sparse finite
  // samples. Treat it as non-estimable; clipping to zero would fabricate a
  // zero standard error and p=0.
  if (!Number.isFinite(variance) || variance <= 0) return null
  const standardError = Math.sqrt(variance)
  return {
    mean: average,
    standard_error: standardError,
    ci95: [average - 1.959963984540054 * standardError, average + 1.959963984540054 * standardError],
    one_sided_p_positive: oneSidedPositiveP(average - nullMean, standardError),
    null_mean: nullMean,
    stock_clusters: stockSums.length,
    month_clusters: monthSums.length,
    stock_month_cells: cellSums.length,
    method: 'two-way cluster-robust normal interval (stock and signal month)',
  }
}

function controlFor(
  event: EventRow,
  exactControls: Map<string, Aggregate>,
  coarseControls: Map<string, Aggregate>,
  exactSignalContributions: Map<string, Aggregate>,
  coarseSignalContributions: Map<string, Aggregate>,
): Aggregate | null {
  if (event.contextKey === null || event.coarseContextKey === null) return null
  const adjusted = (control: Aggregate | undefined, contribution: Aggregate | undefined): Aggregate | null => {
    if (control === undefined) return null
    const result = {
      count: control.count - (contribution?.count ?? 0),
      hits: control.hits - (contribution?.hits ?? 0),
      signed: control.signed - (contribution?.signed ?? 0),
    }
    return result.count >= 20 ? result : null
  }
  const exactKey = `${event.period}|${event.signalDate}|${event.horizon}|${event.contextKey}`
  const exact = adjusted(
    exactControls.get(exactKey),
    exactSignalContributions.get(`${event.signal}|${exactKey}`),
  )
  if (exact !== null) return exact
  const coarseKey = `${event.period}|${event.signalDate}|${event.horizon}|${event.coarseContextKey}`
  return adjusted(
    coarseControls.get(coarseKey),
    coarseSignalContributions.get(`${event.signal}|${coarseKey}`),
  )
}

function compactBasic(events: EventRow[]): Record<string, unknown> {
  if (events.length === 0) {
    return { events: 0, direction_rate: null, mean_signed_return: null }
  }
  const hits = events.map(event => Number(event.directionHit))
  const signed = events.map(event => event.signedReturn)
  const positive = signed.filter(value => value > 0)
  const negative = signed.filter(value => value <= 0)
  const profitFactor = negative.length > 0 && (mean(negative) ?? 0) < 0
    ? positive.reduce((sum, value) => sum + value, 0) / Math.abs(negative.reduce((sum, value) => sum + value, 0))
    : null
  return {
    events: events.length,
    symbols: new Set(events.map(event => event.symbol)).size,
    months: new Set(events.map(event => event.signalDate.slice(0, 7))).size,
    first_signal: events.map(event => event.signalDate).toSorted()[0] ?? null,
    last_signal: events.map(event => event.signalDate).toSorted().at(-1) ?? null,
    direction_hits: hits.reduce((sum, value) => sum + value, 0),
    direction_rate: mean(hits),
    direction_rate_wilson_95ci: wilsonInterval(hits.reduce((sum, value) => sum + value, 0), events.length),
    mean_signed_return: mean(signed),
    median_signed_return: median(signed),
    signed_return_p05: percentile(signed, 0.05),
    signed_return_p95: percentile(signed, 0.95),
    mean_raw_underlying_return: mean(events.map(event => event.rawReturn)),
    profit_factor_signed: profitFactor,
    average_win_loss_payoff_ratio: positive.length > 0 && negative.length > 0
      ? (mean(positive) ?? 0) / Math.abs(mean(negative) ?? 0)
      : null,
    break_even_hit_rate_from_average_payoff: positive.length > 0 && negative.length > 0
      ? Math.abs(mean(negative) ?? 0) / ((mean(positive) ?? 0) + Math.abs(mean(negative) ?? 0))
      : null,
    mean_signed_return_without_best_5pct: mean(signed.toSorted((left, right) => left - right).slice(0, Math.max(1, Math.floor(signed.length * 0.95)))),
    raw_direction_two_way_cluster: twoWayCluster(
      hits,
      events.map(event => event.symbol),
      events.map(event => event.signalDate.slice(0, 7)),
      0.5,
    ),
    raw_signed_return_two_way_cluster: twoWayCluster(
      signed,
      events.map(event => event.symbol),
      events.map(event => event.signalDate.slice(0, 7)),
    ),
    median_next_open_gap: median(events.map(event => event.entryGap)),
    mean_next_open_gap: mean(events.map(event => event.entryGap)),
    planned_exit_locked_limit_down_events: events.filter(event => event.lockedLimitDownAtPlannedExit === true).length,
    planned_exit_lock_observable_events: events.filter(event => event.lockedLimitDownAtPlannedExit !== null).length,
  }
}

function summarize(
  events: EventRow[], exactControls: Map<string, Aggregate>, coarseControls: Map<string, Aggregate>,
  exactSignalContributions: Map<string, Aggregate>, coarseSignalContributions: Map<string, Aggregate>,
): Record<string, unknown> {
  const basic = compactBasic(events)
  if (events.length === 0) return { ...basic, matched_events: 0 }
  const matchedDirection: number[] = []
  const matchedExcess: number[] = []
  const expectedRates: number[] = []
  const expectedSigned: number[] = []
  const symbols: string[] = []
  const months: string[] = []
  const poolSizes: number[] = []
  for (const event of events) {
    const control = controlFor(
      event, exactControls, coarseControls, exactSignalContributions, coarseSignalContributions,
    )
    if (control === null) continue
    const expectedRate = control.hits / control.count
    const expectedReturn = control.signed / control.count
    matchedDirection.push(Number(event.directionHit) - expectedRate)
    matchedExcess.push(event.signedReturn - expectedReturn)
    expectedRates.push(expectedRate)
    expectedSigned.push(expectedReturn)
    symbols.push(event.symbol)
    months.push(event.signalDate.slice(0, 7))
    poolSizes.push(control.count)
  }
  return {
    ...basic,
    matched_events: matchedDirection.length,
    matched_coverage: matchedDirection.length / events.length,
    matched_median_control_pool: median(poolSizes),
    matched_expected_direction_rate: mean(expectedRates),
    matched_direction_uplift: mean(matchedDirection),
    matched_direction_uplift_two_way_cluster: twoWayCluster(matchedDirection, symbols, months),
    matched_expected_signed_return: mean(expectedSigned),
    matched_mean_signed_excess: mean(matchedExcess),
    matched_signed_excess_two_way_cluster: twoWayCluster(matchedExcess, symbols, months),
  }
}

function hashFold(symbol: string): 'development' | 'validation' | 'test' {
  const bucket = Number.parseInt(createHash('sha256').update(symbol).digest('hex').slice(0, 8), 16) % 10
  return bucket <= 4 ? 'development' : bucket <= 7 ? 'validation' : 'test'
}

function diagnostics(events: EventRow[]): Record<string, unknown> {
  const group = (
    selector: (event: EventRow) => string,
    eligible: (event: EventRow, key: string) => boolean = () => true,
  ): Record<string, unknown> => {
    const rows = new Map<string, EventRow[]>()
    for (const event of events) {
      const key = selector(event)
      if (!eligible(event, key)) continue
      rows.set(key, [...(rows.get(key) ?? []), event])
    }
    return Object.fromEntries([...rows.entries()].toSorted(([left], [right]) => left.localeCompare(right)).map(
      ([key, values]) => [key, compactBasic(values)],
    ))
  }
  return {
    folds: group(event => hashFold(event.symbol)),
    years_purged_at_boundaries: group(
      event => event.signalDate.slice(0, 4),
      (event, year) => event.exitDate <= `${year}-12-31`,
    ),
    eras_purged_at_boundaries: group(event => {
      const year = Number(event.signalDate.slice(0, 4))
      return year <= 2020 ? 'through_2020' : year <= 2023 ? '2021_2023' : '2024_2026'
    }, (event, era) => {
      if (era === 'through_2020') return event.exitDate <= '2020-12-31'
      if (era === '2021_2023') return event.signalDate >= '2021-01-01' && event.exitDate <= '2023-12-31'
      return event.signalDate >= '2024-01-01' && event.exitDate <= '2026-12-31'
    }),
    boards: group(event => event.board),
    benchmark_regimes: group(event => event.benchmarkRegime ?? 'unavailable'),
  }
}

function eligiblePrimary(event: EventRow): boolean {
  return event.liquidityEligible && (event.side === 'risk' || event.tradableEntry)
}

function percentNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10_000) / 100 : null
}

function auditRow(
  signal: KlineTurningMarkerKind,
  period: StudyPeriod,
  events: EventRow[],
  exactControls: Map<string, Aggregate>,
  coarseControls: Map<string, Aggregate>,
  exactSignalContributions: Map<string, Aggregate>,
  coarseSignalContributions: Map<string, Aggregate>,
): Record<string, unknown> {
  const definition = SIGNAL_RULES[signal]
  const selected = events.filter(event => event.signal === signal && event.period === period)
  const primary = selected.filter(eligiblePrimary)
  return {
    definition: {
      key: signal,
      label: definition.label,
      side: definition.side,
      period,
      horizon: PERIOD_HORIZONS[period][definition.dailyHorizon],
      horizon_unit: period === 'daily' ? '交易日' : period === 'weekly' ? '周' : '月',
      signal_source: 'packages/client-workbench/src/kline-ma.ts',
    },
    display_universe: summarize(
      selected, exactControls, coarseControls, exactSignalContributions, coarseSignalContributions,
    ),
    liquid_tradable_primary: summarize(
      primary, exactControls, coarseControls, exactSignalContributions, coarseSignalContributions,
    ),
    primary_diagnostics: diagnostics(primary),
  }
}

function holmAdjusted(rows: Array<{ key: string; p: number }>): Record<string, number> {
  const sorted = rows.toSorted((left, right) => left.p - right.p)
  const adjusted: Record<string, number> = {}
  let running = 0
  for (let index = 0; index < sorted.length; index += 1) {
    const row = sorted[index]
    if (row === undefined) continue
    running = Math.max(running, Math.min(1, row.p * (sorted.length - index)))
    adjusted[row.key] = running
  }
  return adjusted
}

function overlapReport(events: EventRow[]): Record<string, unknown> {
  const primary = events.filter(eligiblePrimary)
  const groups = new Map<string, Set<string>>()
  const signalCounts = new Map<string, number>()
  for (const event of primary) {
    const signalKey = `${event.period}|${event.signal}`
    signalCounts.set(signalKey, (signalCounts.get(signalKey) ?? 0) + 1)
    const groupKey = `${event.period}|${event.symbol}|${event.signalDate}`
    const set = groups.get(groupKey) ?? new Set<string>()
    set.add(signalKey)
    groups.set(groupKey, set)
  }
  const pairs = new Map<string, number>()
  for (const values of groups.values()) {
    const keys = [...values].toSorted()
    for (let left = 0; left < keys.length; left += 1) {
      for (let right = left + 1; right < keys.length; right += 1) {
        const first = keys[left]
        const second = keys[right]
        if (first === undefined || second === undefined) continue
        const key = `${first} + ${second}`
        pairs.set(key, (pairs.get(key) ?? 0) + 1)
      }
    }
  }
  const pairRows = [...pairs.entries()].map(([pair, count]) => {
    const [left, right] = pair.split(' + ')
    const leftCount = left === undefined ? 0 : signalCounts.get(left) ?? 0
    const rightCount = right === undefined ? 0 : signalCounts.get(right) ?? 0
    return {
      pair,
      same_bar_events: count,
      share_of_smaller_signal: Math.min(leftCount, rightCount) > 0
        ? count / Math.min(leftCount, rightCount)
        : null,
      jaccard: leftCount + rightCount - count > 0 ? count / (leftCount + rightCount - count) : null,
    }
  }).toSorted((left, right) => right.same_bar_events - left.same_bar_events)
  return {
    primary_marker_rows: primary.length,
    unique_symbol_period_dates: groups.size,
    multi_marker_symbol_period_dates: [...groups.values()].filter(set => set.size > 1).length,
    maximum_markers_on_one_bar: Math.max(0, ...[...groups.values()].map(set => set.size)),
    top_same_bar_pairs: pairRows.slice(0, 30),
    interpretation: 'Nested and same-bar markers are correlated evidence and must not be counted or multiplied as independent probabilities.',
  }
}

function nestedRecord(root: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = root
  for (const part of path) {
    if (current === null || typeof current !== 'object') return null
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function rateFromDiagnostic(row: Record<string, unknown>, fold: string): number | null {
  const value = nestedRecord(row, ['primary_diagnostics', 'folds', fold, 'direction_rate'])
  return typeof value === 'number' ? value : null
}

function releaseGate(
  row: Record<string, unknown>, holmP: number | null,
  evidenceComplete: boolean, diagnosticSubset: boolean,
): Record<string, unknown> {
  const primary = row.liquid_tradable_primary as Record<string, unknown>
  const directionCluster = primary.raw_direction_two_way_cluster as ClusterResult | null
  const upliftCluster = primary.matched_direction_uplift_two_way_cluster as ClusterResult | null
  const excessCluster = primary.matched_signed_excess_two_way_cluster as ClusterResult | null
  const yearRows = nestedRecord(row, ['primary_diagnostics', 'years_purged_at_boundaries']) as Record<string, Record<string, unknown>> | null
  const stableYears = yearRows === null ? 0 : Object.values(yearRows).filter(year => {
    const events = year.events
    const rate = year.direction_rate
    return typeof events === 'number' && events >= 20 && typeof rate === 'number' && rate >= 0.55
  }).length
  const checks = {
    non_diagnostic_full_universe_run: !diagnosticSubset,
    source_manifest_complete_for_period: evidenceComplete,
    at_least_200_events: typeof primary.events === 'number' && primary.events >= 200,
    matched_coverage_at_least_80pct: typeof primary.matched_coverage === 'number'
      && primary.matched_coverage >= 0.80,
    at_least_50_stock_and_24_month_clusters: (upliftCluster?.stock_clusters ?? 0) >= 50
      && (upliftCluster?.month_clusters ?? 0) >= 24,
    historical_direction_rate_at_least_60pct: typeof primary.direction_rate === 'number' && primary.direction_rate >= 0.60,
    two_way_cluster_direction_ci_lower_above_50pct: (directionCluster?.ci95[0] ?? -1) > 0.50,
    matched_direction_uplift_ci_lower_above_zero: (upliftCluster?.ci95[0] ?? -1) > 0,
    matched_signed_excess_ci_lower_above_zero: (excessCluster?.ci95[0] ?? -1) > 0,
    holm_familywise_p_below_5pct: holmP !== null && holmP < 0.05,
    mean_after_removing_best_5pct_positive: typeof primary.mean_signed_return_without_best_5pct === 'number'
      && primary.mean_signed_return_without_best_5pct > 0,
    at_least_three_stable_years: stableYears >= 3,
    cross_section_validation_partition_at_least_55pct: (rateFromDiagnostic(row, 'validation') ?? -1) >= 0.55,
    cross_section_test_partition_at_least_55pct: (rateFromDiagnostic(row, 'test') ?? -1) >= 0.55,
  }
  return {
    stable_years: stableYears,
    holm_adjusted_p: holmP,
    checks,
    passed_except_run_integrity: Object.entries(checks)
      .filter(([key]) => key !== 'non_diagnostic_full_universe_run' && key !== 'source_manifest_complete_for_period')
      .every(([, value]) => value),
    passed: Object.values(checks).every(Boolean),
    interpretation: Object.values(checks).every(Boolean)
      ? 'eligible for prospective product review; not a return guarantee'
      : 'research/observation only; one or more fixed audit gates failed',
  }
}

function readSha256(path: string): string | null {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null
}

function manifestAudit(
  manifest: DownloadManifest | null, securities: SecurityRow[], expectedEnd: string,
): Record<string, unknown> & { complete: boolean } {
  const results = manifest?.results ?? []
  const requestedSymbols = securities.map(item => item.canonical).toSorted()
  const resultSymbols = results.map(item => item.symbol ?? '').toSorted()
  const symbolsMatch = requestedSymbols.length === resultSymbols.length
    && requestedSymbols.every((symbol, index) => symbol === resultSymbols[index])
  const successful = results.filter(item => item.status === 'downloaded' || item.status === 'cached').length
  const failedRows = results.filter(item => item.status === 'failed')
  const structureComplete = manifest?.universe === securities.length
    && results.length === securities.length
    && symbolsMatch
    && manifest?.requested_end === expectedEnd
    && manifest?.diagnostic_subset !== true
  return {
    complete: structureComplete && failedRows.length === 0,
    structure_complete: structureComplete,
    manifest_universe: manifest?.universe ?? null,
    requested_start: manifest?.requested_start ?? null,
    requested_end: manifest?.requested_end ?? null,
    cutoff_matches: manifest?.requested_end === expectedEnd,
    result_rows: results.length,
    successful,
    failed: failedRows.length,
    failed_symbols: failedRows.map(item => item.symbol ?? '').filter(Boolean),
    symbols_match_universe: symbolsMatch,
    diagnostic_subset: manifest?.diagnostic_subset ?? null,
  }
}

function periodSignalKeys(period: StudyPeriod): KlineTurningMarkerKind[] {
  return (Object.keys(SIGNAL_RULES) as KlineTurningMarkerKind[])
    .filter(key => SIGNAL_RULES[key].periods.includes(period))
}

function periodHorizons(period: StudyPeriod): number[] {
  return [...new Set(periodSignalKeys(period).map(key => PERIOD_HORIZONS[period][SIGNAL_RULES[key].dailyHorizon]))]
    .toSorted((left, right) => left - right)
}

function main(): void {
  const args = parseArgs()
  const universePath = resolve(args.cacheDir, 'current-universe.json')
  const manifestPath = resolve(args.cacheDir, 'download-manifest.json')
  const nativeMonthManifestPath = resolve(args.cacheDir, 'native-month', 'download-manifest.json')
  if (!existsSync(universePath)) throw new Error(`missing current universe: ${universePath}`)
  if (!existsSync(manifestPath)) throw new Error(`missing daily download manifest: ${manifestPath}`)
  const universe = JSON.parse(readFileSync(universePath, 'utf8')) as UniverseFile
  const dailyManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DownloadManifest
  const nativeMonthManifest = existsSync(nativeMonthManifestPath)
    ? JSON.parse(readFileSync(nativeMonthManifestPath, 'utf8')) as DownloadManifest
    : null
  if (universe.requested_end !== KLINE_TURNING_STUDY_CUTOFF) {
    throw new Error(`cache cutoff ${universe.requested_end} != product cutoff ${KLINE_TURNING_STUDY_CUTOFF}`)
  }
  const allSecurities = universe.securities.toSorted((left, right) => left.canonical.localeCompare(right.canonical))
  if (args.maxSymbols === null && (
    universe.diagnostic_subset === true
    || universe.exchange_filter != null
    || (universe.security_master_total !== undefined && universe.security_master_total !== allSecurities.length)
  )) {
    throw new Error('current-universe.json is a diagnostic/filter subset; rerun the full downloader')
  }
  const benchmark = loadBenchmarkStates(args.cacheDir, universe.requested_end)
  const securities = args.maxSymbols === null ? allSecurities : allSecurities.slice(0, args.maxSymbols)
  const diagnosticSubset = args.maxSymbols !== null || universe.diagnostic_subset === true
  if (diagnosticSubset) {
    console.error('WARNING: diagnostic subset only; output is not full-universe evidence')
  }
  const dailyManifestAudit = manifestAudit(dailyManifest, allSecurities, universe.requested_end)
  const nativeMonthManifestAudit = manifestAudit(nativeMonthManifest, allSecurities, universe.requested_end)

  const events: EventRow[] = []
  const exactControls = new Map<string, Aggregate>()
  const coarseControls = new Map<string, Aggregate>()
  const sourceCacheDigest = createHash('sha256')
  const quality = {
    securities_requested: securities.length,
    cache_files_loaded: 0,
    cache_files_missing: 0,
    invalid_or_empty: 0,
    valid_daily_rows: 0,
    first_date: null as string | null,
    last_date: null as string | null,
    securities_with_at_least_1000_daily_rows: 0,
    securities_near_1900_row_provider_cap: 0,
    period_rows: { daily: 0, weekly: 0, monthly: 0 },
    period_first_date: { daily: null, weekly: null, monthly: null } as Record<StudyPeriod, string | null>,
    period_last_date: { daily: null, weekly: null, monthly: null } as Record<StudyPeriod, string | null>,
    period_evaluable_securities: { daily: 0, weekly: 0, monthly: 0 },
    period_source: {
      daily: 'daily provider cache',
      weekly: 'daily cache aggregated to completed ISO weeks',
      monthly: 'native monthly qfq; provider mix disclosed separately; daily cache supplies overlapping mean-daily liquidity',
    },
    native_month_files_loaded: 0,
    native_month_files_missing: 0,
    native_month_invalid_or_empty: 0,
    native_month_provider_counts: {} as Record<string, number>,
    native_month_adjustment_counts: {} as Record<string, number>,
    daily_provider_counts: {} as Record<string, number>,
    daily_adjustment_counts: {} as Record<string, number>,
    sina_files_with_zero_factor_dates: 0,
    marker_events_with_mature_outcome: 0,
    marker_events_right_censored_by_horizon: 0,
    right_censored_by_signal_period: {} as Record<string, number>,
    provider_history_cap_warning: 'Sina active-name histories are commonly capped at 1,900 daily bars (~7.5 years).',
  }

  for (let securityIndex = 0; securityIndex < securities.length; securityIndex += 1) {
    const security = securities[securityIndex]
    if (security === undefined) continue
    const path = cachePath(args.cacheDir, security)
    if (!existsSync(path)) {
      quality.cache_files_missing += 1
      continue
    }
    sourceCacheDigest.update(`${security.canonical}\0`)
    sourceCacheDigest.update(readFileSync(path))
    const cacheMetadata = loadCacheMetadata(path)
    quality.daily_provider_counts[cacheMetadata.provider] = (quality.daily_provider_counts[cacheMetadata.provider] ?? 0) + 1
    quality.daily_adjustment_counts[cacheMetadata.fqt] = (quality.daily_adjustment_counts[cacheMetadata.fqt] ?? 0) + 1
    if (cacheMetadata.provider.includes('Sina') && cacheMetadata.factorDates === 0) {
      quality.sina_files_with_zero_factor_dates += 1
    }
    const dailyBars = loadDailyBars(path).filter(bar => bar.date <= universe.requested_end)
    if (dailyBars.length === 0) {
      quality.invalid_or_empty += 1
      continue
    }
    quality.cache_files_loaded += 1
    quality.valid_daily_rows += dailyBars.length
    const firstDate = dailyBars[0]?.date ?? null
    const lastDate = dailyBars.at(-1)?.date ?? null
    if (firstDate !== null && (quality.first_date === null || firstDate < quality.first_date)) quality.first_date = firstDate
    if (lastDate !== null && (quality.last_date === null || lastDate > quality.last_date)) quality.last_date = lastDate
    if (dailyBars.length >= 1_000) quality.securities_with_at_least_1000_daily_rows += 1
    if (dailyBars.length >= 1_890) quality.securities_near_1900_row_provider_cap += 1

    for (const period of PERIODS) {
      let bars: KLineBar[]
      if (period === 'monthly') {
        const nativePath = nativeMonthCachePath(args.cacheDir, security)
        const native = nativeMonthlyBars(args.cacheDir, security, dailyBars, universe.requested_end)
        if (native === null) {
          quality.native_month_files_missing += 1
          bars = []
        } else if (native.length === 0) {
          quality.native_month_invalid_or_empty += 1
          bars = []
        } else {
          quality.native_month_files_loaded += 1
          const nativeMetadata = loadCacheMetadata(nativePath)
          quality.native_month_provider_counts[nativeMetadata.provider] = (quality.native_month_provider_counts[nativeMetadata.provider] ?? 0) + 1
          quality.native_month_adjustment_counts[nativeMetadata.fqt] = (quality.native_month_adjustment_counts[nativeMetadata.fqt] ?? 0) + 1
          sourceCacheDigest.update(`${security.canonical}|native-month\0`)
          sourceCacheDigest.update(readFileSync(nativePath))
          bars = native
        }
      } else {
        bars = aggregateBars(dailyBars, period, universe.requested_end)
      }
      quality.period_rows[period] += bars.length
      const periodFirst = bars[0]?.date ?? null
      const periodLast = bars.at(-1)?.date ?? null
      if (periodFirst !== null && (
        quality.period_first_date[period] === null || periodFirst < (quality.period_first_date[period] ?? periodFirst)
      )) quality.period_first_date[period] = periodFirst
      if (periodLast !== null && (
        quality.period_last_date[period] === null || periodLast > (quality.period_last_date[period] ?? periodLast)
      )) quality.period_last_date[period] = periodLast
      const horizons = periodHorizons(period)
      const largestHorizon = Math.max(...horizons)
      if (bars.length < 121 + largestHorizon + 1) continue
      quality.period_evaluable_securities[period] += 1
      const liquidity = priorAmountMedians(bars)
      const high60 = priorHigh60Series(bars)

      for (let index = 121; index + 1 < bars.length; index += 1) {
        const amount = liquidity[index] ?? null
        if (amount === null || amount < PRIMARY_LIQUIDITY) continue
        const buyTradable = period !== 'daily' || !onePriceLimitUp(bars, index, security.board)
        const buyContext = buyTradable
          ? contextKeys(bars, index, 'buy', security.board, amount, high60[index] ?? null)
          : null
        const riskContext = contextKeys(bars, index, 'risk', security.board, amount, high60[index] ?? null)
        for (const horizon of horizons) {
          const measured = outcome(bars, index, horizon)
          if (measured === null) continue
          for (const [side, context] of [['buy', buyContext], ['risk', riskContext]] as const) {
            if (context === null) continue
            const signed = side === 'buy' ? measured.net : -measured.raw
            const hit = side === 'buy' ? measured.net > 0 : measured.raw < 0
            addAggregate(
              exactControls,
              `${period}|${bars[index]!.date}|${horizon}|${context.exact}`,
              hit,
              signed,
            )
            addAggregate(
              coarseControls,
              `${period}|${bars[index]!.date}|${horizon}|${context.coarse}`,
              hit,
              signed,
            )
          }
        }
      }

      const study = buildKlineTurningStudy(bars, period)
      for (const marker of study.markers) {
        const rule = SIGNAL_RULES[marker.kind]
        if (!rule.periods.includes(period)) continue
        const horizon = PERIOD_HORIZONS[period][rule.dailyHorizon]
        const measured = outcome(bars, marker.index, horizon)
        const entry = bars[marker.index + 1]
        const exit = bars[marker.index + horizon]
        if (measured === null || entry === undefined || exit === undefined) {
          const key = `${period}|${marker.kind}`
          quality.marker_events_right_censored_by_horizon += 1
          quality.right_censored_by_signal_period[key] = (quality.right_censored_by_signal_period[key] ?? 0) + 1
          continue
        }
        const amount = liquidity[marker.index] ?? null
        const liquid = amount !== null && amount >= PRIMARY_LIQUIDITY
        const tradable = rule.side === 'risk'
          || period !== 'daily'
          || !onePriceLimitUp(bars, marker.index, security.board)
        const context = liquid && amount !== null
          ? contextKeys(bars, marker.index, rule.side, security.board, amount, high60[marker.index] ?? null)
          : null
        const signed = rule.side === 'buy' ? measured.net : -measured.raw
        const benchmarkState = benchmark.states.get(marker.date) ?? null
        events.push({
          signal: marker.kind,
          label: rule.label,
          period,
          side: rule.side,
          symbol: security.canonical,
          board: security.board,
          signalDate: marker.date,
          entryDate: entry.date,
          exitDate: exit.date,
          horizon,
          rawReturn: measured.raw,
          netReturn: measured.net,
          signedReturn: signed,
          directionHit: rule.side === 'buy' ? measured.net > 0 : measured.raw < 0,
          tradableEntry: tradable,
          lockedLimitDownAtPlannedExit: rule.side === 'buy' && period === 'daily'
            ? onePriceLimitDown(bars, marker.index + horizon, security.board)
            : null,
          priorAmount20Median: amount,
          liquidityEligible: liquid,
          contextKey: context?.exact ?? null,
          coarseContextKey: context?.coarse ?? null,
          entryGap: measured.gap,
          benchmarkRegime: benchmarkState?.regime ?? null,
          benchmarkReturn20: benchmarkState?.return20 ?? null,
        })
      }
    }
    if ((securityIndex + 1) % 250 === 0 || securityIndex + 1 === securities.length) {
      console.error(`analyzed ${securityIndex + 1}/${securities.length}; events=${events.length}`)
    }
  }
  quality.marker_events_with_mature_outcome = events.length
  const sourceCacheAggregateSha256 = sourceCacheDigest.digest('hex')

  // Remove every eligible occurrence of the tested signal from its matched
  // same-day/context pool. This prevents the shape being evaluated from also
  // serving as its own control condition.
  const exactSignalContributions = new Map<string, Aggregate>()
  const coarseSignalContributions = new Map<string, Aggregate>()
  for (const event of events.filter(eligiblePrimary)) {
    if (event.contextKey === null || event.coarseContextKey === null) continue
    addAggregate(
      exactSignalContributions,
      `${event.signal}|${event.period}|${event.signalDate}|${event.horizon}|${event.contextKey}`,
      event.directionHit,
      event.signedReturn,
    )
    addAggregate(
      coarseSignalContributions,
      `${event.signal}|${event.period}|${event.signalDate}|${event.horizon}|${event.coarseContextKey}`,
      event.directionHit,
      event.signedReturn,
    )
  }

  const rowsByKey = new Map<string, Record<string, unknown>>()
  for (const period of PERIODS) {
    for (const signal of periodSignalKeys(period)) {
      rowsByKey.set(`${period}|${signal}`, auditRow(
        signal,
        period,
        events,
        exactControls,
        coarseControls,
        exactSignalContributions,
        coarseSignalContributions,
      ))
    }
  }
  const pValues: Array<{ key: string; p: number }> = []
  for (const [key, row] of rowsByKey) {
    const cluster = nestedRecord(row, ['liquid_tradable_primary', 'matched_direction_uplift_two_way_cluster']) as ClusterResult | null
    pValues.push({
      key,
      p: cluster != null && Number.isFinite(cluster.one_sided_p_positive)
        ? cluster.one_sided_p_positive
        : 1,
    })
  }
  const adjusted = holmAdjusted(pValues)
  const gates: Record<string, unknown> = {}
  const dailyCacheActuallyComplete = quality.cache_files_loaded === quality.securities_requested
    && quality.cache_files_missing === 0
    && quality.invalid_or_empty === 0
  const nativeMonthCacheActuallyComplete = quality.native_month_files_loaded === quality.securities_requested
    && quality.native_month_files_missing === 0
    && quality.native_month_invalid_or_empty === 0
  const periodEvidenceComplete: Record<StudyPeriod, boolean> = {
    daily: dailyManifestAudit.complete && dailyCacheActuallyComplete,
    weekly: dailyManifestAudit.complete && dailyCacheActuallyComplete,
    monthly: dailyManifestAudit.complete && dailyCacheActuallyComplete
      && nativeMonthManifestAudit.complete && nativeMonthCacheActuallyComplete,
  }
  for (const [key, row] of rowsByKey) {
    const period = key.split('|')[0] as StudyPeriod
    gates[key] = releaseGate(
      row,
      adjusted[key] ?? null,
      periodEvidenceComplete[period],
      diagnosticSubset,
    )
  }

  const signals = Object.fromEntries(PERIODS.map(period => [
    period,
    Object.fromEntries(periodSignalKeys(period).map(signal => [signal, rowsByKey.get(`${period}|${signal}`)])),
  ]))

  const orderedEvents = events.toSorted((left, right) => {
    return left.signalDate.localeCompare(right.signalDate)
      || left.symbol.localeCompare(right.symbol)
      || left.period.localeCompare(right.period)
      || left.signal.localeCompare(right.signal)
  })
  const ledgerBody = orderedEvents.map(event => JSON.stringify(event)).join('\n') + (orderedEvents.length > 0 ? '\n' : '')
  const ledgerBytes = gzipSync(Buffer.from(ledgerBody, 'utf8'), { level: 6 })
  mkdirSync(dirname(args.ledger), { recursive: true })
  writeFileSync(args.ledger, ledgerBytes)
  const ledger = {
    path: relative(ROOT, args.ledger),
    events: orderedEvents.length,
    compressed_bytes: ledgerBytes.byteLength,
    sha256: createHash('sha256').update(ledgerBytes).digest('hex'),
    format: 'gzip JSON Lines; one row per production marker with a mature primary-horizon outcome',
  }

  const scriptPath = fileURLToPath(import.meta.url)
  const productRulePath = resolve(ROOT, 'packages/client-workbench/src/kline-ma.ts')
  const result = {
    metadata: {
      generated_at: new Date().toISOString(),
      purpose: 'current-listed full-universe audit of every production K-line turning marker',
      requested_start: universe.requested_start,
      requested_end: universe.requested_end,
      signal_clock: 'marker known only after the signal-period close; latest incomplete week/month removed',
      entry_clock: 'next period open; daily estimated one-price limit-up entries excluded from primary buy-side results',
      period_date_semantics: 'weekly/monthly entryDate and exitDate are period-end labels while prices are the corresponding period open/close',
      horizon_convention: 'signal + H period close, with the signal period counted as t=0',
      cost_model_for_buy_direction: {
        commission_each_side: BUY_COMMISSION,
        transfer_fee_each_side: TRANSFER_FEE,
        sell_stamp_duty_before_2023_08_28: HISTORICAL_SELL_STAMP_DUTY,
        sell_stamp_duty_from_2023_08_28: CURRENT_SELL_STAMP_DUTY,
        slippage_each_side: SLIPPAGE,
        approximate_round_trip_current: 0.00312,
        approximate_round_trip_before_2023_08_28: 0.00362,
      },
      risk_marker_semantics: 'future underlying decline / avoided-loss observation; never a short-sale P&L claim',
      liquidity_filter: `prior 20 period amount median >= ${PRIMARY_LIQUIDITY}`,
      script_sha256: readSha256(scriptPath),
      product_rule_sha256: readSha256(productRulePath),
      universe_sha256: readSha256(universePath),
      download_manifest_sha256: readSha256(manifestPath),
      native_month_manifest_sha256: readSha256(nativeMonthManifestPath),
      source_cache_aggregate_sha256: sourceCacheAggregateSha256,
      daily_manifest_audit: dailyManifestAudit,
      native_month_manifest_audit: nativeMonthManifestAudit,
      period_evidence_complete: periodEvidenceComplete,
      analyzer_cache_complete: {
        daily_and_weekly: dailyCacheActuallyComplete,
        monthly_native: nativeMonthCacheActuallyComplete,
      },
      matched_control_semantics: 'same date/horizon/location/board/liquidity pool with every eligible occurrence of the tested signal removed',
      benchmark: {
        symbol: 'sh.000300',
        description: '沪深300 raw daily regime context; current close vs MA20 and MA20 three-bar slope',
        cache_sha256: readSha256(benchmark.path),
        dates: benchmark.states.size,
      },
      diagnostic_subset: diagnosticSubset,
    },
    universe: {
      ...quality,
      daily_manifest_audit: dailyManifestAudit,
      native_month_manifest_audit: nativeMonthManifestAudit,
      scope: universe.scope,
      survivorship_warning: universe.survivorship_warning,
      boards: Object.fromEntries(
        [...new Set(securities.map(item => item.board))].toSorted().map(board => [
          board, securities.filter(item => item.board === board).length,
        ]),
      ),
    },
    event_ledger: ledger,
    signals,
    release_gates: gates,
    primary_hypotheses: {
      family: 'every production signal × supported period',
      family_size: pValues.length,
      estimable_tests_with_matched_controls: [...rowsByKey.values()].filter(row => {
        const count = nestedRecord(row, ['liquid_tradable_primary', 'matched_events'])
        return typeof count === 'number' && count > 0
      }).length,
      holm_adjusted_one_sided_p_values: adjusted,
      gates_passed: Object.values(gates).filter(value => (value as Record<string, unknown>).passed === true).length,
      gates_passing_except_run_integrity: Object.values(gates).filter(
        value => (value as Record<string, unknown>).passed_except_run_integrity === true,
      ).length,
      gates_total: Object.keys(gates).length,
    },
    marker_overlap: overlapReport(events),
    limitations: [
      'The security universe contains only currently listed names, so results are survivorship-biased; the frozen 2026-08-22 study remains the historical/delisted-universe reference.',
      'Most active-name Sina histories are capped at 1,900 daily bars, so this audit is broad cross-sectionally but shorter in time than the frozen 2014-start artifact.',
      `Observed source ranges differ by period: daily ${quality.period_first_date.daily ?? 'unavailable'}..${quality.period_last_date.daily ?? 'unavailable'}, weekly ${quality.period_first_date.weekly ?? 'unavailable'}..${quality.period_last_date.weekly ?? 'unavailable'}, monthly ${quality.period_first_date.monthly ?? 'unavailable'}..${quality.period_last_date.monthly ?? 'unavailable'}. They must not be read as one common 2014-start sample.`,
      'The Sina daily cache derives adjusted OHLC from available factor dates and falls back to raw prices where a factor is missing. Files with zero factor dates are counted explicitly because corporate-action gaps can create false deep-decline or return observations.',
      'Weekly bars are aggregated from the capped adjusted daily cache rather than the product provider’s native full-history weekly bars. Monthly signal OHLCV uses native qfq bars (provider mix disclosed in universe quality). Both are provider/window sensitivity limitations.',
      'The weekly/monthly liquidity field is normalized to mean daily amount where daily history overlaps; native monthly rows before daily coverage have no eligible liquidity control.',
      'Historical ST status, IPO no-limit windows, delisting windows, exact exchange limit prices, queue priority, order-book liquidity, and position-size market impact cannot be reconstructed from this cache.',
      'Commission, transfer fee and slippage are fixed assumptions; sell stamp duty is date-aware. Actual costs vary with broker, liquidity, volatility, queue position and order size.',
      'Daily planned exits that appear locked at one-price limit-down are flagged but remain marked to the planned close; their realized sale may be later and worse. Weekly/monthly lock states cannot be reconstructed from aggregate/native bars.',
      'Signal/month clustering is an approximate dependence correction. Strict new time-sample evidence begins only after the frozen cutoff and is not created by this retrospective rerun.',
      'Markers too close to the cutoff to complete their fixed horizon are right-censored, counted separately, and excluded from every outcome denominator; they are never force-closed at the last available bar.',
      'A high raw direction rate can be entirely explained by the matched market state; product upgrade requires positive matched direction and return increments after multiplicity correction.',
    ],
  }

  mkdirSync(dirname(args.output), { recursive: true })
  writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`)
  console.log(`wrote ${args.output}`)
  console.log(`wrote ${args.ledger}`)
}

main()
