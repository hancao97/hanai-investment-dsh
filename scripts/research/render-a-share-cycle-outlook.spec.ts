import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../..')
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, options?: object) => any }

describe('A-share cycle outlook report shell', () => {
  it('renders the complete shared visual system instead of browser defaults', () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'hanai-outlook-'))
    const output = resolve(tempRoot, 'report.html')
    const result = spawnSync(
      resolve(ROOT, 'node_modules/.bin/tsx'),
      [resolve(ROOT, 'scripts/research/render-a-share-cycle-outlook.ts'), '--output', output],
      { cwd: ROOT, encoding: 'utf8' },
    )

    expect(result.status, result.stderr).toBe(0)
    const html = readFileSync(output, 'utf8')
    rmSync(tempRoot, { recursive: true })
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
  })
})
