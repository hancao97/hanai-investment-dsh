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

const OUTLOOK_STYLES = `
:root{--ink:#142033;--muted:#657083;--paper:#f5f2ea;--card:#fffdf8;--line:#d9d4c7;--navy:#15263e;--blue:#1f6090;--cyan:#50a9b8;--red:#b94141;--green:#28745b;--amber:#a26716;--shadow:0 14px 35px rgba(20,32,51,.09);--radius:18px;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;--serif:"Noto Serif SC","Songti SC",STSong,serif}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);line-height:1.65}a{color:inherit}button,input,select{font:inherit}.page{max-width:1520px;margin:auto;padding:0 34px 96px}
.site-nav{position:sticky;top:0;z-index:30;background:rgba(21,38,62,.96);border-bottom:1px solid rgba(255,255,255,.1);backdrop-filter:blur(12px)}.site-nav-inner{max-width:1450px;margin:auto;padding:10px 34px;display:flex;align-items:center;gap:13px;color:#fff}.site-brand{margin-right:auto;font:700 14px var(--serif);text-decoration:none;white-space:nowrap}.site-link{padding:5px 9px;border-radius:999px;color:#b9c5d2;text-decoration:none;font-size:12px;white-space:nowrap}.site-link:hover,.site-link[aria-current="page"]{color:#fff;background:rgba(255,255,255,.1)}
.hero{position:relative;overflow:hidden;margin:0 -34px 34px;padding:76px max(34px,calc((100vw - 1450px)/2)) 58px;background:var(--navy);color:#fff}.hero:after{content:"";position:absolute;right:-120px;top:-160px;width:520px;height:520px;border:1px solid rgba(255,255,255,.12);border-radius:50%;box-shadow:0 0 0 80px rgba(255,255,255,.025),0 0 0 160px rgba(255,255,255,.018)}.hero-inner{position:relative;z-index:1;max-width:1180px}.eyebrow{display:flex;gap:12px;align-items:center;text-transform:uppercase;letter-spacing:.16em;font-size:12px;color:#91cbd3}.eyebrow:before{content:"";width:42px;height:2px;background:#91cbd3}.hero h1{max-width:1030px;margin:17px 0 14px;font:700 clamp(38px,5.4vw,76px)/1.08 var(--serif);letter-spacing:-.04em}.hero h1 em{font-style:normal;color:#8ed1d6}.hero-lead{max-width:950px;margin:0;color:#d3dce8;font-size:18px}.hero-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin-top:28px;padding:15px 0;border-top:1px solid rgba(255,255,255,.13);border-bottom:1px solid rgba(255,255,255,.13)}.hero-cell{min-width:0;padding:0 20px}.hero-cell:first-child{padding-left:0}.hero-cell+.hero-cell{border-left:1px solid rgba(255,255,255,.13)}.hero-cell span{display:block;color:#9dafc2;font-size:11px;letter-spacing:.08em;text-transform:uppercase}.hero-cell strong{display:block;margin-top:4px;color:#fff;font-size:14px}.hero-disclaimer{margin:24px 0 0;padding:14px 18px;border:1px solid #d99d43;background:#fff5db;color:#6b4311;border-radius:12px;font-size:13px;font-weight:700}
.layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:30px}.toc{position:sticky;top:70px;align-self:start;padding:18px;border:1px solid var(--line);border-radius:16px;background:rgba(255,253,248,.9);backdrop-filter:blur(14px)}.toc-title{display:block;margin:0 0 9px;font-size:12px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--muted)}.toc a{display:block;padding:7px 9px;text-decoration:none;border-radius:8px;font-size:13px;color:#4b586a}.toc a:hover,.toc a.active{background:#e7edf0;color:var(--navy)}.toc .actions{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:15px}.btn{border:1px solid var(--line);border-radius:8px;padding:7px;background:#fff;color:var(--ink);cursor:pointer;font-size:12px}.btn:hover{border-color:var(--blue)}.content{min-width:0}
.section{scroll-margin-top:72px;margin-bottom:34px;padding:32px;background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}.section-head{display:grid;grid-template-columns:80px 1fr;gap:18px;margin-bottom:24px}.section-number{padding-top:10px;color:var(--blue);font:700 13px/1 var(--mono);letter-spacing:.1em}.section-kicker{display:block;margin-bottom:5px;color:var(--blue);font:700 11px var(--mono);letter-spacing:.12em;text-transform:uppercase}.section h2{margin:0;font:700 clamp(25px,3vw,38px)/1.2 var(--serif);letter-spacing:-.025em}.section-intro{max-width:970px;margin:8px 0 0;color:var(--muted)}.section h3{font-family:var(--serif)}
.verdict{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:18px;padding:22px;border-left:4px solid var(--red);border-radius:0 14px 14px 0;background:#fbefeb}.verdict h3{margin:0;font-size:22px;line-height:1.45}.verdict p{margin:10px 0 0;color:#596577}.verdict-side{padding:18px;border-radius:12px;background:var(--navy);color:#fff}.verdict-side span,.verdict-side small{display:block;color:#adbac9;font-size:11px}.verdict-side strong{display:block;margin:10px 0;font:700 22px var(--serif);color:#8ed1d6}
.process{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:20px 0}.process article{padding:18px;border:1px solid var(--line);border-radius:14px;background:#fff}.process span{display:block;color:var(--blue);font:700 12px var(--mono)}.process strong{display:block;margin:7px 0;font-family:var(--serif);font-size:17px}.process p{margin:0;color:var(--muted);font-size:12px}.hard-fail{margin-top:14px;padding:14px 16px;border-left:4px solid var(--red);border-radius:0 11px 11px 0;background:#fbefeb;color:#5e3b3b;font-size:13px}.hard-fail ul{margin:7px 0 0;padding-left:20px}.scenario-rule{border-left-color:var(--amber);background:#fff6df;color:#6b4b1e}
.macro-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.macro-card{position:relative;min-height:190px;padding:19px;border:1px solid var(--line);border-radius:14px;background:#fff;overflow:hidden}.macro-card:before{content:"";position:absolute;inset:0 auto 0 0;width:4px;background:#8090a0}.macro-card.tone-positive:before{background:var(--green)}.macro-card.tone-negative:before{background:var(--red)}.macro-card.tone-watch:before{background:var(--amber)}.macro-label{display:block;color:var(--muted);font-size:11px;letter-spacing:.08em;text-transform:uppercase}.macro-card>strong{display:block;margin:10px 0 5px;font:700 29px var(--serif)}.macro-card p{margin:0;color:#586576;font-size:12px}.card-sources{display:flex;flex-wrap:wrap;gap:6px;margin-top:13px}.source-ref{display:inline-block;padding:3px 7px;border-radius:999px;background:#edf2f3;color:#35566a;text-decoration:none;font-size:10px}.source-ref:hover{background:#dfeaec}
.scenario-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.scenario-card{padding:20px;border:1px solid var(--line);border-top:4px solid var(--blue);border-radius:14px;background:#fff}.scenario-card-upside{border-top-color:var(--green)}.scenario-card-downside{border-top-color:var(--red)}.scenario-title{display:flex;justify-content:space-between;gap:12px;align-items:start}.scenario-title span{font:700 19px var(--serif)}.scenario-title strong{padding:3px 8px;border-radius:999px;background:#e8eef2;color:var(--blue);font-size:10px}.scenario-card p,.scenario-card li{color:#586576;font-size:12px}.scenario-card h4{margin:16px 0 5px}.scenario-card ul{margin:0;padding-left:18px}.scenario-scorecard{margin-top:18px}
.timeline{display:grid;grid-template-columns:1fr 1fr;gap:12px}.phase{display:grid;grid-template-columns:58px 1fr;gap:14px;padding:18px;border:1px solid var(--line);border-radius:14px;background:#fff}.phase-index{display:grid;place-items:center;width:48px;height:48px;border-radius:50%;background:var(--navy);color:#fff;font:700 13px var(--mono)}.phase-body time{color:var(--blue);font:700 11px var(--mono)}.phase-body h3{margin:3px 0;font-size:17px}.phase-state{color:var(--amber);font-size:11px}.phase-body p{margin:8px 0;color:var(--muted);font-size:12px}.signal-list{display:flex;flex-wrap:wrap;gap:5px}.signal-list span,.inline-tag{display:inline-block;padding:3px 7px;border-radius:999px;background:#edf1f2;color:#516274;font-size:10px}
.theme-toolbar,.stock-toolbar{display:flex;gap:8px;align-items:center;margin:0 0 16px}.filter-button,.stock-toolbar select{border:1px solid var(--line);border-radius:999px;padding:7px 12px;background:#fff;color:#536174;cursor:pointer;font-size:12px}.filter-button.is-active,.filter-button:hover{border-color:var(--blue);background:var(--navy);color:#fff}.stock-toolbar label{color:var(--muted);font-size:12px}.theme-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.theme-card{padding:20px;border:1px solid var(--line);border-radius:15px;background:#fff}.theme-top{display:grid;grid-template-columns:54px 1fr;gap:14px;align-items:start}.grade{display:grid;place-items:center;width:50px;height:50px;border-radius:50%;background:var(--navy);color:#fff;font:700 15px var(--mono)}.grade-c{background:#7c6650}.theme-card h3{margin:0;font-size:19px}.theme-thesis{color:#455468;font-weight:700}.evidence-list{padding-left:19px;color:#596577;font-size:12px}.candidate{display:flex;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:10px;background:#edf3f5}.candidate span{color:var(--muted);font-size:11px}.candidate strong{color:var(--blue);font-size:12px}.votes{display:flex;gap:4px;margin-top:8px}.vote{width:17px;height:6px;border-radius:999px;background:#c8d0d5}.vote.vote-pass{background:var(--green)}.vote.vote-watch{background:var(--amber)}.vote.vote-reject{background:var(--red)}.vote-copy{display:block;margin-top:4px;color:var(--muted);font-size:10px}
.stock-list{display:grid;gap:16px}.stock-card{padding:22px;border:1px solid var(--line);border-radius:15px;background:#fff}.stock-header{display:flex;justify-content:space-between;gap:20px;align-items:start}.ticker{display:block;color:var(--blue);font:700 12px var(--mono);letter-spacing:.1em}.stock-header h3{margin:2px 0 1px;font-size:24px}.stock-header p{margin:0;color:var(--muted);font-size:11px}.stock-votes{display:flex;gap:7px}.vote-chip{min-width:72px;padding:7px 10px;border-radius:10px;background:#fff3d9;color:#704c13;text-align:center;font-size:10px}.vote-chip b{display:block;font-size:18px}.vote-chip.vote-reject{background:#f8e2de;color:#8b3934}.metric-row{display:grid;grid-template-columns:repeat(4,1fr);margin:18px 0;border:1px solid var(--line);border-radius:12px;overflow:hidden}.metric-row div{padding:12px 14px}.metric-row div+div{border-left:1px solid var(--line)}.metric-row span,.metric-row small{display:block;color:var(--muted);font-size:10px}.metric-row strong{display:block;margin:4px 0;font:700 17px var(--serif)}.stock-reason{padding:13px 15px;border-left:4px solid var(--blue);background:#edf3f5;color:#35485a}.stock-columns{display:grid;grid-template-columns:1fr 1fr;gap:18px}.stock-columns h4{margin:8px 0}.stock-columns p,.stock-columns li{color:#586576;font-size:12px}.gate-bands{margin-top:16px;padding:14px 16px;background:#f2efe7;border-radius:12px}.gate-bands p{margin:5px 0;font-size:12px}.gate-bands p:nth-child(1) b{color:var(--green)}.gate-bands p:nth-child(3) b{color:var(--red)}
.gate-defs{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px}.gate-defs article{display:grid;grid-template-columns:42px 1fr;gap:10px;padding:14px;border:1px solid var(--line);border-radius:12px;background:#fff}.gate-defs article>span{display:grid;place-items:center;width:38px;height:38px;border-radius:9px;background:var(--navy);color:#fff;font:700 11px var(--mono)}.gate-defs h3{margin:0;font-size:14px}.gate-defs p{margin:4px 0 0;color:var(--muted);font-size:11px}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:13px;background:#fff}.gate-table{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap}.gate-table th{padding:11px 10px;background:#edf0ef;color:#4b5664;text-align:left;font-size:11px;line-height:1.25;border-bottom:1px solid var(--line)}.gate-table thead th{position:sticky;top:0;z-index:1}.gate-table td{padding:10px;border-bottom:1px solid #ece8df;vertical-align:top}.gate-table tbody tr:hover{background:#f8faf9}.gate-table tbody tr:last-child td,.gate-table tbody tr:last-child th{border-bottom:0}.status{display:inline-block;padding:3px 7px;border-radius:999px;font-size:10px;font-weight:700}.status-pass{background:#e2f2e9;color:#216346}.status-watch,.status-open{background:#fff0d4;color:#80520f}.status-fail{background:#f8e2de;color:#963b35}.table-note{margin:10px 0 0;color:var(--muted);font-size:11px}
.latest-council{display:flex;justify-content:space-between;gap:24px;align-items:center;padding:24px;background:var(--navy);color:#fff;border-radius:18px;margin-bottom:16px}.latest-council .section-kicker{color:#91cbd3}.latest-council h3{margin:4px 0;font-size:26px}.latest-council p{margin:4px 0;color:rgba(255,255,255,.72);font-size:12px}.artifact-link{white-space:nowrap;padding:10px 14px;border:1px solid rgba(255,255,255,.25);border-radius:999px;text-decoration:none}.artifact-link:hover{background:rgba(255,255,255,.1)}.council-result-grid{display:grid;grid-template-columns:.8fr 1.2fr;gap:14px;margin-bottom:18px}.expert-grid{display:grid;gap:10px}.expert{border:1px solid var(--line);border-radius:14px;background:#fff;overflow:hidden}.expert summary{display:grid;grid-template-columns:46px 1fr auto;gap:12px;align-items:center;padding:15px 18px;cursor:pointer}.expert-index{display:grid;place-items:center;width:38px;height:38px;border-radius:50%;background:var(--navy);color:#fff;font:700 11px var(--mono)}.expert summary strong,.expert summary small{display:block}.expert summary small,.disclosure{color:var(--muted);font-size:11px}.expert-content{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--line)}.expert-content section{padding:20px}.expert-content section+section{border-left:1px solid var(--line)}.expert-content h3{margin-top:0}.expert-content p,.expert-content li{font-size:12px;color:#566376}.revision{padding:12px;border-left:4px solid var(--green);background:#edf7f1;font-size:12px}.ratings{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}.ratings span{padding:7px;border-radius:9px;background:#f3f1eb;text-align:center}.ratings small,.ratings b{display:block;font-size:9px}.rating-core,.rating-pass{color:var(--green)}.rating-satellite,.rating-watch{color:var(--amber)}.rating-reject{color:var(--red)}.muted-tag{background:#f3f1eb;color:#747c87}
.monitor-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.monitor-grid article{display:grid;grid-template-columns:44px 1fr;gap:11px;align-items:center;padding:13px;border:1px solid var(--line);border-radius:12px;background:#fff}.monitor-grid span{color:var(--blue);font:700 12px var(--mono)}.monitor-grid p{margin:0;font-size:12px}.source-list{display:grid;grid-template-columns:1fr 1fr;gap:8px}.source-list>a{display:grid;grid-template-columns:34px 1fr 18px;gap:10px;align-items:center;padding:12px;border:1px solid var(--line);border-radius:11px;background:#fff;text-decoration:none}.source-list>a:hover{border-color:#9fb1bc}.source-list>a>span{color:var(--blue);font:700 11px var(--mono)}.source-list strong,.source-list small{display:block}.source-list strong{font-size:12px}.source-list small{color:var(--muted);font-size:10px}.limitations{columns:2;column-gap:36px;padding-left:20px}.limitations li{break-inside:avoid;margin-bottom:10px;color:#586375;font-size:12px}.provenance{margin-top:18px;padding:14px;border-radius:10px;background:#132136;color:#dbe8ee;font:10px/1.65 var(--mono);overflow-wrap:anywhere}.footer{background:var(--navy);color:#fff}.footer-inner{max-width:1450px;margin:auto;padding:24px 34px;display:flex;justify-content:space-between;gap:24px;align-items:center}.footer p{max-width:920px;margin:0;color:#b9c5d2;font-size:11px}.footer a{color:#8ed1d6}.is-hidden{display:none!important}.no-print{display:flex}
@media(max-width:1180px){.macro-grid{grid-template-columns:1fr 1fr}.theme-grid{grid-template-columns:1fr}.gate-defs{grid-template-columns:1fr 1fr}.ratings{grid-template-columns:repeat(3,1fr)}}
@media(max-width:1050px){.layout{grid-template-columns:1fr}.toc{display:none}.hero-grid{grid-template-columns:1fr 1fr}.hero-cell:nth-child(3){border-left:0}.hero-cell:nth-child(n+3){border-top:1px solid rgba(255,255,255,.13);padding-top:12px}.scenario-grid,.council-result-grid{grid-template-columns:1fr}.process{grid-template-columns:1fr 1fr}}
@media(max-width:720px){.site-nav-inner{padding:9px 14px;overflow-x:auto}.site-brand{margin-right:6px}.page{padding:0 14px 60px}.hero{margin:0 -14px 20px;padding:52px 18px 42px}.hero h1{font-size:42px}.hero-lead{font-size:15px}.hero-grid{grid-template-columns:1fr}.hero-cell{padding:11px 0}.hero-cell+.hero-cell,.hero-cell:nth-child(3){border-left:0;border-top:1px solid rgba(255,255,255,.13)}.section{padding:21px 16px;border-radius:14px}.section-head{grid-template-columns:1fr;gap:3px}.section-number{padding:0}.verdict,.stock-columns,.expert-content{grid-template-columns:1fr}.process,.macro-grid,.timeline,.theme-grid,.gate-defs,.monitor-grid,.source-list{grid-template-columns:1fr}.latest-council{display:block}.artifact-link{display:inline-block;margin-top:12px}.stock-header{display:block}.stock-votes{justify-content:flex-start;margin-top:12px}.candidate{display:block}.candidate strong{display:block;margin-top:4px}.metric-row{grid-template-columns:1fr 1fr}.metric-row div:nth-child(3){border-left:0;border-top:1px solid var(--line)}.metric-row div:nth-child(4){border-top:1px solid var(--line)}.expert summary{grid-template-columns:38px 1fr}.disclosure{grid-column:2}.expert-content section+section{border-left:0;border-top:1px solid var(--line)}.ratings{grid-template-columns:repeat(3,1fr)}.limitations{columns:1}.footer-inner{display:block}.gate-table{min-width:760px}}
@media print{@page{size:A4 landscape;margin:11mm}body{background:#fff;font-size:9pt}.site-nav,.toc,.no-print{display:none!important}.page{max-width:none;padding:0}.hero{margin:0 0 8mm;padding:12mm;background:#fff!important;color:#111;border-bottom:2px solid #111}.hero:after{display:none}.hero-lead,.hero-disclaimer,.hero-cell span{color:#444}.hero-disclaimer{border-color:#aaa;background:#fff}.layout{display:block}.section{break-inside:avoid;margin:0 0 7mm;padding:5mm;border:1px solid #aaa;box-shadow:none}.section h2{font-size:20pt}.table-wrap{overflow:visible}.gate-table{white-space:normal;font-size:7pt}.gate-table th{position:static}.gate-table th,.gate-table td{padding:4px}.stock-card,.theme-card,.scenario-card,.expert,.macro-card{box-shadow:none;break-inside:avoid}.expert:not([open]) .expert-content,.expert[open] .expert-content{display:grid!important}.footer{background:#fff;color:#111;padding:10px 0}.footer p{color:#333}a{color:#111;text-decoration:none}}
`

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

function sectionHeader(index: number, kicker: string, title: string, intro: string): string {
  return `<div class="section-head"><div class="section-number">${String(index).padStart(2, '0')} / 10</div><div><span class="section-kicker">${esc(kicker)}</span><h2>${esc(title)}</h2><p class="section-intro">${esc(intro)}</p></div></div>`
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
  <meta name="color-scheme" content="light">
  <meta name="description" content="截至${esc(meta.as_of)}的A股未来一年周期展望：五个同源 AI 方法论角色、交叉质询、互斥情景状态机、待验证主题与观点门禁。">
  <meta name="theme-color" content="#15263e">
  <title>A股未来一年周期展望 · 五种 AI 方法论会商 | Hanai Worth</title>
  <style>
${OUTLOOK_STYLES}
  </style>
</head>
<body>
  <nav class="site-nav" aria-label="研究站点导航"><div class="site-nav-inner"><a class="site-brand" href="./">Hanai Worth · 值见</a><a class="site-link" href="./turning-point-capability-audit-2026-08-23.html">变盘点审计</a><a class="site-link" href="./a-share-cycle-outlook-2026-08-23.html" aria-current="page">A股周期展望</a><a class="site-link" href="https://github.com/hancao97/hanai-investment-dsh" target="_blank" rel="noreferrer">GitHub ↗</a></div></nav>
  <div class="page">
  <header class="hero"><div class="hero-inner"><div class="eyebrow">Hanai research memo · evidence-gated outlook</div><h1>A股未来一年，<br>让假设先接受<em>数据审判</em></h1><p class="hero-lead">五个系统专家 Skill 以隔离上下文生成首轮观点，再围绕同一份可核验事实交叉质询。最终只保留能够写出数据阈值、复核日期和退出动作的研究假设。</p><div class="hero-grid"><div class="hero-cell"><span>观察窗口</span><strong>${esc(meta.forecast_start)} → ${esc(meta.forecast_end)}</strong></div><div class="hero-cell"><span>主情景排序</span><strong>${esc(mainScenario.name)}</strong></div><div class="hero-cell"><span>门禁结果</span><strong>${watchStocks.length} WATCH / ${rejectedStocks.length} REJECT</strong></div><div class="hero-cell"><span>事实截止</span><strong>${esc(meta.market_data_cutoff)}</strong></div></div><div class="hero-disclaimer">⚠ ${esc(meta.expert_disclosure)} ${esc(meta.investment_boundary)} ${esc(meta.probability_semantics)} 事实层未纳入2026-08-21收盘行情，A股宽度基线仍待接入。</div></div></header>
  <div class="layout">
    <aside class="toc"><p class="toc-title">目录</p><a href="#verdict">01 执行结论</a><a href="#method">02 五角色方法</a><a href="#evidence">03 宏观证据</a><a href="#scenarios">04 周期与情景</a><a href="#themes">05 待验证主题</a><a href="#stocks">06 个股观察池</a><a href="#gates">07 观点门禁</a><a href="#council">08 会商摘要</a><a href="#monitor">09 月度开关</a><a href="#sources">10 来源与限制</a><div class="actions"><button class="btn" type="button" onclick="window.print()">打印</button><button class="btn" type="button" id="top-button">顶部</button></div></aside>
    <main class="content">
      <section class="section" id="verdict">${sectionHeader(1, 'Decision memo', '主情景是结构分化，但证据只够列观察池', '截至已披露数据，工业和高技术制造强于商品消费与地产，利润改善又高度集中。这里追求的是研究可复核性，而不是用多个题材制造虚假的确定性。')}<div class="verdict"><div><h3>${esc(data.verdict.headline)}</h3><p>${esc(data.verdict.summary)}</p></div><div class="verdict-side"><span>方法论一致度最高的待补证对象</span><strong>${esc(primaryWatch ? `${primaryWatch.symbol} ${primaryWatch.name}` : '无')}</strong><small>这是 WATCH，不是 CORE；最新事实、自由现金流和实时估值任一未过门，都不能转成买入结论。</small></div></div></section>
      <section class="section" id="method">${sectionHeader(2, 'Council protocol', '五个同源 AI 方法论角色，两轮会商加一次最新事实复核', '系统实际调用仓库中的五个专家 Skill。首轮做提示与上下文隔离；第二轮要求点名反驳、接受一条批评、重做评级并提交能淘汰自身偏好的门禁；Round 3 再以2026年最新财报重跑五个 Skill。相关真人均未参与、审核或背书。')}<div class="process"><article><span>01</span><strong>隔离首轮</strong><p>周期、情景、题材、股票、反方问题。</p></article><article><span>02</span><strong>事实清洗</strong><p>二手行情被剥离，关键结论回到官方或发行人披露。</p></article><article><span>03</span><strong>匿名质询</strong><p>反驳机制、接受修订、主题与六股重新投票。</p></article><article><span>04</span><strong>最新事实复核</strong><p>五个 Skill 基于2026年最新财报重新评级。</p></article></div><div class="hard-fail"><b>统计边界：</b>${esc(meta.expert_method)} 因此“五票”只记录同源模型在不同提示下的输出分布，不是五个独立预测样本。</div></section>
      <section class="section" id="evidence">${sectionHeader(3, 'Evidence pulse', '供给较强、住房与商品需求偏弱；信用结构仍待补证', '当前事实支持的是一个状态描述，而不是未来一年必然路径：生产和部分新动能较强，商品消费和房地产偏弱，财政土地收入承压；私人信用分项尚未进入证据层。')}${macroGrid(data, sources)}</section>
      <section class="section" id="scenarios">${sectionHeader(4, 'Scenario map', '不展示伪精确概率，只保留互斥状态机', '本期把三个情景排序为主情景、备选情景和压力情景，不给未经历史校准的概率。未来按六项开关的预设阈值机械分类，并冻结每次更新。')}${scenarioSection(data, sources)}<h3 style="margin-top:44px">四个预定复核窗口</h3>${cycleTimeline(data)}</section>
      <section class="section" id="themes">${sectionHeader(5, 'Theme radar', '待验证的是产业链现金流，不是题材名字', 'B到C是证据等级，不是仓位建议。B-表示已有产业与公司证据但Round 3仍全为WATCH；C+表示证据矛盾或传导更弱；C / 影子表示多数角色否决或只配积累数据。委员会旧轮次只对五个合并主题桶投票，拆分后的六主题会明确票源；Round 3则逐主题重审。')}${themeCards(data, sources)}</section>
      <section class="section" id="stocks">${sectionHeader(6, 'Quality watchlist', `${watchStocks.length} 个 WATCH，${rejectedStocks.length} 个 REJECT，0 个可执行推荐`, '“相对稳健”只表示商业与财务证据较易解释，不代表股价低波动。任一门为 WATCH / OPEN 就只能留在待补证研究池；任一门 FAIL 则退出候选层。')}${stockCards(data, sources)}</section>
      <section class="section" id="gates">${sectionHeader(7, 'Falsifiable gates', '观点必须允许自己被淘汰', '门禁把“好公司”“好行业”“好价格”拆开。任何一个标签都不能替代现金流与估值；通过五票也不能越过未完成的估值门。')}${gateMatrix(data)}</section>
      <section class="section" id="council">${sectionHeader(8, 'Structured council digest', '结构化保留分歧、反驳与修订', `${String(meta.committee_vote_snapshot)} 下方Round 1/2是结构化摘要，不是逐字转录；Round 3则公开原始输出、冻结事实包、提示词哈希与Skill哈希。所有姓名均指 AI 方法论角色，相关真人未参与或背书。`)}${latestCouncil(data)}${expertCouncil(data)}</section>
      <section class="section" id="monitor">${sectionHeader(9, 'Monthly switches', '未来一年只盯这十个开关', '静态预测会过期；这些开关决定情景状态是否切换，也决定主题和个股是升级、降级还是退出。成交与市场宽度尚无冻结基线，只列为待接入指标。')}${monitors(data)}</section>
      <section class="section" id="sources">${sectionHeader(10, 'Sources & limits', `${(data.sources as Json[]).length}项官方 / 发行人来源、生成血缘与已知限制`, '关键事实回到统计部门、财政货币部门、监管机构、交易所或发行人披露；个别政府网站转载会在来源名中明示。专家二手行情只用于发现问题，不直接进入事实层。')}${sourcesSection(data)}<p class="table-note"><a href="./research-data/a-share-cycle-outlook-2026-08-23.json" target="_blank" rel="noreferrer">下载结构化报告JSON</a> · <a href="./research-data/a-share-cycle-expert-runs-2026-08-23.json" target="_blank" rel="noreferrer">下载Round 3五角色原始输出与哈希</a></p><h3 style="margin-top:34px">已知限制</h3><ol class="limitations">${(data.limitations as string[]).map(item => `<li>${esc(item)}</li>`).join('')}</ol><div class="provenance">data: docs/research-data/a-share-cycle-outlook-2026-08-23.json · sha256 ${esc(dataHash)} · generated ${esc(generatedAt)} · curated via ${esc(meta.artifact_provenance)} · expert run input ${esc(meta.expert_run_input_sha256)} · snapshot ${esc(meta.expert_snapshot_version)} · runtime ${esc(meta.expert_runtime)}</div></section>
    </main>
  </div>
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
      document.getElementById('top-button')?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }))
      const tocLinks = [...document.querySelectorAll('.toc a[href^="#"]')]
      const sections = tocLinks.map(link => document.querySelector(link.getAttribute('href'))).filter(Boolean)
      const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          tocLinks.forEach(link => link.classList.toggle('active', link.getAttribute('href') === '#' + entry.target.id))
        }
      }, { rootMargin: '-18% 0px -72% 0px' })
      sections.forEach(section => observer.observe(section))
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
