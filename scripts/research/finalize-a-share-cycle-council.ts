#!/usr/bin/env node

/** Merge the frozen Round 4 expert review into the completed A-share outlook. */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { MASTER_VERSION } from '../../packages/masters/src/index.ts'

type Json = Record<string, any>
type GateStatus = 'pass' | 'watch' | 'open' | 'fail'
type StockDecision = 'core' | 'satellite' | 'watch' | 'reject' | 'incomplete'

const ROOT = resolve(import.meta.dirname, '../..')
const INPUT = resolve(ROOT, process.argv[2] ?? 'docs/research-data/a-share-cycle-outlook-pre-council-2026-08-25.json')
const RUNS = resolve(ROOT, process.argv[3] ?? 'docs/research-data/a-share-cycle-expert-runs-2026-08-25.json')
const OUTPUT = resolve(ROOT, process.argv[4] ?? 'docs/research-data/a-share-cycle-outlook-2026-08-25.json')

const THEME_IDS = ['grid', 'semiconductor', 'pharma', 'appliance', 'dividend', 'robotics'] as const
const STOCK_IDS = ['600900', '000333', '300750', '600276', '600941', '600519'] as const
const GATE_IDS = ['fact', 'mechanism', 'quality', 'valuation', 'falsifier', 'council'] as const
const THEME_STATES = new Set(['PASS', 'WATCH', 'REJECT'])
const STOCK_STATES = new Set(['CORE', 'SATELLITE', 'WATCH', 'REJECT', 'INCOMPLETE'])
const EXPECTED_MASTERS: Record<string, string> = {
  'duan-yongping-perspective': '段永平',
  'hunjianglong-perspective': '混江龙',
  'munger-perspective': '查理·芒格',
  'warren-buffett-perspective': '沃伦·巴菲特',
  'sun-yuchen-perspective': '孙宇晨',
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function clean(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '').trim()
}

function parseOutput(stdout: string): Json | null {
  const cleaned = clean(stdout)
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const candidate = fenced ?? cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1)
  try {
    return JSON.parse(candidate) as Json
  }
  catch {
    return null
  }
}

function expectedThemeDecision(grade: unknown): string | null {
  if (grade === 'A' || grade === 'A-') return 'PASS'
  if (grade === 'B+' || grade === 'B' || grade === 'B-') return 'WATCH'
  if (grade === 'C') return 'REJECT'
  return null
}

function expectedStockDecision(stock: Json): string | null {
  const statuses = ['fact', 'mechanism', 'quality', 'valuation', 'falsifier'].map(id => stock.five_gate_result?.[id])
  if (statuses.some(status => !['pass', 'watch', 'open', 'fail'].includes(status))) return null
  if (statuses.includes('fail')) return 'REJECT'
  if (statuses.includes('open')) return 'INCOMPLETE'
  if (statuses.includes('watch')) return 'WATCH'
  const proposed = normalize(stock.proposed_execution_tier)
  return proposed === 'CORE' || proposed === 'SATELLITE' ? proposed : 'SATELLITE'
}

function validateParsedRun(run: Json, factPack: Json): void {
  const parsed = run.parsed as Json
  const ranks = Array.isArray(parsed.scenario_rank) ? parsed.scenario_rank : []
  if (ranks.length !== 3 || new Set(ranks).size !== 3 || ranks.some(id => !['base', 'upside', 'downside'].includes(id))) {
    throw new Error(`Invalid scenario_rank in ${run.master_id}`)
  }
  if (!Array.isArray(parsed.peer_replies) || parsed.peer_replies.length < 3 || parsed.peer_replies.length > 4) throw new Error(`Invalid peer_replies in ${run.master_id}`)
  if (!Array.isArray(parsed.latest_fact_changes) || parsed.latest_fact_changes.length > 6) throw new Error(`Invalid latest_fact_changes in ${run.master_id}`)
  for (const id of THEME_IDS) {
    const theme = factPack.themes?.find((item: Json) => item.id === id)
    if (normalize(parsed.themes?.[id]) !== expectedThemeDecision(theme?.grade)) throw new Error(`Theme mapping mismatch for ${id} in ${run.master_id}`)
  }
  for (const symbol of STOCK_IDS) {
    const stock = factPack.stocks?.find((item: Json) => item.symbol === symbol)
    if (normalize(parsed.stocks?.[symbol]?.decision) !== expectedStockDecision(stock)) throw new Error(`Stock mapping mismatch for ${symbol} in ${run.master_id}`)
    if (!THEME_STATES.has(normalize(parsed.stocks?.[symbol]?.council_vote))) throw new Error(`Invalid council vote for ${symbol} in ${run.master_id}`)
    if (normalize(parsed.stocks?.[symbol]?.gate_audit) !== 'CONSISTENT') throw new Error(`Unresolved gate audit for ${symbol} in ${run.master_id}`)
  }
}

function normalize(value: unknown): string {
  return String(value ?? '').trim().toUpperCase()
}

function countStates(values: string[], states: readonly string[]): Json {
  return Object.fromEntries(states.map(state => [state.toLowerCase(), values.filter(value => value === state).length]))
}

function stockCouncilStatus(counts: Json): GateStatus {
  if (Number(counts.reject) >= 3) return 'fail'
  if (Number(counts.pass) >= 3) return 'pass'
  return 'watch'
}

function decisionFromGates(statuses: GateStatus[], retainedTier: unknown): StockDecision {
  if (statuses.includes('fail')) return 'reject'
  if (statuses.includes('open')) return 'incomplete'
  if (statuses.includes('watch')) return 'watch'
  return retainedTier === 'core' ? 'core' : 'satellite'
}

function actionFor(decision: StockDecision, row: Json): string {
  if (decision === 'core' || decision === 'satellite') return `${decision.toUpperCase()}；六门全部通过，按冻结证伪条件持续复核`
  if (decision === 'incomplete') return 'INCOMPLETE；仍有数据门未完成，不能进入执行层'
  if (decision === 'watch') {
    const pending = GATE_IDS.filter(id => row[id] === 'watch').join(' / ')
    return `WATCH；${pending || '条件门'}尚未转为PASS`
  }
  const failed = GATE_IDS.filter(id => row[id] === 'fail').join(' / ')
  return `REJECT；${failed || '硬门'}失守`
}

const inputRaw = readFileSync(INPUT)
const data = JSON.parse(inputRaw.toString('utf8')) as Json
const runsRaw = readFileSync(RUNS)
const artifact = JSON.parse(runsRaw.toString('utf8')) as Json
const inputSha256 = sha256(inputRaw)
const runsSha256 = sha256(runsRaw)
if (artifact.input_sha256 !== inputSha256) {
  throw new Error(`Round 4 input hash mismatch: artifact ${artifact.input_sha256} vs report ${inputSha256}`)
}
const expectedInputPath = relative(ROOT, INPUT).replaceAll('\\', '/')
if (artifact.schema_version !== 3 || artifact.input !== expectedInputPath || artifact.master_snapshot_version !== MASTER_VERSION) throw new Error('Round 4 artifact provenance contract mismatch')
if (artifact.script !== 'scripts/research/run-a-share-expert-council.ts' || artifact.script_sha256 !== sha256(readFileSync(resolve(ROOT, artifact.script)))) throw new Error('Round 4 runner script hash mismatch')
if (artifact.common_fact_pack_sha256 !== sha256(JSON.stringify(artifact.common_fact_pack))) throw new Error('Round 4 common fact pack hash mismatch')
if (artifact.common_fact_pack?.as_of !== data.metadata?.as_of) throw new Error('Round 4 fact pack cutoff mismatch')
if (artifact.retry_failed_from) {
  const priorPath = resolve(ROOT, artifact.retry_failed_from)
  if (!existsSync(priorPath) || sha256(readFileSync(priorPath)) !== artifact.prior_artifact_sha256) throw new Error('Round 4 prior artifact is missing or its hash changed')
}
const runs = artifact.runs as Json[]
if (!Array.isArray(runs) || runs.length !== 5) throw new Error('Round 4 must contain exactly five runs')
const masterIds = runs.map(run => run.master_id)
if (new Set(masterIds).size !== 5 || Object.keys(EXPECTED_MASTERS).some(id => !masterIds.includes(id))) throw new Error('Round 4 master set is incomplete or duplicated')
for (const run of runs) {
  if (run.exit_code !== 0 || run.parsed === null || typeof run.parsed !== 'object' || !Array.isArray(run.validation_errors) || run.validation_errors.length > 0) {
    throw new Error(`Round 4 run failed or did not parse: ${run.master_id ?? run.method_role}`)
  }
  if (run.method_role !== EXPECTED_MASTERS[run.master_id] || typeof run.parsed.method_role !== 'string' || run.parsed.method_role.trim().length === 0) throw new Error(`Round 4 role mismatch: ${run.master_id}`)
  if (run.prompt_sha256 !== sha256(String(run.prompt ?? '')) || run.stdout_sha256 !== sha256(String(run.stdout ?? '')) || run.stderr_sha256 !== sha256(String(run.stderr ?? ''))) throw new Error(`Round 4 run hash mismatch: ${run.master_id}`)
  if (!/^[a-f0-9]{64}$/.test(String(run.skill_sha256)) || !/^[a-f0-9]{64}$/.test(String(run.agents_sha256))) throw new Error(`Round 4 Skill provenance missing: ${run.master_id}`)
  if (!String(run.prompt).includes(JSON.stringify(artifact.common_fact_pack))) throw new Error(`Round 4 prompt does not contain the common fact pack: ${run.master_id}`)
  const reparsed = parseOutput(String(run.stdout ?? ''))
  if (reparsed === null || JSON.stringify(reparsed) !== JSON.stringify(run.parsed)) throw new Error(`Round 4 parsed output mismatch: ${run.master_id}`)
  validateParsedRun(run, artifact.common_fact_pack)
}

const themesById = new Map((data.themes as Json[]).map(theme => [theme.id, theme]))
const themeUpgradeConditions: Record<string, string> = {
  grid: '升至A档需代表企业订单/合同负债与粗FCF共同改善，且代表股站回MA60、60日超额转正；不能只靠总投资计划。',
  semiconductor: '升至A档需高利用率延续、粗FCF转强、代表股估值回到可解释区间并站回MA60；当前高估值与弱趋势是主要扣分。',
  pharma: '升至A档需剔除授权后核心销售与扣非恢复双位数、CFO/归母≥1，并取得估值和趋势确认。',
  appliance: '从A-升至A需下一报告期扣非利润恢复正增长、CFO/归母≥1且海外毛利率不再下降；满足后盈利维度由10升至15。',
  dividend: '升至A档需核心代表股FCF/股利≥1.2、股息—国债利差≥2.5pp且中期相对强势延续。',
  robotics: '升至A档需可核订单、毛利、单位经济与粗FCF至少连续两个报告期验证，并建立代表股估值门。',
}
const themeResults: Json[] = []
for (const id of THEME_IDS) {
  const values = runs.map(run => normalize(run.parsed.themes?.[id]))
  if (values.some(value => !THEME_STATES.has(value))) throw new Error(`Invalid Round 4 theme vote for ${id}: ${values.join(', ')}`)
  const counts = countStates(values, ['PASS', 'WATCH', 'REJECT'])
  const theme = themesById.get(id)
  if (!theme) throw new Error(`Missing theme ${id}`)
  theme.latest_committee = counts
  theme.committee_basis = 'Round 4对公开人工评分与A/B/C映射做5次一致性检查；不是自由投票，也不是独立统计样本。'
  theme.upgrade_condition = themeUpgradeConditions[id]
  themeResults.push({ name: theme.name, grade: theme.grade, score: theme.score, ...counts })
}

const stocksBySymbol = new Map((data.stocks as Json[]).map(stock => [stock.symbol, stock]))
const rowsByName = new Map((data.view_gates.results as Json[]).map((row: Json) => [row.name, row]))
const stockResults: Json[] = []
for (const symbol of STOCK_IDS) {
  const values = runs.map(run => normalize(run.parsed.stocks?.[symbol]?.decision))
  if (values.some(value => !STOCK_STATES.has(value))) throw new Error(`Invalid Round 4 stock vote for ${symbol}: ${values.join(', ')}`)
  const counts = countStates(values, ['CORE', 'SATELLITE', 'WATCH', 'REJECT', 'INCOMPLETE'])
  const councilValues = runs.map(run => normalize(run.parsed.stocks?.[symbol]?.council_vote))
  if (councilValues.some(value => !THEME_STATES.has(value))) throw new Error(`Invalid Round 4 council vote for ${symbol}: ${councilValues.join(', ')}`)
  const councilCounts = countStates(councilValues, ['PASS', 'WATCH', 'REJECT'])
  const stock = stocksBySymbol.get(symbol)
  if (!stock) throw new Error(`Missing stock ${symbol}`)
  const row = rowsByName.get(stock.name)
  if (!row) throw new Error(`Missing gate row for ${stock.name}`)
  stock.latest_committee = counts
  stock.latest_council_vote = councilCounts
  row.council = stockCouncilStatus(councilCounts)
  const councilNote = `Round 4会商票 ${councilCounts.pass} PASS / ${councilCounts.watch} WATCH / ${councilCounts.reject} REJECT；按3/5多数映射为${String(row.council).toUpperCase()}。`
  row.gate_notes = { ...(row.gate_notes ?? {}), council: councilNote }
  stock.gate_evidence = { ...(stock.gate_evidence ?? {}), council: councilNote }
  const statuses = GATE_IDS.map(id => row[id] as GateStatus)
  const retainedTier = stock.proposed_execution_tier ?? (stock.decision === 'core' || stock.decision === 'satellite' ? stock.decision : stock.execution_tier)
  const decision = decisionFromGates(statuses, retainedTier)
  stock.decision = decision
  stock.execution_tier = decision === 'core' || decision === 'satellite' ? decision : null
  stock.layer = decision === 'reject'
    ? 'REJECT / 硬门失守'
    : decision === 'incomplete'
      ? 'INCOMPLETE / 数据门未闭环'
      : decision === 'watch'
        ? 'WATCH / 已完成但条件未过'
        : `${decision.toUpperCase()} / 六门通过`
  row.decision = decision
  row.action = actionFor(decision, row)
  stockResults.push({ name: stock.name, ...counts, council_vote: councilCounts, decision, action: row.action })
}

const firstChoiceCounts = new Map<string, number>()
for (const run of runs) {
  const firstId = String(run.parsed.scenario_rank?.[0] ?? '未给出')
  const first = (data.scenarios as Json[]).find(scenario => scenario.id === firstId)?.name ?? firstId
  firstChoiceCounts.set(first, (firstChoiceCounts.get(first) ?? 0) + 1)
}
const scenarioConsensus = [...firstChoiceCounts.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([label, count]) => `${count}/5 ${label}`)
  .join('；')

const decisions = (data.stocks as Json[]).map(stock => stock.decision as StockDecision)
const countDecision = (decision: StockDecision): number => decisions.filter(item => item === decision).length
const strongThemes = (data.themes as Json[]).filter(theme => String(theme.grade).startsWith('A'))
const executable = (data.stocks as Json[]).filter(stock => stock.decision === 'core' || stock.decision === 'satellite')
const primary = executable[0] ?? (data.stocks as Json[]).find(stock => stock.decision === 'watch')

data.verdict = {
  headline: `方向层有${strongThemes.length}个A档（${strongThemes.map(theme => `${theme.grade} ${theme.name}`).join('、') || '无'}）；执行层为${countDecision('core')} CORE / ${countDecision('satellite')} SATELLITE。`,
  summary: `六股36个门格均已落为PASS/WATCH/FAIL，当前${countDecision('watch')}个WATCH、${countDecision('reject')}个REJECT、${countDecision('incomplete')}个INCOMPLETE。方向评分衡量证据强度，个股仍须六门全过；Round 4只作反方复核，不能被解释成独立胜率。`,
  primary_watch: primary ? `${primary.symbol} ${primary.name}（${String(primary.decision).toUpperCase()}）` : '无',
  research_watch: (data.stocks as Json[]).filter(stock => stock.decision === 'watch').map(stock => stock.name),
  rejected: (data.stocks as Json[]).filter(stock => stock.decision === 'reject').map(stock => stock.name),
}

const artifactPath = 'docs/research-data/a-share-cycle-expert-runs-2026-08-25.json'
data.metadata = {
  ...data.metadata,
  expert_run_artifact: artifactPath,
  expert_run_artifact_sha256: runsSha256,
  pre_council_artifact: artifact.input,
  pre_council_sha256: inputSha256,
  expert_run_input_sha256: artifact.input_sha256,
  expert_snapshot_version: artifact.master_snapshot_version,
  expert_runtime: `${artifact.runtime?.dsh ?? 'DSH'} / ${artifact.runtime?.profile ?? 'headless'}；具体模型与reasoning配置未冻结`,
  expert_method: '五个隔离DSH工作区各安装一位专家Skill；Round 4使用同一冻结事实包，允许主题PASS/WATCH/REJECT和个股CORE/SATELLITE/WATCH/REJECT/INCOMPLETE全状态输出。角色共享底层运行环境，不能视为统计独立样本。',
  committee_vote_snapshot: 'Round 1/2/3保留为历史方法记录；最终门禁先由冻结行情、官方财报和机械规则生成，再由Round 4全状态反方复核。AI票不覆盖事实硬门。',
}
data.latest_council = {
  round: 'Round 4 · 完整市场/质量/估值复核',
  executed_at: artifact.generated_at,
  artifact: './research-data/a-share-cycle-expert-runs-2026-08-25.json',
  execution: `${runs.filter(run => run.exit_code === 0).length}/5 exit 0，${runs.filter(run => run.parsed).length}/5 JSON解析并通过当前契约验证；${runs.filter(run => (run.attempt_history?.length ?? 0) > 0).length}/5 经修复重试；DSH ${artifact.runtime?.dsh ?? 'unknown'} ${artifact.runtime?.profile ?? 'headless'}；模型与reasoning未冻结`,
  scenario_consensus: scenarioConsensus,
  theme_results: themeResults,
  stock_results: stockResults,
  disagreements: [
    `主题票与机械评分分开：评分中${strongThemes.length}个A档，Round 4票只记录方法论反方意见。`,
    `个股最终动作由六门优先级决定：${countDecision('core')} CORE / ${countDecision('satellite')} SATELLITE / ${countDecision('watch')} WATCH / ${countDecision('reject')} REJECT / ${countDecision('incomplete')} INCOMPLETE。`,
    '五个角色共享底层运行环境；5/5一致也不是未来概率或真人背书。',
  ],
}

const rawArchiveLimit = '市场快照已保存标准化前复权日线与逐条件事件，可离线复算条件比例；但供应商原始响应体未提交，报价与板块字段只能核验解析值和响应哈希，不能完整回放原始载荷。'
if (!(data.limitations as string[]).includes(rawArchiveLimit)) (data.limitations as string[]).push(rawArchiveLimit)
const marketSource = (data.sources as Json[]).find(source => source.id === 'market-snapshot')
if (marketSource) marketSource.title = '六股、主题代理、沪深300估值与前复权技术解析快照'

writeFileSync(OUTPUT, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
process.stdout.write(`${OUTPUT}\n`)
