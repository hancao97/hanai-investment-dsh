import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
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
    <article className={researchStyles['markdownSurface']}>
      <MarkdownText text={normalizeReportMarkdown(content)} codeLabels={CODE_LABELS} />
    </article>
  )
}

/**
 * Older model-authored reports sometimes append a full-width Chinese date
 * annotation directly to a URL. GFM linkification then treats the annotation
 * as part of the destination. Repair only that unambiguous boundary while
 * keeping the visible annotation in the report.
 */
export function normalizeReportMarkdown(content: string): string {
  return content
    .replace(/\[([^\]]+)]\((https?:\/\/[^\s)（]+)(（[^）\n]{1,40}）)\)/gi, '[$1]($2)$3')
    .replace(/(https?:\/\/[^\s<>"'`（]+)(（[^）\n]{1,40}）)/gi, '$1 $2')
}
