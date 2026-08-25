#!/usr/bin/env node

/**
 * Freeze the point-in-time market, valuation and technical evidence used by the
 * A-share cycle outlook. The artifact freezes parsed fields and canonical
 * payload hashes separately from curated fundamental judgements. Raw provider
 * bodies are not retained, so this is a point-in-time parsed snapshot rather
 * than an offline replay archive.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

type Json = Record<string, any>

const AS_OF = '2026-08-25'
const DEFAULT_ARTIFACT = resolve(`docs/research-data/a-share-cycle-market-snapshot-${AS_OF}.json`)
const OUTPUT = resolve(process.argv[2] ?? DEFAULT_ARTIFACT)
const SEED = resolve(process.argv[3] ?? DEFAULT_ARTIFACT)
const EASTMONEY_FIELDS = [
  'f43', 'f57', 'f58', 'f86', 'f116', 'f126', 'f162', 'f163', 'f164', 'f165',
  'f167', 'f173', 'f183', 'f184', 'f185', 'f186', 'f187', 'f188',
].join(',')

const securities = [
  { id: 'cypc', secId: '1.600900', symbol: 'sh600900', code: '600900', name: '长江电力', role: 'stock' },
  { id: 'midea', secId: '0.000333', symbol: 'sz000333', code: '000333', name: '美的集团', role: 'stock' },
  { id: 'catl', secId: '0.300750', symbol: 'sz300750', code: '300750', name: '宁德时代', role: 'stock' },
  { id: 'hengrui', secId: '1.600276', symbol: 'sh600276', code: '600276', name: '恒瑞医药', role: 'stock' },
  { id: 'cmcc', secId: '1.600941', symbol: 'sh600941', code: '600941', name: '中国移动', role: 'stock' },
  { id: 'moutai', secId: '1.600519', symbol: 'sh600519', code: '600519', name: '贵州茅台', role: 'stock' },
  { id: 'nari', secId: '1.600406', symbol: 'sh600406', code: '600406', name: '国电南瑞', role: 'theme-proxy' },
  { id: 'smic', secId: '1.688981', symbol: 'sh688981', code: '688981', name: '中芯国际', role: 'theme-proxy' },
  { id: 'hs300', secId: '1.000300', symbol: 'sh000300', code: '000300', name: '沪深300', role: 'benchmark' },
] as const

const boards = [
  { id: 'grid', type: 'industry', code: 'BK0457', name: '电网设备' },
  { id: 'semiconductor', type: 'industry', code: 'BK1036', name: '半导体' },
  { id: 'pharma', type: 'concept', code: 'BK1106', name: '创新药' },
  { id: 'appliance', type: 'industry', code: 'BK1239', name: '白色家电' },
  { id: 'dividend', type: 'concept', code: 'BK1641', name: '红利股' },
  { id: 'robotics', type: 'concept', code: 'BK1184', name: '人形机器人' },
] as const

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

async function fetchText(url: string, attempts = 4): Promise<string> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json,text/plain,text/html,*/*',
          Referer: url.includes('gtimg') ? 'https://gu.qq.com/' : 'https://quote.eastmoney.com/',
          'User-Agent': 'Mozilla/5.0 Hanai-Worth-Research/1.0',
        },
      })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      const text = await response.text()
      if (text.length < 10) throw new Error('empty response')
      return text
    }
    catch (error) {
      lastError = error
      await new Promise(resolveDelay => setTimeout(resolveDelay, 350 * (attempt + 1)))
    }
  }
  throw lastError
}

function finite(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function round(value: number | null, digits = 4): number | null {
  if (value === null) return null
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function sampleSd(values: number[]): number | null {
  if (values.length < 2) return null
  const average = mean(values)!
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1))
}

function wilson(hits: number, total: number): [number | null, number | null] {
  if (total === 0) return [null, null]
  const z = 1.959963984540054
  const p = hits / total
  const denominator = 1 + z ** 2 / total
  const center = (p + z ** 2 / (2 * total)) / denominator
  const half = z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * total)) / total) / denominator
  return [center - half, center + half]
}

interface Bar {
  date: string
  close: number
}

function movingAverage(bars: Bar[], end: number, length: number): number | null {
  if (end + 1 < length) return null
  return mean(bars.slice(end + 1 - length, end + 1).map(bar => bar.close))
}

function returnAt(bars: Bar[], end: number, lookback: number): number | null {
  if (end < lookback) return null
  return bars[end]!.close / bars[end - lookback]!.close - 1
}

function stateAt(bars: Bar[], benchmark: Bar[], end: number): Json | null {
  const date = bars[end]?.date
  const benchmarkIndex = benchmark.findIndex(bar => bar.date === date)
  if (benchmarkIndex < 60) return null
  const ma20 = movingAverage(bars, end, 20)
  const ma60 = movingAverage(bars, end, 60)
  const ret60 = returnAt(bars, end, 60)
  const benchmarkRet60 = returnAt(benchmark, benchmarkIndex, 60)
  if (ma20 === null || ma60 === null || ret60 === null || benchmarkRet60 === null) return null
  return {
    above_ma20: bars[end]!.close >= ma20,
    above_ma60: bars[end]!.close >= ma60,
    momentum_60_positive: ret60 >= 0,
    relative_60_positive: ret60 >= benchmarkRet60,
  }
}

function sameState(left: Json | null, right: Json | null): boolean {
  if (left === null || right === null) return false
  return ['above_ma20', 'above_ma60', 'momentum_60_positive', 'relative_60_positive']
    .every(key => left[key] === right[key])
}

function conditionalOutcome(bars: Bar[], benchmark: Bar[], horizon: 20 | 60, currentState: Json): Json {
  const benchmarkByDate = new Map(benchmark.map((bar, index) => [bar.date, index]))
  const absolute: number[] = []
  const excess: number[] = []
  const events: Json[] = []
  let lastSelected = -horizon
  for (let index = 60; index + horizon < bars.length; index += 1) {
    if (index - lastSelected < horizon) continue
    const state = stateAt(bars, benchmark, index)
    if (!sameState(state, currentState)) continue
    const benchmarkIndex = benchmarkByDate.get(bars[index]!.date)
    const benchmarkExit = benchmarkByDate.get(bars[index + horizon]!.date)
    if (benchmarkIndex === undefined || benchmarkExit === undefined) continue
    const stockReturn = bars[index + horizon]!.close / bars[index]!.close - 1
    const benchmarkReturn = benchmark[benchmarkExit]!.close / benchmark[benchmarkIndex]!.close - 1
    absolute.push(stockReturn)
    excess.push(stockReturn - benchmarkReturn)
    events.push({
      signal_date: bars[index]!.date,
      exit_date: bars[index + horizon]!.date,
      stock_return: stockReturn,
      benchmark_return: benchmarkReturn,
      excess_return: stockReturn - benchmarkReturn,
      positive: stockReturn > 0,
      outperformed: stockReturn > benchmarkReturn,
    })
    lastSelected = index
  }
  const positiveHits = absolute.filter(value => value > 0).length
  const excessHits = excess.filter(value => value > 0).length
  const [positiveLow, positiveHigh] = wilson(positiveHits, absolute.length)
  const [excessLow, excessHigh] = wilson(excessHits, excess.length)
  return {
    horizon_trading_days: horizon,
    non_overlapping_observations: absolute.length,
    positive_rate: round(absolute.length === 0 ? null : positiveHits / absolute.length),
    positive_rate_wilson95: [round(positiveLow), round(positiveHigh)],
    outperform_rate: round(excess.length === 0 ? null : excessHits / excess.length),
    outperform_rate_wilson95: [round(excessLow), round(excessHigh)],
    mean_return: round(mean(absolute)),
    mean_excess_return: round(mean(excess)),
    excess_return_sd: round(sampleSd(excess)),
    events,
    semantics: '当前四状态的历史非重叠条件频率；描述性统计，不是独立同分布样本或未来保证。',
  }
}

function technicalSnapshot(bars: Bar[], benchmark: Bar[]): Json {
  const end = bars.length - 1
  const benchmarkEnd = benchmark.findIndex(bar => bar.date === bars[end]!.date)
  if (benchmarkEnd < 120) throw new Error(`benchmark missing ${bars[end]!.date}`)
  const latest = bars[end]!
  const state = stateAt(bars, benchmark, end)
  if (state === null) throw new Error(`insufficient state history for ${latest.date}`)
  const returns: Json = {}
  for (const lookback of [20, 60, 120] as const) {
    const stockReturn = returnAt(bars, end, lookback)!
    const benchmarkReturn = returnAt(benchmark, benchmarkEnd, lookback)!
    returns[`${lookback}d`] = {
      absolute: round(stockReturn),
      benchmark: round(benchmarkReturn),
      excess: round(stockReturn - benchmarkReturn),
    }
  }
  const dailyReturns = bars.slice(-21).slice(1).map((bar, index) => bar.close / bars[bars.length - 21 + index]!.close - 1)
  const ma20 = movingAverage(bars, end, 20)!
  const ma60 = movingAverage(bars, end, 60)!
  const ma120 = movingAverage(bars, end, 120)!
  const last120 = bars.slice(-120).map(bar => bar.close)
  const peak = Math.max(...last120)
  return {
    date: latest.date,
    close_qfq: latest.close,
    returns,
    ma: {
      ma20: round(ma20), ma60: round(ma60), ma120: round(ma120),
      close_vs_ma20: round(latest.close / ma20 - 1),
      close_vs_ma60: round(latest.close / ma60 - 1),
      close_vs_ma120: round(latest.close / ma120 - 1),
    },
    state,
    annualized_volatility_20d: round((sampleSd(dailyReturns) ?? 0) * Math.sqrt(242)),
    drawdown_from_120d_high: round(latest.close / peak - 1),
    conditional_history: [
      conditionalOutcome(bars, benchmark, 20, state),
      conditionalOutcome(bars, benchmark, 60, state),
    ],
  }
}

async function quoteSnapshot(item: typeof securities[number]): Promise<Json> {
  const query = new URLSearchParams({ secid: item.secId, fltt: '2', invt: '2', fields: EASTMONEY_FIELDS })
  const url = `https://push2delay.eastmoney.com/api/qt/stock/get?${query}`
  const raw = await fetchText(url)
  const envelope = JSON.parse(raw)
  const row = envelope.data
  if (row === null || row === undefined) throw new Error(`empty quote for ${item.code}`)
  const sourceTime = finite(row.f86)
  const parsed = {
    price: finite(row.f43),
    market_cap: finite(row.f116),
    dividend_yield_pct: finite(row.f126),
    pe_dynamic: finite(row.f162),
    pe_static: finite(row.f163),
    pe_ttm: finite(row.f164),
    ps_ttm: finite(row.f165),
    pb: finite(row.f167),
    roe_reported_pct: finite(row.f173),
    revenue: finite(row.f183),
    revenue_yoy_pct: finite(row.f184),
    net_profit_yoy_pct: finite(row.f185),
    gross_margin_pct: finite(row.f186),
    net_margin_pct: finite(row.f187),
    debt_ratio_pct: finite(row.f188),
  }
  if (parsed.price === null) throw new Error(`missing quote price for ${item.code}`)
  return {
    source_url: url,
    source_response_sha256: sha256(raw),
    source_normalized_sha256: sha256(JSON.stringify(parsed)),
    retrieved_at: new Date().toISOString(),
    source_timestamp: sourceTime === null ? null : new Date(sourceTime * 1000).toISOString(),
    ...parsed,
  }
}

async function historySnapshot(item: typeof securities[number]): Promise<{ bars: Bar[], evidence: Json }> {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${item.symbol},day,,${AS_OF},800,qfq`
  const raw = await fetchText(url)
  const envelope = JSON.parse(raw)
  const stock = envelope.data?.[item.symbol]
  const rows = stock?.qfqday ?? stock?.day
  if (!Array.isArray(rows)) throw new Error(`empty history for ${item.code}`)
  const bars = rows.flatMap((row: unknown) => {
    if (!Array.isArray(row) || typeof row[0] !== 'string') return []
    const close = finite(row[2])
    return close === null ? [] : [{ date: row[0], close }]
  })
  return {
    bars,
    evidence: {
      source_url: url,
      source_response_sha256: sha256(raw),
      source_normalized_sha256: sha256(JSON.stringify(bars)),
      retrieved_at: new Date().toISOString(),
      adjustment: 'Tencent qfq',
      rows: bars.length,
      first_date: bars[0]?.date ?? null,
      last_date: bars.at(-1)?.date ?? null,
    },
  }
}

async function boardRows(type: 'industry' | 'concept'): Promise<{ rows: Json[], sources: Json[] }> {
  const fs = type === 'industry' ? 'm:90+t:2+f:!50' : 'm:90+t:3+f:!50'
  const rows: Json[] = []
  const sources: Json[] = []
  for (let page = 1; page <= 6; page += 1) {
    const query = new URLSearchParams({
      pn: String(page), pz: '100', po: '1', np: '1', fltt: '2', invt: '2',
      fs, fid: 'f3', fields: 'f2,f3,f6,f12,f14,f104,f105',
    })
    const url = `https://push2delay.eastmoney.com/api/qt/clist/get?${query}`
    const raw = await fetchText(url)
    const pageRows = JSON.parse(raw).data?.diff
    if (!Array.isArray(pageRows) || pageRows.length === 0) break
    const normalizedRows = pageRows.map((row: Json) => ({ f3: row.f3, f6: row.f6, f12: row.f12, f14: row.f14, f104: row.f104, f105: row.f105 }))
    sources.push({ url, response_sha256: sha256(raw), normalized_sha256: sha256(JSON.stringify(normalizedRows)), retrieved_at: new Date().toISOString() })
    rows.push(...pageRows)
    if (pageRows.length < 100) break
  }
  return { rows, sources }
}

async function breadthSnapshot(): Promise<Json> {
  const url = 'https://push2ex.eastmoney.com/getTopicZDFenBu?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt'
  const raw = await fetchText(url)
  const data = JSON.parse(raw).data
  let up = 0
  let down = 0
  let flat = 0
  let limitUp = 0
  let limitDown = 0
  for (const bucket of data.fenbu as Json[]) {
    for (const [keyText, valueRaw] of Object.entries(bucket)) {
      const key = Number(keyText)
      const value = Number(valueRaw)
      if (key > 0) up += value
      else if (key < 0) down += value
      else flat += value
      if (key === 11) limitUp = value
      if (key === -11) limitDown = value
    }
  }
  const parsed = {
    date: String(data.qdate).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
    up, down, flat, limit_up: limitUp, limit_down: limitDown,
    advance_ratio: round(up / (up + down)),
  }
  return {
    ...parsed,
    source_url: url,
    source_response_sha256: sha256(raw),
    source_normalized_sha256: sha256(JSON.stringify(parsed)),
    retrieved_at: new Date().toISOString(),
  }
}

async function governmentBondYield(): Promise<Json> {
  const url = 'https://yield.chinabond.com.cn/cbweb-czb-web/czb/moreInfo?locale=cn_ZH&nameType=1'
  const raw = await fetchText(url)
  const date = raw.match(/<input name="gzr"[^>]*value="(\d{4}-\d{2}-\d{2})"/)?.[1] ?? null
  const tenYearBlock = raw.match(/<td>10年<\/td>[\s\S]{0,800}?<td>([0-9.]+)<\/td>/)
  const yieldPct = finite(tenYearBlock?.[1])
  if (date === null || yieldPct === null) throw new Error('cannot parse official 10Y yield')
  const parsed = {
    date,
    maturity: '10Y',
    yield_pct: yieldPct,
  }
  return {
    ...parsed,
    source_name: '财政部-中国国债收益率曲线（CCDC提供）',
    source_url: url,
    source_response_sha256: sha256(raw),
    source_normalized_sha256: sha256(JSON.stringify(parsed)),
    retrieved_at: new Date().toISOString(),
  }
}

async function main(): Promise<void> {
  const seedRaw = existsSync(SEED) ? readFileSync(SEED) : null
  const seed = seedRaw === null ? null : JSON.parse(seedRaw.toString('utf8')) as Json
  if (seed !== null && seed.as_of !== AS_OF) throw new Error(`seed is dated ${seed.as_of}, expected ${AS_OF}`)
  const seedByCode = new Map<string, Json>((seed?.securities ?? []).map((item: Json) => [item.code, item]))
  const histories = new Map<string, { bars: Bar[], evidence: Json }>()
  for (const item of securities) histories.set(item.id, await historySnapshot(item))
  const benchmark = histories.get('hs300')!.bars

  const securityRows: Json[] = []
  for (const item of securities) {
    const history = histories.get(item.id)!
    const quote = seedByCode.get(item.code)?.quote ?? await quoteSnapshot(item)
    if (history.evidence.last_date !== AS_OF) throw new Error(`${item.code} history ends ${history.evidence.last_date}, expected ${AS_OF}`)
    if (quote.source_timestamp?.slice(0, 10) !== AS_OF) throw new Error(`${item.code} quote is dated ${quote.source_timestamp}, expected ${AS_OF}`)
    const technical = technicalSnapshot(history.bars, benchmark)
    if (technical.date !== AS_OF) throw new Error(`${item.code} technical snapshot is dated ${technical.date}, expected ${AS_OF}`)
    securityRows.push({
      id: item.id, sec_id: item.secId, code: item.code, name: item.name, role: item.role,
      quote,
      history_source: history.evidence,
      history_bars: history.bars,
      technical,
    })
  }

  const industry = seed === null ? await boardRows('industry') : null
  const concept = seed === null ? await boardRows('concept') : null
  const boardSnapshots = seed?.boards ?? boards.map(board => {
    const rows = board.type === 'industry' ? industry!.rows : concept!.rows
    const row = rows.find(candidate => candidate.f12 === board.code)
    if (row === undefined) throw new Error(`missing board ${board.code}`)
    const up = finite(row.f104)
    const down = finite(row.f105)
    return {
      id: board.id, code: board.code, name: board.name, type: board.type,
      change_pct: finite(row.f3), amount: finite(row.f6), up, down,
      advance_ratio: up === null || down === null || up + down === 0 ? null : round(up / (up + down)),
    }
  })

  const opportunityCost = seed?.opportunity_cost ?? await governmentBondYield()
  const marketBreadth = seed?.market_breadth ?? await breadthSnapshot()
  if (opportunityCost.date !== AS_OF) throw new Error(`10Y yield is dated ${opportunityCost.date}, expected ${AS_OF}`)
  if (marketBreadth.date !== AS_OF) throw new Error(`market breadth is dated ${marketBreadth.date}, expected ${AS_OF}`)

  const payload = {
    schema_version: 2,
    as_of: AS_OF,
    generated_at: new Date().toISOString(),
    methodology: {
      price_and_valuation: 'Eastmoney delayed quote parsed snapshot; displayed ratios are provider fields, not independently audited.',
      price_history: 'Tencent forward-adjusted daily bars through the cutoff, up to 800 observations; normalized date/close rows are retained in the artifact.',
      technical_horizons: '20/60/120 trading-day close-to-close returns versus CSI 300.',
      conditional_statistics: 'Exact four-state match; forward samples are made non-overlapping by horizon. Every selected event is retained, and Wilson interval only describes the sample hit rate.',
      board_breadth: 'Same-session Eastmoney board advance ratio; it is not a medium-term breadth series.',
    },
    opportunity_cost: opportunityCost,
    market_breadth: marketBreadth,
    boards: boardSnapshots,
    board_sources: seed?.board_sources ?? { industry: industry!.sources, concept: concept!.sources },
    ...(seedRaw !== null && {
      point_in_time_seed: {
        as_of: AS_OF,
        semantics: 'Previously frozen quote, board, breadth and yield fields were reused; normalized histories were refetched with an explicit cutoff and embedded for offline recomputation.',
      },
    }),
    securities: securityRows,
    known_limits: [
      'Current-listed and selected-proxy evidence is not a survivorship-free universe backtest.',
      'Eastmoney ratios and board classifications are provider semantics; official filings remain authoritative for accounting fields.',
      'Conditional samples share a single security history and do not establish causal alpha.',
      'Same-session board breadth can reverse quickly and must not be treated as a multi-month trend by itself.',
      'Raw provider bodies are not committed; normalized daily bars and conditional-event ledgers are retained for offline recomputation, while quote/board response hashes remain provenance only.',
    ],
  }
  writeFileSync(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  process.stdout.write(`${OUTPUT}\n`)
}

await main()
