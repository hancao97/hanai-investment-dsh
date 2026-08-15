/** JSON formatting used by generic tool and forward-compatible event cards. */
export function formatJson(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return ''
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2)
    } catch {
      return value
    }
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Extract readable text from DSH ContentBlock-shaped values. */
export function contentText(blocks: readonly unknown[]): string {
  const output: string[] = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) {
      output.push(String(block))
      continue
    }
    const value = block as Record<string, unknown>
    if ((value.type === 'text' || value.type === 'reasoning') && typeof value.text === 'string') {
      output.push(value.text)
    } else if (value.type === 'image') {
      output.push('[图片]')
    } else if (value.type === 'tool-call') {
      output.push(`[工具调用: ${typeof value.name === 'string' ? value.name : 'unknown'}]`)
    } else if (value.type === 'tool-result' && Array.isArray(value.content)) {
      output.push(contentText(value.content))
    } else {
      output.push(formatJson(value))
    }
  }
  return output.join('\n')
}
