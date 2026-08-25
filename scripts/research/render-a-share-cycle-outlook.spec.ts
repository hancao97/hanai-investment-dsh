import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

type Json = Record<string, any>

const ROOT = resolve(import.meta.dirname, '../..')
const FIXTURE = resolve(ROOT, 'docs/research-data/a-share-cycle-outlook-2026-08-25.json')
const RENDERER = resolve(ROOT, 'scripts/research/render-a-share-cycle-outlook.ts')
const TSX = resolve(ROOT, 'node_modules/.bin/tsx')
const GATE_IDS = ['fact', 'mechanism', 'quality', 'valuation', 'falsifier', 'council'] as const
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, options?: object) => any }

function supportedFixture(): Json {
  const data = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Json
  data.metadata.as_of = '2026-08-25'
  data.metadata.market_data_cutoff = '2026-08-25'
  data.metadata.report_artifact = 'docs/a-share-cycle-outlook-custom.html'
  data.metadata.report_data_artifact = 'docs/research-data/a-share-cycle-outlook-custom.json'
  data.metadata.market_snapshot_artifact = 'docs/research-data/a-share-cycle-market-snapshot-custom.json'
  data.metadata.expert_run_artifact = 'docs/research-data/a-share-cycle-expert-runs-custom.json'
  data.metadata.turning_point_audit_artifact = 'docs/turning-point-custom.html'
  data.theme_scoring = {
    methodology: '五维证据评分，不是概率。',
    execution_separation: '主题评级与个股门禁相互独立。',
    components: [
      { id: 'demand', name: '需求可见度', rule: '需求规则' },
      { id: 'earnings', name: '盈利验证', rule: '盈利规则' },
      { id: 'cash', name: '现金质量', rule: '现金规则' },
      { id: 'valuation', name: '估值余量', rule: '估值规则' },
      { id: 'market', name: '市场确认', rule: '市场规则' },
    ],
    grades: [
      { grade: 'A', min: 85, meaning: '强验证。' },
      { grade: 'A-', min: 80, meaning: '强证据但仍有缺口。' },
      { grade: 'B+', min: 75, meaning: '优先跟踪。' },
      { grade: 'B', min: 70, meaning: '条件性证据。' },
      { grade: 'B-', min: 60, meaning: '明显缺口。' },
      { grade: 'C', min: 0, meaning: '影子研究或反证占优。' },
    ],
  }
  const grades = ['A', 'A-', 'B+', 'B', 'B-', 'C']
  const scores = [85, 80, 75, 70, 60, 40]
  data.themes.forEach((theme: Json, index: number) => {
    theme.grade = grades[index]
    theme.score = scores[index]
    const componentScore = scores[index]! / 5
    theme.score_components = { demand: componentScore, earnings: componentScore, cash: componentScore, valuation: componentScore, market: componentScore }
    theme.score_summary = `${theme.name} 的五维评分解释。`
  })

  const decisions = ['core', 'satellite', 'watch', 'reject', 'incomplete', 'watch']
  data.stocks.forEach((stock: Json, index: number) => {
    const decision = decisions[index]!
    stock.decision = decision
    delete stock.execution_tier
    stock.latest_committee = { [decision]: 5 }
  })
  delete data.stocks[1].decision
  data.stocks[1].execution_tier = 'satellite'

  data.view_gates.results.forEach((row: Json, index: number) => {
    const decision = decisions[index]!
    for (const gateId of GATE_IDS) row[gateId] = 'pass'
    if (decision === 'watch') row.quality = 'watch'
    if (decision === 'reject') row.fact = 'fail'
    if (decision === 'incomplete') row.valuation = 'open'
    row.decision = decision
    row.action = `${decision.toUpperCase()}；测试动作`
  })
  Object.assign(data.stocks[0].quality_snapshot, { status: 'pass', period: '2026Q1 / 2025A', conclusion: '现金质量通过。', annual: '全年粗FCF覆盖分红。' })
  Object.assign(data.stocks[0].valuation_snapshot, { status: 'watch', date: '2026-08-25', conclusion: '估值处于观察带。' })
  data.stocks[0].technical_snapshot = {
    date: '2026-08-25',
    conditional_history: [
      { horizon_trading_days: 20, non_overlapping_observations: 14, positive_rate: 0.6429, positive_rate_wilson95: [0.3876, 0.8366], outperform_rate: 0.4286, outperform_rate_wilson95: [0.2138, 0.6741], mean_return: 0.0101, mean_excess_return: -0.0113, semantics: '描述性统计，不是未来保证。' },
      { horizon_trading_days: 60, non_overlapping_observations: 8, positive_rate: 0.75, positive_rate_wilson95: [0.4093, 0.9285], outperform_rate: 0.625, outperform_rate_wilson95: [0.3057, 0.8632], mean_return: 0.0448, mean_excess_return: 0.0289, semantics: '描述性统计，不是未来保证。' },
    ],
  }
  data.latest_council.theme_results.forEach((row: Json) => { row.pass = 0 })
  data.latest_council.stock_results.forEach((row: Json, index: number) => {
    Object.assign(row, { core: index === 0 ? 5 : 0, satellite: 0, incomplete: 0, decision: decisions[index], council_vote: { pass: 3, watch: 2, reject: 0 } })
  })
  return data
}

function renderFixture(data: Json): { result: ReturnType<typeof spawnSync>; html: string } {
  const tempRoot = mkdtempSync(resolve(tmpdir(), 'hanai-outlook-'))
  const input = resolve(tempRoot, 'input.json')
  const output = resolve(tempRoot, 'report.html')
  writeFileSync(input, JSON.stringify(data))
  const result = spawnSync(TSX, [RENDERER, '--input', input, '--output', output], { cwd: ROOT, encoding: 'utf8' })
  let html = ''
  try {
    if (result.status === 0) html = readFileSync(output, 'utf8')
  } finally {
    rmSync(tempRoot, { recursive: true })
  }
  return { result, html }
}

describe('A-share cycle outlook report shell', () => {
  it('renders the shared visual system and every supported grade and decision', () => {
    const { result, html } = renderFixture(supportedFixture())

    expect(result.status, String(result.stderr)).toBe(0)
    const dom = new JSDOM(html, { pretendToBeVisual: true })
    const { document } = dom.window
    const style = document.querySelector('style')?.textContent ?? ''

    expect(style.length).toBeGreaterThan(12_000)
    expect(document.styleSheets[0]?.cssRules.length).toBeGreaterThan(100)
    expect(document.querySelectorAll('.section-head')).toHaveLength(10)
    expect(document.querySelector('.page > .hero + .layout')).not.toBeNull()

    const bodyStyle = dom.window.getComputedStyle(document.body)
    const navStyle = dom.window.getComputedStyle(document.querySelector('.site-nav')!)
    const layoutStyle = dom.window.getComputedStyle(document.querySelector('.layout')!)
    const rules = [...document.styleSheets[0]!.cssRules]
    const heroRule = rules.find(rule => 'selectorText' in rule && rule.selectorText === '.hero') as CSSStyleRule
    const sectionRule = rules.find(rule => 'selectorText' in rule && rule.selectorText === '.section') as CSSStyleRule

    expect(bodyStyle.margin).toBe('0px')
    expect(navStyle.position).toBe('sticky')
    expect(heroRule.style.background).toBe('var(--navy)')
    expect(layoutStyle.display).toBe('grid')
    expect(sectionRule.style.background).toBe('var(--card)')
    expect(sectionRule.style.borderRadius).toBe('var(--radius)')

    expect([...document.querySelectorAll('[data-theme-filter]')].map((node: Element) => node.getAttribute('data-theme-filter'))).toEqual(['all', 'A', 'B', 'C'])
    expect([...document.querySelectorAll('.grade')].map((node: Element) => node.textContent)).toEqual(['A', 'A-', 'B+', 'B', 'B-', 'C'])
    expect([...document.querySelectorAll('.theme-score-total strong')].map((node: Element) => node.textContent)).toEqual(['85', '80', '75', '70', '60', '40'])
    expect(document.querySelectorAll('.theme-component')).toHaveLength(30)
    expect(document.querySelectorAll('.theme-score-summary')).toHaveLength(12)
    expect([...document.querySelectorAll('.theme-score-summary b')].filter((node: Element) => node.textContent === '升级条件：')).toHaveLength(6)
    expect([...document.querySelectorAll('#stock-layer option')].map((node: Element) => node.getAttribute('value'))).toEqual(['all', 'core', 'satellite', 'watch', 'reject', 'incomplete'])
    expect(new Set([...document.querySelectorAll('.stock-card')].map((node: Element) => node.getAttribute('data-layer')))).toEqual(new Set(['core', 'satellite', 'watch', 'reject', 'incomplete']))
    expect(new Set([...document.querySelectorAll('.stock-votes .vote-chip')].map((node: Element) => node.textContent?.replace('5', '')))).toEqual(new Set(['CORE', 'SATELLITE', 'WATCH', 'REJECT', 'INCOMPLETE']))
    expect(document.querySelectorAll('.stock-card .decision-incomplete')).toHaveLength(1)
    expect(document.querySelector('#gates .decision-incomplete')?.textContent).toBe('INCOMPLETE')
    expect(document.querySelectorAll('.stock-audit-card')).toHaveLength(24)
    expect(document.querySelectorAll('.conditional-history tbody tr')).toHaveLength(12)
    expect(document.querySelector('.conditional-history tbody tr')?.textContent).toContain('64.3% · [38.8%, 83.7%]')
    expect(document.querySelector('.conditional-history tbody tr')?.textContent).toContain('42.9% · [21.4%, 67.4%]')
    expect(document.querySelector('.conditional-history tbody tr')?.textContent).toContain('1.0%')
    expect(document.querySelector('#report-json-link')?.getAttribute('href')).toBe('./research-data/a-share-cycle-outlook-custom.json')
    expect(document.querySelector('#pre-council-link')?.getAttribute('href')).toBe('./research-data/a-share-cycle-outlook-pre-council-2026-08-25.json')
    expect(document.querySelector('#market-snapshot-link')?.getAttribute('href')).toBe('./research-data/a-share-cycle-market-snapshot-custom.json')
    expect(document.querySelector('#expert-runs-link')?.getAttribute('href')).toBe('./research-data/a-share-cycle-expert-runs-custom.json')
    expect(document.querySelector('.site-link[aria-current="page"]')?.getAttribute('href')).toBe('./a-share-cycle-outlook-custom.html')
    expect(document.body.textContent).not.toContain('事实层未纳入2026-08-21收盘行情')
    expect(document.body.textContent).not.toContain('A股宽度基线仍待接入')
    expect([...document.querySelectorAll('#council .gate-table')].some((table: Element) => table.textContent?.includes('CORE') && table.textContent?.includes('INCOMPLETE'))).toBe(true)
    expect([...document.querySelectorAll('#council .gate-table')].some((table: Element) => table.textContent?.includes('会商 P/W/R') && table.textContent?.includes('3 / 2 / 0'))).toBe(true)
  })

  it('rejects grades outside the exact A/A-/B+/B/B-/C contract', () => {
    const data = supportedFixture()
    data.themes[0].grade = 'C+'
    const { result } = renderFixture(data)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Invalid theme grade')
  })

  it('rejects latest stock vote totals that do not sum to five across C/S/W/R/I', () => {
    const data = supportedFixture()
    data.stocks[0].latest_committee = { core: 3, satellite: 1, watch: 0, reject: 0, incomplete: 0 }
    const { result } = renderFixture(data)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Invalid committee vote total')
  })

  it.each([
    ['a missing criterion field', (data: Json) => { delete data.view_gates.criteria[0].rule }, 'requires non-empty id, name, and rule'],
    ['a missing stock gate field', (data: Json) => { delete data.view_gates.results[0].fact }, 'Invalid or missing gate status fact'],
    ['an unknown gate status', (data: Json) => { data.view_gates.results[0].fact = 'pending' }, 'Invalid or missing gate status fact'],
    ['a gate-derived decision mismatch', (data: Json) => {
      data.stocks[4].decision = 'watch'
      data.view_gates.results[4].decision = 'watch'
      data.view_gates.results[4].action = 'WATCH；错误动作'
    }, 'statuses require incomplete, received watch'],
    ['an action/decision mismatch', (data: Json) => { data.view_gates.results[0].action = 'WATCH；错误动作' }, 'must start with CORE'],
    ['a missing stock result row', (data: Json) => { data.view_gates.results.pop() }, 'exactly one row for every stock'],
  ])('rejects %s', (_label, mutate, errorText) => {
    const data = supportedFixture()
    mutate(data)
    const { result } = renderFixture(data)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(errorText)
  })
})
