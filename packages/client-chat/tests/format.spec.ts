import { describe, expect, it } from 'vitest'
import { contentText, formatJson } from '../src/format.ts'

describe('chat formatting', () => {
  it('pretty prints JSON while preserving ordinary strings', () => {
    expect(formatJson('{"code":"600519","price":1688}')).toBe(`{\n  "code": "600519",\n  "price": 1688\n}`)
    expect(formatJson('not-json')).toBe('not-json')
  })

  it('extracts readable text from nested content blocks', () => {
    expect(contentText([
      { type: 'text', text: '护城河仍在' },
      { type: 'image', attachment: {} },
      { type: 'tool-result', content: [{ type: 'text', text: '现金流改善' }] },
    ])).toBe('护城河仍在\n[图片]\n现金流改善')
  })
})
