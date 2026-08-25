#!/usr/bin/env tsx

/** Render the one-year A-share outlook and five-expert council as a portable HTML report. */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type Json = Record<string, any>

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_INPUT = resolve(ROOT, 'docs/research-data/a-share-cycle-outlook-2026-08-25.json')
const DEFAULT_OUTPUT = resolve(ROOT, 'docs/a-share-cycle-outlook-2026-08-25.html')

const THEME_GRADES = ['A', 'A-', 'B+', 'B', 'B-', 'C'] as const
const STOCK_DECISIONS = ['core', 'satellite', 'watch', 'reject', 'incomplete'] as const
const EXECUTION_TIERS = ['core', 'satellite'] as const
const REQUIRED_GATE_IDS = ['fact', 'mechanism', 'quality', 'valuation', 'falsifier', 'council'] as const
const GATE_STATUSES = ['pass', 'watch', 'open', 'fail'] as const

type StockDecision = (typeof STOCK_DECISIONS)[number]
type GateStatus = (typeof GATE_STATUSES)[number]

const THEME_GRADE_SET = new Set<string>(THEME_GRADES)
const STOCK_DECISION_SET = new Set<string>(STOCK_DECISIONS)
const EXECUTION_TIER_SET = new Set<string>(EXECUTION_TIERS)
const GATE_STATUS_SET = new Set<string>(GATE_STATUSES)

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
.theme-toolbar,.stock-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 16px}.filter-button,.stock-toolbar select{border:1px solid var(--line);border-radius:999px;padding:7px 12px;background:#fff;color:#536174;cursor:pointer;font-size:12px}.filter-button.is-active,.filter-button:hover{border-color:var(--blue);background:var(--navy);color:#fff}.stock-toolbar label{color:var(--muted);font-size:12px}.theme-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.theme-card{padding:20px;border:1px solid var(--line);border-radius:15px;background:#fff}.theme-top{display:grid;grid-template-columns:54px 1fr auto;gap:14px;align-items:start}.grade{display:grid;place-items:center;width:50px;height:50px;border-radius:50%;background:var(--navy);color:#fff;font:700 15px var(--mono)}.grade-a{background:var(--green)}.grade-b{background:var(--navy)}.grade-c{background:#7c6650}.theme-card h3{margin:0;font-size:19px}.theme-score-total{min-width:74px;padding:7px 10px;border:1px solid #c9dcda;border-radius:10px;background:#edf7f3;color:var(--green);text-align:center}.theme-score-total strong,.theme-score-total small{display:block}.theme-score-total strong{font:700 18px var(--mono)}.theme-score-total small{font-size:9px;letter-spacing:.05em}.theme-score-summary{margin:12px 0;padding:11px 13px;border-left:3px solid var(--cyan);background:#eef6f6;color:#3d5963;font-size:12px}.theme-components{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;margin:12px 0}.theme-component{padding:8px 6px;border:1px solid #e1ddd3;border-radius:9px;background:#faf8f2;text-align:center}.theme-component small,.theme-component b{display:block}.theme-component small{min-height:28px;color:var(--muted);font-size:9px}.theme-component b{color:var(--navy);font:700 12px var(--mono)}.theme-thesis{color:#455468;font-weight:700}.evidence-list{padding-left:19px;color:#596577;font-size:12px}.candidate{display:flex;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:10px;background:#edf3f5}.candidate span{color:var(--muted);font-size:11px}.candidate strong{color:var(--blue);font-size:12px}.votes{display:flex;gap:4px;margin-top:8px}.vote{width:17px;height:6px;border-radius:999px;background:#c8d0d5}.vote.vote-pass{background:var(--green)}.vote.vote-watch{background:var(--amber)}.vote.vote-reject{background:var(--red)}.vote-copy{display:block;margin-top:4px;color:var(--muted);font-size:10px}
.stock-list{display:grid;gap:16px}.stock-card{padding:22px;border:1px solid var(--line);border-radius:15px;background:#fff}.stock-header{display:flex;justify-content:space-between;gap:20px;align-items:start}.ticker{display:block;color:var(--blue);font:700 12px var(--mono);letter-spacing:.1em}.stock-header h3{margin:2px 0 1px;font-size:24px}.stock-header p{margin:0;color:var(--muted);font-size:11px}.decision-chip{display:inline-block;margin-top:8px;padding:3px 8px;border:1px solid transparent;border-radius:999px;font:700 10px var(--mono);letter-spacing:.05em}.decision-core{background:#e2f2e9;color:#216346}.decision-satellite{background:#e1f0f4;color:#285d74}.decision-watch{background:#fff0d4;color:#80520f}.decision-reject{background:#f8e2de;color:#963b35}.decision-incomplete{border-color:#b9c0c7;background:#eef0f1;color:#59636f}.stock-votes{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:7px;max-width:480px}.vote-chip{min-width:68px;padding:7px 9px;border-radius:10px;background:#fff3d9;color:#704c13;text-align:center;font-size:9px}.vote-chip b{display:block;font-size:18px}.vote-chip.vote-core{background:#e2f2e9;color:#216346}.vote-chip.vote-satellite{background:#e1f0f4;color:#285d74}.vote-chip.vote-reject{background:#f8e2de;color:#8b3934}.vote-chip.vote-incomplete{border:1px solid #c8cdd2;background:#eef0f1;color:#59636f}.metric-row{display:grid;grid-template-columns:repeat(4,1fr);margin:18px 0;border:1px solid var(--line);border-radius:12px;overflow:hidden}.metric-row div{padding:12px 14px}.metric-row div+div{border-left:1px solid var(--line)}.metric-row span,.metric-row small{display:block;color:var(--muted);font-size:10px}.metric-row strong{display:block;margin:4px 0;font:700 17px var(--serif)}.stock-audit-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0}.stock-audit-card{padding:14px;border:1px solid var(--line);border-radius:12px;background:#faf9f5}.stock-audit-title{display:flex;align-items:center;justify-content:space-between;gap:10px}.stock-audit-title h4{margin:0;font-size:14px}.stock-audit-card p{margin:8px 0 0;color:#586576;font-size:11px}.technical-audit,.gate-evidence-audit{grid-column:1/-1}.technical-audit .table-wrap{margin-top:10px}.technical-audit .gate-table{font-size:10px}.technical-audit .gate-table th,.technical-audit .gate-table td{padding:8px}.history-semantics{color:var(--muted);font-size:10px}.gate-evidence-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:10px}.gate-evidence-grid p{margin:0;padding:8px 10px;border-radius:8px;background:#fff;font-size:10px}.gate-evidence-grid b{color:var(--blue)}.stock-reason{padding:13px 15px;border-left:4px solid var(--blue);background:#edf3f5;color:#35485a}.stock-columns{display:grid;grid-template-columns:1fr 1fr;gap:18px}.stock-columns h4{margin:8px 0}.stock-columns p,.stock-columns li{color:#586576;font-size:12px}.gate-bands{margin-top:16px;padding:14px 16px;background:#f2efe7;border-radius:12px}.gate-bands p{margin:5px 0;font-size:12px}.gate-bands p:nth-child(1) b{color:var(--green)}.gate-bands p:nth-child(3) b{color:var(--red)}
.gate-defs{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px}.gate-defs article{display:grid;grid-template-columns:42px 1fr;gap:10px;padding:14px;border:1px solid var(--line);border-radius:12px;background:#fff}.gate-defs article>span{display:grid;place-items:center;width:38px;height:38px;border-radius:9px;background:var(--navy);color:#fff;font:700 11px var(--mono)}.gate-defs h3{margin:0;font-size:14px}.gate-defs p{margin:4px 0 0;color:var(--muted);font-size:11px}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:13px;background:#fff}.gate-table{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap}.gate-table th{padding:11px 10px;background:#edf0ef;color:#4b5664;text-align:left;font-size:11px;line-height:1.25;border-bottom:1px solid var(--line)}.gate-table thead th{position:sticky;top:0;z-index:1}.gate-table td{padding:10px;border-bottom:1px solid #ece8df;vertical-align:top}.gate-table tbody tr:hover{background:#f8faf9}.gate-table tbody tr:last-child td,.gate-table tbody tr:last-child th{border-bottom:0}.status{display:inline-block;padding:3px 7px;border-radius:999px;font-size:10px;font-weight:700}.status-pass{background:#e2f2e9;color:#216346}.status-watch,.status-open{background:#fff0d4;color:#80520f}.status-fail{background:#f8e2de;color:#963b35}.table-note{margin:10px 0 0;color:var(--muted);font-size:11px}
.latest-council{display:flex;justify-content:space-between;gap:24px;align-items:center;padding:24px;background:var(--navy);color:#fff;border-radius:18px;margin-bottom:16px}.latest-council .section-kicker{color:#91cbd3}.latest-council h3{margin:4px 0;font-size:26px}.latest-council p{margin:4px 0;color:rgba(255,255,255,.72);font-size:12px}.artifact-link{white-space:nowrap;padding:10px 14px;border:1px solid rgba(255,255,255,.25);border-radius:999px;text-decoration:none}.artifact-link:hover{background:rgba(255,255,255,.1)}.council-result-grid{display:grid;grid-template-columns:.8fr 1.2fr;gap:14px;margin-bottom:18px}.expert-grid{display:grid;gap:10px}.expert{border:1px solid var(--line);border-radius:14px;background:#fff;overflow:hidden}.expert summary{display:grid;grid-template-columns:46px 1fr auto;gap:12px;align-items:center;padding:15px 18px;cursor:pointer}.expert-index{display:grid;place-items:center;width:38px;height:38px;border-radius:50%;background:var(--navy);color:#fff;font:700 11px var(--mono)}.expert summary strong,.expert summary small{display:block}.expert summary small,.disclosure{color:var(--muted);font-size:11px}.expert-content{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--line)}.expert-content section{padding:20px}.expert-content section+section{border-left:1px solid var(--line)}.expert-content h3{margin-top:0}.expert-content p,.expert-content li{font-size:12px;color:#566376}.revision{padding:12px;border-left:4px solid var(--green);background:#edf7f1;font-size:12px}.ratings{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}.ratings span{padding:7px;border-radius:9px;background:#f3f1eb;text-align:center}.ratings small,.ratings b{display:block;font-size:9px}.rating-core,.rating-pass{color:var(--green)}.rating-satellite,.rating-watch{color:var(--amber)}.rating-reject{color:var(--red)}.muted-tag{background:#f3f1eb;color:#747c87}
.monitor-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.monitor-grid article{display:grid;grid-template-columns:44px 1fr;gap:11px;align-items:center;padding:13px;border:1px solid var(--line);border-radius:12px;background:#fff}.monitor-grid span{color:var(--blue);font:700 12px var(--mono)}.monitor-grid p{margin:0;font-size:12px}.source-list{display:grid;grid-template-columns:1fr 1fr;gap:8px}.source-list>a{display:grid;grid-template-columns:34px 1fr 18px;gap:10px;align-items:center;padding:12px;border:1px solid var(--line);border-radius:11px;background:#fff;text-decoration:none}.source-list>a:hover{border-color:#9fb1bc}.source-list>a>span{color:var(--blue);font:700 11px var(--mono)}.source-list strong,.source-list small{display:block}.source-list strong{font-size:12px}.source-list small{color:var(--muted);font-size:10px}.limitations{columns:2;column-gap:36px;padding-left:20px}.limitations li{break-inside:avoid;margin-bottom:10px;color:#586375;font-size:12px}.provenance{margin-top:18px;padding:14px;border-radius:10px;background:#132136;color:#dbe8ee;font:10px/1.65 var(--mono);overflow-wrap:anywhere}.footer{background:var(--navy);color:#fff}.footer-inner{max-width:1450px;margin:auto;padding:24px 34px;display:flex;justify-content:space-between;gap:24px;align-items:center}.footer p{max-width:920px;margin:0;color:#b9c5d2;font-size:11px}.footer a{color:#8ed1d6}.is-hidden{display:none!important}.no-print{display:flex}
@media(max-width:1180px){.macro-grid{grid-template-columns:1fr 1fr}.theme-grid{grid-template-columns:1fr}.gate-defs{grid-template-columns:1fr 1fr}.ratings{grid-template-columns:repeat(3,1fr)}}
@media(max-width:1050px){.layout{grid-template-columns:1fr}.toc{display:none}.hero-grid{grid-template-columns:1fr 1fr}.hero-cell:nth-child(3){border-left:0}.hero-cell:nth-child(n+3){border-top:1px solid rgba(255,255,255,.13);padding-top:12px}.scenario-grid,.council-result-grid{grid-template-columns:1fr}.process{grid-template-columns:1fr 1fr}}
@media(max-width:720px){.site-nav-inner{padding:9px 14px;overflow-x:auto}.site-brand{margin-right:6px}.page{padding:0 14px 60px}.hero{margin:0 -14px 20px;padding:52px 18px 42px}.hero h1{font-size:clamp(34px,10.5vw,42px);overflow-wrap:anywhere}.hero h1 em{display:inline-block}.hero-lead{font-size:15px}.hero-grid{grid-template-columns:1fr}.hero-cell{padding:11px 0}.hero-cell+.hero-cell,.hero-cell:nth-child(3){border-left:0;border-top:1px solid rgba(255,255,255,.13)}.section{padding:21px 16px;border-radius:14px}.section-head{grid-template-columns:1fr;gap:3px}.section-number{padding:0}.verdict,.stock-columns,.expert-content{grid-template-columns:1fr}.process,.macro-grid,.timeline,.theme-grid,.gate-defs,.monitor-grid,.source-list,.stock-audit-grid,.gate-evidence-grid{grid-template-columns:1fr}.theme-top{grid-template-columns:54px 1fr}.theme-score-total{grid-column:1/-1;width:100%}.theme-components{grid-template-columns:repeat(2,minmax(0,1fr))}.latest-council{display:block}.artifact-link{display:inline-block;margin-top:12px}.stock-header{display:block}.stock-votes{justify-content:flex-start;margin-top:12px}.candidate{display:block}.candidate strong{display:block;margin-top:4px}.metric-row{grid-template-columns:1fr 1fr}.metric-row div:nth-child(3){border-left:0;border-top:1px solid var(--line)}.metric-row div:nth-child(4){border-top:1px solid var(--line)}.expert summary{grid-template-columns:38px 1fr}.disclosure{grid-column:2}.expert-content section+section{border-left:0;border-top:1px solid var(--line)}.ratings{grid-template-columns:repeat(3,1fr)}.limitations{columns:1}.footer-inner{display:block}.gate-table{min-width:760px}}
@media(max-width:420px){.site-nav-inner{gap:5px}.site-link{padding:5px 7px}.site-link:last-child{display:none}}
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function publicArtifactHref(value: unknown, fallback: string): string {
  const raw = (isNonEmptyString(value) ? value : fallback).trim().replaceAll('\\', '/')
  if (/^(?:https?:)?\/\//i.test(raw) || raw.startsWith('#')) return raw
  const docsMarker = raw.lastIndexOf('/docs/')
  const publicPath = (docsMarker >= 0 ? raw.slice(docsMarker + 6) : raw)
    .replace(/^docs\//, '')
    .replace(/^\.\//, '')
    .replace(/^\//, '')
  return `./${publicPath}`
}

function voteTotal(votes: unknown, keys: readonly string[], label: string): number {
  if (votes === null || typeof votes !== 'object' || Array.isArray(votes)) {
    throw new Error(`Missing committee votes for ${label}`)
  }
  let total = 0
  for (const key of keys) {
    const value = (votes as Json)[key]
    if (value === undefined) continue
    const count = Number(value)
    if (!Number.isInteger(count) || count < 0) throw new Error(`Invalid ${key} vote count for ${label}: ${value}`)
    total += count
  }
  return total
}

function effectiveStockDecision(stock: Json): StockDecision {
  const label = String(stock.symbol ?? stock.name ?? 'unknown stock')
  const decision = isNonEmptyString(stock.decision) ? stock.decision.trim().toLowerCase() : ''
  const executionTier = isNonEmptyString(stock.execution_tier) ? stock.execution_tier.trim().toLowerCase() : ''

  if (executionTier && !EXECUTION_TIER_SET.has(executionTier)) {
    throw new Error(`Invalid execution_tier for ${label}: ${stock.execution_tier}`)
  }
  if (decision && !STOCK_DECISION_SET.has(decision)) {
    throw new Error(`Invalid stock decision for ${label}: ${stock.decision}`)
  }
  if (!decision && executionTier) return executionTier as StockDecision
  if (!decision) throw new Error(`Missing stock decision for ${label}`)
  if (executionTier && decision !== executionTier) {
    throw new Error(`Conflicting decision and execution_tier for ${label}: ${decision} vs ${executionTier}`)
  }
  return decision as StockDecision
}

function decisionChip(decision: StockDecision): string {
  return `<span class="decision-chip decision-${decision}">${esc(decision.toUpperCase())}</span>`
}

function decisionSummary(stocks: Json[]): string {
  return STOCK_DECISIONS
    .map(decision => ({ decision, count: stocks.filter(stock => effectiveStockDecision(stock) === decision).length }))
    .filter(item => item.count > 0)
    .map(item => `${item.count} ${item.decision.toUpperCase()}`)
    .join(' / ') || '无候选'
}

function gateOutcome(statuses: GateStatus[]): StockDecision | 'executable' {
  if (statuses.includes('fail')) return 'reject'
  if (statuses.includes('open')) return 'incomplete'
  if (statuses.includes('watch')) return 'watch'
  return 'executable'
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
  return `<div class="votes" aria-label="评分映射核对：${pass} PASS，${watch} WATCH，${reject} REJECT">${cells.join('')}</div><span class="vote-copy">${pass}/${watch}/${reject} · ${total}次映射核对</span>`
}

function stockVotes(votes: Json): string {
  const entries = STOCK_DECISIONS
    .map(decision => ({ decision, count: Number(votes[decision] ?? 0) }))
    .filter(({ decision, count }) => Object.hasOwn(votes, decision) || count > 0)
  const label = entries.map(entry => `${entry.count} ${entry.decision.toUpperCase()}`).join('，')
  return `<div class="stock-votes" aria-label="前五门映射核对：${esc(label)}">${entries.map(({ decision, count }) => `<span class="vote-chip vote-${decision}"><b>${count}</b>${esc(decision.toUpperCase())}</span>`).join('')}</div>`
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
  const scoreDefinitions = Array.isArray(data.theme_scoring?.components) ? data.theme_scoring.components as Json[] : []
  return `<div class="theme-toolbar no-print" aria-label="主题筛选"><button type="button" class="filter-button is-active" data-theme-filter="all">全部</button><button type="button" class="filter-button" data-theme-filter="A">A档 / 强证据</button><button type="button" class="filter-button" data-theme-filter="B">B档 / 条件性</button><button type="button" class="filter-button" data-theme-filter="C">C档 / 影子</button></div>
  <div class="theme-grid" id="theme-grid">${(data.themes as Json[]).map(theme => {
    const hasScore = Number.isFinite(Number(theme.score))
    const scorePanel = hasScore
      ? `<div class="theme-score-total" aria-label="主题证据分数 ${esc(theme.score)} / 100"><strong>${esc(theme.score)}</strong><small>／100</small></div>`
      : ''
    const componentPanel = hasScore && scoreDefinitions.length > 0
      ? `<div class="theme-components" aria-label="五维证据评分">${scoreDefinitions.map(component => `<span class="theme-component" title="${esc(component.rule)}"><small>${esc(component.name)}</small><b>${esc(theme.score_components?.[component.id])} / 20</b></span>`).join('')}</div>`
      : ''
    const scoreSummary = isNonEmptyString(theme.score_summary) ? `<p class="theme-score-summary"><b>评分解释：</b>${esc(theme.score_summary)}</p>` : ''
    const upgradeCondition = isNonEmptyString(theme.upgrade_condition) ? `<p class="theme-score-summary"><b>升级条件：</b>${esc(theme.upgrade_condition)}</p>` : ''
    return `<article class="theme-card" data-grade="${esc(String(theme.grade).slice(0, 1))}">
      <div class="theme-top"><span class="grade grade-${esc(String(theme.grade).slice(0, 1).toLowerCase())}">${esc(theme.grade)}</span><div><h3>${esc(theme.name)}</h3>${voteBar(theme.latest_committee)}<small class="vote-copy">核对口径：${esc(theme.committee_basis)}</small></div>${scorePanel}</div>
      ${componentPanel}${scoreSummary}${upgradeCondition}
      <p class="theme-thesis">${esc(theme.thesis)}</p>
      <ul class="evidence-list">${(theme.evidence as string[]).map(item => `<li>${esc(item)}</li>`).join('')}</ul>
      <div class="candidate"><span>观察标的</span><strong>${esc(theme.candidate)}</strong></div>
      <div class="hard-fail"><b>硬失效：</b>${esc(theme.hard_fail)}</div>
      <div class="card-sources">${sourceRefs(theme.source_ids, sources)}</div>
    </article>`
  }).join('')}</div>`
}

function percent(value: unknown): string {
  const number = Number(value)
  return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : '—'
}

function wilsonInterval(value: unknown): string {
  if (!Array.isArray(value) || value.length !== 2) return '—'
  return `[${percent(value[0])}, ${percent(value[1])}]`
}

function stockAuditSnapshots(stock: Json): string {
  const quality = stock.quality_snapshot as Json | undefined
  const valuation = stock.valuation_snapshot as Json | undefined
  const technical = stock.technical_snapshot as Json | undefined
  const gateEvidence = stock.gate_evidence as Json | undefined
  const history = Array.isArray(technical?.conditional_history) ? technical.conditional_history as Json[] : []
  if (!quality && !valuation && !gateEvidence && history.length === 0) return ''

  const qualityCard = quality
    ? `<article class="stock-audit-card"><div class="stock-audit-title"><h4>质量门 · ${esc(quality.period)}</h4>${status(String(quality.status))}</div><p>${esc(quality.conclusion)}</p>${isNonEmptyString(quality.annual) ? `<p><b>全年参照：</b>${esc(quality.annual)}</p>` : ''}</article>`
    : ''
  const valuationCard = valuation
    ? `<article class="stock-audit-card"><div class="stock-audit-title"><h4>估值门 · ${esc(valuation.date)}</h4>${status(String(valuation.status))}</div><p>${esc(valuation.conclusion)}</p>${valuation.rule ? `<p><b>${esc(valuation.track === 'growth' ? '成长轨道' : '稳定现金流轨道')} PASS：</b>${esc(valuation.rule.pass)}</p>` : ''}</article>`
    : ''
  const technicalCard = history.length > 0
    ? `<article class="stock-audit-card technical-audit"><div class="stock-audit-title"><h4>同状态历史条件频率 · 截至 ${esc(technical?.date)}</h4><span class="history-semantics">非重叠样本，描述性统计</span></div><div class="table-wrap"><table class="gate-table conditional-history"><thead><tr><th>观察期</th><th>n / 样本状态</th><th>上涨率 · Wilson 95%</th><th>跑赢率 · Wilson 95%</th><th>平均收益</th><th>平均超额</th></tr></thead><tbody>${history.map(row => `<tr><th>${esc(row.horizon_trading_days)}日</th><td>${esc(row.non_overlapping_observations)} · ${Number(row.non_overlapping_observations) < 10 ? '<span class="status status-watch">样本不足</span>' : '<span class="status status-pass">仅描述</span>'}</td><td>${percent(row.positive_rate)} · ${wilsonInterval(row.positive_rate_wilson95)}</td><td>${percent(row.outperform_rate)} · ${wilsonInterval(row.outperform_rate_wilson95)}</td><td>${percent(row.mean_return)}</td><td>${percent(row.mean_excess_return)}</td></tr>`).join('')}</tbody></table></div><p class="history-semantics">${esc(history[0]?.semantics)} 样本少于10的窗口明确标记为不足；所有条件频率均不参与主题评分或六门决策。</p></article>`
    : ''
  const gateLabels: Record<string, string> = { fact: '事实', mechanism: '机制', quality: '质量', valuation: '估值', falsifier: '反证', council: '会商' }
  const gateEvidenceCard = gateEvidence
    ? `<article class="stock-audit-card gate-evidence-audit"><div class="stock-audit-title"><h4>六门证据说明</h4><span class="history-semantics">状态不是空标签</span></div><div class="gate-evidence-grid">${Object.entries(gateLabels).map(([id, label]) => `<p><b>${esc(label)}：</b>${esc(gateEvidence[id] ?? '—')}</p>`).join('')}</div></article>`
    : ''
  return `<div class="stock-audit-grid">${qualityCard}${valuationCard}${gateEvidenceCard}${technicalCard}</div>`
}

function stockCards(data: Json, sources: Map<string, Json>): string {
  return `<div class="stock-toolbar no-print"><label for="stock-layer">显示：</label><select id="stock-layer"><option value="all">全部${(data.stocks as Json[]).length}股</option><option value="core">CORE / 核心执行层</option><option value="satellite">SATELLITE / 卫星执行层</option><option value="watch">WATCH / 待补证研究池</option><option value="reject">REJECT / 当前否决</option><option value="incomplete">INCOMPLETE / 门禁未完成</option></select></div>
  <div class="stock-list" id="stock-list">${(data.stocks as Json[]).map(stock => {
    const filter = effectiveStockDecision(stock)
    return `<article class="stock-card" data-layer="${filter}">
      <div class="stock-header"><div><span class="ticker">${esc(stock.symbol)}</span><h3>${esc(stock.name)}</h3><p>${esc(stock.layer)} · 财务截止 ${esc(stock.financial_cutoff)}</p>${decisionChip(filter)}</div>${stockVotes(stock.latest_committee)}</div>
      <div class="metric-row">${(stock.metrics as Json[]).map(metric => `<div><span>${esc(metric.label)}</span><strong>${esc(metric.value)}</strong><small>${esc(metric.change)}</small></div>`).join('')}</div>
      ${stockAuditSnapshots(stock)}
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
  const stocksByName = new Map((data.stocks as Json[]).map(stock => [stock.name, stock]))
  const executableCount = (data.stocks as Json[]).filter(stock => EXECUTION_TIER_SET.has(effectiveStockDecision(stock))).length
  return `<div class="gate-defs">${criteria.map((gate, index) => `<article><span>G${index + 1}</span><div><h3>${esc(gate.name)}</h3><p>${esc(gate.rule)}</p></div></article>`).join('')}</div>
  <div class="table-wrap"><table class="gate-table"><thead><tr><th>观察对象</th>${criteria.map(g => `<th>${esc(g.name)}</th>`).join('')}<th>Decision</th><th>动作</th></tr></thead><tbody>${results.map(row => {
    const stock = stocksByName.get(row.name)!
    return `<tr><th>${esc(row.name)}</th>${criteria.map(g => `<td>${status(row[g.id])}</td>`).join('')}<td>${decisionChip(effectiveStockDecision(stock))}</td><td>${esc(row.action)}</td></tr>`
  }).join('')}</tbody></table></div>
  <p class="table-note">强制动作规则：任一门 FAIL → REJECT；无 FAIL 但任一门 OPEN → INCOMPLETE；无 FAIL / OPEN 但任一门 WATCH → WATCH；六门全部 PASS 才允许进入 CORE / SATELLITE，并保留各自执行层级。本期为 ${executableCount} 个可执行候选。</p>`
}

function expertCouncil(data: Json): string {
  return `<div class="expert-grid">${(data.experts as Json[]).map((expert, index) => `<details class="expert" ${index === 0 ? 'open' : ''}>
    <summary><span class="expert-index">0${index + 1}</span><div><strong>${esc(expert.name)}</strong><small>${esc(expert.role)}</small></div><span class="disclosure">方法论 AI 模拟 · 展开</span></summary>
    <div class="expert-content">
      <section><h3>Round 1 · 独立盲审</h3><p><b>周期：</b>${esc(expert.round1.cycle)}</p><p><b>历史原始未校准权重（最终废弃，不是概率）：</b>${esc(expert.round1.scenarios)}</p><p><b>偏好：</b>${(expert.round1.preferred as string[]).map(item => `<span class="inline-tag">${esc(item)}</span>`).join('')}</p><p><b>首轮股票（历史观点，已被最新复核覆盖）：</b>${(expert.round1.stocks as string[]).map(item => `<span class="inline-tag muted-tag">${esc(item)}</span>`).join('')}</p><h4>反对的共识</h4><ul>${(expert.round1.objections as string[]).map(item => `<li>${esc(item)}</li>`).join('')}</ul><h4>向同行发问</h4><ol>${(expert.round1.questions as string[]).map(item => `<li>${esc(item)}</li>`).join('')}</ol></section>
      <section class="round-two"><h3>Round 2 · 匿名交叉质询</h3><h4>反驳</h4><ul>${(expert.round2.rebuttals as string[]).map(item => `<li>${esc(item)}</li>`).join('')}</ul><div class="revision"><b>接受并修订：</b>${esc(expert.round2.accepted_revision)}</div><h4>主题评级（历史快照）</h4><div class="ratings">${Object.entries(expert.round2.theme_ratings as Record<string, string>).map(([key, value]) => `<span><small>${esc(({ dividend: '红利', grid_ai: 'AI/电网', manufacturing: '制造/机器人', pharma: '创新药', consumption: '消费' } as Record<string, string>)[key] ?? key)}</small><b class="rating-${esc(value.toLowerCase())}">${esc(value)}</b></span>`).join('')}</div><h4>${(data.stocks as Json[]).length}股评级（历史观点，已被最新复核覆盖）</h4><div class="ratings stock-ratings">${Object.entries(expert.round2.stock_ratings as Record<string, string>).map(([key, value]) => `<span><small>${esc(key)}</small><b class="rating-${esc(value.toLowerCase())}">${esc(value)}</b></span>`).join('')}</div><p><b>历史未校准修订权重（最终废弃，不是概率）：</b>${esc(expert.round2.scenarios)}</p><h4>自我约束门禁</h4><ol>${(expert.round2.gates as string[]).map(item => `<li>${esc(item)}</li>`).join('')}</ol></section>
    </div>
  </details>`).join('')}</div>`
}

function latestCouncil(data: Json): string {
  const council = data.latest_council as Json
  const themeResults = council.theme_results as Json[]
  const stockResults = council.stock_results as Json[]
  const themeColumnCandidates = [
    { key: 'grade', label: '等级' },
    { key: 'score', label: '分数' },
    { key: 'pass', label: 'PASS' },
    { key: 'watch', label: 'WATCH' },
    { key: 'reject', label: 'REJECT' },
  ]
  const stockColumnCandidates = [
    { key: 'core', label: 'CORE' },
    { key: 'satellite', label: 'SATELLITE' },
    { key: 'watch', label: 'WATCH' },
    { key: 'reject', label: 'REJECT' },
    { key: 'incomplete', label: 'INCOMPLETE' },
    { key: 'decision', label: '门禁决策' },
  ]
  const themeColumns = themeColumnCandidates.filter(column => themeResults.some(row => Object.hasOwn(row, column.key)))
  const stockColumns = stockColumnCandidates.filter(column => stockResults.some(row => Object.hasOwn(row, column.key)))
  const hasCouncilVote = stockResults.some(row => row.council_vote !== null && typeof row.council_vote === 'object')
  const artifactHref = publicArtifactHref(data.metadata.expert_run_artifact ?? council.artifact, `docs/research-data/a-share-cycle-expert-runs-${data.metadata.as_of}.json`)
  return `<div class="latest-council"><div><span class="section-kicker">${esc(council.round)}</span><h3>最新事实复核已留痕</h3><p>${esc(council.execution)}</p><p><b>情景共识：</b>${esc(council.scenario_consensus)}</p></div><a class="artifact-link" href="${esc(artifactHref)}" target="_blank" rel="noreferrer">查看${(data.experts as Json[]).length}份原始输出与哈希 ↗</a></div>
  <div class="council-result-grid"><div class="table-wrap"><table class="gate-table"><thead><tr><th>主题映射核对</th>${themeColumns.map(column => `<th>${esc(column.label)}</th>`).join('')}</tr></thead><tbody>${themeResults.map(row => `<tr><th>${esc(row.name)}</th>${themeColumns.map(column => `<td>${esc(row[column.key] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div><div class="table-wrap"><table class="gate-table"><thead><tr><th>股票前五门核对</th>${stockColumns.map(column => `<th>${esc(column.label)}</th>`).join('')}${hasCouncilVote ? '<th>独立会商 P/W/R</th>' : ''}<th>最终动作</th></tr></thead><tbody>${stockResults.map(row => `<tr><th>${esc(row.name)}</th>${stockColumns.map(column => `<td>${esc(row[column.key] ?? '—')}</td>`).join('')}${hasCouncilVote ? `<td>${esc(row.council_vote?.pass ?? 0)} / ${esc(row.council_vote?.watch ?? 0)} / ${esc(row.council_vote?.reject ?? 0)}</td>` : ''}<td>${esc(row.action)}</td></tr>`).join('')}</tbody></table></div></div>
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
  if (!isNonEmptyString(data.metadata?.pre_council_artifact) || !/^[a-f0-9]{64}$/.test(String(data.metadata?.pre_council_sha256))) throw new Error('Missing frozen pre-council artifact provenance')
  if (!isNonEmptyString(data.metadata?.expert_run_artifact) || !/^[a-f0-9]{64}$/.test(String(data.metadata?.expert_run_artifact_sha256))) throw new Error('Missing expert-run artifact provenance')
  if (!Array.isArray(data.experts) || data.experts.length !== 5) throw new Error('Expected exactly five expert-method roles')
  if (!Array.isArray(data.scenarios) || data.scenarios.length !== 3) throw new Error('Expected exactly three scenarios')
  if ((data.scenarios as Json[]).some(item => 'weight' in item || !item.priority)) throw new Error('Final scenarios must use ranks, not uncalibrated numeric weights')
  if (!Array.isArray(data.scenario_scorecard) || data.scenario_scorecard.length !== 6) throw new Error('Scenario state machine requires six indicators')
  if (!Array.isArray(data.themes)) throw new Error('Expected a themes array')
  const scoreDefinitions = Array.isArray(data.theme_scoring?.components) ? data.theme_scoring.components as Json[] : []
  const gradeDefinitions = Array.isArray(data.theme_scoring?.grades) ? data.theme_scoring.grades as Json[] : []
  if (data.theme_scoring !== undefined) {
    if (scoreDefinitions.length !== 5) throw new Error('Theme scoring requires exactly five components')
    if (gradeDefinitions.length !== THEME_GRADES.length) throw new Error(`Theme scoring requires exactly ${THEME_GRADES.length} grade bands`)
    const scoreIds = new Set<string>()
    for (const component of scoreDefinitions) {
      if (!isNonEmptyString(component.id) || !isNonEmptyString(component.name) || !isNonEmptyString(component.rule)) {
        throw new Error('Every theme score component requires non-empty id, name, and rule fields')
      }
      if (scoreIds.has(component.id)) throw new Error(`Duplicate theme score component: ${component.id}`)
      scoreIds.add(component.id)
    }
  }
  for (const theme of data.themes as Json[]) {
    if (!THEME_GRADE_SET.has(theme.grade)) {
      throw new Error(`Invalid theme grade for ${theme.id ?? theme.name}: ${theme.grade}; expected ${THEME_GRADES.join(', ')}`)
    }
    const committeeTotal = voteTotal(theme.committee, ['pass', 'watch', 'reject'], `${theme.id} historical theme committee`)
    const latestCommitteeTotal = voteTotal(theme.latest_committee, ['pass', 'watch', 'reject'], `${theme.id} latest theme committee`)
    if (committeeTotal !== 5 || latestCommitteeTotal !== 5 || !theme.committee_basis) throw new Error(`Invalid committee mapping for theme ${theme.id}`)
    if (data.theme_scoring !== undefined) {
      const score = Number(theme.score)
      if (!Number.isInteger(score) || score < 0 || score > 100) throw new Error(`Invalid theme score for ${theme.id}: ${theme.score}`)
      let scoreTotal = 0
      for (const component of scoreDefinitions) {
        const componentScore = Number(theme.score_components?.[component.id])
        if (!Number.isInteger(componentScore) || componentScore < 0 || componentScore > 20) {
          throw new Error(`Invalid ${component.id} score for theme ${theme.id}: ${theme.score_components?.[component.id]}`)
        }
        scoreTotal += componentScore
      }
      if (scoreTotal !== score) throw new Error(`Theme score total mismatch for ${theme.id}: ${scoreTotal} vs ${score}`)
      const expectedGrade = [...gradeDefinitions]
        .sort((left, right) => Number(right.min) - Number(left.min))
        .find(definition => score >= Number(definition.min))?.grade
      if (expectedGrade !== theme.grade) throw new Error(`Theme grade mismatch for ${theme.id}: score ${score} requires ${expectedGrade}, received ${theme.grade}`)
      if (!isNonEmptyString(theme.score_summary)) throw new Error(`Missing theme score summary for ${theme.id}`)
    }
  }

  if (!Array.isArray(data.stocks) || data.stocks.length === 0) throw new Error('Expected a non-empty stocks array')
  const stockNames = new Set<string>()
  const stockSymbols = new Set<string>()
  for (const stock of data.stocks as Json[]) {
    if (!isNonEmptyString(stock.name) || !isNonEmptyString(stock.symbol)) throw new Error('Every stock requires a non-empty name and symbol')
    if (stockNames.has(stock.name) || stockSymbols.has(stock.symbol)) throw new Error(`Duplicate stock identity: ${stock.symbol} ${stock.name}`)
    stockNames.add(stock.name)
    stockSymbols.add(stock.symbol)
    effectiveStockDecision(stock)
    const committeeTotal = voteTotal(stock.committee, STOCK_DECISIONS, `${stock.symbol} historical stock committee`)
    const latestCommitteeTotal = voteTotal(stock.latest_committee, STOCK_DECISIONS, `${stock.symbol} latest stock committee`)
    if (committeeTotal !== 5 || latestCommitteeTotal !== 5) throw new Error(`Invalid committee vote total for ${stock.symbol}`)
    if (!isNonEmptyString(stock.gate_bands?.pass) || !isNonEmptyString(stock.gate_bands?.watch) || !isNonEmptyString(stock.gate_bands?.fail)) throw new Error(`Incomplete strict gate bands for ${stock.symbol}`)
    if (stock.quality_snapshot !== undefined && !GATE_STATUS_SET.has(String(stock.quality_snapshot.status))) throw new Error(`Invalid quality snapshot status for ${stock.symbol}`)
    if (stock.valuation_snapshot !== undefined) {
      if (!GATE_STATUS_SET.has(String(stock.valuation_snapshot.status))) throw new Error(`Invalid valuation snapshot status for ${stock.symbol}`)
      if (!Number.isFinite(Number(stock.valuation_snapshot.annual_fcf_yield_pct))) throw new Error(`Missing annual FCF yield for ${stock.symbol}`)
      if (!isNonEmptyString(stock.valuation_snapshot.rule?.pass) || !isNonEmptyString(stock.valuation_snapshot.rule?.watch) || !isNonEmptyString(stock.valuation_snapshot.rule?.fail)) throw new Error(`Incomplete valuation rule for ${stock.symbol}`)
    }
    if (stock.gate_evidence !== undefined) {
      for (const gateId of REQUIRED_GATE_IDS) if (!isNonEmptyString(stock.gate_evidence[gateId])) throw new Error(`Missing ${gateId} evidence for ${stock.symbol}`)
    }
  }

  if (data.view_gates === null || typeof data.view_gates !== 'object') throw new Error('Missing view_gates object')
  const criteria = data.view_gates.criteria
  if (!Array.isArray(criteria) || criteria.length !== REQUIRED_GATE_IDS.length) {
    throw new Error(`view_gates.criteria must contain exactly ${REQUIRED_GATE_IDS.length} gates`)
  }
  const criterionIds = new Set<string>()
  for (const criterion of criteria as Json[]) {
    if (!isNonEmptyString(criterion.id) || !isNonEmptyString(criterion.name) || !isNonEmptyString(criterion.rule)) {
      throw new Error('Every view gate criterion requires non-empty id, name, and rule fields')
    }
    if (criterionIds.has(criterion.id)) throw new Error(`Duplicate view gate criterion: ${criterion.id}`)
    if (!(REQUIRED_GATE_IDS as readonly string[]).includes(criterion.id)) throw new Error(`Unknown view gate criterion: ${criterion.id}`)
    criterionIds.add(criterion.id)
  }
  for (const gateId of REQUIRED_GATE_IDS) {
    if (!criterionIds.has(gateId)) throw new Error(`Missing view gate criterion: ${gateId}`)
  }

  const results = data.view_gates.results
  if (!Array.isArray(results) || results.length !== data.stocks.length) {
    throw new Error('view_gates.results must contain exactly one row for every stock')
  }
  const stocksByName = new Map<string, Json>((data.stocks as Json[]).map(stock => [stock.name, stock]))
  const resultNames = new Set<string>()
  for (const row of results as Json[]) {
    if (!isNonEmptyString(row.name) || !isNonEmptyString(row.action)) {
      throw new Error('Every view gate result requires non-empty name and action fields')
    }
    if (resultNames.has(row.name)) throw new Error(`Duplicate view gate result: ${row.name}`)
    resultNames.add(row.name)
    const stock = stocksByName.get(row.name)
    if (!stock) throw new Error(`View gate result does not match a stock: ${row.name}`)

    const statuses = REQUIRED_GATE_IDS.map(gateId => {
      const gateStatus = row[gateId]
      if (!isNonEmptyString(gateStatus) || !GATE_STATUS_SET.has(gateStatus)) {
        throw new Error(`Invalid or missing gate status ${gateId} for ${row.name}: ${gateStatus}`)
      }
      return gateStatus as GateStatus
    })
    const decision = effectiveStockDecision(stock)
    const expected = gateOutcome(statuses)
    if (expected === 'executable') {
      if (!EXECUTION_TIER_SET.has(decision)) {
        throw new Error(`Gate decision mismatch for ${row.name}: all PASS requires core or satellite, received ${decision}`)
      }
    } else if (decision !== expected) {
      throw new Error(`Gate decision mismatch for ${row.name}: statuses require ${expected}, received ${decision}`)
    }

    if (row.decision !== undefined) {
      const rowDecision = isNonEmptyString(row.decision) ? row.decision.trim().toLowerCase() : ''
      if (!STOCK_DECISION_SET.has(rowDecision) || rowDecision !== decision) {
        throw new Error(`View gate decision mismatch for ${row.name}: ${row.decision} vs ${decision}`)
      }
    }
    const actionDecision = row.action.match(/^(CORE|SATELLITE|WATCH|REJECT|INCOMPLETE)(?=$|[\s:：;；,，])/i)?.[1]?.toLowerCase()
    if (actionDecision !== decision) {
      throw new Error(`View gate action for ${row.name} must start with ${decision.toUpperCase()}`)
    }
  }
  for (const stockName of stockNames) {
    if (!resultNames.has(stockName)) throw new Error(`Missing view gate result for ${stockName}`)
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
  const asOf = isNonEmptyString(meta.as_of) ? meta.as_of : '2026-08-25'
  const reportDataArtifact = isNonEmptyString(meta.report_data_artifact) ? meta.report_data_artifact : `docs/research-data/a-share-cycle-outlook-${asOf}.json`
  const reportHtmlHref = publicArtifactHref(meta.report_artifact, `docs/a-share-cycle-outlook-${asOf}.html`)
  const reportDataHref = publicArtifactHref(reportDataArtifact, `docs/research-data/a-share-cycle-outlook-${asOf}.json`)
  const preCouncilHref = publicArtifactHref(meta.pre_council_artifact, `docs/research-data/a-share-cycle-outlook-pre-council-${asOf}.json`)
  const expertArtifactHref = publicArtifactHref(meta.expert_run_artifact ?? data.latest_council?.artifact, `docs/research-data/a-share-cycle-expert-runs-${asOf}.json`)
  const marketSnapshotHref = publicArtifactHref(meta.market_snapshot_artifact, `docs/research-data/a-share-cycle-market-snapshot-${asOf}.json`)
  const auditHref = publicArtifactHref(meta.turning_point_audit_artifact, 'docs/turning-point-capability-audit-2026-08-23.html')
  const repositoryHref = isNonEmptyString(meta.repository_url) ? meta.repository_url : 'https://github.com/hancao97/hanai-investment-dsh'
  const latestRound = isNonEmptyString(data.latest_council?.round) ? data.latest_council.round : '最新事实复核'
  const themeMethodology = isNonEmptyString(data.theme_scoring?.methodology)
    ? data.theme_scoring.methodology
    : '主题等级表示证据强度，不是收益概率或仓位。'
  const themeExecutionSeparation = isNonEmptyString(data.theme_scoring?.execution_separation)
    ? data.theme_scoring.execution_separation
    : '主题评级与股票执行门禁彼此独立。'
  const stocks = data.stocks as Json[]
  const stockDecisionSummary = decisionSummary(stocks)
  const executableCount = stocks.filter(stock => EXECUTION_TIER_SET.has(effectiveStockDecision(stock))).length
  const primaryStock = stocks.find(stock => effectiveStockDecision(stock) === 'core')
    ?? stocks.find(stock => effectiveStockDecision(stock) === 'satellite')
    ?? stocks.find(stock => effectiveStockDecision(stock) === 'watch' && String(stock.layer).startsWith('WATCH-1'))
    ?? stocks.find(stock => effectiveStockDecision(stock) === 'watch')
    ?? stocks.find(stock => effectiveStockDecision(stock) === 'incomplete')
    ?? stocks.find(stock => effectiveStockDecision(stock) === 'reject')
  const primaryDecision = primaryStock ? effectiveStockDecision(primaryStock) : undefined
  const primaryDecisionCopy = primaryDecision && EXECUTION_TIER_SET.has(primaryDecision)
    ? `六门全部 PASS，当前执行层级为 ${primaryDecision.toUpperCase()}；仍须按预设监控开关持续复核。`
    : `当前为 ${primaryDecision?.toUpperCase() ?? '无候选'}；OPEN、WATCH 或 FAIL 任一未解除，都不能进入 CORE / SATELLITE。`
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
  <nav class="site-nav" aria-label="研究站点导航"><div class="site-nav-inner"><a class="site-brand" href="./">Hanai Worth · 值见</a><a class="site-link" href="${esc(auditHref)}">变盘点审计</a><a class="site-link" href="${esc(reportHtmlHref)}" aria-current="page">A股周期展望</a><a class="site-link" href="${esc(repositoryHref)}" target="_blank" rel="noreferrer">GitHub ↗</a></div></nav>
  <div class="page">
  <header class="hero"><div class="hero-inner"><div class="eyebrow">Hanai research memo · evidence-gated outlook</div><h1>A股未来一年，<br>让假设先接受<em>数据审判</em></h1><p class="hero-lead">五个系统专家 Skill 以隔离上下文生成首轮观点，再围绕同一份可核验事实交叉质询。最终只保留能够写出数据阈值、复核日期和退出动作的研究假设。</p><div class="hero-grid"><div class="hero-cell"><span>观察窗口</span><strong>${esc(meta.forecast_start)} → ${esc(meta.forecast_end)}</strong></div><div class="hero-cell"><span>主情景排序</span><strong>${esc(mainScenario.name)}</strong></div><div class="hero-cell"><span>门禁结果</span><strong>${esc(stockDecisionSummary)}</strong></div><div class="hero-cell"><span>事实截止</span><strong>${esc(meta.market_data_cutoff)}</strong></div></div><div class="hero-disclaimer">⚠ ${esc(meta.expert_disclosure)} ${esc(meta.investment_boundary)} ${esc(meta.probability_semantics)} 报告严格使用截至 ${esc(meta.market_data_cutoff)} 的冻结截面，缺失字段不作插值。</div></div></header>
  <div class="layout">
    <aside class="toc"><p class="toc-title">目录</p><a href="#verdict">01 执行结论</a><a href="#method">02 五角色方法</a><a href="#evidence">03 宏观证据</a><a href="#scenarios">04 周期与情景</a><a href="#themes">05 待验证主题</a><a href="#stocks">06 个股观察池</a><a href="#gates">07 观点门禁</a><a href="#council">08 会商摘要</a><a href="#monitor">09 月度开关</a><a href="#sources">10 来源与限制</a><div class="actions"><button class="btn" type="button" onclick="window.print()">打印</button><button class="btn" type="button" id="top-button">顶部</button></div></aside>
    <main class="content">
      <section class="section" id="verdict">${sectionHeader(1, 'Decision memo', '主情景是结构分化，执行层级由六门共同决定', '截至已披露数据，工业和高技术制造强于商品消费与地产，利润改善又高度集中。这里追求的是研究可复核性，而不是用多个题材制造虚假的确定性。')}<div class="verdict"><div><h3>${esc(data.verdict.headline)}</h3><p>${esc(data.verdict.summary)}</p></div><div class="verdict-side"><span>当前门禁排序最靠前对象</span><strong>${esc(primaryStock ? `${primaryStock.symbol} ${primaryStock.name}` : '无')}</strong><small>${esc(primaryDecisionCopy)}</small></div></div></section>
      <section class="section" id="method">${sectionHeader(2, 'Council protocol', '五个同源 AI 方法论角色，两轮会商加最新事实复核', `系统实际调用仓库中的五个专家 Skill。首轮做提示与上下文隔离；第二轮要求点名反驳、接受一条批评、重做评级并提交能淘汰自身偏好的门禁；${latestRound}再用同一份冻结事实包复核。相关真人均未参与、审核或背书。`)}<div class="process"><article><span>01</span><strong>隔离首轮</strong><p>周期、情景、题材、股票、反方问题。</p></article><article><span>02</span><strong>事实清洗</strong><p>关键结论回到官方、发行人披露与冻结市场截面。</p></article><article><span>03</span><strong>匿名质询</strong><p>反驳机制、接受修订、主题与个股重新投票。</p></article><article><span>04</span><strong>最新事实复核</strong><p>${esc(latestRound)}完成后按机械门禁归类。</p></article></div><div class="hard-fail"><b>统计边界：</b>${esc(meta.expert_method)} 因此“五票”只记录同源模型在不同提示下的输出分布，不是五个独立预测样本。</div></section>
      <section class="section" id="evidence">${sectionHeader(3, 'Evidence pulse', '供给较强、住房与商品需求偏弱；信用结构仍待补证', '当前事实支持的是一个状态描述，而不是未来一年必然路径：生产和部分新动能较强，商品消费和房地产偏弱，财政土地收入承压；私人信用分项尚未进入证据层。')}${macroGrid(data, sources)}</section>
      <section class="section" id="scenarios">${sectionHeader(4, 'Scenario map', '不展示伪精确概率，只保留互斥状态机', '本期把三个情景排序为主情景、备选情景和压力情景，不给未经历史校准的概率。未来按六项开关的预设阈值机械分类，并冻结每次更新。')}${scenarioSection(data, sources)}<h3 style="margin-top:44px">四个预定复核窗口</h3>${cycleTimeline(data)}</section>
      <section class="section" id="themes">${sectionHeader(5, 'Theme radar', '待验证的是产业链现金流，不是题材名字', `${themeMethodology} ${themeExecutionSeparation} 每张卡同时公开总分、五维拆分、评分解释与委员会票源。`)}${themeCards(data, sources)}</section>
      <section class="section" id="stocks">${sectionHeader(6, 'Quality watchlist', `${stockDecisionSummary}；${executableCount} 个可执行候选`, '“相对稳健”只表示商业与财务证据较易解释，不代表股价低波动。FAIL 直接 REJECT；OPEN 标记 INCOMPLETE；仅剩 WATCH 则留在待补证研究池；六门全 PASS 后才按 CORE / SATELLITE 分层。')}<div class="hard-fail"><b>估值判据：</b>${esc(data.valuation_framework?.methodology ?? '估值按冻结截面审查。')} ${esc(data.valuation_framework?.disclosure ?? '')}</div>${stockCards(data, sources)}</section>
      <section class="section" id="gates">${sectionHeader(7, 'Falsifiable gates', '观点必须允许自己被淘汰', '门禁把“好公司”“好行业”“好价格”拆开。任何一个标签都不能替代现金流与估值；通过五票也不能越过未完成的估值门。')}${gateMatrix(data)}</section>
      <section class="section" id="council">${sectionHeader(8, 'Structured council digest', '结构化保留分歧、反驳与修订', `${String(meta.committee_vote_snapshot)} 下方Round 1/2是结构化历史摘要，不是逐字转录；${latestRound}公开原始输出、冻结事实包、提示词哈希与Skill哈希。所有姓名均指 AI 方法论角色，相关真人未参与或背书。`)}${latestCouncil(data)}${expertCouncil(data)}</section>
      <section class="section" id="monitor">${sectionHeader(9, 'Monthly switches', `未来一年只盯这${(data.monitor_switches as string[]).length}个开关`, '静态预测会过期；这些开关决定情景状态是否切换，也决定主题和个股是升级、降级还是退出。成交、市场宽度、相对强弱与财务质量均按预设复核日重新冻结。')}${monitors(data)}</section>
      <section class="section" id="sources">${sectionHeader(10, 'Sources & limits', `${(data.sources as Json[]).length}项官方 / 发行人 / 行情快照来源、生成血缘与已知限制`, '关键事实回到统计部门、财政货币部门、监管机构、交易所、冻结市场截面或发行人披露；每个衍生产物均保留独立下载入口。')}${sourcesSection(data)}<p class="table-note"><a id="report-json-link" href="${esc(reportDataHref)}" target="_blank" rel="noreferrer">下载结构化报告JSON</a> · <a id="pre-council-link" href="${esc(preCouncilHref)}" target="_blank" rel="noreferrer">下载会商冻结输入</a> · <a id="market-snapshot-link" href="${esc(marketSnapshotHref)}" target="_blank" rel="noreferrer">下载冻结市场快照</a> · <a id="expert-runs-link" href="${esc(expertArtifactHref)}" target="_blank" rel="noreferrer">下载最新会商原始输出与哈希</a></p><h3 style="margin-top:34px">已知限制</h3><ol class="limitations">${(data.limitations as string[]).map(item => `<li>${esc(item)}</li>`).join('')}</ol><div class="provenance">data: ${esc(reportDataArtifact)} · sha256 ${esc(dataHash)} · generated ${esc(generatedAt)} · curated via ${esc(meta.artifact_provenance)} · expert input ${esc(meta.pre_council_sha256 ?? meta.expert_run_input_sha256)} · expert runs ${esc(meta.expert_run_artifact_sha256)} · market snapshot ${esc(meta.market_snapshot_sha256)} · expert Skill snapshot ${esc(meta.expert_snapshot_version)} · runtime ${esc(meta.expert_runtime)}</div></section>
    </main>
  </div>
  </div>
  <footer class="footer"><div class="footer-inner"><p>本报告是可证伪的研究备忘录，不构成投资建议。市场有风险；CORE / SATELLITE / WATCH / REJECT / INCOMPLETE 只表示研究门禁状态，投资者应独立核验最新财报、价格、估值与自身风险承受能力。</p><div><a href="${esc(auditHref)}">变盘点能力审计</a> · <a href="${esc(repositoryHref)}" target="_blank" rel="noreferrer">GitHub</a></div></div></footer>
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
