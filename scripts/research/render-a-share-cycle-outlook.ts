#!/usr/bin/env tsx

/** Render the one-year A-share outlook and five-expert council as a portable HTML report. */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type Json = Record<string, any>

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_INPUT = resolve(ROOT, 'docs/research-data/a-share-cycle-outlook-2026-08-23.json')
const DEFAULT_OUTPUT = resolve(ROOT, 'docs/a-share-cycle-outlook-2026-08-23.html')

function args(): { input: string; output: string } {
  let input = DEFAULT_INPUT
  let output = DEFAULT_OUTPUT
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index]
    const value = process.argv[index + 1]
    if (!key || !value) throw new Error('Usage: [--input path] [--output path]')
    if (key === '--input') input = resolve(value)
    else if (key === '--output') output = resolve(value)
    else throw new Error(`Unknown option: ${key}`)
  }
  return { input, output }
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function sourceMap(data: Json): Map<string, Json> {
  return new Map((data.sources as Json[]).map(source => [source.id, source]))
}

function sourceRefs(ids: string[], sources: Map<string, Json>): string {
  return ids.map(id => {
    const source = sources.get(id)
    if (!source) return `<span class="source-missing">[${esc(id)}]</span>`
    return `<a class="source-ref" href="${esc(source.url)}" target="_blank" rel="noreferrer">${esc(source.publisher)} · ${esc(source.date)}</a>`
  }).join(' ')
}

function status(value: string): string {
  const normalized = value.toLowerCase()
  const label: Record<string, string> = { pass: '通过', watch: '待核', open: '未完成', fail: '失败' }
  return `<span class="status status-${esc(normalized)}">${esc(label[normalized] ?? value)}</span>`
}

function voteBar(votes: Json): string {
  const pass = Number(votes.pass ?? 0)
  const watch = Number(votes.watch ?? 0)
  const reject = Number(votes.reject ?? 0)
  const total = pass + watch + reject
  const cells: string[] = []
  for (let i = 0; i < pass; i++) cells.push('<i class="vote vote-pass" aria-label="PASS"></i>')
  for (let i = 0; i < watch; i++) cells.push('<i class="vote vote-watch" aria-label="WATCH"></i>')
  for (let i = 0; i < reject; i++) cells.push('<i class="vote vote-reject" aria-label="REJECT"></i>')
  return `<div class="votes" aria-label="委员会：${pass} PASS，${watch} WATCH，${reject} REJECT">${cells.join('')}</div><span class="vote-copy">${pass}/${watch}/${reject} · 共${total}视角</span>`
}

function stockVotes(votes: Json): string {
  const entries: [string, number, string][] = [
    ['WATCH', Number(votes.watch ?? 0), 'watch'],
    ['REJECT', Number(votes.reject ?? 0), 'reject'],
  ]
  return `<div class="stock-votes" aria-label="Round 3最新事实复核">${entries.map(([label, count, tone]) => `<span class="vote-chip vote-${tone}"><b>${count}</b>${label}</span>`).join('')}</div>`
}

function scenarioSection(data: Json, sources: Map<string, Json>): string {
  const scenarios = data.scenarios as Json[]
  return `
    <div class="scenario-grid">
      ${scenarios.map(scenario => `<article class="scenario-card scenario-card-${esc(scenario.id)}">
        <div class="scenario-title"><span>${esc(scenario.name)}</span><strong>${esc(scenario.priority)}</strong></div>
        <p>${esc(scenario.description)}</p>
        <h4>确认开关</h4><ul>${(scenario.confirm as string[]).map(item => `<li>${esc(item)}</li>`).join('')}</ul>
        <div class="hard-fail"><b>推翻：</b>${esc(scenario.falsify)}</div>
      </article>`).join('')}
    </div>
    <div class="hard-fail scenario-rule"><b>互斥状态机：</b>${esc(data.scenario_state_rule)}</div>
    <div class="table-wrap scenario-scorecard"><table class="gate-table"><thead><tr><th>六项开关</th><th>当前值 / 时点</th><th>上行阈值</th><th>压力阈值</th><th>来源</th></tr></thead><tbody>${(data.scenario_scorecard as Json[]).map(item => `<tr><th>${esc(item.name)}</th><td>${esc(item.current)}</td><td>${esc(item.upside)}</td><td>${esc(item.downside)}</td><td>${sourceRefs(item.source_ids, sources)}</td></tr>`).join('')}</tbody></table></div>`
}

function cycleTimeline(data: Json): string {
  return `<div class="timeline">${(data.cycle_phases as Json[]).map((phase, index) => `<article class="phase">
    <div class="phase-index">0${index + 1}</div><div class="phase-body"><time>${esc(phase.period)}</time><h3>${esc(phase.name)}</h3><span class="phase-state">${esc(phase.state)}</span><p>${esc(phase.focus)}</p><div class="signal-list">${(phase.signals as string[]).map(s => `<span>${esc(s)}</span>`).join('')}</div></div>
  </article>`).join('')}</div>`
}

function macroGrid(data: Json, sources: Map<string, Json>): string {
  return `<div class="macro-grid">${(data.macro_evidence as Json[]).map(item => `<article class="macro-card tone-${esc(item.tone)}"><span class="macro-label">${esc(item.label)}</span><strong>${esc(item.value)}</strong><p>${esc(item.detail)}</p><div class="card-sources">${sourceRefs(item.source_ids, sources)}</div></article>`).join('')}</div>`
}

function themeCards(data: Json, sources: Map<string, Json>): string {
  return `<div class="theme-toolbar no-print" aria-label="主题筛选"><button type="button" class="filter-button is-active" data-theme-filter="all">全部</button><button type="button" class="filter-button" data-theme-filter="B">B / 待验证</button><button type="button" class="filter-button" data-theme-filter="C">C / 影子</button></div>
  <div class="theme-grid" id="theme-grid">${(data.themes as Json[]).map(theme => `<article class="theme-card" data-grade="${esc(String(theme.grade).slice(0, 1))}">
    <div class="theme-top"><span class="grade grade-${esc(String(theme.grade).slice(0, 1).toLowerCase())}">${esc(theme.grade)}</span><div><h3>${esc(theme.name)}</h3>${voteBar(theme.latest_committee)}<small class="vote-copy">票源：${esc(theme.committee_basis)}</small></div></div>
    <p class="theme-thesis">${esc(theme.thesis)}</p>
    <ul class="evidence-list">${(theme.evidence as string[]).map(item => `<li>${esc(item)}</li>`).join('')}</ul>
    <div class="candidate"><span>观察标的</span><strong>${esc(theme.candidate)}</strong></div>
    <div class="hard-fail"><b>硬失效：</b>${esc(theme.hard_fail)}</div>
    <div class="card-sources">${sourceRefs(theme.source_ids, sources)}</div>
  </article>`).join('')}</div>`
}

function stockCards(data: Json, sources: Map<string, Json>): string {
  return `<div class="stock-toolbar no-print"><label for="stock-layer">显示：</label><select id="stock-layer"><option value="all">全部六股</option><option value="watch">待补证研究池</option><option value="reject">当前否决</option></select></div>
  <div class="stock-list" id="stock-list">${(data.stocks as Json[]).map(stock => {
    const filter = String(stock.decision)
    return `<article class="stock-card" data-layer="${filter}">
      <div class="stock-header"><div><span class="ticker">${esc(stock.symbol)}</span><h3>${esc(stock.name)}</h3><p>${esc(stock.layer)} · 财务截止 ${esc(stock.financial_cutoff)}</p></div>${stockVotes(stock.latest_committee)}</div>
      <div class="metric-row">${(stock.metrics as Json[]).map(metric => `<div><span>${esc(metric.label)}</span><strong>${esc(metric.value)}</strong><small>${esc(metric.change)}</small></div>`).join('')}</div>
      <p class="stock-reason">${esc(stock.reason)}</p>
      <div class="stock-columns"><div><h4>未来一年待验证变量</h4><ul>${(stock.catalysts as string[]).map(item => `<li>${esc(item)}</li>`).join('')}</ul></div><div><h4>估值 / 入场门</h4><p>${esc(stock.valuation_gate)}</p></div></div>
      <div class="gate-bands"><p><b>PASS：</b>${esc(stock.gate_bands.pass)}</p><p><b>WATCH：</b>${esc(stock.gate_bands.watch)}</p><p><b>FAIL：</b>${esc(stock.gate_bands.fail)}</p></div>
      <div class="card-sources">${sourceRefs(stock.source_ids, sources)}</div>
    </article>`
  }).join('')}</div>`
}

function gateMatrix(data: Json): string {
  const criteria = data.view_gates.criteria as Json[]
  const results = data.view_gates.results as Json[]
  return `<div class="gate-defs">${criteria.map((gate, index) => `<article><span>G${index + 1}</span><div><h3>${esc(gate.name)}</h3><p>${esc(gate.rule)}</p></div></article>`).join('')}</div>
  <div class="table-wrap"><table class="gate-table"><thead><tr><th>观察对象</th>${criteria.map(g => `<th>${esc(g.name)}</th>`).join('')}<th>动作</th></tr></thead><tbody>${results.map(row => `<tr><th>${esc(row.name)}</th>${criteria.map(g => `<td>${status(row[g.id])}</td>`).join('')}<td>${esc(row.action)}</td></tr>`).join('')}</tbody></table></div>
  <p class="table-note">强制动作规则：任一门 FAIL → REJECT；任一门 WATCH / OPEN → WATCH；只有六门全部 PASS 才允许进入可执行 CORE / SATELLITE。本期因此为 0 个可执行推荐。</p>`
}

function expertCouncil(data: Json): string {
  return `<div class="expert-grid">${(data.experts as Json[]).map((expert, index) => `<details class="expert" ${index === 0 ? 'open' : ''}>
    <summary><span class="expert-index">0${index + 1}</span><div><strong>${esc(expert.name)}</strong><small>${esc(expert.role)}</small></div><span class="disclosure">方法论 AI 模拟 · 展开</span></summary>
    <div class="expert-content">
      <section><h3>Round 1 · 独立盲审</h3><p><b>周期：</b>${esc(expert.round1.cycle)}</p><p><b>历史原始未校准权重（最终废弃，不是概率）：</b>${esc(expert.round1.scenarios)}</p><p><b>偏好：</b>${(expert.round1.preferred as string[]).map(item => `<span class="inline-tag">${esc(item)}</span>`).join('')}</p><p><b>首轮股票（历史观点，已被Round 3覆盖）：</b>${(expert.round1.stocks as string[]).map(item => `<span class="inline-tag muted-tag">${esc(item)}</span>`).join('')}</p><h4>反对的共识</h4><ul>${(expert.round1.objections as string[]).map(item => `<li>${esc(item)}</li>`).join('')}</ul><h4>向同行发问</h4><ol>${(expert.round1.questions as string[]).map(item => `<li>${esc(item)}</li>`).join('')}</ol></section>
      <section class="round-two"><h3>Round 2 · 匿名交叉质询</h3><h4>反驳</h4><ul>${(expert.round2.rebuttals as string[]).map(item => `<li>${esc(item)}</li>`).join('')}</ul><div class="revision"><b>接受并修订：</b>${esc(expert.round2.accepted_revision)}</div><h4>主题评级（历史快照）</h4><div class="ratings">${Object.entries(expert.round2.theme_ratings as Record<string, string>).map(([key, value]) => `<span><small>${esc(({ dividend: '红利', grid_ai: 'AI/电网', manufacturing: '制造/机器人', pharma: '创新药', consumption: '消费' } as Record<string, string>)[key] ?? key)}</small><b class="rating-${esc(value.toLowerCase())}">${esc(value)}</b></span>`).join('')}</div><h4>六股评级（历史观点，已被Round 3覆盖）</h4><div class="ratings stock-ratings">${Object.entries(expert.round2.stock_ratings as Record<string, string>).map(([key, value]) => `<span><small>${esc(key)}</small><b class="rating-${esc(value.toLowerCase())}">${esc(value)}</b></span>`).join('')}</div><p><b>历史未校准修订权重（最终废弃，不是概率）：</b>${esc(expert.round2.scenarios)}</p><h4>自我约束门禁</h4><ol>${(expert.round2.gates as string[]).map(item => `<li>${esc(item)}</li>`).join('')}</ol></section>
    </div>
  </details>`).join('')}</div>`
}

function latestCouncil(data: Json): string {
  const council = data.latest_council as Json
  return `<div class="latest-council"><div><span class="section-kicker">${esc(council.round)}</span><h3>最新事实复核已留痕</h3><p>${esc(council.execution)}</p><p><b>情景共识：</b>${esc(council.scenario_consensus)}</p></div><a class="artifact-link" href="${esc(council.artifact)}" target="_blank" rel="noreferrer">查看5份原始输出与哈希 ↗</a></div>
  <div class="council-result-grid"><div class="table-wrap"><table class="gate-table"><thead><tr><th>主题</th><th>WATCH</th><th>REJECT</th></tr></thead><tbody>${(council.theme_results as Json[]).map(row => `<tr><th>${esc(row.name)}</th><td>${esc(row.watch)}</td><td>${esc(row.reject)}</td></tr>`).join('')}</tbody></table></div><div class="table-wrap"><table class="gate-table"><thead><tr><th>股票</th><th>W/R</th><th>最终动作</th></tr></thead><tbody>${(council.stock_results as Json[]).map(row => `<tr><th>${esc(row.name)}</th><td>${esc(row.watch)} / ${esc(row.reject)}</td><td>${esc(row.action)}</td></tr>`).join('')}</tbody></table></div></div>
  <div class="hard-fail"><b>保留分歧：</b><ul>${(council.disagreements as string[]).map(item => `<li>${esc(item)}</li>`).join('')}</ul></div>`
}

function monitors(data: Json): string {
  return `<div class="monitor-grid">${(data.monitor_switches as string[]).map((item, index) => `<article><span>${String(index + 1).padStart(2, '0')}</span><p>${esc(item)}</p></article>`).join('')}</div>`
}

function sourcesSection(data: Json): string {
  return `<div class="source-list">${(data.sources as Json[]).map((source, index) => `<a href="${esc(source.url)}" target="_blank" rel="noreferrer"><span>${String(index + 1).padStart(2, '0')}</span><div><strong>${esc(source.title)}</strong><small>${esc(source.publisher)} · ${esc(source.date)}</small></div><b>↗</b></a>`).join('')}</div>`
}

function validateData(data: Json): void {
  if (!Array.isArray(data.experts) || data.experts.length !== 5) throw new Error('Expected exactly five expert-method roles')
  if (!Array.isArray(data.scenarios) || data.scenarios.length !== 3) throw new Error('Expected exactly three scenarios')
  if ((data.scenarios as Json[]).some(item => 'weight' in item || !item.priority)) throw new Error('Final scenarios must use ranks, not uncalibrated numeric weights')
  if (!Array.isArray(data.scenario_scorecard) || data.scenario_scorecard.length !== 6) throw new Error('Scenario state machine requires six indicators')
  for (const theme of data.themes as Json[]) {
    const voteTotal = Number(theme.committee.pass) + Number(theme.committee.watch) + Number(theme.committee.reject)
    const latestVoteTotal = Number(theme.latest_committee.pass) + Number(theme.latest_committee.watch) + Number(theme.latest_committee.reject)
    if (voteTotal !== 5 || latestVoteTotal !== 5 || !theme.committee_basis) throw new Error(`Invalid committee mapping for theme ${theme.id}`)
  }
  for (const stock of data.stocks as Json[]) {
    const voteTotal = Number(stock.committee.core) + Number(stock.committee.satellite) + Number(stock.committee.watch) + Number(stock.committee.reject)
    const latestVoteTotal = Number(stock.latest_committee.watch) + Number(stock.latest_committee.reject)
    if (voteTotal !== 5 || latestVoteTotal !== 5) throw new Error(`Invalid committee vote total for ${stock.symbol}`)
    if (!['watch', 'reject'].includes(stock.decision) || !stock.gate_bands?.pass || !stock.gate_bands?.watch || !stock.gate_bands?.fail) {
      throw new Error(`Incomplete strict gate bands for ${stock.symbol}`)
    }
  }
  const sourceIds = new Set((data.sources as Json[]).map(source => source.id))
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    const object = value as Json
    if (Array.isArray(object.source_ids)) {
      for (const id of object.source_ids) if (!sourceIds.has(id)) throw new Error(`Unknown source id: ${id}`)
    }
    for (const child of Object.values(object)) visit(child)
  }
  visit(data)
}

function render(data: Json, dataHash: string): string {
  const sources = sourceMap(data)
  const meta = data.metadata
  const generatedAt = new Date().toISOString()
  const watchStocks = (data.stocks as Json[]).filter(stock => stock.decision === 'watch')
  const rejectedStocks = (data.stocks as Json[]).filter(stock => stock.decision === 'reject')
  const primaryWatch = watchStocks.find(stock => String(stock.layer).startsWith('WATCH-1')) ?? watchStocks[0]
  const mainScenario = (data.scenarios as Json[]).find(scenario => scenario.id === 'base') ?? data.scenarios[0]
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="截至${esc(meta.as_of)}的A股未来一年周期展望：五个同源 AI 方法论角色、交叉质询、互斥情景状态机、待验证主题与观点门禁。">
  <meta name="theme-color" content="#10211f">
  <title>A股未来一年周期展望 · 五种 AI 方法论会商 | Hanai Worth</title>
  <style>
    :root{--ink:#172725;--deep:#10211f;--paper:#f4f0e7;--paper-2:#ebe4d7;--white:#fffdf7;--jade:#1f6b5c;--jade-2:#78a598;--gold:#b38238;--red:#a94e43;--blue:#38697c;--muted:#62716d;--line:#d4caba;--shadow:0 20px 55px rgba(31,49,45,.12);--radius:22px}
    .macro-grid{grid-template-columns:repeat(3,1fr)}
    .scenario-scorecard{margin-top:18px}.scenario-rule{border-left-color:var(--gold);background:rgba(179,130,56,.08)}.gate-bands{margin-top:16px;padding:14px 16px;background:var(--paper-2);border-radius:12px}.gate-bands p{margin:5px 0;font-size:12px}.gate-bands p:nth-child(1) b{color:var(--jade)}.gate-bands p:nth-child(3) b{color:var(--red)}.latest-council{display:flex;justify-content:space-between;gap:24px;align-items:center;padding:24px;background:var(--deep);color:#fff;border-radius:18px;margin-bottom:16px}.latest-council h3{margin:4px 0;font-family:Georgia,"Songti SC",serif;font-size:26px}.latest-council p{margin:4px 0;color:rgba(255,255,255,.72);font-size:12px}.artifact-link{white-space:nowrap;padding:10px 14px;border:1px solid rgba(255,255,255,.25);border-radius:999px;text-decoration:none}.council-result-grid{display:grid;grid-template-columns:.8fr 1.2fr;gap:14px;margin-bottom:18px}
    @media(max-width:1000px){.layout{grid-template-columns:1fr}.toc{display:none}.hero-grid{grid-template-columns:1fr 1fr}.hero-cell:nth-child(3){border-left:0}.macro-grid{grid-template-columns:repeat(2,1fr)}.theme-grid,.council-result-grid{grid-template-columns:1fr}.scenario-grid{grid-template-columns:1fr}.process{grid-template-columns:1fr 1fr}}
    @media(max-width:680px){.site-nav-inner{padding:9px 14px;overflow-x:auto}.site-brand{min-width:max-content}.site-link{min-width:max-content}.hero{padding:58px 18px 45px}.hero-grid{grid-template-columns:1fr}.hero-cell+.hero-cell{padding-left:0;border-left:0;border-top:1px solid rgba(255,255,255,.15)}.layout{padding:24px 16px 60px}.section{padding:45px 0}.verdict{grid-template-columns:1fr;padding:20px}.process,.macro-grid,.gate-defs,.monitor-grid,.source-list{grid-template-columns:1fr}.latest-council{display:block}.artifact-link{display:inline-block;margin-top:12px}.scenario-strip{height:72px}.scenario-segment{padding:10px}.scenario-segment strong{font-size:21px}.scenario-segment span{font-size:9px}.phase{grid-template-columns:58px 1fr}.timeline:before{left:23px}.phase-index{width:40px;height:40px}.stock-header{display:block}.stock-votes{justify-content:flex-start;margin-top:12px}.metric-row{grid-template-columns:1fr 1fr}.metric-row div:nth-child(3){border-left:0;border-top:1px solid var(--line)}.metric-row div:nth-child(4){border-top:1px solid var(--line)}.stock-columns,.expert-content{grid-template-columns:1fr}.expert-content section+section{border-left:0;border-top:1px solid var(--line)}.ratings{grid-template-columns:repeat(3,1fr)}.footer-inner{display:block}}
    @media print{body{background:#fff}.site-nav,.toc,.no-print{display:none!important}.hero{padding:35px 0;background:#fff;color:#111}.hero:before{display:none}.hero-lead,.hero-disclaimer,.hero-cell span{color:#444}.hero-grid{border-color:#ccc}.hero-cell+.hero-cell{border-color:#ccc}.layout{display:block;padding:0}.section{break-inside:avoid}.stock-card,.theme-card,.scenario-card,.expert{box-shadow:none;border:1px solid #ddd;break-inside:avoid}.footer{background:#fff;color:#111;padding:10px 0}.footer p{color:#333}.expert[open] .expert-content{display:grid}a{color:#111;text-decoration:none}.source-ref:after{content:""}}
  </style>
</head>
<body>
  <nav class="site-nav" aria-label="研究站点导航"><div class="site-nav-inner"><a class="site-brand" href="./">Hanai Worth · 值见</a><a class="site-link" href="./turning-point-capability-audit-2026-08-23.html">变盘点审计</a><a class="site-link" href="./a-share-cycle-outlook-2026-08-23.html" aria-current="page">A股周期展望</a><a class="site-link" href="https://github.com/hancao97/hanai-investment-dsh" target="_blank" rel="noreferrer">GitHub ↗</a></div></nav>
  <header class="hero"><div class="hero-inner"><div class="eyebrow">Hanai research memo · ${esc(meta.as_of)}</div><h1>A股未来一年：<br>让假设先接受数据审判</h1><p class="hero-lead">五个系统专家 Skill 以隔离上下文生成首轮观点，再围绕同一份可核验事实交叉质询。最终只保留能够写出数据阈值、复核日期和退出动作的研究假设。</p><div class="hero-grid"><div class="hero-cell"><span>观察窗口</span><strong>${esc(meta.forecast_start)} → ${esc(meta.forecast_end)}</strong></div><div class="hero-cell"><span>主情景排序</span><strong>${esc(mainScenario.name)}</strong></div><div class="hero-cell"><span>门禁结果</span><strong>${watchStocks.length} WATCH / ${rejectedStocks.length} REJECT</strong></div><div class="hero-cell"><span>事实截止</span><strong>${esc(meta.market_data_cutoff)}</strong></div></div><div class="hero-disclaimer">${esc(meta.expert_disclosure)} ${esc(meta.investment_boundary)} ${esc(meta.probability_semantics)} 事实层未纳入2026-08-21收盘行情，A股宽度基线仍待接入。</div></div></header>
  <div class="layout">
    <aside class="toc"><p class="toc-title">Contents</p><a href="#verdict">00 · 结论</a><a href="#method">01 · 五角色方法</a><a href="#evidence">02 · 宏观证据</a><a href="#scenarios">03 · 周期与情景</a><a href="#themes">04 · 待验证主题</a><a href="#stocks">05 · 个股观察池</a><a href="#gates">06 · 观点门禁</a><a href="#council">07 · 会商摘要</a><a href="#monitor">08 · 月度开关</a><a href="#sources">09 · 来源与限制</a></aside>
    <main class="content">
      <section class="section" id="verdict"><span class="section-kicker">00 · Decision memo</span><h2>主情景是结构分化，但证据只够列观察池</h2><p class="section-intro">截至已披露数据，工业和高技术制造强于商品消费与地产，利润改善又高度集中。这里追求的是研究可复核性，而不是用多个题材制造虚假的确定性。</p><div class="verdict"><div><h3>${esc(data.verdict.headline)}</h3><p>${esc(data.verdict.summary)}</p></div><div class="verdict-side"><span>方法论一致度最高的待补证对象</span><strong>${esc(primaryWatch ? `${primaryWatch.symbol} ${primaryWatch.name}` : '无')}</strong><small>这是 WATCH，不是 CORE；最新事实、自由现金流和实时估值任一未过门，都不能转成买入结论。</small></div></div></section>
      <section class="section" id="method"><span class="section-kicker">01 · Council protocol</span><h2>五个同源 AI 方法论角色，两轮会商加一次最新事实复核</h2><p class="section-intro">系统实际调用仓库中的五个专家 Skill。首轮做提示与上下文隔离；第二轮要求点名反驳、接受一条批评、重做评级并提交能淘汰自身偏好的门禁；Round 3 再以2026年最新财报重跑五个 Skill。相关真人均未参与、审核或背书。</p><div class="process"><article><span>01</span><strong>隔离首轮</strong><p>周期、情景、题材、股票、反方问题。</p></article><article><span>02</span><strong>事实清洗</strong><p>二手行情被剥离，关键结论回到官方或发行人披露。</p></article><article><span>03</span><strong>匿名质询</strong><p>反驳机制、接受修订、主题与六股重新投票。</p></article><article><span>04</span><strong>最新事实复核</strong><p>五个 Skill 基于2026年最新财报重新评级。</p></article></div><div class="hard-fail"><b>统计边界：</b>${esc(meta.expert_method)} 因此“五票”只记录同源模型在不同提示下的输出分布，不是五个独立预测样本。</div></section>
      <section class="section" id="evidence"><span class="section-kicker">02 · Evidence pulse</span><h2>供给较强、住房与商品需求偏弱；信用结构仍待补证</h2><p class="section-intro">当前事实支持的是一个状态描述，而不是未来一年必然路径：生产和部分新动能较强，商品消费和房地产偏弱，财政土地收入承压；私人信用分项尚未进入证据层。</p>${macroGrid(data, sources)}</section>
      <section class="section" id="scenarios"><span class="section-kicker">03 · Scenario map</span><h2>不展示伪精确概率，只保留互斥状态机</h2><p class="section-intro">本期把三个情景排序为主情景、备选情景和压力情景，不给未经历史校准的概率。未来按六项开关的预设阈值机械分类，并冻结每次更新。</p>${scenarioSection(data, sources)}<h3 style="margin-top:44px">四个预定复核窗口</h3>${cycleTimeline(data)}</section>
      <section class="section" id="themes"><span class="section-kicker">04 · Theme radar</span><h2>待验证的是产业链现金流，不是题材名字</h2><p class="section-intro">B到C是证据等级，不是仓位建议。B-表示已有产业与公司证据但Round 3仍全为WATCH；C+表示证据矛盾或传导更弱；C / 影子表示多数角色否决或只配积累数据。委员会旧轮次只对五个合并主题桶投票，拆分后的六主题会明确票源；Round 3则逐主题重审。</p>${themeCards(data, sources)}</section>
      <section class="section" id="stocks"><span class="section-kicker">05 · Quality watchlist</span><h2>${watchStocks.length} 个 WATCH，${rejectedStocks.length} 个 REJECT，0 个可执行推荐</h2><p class="section-intro">“相对稳健”只表示商业与财务证据较易解释，不代表股价低波动。任一门为 WATCH / OPEN 就只能留在待补证研究池；任一门 FAIL 则退出候选层。</p>${stockCards(data, sources)}</section>
      <section class="section" id="gates"><span class="section-kicker">06 · Falsifiable gates</span><h2>观点必须允许自己被淘汰</h2><p class="section-intro">门禁把“好公司”“好行业”“好价格”拆开。任何一个标签都不能替代现金流与估值；通过五票也不能越过未完成的估值门。</p>${gateMatrix(data)}</section>
      <section class="section" id="council"><span class="section-kicker">07 · Structured council digest</span><h2>结构化保留分歧、反驳与修订</h2><p class="section-intro">${esc(meta.committee_vote_snapshot)} 下方Round 1/2是结构化摘要，不是逐字转录；Round 3则公开原始输出、冻结事实包、提示词哈希与Skill哈希。所有姓名均指 AI 方法论角色，相关真人未参与或背书。</p>${latestCouncil(data)}${expertCouncil(data)}</section>
      <section class="section" id="monitor"><span class="section-kicker">08 · Monthly switches</span><h2>未来一年只盯这十个开关</h2><p class="section-intro">静态预测会过期；这些开关决定情景状态是否切换，也决定主题和个股是升级、降级还是退出。成交与市场宽度尚无冻结基线，只列为待接入指标。</p>${monitors(data)}</section>
      <section class="section" id="sources"><span class="section-kicker">09 · Sources & limits</span><h2>${(data.sources as Json[]).length}项官方 / 发行人来源、生成血缘与已知限制</h2><p class="section-intro">关键事实回到统计部门、财政货币部门、监管机构、交易所或发行人披露；个别政府网站转载会在来源名中明示。专家二手行情只用于发现问题，不直接进入事实层。</p>${sourcesSection(data)}<p class="table-note"><a href="./research-data/a-share-cycle-outlook-2026-08-23.json" target="_blank" rel="noreferrer">下载结构化报告JSON</a> · <a href="./research-data/a-share-cycle-expert-runs-2026-08-23.json" target="_blank" rel="noreferrer">下载Round 3五角色原始输出与哈希</a></p><h3 style="margin-top:34px">已知限制</h3><ol class="limitations">${(data.limitations as string[]).map(item => `<li>${esc(item)}</li>`).join('')}</ol><div class="provenance">data: docs/research-data/a-share-cycle-outlook-2026-08-23.json · sha256 ${esc(dataHash)} · generated ${esc(generatedAt)} · curated via ${esc(meta.artifact_provenance)} · expert run input ${esc(meta.expert_run_input_sha256)} · snapshot ${esc(meta.expert_snapshot_version)} · runtime ${esc(meta.expert_runtime)}</div></section>
    </main>
  </div>
  <footer class="footer"><div class="footer-inner"><p>本报告是可证伪的研究备忘录，不构成投资建议。市场有风险；WATCH / REJECT 只表示研究门禁状态，投资者应独立核验最新财报、价格、估值与自身风险承受能力。</p><div><a href="./turning-point-capability-audit-2026-08-23.html">变盘点能力审计</a> · <a href="https://github.com/hancao97/hanai-investment-dsh" target="_blank" rel="noreferrer">GitHub</a></div></div></footer>
  <script>
    (() => {
      const themeButtons = [...document.querySelectorAll('[data-theme-filter]')]
      const themeCards = [...document.querySelectorAll('#theme-grid .theme-card')]
      themeButtons.forEach(button => button.addEventListener('click', () => {
        const selected = button.dataset.themeFilter
        themeButtons.forEach(item => item.classList.toggle('is-active', item === button))
        themeCards.forEach(card => card.classList.toggle('is-hidden', selected !== 'all' && card.dataset.grade !== selected))
      }))
      const stockLayer = document.getElementById('stock-layer')
      const stockCards = [...document.querySelectorAll('#stock-list .stock-card')]
      stockLayer?.addEventListener('change', () => {
        stockCards.forEach(card => card.classList.toggle('is-hidden', stockLayer.value !== 'all' && card.dataset.layer !== stockLayer.value))
      })
    })()
  </script>
</body>
</html>`
}

const parsed = args()
const raw = readFileSync(parsed.input, 'utf8')
const data = JSON.parse(raw) as Json
validateData(data)
const hash = createHash('sha256').update(raw).digest('hex')
const html = render(data, hash)
mkdirSync(dirname(parsed.output), { recursive: true })
writeFileSync(parsed.output, html)
console.log(`Rendered ${parsed.output} (${Buffer.byteLength(html)} bytes, data sha256 ${hash})`)
