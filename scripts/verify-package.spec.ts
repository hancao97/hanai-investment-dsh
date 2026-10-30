import { expect, it } from 'vitest'
import { parseNpmPackFiles } from './verify-package.ts'

it('reads both npm JSON report formats and the older notice format', () => {
  const item = { files: [{ path: 'lib/index.js' }, { path: 'README.md' }] }
  for (const report of [[item], { 'hanai-investment-dsh': item }]) {
    expect(parseNpmPackFiles(JSON.stringify(report), '')).toEqual(['README.md', 'lib/index.js'])
  }
  expect(parseNpmPackFiles('package.tgz', 'npm notice === Tarball Contents ===\nnpm notice 123B lib/index.js\nnpm notice === Tarball Details ===')).toEqual(['lib/index.js'])
})

it('rejects empty, malformed and duplicate file lists', () => {
  for (const files of [[], [{ path: '' }], [{ path: 'a' }, { path: 'a' }], [null]]) {
    expect(() => parseNpmPackFiles(JSON.stringify([{ files }]), '')).toThrow()
  }
  expect(() => parseNpmPackFiles('package.tgz', '')).toThrow(/file list/)
})
