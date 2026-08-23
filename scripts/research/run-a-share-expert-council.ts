#!/usr/bin/env tsx

/** Run a reproducible, latest-facts gate review through all five packaged expert Skills. */

import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installMasterSnapshot, listMasters, MASTER_VERSION, resolveMasterAssetsRoot } from '../../packages/masters/src/index.ts'

type Json = Record<string, any>

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const INPUT = resolve(ROOT, 'docs/research-data/a-share-cycle-outlook-2026-08-23.json')
const OUTPUT = resolve(ROOT, 'docs/research-data/a-share-cycle-expert-runs-2026-08-23.json')
const DSH = process.env.HANAI_DSH_BIN || '/opt/homebrew/bin/dsh'

function sha(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function compactFactPack(data: Json): Json {
  return {
    as_of: data.metadata.as_of,
    disclosure: data.metadata.expert_disclosure,
    scenario_rule: data.scenario_state_rule,
    scenario_indicators: data.scenario_scorecard,
    macro_evidence: data.macro_evidence,
    themes: data.themes.map((theme: Json) => ({
      id: theme.id,
      name: theme.name,
      grade: theme.grade,
      committee: theme.committee,
      committee_basis: theme.committee_basis,
      evidence: theme.evidence,
      hard_fail: theme.hard_fail,
    })),
    stocks: data.stocks.map((stock: Json) => ({
      symbol: stock.symbol,
      name: stock.name,
      financial_cutoff: stock.financial_cutoff,
      metrics: stock.metrics,
      reason: stock.reason,
      valuation_gate: stock.valuation_gate,
      gate_bands: stock.gate_bands,
    })),
    strict_gate_rule: '任一门FAIL→REJECT；任一门WATCH/OPEN→WATCH；六门全部PASS才可CORE/SATELLITE。实时估值全部OPEN，所以本轮股票最多WATCH。',
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
  return `你正在执行 Hanai A股一年展望的最终事实门复核。你是“${masterName}”方法论 AI 角色，不是相关真人；真人没有参与或背书。只能使用下方冻结事实包，不得联网补数，不得把五个同源角色当成独立概率。

任务：
1. 回应至少三条 peer_challenges，明确你接受哪条批评；
2. 按互斥状态机给三情景排序，但不得给概率；
3. 对六主题逐一给 WATCH 或 REJECT；
4. 对六股严格执行 strict_gate_rule，只能给 WATCH 或 REJECT，并写最关键缺口与硬失效；
5. 指出最新2026财报相对旧快照改变了什么；
6. 不得给目标价、仓位、买入指令或收益承诺。

只输出一个合法 JSON 对象，不要 Markdown，不要代码围栏。结构：
{"method_role":"...","scenario_rank":["...","...","..."],"strongest_switch":"...","peer_replies":[{"claim":"...","reply":"..."}],"accepted_revision":"...","themes":{"grid":"WATCH|REJECT","semiconductor":"WATCH|REJECT","pharma":"WATCH|REJECT","appliance":"WATCH|REJECT","dividend":"WATCH|REJECT","robotics":"WATCH|REJECT"},"stocks":{"600900":{"decision":"WATCH|REJECT","reason":"...","missing_evidence":"...","hard_fail":"..."},"000333":{},"300750":{},"600276":{},"600941":{},"600519":{}},"latest_fact_changes":["..."],"strongest_objection":"..."}

冻结事实包：
${JSON.stringify(factPack)}`
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

function runDsh(workspace: string, prompt: string): Promise<{ stdout: string; stderr: string; exit_code: number | null; duration_ms: number }> {
  return new Promise(resolveRun => {
    const started = Date.now()
    const child = spawn(DSH, ['--profile', 'headless', prompt], {
      cwd: workspace,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGTERM'), 240_000)
    child.on('close', code => {
      clearTimeout(timer)
      resolveRun({ stdout: clean(stdout), stderr: clean(stderr), exit_code: code, duration_ms: Date.now() - started })
    })
  })
}

async function main(): Promise<void> {
  const rawInput = readFileSync(INPUT)
  const data = JSON.parse(rawInput.toString('utf8')) as Json
  const factPack = compactFactPack(data)
  const assetsRoot = resolveMasterAssetsRoot(import.meta.url)
  const runRoot = mkdtempSync(join(tmpdir(), 'hanai-a-share-council-'))
  const dshVersion = clean(spawnSync(DSH, ['--version'], { encoding: 'utf8' }).stdout || 'unknown')
  try {
    const prepared = listMasters().map(master => {
      const workspace = join(runRoot, master.id)
      const installed = installMasterSnapshot(assetsRoot, master, workspace, 'open-chat')
      const prompt = promptFor(master.name, factPack)
      return { master, workspace, installed, prompt }
    })
    const results: Json[] = []
    for (let index = 0; index < prepared.length; index += 2) {
      const batch = prepared.slice(index, index + 2)
      const completed = await Promise.all(batch.map(async item => {
        const execution = await runDsh(item.workspace, item.prompt)
        return {
          master_id: item.master.id,
          method_role: item.master.name,
          persona_disclaimer: 'AI方法论角色；相关真人未参与、未审核、未背书。',
          prompt: item.prompt,
          prompt_sha256: sha(item.prompt),
          skill_sha256: sha(readFileSync(item.installed.skillPath)),
          agents_sha256: sha(readFileSync(item.installed.agentsPath)),
          ...execution,
          parsed: parseOutput(execution.stdout),
        }
      }))
      results.push(...completed)
    }
    const artifact = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      purpose: 'Latest-facts gate review; raw DSH stdout/stderr retained for audit.',
      input: 'docs/research-data/a-share-cycle-outlook-2026-08-23.json',
      input_sha256: sha(rawInput),
      script: 'scripts/research/run-a-share-expert-council.ts',
      script_sha256: sha(readFileSync(fileURLToPath(import.meta.url))),
      master_snapshot_version: MASTER_VERSION,
      runtime: {
        dsh: dshVersion,
        profile: 'headless',
        concurrency: 2,
        model_config_frozen: false,
        note: 'The artifact does not prove a specific model name or reasoning-effort setting.',
      },
      common_fact_pack: factPack,
      runs: results,
    }
    mkdirSync(dirname(OUTPUT), { recursive: true })
    writeFileSync(OUTPUT, `${JSON.stringify(artifact, null, 2)}\n`)
    const failed = results.filter(result => result.exit_code !== 0 || result.parsed === null)
    console.log(`Wrote ${OUTPUT}; ${results.length - failed.length}/${results.length} parsed successfully`)
    if (failed.length > 0) process.exitCode = 1
  }
  finally {
    rmSync(runRoot, { recursive: true, force: true })
  }
}

await main()
