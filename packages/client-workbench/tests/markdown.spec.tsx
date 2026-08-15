// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownView } from '../src/markdown.tsx'

afterEach(cleanup)

describe('MarkdownView', () => {
  it('renders research-grade GFM structure and hardens external links', () => {
    const { container } = render(<MarkdownView content={`# 研判结论

[官方文档](https://api.deepseek.com/docs) 与 https://example.com/research?q=hanai

- 估值
  1. PE 区间
  2. PB 区间
- 风险

| 指标 | 当前 | 判断 |
| :-- | --: | :-- |
| PE | 12.3 | 中性 |

> 引用数据仅用于研究。

\`\`\`ts
const alpha = 1
\`\`\``} />)

    expect(screen.getByRole('heading', { level: 1, name: '研判结论' })).toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(container.querySelector('ul ol')).not.toBeNull()
    expect(container.querySelector('blockquote')).toHaveTextContent('引用数据仅用于研究。')
    expect(container.querySelector('pre')).toHaveTextContent('const alpha = 1')

    const namedLink = screen.getByRole('link', { name: '官方文档' })
    expect(namedLink).toHaveAttribute('href', 'https://api.deepseek.com/docs')
    expect(namedLink).toHaveAttribute('target', '_blank')
    expect(namedLink).toHaveAttribute('rel', 'noopener noreferrer')

    const bareLink = screen.getByRole('link', { name: 'https://example.com/research?q=hanai' })
    expect(bareLink).toHaveAttribute('target', '_blank')
    expect(bareLink).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('keeps raw HTML literal and unwraps unsafe or relative destinations', () => {
    const { container } = render(<MarkdownView content={`[danger](javascript:alert(1))

[relative](./private-report)

<img src=x onerror="alert(1)">`} />)

    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    expect(container).toHaveTextContent('<img src=x onerror="alert(1)">')
    expect(container).toHaveTextContent('danger')
    expect(container).toHaveTextContent('relative')
  })
})
