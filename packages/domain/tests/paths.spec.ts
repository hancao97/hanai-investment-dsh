import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HanaiPaths } from '../src/paths.ts'
import { ensureHanaiLayout, resolveHanaiPaths } from '../src/paths.ts'

const sandboxes: string[] = []

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true })
})

function sandbox(): string {
  const value = mkdtempSync(join(tmpdir(), 'hanai-dsh-paths-'))
  sandboxes.push(value)
  return value
}

function directoryLink(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

describe('Hanai data layout isolation', () => {
  it('rejects a data-root symlink before touching its legacy target', () => {
    const fixture = sandbox()
    const legacy = join(fixture, 'legacy')
    const isolated = join(fixture, '.hanai-investment-dsh')
    mkdirSync(legacy)
    directoryLink(legacy, isolated)

    expect(() => ensureHanaiLayout(resolveHanaiPaths(isolated))).toThrow('拒绝使用符号链接')
    expect(readdirSync(legacy)).toEqual([])
    expect(lstatSync(isolated).isSymbolicLink()).toBe(true)
  })

  it.each([
    'databaseDir',
    'cacheDir',
    'marketCacheDir',
    'valuationCacheDir',
    'judgementsDir',
    'exportsDir',
    'tmpDir',
  ] satisfies Array<Exclude<keyof HanaiPaths, 'root' | 'databasePath'>>)(
    'rejects a pre-existing symlink at managed %s before creating sibling directories',
    (key) => {
      const fixture = sandbox()
      const paths = resolveHanaiPaths(join(fixture, 'data'))
      const outside = join(fixture, `outside-${key}`)
      const linked = paths[key]
      mkdirSync(paths.root)
      mkdirSync(dirname(linked), { recursive: true })
      mkdirSync(outside)
      directoryLink(outside, linked)
      const rootEntries = readdirSync(paths.root, { recursive: true }).sort()

      expect(() => ensureHanaiLayout(paths)).toThrow('拒绝使用符号链接')
      expect(readdirSync(paths.root, { recursive: true }).sort()).toEqual(rootEntries)
      expect(readdirSync(outside)).toEqual([])
      expect(lstatSync(linked).isSymbolicLink()).toBe(true)
    },
  )

  it('creates every managed directory normally and accepts an ordinary restart', () => {
    const fixture = sandbox()
    const paths = resolveHanaiPaths(join(fixture, 'data'))
    const managed = [
      paths.root,
      paths.databaseDir,
      paths.cacheDir,
      paths.marketCacheDir,
      paths.valuationCacheDir,
      paths.judgementsDir,
      paths.exportsDir,
      paths.tmpDir,
    ]

    ensureHanaiLayout(paths)
    expect(managed.every(path => existsSync(path) && lstatSync(path).isDirectory())).toBe(true)
    expect(managed.every(path => !lstatSync(path).isSymbolicLink())).toBe(true)

    expect(() => ensureHanaiLayout(paths)).not.toThrow()
    expect(managed.every(path => existsSync(path) && lstatSync(path).isDirectory())).toBe(true)
  })
})
