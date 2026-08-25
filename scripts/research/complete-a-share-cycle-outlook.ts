#!/usr/bin/env node

/** Build the completed, point-in-time A-share cycle outlook data artifact. */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

type Json = Record<string, any>

const ROOT = resolve(import.meta.dirname, '../..')
const BASE = resolve(ROOT, 'docs/research-data/a-share-cycle-outlook-2026-08-23.json')
const MARKET = resolve(ROOT, 'docs/research-data/a-share-cycle-market-snapshot-2026-08-25.json')
const OUTPUT = resolve(process.argv[2] ?? 'docs/research-data/a-share-cycle-outlook-pre-council-2026-08-25.json')

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function pct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return '—'
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(digits)}%`
}

function numberText(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined ? '—' : value.toFixed(digits)
}

function scoreGrade(score: number): 'A' | 'A-' | 'B+' | 'B' | 'B-' | 'C' {
  if (score >= 85) return 'A'
  if (score >= 80) return 'A-'
  if (score >= 75) return 'B+'
  if (score >= 70) return 'B'
  if (score >= 60) return 'B-'
  return 'C'
}

const data = clone(JSON.parse(readFileSync(BASE, 'utf8')) as Json)
const marketRaw = readFileSync(MARKET)
const market = JSON.parse(marketRaw.toString('utf8')) as Json
const marketByCode = new Map<string, Json>(market.securities.map((item: Json) => [item.code, item]))
const boardById = new Map<string, Json>(market.boards.map((item: Json) => [item.id, item]))

const scoring = {
  methodology: '完成版编辑性五维证据评分，每维0—20、总分100；0=反证/缺失，5=偏弱，10=混合，15=多数验证，20=强验证。分值由公开事实按同一尺度人工判定，不是历史校准概率或机械交易信号。',
  components: [
    { id: 'demand', name: '需求可见度', rule: '官方多年计划/真实需求量与可追踪订单越明确，得分越高。' },
    { id: 'earnings', name: '盈利验证', rule: '代表企业收入、利润、毛利和利用率共同改善，且不是单一一次性项目。' },
    { id: 'cash', name: '现金质量', rule: '经营现金流、粗略FCF、分红覆盖和资本回报共同验证。' },
    { id: 'valuation', name: '估值余量', rule: '统一截面的PE/PB/股息利差与增长、资本强度匹配。' },
    { id: 'market', name: '市场确认', rule: '代表股相对沪深300、MA20/60/120与同日板块广度共同验证；单日广度只能贡献一部分。' },
  ],
  grades: [
    { grade: 'A', min: 85, meaning: '五维均强，仍须个股门禁独立通过。' },
    { grade: 'A-', min: 80, meaning: '方向证据强，但至少一个维度仍有清晰缺口。' },
    { grade: 'B+', min: 75, meaning: '优先跟踪，尚不足以视为完整趋势。' },
    { grade: 'B', min: 70, meaning: '有两到三项证据，条件性较强。' },
    { grade: 'B-', min: 60, meaning: '存在产业证据，但估值、现金或市场确认明显不足。' },
    { grade: 'C', min: 0, meaning: '影子研究或反证占优。' },
  ],
  execution_separation: '主题A/A-只表示本版证据评分较高，不等于股票可买；股票必须另过事实、机制、质量、估值、反证和会商六门。',
}

const valuationFramework = {
  methodology: '本版冻结的分析师估值判据，不是历史分位或统计胜率。先用同一截面的PE-TTM、粗FCF收益率、股息率与10年国债利差，再按稳定现金流/成长两条轨道判定。',
  stable_cash_flow: {
    pass: 'PE-TTM≤20×、最近完整年度粗FCF收益率≥5%、股息率较10年国债利差≥2.5pp，且质量门不为FAIL。',
    watch: '未满足全部PASS条件、但也未同时触发FAIL条件；包括零至两项达标或渠道/资本回报仍待核。',
    fail: 'PE-TTM≥35×、粗FCF收益率<3%，且最新盈利或现金流同时转弱。',
  },
  growth: {
    pass: 'PE-TTM≤25×、最近完整年度粗FCF收益率≥4.5%，且最新收入与归母净利均增长≥20%。',
    watch: '未满足全部PASS条件、但也未同时触发FAIL条件；包括成长仍在但任一估值/现金阈值未过。',
    fail: '增长转负且PE-TTM≥35×或粗FCF收益率<3%。',
  },
  disclosure: '这些阈值在完成版中公开冻结，但没有跨周期历史校准；SATELLITE只表示本框架内六门通过，不代表安全边际客观确定。',
}

const themeScores: Record<string, { components: Json; summary: string }> = {
  grid: {
    components: { demand: 20, earnings: 15, cash: 15, valuation: 15, market: 10 },
    summary: '四万亿元多年投资提供最强需求可见度；国电南瑞盈利为正、估值中性，但股价低于MA20/60/120且60/120日相对收益为负。',
  },
  semiconductor: {
    components: { demand: 20, earnings: 20, cash: 10, valuation: 5, market: 10 },
    summary: '收入、毛利和利用率验证最强，但中芯国际PE-TTM约204倍，代表股低于三条均线且板块当日上涨家数不足一半。',
  },
  pharma: {
    components: { demand: 15, earnings: 10, cash: 5, valuation: 5, market: 10 },
    summary: '创新药销售仍增长，但恒瑞收入、扣非、FCF与趋势同时偏弱，估值余量不足。',
  },
  appliance: {
    components: { demand: 15, earnings: 10, cash: 15, valuation: 20, market: 20 },
    summary: '美的估值与股息利差合理、站上MA20/60/120且60/120日显著跑赢沪深300；扣非利润下降使其只能是A-而非A。',
  },
  dividend: {
    components: { demand: 15, earnings: 12, cash: 15, valuation: 18, market: 15 },
    summary: '长电与移动估值、股息和相对强弱具备防御属性，但移动FCF不能覆盖分红、长电股息利差略低于预设PASS线。',
  },
  robotics: {
    components: { demand: 10, earnings: 5, cash: 5, valuation: 5, market: 10 },
    summary: '同日板块广度较高，但缺稳定订单、单位经济、自由现金流和代表股完整门禁。',
  },
}

for (const theme of data.themes as Json[]) {
  const scored = themeScores[theme.id]
  const board = boardById.get(theme.id)
  if (!scored || !board) throw new Error(`Missing completed theme evidence for ${theme.id}`)
  const total = Object.values(scored.components).reduce((sum: number, value: any) => sum + Number(value), 0)
  theme.score = total
  theme.score_components = scored.components
  theme.grade = scoreGrade(total)
  theme.score_summary = scored.summary
  theme.market_evidence = {
    date: market.as_of,
    board: board.name,
    board_change_pct: board.change_pct,
    board_advance_ratio: board.advance_ratio,
  }
  theme.latest_committee = { pass: 0, watch: 5, reject: 0 }
  theme.committee_basis = 'Round 3历史受限票，仅作反方记录；完成版为公开尺度的人工证据评分，待Round 4全状态复核覆盖。'
  theme.source_ids = [...new Set([...(theme.source_ids as string[]), 'market-snapshot'])]
}

// Refine the broad bucket so its A- grade describes the actually measured exposure.
const applianceTheme = (data.themes as Json[]).find(theme => theme.id === 'appliance')!
applianceTheme.name = '白色家电全球化与节能更新'
applianceTheme.thesis = '更新需求、全球渠道、合理估值与相对强势共同成立；但扣非利润转弱，A-是方向证据等级而不是买入评级。'

const quality: Record<string, Json> = {
  '600900': {
    status: 'pass', period: '2026Q1 / 2025A', cfo: 117.11, capex: 32.20, fcf: 84.90, fcf_to_profit: 1.26,
    annual_fcf: 420.74,
    annual: '2025粗FCF420.74亿元、FCF/归母1.22×、覆盖现金分红1.72×、ROE15.90%。',
    conclusion: '即使把全部购建长期资产现金视为维护性资本开支，Q1和全年现金质量仍过预设门。',
  },
  '000333': {
    status: 'pass', period: '2026Q1 / 2025A', cfo: 145.29, capex: 21.43, fcf: 123.86, fcf_to_profit: 0.98,
    annual_cfo: 533.46, annual_capex: 111.42, annual_fcf: 422.04, annual_net_profit: 439.45,
    annual_cfo_to_profit: 1.21, annual_fcf_to_profit: 0.96, annual_dividends: 323.61,
    annual_fcf_dividend_cover: 1.30, annual_roe_pct: 19.70, working_capital_release: 52.80,
    annual: '2025 CFO533.46亿元、粗FCF422.04亿元、FCF/归母0.96×、覆盖现金分红1.30×、ROE19.70%；海外毛利率26.60%，同比仅-0.22pp。',
    conclusion: '2025 CFO/归母1.21×、粗FCF/分红1.30×、ROE19.70%；购建支出111.42亿元、营运资本约释现52.80亿元，海外毛利率仅降0.22pp，均已拆清。Q1扣非-14.02%作为下一期证伪，不追认成FAIL。',
  },
  '300750': {
    status: 'watch', period: '2026H1 / 2025A', cfo: 602.17, capex: 250.73, fcf: 351.44, fcf_to_profit: 0.81,
    annual_fcf: 908.75,
    annual: '2025粗FCF908.75亿元、FCF/归母1.26×、覆盖现金分红2.52×、ROE24.91%。',
    conclusion: '2025质量强，但最新H1 FCF转化降至0.81×，合同负债下降25.9%；2025收入/GWh混合代理约下降12.3%，H1销量/ASP/利用率仍缺同口径更新。',
  },
  '600276': {
    status: 'watch', period: '2026H1 / 2025A', cfo: 19.87, capex: 15.78, fcf: 4.09, fcf_to_profit: 0.09,
    annual_fcf: 82.73,
    annual: '2025粗FCF82.73亿元、FCF/归母1.07×；2026H1许可收入14.22亿元，流动及长期合同负债合计下降43.7%。',
    conclusion: '最新现金质量显著失守；当前规则要求连续两期才FAIL，因此列高风险WATCH并锁定下一期复核。',
  },
  '600941': {
    status: 'fail', period: '2026H1 / 2025A', cfo: 1148.54, capex: 609.54, fcf: 539.00, fcf_to_profit: 0.68,
    annual_fcf: 820.41,
    annual: '2025公司披露FCF820.41亿元、覆盖同期实际现金分红0.806×；2026H1 FCF覆盖同期宣告中期股利0.990×。',
    conclusion: '连续两期FCF不能覆盖分红，低于预设PASS≥1.2，质量门闭环为FAIL。',
  },
  '600519': {
    status: 'watch', period: '2026H1 / 2025A', cfo: 706.91, capex: 8.32, fcf: 698.59, fcf_to_profit: 1.57,
    annual_fcf: 722.087,
    annual: '剔除财务公司专属现金流行后，2025调整FCF约722.09亿元、FCF/归母0.877×、现金分红覆盖1.110×。',
    normalized: '同口径下2026H1调整CFO约379.71亿元、粗FCF371.38亿元、FCF/归母0.834×；该近似未同步剔除财务公司利润。',
    conclusion: '归一化现金刚过下限，但合同负债下降60.3%、境内经销商净减46家，批价与渠道库存没有一手冻结序列。',
  },
}

const valuation: Record<string, { track: 'stable_cash_flow' | 'growth'; latest_revenue_growth_pct?: number; latest_profit_growth_pct?: number; conclusion: string }> = {
  '600900': { track: 'stable_cash_flow', conclusion: 'PE-TTM19.13×、2025粗FCF收益率6.10%，但股息率较10年国债利差仅1.86pp，稳定现金流轨道三项中两项通过。' },
  '000333': { track: 'stable_cash_flow', conclusion: 'PE-TTM14.96×、2025粗FCF收益率6.38%、股息率较10年国债利差3.28pp，稳定现金流轨道三项全部通过。' },
  '300750': { track: 'growth', latest_revenue_growth_pct: 54.80, latest_profit_growth_pct: 41.98, conclusion: 'PE-TTM20.51×、2025粗FCF收益率5.21%，H1收入/归母净利+54.8%/+42.0%，成长轨道三项全部通过；质量门仍独立为WATCH。' },
  '600276': { track: 'growth', latest_revenue_growth_pct: -1.94, latest_profit_growth_pct: -12.71, conclusion: 'PE-TTM39.94×、2025粗FCF收益率2.68%，且H1收入、扣非与FCF同时转弱，触发成长轨道FAIL。' },
  '600941': { track: 'stable_cash_flow', conclusion: 'PE-TTM16.27×、股息利差3.08pp，但2025公司披露FCF收益率仅3.83%，稳定现金流轨道只有两项通过；质量门另为FAIL。' },
  '600519': { track: 'stable_cash_flow', conclusion: 'PE-TTM20.02×、调整后2025粗FCF收益率4.43%、股息利差2.31pp，三项均未完整达到PASS线。' },
}

function evaluateValuation(config: typeof valuation[string], quote: Json, annualFcfYieldPct: number, dividendSpreadPp: number | null, qualityStatus: string): 'pass' | 'watch' | 'fail' {
  const pe = Number(quote.pe_ttm)
  if (config.track === 'stable_cash_flow') {
    const pass = pe <= 20 && annualFcfYieldPct >= 5 && dividendSpreadPp !== null && dividendSpreadPp >= 2.5 && qualityStatus !== 'fail'
    if (pass) return 'pass'
    const simultaneouslyWeak = Number(quote.net_profit_yoy_pct) < 0 || qualityStatus === 'fail'
    return pe >= 35 && annualFcfYieldPct < 3 && simultaneouslyWeak ? 'fail' : 'watch'
  }
  const revenueGrowth = Number(config.latest_revenue_growth_pct)
  const profitGrowth = Number(config.latest_profit_growth_pct)
  if (pe <= 25 && annualFcfYieldPct >= 4.5 && revenueGrowth >= 20 && profitGrowth >= 20) return 'pass'
  return (revenueGrowth < 0 || profitGrowth < 0) && (pe >= 35 || annualFcfYieldPct < 3) ? 'fail' : 'watch'
}

const mechanism: Record<string, 'pass' | 'watch' | 'fail'> = {
  '600900': 'pass', '000333': 'pass', '300750': 'pass', '600276': 'pass', '600941': 'watch', '600519': 'watch',
}
const mechanismNote: Record<string, string> = {
  '600900': '来水、发电量与结算电价可直接传导至现金流，且采用全量capex扣除。',
  '000333': '更新需求与海外本地化能传导至收入、海外毛利和CFO，关键桥接均已披露。',
  '300750': '销量与利用率可传导至收入/GWh、毛利和FCF；H1运营量缺失由事实/质量门保留。',
  '600276': '创新药销售与许可交易可传导至产品收入和现金，但需剔除一次性授权影响。',
  '600941': '算力收入增长已披露，但分业务资本回报尚未披露，机制门保持WATCH。',
  '600519': '品牌需求可传导至主品收入和回款，但批价/渠道库存缺乏一手序列，机制门保持WATCH。',
}

const fact: Record<string, { status: 'pass' | 'watch'; note: string }> = {
  '600900': { status: 'pass', note: '2025A、2026Q1、2026-08-25行情和国债机会成本均已冻结；全部购建支出已按保守口径扣除。' },
  '000333': { status: 'pass', note: '2025完整年报、2026Q1、营运资本、资本开支、海外毛利与点时估值均已闭环。' },
  '300750': { status: 'watch', note: '2026H1财务已披露，但公司未给出同口径H1销量、ASP与利用率，事实门保留WATCH。' },
  '600276': { status: 'pass', note: '2025A、2026H1、许可收入、合同负债与点时估值均有一手披露。' },
  '600941': { status: 'pass', note: '2025A、2026H1、公司FCF、同期宣告股利及点时估值均已闭环。' },
  '600519': { status: 'watch', note: '财报与点时估值已冻结，但没有发行人可复核的批价和渠道库存序列，事实门保留WATCH。' },
}

const falsifier: Record<string, { status: 'pass'; note: string }> = {
  '600900': { status: 'pass', note: '粗FCF/现金分红<1.0×，或发电量同比≤-10%且平均结算电价同比≤-5%连续两期即FAIL。' },
  '000333': { status: 'pass', note: 'CFO/归母<0.8×、收入或利润转负、或海外毛利率同比下降≥2pp连续两期即FAIL。' },
  '300750': { status: 'pass', note: 'FCF/归母<0.8×且收入增速<10%连续两期，或利用率<85%且收入/GWh代理再降≥10%而capex仍增即FAIL。' },
  '600276': { status: 'pass', note: '剔除许可后核心销售转负、关键三期失败/延期，或CFO/归母<1.0×连续两期即FAIL。' },
  '600941': { status: 'pass', note: '同利润归属期FCF/股利<1.0×连续两期，或通信服务收入连续两期负增长即FAIL。' },
  '600519': { status: 'pass', note: '茅台酒收入转负、调整FCF/归母<0.6×，或境内经销商净减少≥50家连续两期即FAIL。' },
}

// The original Midea gate used CFO/net profit as its cash-conversion numerator.
// Preserve that predeclared denominator explicitly now that rough FCF is shown too.
const midea = (data.stocks as Json[]).find(stock => stock.symbol === '000333')!
midea.gate_bands = {
  ...midea.gate_bands,
  pass: 'CFO/归母≥1.0、年度ROE≥18%，海外毛利稳定，且营运资本与资本开支变动已解释。',
  watch: 'CFO/归母0.8—1.0，或现金流下降、并购与营运资本影响尚未拆清。',
  fail: 'CFO/归母<0.8，或收入/利润转负，或海外毛利连续两期明显恶化。',
}
midea.valuation_gate = '2025营运资本、资本开支和海外毛利已拆清；当前PE-TTM14.96×、股息率4.96%。后续要求CFO/归母维持≥1.0、年度ROE≥18%，且扣非利润恢复。'
midea.hard_fails = [
  'CFO/归母低于0.8',
  '收入或利润转负',
  '海外毛利率连续两期明显恶化',
]

const cypc = (data.stocks as Json[]).find(stock => stock.symbol === '600900')!
cypc.gate_bands = {
  ...cypc.gate_bands,
  pass: 'PE-TTM≤20×、最近完整年度粗FCF收益率≥5%、股息率较10年国债利差≥2.5pp，且质量门不为FAIL。',
  watch: '稳定现金流估值三项只满足一至两项，或来水、资本回报仍需复核。',
}
cypc.valuation_gate = '统一按稳定现金流轨道审查：PE-TTM≤20×、2025粗FCF收益率≥5%、股息率较10年国债利差≥2.5pp才通过。'

const valuationStatuses: Record<string, 'pass' | 'watch' | 'fail'> = {}
for (const stock of data.stocks as Json[]) {
  const snapshot = marketByCode.get(stock.symbol)
  const qualityResult = quality[stock.symbol]
  const valuationResult = valuation[stock.symbol]
  if (!snapshot || !qualityResult || !valuationResult) throw new Error(`Missing completed stock evidence for ${stock.symbol}`)
  const quote = snapshot.quote
  const technical = snapshot.technical
  const yieldSpread = quote.dividend_yield_pct === null ? null : quote.dividend_yield_pct - market.opportunity_cost.yield_pct
  const annualFcfYieldPct = qualityResult.annual_fcf / (quote.market_cap / 1e8) * 100
  const valuationStatus = evaluateValuation(valuationResult, quote, annualFcfYieldPct, yieldSpread, qualityResult.status)
  valuationStatuses[stock.symbol] = valuationStatus
  stock.market_cutoff = market.as_of
  stock.quality_snapshot = qualityResult
  stock.valuation_snapshot = {
    date: market.as_of,
    status: valuationStatus,
    price: quote.price,
    market_cap_100m: quote.market_cap / 1e8,
    pe_ttm: quote.pe_ttm,
    pb: quote.pb,
    dividend_yield_pct: quote.dividend_yield_pct,
    government_bond_10y_pct: market.opportunity_cost.yield_pct,
    dividend_spread_pp: yieldSpread,
    track: valuationResult.track,
    annual_fcf_100m: qualityResult.annual_fcf,
    annual_fcf_yield_pct: annualFcfYieldPct,
    rule: valuationFramework[valuationResult.track],
    conclusion: valuationResult.conclusion,
  }
  stock.technical_snapshot = technical
  stock.gate_bands.fail = falsifier[stock.symbol]!.note
  stock.gate_evidence = {
    fact: fact[stock.symbol]!.note,
    mechanism: mechanismNote[stock.symbol],
    quality: qualityResult.conclusion,
    valuation: valuationResult.conclusion,
    falsifier: falsifier[stock.symbol]!.note,
    council: 'Round 4预留；在独立council_vote聚合前保持OPEN。',
  }
  stock.metrics = [
    ...(stock.metrics as Json[]).slice(0, 4),
    { label: '收盘 / PE-TTM', value: `${numberText(quote.price)} / ${numberText(quote.pe_ttm)}×`, change: `2026-08-25；PB ${numberText(quote.pb)}×` },
    { label: '股息率 / 国债利差', value: `${numberText(quote.dividend_yield_pct)}% / ${yieldSpread === null ? '—' : `${yieldSpread >= 0 ? '+' : ''}${yieldSpread.toFixed(2)}pp`}`, change: '10年国债1.68%' },
    { label: '60日收益 / 超额', value: `${pct(technical.returns['60d'].absolute)} / ${pct(technical.returns['60d'].excess)}`, change: '相对沪深300价格指数' },
    { label: '粗FCF / 归母', value: `${numberText(qualityResult.fcf)}亿元 / ${numberText(qualityResult.fcf_to_profit)}×`, change: qualityResult.period },
  ]
  stock.reason = `${qualityResult.conclusion} ${valuationResult.conclusion} 60日相对沪深300为${pct(technical.returns['60d'].excess)}。`
  stock.source_ids = [...new Set([...(stock.source_ids as string[]), 'market-snapshot', 'chinabond-10y'])]
  if (stock.symbol === '000333') stock.source_ids.push('midea-annual-full')
}

const gateRows: Json[] = (data.stocks as Json[]).map(stock => {
  const qualityStatus = quality[stock.symbol]!.status as 'pass' | 'watch' | 'fail'
  const valuationStatus = valuationStatuses[stock.symbol]!
  const factStatus = fact[stock.symbol]!.status
  const falsifierStatus = falsifier[stock.symbol]!.status
  const dataStatuses = [factStatus, mechanism[stock.symbol], qualityStatus, valuationStatus, falsifierStatus]
  const preCouncilDecision = dataStatuses.includes('fail') ? 'reject' : dataStatuses.includes('watch') ? 'watch' : 'satellite'
  const statuses = [...dataStatuses, 'open']
  const decision = statuses.includes('fail') ? 'reject' : statuses.includes('open') ? 'incomplete' : statuses.includes('watch') ? 'watch' : 'satellite'
  stock.pre_council_decision = preCouncilDecision
  stock.proposed_execution_tier = preCouncilDecision === 'satellite' ? 'satellite' : null
  stock.decision = decision
  stock.layer = decision === 'reject'
    ? 'REJECT / 硬门失守'
    : decision === 'incomplete'
      ? 'INCOMPLETE / 等待Round 4会商门'
      : decision === 'satellite'
        ? 'SATELLITE / 全门通过'
        : 'WATCH / 已完成但条件未过'
  return {
    name: stock.name,
    fact: factStatus,
    mechanism: mechanism[stock.symbol],
    quality: qualityStatus,
    valuation: valuationStatus,
    falsifier: falsifierStatus,
    council: 'open',
    decision,
    gate_notes: stock.gate_evidence,
    action: `${decision.toUpperCase()}；${decision === 'reject'
      ? (qualityStatus === 'fail' ? '质量硬门失守' : '估值安全边际不足')
      : decision === 'incomplete'
        ? 'Round 4会商门尚未执行'
        : decision === 'satellite'
        ? '六门全部通过，按已冻结证伪条件持续复核'
        : '等待当前WATCH条件转为PASS'}`,
  }
})

data.schema_version = 3
data.metadata = {
  ...data.metadata,
  title: 'A股未来一年周期展望：完整门禁与方向评分版',
  as_of: '2026-08-25',
  market_data_cutoff: '2026-08-25',
  forecast_start: '2026-08-25',
  forecast_end: '2027-08-25',
  report_origin_date: '2026-08-23',
  report_revision: '2026.08.25-complete-v1',
  report_artifact: 'docs/a-share-cycle-outlook-2026-08-25.html',
  report_data_artifact: 'docs/research-data/a-share-cycle-outlook-2026-08-25.json',
  turning_point_audit_artifact: 'docs/turning-point-capability-audit-2026-08-23.html',
  repository_url: 'https://github.com/hancao97/hanai-investment-dsh',
  market_snapshot_artifact: 'docs/research-data/a-share-cycle-market-snapshot-2026-08-25.json',
  market_snapshot_sha256: sha256(marketRaw),
  probability_semantics: '主题分数是证据强度而非概率；个股历史条件频率使用非重叠样本与Wilson区间，只作描述，不是未来收益保证。',
  investment_boundary: 'A/A-表示方向证据，不等于买入。股票执行层由六门独立决定；本版不提供目标价、仓位或收益承诺。',
  committee_vote_snapshot: 'Round 1/2与Round 3保留为历史方法论记录；完成版门禁首先由冻结行情、官方财报与机械规则决定，Round 4将允许PASS/CORE后重新复核。',
}
data.theme_scoring = scoring
data.valuation_framework = valuationFramework
data.market_snapshot_summary = {
  date: market.as_of,
  hs300: marketByCode.get('000300')!.technical,
  breadth: market.market_breadth,
  government_bond_10y: market.opportunity_cost,
  interpretation: '沪深300低于MA20/60/120，而当日上涨家数占涨跌家数77.3%；这是弱中期趋势中的单日普涨，不能单独定义反转。',
}
data.verdict = {
  headline: '方向层人工证据评分首次出现A-；数据五门已补齐，但Round 4尚未执行，会商门保持OPEN。',
  summary: 'A-方向由合理估值、强相对趋势和板块广度支撑；美的数据五门已过，但在全状态会商完成前只能标INCOMPLETE。扣非利润下降仍是下一期硬复核项。高股息现金流与电网为B+；半导体为B-；其余为C。',
  primary_watch: '000333 美的集团（INCOMPLETE；等待Round 4，不提前宣布SATELLITE）',
  research_watch: gateRows.filter(row => row.decision === 'watch').map(row => row.name),
  rejected: gateRows.filter(row => row.decision === 'reject').map(row => row.name),
}
data.view_gates.criteria = [
  { id: 'fact', name: '事实门', rule: '一手财报/官方统计与冻结行情均有数据日期和来源；未知不得视为通过。' },
  { id: 'mechanism', name: '机制门', rule: '政策或需求必须能传导至公司订单、利润和现金；仅有标签不得通过。' },
  { id: 'quality', name: '质量门', rule: '用CFO减购建长期资产现金估算粗FCF，并核现金转化、分红覆盖、营运资本和一次性项。' },
  { id: 'valuation', name: '估值门', rule: '统一使用2026-08-25价格、PE-TTM/PB/股息率及10年国债1.68%的机会成本；增长和资本强度必须匹配。' },
  { id: 'falsifier', name: '反证门', rule: '必须有可观测硬失效条件、阈值和降级动作。' },
  { id: 'council', name: '会商门', rule: '同源AI角色只作反方审查；不能替代数据门，也不计作独立统计样本。' },
]
data.view_gates.results = gateRows
data.latest_council.summary = 'Round 3历史输出受WATCH/REJECT提示词限制，不能作为0 PASS证据；完成版将由允许全状态的Round 4覆盖。'
data.latest_council.findings = [
  '市场与质量数据已补齐，六股估值门不再OPEN：2 PASS / 3 WATCH / 1 FAIL；估值轨道与阈值已公开但未经历史校准。',
  '质量门为2 PASS / 3 WATCH / 1 FAIL；美的在补齐2025全年资本开支、分红覆盖与海外毛利后转PASS。',
  '主题采用五维机械评分，首次出现1个A-方向；A/A-不是收益概率。',
]
data.monitor_switches = [
  ...(data.monitor_switches as string[]).slice(0, 6),
  'M1-M2、居民/企业中长期贷款与社融结构是否连续改善',
  '沪深300能否收复MA60，且全市场20日宽度连续10日高于55%',
  'A-家电方向的扣非利润、海外毛利与粗FCF能否同时改善',
  '六股估值、质量和硬失效条件是否发生门禁迁移',
]
data.limitations = [
  '主题五维分数的分档阈值尚未经过跨周期历史校准；本版公开组件与分数，后续必须冻结回看。',
  '个股条件历史统计只有约800根前复权日线，非重叠样本仍小且具有幸存者偏差；Wilson区间不处理制度变化。',
  '东方财富估值字段、概念板块和同日涨跌宽度属于行情商口径；会与官方财报字段分层展示，不混称一手会计数据。',
  '粗FCF=CFO−购建固定/无形/其他长期资产现金，不等于严格维护性资本开支，也未对并购、租赁和金融子公司全部标准化。',
  '五个AI方法论角色共享底层运行环境，投票不是独立概率；数据门优先于会商门。',
  'A/H公司总市值采用A股现价乘行情商总股本，不是按两地价格分别计价的合并经济市值。',
  '同日板块宽度可能快速反转；中期趋势主要依赖MA与20/60/120日相对收益，不能用单日普涨代替。',
  '报告仍不提供目标价、仓位和收益承诺；WATCH表示条件未过，REJECT表示当前硬门失守。',
]
data.sources.push(
  { id: 'market-snapshot', publisher: '东方财富 / 腾讯行情', date: '2026-08-25', title: '六股、主题代理、沪深300估值与前复权技术快照（冻结JSON）', url: './research-data/a-share-cycle-market-snapshot-2026-08-25.json' },
  { id: 'chinabond-10y', publisher: '财政部-中国国债收益率曲线 / CCDC', date: '2026-08-25', title: '10年期国债收益率1.68%', url: 'https://yield.chinabond.com.cn/cbweb-czb-web/czb/moreInfo?locale=cn_ZH&nameType=1' },
  { id: 'midea-annual-full', publisher: '巨潮资讯 / 美的集团', date: '2026-03-31', title: '美的集团2025年年度报告全文', url: 'https://static.cninfo.com.cn/finalpage/2026-03-31/1225065145.PDF' },
)

writeFileSync(OUTPUT, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
process.stdout.write(`${OUTPUT}\n`)
