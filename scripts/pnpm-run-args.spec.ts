import { describe, expect, it } from 'vitest'

import { stripPnpmRunSeparator } from './pnpm-run-args.ts'

describe('stripPnpmRunSeparator', () => {
  it('accepts the separator forwarded by pnpm run', () => {
    expect(stripPnpmRunSeparator(['--', '--package', '.'])).toEqual(['--package', '.'])
  })

  it('does not hide a separator in the middle of user arguments', () => {
    expect(stripPnpmRunSeparator(['--package', '.', '--'])).toEqual(['--package', '.', '--'])
  })
})
