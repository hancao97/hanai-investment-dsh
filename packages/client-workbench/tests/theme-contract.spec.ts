import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

const shellCss = source('packages/client-workbench/src/styles.module.css')
const chatCss = source('packages/client-chat/src/ChatPanel.module.css')
const researchCss = source('packages/client-workbench/src/research-surfaces.module.css')

describe('workbench theme contract', () => {
  it('provides the complete legacy Hanai token bridge for shared surfaces', () => {
    const aliases: Record<string, string> = {
      '--hanai-bg': '--bg',
      '--hanai-bg-soft': '--bg-soft',
      '--hanai-panel': '--panel-glass',
      '--hanai-panel-solid': '--panel',
      '--hanai-panel-soft': '--panel-soft',
      '--hanai-panel-hover': '--hover',
      '--hanai-text': '--text',
      '--hanai-muted': '--muted',
      '--hanai-faint': '--faint',
      '--hanai-primary': '--primary',
      '--hanai-primary-rgb': '--primary-rgb',
      '--hanai-primary-strong': '--primary-strong',
      '--hanai-primary-soft': '--gold-soft',
      '--hanai-on-primary': '--on-primary',
      '--hanai-border': '--border',
      '--hanai-border-strong': '--border-strong',
      '--hanai-up': '--up',
      '--hanai-up-soft': '--up-soft',
      '--hanai-down': '--down',
      '--hanai-down-soft': '--down-soft',
      '--hanai-gold': '--gold',
      '--hanai-gold-strong': '--gold-strong',
      '--hanai-gold-soft': '--gold-soft',
      '--hanai-shadow': '--shadow',
    }

    for (const [alias, target] of Object.entries(aliases)) {
      expect(shellCss).toContain(`${alias}: var(${target});`)
    }

    expect(shellCss).toContain('--primary-rgb: 224, 179, 76;')
    const lightTheme = shellCss.match(/\.app\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/)?.[1]
    expect(lightTheme).toBeDefined()
    expect(lightTheme).toContain('--primary-rgb: 142, 97, 14;')
    expect(lightTheme).toContain('--on-primary: #fff;')
    expect(lightTheme).toContain('color-scheme: light;')
  })

  it('lets the chat surface inherit the host color scheme and themed foreground', () => {
    expect(chatCss).toContain('color-scheme: inherit;')
    expect(chatCss).not.toMatch(/color-scheme:\s*dark/)
    expect(chatCss).toContain('--chat-on-accent: var(--hanai-on-primary, #07111f);')
    expect(chatCss).toContain('--chat-ink: var(--hanai-text, #edf5ff);')
    expect(chatCss).toContain('--chat-surface: var(--hanai-panel-solid, #0e1d30);')
  })

  it('keeps report links, tables, and code blocks on semantic theme tokens', () => {
    expect(researchCss).toMatch(/\.markdownSurface\s*\{[^}]*color: var\(--hanai-text\)/s)
    expect(researchCss).toMatch(/\.markdownSurface\s*\{[^}]*--dsw-alias-label-primary: var\(--hanai-text\)/s)
    expect(researchCss).toMatch(/\.markdownSurface\s*\{[^}]*--dsw-alias-label-secondary: var\(--hanai-muted\)/s)
    expect(researchCss).toMatch(/\.markdownSurface\s*\{[^}]*--dsw-alias-label-caption: var\(--hanai-faint\)/s)
    expect(researchCss).toMatch(/\.markdownSurface\s*\{[^}]*--dsw-alias-state-business-primary: var\(--hanai-primary\)/s)
    expect(researchCss).toMatch(/\.markdownSurface\s*\{[^}]*--dsw-alias-markdown-inline-code: var\(--hanai-bg-soft\)/s)
    expect(researchCss).toMatch(/:global\(\[data-theme='light'\]\) \.markdownSurface\s*\{[^}]*--shiki-token-comment: #667085/s)
    expect(researchCss).toMatch(/\.markdownSurface a\s*\{[^}]*color: var\(--hanai-primary\)/s)
    expect(researchCss).toMatch(/\.markdownSurface table\s*\{[^}]*overflow-x: auto/s)
    expect(researchCss).toContain('background: rgba(var(--hanai-primary-rgb), .06);')
    expect(researchCss).toMatch(/:global\(\.md-code-block\)\s*\{[^}]*color: var\(--hanai-text\)/s)
    expect(researchCss).toMatch(/:global\(\.md-code-block\) pre\s*\{[^}]*overflow: auto/s)
  })
})
