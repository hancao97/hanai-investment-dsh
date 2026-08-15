import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './styles.module.css'
import researchStyles from './research-surfaces.module.css'

const CODE_LABELS = {
  copyLabel: '复制代码',
  copiedLabel: '已复制',
} as const

/**
 * Render a settled, model-authored research report through DSH's untrusted
 * Markdown pipeline. The primitive parses GFM without an HTML parser, unwraps
 * relative or unsafe links, and hardens HTTP(S) links for a new tab.
 */
export function MarkdownView({ content }: { content: string }) {
  return (
    <article className={`${styles['markdown']} ${researchStyles['markdownSurface']}`}>
      <MarkdownText text={content} codeLabels={CODE_LABELS} />
    </article>
  )
}
