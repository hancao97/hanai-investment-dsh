#!/usr/bin/env tsx

/**
 * Render the independent turning-point capability audit as one portable HTML file.
 *
 * The renderer deliberately performs no backtest calculations. It reads the frozen
 * JSON artifacts, exposes their clocks/filters/limitations, and renders missing
 * fields as an em dash. That separation keeps presentation changes from silently
 * changing the evidence.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type JsonObject = Record<string, unknown>

interface Args {
  production: string
  fullMarket: string
  periodStudy: string
  chanStability: string
  chanWalkForward: string
  output: string
}

interface ProductionRow {
  key: string
  period: string
  signal: string
  label: string
  side: string
  horizon: number | null
  horizonUnit: string
  supported: boolean
  primary: JsonObject
  diagnostics: JsonObject
  gate: JsonObject
  events: number | null
  directionHits: number | null
  matchedEvents: number | null
  symbols: number | null
  rawRate: number | null
  rawCi: number[] | null
  meanSigned: number | null
  profitFactor: number | null
  expectedRate: number | null
  uplift: number | null
  upliftCi: number[] | null
  signedExcess: number | null
  excessCi: number[] | null
  matchedCoverage: number | null
  holmP: number | null
  stableYears: number | null
  checksPassed: number
  checksTotal: number
  gatePassed: boolean
}

type ProbabilityTier = 'dual' | 'direction' | 'unproven' | 'adverse' | 'insufficient'

interface ProbabilityJudgement {
  tier: ProbabilityTier
  label: string
  tone: 'good' | 'warn' | 'bad' | 'neutral'
  explanation: string
  action: string
}

interface ResearchRow {
  signal: string
  label: string
  side: string
  family: string
  stage: string
  priority: string
  horizon: number | null
  rule: string
  population: string
  evidence: JsonObject
  diagnostics: JsonObject
  gate: JsonObject
  events: number | null
  symbols: number | null
  rawRate: number | null
  rawCi: number[] | null
  meanSigned: number | null
  profitFactor: number | null
  expectedRate: number | null
  uplift: number | null
  upliftCi: number[] | null
  signedExcess: number | null
  excessCi: number[] | null
  matchedCoverage: number | null
  validationRate: number | null
  testRate: number | null
  holmP: number | null
  stableYears: number | null
  checksPassed: number
  checksTotal: number
  gatePassed: boolean
}

interface ChanStageRow {
  configuration: string
  stage: string
  horizon: string
  evidence: JsonObject
  events: number | null
  rate: number | null
  ci: number[] | null
  meanSigned: number | null
  cooldownEvents: number | null
  cooldownRate: number | null
  cooldownCi: number[] | null
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULTS: Args = {
  production: resolve(ROOT, 'docs/research-data/production-turning-point-full-backtest-2026-08-23.json'),
  fullMarket: resolve(ROOT, 'docs/research-data/full-market-turning-point-study-2026-08-22.json'),
  periodStudy: resolve(ROOT, 'docs/research-data/kline-period-turning-study-2026-08-22.json'),
  chanStability: resolve(ROOT, 'docs/research-data/chan-signal-stability-2026-08-21.json'),
  chanWalkForward: resolve(ROOT, 'docs/research-data/chan-signal-walk-forward-2026-08-21.json'),
  output: resolve(ROOT, 'docs/turning-point-capability-audit-2026-08-23.html'),
}
const LEGACY_CASE_PATH = resolve(ROOT, 'docs/research-data/ma-volume-turning-point-study-2026-08-21.json')

const PERIOD_ORDER = ['daily', 'weekly', 'monthly']
const PERIOD_LABELS: Record<string, string> = { daily: '日 K', weekly: '周 K', monthly: '月 K' }
const STAGE_LABELS: Record<string, string> = {
  first_seen: '首次出现（会变化）',
  underlying_bi_sure: '底层笔确认',
  marker_frozen: '标记冻结',
  anchor: '观察锚点',
  confirmed: '确认',
}
const CONFIG_LABELS: Record<string, string> = {
  official_default_daily_morphology: '官方默认日线形态',
  strict_divergence_0_9: '严格背驰 0.9',
  independent_relaxed: '独立宽松参数',
}

const PRODUCTION_RULES: Record<string, { rule: string; productVerdict: string }> = {
  'post-rise-huge-volume': {
    rule: '前 21 根涨幅≥15%，MA5>MA10、MA10 上行、昨收>昨 MA5，量比 VMA20≥2.5。',
    productVerdict: '当前最有统计价值的风险预警家族：日、周为 A，月为 B；适合降仓/过滤，不等于可做空收益。',
  },
  'post-rise-huge-volume-weak': {
    rule: '满足“巨量分歧”，且收盘位置 CLV≤0.35；它是基础信号的完全子集。',
    productVerdict: '日、周、月均有方向增量，但与基础信号高度重合；应作为强度特征，不应重复计权。',
  },
  'deep-decline-huge-volume': {
    rule: '距前 60 根高点回撤≤−25%，近 20 根至少 10 次收于 MA20 下，今收≤MA20，量比≥2.5。',
    productVerdict: '日线只有场景概率，周/月反而显著偏弱；不应继续解释为可跨周期迁移的抄底买点。',
  },
  'deep-decline-huge-volume-strong': {
    rule: '满足“深跌放量”，且阳线、收盘位置 CLV≥0.70。',
    productVerdict: '日线高 raw 未超越同状态基线，周线为方向反证、月线样本不足；暂不作为买入依据。',
  },
  'deep-decline-huge-volume-lower-shadow': {
    rule: '满足“深跌放量”，且下影/振幅≥0.45、收盘位置 CLV≥0.55。',
    productVerdict: '日线历史约 2/3 上涨，但增量区间跨 0；周/月样本不足，只能保留观察。',
  },
  'deep-decline-reclaim-ma5': {
    rule: '前 5 根出现深跌巨量，昨收≤MA5，今日阳线收复 MA5 且 CLV≥0.65。',
    productVerdict: '三个周期均未证明独立概率增量；保留图表观察，不提升为交易信号。',
  },
  'low-bullish-outside': {
    rule: '仅日线：DD60≤−15%、前 10 根跌幅≤−10%，破低扩幅后阳线收过昨高，CLV≥0.75、TR≥1.2ATR、量≥1.2VMA。',
    productVerdict: 'raw 上涨率 66.77% 很高，但同场景基线 65.66%，独立增量不显著；典型“状态概率≠形态能力”。',
  },
  'hammer-spring-anchor': {
    rule: '仅日线：DD60≤−20%，探前低后收回；下影≥0.50、CLV≥0.65、实体≤0.35、TR≥0.8ATR。',
    productVerdict: '原始胜率接近五五开，增量区间跨 0；只能作为待确认锚点。',
  },
  'hammer-spring-confirmed': {
    rule: '仅日线：锚点后 1–3 日首次收过锚高并站上 MA5、CLV≥0.55；跌破锚低−0.25ATR 则失效。',
    productVerdict: '确认后 raw 52.51%，增量下界仍略低于 0；有弱提示，尚未达到独立买点证据。',
  },
  'huge-upper-rejection': {
    rule: '仅日线：上涨趋势中创前 20 根新高，量≥2.5VMA，上影≥0.55、CLV≤0.35、TR≥ATR。',
    productVerdict: 'raw 下跌率 57.19%，但 matched 增量区间跨 0；作为风险观察，不把它宣称成卖点。',
  },
}

const DEPLOYED_RESEARCH_SIGNALS: Record<string, string> = {
  low_bullish_outside: 'low-bullish-outside',
  hammer_spring_raw: 'hammer-spring-anchor',
  hammer_spring_confirmed: 'hammer-spring-confirmed',
  huge_upper_rejection_raw: 'huge-upper-rejection',
}

const INDUSTRY_SOURCES = [
  { title: 'Lo, Mamaysky & Wang · Foundations of Technical Analysis', finding: '技术形态可携带条件信息，但经济意义与样本外稳定性必须单独验证。', url: 'https://doi.org/10.1111/0022-1082.00265' },
  { title: 'Brock, Lakonishok & LeBaron · Simple Technical Trading Rules', finding: '移动平均与区间突破的早期证据促成了更严格的数据窥探检验。', url: 'https://doi.org/10.1111/j.1540-6261.1992.tb04681.x' },
  { title: 'Sullivan, Timmermann & White · Data-Snooping', finding: '大量规则中挑最好者会显著夸大有效性，必须做 family-wise 校正。', url: 'https://doi.org/10.1111/0022-1082.00163' },
  { title: 'Zakamulin & Giner · 6,406 rules / 41 markets', finding: '可预测性随时间衰减，对交易成本敏感；最近最优规则样本外常不如持有。', url: 'https://link.springer.com/article/10.1007/s11408-023-00433-2' },
  { title: 'A 股 7,000 条技术规则研究', finding: 'A 股规则海量搜索同样面临数据窥探与成本敏感性，不能以最佳历史参数替代冻结验证。', url: 'https://doi.org/10.1016/j.physa.2015.07.029' },
  { title: 'Moskowitz, Ooi & Pedersen · Time Series Momentum', finding: '约 1–12 月趋势延续与更长周期部分反转提示：周期状态比静态 K 线更重要。', url: 'https://doi.org/10.1016/j.jfineco.2011.11.003' },
  { title: 'Cooper, Gutierrez & Hameed · Market States and Momentum', finding: '动量收益依赖市场状态，说明信号必须与指数/行业状态联合评估。', url: 'https://doi.org/10.1111/j.1540-6261.2004.00665.x' },
  { title: 'Daniel & Moskowitz · Momentum Crashes', finding: '剧烈反弹阶段会发生动量崩溃；反转与趋势策略都需要 regime gate。', url: 'https://doi.org/10.1016/j.jfineco.2015.12.002' },
  { title: 'Nagel · Evaporating Liquidity / Short-term Reversal', finding: '短期反转与流动性供给相关，成交量本身不是方向，需要位置与流动性解释。', url: 'https://doi.org/10.1093/rfs/hhs066' },
  { title: 'Lee & Swaminathan · Price Momentum and Trading Volume', finding: '成交量为价格路径提供状态信息，但不能被当成独立买卖方向。', url: 'https://doi.org/10.1111/0022-1082.00280' },
  { title: 'McLean & Pontiff · Does Academic Research Destroy Return Predictability?', finding: '发表/发现后的收益衰减体现过拟合与拥挤，历史最优不是未来概率。', url: 'https://doi.org/10.1111/jofi.12365' },
  { title: 'Brown, Cai & DasGupta · Interval Estimation for Binomial Proportion', finding: '胜率区间应使用 Wilson 等稳健方法，而非只报点估计。', url: 'https://doi.org/10.1214/ss/1009213286' },
  { title: 'Bailey et al. · Probability of Backtest Overfitting', finding: '组合式回测应量化选择过拟合，并保留真正冻结后的未使用样本。', url: 'https://escholarship.org/uc/item/63t9f6t2' },
]

function parseArgs(): Args {
  const values = new Map<string, string>()
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index]
    const value = process.argv[index + 1]
    if (key === undefined || value === undefined || !key.startsWith('--')) {
      throw new Error('Usage: [--production path] [--full-market path] [--period-study path] [--chan-stability path] [--chan-walk-forward path] [--output path]')
    }
    values.set(key.slice(2), value)
  }
  const known = new Set(['production', 'full-market', 'period-study', 'chan-stability', 'chan-walk-forward', 'output'])
  for (const key of values.keys()) {
    if (!known.has(key)) throw new Error(`unknown option --${key}`)
  }
  return {
    production: resolve(values.get('production') ?? DEFAULTS.production),
    fullMarket: resolve(values.get('full-market') ?? DEFAULTS.fullMarket),
    periodStudy: resolve(values.get('period-study') ?? DEFAULTS.periodStudy),
    chanStability: resolve(values.get('chan-stability') ?? DEFAULTS.chanStability),
    chanWalkForward: resolve(values.get('chan-walk-forward') ?? DEFAULTS.chanWalkForward),
    output: resolve(values.get('output') ?? DEFAULTS.output),
  }
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function get(root: unknown, ...path: Array<string | number>): unknown {
  let current: unknown = root
  for (const part of path) {
    if (Array.isArray(current) && typeof part === 'number') current = current[part]
    else if (current !== null && typeof current === 'object') current = (current as JsonObject)[String(part)]
    else return undefined
  }
  return current
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value : ''
}

function numberArray(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length < 2) return null
  const values = value.map(numberValue)
  return values.every(item => item !== null) ? values as number[] : null
}

function readJson(path: string): JsonObject {
  if (!existsSync(path)) throw new Error(`missing input artifact: ${path}`)
  return asObject(JSON.parse(readFileSync(path, 'utf8')))
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function escapeAttr(value: unknown): string {
  return escapeHtml(value).replaceAll('`', '&#096;')
}

function fmtInt(value: number | null): string {
  return value === null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value)
}

function fmtNumber(value: number | null, digits = 2): string {
  return value === null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(value)
}

function fmtPct(value: number | null, digits = 1, signed = false): string {
  if (value === null) return '—'
  const sign = signed && value > 0 ? '+' : ''
  return `${sign}${(value * 100).toFixed(digits)}%`
}

function fmtPp(value: number | null, digits = 2): string {
  if (value === null) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${(value * 100).toFixed(digits)}pp`
}

function fmtPpCi(value: number[] | null): string {
  return value === null ? '—' : `[${fmtPp(value[0] ?? null)}, ${fmtPp(value[1] ?? null)}]`
}

function fmtPctAlready(value: number | null, digits = 1): string {
  return value === null ? '—' : `${value.toFixed(digits)}%`
}

function fmtP(value: number | null): string {
  if (value === null) return '—'
  if (value === 0) return '&lt; 1e−12'
  if (value < 0.0001) return value.toExponential(2)
  return value.toFixed(4)
}

function fmtCi(value: number[] | null, percent = true): string {
  if (value === null) return '—'
  return percent
    ? `[${fmtPct(value[0] ?? null)}, ${fmtPct(value[1] ?? null)}]`
    : `[${fmtNumber(value[0] ?? null)}, ${fmtNumber(value[1] ?? null)}]`
}

function countChecks(gate: JsonObject): { passed: number; total: number } {
  const values = Object.values(asObject(gate.checks)).filter(value => typeof value === 'boolean')
  return { passed: values.filter(Boolean).length, total: values.length }
}

function productionRows(production: JsonObject): ProductionRow[] {
  const signalsByPeriod = asObject(production.signals)
  const definitions = new Map<string, JsonObject>()
  for (const period of PERIOD_ORDER) {
    for (const [signal, rawRow] of Object.entries(asObject(signalsByPeriod[period]))) {
      const definition = asObject(asObject(rawRow).definition)
      if (!definitions.has(signal)) definitions.set(signal, definition)
    }
  }
  const releaseGates = asObject(production.release_gates)
  const rows: ProductionRow[] = []
  for (const [signal, fallbackDefinition] of definitions) {
    for (const period of PERIOD_ORDER) {
      const rawRow = asObject(asObject(signalsByPeriod[period])[signal])
      const supported = Object.keys(rawRow).length > 0
      const definition = supported ? asObject(rawRow.definition) : fallbackDefinition
      const primary = asObject(rawRow.liquid_tradable_primary)
      const diagnostics = asObject(rawRow.primary_diagnostics)
      const key = `${period}|${signal}`
      const gate = asObject(releaseGates[key])
      const checks = countChecks(gate)
      rows.push({
        key,
        period,
        signal,
        label: stringValue(definition.label) || signal,
        side: stringValue(definition.side),
        horizon: supported ? numberValue(definition.horizon) : null,
        horizonUnit: supported ? stringValue(definition.horizon_unit) : '',
        supported,
        primary,
        diagnostics,
        gate,
        events: numberValue(primary.events),
        directionHits: numberValue(primary.direction_hits),
        matchedEvents: numberValue(primary.matched_events),
        symbols: numberValue(primary.symbols),
        rawRate: numberValue(primary.direction_rate),
        rawCi: numberArray(primary.direction_rate_wilson_95ci),
        meanSigned: numberValue(primary.mean_signed_return),
        profitFactor: numberValue(primary.profit_factor_signed),
        expectedRate: numberValue(primary.matched_expected_direction_rate),
        uplift: numberValue(primary.matched_direction_uplift),
        upliftCi: numberArray(get(primary, 'matched_direction_uplift_two_way_cluster', 'ci95')),
        signedExcess: numberValue(primary.matched_mean_signed_excess),
        excessCi: numberArray(get(primary, 'matched_signed_excess_two_way_cluster', 'ci95')),
        matchedCoverage: numberValue(primary.matched_coverage),
        holmP: numberValue(gate.holm_adjusted_p),
        stableYears: numberValue(gate.stable_years),
        checksPassed: checks.passed,
        checksTotal: checks.total,
        gatePassed: gate.passed === true,
      })
    }
  }
  return rows.toSorted((left, right) => PERIOD_ORDER.indexOf(left.period) - PERIOD_ORDER.indexOf(right.period)
    || left.label.localeCompare(right.label, 'zh-CN'))
}

function researchRows(fullMarket: JsonObject): ResearchRow[] {
  const releaseGates = asObject(fullMarket.release_gates)
  const rows: ResearchRow[] = []
  for (const [signal, rawRow] of Object.entries(asObject(fullMarket.signals))) {
    const row = asObject(rawRow)
    const definition = asObject(row.definition)
    const horizon = numberValue(definition.primary_horizon)
    const horizonRow = asObject(asObject(row.horizons)[String(horizon ?? '')])
    const expanded = asObject(horizonRow.expanded_unseen_symbols)
    const allMarket = asObject(horizonRow.all_market)
    const evidence = Object.keys(expanded).length > 0 ? expanded : allMarket
    const population = Object.keys(expanded).length > 0 ? 'expanded_unseen_symbols' : Object.keys(allMarket).length > 0 ? 'all_market' : ''
    const diagnostics = asObject(row.primary_horizon_diagnostics)
    const gate = asObject(releaseGates[signal])
    const checks = countChecks(gate)
    rows.push({
      signal,
      label: stringValue(definition.label) || signal,
      side: stringValue(definition.side),
      family: stringValue(definition.family),
      stage: stringValue(definition.stage),
      priority: stringValue(definition.priority),
      horizon,
      rule: stringValue(definition.rule),
      population,
      evidence,
      diagnostics,
      gate,
      events: numberValue(evidence.events),
      symbols: numberValue(evidence.symbols),
      rawRate: numberValue(evidence.direction_rate),
      rawCi: numberArray(evidence.direction_rate_wilson_95ci),
      meanSigned: numberValue(evidence.mean_signed_return),
      profitFactor: numberValue(evidence.profit_factor_signed),
      expectedRate: numberValue(evidence.matched_expected_direction_rate),
      uplift: numberValue(evidence.matched_direction_uplift),
      upliftCi: numberArray(get(evidence, 'matched_direction_uplift_two_way_cluster', 'ci95')),
      signedExcess: numberValue(evidence.matched_mean_signed_excess),
      excessCi: numberArray(get(evidence, 'matched_signed_excess_two_way_cluster', 'ci95')),
      matchedCoverage: numberValue(evidence.matched_coverage),
      validationRate: numberValue(get(diagnostics, 'folds', 'expanded_validation', 'direction_rate')),
      testRate: numberValue(get(diagnostics, 'folds', 'expanded_test', 'direction_rate')),
      holmP: numberValue(gate.holm_adjusted_p),
      stableYears: numberValue(gate.stable_years),
      checksPassed: checks.passed,
      checksTotal: checks.total,
      gatePassed: gate.passed === true,
    })
  }
  return rows.toSorted((left, right) => left.side.localeCompare(right.side)
    || left.family.localeCompare(right.family)
    || left.stage.localeCompare(right.stage))
}

function annualProductionRows(rows: ProductionRow[]): Array<{
  key: string; label: string; period: string; side: string; year: string; events: number | null
  rate: number | null; ci: number[] | null; mean: number | null
}> {
  const result: ReturnType<typeof annualProductionRows> = []
  for (const row of rows.filter(item => item.supported)) {
    for (const [year, rawEvidence] of Object.entries(asObject(row.diagnostics.years_purged_at_boundaries))) {
      const evidence = asObject(rawEvidence)
      result.push({
        key: row.key,
        label: row.label,
        period: row.period,
        side: row.side,
        year,
        events: numberValue(evidence.events),
        rate: numberValue(evidence.direction_rate),
        ci: numberArray(evidence.direction_rate_wilson_95ci),
        mean: numberValue(evidence.mean_signed_return),
      })
    }
  }
  return result.toSorted((left, right) => left.key.localeCompare(right.key) || left.year.localeCompare(right.year))
}

function periodStudyRows(periodStudy: JsonObject): Array<{
  period: string; signal: string; label: string; side: string; horizon: number | null; unit: string
  development: JsonObject; validation: JsonObject; recent: JsonObject; product: JsonObject
}> {
  const result: ReturnType<typeof periodStudyRows> = []
  for (const period of PERIOD_ORDER) {
    const periodRow = asObject(get(periodStudy, 'study', period))
    for (const [signal, rawSignal] of Object.entries(asObject(periodRow.events))) {
      const signalRow = asObject(rawSignal)
      const segments = asObject(signalRow.segments)
      const product = asObject(segments.product_evidence)
      result.push({
        period,
        signal,
        label: stringValue(signalRow.label) || signal,
        side: signal.startsWith('post-rise') ? 'risk' : 'buy',
        horizon: numberValue(product.horizon),
        unit: stringValue(product.horizon_unit),
        development: asObject(segments.development),
        validation: asObject(segments.validation),
        recent: asObject(segments.recent_point_in_time),
        product,
      })
    }
  }
  return result
}

function chanStageRows(chan: JsonObject): ChanStageRow[] {
  const result: ChanStageRow[] = []
  for (const [configuration, rawConfig] of Object.entries(asObject(chan.configurations))) {
    const outcomes = asObject(asObject(rawConfig).outcomes)
    for (const stage of ['first_seen', 'underlying_bi_sure', 'marker_frozen']) {
      for (const horizon of ['5', '10', '20']) {
        const evidence = asObject(get(outcomes, stage, horizon))
        if (Object.keys(evidence).length === 0) continue
        const cooldown = asObject(evidence.non_overlapping_horizon_cooldown)
        result.push({
          configuration,
          stage,
          horizon,
          evidence,
          events: numberValue(evidence.signals),
          rate: numberValue(evidence.direction_correct_rate),
          ci: numberArray(get(evidence, 'cluster_bootstrap', 'direction_correct_95ci')),
          meanSigned: numberValue(evidence.mean_signed_return),
          cooldownEvents: numberValue(cooldown.signals),
          cooldownRate: numberValue(cooldown.direction_correct_rate),
          cooldownCi: numberArray(get(cooldown, 'cluster_bootstrap', 'direction_correct_95ci')),
        })
      }
    }
  }
  return result
}

function chanAnnualRows(walkForward: JsonObject): Array<{
  configuration: string; stage: string; horizon: string; year: string; events: number | null
  rate: number | null; ci: number[] | null; mean: number | null; cooldownEvents: number | null
  cooldownRate: number | null
}> {
  const result: ReturnType<typeof chanAnnualRows> = []
  for (const [configuration, rawConfig] of Object.entries(asObject(walkForward.configurations))) {
    for (const stage of ['first_seen', 'underlying_bi_sure', 'marker_frozen']) {
      for (const horizon of ['5', '10', '20']) {
        const annual = asObject(get(rawConfig, 'stages', stage, horizon, 'annual_overall'))
        for (const [year, rawEvidence] of Object.entries(annual)) {
          const evidence = asObject(rawEvidence)
          const cooldown = asObject(evidence.non_overlapping_horizon_cooldown)
          result.push({
            configuration,
            stage,
            horizon,
            year,
            events: numberValue(evidence.signals),
            rate: numberValue(evidence.direction_correct_rate),
            ci: numberArray(get(evidence, 'cluster_bootstrap', 'direction_correct_95ci')),
            mean: numberValue(evidence.mean_signed_return),
            cooldownEvents: numberValue(cooldown.signals),
            cooldownRate: numberValue(cooldown.direction_correct_rate),
          })
        }
      }
    }
  }
  return result
}

function pill(text: string, tone: 'good' | 'warn' | 'bad' | 'neutral' = 'neutral'): string {
  return `<span class="pill ${tone}">${escapeHtml(text)}</span>`
}

function sidePill(side: string): string {
  return side === 'buy' ? pill('买侧', 'good') : side === 'risk' || side === 'sell' ? pill('风险侧', 'warn') : pill('—')
}

function gatePill(row: { supported?: boolean; gatePassed: boolean; checksPassed: number; checksTotal: number }): string {
  if (row.supported === false) return pill('未启用', 'neutral')
  if (row.gatePassed) return pill(`通过 ${row.checksPassed}/${row.checksTotal}`, 'good')
  return pill(`未通过 ${row.checksPassed}/${row.checksTotal}`, 'bad')
}

function metricCard(kicker: string, value: string, label: string, tone = ''): string {
  return `<article class="metric ${tone}"><p>${escapeHtml(kicker)}</p><strong>${value}</strong><span>${escapeHtml(label)}</span></article>`
}

function tableEmpty(message: string, columns: number): string {
  return `<tr><td colspan="${columns}" class="empty">${escapeHtml(message)}</td></tr>`
}

function productionTierCell(row: ProductionRow): string {
  const judgement = judgeProbability(row)
  return `<div class="period-evidence"><b>${escapeHtml(PERIOD_LABELS[row.period] ?? row.period)}</b>${pill(judgement.label, judgement.tone)}<span>n=${fmtInt(row.events)}；raw ${fmtPct(row.rawRate, 2)}；基线 ${fmtPct(row.expectedRate, 2)}；增量 ${fmtPp(row.uplift)} <small>${fmtPpCi(row.upliftCi)}</small></span></div>`
}

function deployedSignalTable(rows: ProductionRow[]): string {
  const signals = [...new Set(rows.map(row => row.signal))]
  const body = signals.map(signal => {
    const signalRows = rows.filter(row => row.signal === signal && row.supported)
      .toSorted((left, right) => PERIOD_ORDER.indexOf(left.period) - PERIOD_ORDER.indexOf(right.period))
    const sample = signalRows[0] ?? rows.find(row => row.signal === signal)
    const definition = PRODUCTION_RULES[signal]
    const periods = signalRows.map(row => PERIOD_LABELS[row.period] ?? row.period).join(' / ')
    return `<tr>
      <td><strong>${escapeHtml(sample?.label ?? signal)}</strong><small>${escapeHtml(signal)}</small>${sidePill(sample?.side ?? '')}</td>
      <td class="rule">${escapeHtml(definition?.rule ?? '源生产规则；详见 kline-ma.ts。')}</td>
      <td><strong>${escapeHtml(periods || '—')}</strong><small>${signalRows.length === 3 ? '日 / 周 / 月均启用' : '其余周期未接入，不是 0 样本'}</small></td>
      <td class="evidence-stack">${signalRows.map(productionTierCell).join('')}</td>
      <td class="decision">${escapeHtml(definition?.productVerdict ?? '按逐周期统计判定使用。')}</td>
    </tr>`
  }).join('\n')
  return `<div class="table-wrap deployed-table"><table class="data-table"><thead><tr><th>系统已引入的变盘点</th><th>生产规则摘要</th><th>实际启用周期</th><th>当前全量数据怎么说</th><th>我的产品判断</th></tr></thead><tbody>${body || tableEmpty('没有生产标记', 5)}</tbody></table></div>`
}

function productionTable(rows: ProductionRow[]): string {
  const body = rows.map(row => `<tr data-filter-row data-period="${escapeAttr(row.period)}" data-side="${escapeAttr(row.side)}" data-status="${row.supported ? row.gatePassed ? 'pass' : 'fail' : 'off'}" data-search="${escapeAttr(`${row.label} ${row.signal} ${row.period}`.toLowerCase())}">
    <td><strong>${escapeHtml(row.label)}</strong><small>${escapeHtml(row.signal)}</small></td>
    <td>${escapeHtml(PERIOD_LABELS[row.period] ?? row.period)}</td>
    <td>${sidePill(row.side)}</td>
    <td>${row.horizon === null ? '—' : `${fmtInt(row.horizon)} ${escapeHtml(row.horizonUnit)}`}</td>
    <td class="num">${fmtInt(row.events)}</td>
    <td class="num">${fmtInt(row.symbols)}</td>
    <td class="num emphasis">${fmtPct(row.rawRate)}<small>${fmtCi(row.rawCi)}</small></td>
    <td class="num">${fmtPct(row.meanSigned, 2, true)}</td>
    <td class="num">${fmtNumber(row.profitFactor)}</td>
    <td class="num">${row.expectedRate !== null && row.uplift !== null ? fmtPct(row.expectedRate + row.uplift) : '—'}</td>
    <td class="num">${fmtPct(row.expectedRate)}</td>
    <td class="num ${row.uplift !== null && row.uplift > 0 ? 'positive' : row.uplift !== null && row.uplift < 0 ? 'negative' : ''}">${fmtPp(row.uplift)}<small>${fmtPpCi(row.upliftCi)}</small></td>
    <td class="num ${row.signedExcess !== null && row.signedExcess > 0 ? 'positive' : row.signedExcess !== null && row.signedExcess < 0 ? 'negative' : ''}">${fmtPct(row.signedExcess, 2, true)}<small>${fmtCi(row.excessCi)}</small></td>
    <td class="num">${fmtPct(row.matchedCoverage)}</td>
    <td class="num">${fmtP(row.holmP)}</td>
    <td>${gatePill(row)}<small>稳定年 ${fmtInt(row.stableYears)}</small></td>
  </tr>`).join('\n')
  return `<div class="table-wrap"><table class="data-table sortable" id="production-table">
    <thead><tr><th>生产标记</th><th>周期</th><th>方向</th><th>持有期</th><th>事件</th><th>标的</th><th>全主样本 raw / Wilson 95%</th><th>平均方向收益</th><th>PF</th><th>匹配子样本实际</th><th>匹配期望命中率</th><th>匹配命中增益 / 聚类 95%</th><th>匹配收益增量 / 聚类 95%</th><th>匹配覆盖</th><th>Holm p</th><th>发布门禁</th></tr></thead>
    <tbody>${body || tableEmpty('没有生产信号数据', 16)}</tbody>
  </table></div>`
}

function judgeProbability(row: ProductionRow): ProbabilityJudgement {
  if (!row.supported || row.events === null || row.events < 200 || row.upliftCi === null || row.excessCi === null) {
    return {
      tier: 'insufficient', label: 'E · 样本不足', tone: 'neutral',
      explanation: '有效事件不足 200，或关键聚类区间缺失，无法稳定判断。',
      action: '继续积累样本，不据此决策。',
    }
  }
  const directionLow = row.upliftCi[0] ?? -Infinity
  const directionHigh = row.upliftCi[1] ?? Infinity
  const returnLow = row.excessCi[0] ?? -Infinity
  if (directionLow > 0 && returnLow > 0 && row.holmP !== null && row.holmP <= 0.05) {
    return {
      tier: 'dual', label: 'A · 双增量显著', tone: 'good',
      explanation: '命中增量与收益增量的聚类 95% 下界均大于 0，且通过 Holm 校正。',
      action: row.side === 'risk' ? '具有历史风险预警价值；作为降仓/过滤候选，等待前瞻验证。' : '进入最高优先级前瞻候选，尚不能直接上线。',
    }
  }
  if (directionLow > 0) {
    return {
      tier: 'direction', label: 'B · 方向增量', tone: 'warn',
      explanation: '命中增量的聚类 95% 下界大于 0，但收益增量或多重校正未同时满足。',
      action: '可用于观察与排序，不按该比例直接下单。',
    }
  }
  if (directionHigh < 0) {
    return {
      tier: 'adverse', label: 'D · 方向反证', tone: 'bad',
      explanation: '命中增量的聚类 95% 上界小于 0：相同状态下比对照更差。',
      action: '停止按原方向解释；优先检查周期定义或作为反例过滤。',
    }
  }
  return {
    tier: 'unproven', label: 'C · 仅条件概率', tone: 'neutral',
    explanation: '有历史命中比例，但独立命中增量区间跨 0，尚不能归因于标记。',
    action: '只描述场景，不把 raw 比例当作额外胜率。',
  }
}

function probabilityJudgementSection(rows: ProductionRow[]): string {
  const tierOrder: Record<ProbabilityTier, number> = { dual: 0, direction: 1, unproven: 2, adverse: 3, insufficient: 4 }
  const judged = rows.filter(row => row.supported).map(row => ({ row, judgement: judgeProbability(row) }))
    .toSorted((left, right) => tierOrder[left.judgement.tier] - tierOrder[right.judgement.tier]
      || (right.row.upliftCi?.[0] ?? -Infinity) - (left.row.upliftCi?.[0] ?? -Infinity)
      || (right.row.events ?? 0) - (left.row.events ?? 0))
  const counts: Record<ProbabilityTier, number> = { dual: 0, direction: 0, unproven: 0, adverse: 0, insufficient: 0 }
  for (const item of judged) counts[item.judgement.tier] += 1
  const total = judged.length
  const share = (count: number): string => total === 0 ? '—' : `${fmtInt(count)} / ${fmtInt(total)} · ${fmtPct(count / total)}`
  const strongNames = judged.filter(item => item.judgement.tier === 'dual')
    .map(item => `${PERIOD_LABELS[item.row.period]}${item.row.label}`).join('、')
  const positiveInformation = judged.filter(item => item.judgement.tier === 'dual' || item.judgement.tier === 'direction')
  const positiveRiskCount = positiveInformation.filter(item => item.row.side === 'risk').length
  const positiveBuyCount = positiveInformation.filter(item => item.row.side === 'buy').length
  const positiveFamilies = [...new Set(positiveInformation.map(item => item.row.signal.replace(/-weak$/, '')))]
  const body = judged.map(({ row, judgement }) => {
    const matchedObserved = row.expectedRate !== null && row.uplift !== null ? row.expectedRate + row.uplift : null
    const relativeLift = row.expectedRate !== null && row.expectedRate !== 0 && row.uplift !== null
      ? row.uplift / row.expectedRate : null
    const hitFraction = row.directionHits === null || row.events === null
      ? fmtInt(row.events)
      : `${fmtInt(row.directionHits)} / ${fmtInt(row.events)}`
    return `<tr>
      <td>${pill(judgement.label, judgement.tone)}</td>
      <td><strong>${escapeHtml(row.label)}</strong><small>${escapeHtml(`${PERIOD_LABELS[row.period]} · ${row.signal}`)}</small></td>
      <td>${sidePill(row.side)}<small>${row.side === 'risk' ? '未来下跌 / 走弱' : '未来上涨'}</small></td>
      <td class="num emphasis">${fmtPct(row.rawRate, 2)}<small>${hitFraction}；Wilson ${fmtCi(row.rawCi)}</small></td>
      <td class="num">${fmtPct(matchedObserved, 2)}<small>同状态无标记 ${fmtPct(row.expectedRate, 2)}；匹配 n=${fmtInt(row.matchedEvents)}</small></td>
      <td class="num ${row.uplift !== null && row.uplift > 0 ? 'positive' : row.uplift !== null && row.uplift < 0 ? 'negative' : ''}">${fmtPp(row.uplift)}<small>95% ${fmtPpCi(row.upliftCi)}；相对基线 ${fmtPct(relativeLift, 1, true)}</small></td>
      <td class="num ${row.signedExcess !== null && row.signedExcess > 0 ? 'positive' : row.signedExcess !== null && row.signedExcess < 0 ? 'negative' : ''}">${fmtPct(row.signedExcess, 2, true)}<small>95% ${fmtCi(row.excessCi)}</small></td>
      <td><strong>${escapeHtml(judgement.explanation)}</strong><small>Holm p=${fmtP(row.holmP)}</small></td>
      <td class="decision">${escapeHtml(judgement.action)}</td>
    </tr>`
  }).join('\n')
  return `<div class="callout good"><strong>0 个通过完整上线门禁，不等于 0 个有统计价值</strong><span>在 ${fmtInt(total)} 个已启用格中，${fmtInt(counts.dual)} 个同时具有方向与收益增量证据（${escapeHtml(strongNames || '无')}），另有 ${fmtInt(counts.direction)} 个只有方向概率增量。门禁还要求数据完整、稳健性与折外表现，因此“有历史统计信息”和“可生产交易”是两个层级。</span></div>
    <div class="metric-grid probability-metrics">
      ${metricCard('A · 双增量显著', share(counts.dual), '命中+收益增量，且 Holm 合格', counts.dual > 0 ? 'good' : '')}
      ${metricCard('B · 方向增量', share(counts.direction), '命中改善，经济收益未同时确认')}
      ${metricCard('C · 仅条件概率', share(counts.unproven), 'raw 可观察，但独立增量未证实')}
      ${metricCard('D · 方向反证', share(counts.adverse), '同状态下显著差于对照', counts.adverse > 0 ? 'bad' : '')}
      ${metricCard('E · 样本不足', share(counts.insufficient), 'n<200 或区间缺失')}
    </div>
    <div class="candidate-note"><strong>集中性结论：</strong>A/B 共 ${fmtInt(positiveInformation.length)} 格，其中风险侧 ${fmtInt(positiveRiskCount)} 格、买侧 ${fmtInt(positiveBuyCount)} 格；归并弱收子集后仅 ${fmtInt(positiveFamilies.length)} 个规则家族。它们集中于“上涨后巨量分歧/弱收”的日、周、月风险观察，彼此嵌套且跨周期相关，不能当成 ${fmtInt(positiveInformation.length)} 个独立发现。六格剔除最佳 5% 极端贡献后平均方向收益均转负，因此更适合风险预警，不是做空胜率或已验证交易收益。</div>
    <div class="table-wrap probability-table"><table class="data-table"><thead><tr><th>统计等级</th><th>信号 × 周期</th><th>所判方向</th><th>历史命中比例</th><th>匹配实际 / 同状态基线</th><th>独立概率增量</th><th>方向收益增量</th><th>统计判定</th><th>实际语义</th></tr></thead><tbody>${body || tableEmpty('没有可判定的生产格', 9)}</tbody></table></div>
    <p class="footnote">A–E 是展示层对冻结统计字段的确定性映射，不是重新调参或新增回测：先排除 n&lt;200/字段缺失；A 要求命中与收益增量聚类 95% 下界均 &gt;0 且 Holm p≤0.05；B 要求命中增量下界 &gt;0；D 要求命中增量上界 &lt;0；其余为 C。风险侧的“命中”表示之后下跌/走弱，不等于净卖空收益。</p>`
}

function candidateProductDecision(row: ResearchRow): { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral'; note: string } {
  const productionSignal = DEPLOYED_RESEARCH_SIGNALS[row.signal]
  if (productionSignal !== undefined) {
    return {
      label: '已引入系统', tone: 'good',
      note: `对应生产标记 ${productionSignal}；上线后的结论应以本报告第 02–03 节最新生产回测为准。`,
    }
  }
  if (row.signal === 'failed_breakout_raw') {
    return {
      label: '考虑：影子验证', tone: 'warn',
      note: '大样本且与已验证的高位风险家族逻辑一致，但 matched 增量区间跨 0；只建议冻结规则后记录，不建议直接上线。',
    }
  }
  if (row.signal === 'capitulation_retest_confirmed') {
    return {
      label: '考虑：先补样本', tone: 'neutral',
      note: '确认链条有研究价值，但当前主样本仅 75 个事件，远不足以支持引入。',
    }
  }
  if (row.signal === 'bottom_huge_strong_close') {
    return {
      label: '既有同族覆盖', tone: 'neutral',
      note: '系统已有 legacy“深跌强收”同语义点；此 benchmark 使用不同量均线口径与冷却规则，未作为独立变体引入。',
    }
  }
  const adverse = row.upliftCi !== null && (row.upliftCi[1] ?? Infinity) < 0
  return adverse
    ? { label: '暂不引入', tone: 'bad', note: '匹配命中增量显著为负，或确认阶段削弱了原始信号；应作为反例/过滤条件研究。' }
    : { label: '暂不引入', tone: 'neutral', note: '样本内有频率描述，但 matched 增量尚未被统计确认；继续研究，不进入产品决策权重。' }
}

function researchTable(rows: ResearchRow[]): string {
  const body = rows.map(row => `<tr data-candidate-row data-side="${escapeAttr(row.side)}" data-stage="${escapeAttr(row.stage)}" data-search="${escapeAttr(`${row.label} ${row.signal} ${row.rule}`.toLowerCase())}">
    <td><strong>${escapeHtml(row.label)}</strong><small>${escapeHtml(row.signal)}</small></td>
    <td>${(() => { const decision = candidateProductDecision(row); return `${pill(decision.label, decision.tone)}<small>${escapeHtml(decision.note)}</small>` })()}</td>
    <td>${sidePill(row.side)}</td>
    <td>${escapeHtml(STAGE_LABELS[row.stage] ?? (row.stage || '—'))}</td>
    <td>${escapeHtml(row.priority || '—')}</td>
    <td class="num">${fmtInt(row.horizon)}</td>
    <td class="num">${fmtInt(row.events)}</td>
    <td class="num emphasis">${fmtPct(row.rawRate)}<small>${fmtCi(row.rawCi)}</small></td>
    <td class="num">${fmtPct(row.meanSigned, 2, true)}</td>
    <td class="num">${fmtNumber(row.profitFactor)}</td>
    <td class="num">${row.expectedRate !== null && row.uplift !== null ? fmtPct(row.expectedRate + row.uplift) : '—'}<small>期望 ${fmtPct(row.expectedRate)}</small></td>
    <td class="num ${row.uplift !== null && row.uplift > 0 ? 'positive' : row.uplift !== null && row.uplift < 0 ? 'negative' : ''}">${fmtPp(row.uplift)}<small>${fmtPpCi(row.upliftCi)}</small></td>
    <td class="num">${fmtPct(row.signedExcess, 2, true)}<small>${fmtCi(row.excessCi)}</small></td>
    <td class="num">${fmtPct(row.matchedCoverage)}</td>
    <td class="num">${fmtPct(row.validationRate)}</td>
    <td class="num">${fmtPct(row.testRate)}</td>
    <td class="num">${fmtP(row.holmP)}</td>
    <td>${gatePill(row)}<small>稳定年 ${fmtInt(row.stableYears)}</small></td>
    <td><details><summary>规则</summary><p class="rule">${escapeHtml(row.rule || '—')}</p><p class="micro">总体：${escapeHtml(row.population || '—')}</p></details></td>
  </tr>`).join('\n')
  return `<div class="table-wrap"><table class="data-table sortable" id="candidate-table">
    <thead><tr><th>研究候选</th><th>是否引入 / 我的建议</th><th>方向</th><th>阶段</th><th>原优先级</th><th>主周期</th><th>事件</th><th>expanded unseen raw / Wilson 95%</th><th>平均方向收益</th><th>PF</th><th>匹配实际 / 期望</th><th>匹配命中增益 / 95%</th><th>匹配收益增量 / 95%</th><th>匹配覆盖</th><th>验证折</th><th>测试折</th><th>Holm p</th><th>门禁</th><th>定义</th></tr></thead>
    <tbody>${body || tableEmpty('没有研究候选数据', 19)}</tbody>
  </table></div>`
}

function annualProductionTable(rows: ReturnType<typeof annualProductionRows>): string {
  const body = rows.map(row => `<tr data-annual-row data-key="${escapeAttr(row.key)}" data-period="${escapeAttr(row.period)}">
    <td>${escapeHtml(row.label)}<small>${escapeHtml(PERIOD_LABELS[row.period] ?? row.period)}</small></td>
    <td>${escapeHtml(row.year)}</td><td class="num">${fmtInt(row.events)}</td><td class="num emphasis">${fmtPct(row.rate)}</td>
    <td class="num">${fmtCi(row.ci)}</td><td class="num">${fmtPct(row.mean, 2, true)}</td>
  </tr>`).join('\n')
  return `<div class="table-wrap compact-table"><table class="data-table"><thead><tr><th>信号</th><th>信号年（退出不跨年）</th><th>事件</th><th>方向命中率</th><th>Wilson 95%</th><th>平均方向收益</th></tr></thead><tbody>${body || tableEmpty('源数据没有年度诊断字段', 6)}</tbody></table></div>`
}

function periodStudyTable(rows: ReturnType<typeof periodStudyRows>): string {
  function correctRate(row: ReturnType<typeof periodStudyRows>[number], evidence: JsonObject): number | null {
    return numberValue(row.side === 'risk' ? evidence.weak_rate_pct : evidence.up_rate_pct)
  }
  const body = rows.map(row => `<tr data-period-study-row data-period="${escapeAttr(row.period)}">
    <td><strong>${escapeHtml(row.label)}</strong><small>${escapeHtml(row.signal)}</small></td><td>${escapeHtml(PERIOD_LABELS[row.period] ?? row.period)}</td>
    <td>${sidePill(row.side)}</td><td>${fmtInt(row.horizon)} ${escapeHtml(row.unit)}</td>
    <td class="num">${fmtInt(numberValue(row.development.events))}</td><td class="num">${fmtPctAlready(correctRate(row, row.development))}</td>
    <td class="num">${fmtInt(numberValue(row.validation.events))}</td><td class="num">${fmtPctAlready(correctRate(row, row.validation))}</td>
    <td class="num">${fmtInt(numberValue(row.recent.events))}</td><td class="num">${fmtPctAlready(correctRate(row, row.recent))}</td>
    <td class="num">${fmtInt(numberValue(row.product.events))}</td><td class="num emphasis">${fmtPctAlready(correctRate(row, row.product))}</td>
    <td class="num">${fmtPctAlready(numberValue(row.product.mean_return_pct), 2)}</td>
  </tr>`).join('\n')
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>信号</th><th>周期</th><th>方向</th><th>持有期</th><th>开发 n</th><th>开发命中</th><th>验证 n</th><th>验证命中</th><th>近期 n</th><th>近期命中</th><th>产品证据 n</th><th>产品证据命中</th><th>标的平均收益</th></tr></thead><tbody>${body || tableEmpty('没有周期研究数据', 13)}</tbody></table></div>`
}

function chanStageTable(rows: ChanStageRow[]): string {
  const body = rows.map(row => `<tr data-chan-row data-configuration="${escapeAttr(row.configuration)}" data-stage="${escapeAttr(row.stage)}">
    <td>${escapeHtml(CONFIG_LABELS[row.configuration] ?? row.configuration)}</td><td>${escapeHtml(STAGE_LABELS[row.stage] ?? row.stage)}</td><td class="num">${escapeHtml(row.horizon)} 日</td>
    <td class="num">${fmtInt(row.events)}</td><td class="num emphasis">${fmtPct(row.rate)}<small>${fmtCi(row.ci)}</small></td><td class="num">${fmtPct(row.meanSigned, 2, true)}</td>
    <td class="num">${fmtInt(row.cooldownEvents)}</td><td class="num">${fmtPct(row.cooldownRate)}<small>${fmtCi(row.cooldownCi)}</small></td>
  </tr>`).join('\n')
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>参数</th><th>决策阶段</th><th>观察窗</th><th>原始事件</th><th>方向正确率 / 聚类 bootstrap 95%</th><th>平均方向收益</th><th>去重事件</th><th>非重叠冷却后正确率 / 95%</th></tr></thead><tbody>${body || tableEmpty('没有缠论阶段数据', 8)}</tbody></table></div>`
}

function chanAnnualTable(rows: ReturnType<typeof chanAnnualRows>): string {
  const body = rows.map(row => `<tr data-chan-annual-row data-configuration="${escapeAttr(row.configuration)}" data-stage="${escapeAttr(row.stage)}" data-horizon="${escapeAttr(row.horizon)}">
    <td>${escapeHtml(CONFIG_LABELS[row.configuration] ?? row.configuration)}</td><td>${escapeHtml(STAGE_LABELS[row.stage] ?? row.stage)}</td><td>${escapeHtml(row.horizon)} 日</td><td>${escapeHtml(row.year)}</td>
    <td class="num">${fmtInt(row.events)}</td><td class="num emphasis">${fmtPct(row.rate)}<small>${fmtCi(row.ci)}</small></td><td class="num">${fmtPct(row.mean, 2, true)}</td>
    <td class="num">${fmtInt(row.cooldownEvents)}</td><td class="num">${fmtPct(row.cooldownRate)}</td>
  </tr>`).join('\n')
  return `<div class="table-wrap compact-table"><table class="data-table"><thead><tr><th>参数</th><th>阶段</th><th>窗</th><th>年度</th><th>事件</th><th>正确率 / 95%</th><th>平均方向收益</th><th>冷却 n</th><th>冷却正确率</th></tr></thead><tbody>${body || tableEmpty('没有缠论年度前推数据', 9)}</tbody></table></div>`
}

function comparisonSvg(rows: ProductionRow[]): string {
  const drawable = rows.filter(row => row.supported && row.rawRate !== null && row.expectedRate !== null && row.uplift !== null)
  if (drawable.length === 0) return '<p class="empty">匹配对照字段缺失，无法绘图。</p>'
  const width = 1080
  const left = 260
  const right = 40
  const top = 56
  const rowHeight = 31
  const height = top + drawable.length * rowHeight + 50
  const values = drawable.flatMap(row => [row.rawRate as number, row.expectedRate as number, (row.expectedRate as number) + (row.uplift as number)])
  const rawMin = Math.min(...values)
  const rawMax = Math.max(...values)
  const min = Math.max(0, Math.floor((rawMin - 0.05) * 10) / 10)
  const max = Math.min(1, Math.ceil((rawMax + 0.05) * 10) / 10)
  const span = Math.max(0.1, max - min)
  const x = (value: number): number => left + (value - min) / span * (width - left - right)
  const ticks = Array.from({ length: 6 }, (_, index) => min + span * index / 5)
  const grid = ticks.map(tick => `<line x1="${x(tick)}" y1="${top - 18}" x2="${x(tick)}" y2="${height - 28}" class="grid"/><text x="${x(tick)}" y="24" text-anchor="middle" class="axis">${fmtPct(tick, 0)}</text>`).join('')
  const marks = drawable.map((row, index) => {
    const y = top + index * rowHeight
    const raw = row.rawRate as number
    const expected = row.expectedRate as number
    const matchedObserved = expected + (row.uplift as number)
    return `<text x="${left - 12}" y="${y + 4}" text-anchor="end" class="label">${escapeHtml(`${PERIOD_LABELS[row.period]} · ${row.label}`)}</text>
      <line x1="${x(Math.min(matchedObserved, expected))}" y1="${y}" x2="${x(Math.max(matchedObserved, expected))}" y2="${y}" class="connector"/>
      <rect x="${x(expected) - 4}" y="${y - 4}" width="8" height="8" class="expected"><title>匹配期望 ${fmtPct(expected)}</title></rect>
      <circle cx="${x(matchedObserved)}" cy="${y}" r="5.5" class="raw"><title>匹配子样本实际 ${fmtPct(matchedObserved)}</title></circle>
      <circle cx="${x(raw)}" cy="${y}" r="4.5" class="whole"><title>全主样本 raw ${fmtPct(raw)}</title></circle>`
  }).join('')
  return `<div class="svg-wrap"><svg class="comparison" viewBox="0 0 ${width} ${height}" role="img" aria-label="全主样本原始命中率、匹配子样本实际命中率与匹配期望命中率对比">${grid}${marks}
    <g transform="translate(${left},${height - 12})"><circle cx="0" cy="0" r="4.5" class="whole"/><text x="10" y="4" class="legend">全主样本 raw</text><circle cx="125" cy="0" r="5" class="raw"/><text x="136" y="4" class="legend">匹配子样本实际</text><rect x="265" y="-4" width="8" height="8" class="expected"/><text x="281" y="4" class="legend">同状态匹配期望</text></g>
  </svg></div>`
}

function upliftSvg(rows: ProductionRow[]): string {
  const drawable = rows.filter(row => row.supported && row.uplift !== null)
  if (drawable.length === 0) return '<p class="empty">匹配增益字段缺失，无法绘图。</p>'
  const width = 1080
  const left = 260
  const right = 60
  const top = 42
  const rowHeight = 30
  const height = top + drawable.length * rowHeight + 32
  const absolute = Math.max(0.02, ...drawable.map(row => Math.abs(row.uplift as number)), ...drawable.flatMap(row => row.upliftCi?.map(Math.abs) ?? []))
  const bound = Math.ceil(absolute * 20) / 20
  const x = (value: number): number => left + (value + bound) / (2 * bound) * (width - left - right)
  const zero = x(0)
  const marks = drawable.map((row, index) => {
    const y = top + index * rowHeight
    const value = row.uplift as number
    const low = row.upliftCi?.[0] ?? value
    const high = row.upliftCi?.[1] ?? value
    return `<text x="${left - 12}" y="${y + 4}" text-anchor="end" class="label">${escapeHtml(`${PERIOD_LABELS[row.period]} · ${row.label}`)}</text>
      <line x1="${x(low)}" y1="${y}" x2="${x(high)}" y2="${y}" class="ci-line"/><line x1="${x(low)}" y1="${y - 4}" x2="${x(low)}" y2="${y + 4}" class="ci-line"/><line x1="${x(high)}" y1="${y - 4}" x2="${x(high)}" y2="${y + 4}" class="ci-line"/>
      <circle cx="${x(value)}" cy="${y}" r="5" class="${value >= 0 ? 'positive-dot' : 'negative-dot'}"><title>${fmtPct(value, 2, true)}；95% ${fmtCi(row.upliftCi)}</title></circle>`
  }).join('')
  return `<div class="svg-wrap"><svg class="comparison" viewBox="0 0 ${width} ${height}" role="img" aria-label="匹配方向命中增益与两向聚类置信区间"><line x1="${zero}" y1="20" x2="${zero}" y2="${height - 14}" class="zero"/><text x="${zero}" y="15" text-anchor="middle" class="axis">0：无增量</text>${marks}</svg></div>`
}

function selectProductionCase(rows: ProductionRow[]): ProductionRow | null {
  return rows.filter(row => row.supported && row.events !== null)
    .toSorted((left, right) => Number(right.gatePassed) - Number(left.gatePassed)
      || right.checksPassed - left.checksPassed
      || (right.upliftCi?.[0] ?? -Infinity) - (left.upliftCi?.[0] ?? -Infinity)
      || (right.events ?? 0) - (left.events ?? 0))[0] ?? null
}

function selectResearchCase(rows: ResearchRow[]): ResearchRow | null {
  return rows.filter(row => row.events !== null)
    .toSorted((left, right) => Number(right.gatePassed) - Number(left.gatePassed)
      || right.checksPassed - left.checksPassed
      || (right.stableYears ?? 0) - (left.stableYears ?? 0)
      || (right.events ?? 0) - (left.events ?? 0))[0] ?? null
}

function confirmedPair(rows: ResearchRow[]): { anchor: ResearchRow; confirmed: ResearchRow; delta: number | null } | null {
  const pairs: Array<{ anchor: ResearchRow; confirmed: ResearchRow; delta: number | null }> = []
  const families = [...new Set(rows.map(row => row.family).filter(Boolean))]
  for (const family of families) {
    const familyRows = rows.filter(row => row.family === family)
    const anchor = familyRows.find(row => row.stage === 'anchor' || row.signal.endsWith('_raw'))
    const confirmed = familyRows.find(row => row.stage === 'confirmed' && row !== anchor)
    if (anchor === undefined || confirmed === undefined) continue
    pairs.push({ anchor, confirmed, delta: anchor.rawRate !== null && confirmed.rawRate !== null ? confirmed.rawRate - anchor.rawRate : null })
  }
  return pairs.toSorted((left, right) => (right.delta ?? -Infinity) - (left.delta ?? -Infinity))[0] ?? null
}

function crossPeriodCase(rows: ProductionRow[]): ProductionRow[] {
  const groups = new Map<string, ProductionRow[]>()
  for (const row of rows.filter(item => item.supported && item.rawRate !== null && item.events !== null && item.events > 0)) {
    const group = groups.get(row.signal) ?? []
    group.push(row)
    groups.set(row.signal, group)
  }
  return [...groups.values()].filter(group => PERIOD_ORDER.every(period => group.some(row => row.period === period)))
    .toSorted((left, right) => Math.min(...right.map(row => row.rawRate as number)) - Math.min(...left.map(row => row.rawRate as number)))[0]
    ?.toSorted((left, right) => PERIOD_ORDER.indexOf(left.period) - PERIOD_ORDER.indexOf(right.period)) ?? []
}

function selectChanCase(rows: ChanStageRow[]): ChanStageRow | null {
  return rows.filter(row => row.configuration === 'official_default_daily_morphology'
      && row.cooldownEvents !== null && row.cooldownEvents >= 50 && row.cooldownRate !== null)
    .toSorted((left, right) => (right.cooldownCi?.[0] ?? -Infinity) - (left.cooldownCi?.[0] ?? -Infinity)
      || (right.cooldownEvents ?? 0) - (left.cooldownEvents ?? 0))[0] ?? null
}

function caseCard(code: string, title: string, selection: string, metric: string, evidence: string, next: string): string {
  return `<article class="case-card"><div class="case-code">${escapeHtml(code)}</div><div><h3>${escapeHtml(title)}</h3><p class="selection">${escapeHtml(selection)}</p><strong class="case-metric">${metric}</strong><p>${evidence}</p><p class="next"><b>验证条件：</b>${escapeHtml(next)}</p></div></article>`
}

function casesSection(production: ProductionRow[], research: ResearchRow[], chan: ChanStageRow[]): string {
  const p1 = selectProductionCase(production)
  const p2 = selectResearchCase(research)
  const p3 = confirmedPair(research)
  const p4 = crossPeriodCase(production)
  const p5 = selectChanCase(chan)
  const p1Card = p1 === null
    ? caseCard('P1', '生产门禁领先项', '无可计算行', '—', '生产字段缺失。', '补齐全量生产 JSON。')
    : caseCard('P1', `生产门禁领先：${p1.label} · ${PERIOD_LABELS[p1.period]}`, '按门禁是否通过 → 通过检查数 → 匹配增益置信下界 → 样本量排序；不是按最高胜率挑选。', fmtPct(p1.rawRate), `全主样本 n=${fmtInt(p1.events)}；匹配子样本实际 ${p1.expectedRate !== null && p1.uplift !== null ? fmtPct(p1.expectedRate + p1.uplift) : '—'}，期望 ${fmtPct(p1.expectedRate)}；增益 ${fmtPct(p1.uplift, 2, true)}，95% ${fmtCi(p1.upliftCi)}；门禁 ${p1.checksPassed}/${p1.checksTotal}${p1.gatePassed ? '，通过' : '，未通过'}。`, '必须在新的时间样本继续满足发布门禁，且匹配增益与收益增量置信下界同时大于 0。')
  const p2Card = p2 === null
    ? caseCard('P2', '全市场研究领先项', '无可计算行', '—', '候选字段缺失。', '补齐全市场研究 JSON。')
    : caseCard('P2', `研究门禁领先：${p2.label}`, '在冻结的 16 候选内按门禁是否通过 → 通过检查数 → 稳定年数 → 样本量排序。', fmtPct(p2.rawRate), `expanded unseen n=${fmtInt(p2.events)}；验证折 ${fmtPct(p2.validationRate)}，测试折 ${fmtPct(p2.testRate)}；匹配增益 ${fmtPct(p2.uplift, 2, true)}，95% ${fmtCi(p2.upliftCi)}；Holm p=${fmtP(p2.holmP)}。`, '不得改规则后复用同一测试折；需在冻结 cutoff 后积累前瞻样本。')
  const p3Card = p3 === null
    ? caseCard('P3', '锚点→确认的增量案例', '没有可配对家族', '—', '源数据未提供可比的 anchor/confirmed 配对。', '冻结配对定义后再测试确认是否真正增加信息。')
    : caseCard('P3', `确认增量：${p3.confirmed.label}`, '在同 family 的锚点/确认配对中，探索性选择原始命中率提升最大的一对；存在选择偏差。', fmtPct(p3.confirmed.rawRate), `锚点 ${p3.anchor.label}：${fmtPct(p3.anchor.rawRate)}（n=${fmtInt(p3.anchor.events)}）；确认：${fmtPct(p3.confirmed.rawRate)}（n=${fmtInt(p3.confirmed.events)}）；差值 ${fmtPct(p3.delta, 2, true)}。确认项匹配增益 ${fmtPct(p3.confirmed.uplift, 2, true)}。`, '把“确认日更晚、样本更少”纳入比较；必须比较同一 entry clock 下的匹配增益，而不只比较 raw 差值。')
  const p4Metric = p4.length === 0 ? '—' : p4.map(row => `${PERIOD_LABELS[row.period]} ${fmtPct(row.rawRate)}`).join(' · ')
  const p4Evidence = p4.length === 0 ? '没有三个周期均具备成熟事件的同名信号。' : `${escapeHtml(p4[0]?.label ?? '')} 在三个周期中“最低方向命中率”最高；各期 n=${p4.map(row => `${PERIOD_LABELS[row.period]} ${fmtInt(row.events)}`).join(' / ')}。这只是跨周期一致性筛选，不代表三个信号独立，也没有把概率相乘。`
  const p4Card = caseCard('P4', `跨周期共振${p4.length === 0 ? '' : `：${p4[0]?.label ?? ''}`}`, '要求同一生产标记在日/周/月都有成熟事件，再按三个周期的最低 raw 命中率排序。', p4Metric, p4Evidence, '同一标的同一日期的多周期事件应合并为一次决策，并用按标的与月份聚类的前瞻评估，严禁把三个命中率相乘。')
  const p5Card = p5 === null
    ? caseCard('P5', '缠论阶段/冷却案例', '官方默认参数中没有 n≥50 的可计算组合', '—', '阶段证据不足。', '扩大完全点时可得的冻结标记样本。')
    : caseCard('P5', `缠论决策阶段：${STAGE_LABELS[p5.stage]} · ${p5.horizon} 日`, '仅在官方默认参数、非重叠持有期冷却、n≥50 的九个阶段×观察窗中，按 bootstrap 95% 下界排序；属于探索性比较。', fmtPct(p5.cooldownRate), `冷却后 n=${fmtInt(p5.cooldownEvents)}，方向正确率 ${fmtPct(p5.cooldownRate)}，聚类 bootstrap 95% ${fmtCi(p5.cooldownCi)}；未冷却 n=${fmtInt(p5.events)}，正确率 ${fmtPct(p5.rate)}。`, '固定阶段与观察窗后，逐年 walk-forward；同时报告标记确认延迟与失效率。')
  return [p1Card, p2Card, p3Card, p4Card, p5Card].join('\n')
}

function auditRiskCards(production: JsonObject, rows: ProductionRow[], chan: JsonObject): string {
  const universe = asObject(production.universe)
  const metadata = asObject(production.metadata)
  const overlap = asObject(production.marker_overlap)
  const lifecycle = asObject(get(chan, 'configurations', 'official_default_daily_morphology', 'lifecycle'))
  const periodComplete = asObject(metadata.period_evidence_complete)
  const periodEvaluable = asObject(universe.period_evaluable_securities)
  const periodFirst = asObject(universe.period_first_date)
  const periodLast = asObject(universe.period_last_date)
  const dailyManifest = asObject(metadata.daily_manifest_audit)
  const monthManifest = asObject(metadata.native_month_manifest_audit)
  const supported = rows.filter(row => row.supported)
  const coverages = supported.map(row => row.matchedCoverage).filter((value): value is number => value !== null)
  const completeText = (period: string): string => typeof periodComplete[period] === 'boolean'
    ? periodComplete[period] === true ? '完整' : '不完整'
    : '—'
  const cards = [
    ['样本宇宙', production.metadata && get(production, 'metadata', 'diagnostic_subset') === true ? '诊断子集' : '全量请求', `请求 ${fmtInt(numberValue(universe.securities_requested))}，载入 ${fmtInt(numberValue(universe.cache_files_loaded))}；“全量请求”不掩盖 manifest 失败，且当前上市样本会引入生存者偏差。`],
    ['证据完整性', `日 ${completeText('daily')} · 周 ${completeText('weekly')} · 月 ${completeText('monthly')}`, `日线 manifest 失败 ${fmtInt(numberValue(dailyManifest.failed))}；原生月线 manifest 失败 ${fmtInt(numberValue(monthManifest.failed))}。门禁应把不完整周期强制判失败。`],
    ['周期可评估证券', `日 ${fmtInt(numberValue(periodEvaluable.daily))} · 周 ${fmtInt(numberValue(periodEvaluable.weekly))} · 月 ${fmtInt(numberValue(periodEvaluable.monthly))}`, '满足 121 根预热与最大主观察窗的证券数；为 0 的周期不能称为已完成全量回测。'],
    ['实际证据窗口', `D ${stringValue(periodFirst.daily) || '—'} · W ${stringValue(periodFirst.weekly) || '—'} · M ${stringValue(periodFirst.monthly) || '—'}`, `各周期最早源数据日期；共同截止约 ${stringValue(periodLast.daily) || '—'}。三个周期不是同一起点样本，不能直接比较长期稳定性。`],
    ['右删失标记', fmtInt(numberValue(universe.marker_events_right_censored_by_horizon)), '截止日前已出现、但尚未走完各自主观察窗的生产标记；它们不进入胜率分母，也不按截止日强平。'],
    ['历史长度', fmtInt(numberValue(universe.securities_near_1900_row_provider_cap)), `接近 1,900 行供应商上限的标的数；字段缺失时为“—”。${stringValue(universe.provider_history_cap_warning)}`],
    ['复权因子缺口', fmtInt(numberValue(universe.sina_files_with_zero_factor_dates)), 'Sina 文件中 factor_dates=0 的数量；这些文件退化为原始价，除权附近可能制造伪深跌/伪收益，门禁结论需换源敏感性复核。'],
    ['匹配覆盖', coverages.length === 0 ? '—' : fmtPct(Math.min(...coverages)), '生产格中最低匹配覆盖率；低覆盖意味着 matched 结论只适用于成功找到对照的子样本。'],
    ['信号重叠', fmtInt(numberValue(overlap.multi_marker_symbol_period_dates)), `同标的/周期/日期的多标记格数；最多叠加 ${fmtInt(numberValue(overlap.maximum_markers_on_one_bar))} 个，相关证据不能相乘。`],
    ['缠论重绘风险', fmtPct(numberValue(lifecycle.provisional_invalidation_before_bi_sure_rate)), `初见 provisional 在底层笔确认前失效率；冻结率 ${fmtPct(numberValue(lifecycle.provisional_marker_freeze_rate))}，冻结中位延迟 ${fmtNumber(numberValue(lifecycle.median_marker_freeze_lag_bars_from_anchor), 1)} bars。`],
    ['多重检验', fmtInt(numberValue(get(production, 'primary_hypotheses', 'estimable_tests_with_matched_controls')) ?? numberValue(get(production, 'primary_hypotheses', 'tests_with_matched_controls'))), `具备 matched control 的可估检验数；总家族 ${fmtInt(numberValue(get(production, 'primary_hypotheses', 'family_size')) ?? numberValue(get(production, 'primary_hypotheses', 'gates_total')))}，使用 Holm family-wise 校正。`],
  ]
  return cards.map(([title, value, body]) => `<article class="risk-card"><p>${escapeHtml(title)}</p><strong>${value}</strong><span>${escapeHtml(body)}</span></article>`).join('\n')
}

function limitationsList(...artifacts: JsonObject[]): string {
  const rows: string[] = []
  for (const artifact of artifacts) {
    for (const item of asArray(artifact.limitations)) if (typeof item === 'string') rows.push(item)
    for (const item of asArray(get(artifact, 'metadata', 'limitations'))) if (typeof item === 'string') rows.push(item)
  }
  const unique = [...new Set(rows)]
  return unique.length === 0
    ? '<li>—</li>'
    : unique.map(item => `<li>${escapeHtml(item)}</li>`).join('\n')
}

function sourceCard(label: string, path: string, artifact: JsonObject): string {
  const generated = stringValue(get(artifact, 'metadata', 'generated_at')) || stringValue(artifact.generated_at)
  const start = stringValue(get(artifact, 'metadata', 'requested_start'))
  const end = stringValue(get(artifact, 'metadata', 'requested_end'))
  const periodFirst = asObject(get(artifact, 'universe', 'period_first_date'))
  const periodLast = asObject(get(artifact, 'universe', 'period_last_date'))
  const actualPeriodRange = PERIOD_ORDER.some(period => typeof periodFirst[period] === 'string')
    ? PERIOD_ORDER.map(period => `${PERIOD_LABELS[period]} ${stringValue(periodFirst[period]) || '—'}→${stringValue(periodLast[period]) || '—'}`).join('；')
    : ''
  const range = actualPeriodRange || `${start || '—'} → ${end || '—'}`
  return `<article class="source-card"><h3>${escapeHtml(label)}</h3><code>${escapeHtml(relative(ROOT, path))}</code><dl><div><dt>生成</dt><dd>${escapeHtml(generated || '—')}</dd></div><div><dt>区间</dt><dd title="${escapeAttr(range)}">${escapeHtml(range)}</dd></div><div><dt>SHA-256</dt><dd title="${sha256(path)}">${sha256(path).slice(0, 16)}…</dd></div></dl></article>`
}

function industryEvidenceCards(): string {
  return INDUSTRY_SOURCES.map(source => `<article class="source-card"><h3><a href="${escapeAttr(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.title)} ↗</a></h3><p class="micro">${escapeHtml(source.finding)}</p></article>`).join('\n')
}

function nextGenerationHypotheses(): string {
  const rows = [
    ['H1 · 市场/行业同向拐点', '指数 close>MA20 且 MA20 上行；行业由弱转强；个股触发低位反包/回稳', '与同日、同板块、同回撤、同流动性但无形态者比较', 'matched 命中与收益增量的聚类 95% 下界均 > 0'],
    ['H2 · 强相对强度回踩再启动', '中期 RS 前 30%；MA20>MA60；缩量回踩后收复 MA20/前高', '分离趋势延续与真正 V 形反转，不与深度超跌混池', '胜率、赔率、2×成本、去最好 5% 后均值同时过关'],
    ['H3 · 行业残差极端 + 恐慌收回', '剔除行业/指数收益后的个股残差极端；深回撤、放量、CLV 强收', '事件日之前拟合残差模型；禁止使用未来成分股', 'purged walk-forward 中 matched excess CI 下界 > 0'],
    ['H4 · 失败突破确认型风险门', '高位突破失败锚点后 1–3 日收破锚点低，不把锚点日直接称卖点', '比较“继续持有”与“规避损失”，不宣称可卖空收益', '避免损失增量跨三段时期稳定，且极端行情不反转为负'],
    ['H5 · 简单校准元过滤器', '仅用事前市场状态、RS、回撤、量比、波动、板块、流动性；限制复杂度', '嵌套 purged walk-forward；与每个单形态和无形态基线比较', 'Brier/校准、top-decile coverage、DSR/PBO 与组合成本共同验收'],
  ]
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>待冻结 case</th><th>事前定义</th><th>关键反事实</th><th>可证伪门槛</th></tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td class="rule">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
}

function shadowValidationRoadmap(production: ProductionRow[], research: ResearchRow[]): string {
  const dailyRisk = production.find(row => row.signal === 'post-rise-huge-volume' && row.period === 'daily')
  const riskPeriods = production.filter(row => row.signal === 'post-rise-huge-volume' && row.supported)
    .toSorted((left, right) => PERIOD_ORDER.indexOf(left.period) - PERIOD_ORDER.indexOf(right.period))
  const failedBreakout = research.find(row => row.signal === 'failed_breakout_raw')
  const capitulationRetest = research.find(row => row.signal === 'capitulation_retest_confirmed')
  const rows = [
    ['S0 · 现有巨量风险族统一评分', '已有生产证据', `日线 n=${fmtInt(dailyRisk?.events ?? null)}，下跌命中 ${fmtPct(dailyRisk?.rawRate ?? null, 2)}，matched 增量 ${fmtPp(dailyRisk?.uplift ?? null)}，95% ${fmtPpCi(dailyRisk?.upliftCi ?? null)}；收益增量 ${fmtPct(dailyRisk?.signedExcess ?? null, 2, true)}，95% ${fmtCi(dailyRisk?.excessCi ?? null)}。`, '优先接入收盘 final 后的 scanner / risk ranking；输出风险增强与规避损失，不输出做空胜率。'],
    ['S1 · 跨周期巨量分歧共振', '考虑新组合', riskPeriods.map(row => `${PERIOD_LABELS[row.period]} ${fmtPct(row.rawRate, 2)}（n=${fmtInt(row.events)}）`).join('；') + '。当前没有同一标的同一时点交集的冻结胜率，三者不可相乘。', '新建事件级交集、去重和边际增量回测；未得到交集数据前不新增“共振胜率”。'],
    ['S1 · 放量假突破观察', '未上线候选', `n=${fmtInt(failedBreakout?.events ?? null)}，未来走弱 raw ${fmtPct(failedBreakout?.rawRate ?? null, 2)}，基线 ${fmtPct(failedBreakout?.expectedRate ?? null, 2)}，uplift ${fmtPp(failedBreakout?.uplift ?? null)}，95% ${fmtPpCi(failedBreakout?.upliftCi ?? null)}。`, '只进影子事件账本；叠加指数/行业弱势条件后重新冻结，当前版本不进默认 UI。'],
    ['S2 · 底部恐慌→缩量不破→转强', '补样本候选', `n=${fmtInt(capitulationRetest?.events ?? null)}，上涨 raw ${fmtPct(capitulationRetest?.rawRate ?? null, 2)}，uplift ${fmtPp(capitulationRetest?.uplift ?? null)}，95% ${fmtPpCi(capitulationRetest?.upliftCi ?? null)}。`, '保留规则积累样本，至少 n≥200 再判；当前绝不引入。'],
  ]
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>优先级 / case</th><th>当前状态</th><th>现在能诚实报告的数据</th><th>建议动作</th></tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td class="rule">${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
}

function legacyAdverseCase(artifact: JsonObject): string {
  const evidence = asObject(get(
    artifact,
    'study', 'ma5_ma10', 'contexts', 'adverse_confirmation', 'events',
    'post_rise_huge_volume_weak', 'horizons', '10',
  ))
  const nonOverlap = asObject(evidence.non_overlapping)
  const matched = asObject(evidence.same_date_matched_control)
  const nonOverlapCi = numberArray(get(nonOverlap, 'cluster_bootstrap', 'direction_rate_95ci'))
  const upliftCi = numberArray(get(matched, 'cluster_bootstrap', 'direction_lift_95ci'))
  const returnCi = numberArray(get(matched, 'cluster_bootstrap', 'mean_return_lift_95ci'))
  return `<div class="callout"><strong>最值得继续验证的既有风险 case：上涨后巨量弱收盘 · 10 日</strong><span>逆风历史成分样本的非重叠事件 n=${fmtInt(numberValue(nonOverlap.events))}、${fmtInt(numberValue(nonOverlap.symbols))} 股，后续下跌率 ${fmtPct(numberValue(nonOverlap.direction_correct_rate))}，股票聚类 bootstrap 95% ${fmtCi(nonOverlapCi)}。同日匹配 n=${fmtInt(numberValue(matched.matched_events))}：事件 ${fmtPct(numberValue(matched.event_direction_rate))} vs 对照 ${fmtPct(numberValue(matched.control_direction_rate))}，命中增量 ${fmtPct(numberValue(matched.direction_lift), 2, true)}，95% ${fmtCi(upliftCi)}；方向收益增量 ${fmtPct(numberValue(matched.mean_signed_return_lift), 2, true)}，95% ${fmtCi(returnCi)}。这是“减仓/风控研究”而非卖空结论；样本池较窄、每事件最多 3 个对照且未纳入本次 22 格 Holm 家族，所以仍是探索性证据。</span></div>`
}

function render(args: Args): string {
  const production = readJson(args.production)
  const fullMarket = readJson(args.fullMarket)
  const periodStudy = readJson(args.periodStudy)
  const chanStability = readJson(args.chanStability)
  const chanWalkForward = readJson(args.chanWalkForward)
  const legacyTurning = readJson(LEGACY_CASE_PATH)
  const prodRows = productionRows(production)
  const supportedRows = prodRows.filter(row => row.supported)
  const research = researchRows(fullMarket)
  const annual = annualProductionRows(prodRows)
  const periodRows = periodStudyRows(periodStudy)
  const chanRows = chanStageRows(chanStability)
  const chanAnnual = chanAnnualRows(chanWalkForward)
  const diagnosticSubset = get(production, 'metadata', 'diagnostic_subset') === true
  const periodEvidence = asObject(get(production, 'metadata', 'period_evidence_complete'))
  const sourceIncomplete = Object.values(periodEvidence).some(value => value === false)
  const gatesPassed = numberValue(get(production, 'primary_hypotheses', 'gates_passed'))
    ?? supportedRows.filter(row => row.gatePassed).length
  const gatesTotal = numberValue(get(production, 'primary_hypotheses', 'gates_total')) ?? supportedRows.length
  const gatesWithoutIntegrity = numberValue(get(production, 'primary_hypotheses', 'gates_passing_except_run_integrity'))
  const researchPassed = research.filter(row => row.gatePassed).length
  const rawSixtyNoMatched = supportedRows.filter(row => (row.rawRate ?? -Infinity) >= 0.60
    && row.upliftCi !== null && (row.upliftCi[0] ?? Infinity) <= 0).length
  const probabilityJudgements = supportedRows.map(judgeProbability)
  const dualEvidenceCount = probabilityJudgements.filter(item => item.tier === 'dual').length
  const directionEvidenceCount = probabilityJudgements.filter(item => item.tier === 'direction').length
  const bestProduction = selectProductionCase(prodRows)
  const chanLifecycle = asObject(get(chanStability, 'configurations', 'official_default_daily_morphology', 'lifecycle'))
  const verdict = gatesPassed === 0
    ? `上线结论：没有生产信号×周期格通过完整门禁；统计结论并非“全部无价值”：${fmtInt(dualEvidenceCount)} 格有方向+收益双增量，${fmtInt(directionEvidenceCount)} 格有方向增量。`
    : `${fmtInt(gatesPassed)} 个生产信号×周期格通过历史门禁；这仍不是未来收益保证，必须继续做 cutoff 后前瞻验证。`
  const statusTone = gatesPassed === 0 ? 'bad' : 'good'
  const prodKeys = supportedRows.map(row => `<option value="${escapeAttr(row.key)}">${escapeHtml(`${PERIOD_LABELS[row.period]} · ${row.label}`)}</option>`).join('')
  const generatedAt = new Date().toISOString()
  const productionGeneratedAt = stringValue(get(production, 'metadata', 'generated_at'))
  const roundTripCost = numberValue(get(production, 'metadata', 'cost_model_for_buy_direction', 'approximate_round_trip_current'))
    ?? numberValue(get(production, 'metadata', 'cost_model_for_buy_direction', 'approximate_round_trip'))
  const sourceCards = [
    sourceCard('生产 10 类全量回测', args.production, production),
    sourceCard('全市场 16 候选研究', args.fullMarket, fullMarket),
    sourceCard('K 线周期研究', args.periodStudy, periodStudy),
    sourceCard('缠论信号稳定性', args.chanStability, chanStability),
    sourceCard('缠论逐年前推', args.chanWalkForward, chanWalkForward),
    sourceCard('量价转折历史 case', LEGACY_CASE_PATH, legacyTurning),
  ].join('\n')
  const industryCards = industryEvidenceCards()
  const command = `pnpm tsx scripts/research/render-turning-point-capability-report.ts${args.production === DEFAULTS.production ? '' : ` --production ${relative(ROOT, args.production)}`} --output ${relative(ROOT, args.output)}`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="description" content="hanai-investment-dsh 变盘点能力全量审计：生产信号、匹配对照、年度稳定性、研究候选与缠论证据。">
<title>Hanai 变盘点能力审计 · 2026-08-23</title>
<style>
:root{--ink:#142033;--muted:#657083;--paper:#f5f2ea;--card:#fffdf8;--line:#d9d4c7;--navy:#15263e;--blue:#1f6090;--cyan:#50a9b8;--red:#b94141;--green:#28745b;--amber:#a26716;--shadow:0 14px 35px rgba(20,32,51,.09);--radius:18px;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;--serif:"Noto Serif SC","Songti SC",STSong,serif}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);line-height:1.65}a{color:inherit}button,input,select{font:inherit}.page{max-width:1520px;margin:auto;padding:0 34px 96px}.hero{position:relative;overflow:hidden;margin:0 -34px 34px;padding:76px max(34px,calc((100vw - 1450px)/2)) 58px;background:var(--navy);color:#fff}.hero:after{content:"";position:absolute;right:-120px;top:-160px;width:520px;height:520px;border:1px solid rgba(255,255,255,.12);border-radius:50%;box-shadow:0 0 0 80px rgba(255,255,255,.025),0 0 0 160px rgba(255,255,255,.018)}.eyebrow{display:flex;gap:12px;align-items:center;text-transform:uppercase;letter-spacing:.16em;font-size:12px;color:#91cbd3}.eyebrow:before{content:"";width:42px;height:2px;background:#91cbd3}.hero h1{position:relative;max-width:1020px;margin:17px 0 14px;font:700 clamp(38px,5.4vw,76px)/1.08 var(--serif);letter-spacing:-.04em}.hero h1 em{font-style:normal;color:#8ed1d6}.hero .lede{max-width:900px;margin:0;font-size:18px;color:#d3dce8}.hero-meta{display:flex;flex-wrap:wrap;gap:12px 30px;margin-top:28px;color:#9dafc2;font-size:13px}.subset-banner{margin:24px 0 0;padding:14px 18px;border:1px solid #d99d43;background:#fff5db;color:#6b4311;border-radius:12px;font-weight:700}.layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:30px}.toc{position:sticky;top:20px;align-self:start;padding:18px;border:1px solid var(--line);border-radius:16px;background:rgba(255,253,248,.88);backdrop-filter:blur(14px)}.toc b{display:block;margin-bottom:9px;font-size:12px;letter-spacing:.13em;text-transform:uppercase;color:var(--muted)}.toc a{display:block;padding:7px 9px;text-decoration:none;border-radius:8px;font-size:13px;color:#4b586a}.toc a:hover,.toc a.active{background:#e7edf0;color:var(--navy)}.toc .actions{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:15px}.btn{border:1px solid var(--line);border-radius:8px;padding:7px;background:#fff;cursor:pointer;font-size:12px}.btn:hover{border-color:var(--blue)}main{min-width:0}.section{scroll-margin-top:20px;margin-bottom:34px;padding:32px;background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}.section-head{display:grid;grid-template-columns:80px 1fr;gap:18px;margin-bottom:24px}.section-number{font:700 13px/1 var(--mono);letter-spacing:.1em;color:var(--blue);padding-top:10px}.section h2{margin:0;font:700 clamp(25px,3vw,38px)/1.2 var(--serif);letter-spacing:-.025em}.section .intro{max-width:970px;margin:8px 0 0;color:var(--muted)}.callout{padding:18px 20px;border-left:4px solid var(--blue);background:#edf3f5;border-radius:0 12px 12px 0}.callout.bad{border-color:var(--red);background:#fbefeb}.callout.good{border-color:var(--green);background:#edf7f1}.callout strong{display:block;font-size:20px;margin-bottom:3px}.metric-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin:20px 0}.metric{min-height:140px;padding:18px;border:1px solid var(--line);border-radius:14px;background:#fff}.metric p{margin:0;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.07em}.metric strong{display:block;margin:10px 0 4px;font:700 30px/1.1 var(--serif)}.metric span{display:block;color:var(--muted);font-size:12px}.metric.bad strong{color:var(--red)}.metric.good strong{color:var(--green)}.filters{display:flex;flex-wrap:wrap;gap:9px;align-items:end;margin:18px 0}.filter{display:grid;gap:4px}.filter label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em}.filter input,.filter select{height:38px;padding:0 10px;border:1px solid var(--line);border-radius:9px;background:#fff;color:var(--ink)}.filter input{min-width:240px}.count{margin-left:auto;color:var(--muted);font-size:13px}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:13px;background:#fff}.data-table{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap}.data-table th{position:sticky;top:0;z-index:1;padding:11px 10px;background:#edf0ef;color:#4b5664;text-align:left;font-size:11px;line-height:1.25;border-bottom:1px solid var(--line)}.data-table td{padding:10px;border-bottom:1px solid #ece8df;vertical-align:top}.data-table tbody tr:hover{background:#f8faf9}.data-table tbody tr:last-child td{border-bottom:0}.data-table small{display:block;color:var(--muted);font-size:10px}.data-table .num{text-align:right;font-variant-numeric:tabular-nums}.data-table .emphasis{font-weight:700;color:var(--navy)}.data-table .positive{color:var(--green);font-weight:700}.data-table .negative{color:var(--red);font-weight:700}.data-table .empty,.empty{padding:26px;text-align:center;color:var(--muted)}.compact-table{max-height:560px}.pill{display:inline-block;padding:3px 7px;border-radius:999px;background:#edf0f2;color:#586576;font-size:10px;font-weight:700}.pill.good{background:#e2f2e9;color:#216346}.pill.warn{background:#fff0d4;color:#80520f}.pill.bad{background:#f8e2de;color:#963b35}.chart-grid{display:grid;grid-template-columns:1fr;gap:16px;margin:20px 0}.chart-card{padding:18px;border:1px solid var(--line);border-radius:14px;background:#fbfcfa}.chart-card h3{margin:0 0 3px;font-size:16px}.chart-card p{margin:0 0 12px;color:var(--muted);font-size:12px}.svg-wrap{overflow:auto}.comparison{display:block;width:100%;min-width:760px;height:auto}.comparison .grid{stroke:#dfe4e5;stroke-width:1}.comparison .axis,.comparison .legend{font:11px var(--sans);fill:#768191}.comparison .label{font:11px var(--sans);fill:#354356}.comparison .connector{stroke:#b7c1c7;stroke-width:3}.comparison .raw{fill:var(--blue)}.comparison .expected{fill:var(--amber)}.comparison .ci-line{stroke:#7c8998;stroke-width:2}.comparison .zero{stroke:#a7afb8;stroke-width:1;stroke-dasharray:4 4}.comparison .positive-dot{fill:var(--green)}.comparison .negative-dot{fill:var(--red)}.split{display:grid;grid-template-columns:1fr 1fr;gap:16px}.formula{padding:18px;border:1px solid #cfdbe0;background:#f3f7f8;border-radius:13px}.formula code{display:block;margin:8px 0;font:600 14px/1.6 var(--mono);color:#154c68;white-space:normal}.formula p{margin:0;color:var(--muted);font-size:13px}.candidate-note{padding:13px 16px;border:1px dashed #b9a276;border-radius:10px;background:#fff9e9;color:#72551e}.rule{white-space:normal;max-width:520px;margin:8px 0}.micro{font-size:11px;color:var(--muted)}.chan-lifecycle{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:18px 0}.chan-lifecycle div{padding:15px;background:#eef4f3;border-radius:12px}.chan-lifecycle dt{font-size:11px;color:var(--muted)}.chan-lifecycle dd{margin:5px 0 0;font:700 23px var(--serif)}.risk-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.risk-card{padding:18px;border:1px solid var(--line);border-radius:14px;background:#fff}.risk-card p{margin:0;color:var(--muted);font-size:12px}.risk-card strong{display:block;margin:7px 0;font:700 25px var(--serif);color:var(--red)}.risk-card span{display:block;font-size:12px;color:#596577}.limitations{columns:2;column-gap:36px;padding-left:20px}.limitations li{break-inside:avoid;margin-bottom:10px;color:#586375;font-size:12px}.case-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}.case-card{position:relative;display:grid;grid-template-columns:58px 1fr;gap:16px;padding:21px;border:1px solid var(--line);border-radius:15px;background:#fff}.case-card:nth-child(5){grid-column:1/-1}.case-code{display:grid;place-items:center;width:52px;height:52px;border-radius:50%;background:var(--navy);color:#fff;font:700 15px var(--mono)}.case-card h3{margin:0;font:700 18px var(--serif)}.case-card p{margin:6px 0;color:#526071;font-size:12px}.case-card .selection{color:var(--muted);font-style:italic}.case-metric{display:block;margin:10px 0;color:var(--blue);font:700 23px var(--serif)}.case-card .next{padding-top:8px;border-top:1px solid #e7e2d8}.source-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.source-card{padding:17px;border:1px solid var(--line);border-radius:13px;background:#fff;min-width:0}.source-card h3{margin:0 0 6px;font-size:14px}.source-card code{display:block;overflow:hidden;text-overflow:ellipsis;color:var(--blue);font:11px var(--mono)}.source-card dl{margin:10px 0 0}.source-card dl div{display:flex;gap:9px;font-size:11px}.source-card dt{width:48px;color:var(--muted)}.source-card dd{margin:0;overflow:hidden;text-overflow:ellipsis}.repro{margin-top:18px;padding:18px;border-radius:12px;background:#132136;color:#dbe8ee;overflow:auto}.repro code{font:12px var(--mono);white-space:pre}.footnote{font-size:11px;color:var(--muted)}.no-print{display:block}[hidden]{display:none!important}
.comparison .whole{fill:#fff;stroke:#667485;stroke-width:2}
.chart-grid{grid-template-columns:minmax(0,1fr)}.chart-card{min-width:0}.svg-wrap{max-width:100%}
.filters.no-print{display:flex}
.site-nav{position:sticky;top:0;z-index:30;background:rgba(21,38,62,.96);border-bottom:1px solid rgba(255,255,255,.1);backdrop-filter:blur(12px)}.site-nav-inner{max-width:1450px;margin:auto;padding:10px 34px;display:flex;align-items:center;gap:13px;color:#fff}.site-brand{margin-right:auto;font:700 14px var(--serif);text-decoration:none;white-space:nowrap}.site-link{padding:5px 9px;border-radius:999px;color:#b9c5d2;text-decoration:none;font-size:12px;white-space:nowrap}.site-link:hover,.site-link[aria-current="page"]{color:#fff;background:rgba(255,255,255,.1)}
.probability-table .data-table{min-width:1420px;white-space:normal}.probability-table td:nth-child(8){min-width:260px}.probability-table td:nth-child(9){min-width:210px}.probability-metrics .metric strong{font-size:24px}
.deployed-table{margin:18px 0}.deployed-table .data-table{min-width:1280px;white-space:normal}.deployed-table td:nth-child(1){min-width:180px}.deployed-table td:nth-child(2){min-width:310px}.deployed-table td:nth-child(4){min-width:390px}.deployed-table td:nth-child(5){min-width:260px}.evidence-stack{display:grid;gap:8px}.period-evidence{display:grid;grid-template-columns:48px 105px minmax(210px,1fr);gap:7px;align-items:start;padding-bottom:7px;border-bottom:1px dashed #e2ddd2}.period-evidence:last-child{padding-bottom:0;border-bottom:0}.period-evidence span{white-space:normal}.period-evidence small{display:inline;color:var(--muted)}
@media(max-width:1050px){.layout{grid-template-columns:1fr}.toc{position:relative;top:auto;display:none}.metric-grid{grid-template-columns:repeat(3,1fr)}.risk-grid{grid-template-columns:repeat(2,1fr)}.chan-lifecycle{grid-template-columns:repeat(3,1fr)}}
@media(max-width:720px){.site-nav-inner{padding:9px 14px;overflow-x:auto}.site-brand{margin-right:6px}.page{padding:0 14px 60px}.hero{margin:0 -14px 20px;padding:52px 18px 42px}.hero h1{font-size:42px}.hero .lede{font-size:15px}.section{padding:21px 16px;border-radius:14px}.section-head{grid-template-columns:1fr;gap:3px}.section-number{padding:0}.metric-grid,.risk-grid,.case-grid,.source-grid,.split{grid-template-columns:1fr}.metric{min-height:auto}.case-card:nth-child(5){grid-column:auto}.chan-lifecycle{grid-template-columns:1fr 1fr}.filters{align-items:stretch}.filter{width:100%}.filter input,.filter select{width:100%}.count{margin-left:0}.limitations{columns:1}}
@media print{@page{size:A4 landscape;margin:11mm}body{background:#fff;font-size:9pt}.site-nav{display:none!important}.page{max-width:none;padding:0}.hero{margin:0 0 8mm;padding:12mm;background:#fff!important;color:#111;border-bottom:2px solid #111}.hero:after,.toc,.filters,.no-print{display:none!important}.hero .lede,.hero-meta{color:#444}.eyebrow{color:#333}.section{break-inside:avoid;margin:0 0 7mm;padding:5mm;border:1px solid #aaa;box-shadow:none}.section h2{font-size:20pt}.table-wrap{overflow:visible;max-height:none;border-color:#aaa}.data-table{font-size:7pt;white-space:normal}.data-table th{position:static;background:#eee!important}.data-table th,.data-table td{padding:4px}.chart-card,.metric,.risk-card,.case-card,.source-card{break-inside:avoid;box-shadow:none}.comparison{min-width:0}.metric-grid{grid-template-columns:repeat(5,1fr)}.risk-grid{grid-template-columns:repeat(3,1fr)}.source-grid{grid-template-columns:repeat(2,1fr)}.case-grid{grid-template-columns:1fr 1fr}.pill{border:1px solid #aaa}.positive,.negative{color:#111!important}}
</style>
</head>
<body>
<nav class="site-nav" aria-label="研究站点导航"><div class="site-nav-inner"><a class="site-brand" href="./">Hanai Worth · 值见</a><a class="site-link" href="./turning-point-capability-audit-2026-08-23.html" aria-current="page">变盘点审计</a><a class="site-link" href="./a-share-cycle-outlook.html">A股周期展望</a><a class="site-link" href="https://github.com/hancao97/hanai-investment-dsh" target="_blank" rel="noreferrer">GitHub ↗</a></div></nav>
<div class="page">
  <header class="hero">
    <div class="eyebrow">Reproducible capability audit · frozen evidence</div>
    <h1>变盘点不是一个点，<br>而是一个<em>可证伪的决策过程</em></h1>
    <p class="lede">hanai-investment-dsh 生产 10 类标记 × 日/周/月周期的全格审计，连同 raw vs matched、年度稳定性、16 个研究候选与缠论标记生命周期。所有“—”都表示源字段缺失，不作插值。</p>
    <div class="hero-meta"><span>报告生成：${escapeHtml(generatedAt)}</span><span>生产产物：${escapeHtml(productionGeneratedAt || '—')}</span><span>研究 cutoff：${escapeHtml(stringValue(get(production, 'metadata', 'requested_end')) || '—')}</span><span>成本：买侧约 ${fmtPct(roundTripCost, 3)} 往返</span></div>
${diagnosticSubset ? '    <div class="subset-banner">⚠ 当前 production 输入标记为 diagnostic_subset：本页仅用于生成器与结构验证，不得作为“全市场最终结论”。</div>\n' : ''}${sourceIncomplete ? '    <div class="subset-banner">⚠ 至少一个周期的 manifest 或解析覆盖不完整；本报告仍覆盖全部生产规则和所有可评估证券，但相关发布门禁已被强制判为失败，缺口在“系统审计风险”中披露。</div>\n' : ''}  </header>
  <div class="layout">
    <nav class="toc" aria-label="报告目录"><b>目录</b>
      <a href="#summary">01 执行摘要</a><a href="#production">02 已引入 10 类</a><a href="#matched">03 Raw vs matched</a><a href="#stability">04 年度与周期稳定</a><a href="#candidates">05 已/未引入候选</a><a href="#chan">06 缠论证据</a><a href="#risks">07 系统审计风险</a><a href="#cases">08 拟影子验证</a><a href="#method">09 胜率计算方法</a><a href="#sources">10 来源与复现</a>
      <div class="actions"><button class="btn" type="button" onclick="window.print()">打印</button><button class="btn" type="button" id="top-button">顶部</button></div>
    </nav>
    <main>
      <section class="section" id="summary"><div class="section-head"><div class="section-number">01 / 10</div><div><h2>执行摘要</h2><p class="intro">先问是否具备超越市场状态的增量，再看“命中率有多高”。生产发布门禁同时要求样本、方向、收益、匹配增量、年度、折外与多重检验，不接受单一漂亮数字。</p></div></div>
        <div class="callout ${statusTone}"><strong>${escapeHtml(verdict)}</strong><span>${diagnosticSubset ? '这是诊断子集上的状态，最终报告必须以完整 production 产物重跑。' : '这是历史回测审计结论，不构成收益承诺或交易建议。'}</span></div>
        <div class="metric-grid">
          ${metricCard('生产门禁', `${fmtInt(gatesPassed)} / ${fmtInt(gatesTotal)}`, `通过全部检查；忽略运行完整性仍过 ${fmtInt(gatesWithoutIntegrity)}`, gatesPassed === 0 ? 'bad' : 'good')}
          ${metricCard('生产支持格', fmtInt(supportedRows.length), `10×3 矩阵中启用；未启用 ${fmtInt(prodRows.length - supportedRows.length)}`)}
          ${metricCard('Raw ≥ 60%', fmtInt(rawSixtyNoMatched), '但 matched 增益 95% 下界不大于 0 的生产格')}
          ${metricCard('16 候选门禁', `${fmtInt(researchPassed)} / ${fmtInt(research.length)}`, '冻结候选通过数', researchPassed === 0 ? 'bad' : 'good')}
          ${metricCard('缠论冻结率', fmtPct(numberValue(chanLifecycle.provisional_marker_freeze_rate)), '官方默认 provisional 最终冻结；不是胜率')}
        </div>
        <div class="split"><div class="formula"><b>一句话判断</b><code>raw 命中率 ≠ 信号增量；matched uplift 才回答“同样市场状态下，标记是否多提供了信息”。</code><p>最佳生产行：${escapeHtml(bestProduction === null ? '—' : `${PERIOD_LABELS[bestProduction.period]} · ${bestProduction.label}`)}；它只是按门禁完备度领先，不等于可上线。</p></div><div class="formula"><b>投资理念翻译</b><code>周期定位 → 形态触发 → 收盘确认 → 次期开盘执行 → 固定窗验证 → 同状态对照</code><p>缠论负责结构语言，周期负责上下文，波段负责持有窗；统计审计负责阻止事后叙事把偶然波动包装成能力。</p></div></div>
      </section>

      <section class="section" id="production"><div class="section-head"><div class="section-number">02 / 10</div><div><h2>生产 10 类 × 周期全表</h2><p class="intro">矩阵完整列出 10 类 × 3 周期共 ${fmtInt(prodRows.length)} 格；源产品不支持的组合标为“未启用”，不把空白当作 0。已启用格使用流动性与可交易主样本。</p></div></div>
        <div class="callout bad"><strong>先定性：当前不是“自动变盘交易系统”，也不是生产缠论引擎</strong><span>生产实现是浏览器 K 线图上的 10 类硬编码观察标记；没有服务端信号计算、全市场扫描/告警、订单执行、首次出现台账或冻结后的前瞻评分。缠论只存在于独立研究脚本，未接入产品生产链路。</span></div>
        <div class="risk-grid"><article class="risk-card"><p>未收盘重绘</p><strong>D / W / M</strong><span>数据契约没有 isFinal；当前日/周/月 K 每 15 秒重算，最新标记可出现或消失，不能称“收盘确认”。</span></article><article class="risk-card"><p>历史回填相位</p><strong>121 + cooldown</strong><span>初始日线窗口较短，向左补历史后贪心冷却从更早候选起步，绝对日期标记可能改变，需 backfill-invariance 测试。</span></article><article class="risk-card"><p>嵌套证据</p><strong>不可相乘</strong><span>深跌基础/强收/长影及锚点/确认存在父子与同日重叠；显示多个图标不等于多个独立概率。</span></article><article class="risk-card"><p>MA 工具栏</p><strong>只改画线</strong><span>“短/中周期”选择只改变 MA5/10 或 MA20/60 显示，不改变任何标记规则，UI 容易造成规则随模式变化的误解。</span></article></div>
        <h3>现在系统到底引入了什么：10 类生产标记逐一对账</h3>
        <p class="intro">下表是一类一行的产品清单，不再把“研究候选”和“已上线标记”混为一谈。A–E 等级来自第 03 节的冻结统计判定；每个周期都同时展示 raw、同状态基线与 matched 增量。</p>
        ${deployedSignalTable(prodRows)}
        <h3>完整 10 × 3 周期矩阵</h3>
        <div class="filters no-print"><div class="filter"><label for="prod-search">搜索</label><input id="prod-search" type="search" placeholder="信号中文名 / key"></div><div class="filter"><label for="prod-period">周期</label><select id="prod-period"><option value="all">全部</option><option value="daily">日 K</option><option value="weekly">周 K</option><option value="monthly">月 K</option></select></div><div class="filter"><label for="prod-side">方向</label><select id="prod-side"><option value="all">全部</option><option value="buy">买侧</option><option value="risk">风险侧</option></select></div><div class="filter"><label for="prod-status">门禁</label><select id="prod-status"><option value="all">全部</option><option value="pass">通过</option><option value="fail">未通过</option><option value="off">未启用</option></select></div><span class="count" id="prod-count"></span></div>
        ${productionTable(prodRows)}
        <p class="footnote">风险侧的“方向命中”是标的未来下跌 / 可避免损失观察，不是可卖空收益。平均方向收益对风险侧取反；买侧使用扣除约定摩擦后的收益。</p>
      </section>

      <section class="section" id="matched"><div class="section-head"><div class="section-number">03 / 10</div><div><h2>Raw vs matched：把行情红利剥掉</h2><p class="intro">空心点是全主样本 raw；蓝点与方块只在成功匹配的同一子样本上，二者之差才是正式 uplift。对照池按同日、周期、方向、板块组、事前涨幅/回撤位置与流动性分层，并剔除被检验信号本身；置信区间跨 0 时，不能宣称有稳定增量。</p></div></div>
        <h3>统计概率判定：把 22 格分成可解释的 A–E 五类</h3>
        ${probabilityJudgementSection(prodRows)}
        <div class="chart-grid"><article class="chart-card"><h3>全主样本 raw、匹配子样本实际与同状态期望</h3><p>匹配覆盖不足 100% 时，空心点不能直接与方块相减；连接线严格连接匹配子样本实际和期望。</p>${comparisonSvg(prodRows)}</article><article class="chart-card"><h3>匹配命中增益与两向聚类 95% 区间</h3><p>横轴 0 表示“标记没有超越同状态对照”；按股票与信号月份修正依赖。</p>${upliftSvg(prodRows)}</article></div>
        <div class="callout"><strong>为什么高 raw 仍可能失败？</strong><span>底部反转信号常发生在本来就高反弹概率的超跌/高波动状态；顶部风险信号也可能发生在本来就容易回撤的状态。若 matched uplift 或 matched signed excess 的 95% 下界不大于 0，漂亮的 raw 命中率不能归因于标记本身。</span></div>
      </section>

      <section class="section" id="stability"><div class="section-head"><div class="section-number">04 / 10</div><div><h2>年度与周期稳定性</h2><p class="intro">年度切分按信号年归组，并剔除退出跨年事件，避免持有期越界。周期交叉证据来自冻结的 K 线周期研究；该旧产物覆盖六类基础标记，不替代本次 10 类生产审计。</p></div></div>
        <h3>生产信号逐年诊断</h3><div class="filters no-print"><div class="filter"><label for="annual-key">信号 × 周期</label><select id="annual-key"><option value="all">全部</option>${prodKeys}</select></div><span class="count" id="annual-count"></span></div>${annualProductionTable(annual)}
        <h3>冻结 K 线周期研究：开发 / 验证 / 近期 / 产品证据</h3><div class="filters no-print"><div class="filter"><label for="period-study-filter">周期</label><select id="period-study-filter"><option value="all">全部</option><option value="daily">日 K</option><option value="weekly">周 K</option><option value="monthly">月 K</option></select></div></div>${periodStudyTable(periodRows)}
        <p class="footnote">此表中的“标的平均收益”保持源产物符号；风险侧负收益代表之后下跌，不是净做空 P&amp;L。不同周期持有单位不同，不能横向当作相同时间长度。</p>
      </section>

      <section class="section" id="candidates"><div class="section-head"><div class="section-number">05 / 10</div><div><h2>已研究候选：哪些已引入，哪些还在考虑</h2><p class="intro">冻结候选共 16 个：4 个本轮候选直接映射为日线 V0，1 个 benchmark 已由 legacy 同族覆盖但该规则变体未单独引入，其余 11 个未引入。候选网格优先显示 expanded unseen symbols 的主观察窗；验证折、测试折、匹配对照与 Holm 校正共同约束选择偏差。</p></div></div>
        <div class="callout"><strong>候选结论：4 个直接映射 + 1 个既有同族覆盖，不代表它们通过了研究门禁；其余 11 个也没有任何一个达到直接引入标准</strong><span>直接映射为低位破低反包、金针探底观察、金针突破确认、高位巨量长上影；“深跌巨量强收”benchmark 与既有 legacy“深跌强收”同语义，但量均线口径与冷却规则不同，未作为独立变体引入。其他候选中，我只把“失败突破观察”列为优先影子验证：n=${fmtInt(research.find(row => row.signal === 'failed_breakout_raw')?.events ?? null)}、raw ${fmtPct(research.find(row => row.signal === 'failed_breakout_raw')?.rawRate ?? null, 2)}，但 matched 增量 ${fmtPp(research.find(row => row.signal === 'failed_breakout_raw')?.uplift ?? null)} 且 95% ${fmtPpCi(research.find(row => row.signal === 'failed_breakout_raw')?.upliftCi ?? null)}，所以仍不能上线；“巨量后缩量不破转强”只有 ${fmtInt(research.find(row => row.signal === 'capitulation_retest_confirmed')?.events ?? null)} 个事件，只能先补样本。</span></div>
        <div class="candidate-note">“P0 / P1 / P2 / benchmark”是原研究文件中的候选优先级，不是本报告后文 P1–P5 case。候选没有通过门禁时，只能保留为研究/观察标记。</div>
        <div class="filters no-print"><div class="filter"><label for="candidate-search">搜索</label><input id="candidate-search" type="search" placeholder="候选 / 规则"></div><div class="filter"><label for="candidate-side">方向</label><select id="candidate-side"><option value="all">全部</option><option value="buy">买侧</option><option value="sell">风险侧</option></select></div><div class="filter"><label for="candidate-stage">阶段</label><select id="candidate-stage"><option value="all">全部</option><option value="anchor">观察锚点</option><option value="confirmed">确认</option></select></div><span class="count" id="candidate-count"></span></div>
        ${researchTable(research)}
      </section>

      <section class="section" id="chan"><div class="section-head"><div class="section-number">06 / 10</div><div><h2>缠论证据：先处理“何时可知”</h2><p class="intro">缠论信号最危险的不是形态解释，而是把事后冻结标记当作当时就已知。稳定性产物明确分离首次出现、底层笔确认和标记冻结，并记录 provisional 失效与确认延迟。</p></div></div>
        <dl class="chan-lifecycle"><div><dt>episode</dt><dd>${fmtInt(numberValue(chanLifecycle.episodes))}</dd></div><div><dt>底层笔确认率</dt><dd>${fmtPct(numberValue(chanLifecycle.provisional_underlying_bi_sure_rate))}</dd></div><div><dt>最终冻结率</dt><dd>${fmtPct(numberValue(chanLifecycle.provisional_marker_freeze_rate))}</dd></div><div><dt>确认前失效</dt><dd>${fmtPct(numberValue(chanLifecycle.provisional_invalidation_before_bi_sure_rate))}</dd></div><div><dt>冻结中位延迟</dt><dd>${fmtNumber(numberValue(chanLifecycle.median_marker_freeze_lag_bars_from_anchor), 1)} bars</dd></div></dl>
        <div class="callout bad"><strong>不能用事后冻结点回填实时胜率</strong><span>官方默认形态下，源文件记录了 provisional → 底层笔确认 → marker frozen 的生命周期。实时系统应按当时可见阶段做决策，并把会失效的 provisional 全部计入分母。</span></div>
        <div class="filters no-print"><div class="filter"><label for="chan-config">参数</label><select id="chan-config"><option value="all">全部</option>${Object.keys(asObject(chanStability.configurations)).map(key => `<option value="${escapeAttr(key)}">${escapeHtml(CONFIG_LABELS[key] ?? key)}</option>`).join('')}</select></div><div class="filter"><label for="chan-stage">阶段</label><select id="chan-stage"><option value="all">全部</option><option value="first_seen">首次出现</option><option value="underlying_bi_sure">底层笔确认</option><option value="marker_frozen">标记冻结</option></select></div></div>
        ${chanStageTable(chanRows)}
        <h3>逐年前推：官方/严格参数的年度结果</h3><div class="filters no-print"><div class="filter"><label for="chan-annual-config">参数</label><select id="chan-annual-config"><option value="official_default_daily_morphology">官方默认日线形态</option><option value="strict_divergence_0_9">严格背驰 0.9</option><option value="all">全部</option></select></div><div class="filter"><label for="chan-annual-stage">阶段</label><select id="chan-annual-stage"><option value="all">全部</option><option value="first_seen">首次出现</option><option value="underlying_bi_sure">底层笔确认</option><option value="marker_frozen">标记冻结</option></select></div><div class="filter"><label for="chan-annual-horizon">窗</label><select id="chan-annual-horizon"><option value="all">全部</option><option value="5">5 日</option><option value="10">10 日</option><option value="20">20 日</option></select></div><span class="count" id="chan-annual-count"></span></div>
        ${chanAnnualTable(chanAnnual)}
      </section>

      <section class="section" id="risks"><div class="section-head"><div class="section-number">07 / 10</div><div><h2>系统审计风险</h2><p class="intro">能力边界不仅来自策略，也来自数据宇宙、历史长度、供应商复权、交易可执行性、信号相关性与选择流程。这里把最容易被一张“高胜率”表遮住的风险直接量化。</p></div></div>
        <div class="risk-grid">${auditRiskCards(production, prodRows, chanStability)}</div>
        <details><summary>展开五份源产物的原始 limitations</summary><ol class="limitations">${limitationsList(production, fullMarket, periodStudy, chanStability, chanWalkForward)}</ol></details>
      </section>

      <section class="section" id="cases"><div class="section-head"><div class="section-number">08 / 10</div><div><h2>我考虑的下一批：先影子验证，再谈引入</h2><p class="intro">以下不是“承诺 70% 胜率”的营销清单，而是可复现、可否决的下一轮研究 case。每张卡都用当前数据填数；没有冻结数据就明确写暂无，算法选出的结果若不合格也如实显示未通过。</p></div></div>
        ${legacyAdverseCase(legacyTurning)}
        <div class="case-grid">${casesSection(prodRows, research, chanRows)}</div>
        <p class="footnote">P3、P4、P5 在多个候选中做了探索性排序，存在 winner's curse；它们的当前数字只能生成假设，不能当作独立验证。</p>
        <h3>我真正建议进入“影子验证”的下一步</h3>
        <p class="intro">“考虑引入”在这里不是立刻增加图标，而是先冻结定义、记录 first-seen / final / invalidated，并在不影响用户决策的事件台账中评估。现有数据不足时明确写“暂无”，不把三个边际胜率相乘。</p>
        ${shadowValidationRoadmap(prodRows, research)}
        <h3>我的下一代 H1–H5：把“形态”升级为状态条件模型</h3>
        <p class="intro">这些 case 目前没有诚实可报的冻结样本外胜率，因此不伪造数字。它们把业界更稳定的结论——期限、市场状态、相对强度、流动性与确认时钟——转化为可直接编码和否决的实验。</p>
        ${nextGenerationHypotheses()}
      </section>

      <section class="section" id="method"><div class="section-head"><div class="section-number">09 / 10</div><div><h2>胜率如何计算，怎样才算“高”</h2><p class="intro">胜率必须绑定方向、入场时钟、持有窗、交易成本与分母。一个没有 n、区间、匹配基线和样本外表现的“胜率”不可审计。</p></div></div>
        <div class="split"><div class="formula"><b>1 · 事件命中</b><code>买侧 yᵢ = 1[ next-open→H-close 净收益 &gt; 0 ]<br>风险侧 yᵢ = 1[ 标的 next-open→H-close 原始收益 &lt; 0 ]<br>p̂ = Σyᵢ / n</code><p>买侧扣日期感知印花税与约定摩擦；日线一字涨停不可成交入场从主样本排除。风险侧只解释“回避下跌”，不解释卖空收益。</p></div><div class="formula"><b>2 · Wilson 95% 区间</b><code>(p̂ + z²/2n ± z·√(p̂(1−p̂)/n + z²/4n²)) / (1 + z²/n), z=1.96</code><p>小样本的 80% 可能比大样本的 58% 更不可靠；应看下界，不只看点估计。</p></div><div class="formula"><b>3 · 匹配增量</b><code>eᵢ = 同日/周期/方向/板块组/位置/流动性、且剔除该信号的对照池均值<br>uplift = mean(yᵢ − eᵢ)</code><p>匹配收益增量同理用 signal signed return 减 control expected signed return。覆盖率必须同步报告。</p></div><div class="formula"><b>4 · 依赖、多重检验与时间</b><code>CI = 股票 × 信号月份 two-way cluster<br>p_family = Holm 校正<br>partition = development / validation / test<br>year = signal-year with cross-boundary exits purged</code><p>生产 partition 是股票哈希的横截面稳定性分区，不是真正新的时间样本外；同一股票、同一月份和嵌套标记也不独立，多周期胜率不能相乘。</p></div></div>
        <div class="callout"><strong>本报告认可的“高胜率”最低语义</strong><span>不仅 raw p̂ 高，还要有足够 n、Wilson/聚类下界、正 matched uplift 与 signed excess、Holm 后显著、去掉最佳 5% 仍为正、至少三年稳定、验证折与测试折均达标。通过历史门禁仍需 cutoff 后前瞻检验。</span></div>
      </section>

      <section class="section" id="sources"><div class="section-head"><div class="section-number">10 / 10</div><div><h2>来源、业界证据与复现</h2><p class="intro">本 HTML 无外部字体/脚本/图片，可离线阅读；论文链接仅用于核验。源 JSON 的摘要与 SHA-256 写入页面，便于确认报告对应哪一版证据。</p></div></div>
        <div class="source-grid">${sourceCards}</div>
        <h3>业界与学术证据地图</h3>
        <div class="callout"><strong>一致结论：边缘是期限与状态条件性的，不是永恒形态胜率</strong><span>研究共同指向市场状态、流动性、交易成本、规则选择偏差和发现后衰减。缠论在本报告中被视为结构候选生成语言；目前没有找到足以把其事后结构直接认定为跨市场稳定 alpha 的独立高质量证据。</span></div>
        <div class="source-grid">${industryCards}</div>
        <h3>关键时钟</h3><dl class="source-card"><div><dt>信号</dt><dd>${escapeHtml(stringValue(get(production, 'metadata', 'signal_clock')) || '—')}</dd></div><div><dt>入场</dt><dd>${escapeHtml(stringValue(get(production, 'metadata', 'entry_clock')) || '—')}</dd></div><div><dt>周期标签</dt><dd>${escapeHtml(stringValue(get(production, 'metadata', 'period_date_semantics')) || '—')}</dd></div><div><dt>持有</dt><dd>${escapeHtml(stringValue(get(production, 'metadata', 'horizon_convention')) || '—')}</dd></div><div><dt>流动性</dt><dd>${escapeHtml(stringValue(get(production, 'metadata', 'liquidity_filter')) || '—')}</dd></div><div><dt>对照池</dt><dd>${escapeHtml(stringValue(get(production, 'metadata', 'matched_control_semantics')) || '—')}</dd></div></dl>
        <div class="repro"><code id="repro-command">${escapeHtml(command)}</code></div><button class="btn no-print" type="button" id="copy-command">复制命令</button>
        <p class="footnote">可复现能力审计 · 不构成投资建议。A 股交易制度、费用、涨跌停、ST 状态、冲击成本与供应商数据均可能改变实盘结果。</p>
      </section>
    </main>
  </div>
</div>
<script>
(() => {
  const q = (selector) => document.querySelector(selector)
  const qa = (selector) => Array.from(document.querySelectorAll(selector))
  const value = (selector) => q(selector)?.value ?? 'all'
  function updateProduction() {
    const search = (q('#prod-search')?.value ?? '').trim().toLowerCase()
    let visible = 0
    qa('[data-filter-row]').forEach(row => {
      const show = (!search || row.dataset.search.includes(search))
        && (value('#prod-period') === 'all' || row.dataset.period === value('#prod-period'))
        && (value('#prod-side') === 'all' || row.dataset.side === value('#prod-side'))
        && (value('#prod-status') === 'all' || row.dataset.status === value('#prod-status'))
      row.hidden = !show
      if (show) visible += 1
    })
    if (q('#prod-count')) q('#prod-count').textContent = visible + ' 格'
  }
  function updateCandidates() {
    const search = (q('#candidate-search')?.value ?? '').trim().toLowerCase()
    let visible = 0
    qa('[data-candidate-row]').forEach(row => {
      const show = (!search || row.dataset.search.includes(search))
        && (value('#candidate-side') === 'all' || row.dataset.side === value('#candidate-side'))
        && (value('#candidate-stage') === 'all' || row.dataset.stage === value('#candidate-stage'))
      row.hidden = !show
      if (show) visible += 1
    })
    if (q('#candidate-count')) q('#candidate-count').textContent = visible + ' 项'
  }
  function updateAnnual() {
    let visible = 0
    qa('[data-annual-row]').forEach(row => {
      const show = value('#annual-key') === 'all' || row.dataset.key === value('#annual-key')
      row.hidden = !show
      if (show) visible += 1
    })
    if (q('#annual-count')) q('#annual-count').textContent = visible + ' 年度格'
  }
  function updatePeriodStudy() {
    qa('[data-period-study-row]').forEach(row => { row.hidden = value('#period-study-filter') !== 'all' && row.dataset.period !== value('#period-study-filter') })
  }
  function updateChan() {
    qa('[data-chan-row]').forEach(row => {
      row.hidden = !((value('#chan-config') === 'all' || row.dataset.configuration === value('#chan-config'))
        && (value('#chan-stage') === 'all' || row.dataset.stage === value('#chan-stage')))
    })
  }
  function updateChanAnnual() {
    let visible = 0
    qa('[data-chan-annual-row]').forEach(row => {
      const show = (value('#chan-annual-config') === 'all' || row.dataset.configuration === value('#chan-annual-config'))
        && (value('#chan-annual-stage') === 'all' || row.dataset.stage === value('#chan-annual-stage'))
        && (value('#chan-annual-horizon') === 'all' || row.dataset.horizon === value('#chan-annual-horizon'))
      row.hidden = !show
      if (show) visible += 1
    })
    if (q('#chan-annual-count')) q('#chan-annual-count').textContent = visible + ' 年度格'
  }
  ;['#prod-search','#prod-period','#prod-side','#prod-status'].forEach(selector => q(selector)?.addEventListener('input', updateProduction))
  ;['#candidate-search','#candidate-side','#candidate-stage'].forEach(selector => q(selector)?.addEventListener('input', updateCandidates))
  q('#annual-key')?.addEventListener('input', updateAnnual)
  q('#period-study-filter')?.addEventListener('input', updatePeriodStudy)
  ;['#chan-config','#chan-stage'].forEach(selector => q(selector)?.addEventListener('input', updateChan))
  ;['#chan-annual-config','#chan-annual-stage','#chan-annual-horizon'].forEach(selector => q(selector)?.addEventListener('input', updateChanAnnual))
  q('#top-button')?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }))
  q('#copy-command')?.addEventListener('click', async (event) => {
    const command = q('#repro-command')?.textContent ?? ''
    await navigator.clipboard.writeText(command)
    event.currentTarget.textContent = '已复制'
  })
  const sections = qa('main section[id]')
  const tocLinks = qa('.toc a')
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return
      tocLinks.forEach(link => link.classList.toggle('active', link.getAttribute('href') === '#' + entry.target.id))
    })
  }, { rootMargin: '-20% 0px -70% 0px' })
  sections.forEach(section => observer.observe(section))
  updateProduction(); updateCandidates(); updateAnnual(); updatePeriodStudy(); updateChan(); updateChanAnnual()
})()
</script>
</body>
</html>`
}

function main(): void {
  const args = parseArgs()
  const html = render(args)
  mkdirSync(dirname(args.output), { recursive: true })
  writeFileSync(args.output, html)
  console.log(`wrote ${args.output}`)
  console.log(`production: ${args.production}`)
  console.log(`bytes: ${Buffer.byteLength(html, 'utf8')}`)
}

main()
