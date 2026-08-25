#!/usr/bin/env tsx

/** Run a reproducible, latest-facts gate review through all five packaged expert Skills. */

import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installMasterSnapshot, listMasters, MASTER_VERSION, resolveMasterAssetsRoot } from '../../packages/masters/src/index.ts'

type Json = Record<string, any>

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_INPUT = resolve(ROOT, 'docs/research-data/a-share-cycle-outlook-pre-council-2026-08-25.json')
const DEFAULT_OUTPUT = resolve(ROOT, 'docs/research-data/a-share-cycle-expert-runs-2026-08-25.json')
const DSH = process.env.HANAI_DSH_BIN || '/opt/homebrew/bin/dsh'
const THEME_IDS = ['grid', 'semiconductor', 'pharma', 'appliance', 'dividend', 'robotics'] as const
const STOCK_SYMBOLS = ['600900', '000333', '300750', '600276', '600941', '600519'] as const
const MAX_OUTPUT_CHARACTERS = 6_000

interface CliOptions {
  input: string
  output: string
  retryFailedFrom: string | undefined
}

function parseArgs(args: string[]): CliOptions {
  let input = DEFAULT_INPUT
  let output = DEFAULT_OUTPUT
  let retryFailedFrom: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: pnpm exec tsx scripts/research/run-a-share-expert-council.ts [--input PATH] [--output PATH] [--retry-failed-from PATH]')
      process.exit(0)
    }

    const [flag, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined]
    if (flag !== '--input' && flag !== '--output' && flag !== '--retry-failed-from') throw new Error(`Unknown argument: ${arg}`)
    const value = inlineValue ?? args[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    const path = resolve(ROOT, value)
    if (flag === '--input') input = path
    else if (flag === '--output') output = path
    else retryFailedFrom = path
  }

  if (retryFailedFrom !== undefined && resolve(retryFailedFrom) === resolve(output)) {
    throw new Error('--retry-failed-from must be an immutable artifact at a path different from --output')
  }
  return { input, output, retryFailedFrom }
}

function artifactPath(path: string): string {
  const repoRelative = relative(ROOT, path).replaceAll('\\', '/')
  return repoRelative.startsWith('../') ? path : repoRelative
}

function sha(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function compactTechnical(snapshot: Json | undefined): Json | null {
  if (!snapshot) return null
  return {
    return_60d: snapshot.returns?.['60d']?.absolute,
    excess_60d: snapshot.returns?.['60d']?.excess,
    return_120d: snapshot.returns?.['120d']?.absolute,
    excess_120d: snapshot.returns?.['120d']?.excess,
    above_ma20: snapshot.state?.above_ma20,
    above_ma60: snapshot.state?.above_ma60,
    above_ma120: snapshot.ma?.close_vs_ma120 == null ? undefined : snapshot.ma.close_vs_ma120 > 0,
  }
}

function compactQuality(snapshot: Json | undefined): Json | null {
  if (!snapshot) return null
  return {
    status: snapshot.status,
    period: snapshot.period,
    cfo: snapshot.cfo,
    capex: snapshot.capex,
    fcf: snapshot.fcf,
    fcf_to_profit: snapshot.fcf_to_profit,
    annual: snapshot.annual,
    conclusion: snapshot.conclusion,
  }
}

function compactValuation(snapshot: Json | undefined): Json | null {
  if (!snapshot) return null
  return {
    status: snapshot.status,
    pe_ttm: snapshot.pe_ttm,
    dividend_yield_pct: snapshot.dividend_yield_pct,
    dividend_spread_pp: snapshot.dividend_spread_pp,
    annual_fcf_yield_pct: snapshot.annual_fcf_yield_pct,
    conclusion: snapshot.conclusion,
  }
}

function compactFactPack(data: Json): Json {
  const gateByName = new Map(
    (data.view_gates?.results ?? []).map((result: Json) => [result.name, result]),
  )

  return {
    as_of: data.metadata.as_of,
    market_data_cutoff: data.metadata.market_data_cutoff,
    forecast_window: [data.metadata.forecast_start, data.metadata.forecast_end],
    scenario_rule: data.scenario_state_rule,
    scenarios: data.scenarios?.map((scenario: Json) => ({
      id: scenario.id,
      name: scenario.name,
      priority: scenario.priority,
      description: scenario.description,
    })),
    scenario_indicators: data.scenario_scorecard?.map((indicator: Json) => ({
      name: indicator.name,
      current: indicator.current,
      upside: indicator.upside,
      downside: indicator.downside,
    })),
    macro_evidence: data.macro_evidence?.map((item: Json) => ({
      label: item.label,
      value: item.value,
      tone: item.tone,
    })),
    market_snapshot: {
      date: data.market_snapshot_summary?.date,
      hs300: {
        return_20d: data.market_snapshot_summary?.hs300?.returns?.['20d']?.absolute,
        return_60d: data.market_snapshot_summary?.hs300?.returns?.['60d']?.absolute,
        return_120d: data.market_snapshot_summary?.hs300?.returns?.['120d']?.absolute,
        above_ma20: data.market_snapshot_summary?.hs300?.state?.above_ma20,
        above_ma60: data.market_snapshot_summary?.hs300?.state?.above_ma60,
        above_ma120: data.market_snapshot_summary?.hs300?.ma?.close_vs_ma120 == null
          ? undefined
          : data.market_snapshot_summary.hs300.ma.close_vs_ma120 > 0,
      },
      breadth_advance_ratio: data.market_snapshot_summary?.breadth?.advance_ratio,
      government_bond_10y_pct: data.market_snapshot_summary?.government_bond_10y?.yield_pct,
      interpretation: data.market_snapshot_summary?.interpretation,
    },
    theme_scoring: {
      components: data.theme_scoring?.components?.map((component: Json) => component.id),
      grade_mapping: { A: 85, 'A-': 80, 'B+': 75, B: 70, 'B-': 60, C: 0 },
      execution_separation: data.theme_scoring?.execution_separation,
    },
    theme_review_rule: 'score/grade是按报告公开尺度形成的人工证据评分，不是概率，也不是专家自由投票。Round 4只审计映射一致性：A或A-→PASS；B+、B或B-→WATCH；C→REJECT；不得在会商输出中暗改分数。',
    themes: data.themes.map((theme: Json) => ({
      id: theme.id,
      name: theme.name,
      grade: theme.grade,
      score: theme.score,
      score_components: theme.score_components,
      score_summary: theme.score_summary,
      market_evidence: theme.market_evidence && {
        date: theme.market_evidence.date,
        board_change_pct: theme.market_evidence.board_change_pct,
        board_advance_ratio: theme.market_evidence.board_advance_ratio,
      },
      hard_fail: theme.hard_fail,
    })),
    stocks: data.stocks.map((stock: Json) => ({
      symbol: stock.symbol,
      name: stock.name,
      pre_round4_decision: stock.pre_council_decision,
      proposed_execution_tier: stock.proposed_execution_tier,
      financial_cutoff: stock.financial_cutoff,
      quality_evidence: compactQuality(stock.quality_snapshot),
      valuation_evidence: compactValuation(stock.valuation_snapshot),
      technical_evidence: compactTechnical(stock.technical_snapshot),
      five_gate_result: (() => {
        const gate = gateByName.get(stock.name) as Json | undefined
        if (!gate) return null
        return {
          fact: gate.fact,
          mechanism: gate.mechanism,
          quality: gate.quality,
          valuation: gate.valuation,
          falsifier: gate.falsifier,
          non_pass_notes: Object.fromEntries(
            ['fact', 'mechanism', 'quality', 'valuation']
              .filter(id => gate[id] !== 'pass')
              .map(id => [id, gate.gate_notes?.[id]]),
          ),
          falsifier_note: gate.gate_notes?.falsifier,
        }
      })(),
    })),
    stock_decision_rule: '只核前五门，忽略预留council=OPEN：FAIL→REJECT；否则OPEN→INCOMPLETE；否则WATCH→WATCH；全PASS→proposed_execution_tier，未预设则SATELLITE。另给council_vote=PASS|WATCH|REJECT，不得回写前五门。',
    peer_challenges: [
      '经营现金流不等于扣除维护性资本开支后的自由现金流。',
      '成交与资金确认不能替代公司价值，但静态公司质量也不能替代周期风险。',
      '政策总盘子不能直接推出单家公司份额、毛利和回款。',
      '短缺与高利润会诱发资本开支，最终可能转成过剩。',
      '品牌、红利、创新药授权和高增长都可能被标签偏误高估。',
      '五个角色共享同一底层模型，投票不是独立概率。',
    ],
  }
}

function promptFor(masterName: string, factPack: Json): string {
  return `执行 Hanai A股一年展望 Round 4 一致性复核。你是“${masterName}”方法论AI角色；相关真人未参与、审核或背书。只用冻结事实包，不联网补数，不把五个同源角色当独立概率。主题分级及前五门是待核映射，不可按个人偏好改写。

任务：
1. 用base/upside/downside各一次给情景排序，不给概率。
2. 回应3—4条peer_challenges，明确accepted_revision。
3. 六主题严格按theme_review_rule输出PASS/WATCH/REJECT，不重算分数。
4. 六股严格按five_gate_result及stock_decision_rule输出decision；另给council_vote。发现输入映射矛盾才写INCONSISTENT。
5. latest_fact_changes最多6条。不得给目标价、仓位、买入指令或收益承诺。

只输出一个JSON对象，无Markdown/围栏/前后缀，总长度不超过${MAX_OUTPUT_CHARACTERS}字符。所有解释字段每项不超过60个汉字。必需字段：
{"method_role":"...","scenario_rank":["base","upside","downside"],"strongest_switch":"...","peer_replies":[{"claim":"...","reply":"..."}],"accepted_revision":"...","themes":{"grid":"...","semiconductor":"...","pharma":"...","appliance":"...","dividend":"...","robotics":"..."},"stocks":{"600900":S,"000333":S,"300750":S,"600276":S,"600941":S,"600519":S},"latest_fact_changes":["..."],"strongest_objection":"..."}
S={"decision":"CORE|SATELLITE|WATCH|REJECT|INCOMPLETE","council_vote":"PASS|WATCH|REJECT","gate_audit":"CONSISTENT|INCONSISTENT","reason":"...","missing_evidence":"...","hard_fail":"..."}；themes值只能PASS|WATCH|REJECT。

冻结事实包：
${JSON.stringify(factPack)}`
}

function repairPromptFor(masterName: string, factPack: Json, errors: string[]): string {
  return `${promptFor(masterName, factPack)}

自动紧凑修复重试：上次输出未通过（${errors.join('；')}）。请重新生成完整JSON；不得复述事实包，优先缩短解释，务必保留全部六主题、六股及必需字段。`
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
  const gate = stock.five_gate_result
  const statuses = ['fact', 'mechanism', 'quality', 'valuation', 'falsifier'].map(id => gate?.[id])
  if (statuses.some(status => !['pass', 'watch', 'open', 'fail'].includes(status))) return null
  if (statuses.includes('fail')) return 'REJECT'
  if (statuses.includes('open')) return 'INCOMPLETE'
  if (statuses.includes('watch')) return 'WATCH'
  const proposed = String(stock.proposed_execution_tier ?? '').toUpperCase()
  return proposed === 'CORE' || proposed === 'SATELLITE' ? proposed : 'SATELLITE'
}

function validateFactPack(factPack: Json): string[] {
  const errors: string[] = []
  for (const id of THEME_IDS) {
    const theme = factPack.themes?.find((entry: Json) => entry.id === id)
    if (!theme) errors.push(`themes.${id} is missing from the fact pack`)
    else if (expectedThemeDecision(theme.grade) === null) errors.push(`themes.${id}.grade is outside the disclosed review mapping`)
  }
  for (const symbol of STOCK_SYMBOLS) {
    const stock = factPack.stocks?.find((entry: Json) => entry.symbol === symbol)
    if (!stock) errors.push(`stocks.${symbol} is missing from the fact pack`)
    else if (expectedStockDecision(stock) === null) errors.push(`stocks.${symbol} has incomplete or inconsistent pre-council gates`)
  }
  return errors
}

function validateOutput(parsed: Json, factPack: Json): string[] {
  const errors: string[] = []
  const validateExplanation = (value: unknown, path: string): void => {
    if (typeof value !== 'string' || value.trim().length === 0) errors.push(`${path} must be a non-empty string`)
    else if (Array.from(value).length > 60) errors.push(`${path} must not exceed 60 characters`)
  }
  if (typeof parsed.method_role !== 'string' || parsed.method_role.trim().length === 0) errors.push('method_role must be a non-empty string')
  for (const field of ['strongest_switch', 'accepted_revision', 'strongest_objection']) validateExplanation(parsed[field], field)
  const scenarioRank = Array.isArray(parsed.scenario_rank) ? parsed.scenario_rank : []
  if (scenarioRank.length !== 3 || new Set(scenarioRank).size !== 3 || scenarioRank.some(id => !['base', 'upside', 'downside'].includes(id))) {
    errors.push('scenario_rank must be a permutation of base, upside and downside')
  }
  if (!Array.isArray(parsed.peer_replies) || parsed.peer_replies.length < 3 || parsed.peer_replies.length > 4) {
    errors.push('peer_replies must contain three or four replies')
  }
  else {
    for (const [index, reply] of parsed.peer_replies.entries()) {
      validateExplanation(reply?.claim, `peer_replies.${index}.claim`)
      validateExplanation(reply?.reply, `peer_replies.${index}.reply`)
    }
  }
  if (!Array.isArray(parsed.latest_fact_changes) || parsed.latest_fact_changes.length > 6 || parsed.latest_fact_changes.some((item: unknown) => typeof item !== 'string' || item.trim().length === 0)) {
    errors.push('latest_fact_changes must contain at most six non-empty strings')
  }
  else parsed.latest_fact_changes.forEach((item: string, index: number) => validateExplanation(item, `latest_fact_changes.${index}`))

  const themeDecisions = new Set(['PASS', 'WATCH', 'REJECT'])
  for (const id of THEME_IDS) {
    if (!themeDecisions.has(parsed.themes?.[id])) errors.push(`themes.${id} has an invalid decision`)
    const theme = factPack.themes.find((entry: Json) => entry.id === id)
    const expected = expectedThemeDecision(theme?.grade)
    if (expected !== null && parsed.themes?.[id] !== expected) errors.push(`themes.${id} does not follow the disclosed grade mapping (${expected})`)
  }

  const stockDecisions = new Set(['CORE', 'SATELLITE', 'WATCH', 'REJECT', 'INCOMPLETE'])
  const councilVotes = new Set(['PASS', 'WATCH', 'REJECT'])
  for (const symbol of STOCK_SYMBOLS) {
    if (!stockDecisions.has(parsed.stocks?.[symbol]?.decision)) errors.push(`stocks.${symbol}.decision is invalid`)
    if (!councilVotes.has(parsed.stocks?.[symbol]?.council_vote)) errors.push(`stocks.${symbol}.council_vote is invalid`)
    if (parsed.stocks?.[symbol]?.gate_audit !== 'CONSISTENT') errors.push(`stocks.${symbol}.gate_audit must be CONSISTENT after the mechanical mapping checks pass`)
    for (const field of ['reason', 'missing_evidence', 'hard_fail']) {
      validateExplanation(parsed.stocks?.[symbol]?.[field], `stocks.${symbol}.${field}`)
    }
    const stock = factPack.stocks.find((entry: Json) => entry.symbol === symbol)
    const expected = expectedStockDecision(stock)
    if (expected !== null && parsed.stocks?.[symbol]?.decision !== expected) errors.push(`stocks.${symbol}.decision does not follow the five-gate pre-council mapping (${expected})`)
  }
  return errors
}

interface Execution {
  stdout: string
  stderr: string
  exit_code: number | null
  duration_ms: number
}

interface PriorArtifactContext {
  path: string
  artifactPath: string
  artifactSha256: string
  artifact: Json
  runsByMasterId: Map<string, Json>
}

function outputCharacterCount(value: string): number {
  return Array.from(value).length
}

function runDsh(workspace: string, prompt: string): Promise<Execution> {
  return new Promise(resolveRun => {
    const started = Date.now()
    const child = spawn(DSH, ['--profile', 'headless', prompt], {
      cwd: workspace,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun({ stdout: clean(stdout), stderr: clean(stderr), exit_code: code, duration_ms: Date.now() - started })
    }
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGTERM'), 240_000)
    child.on('error', error => {
      stderr += `${stderr ? '\n' : ''}${error.message}`
      finish(null)
    })
    child.on('close', finish)
  })
}

function executionValidation(execution: Execution, factPack: Json): { parsed: Json | null; validationErrors: string[] } {
  const parsed = parseOutput(execution.stdout)
  const validationErrors: string[] = []
  if (execution.exit_code !== 0) validationErrors.push(`DSH exited with code ${execution.exit_code ?? 'null'}`)
  if (outputCharacterCount(execution.stdout) > MAX_OUTPUT_CHARACTERS) {
    validationErrors.push(`stdout exceeds ${MAX_OUTPUT_CHARACTERS} characters`)
  }
  if (parsed === null) validationErrors.push('stdout is not valid JSON')
  else validationErrors.push(...validateOutput(parsed, factPack))
  return { parsed, validationErrors }
}

function revalidatePriorRun(run: Json | undefined, factPack: Json): Json | undefined {
  if (run === undefined) return undefined
  const execution: Execution = {
    stdout: typeof run.stdout === 'string' ? run.stdout : '',
    stderr: typeof run.stderr === 'string' ? run.stderr : '',
    exit_code: typeof run.exit_code === 'number' ? run.exit_code : null,
    duration_ms: Number(run.duration_ms) || 0,
  }
  const { parsed, validationErrors } = executionValidation(execution, factPack)
  return {
    ...run,
    parsed,
    validation_errors: validationErrors,
    revalidated_with_current_contract: true,
  }
}

function isReusableRun(run: Json | undefined, prompt: string, installed: { skillPath: string; agentsPath: string }): run is Json {
  return run !== undefined
    && run.exit_code === 0
    && run.parsed !== null
    && Array.isArray(run.validation_errors)
    && run.validation_errors.length === 0
    && run.prompt_sha256 === sha(prompt)
    && run.stdout_sha256 === sha(String(run.stdout ?? ''))
    && run.stderr_sha256 === sha(String(run.stderr ?? ''))
    && run.skill_sha256 === sha(readFileSync(installed.skillPath))
    && run.agents_sha256 === sha(readFileSync(installed.agentsPath))
}

function attemptEvidence(run: Json, source: Json): Json {
  const stdout = typeof run.stdout === 'string' ? run.stdout : ''
  const stderr = typeof run.stderr === 'string' ? run.stderr : ''
  return {
    source,
    prompt_sha256: run.prompt_sha256,
    stdout,
    stdout_sha256: run.stdout_sha256 ?? sha(stdout),
    stderr,
    stderr_sha256: run.stderr_sha256 ?? sha(stderr),
    exit_code: run.exit_code ?? null,
    duration_ms: run.duration_ms,
    parsed: run.parsed ?? null,
    validation_errors: Array.isArray(run.validation_errors) ? run.validation_errors : ['validation_errors missing'],
  }
}

function loadPriorArtifact(path: string, inputSha256: string): PriorArtifactContext {
  const raw = readFileSync(path)
  const artifact = JSON.parse(raw.toString('utf8')) as Json
  if (artifact.input_sha256 !== inputSha256) {
    throw new Error(`Retry artifact input_sha256 mismatch: expected ${inputSha256}, received ${String(artifact.input_sha256)}`)
  }
  if (!Array.isArray(artifact.runs)) throw new Error('Retry artifact does not contain a runs array')

  const runsByMasterId = new Map<string, Json>()
  for (const run of artifact.runs) {
    if (typeof run?.master_id !== 'string') throw new Error('Retry artifact contains a run without master_id')
    if (runsByMasterId.has(run.master_id)) throw new Error(`Retry artifact contains duplicate master_id: ${run.master_id}`)
    runsByMasterId.set(run.master_id, run)
  }

  return {
    path,
    artifactPath: artifactPath(path),
    artifactSha256: sha(raw),
    artifact,
    runsByMasterId,
  }
}

function priorSource(prior: PriorArtifactContext): Json {
  return {
    artifact: prior.artifactPath,
    artifact_sha256: prior.artifactSha256,
    generated_at: prior.artifact.generated_at,
  }
}

function inheritedAttemptHistory(run: Json | undefined, prior: PriorArtifactContext | undefined): Json[] {
  if (!run || !prior) return []
  const history = Array.isArray(run.attempt_history) ? [...run.attempt_history] : []
  history.push(attemptEvidence(run, priorSource(prior)))
  return history
}

async function executeWithRepair(item: Json, factPack: Json, inheritedHistory: Json[]): Promise<Json> {
  let prompt = item.prompt as string
  let promptMode = 'standard'
  let execution = await runDsh(item.workspace, prompt)
  let { parsed, validationErrors } = executionValidation(execution, factPack)
  const attemptHistory = [...inheritedHistory]

  if (validationErrors.length > 0) {
    attemptHistory.push(attemptEvidence({
      ...execution,
      parsed,
      prompt_sha256: sha(prompt),
      validation_errors: validationErrors,
    }, { kind: 'current_run', prompt_mode: promptMode }))
    prompt = repairPromptFor(item.master.name, factPack, validationErrors)
    promptMode = 'compact_repair'
    execution = await runDsh(item.workspace, prompt)
    ;({ parsed, validationErrors } = executionValidation(execution, factPack))
  }

  return {
    master_id: item.master.id,
    method_role: item.master.name,
    persona_disclaimer: 'AI方法论角色；相关真人未参与、未审核、未背书。',
    prompt,
    prompt_mode: promptMode,
    prompt_sha256: sha(prompt),
    skill_sha256: sha(readFileSync(item.installed.skillPath)),
    agents_sha256: sha(readFileSync(item.installed.agentsPath)),
    ...execution,
    stdout_sha256: sha(execution.stdout),
    stderr_sha256: sha(execution.stderr),
    parsed,
    validation_errors: validationErrors,
    attempt_history: attemptHistory,
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const rawInput = readFileSync(options.input)
  const inputSha256 = sha(rawInput)
  const data = JSON.parse(rawInput.toString('utf8')) as Json
  const factPack = compactFactPack(data)
  const factPackErrors = validateFactPack(factPack)
  if (factPackErrors.length > 0) throw new Error(`Invalid fact pack:\n- ${factPackErrors.join('\n- ')}`)
  const prior = options.retryFailedFrom ? loadPriorArtifact(options.retryFailedFrom, inputSha256) : undefined
  const assetsRoot = resolveMasterAssetsRoot(import.meta.url)
  const runRoot = mkdtempSync(join(tmpdir(), 'hanai-a-share-council-'))
  try {
    const masters = listMasters()
    const resultsByMasterId = new Map<string, Json>()
    const toExecute: Json[] = []
    for (const master of masters) {
      const workspace = join(runRoot, master.id)
      const installed = installMasterSnapshot(assetsRoot, master, workspace, 'open-chat')
      const prompt = promptFor(master.name, factPack)
      const priorRun = revalidatePriorRun(prior?.runsByMasterId.get(master.id), factPack)
      if (isReusableRun(priorRun, prompt, installed) && prior) {
        resultsByMasterId.set(master.id, {
          ...priorRun,
          reused_from: priorSource(prior),
        })
        continue
      }
      toExecute.push({ master, workspace, installed, prompt, priorRun })
    }

    const dshVersion = toExecute.length === 0
      ? String(prior?.artifact.runtime?.dsh ?? 'not invoked; all runs reused')
      : clean(spawnSync(DSH, ['--version'], { encoding: 'utf8' }).stdout || 'unknown')
    for (let index = 0; index < toExecute.length; index += 2) {
      const batch = toExecute.slice(index, index + 2)
      const completed = await Promise.all(batch.map(item => executeWithRepair(
        item,
        factPack,
        inheritedAttemptHistory(item.priorRun, prior),
      )))
      for (const result of completed) resultsByMasterId.set(result.master_id, result)
    }

    const results = masters.map(master => {
      const result = resultsByMasterId.get(master.id)
      if (!result) throw new Error(`Internal error: no result for ${master.id}`)
      return result
    })
    const reusedMasterIds = results.filter(result => result.reused_from).map(result => result.master_id)
    const rerunMasterIds = results.filter(result => !result.reused_from).map(result => result.master_id)
    const artifact = {
      schema_version: 3,
      generated_at: new Date().toISOString(),
      purpose: 'Round 4 completed-data consistency review. Theme statuses audit a disclosed human evidence-score mapping rather than form free or independent votes; stock council votes review, but never rewrite, the five pre-council data gates. Raw DSH stdout/stderr retained for audit.',
      review_semantics: {
        themes: 'PASS/WATCH/REJECT is a consistency audit of the disclosed human evidence-score grade mapping, not an independent probability or fresh score.',
        stocks: 'decision follows the five pre-council gates; council_vote is the reviewer output used downstream to close the sixth gate.',
      },
      input: artifactPath(options.input),
      input_sha256: inputSha256,
      ...(prior && {
        retry_failed_from: prior.artifactPath,
        prior_artifact_sha256: prior.artifactSha256,
        retry_summary: {
          reused_master_ids: reusedMasterIds,
          rerun_master_ids: rerunMasterIds,
          rule: 'A prior run is reused only after current-contract revalidation and exact prompt, Skill and AGENTS hash matches. Every rejected or failed final attempt remains in attempt_history.',
        },
      }),
      script: 'scripts/research/run-a-share-expert-council.ts',
      script_sha256: sha(readFileSync(fileURLToPath(import.meta.url))),
      master_snapshot_version: MASTER_VERSION,
      runtime: {
        dsh: dshVersion,
        profile: 'headless',
        concurrency: 2,
        max_attempts_per_executed_master: 2,
        max_output_characters: MAX_OUTPUT_CHARACTERS,
        model_config_frozen: false,
        note: 'The artifact does not prove a specific model name or reasoning-effort setting.',
      },
      common_fact_pack_sha256: sha(JSON.stringify(factPack)),
      common_fact_pack: factPack,
      runs: results,
    }
    mkdirSync(dirname(options.output), { recursive: true })
    writeFileSync(options.output, `${JSON.stringify(artifact, null, 2)}\n`)
    const failed = results.filter(result => result.exit_code !== 0 || result.validation_errors.length > 0)
    console.log(`Wrote ${options.output}; ${results.length - failed.length}/${results.length} parsed and validated successfully`)
    if (failed.length > 0) process.exitCode = 1
  }
  finally {
    rmSync(runRoot, { recursive: true, force: true })
  }
}

await main()
