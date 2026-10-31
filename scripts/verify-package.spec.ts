import { expect, it } from 'vitest'
import { parseNpmPackFiles, verifyPublicationPaths } from './verify-package.ts'

it('reads both npm JSON report formats and the older notice format', () => {
  const item = { files: [{ path: 'lib/index.js' }, { path: 'README.md' }] }
  for (const report of [[item], { 'hanai-investment-dsh': item }]) {
    expect(parseNpmPackFiles(JSON.stringify(report), '')).toEqual(['README.md', 'lib/index.js'])
  }
  expect(parseNpmPackFiles('package.tgz', 'npm notice === Tarball Contents ===\nnpm notice 123B lib/index.js\nnpm notice === Tarball Details ===')).toEqual(['lib/index.js'])
})

it('rejects development files even inside an allowed output or asset directory', () => {
  for (const file of ['node_modules/zod/index.js', 'lib/node_modules/zrender/index.js', 'lib/.pnpm/lock.yaml', 'lib/.env', 'lib/.env.local', 'lib/.npmrc', 'packages/masters/assets/.git/config', 'lib/pnpm-workspace.yaml', 'lib/../package.json', '/lib/index.js', 'lib\\index.js']) {
    expect(() => verifyPublicationPaths([file]), file).toThrow()
  }
  expect(() => verifyPublicationPaths(['lib/index.js', 'lib/client.js.map', 'packages/masters/assets/expert/scripts/check.py', 'package.json'])).not.toThrow()
})

it('rejects empty, malformed and duplicate file lists', () => {
  for (const files of [[], [{ path: '' }], [{ path: 'a' }, { path: 'a' }], [null]]) {
    expect(() => parseNpmPackFiles(JSON.stringify([{ files }]), '')).toThrow()
  }
  expect(() => parseNpmPackFiles('package.tgz', '')).toThrow(/file list/)
})
