import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

type JsonObject = Record<string, unknown>

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as JsonObject

const EXPECTED_KEYWORDS = [
  'deepseek',
  'deepseek-harness',
  'dsh-plugin',
  'investment',
  'a-share',
  'agent',
]

const EXPECTED_FILES = [
  'lib/**',
  'cordis.patch.yml',
  'packages/masters/assets/**',
  'THIRD_PARTY_NOTICES.md',
  'README.md',
  'LICENSE',
]

const EXPECTED_CLIENT_INJECT = [
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-ui-conversation',
]

const LEGACY_DATA_DIRECTORY = `.${['hanai', 'investment'].join('-')}`
const LEGACY_DATA_DIRECTORY_PATTERN = new RegExp(
  `${escapeRegExp(LEGACY_DATA_DIRECTORY)}(?!-dsh)`,
)
const PRIVATE_REPOSITORY_PATH_PATTERN = /(?:\/(?:Users|home)\/[^/\s`"'<>]+\/|[A-Za-z]:\\Users\\[^\\\s`"'<>]+\\)/
const REPOSITORY_TEXT_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
])
const REPOSITORY_SCAN_EXCLUDES = new Set([
  '.git',
  'coverage',
  'lib',
  'node_modules',
])
const MAX_DOCUMENTATION_IMAGE_BYTES = 1_000_000

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const output: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = resolve(root, entry.name)
    if (entry.isDirectory()) output.push(...walkFiles(absolute))
    else if (entry.isFile()) output.push(absolute)
  }
  return output.sort()
}

function repositoryTextInputs(root = ROOT): string[] {
  const output: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (REPOSITORY_SCAN_EXCLUDES.has(entry.name)) continue
    const absolute = resolve(root, entry.name)
    if (entry.isDirectory()) output.push(...repositoryTextInputs(absolute))
    else if (entry.isFile() && REPOSITORY_TEXT_EXTENSIONS.has(extname(entry.name))) {
      output.push(absolute)
    }
  }
  return output.sort()
}

function staticPublicationInputs(): string[] {
  const packageFiles = walkFiles(resolve(ROOT, 'packages')).filter((file) => {
    const path = relative(ROOT, file).split('\\').join('/')
    return path.includes('/src/') || path.startsWith('packages/masters/assets/')
  })
  const roots = [
    resolve(ROOT, 'package.json'),
    resolve(ROOT, 'cordis.patch.yml'),
    resolve(ROOT, 'THIRD_PARTY_NOTICES.md'),
    resolve(ROOT, 'README.md'),
    resolve(ROOT, 'LICENSE'),
  ].filter(existsSync)
  return [...roots, ...packageFiles, ...walkFiles(resolve(ROOT, 'tooling'))]
}

describe('npm and DSH package manifest', () => {
  it('has the canonical plugin identity and discovery keywords', () => {
    expect(manifest.name).toBe('hanai-investment-dsh')
    expect(manifest.type).toBe('module')
    expect(manifest.main).toBe('./lib/index.js')
    expect(manifest.types).toBe('./lib/index.d.ts')
    expect(manifest.keywords).toEqual(EXPECTED_KEYWORDS)

    const keywords = manifest.keywords as string[]
    expect(new Set(keywords).size).toBe(keywords.length)
    expect(keywords.every((keyword) => keyword === keyword.trim().toLowerCase())).toBe(true)
  })

  it('publishes only the host, client, patch, master assets, and package metadata surfaces', () => {
    expect(manifest.exports).toEqual({
      '.': {
        types: './lib/index.d.ts',
        default: './lib/index.js',
      },
      './client': './lib/client.js',
      './cordis.patch.yml': './cordis.patch.yml',
      './package.json': './package.json',
    })
    expect(manifest.files).toEqual(EXPECTED_FILES)
  })

  it('declares both the bundle and lazy web-client DSH roles', () => {
    expect(manifest.dsh).toEqual({
      bundle: {
        patch: './cordis.patch.yml',
      },
      client: {
        platform: 'web',
        inject: EXPECTED_CLIENT_INJECT,
      },
    })
    expect((manifest.dsh as { client: JsonObject }).client).not.toHaveProperty('immediately')
  })

  it('publishes complete notices for dependencies bundled into the client', () => {
    const notices = readFileSync(resolve(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8')
    expect(notices).toContain('Apache ECharts 5.6.0 — Apache License 2.0')
    expect(notices).toContain('Apache ECharts 5.6.0 — NOTICE')
    expect(notices).toContain('Apache ECharts bundled d3-derived code — BSD 3-Clause')
    expect(notices).toContain('zrender 5.6.1 — BSD 3-Clause')
    expect(notices).toContain('tslib 2.3.0 — ISC-style license')
    expect(notices).toContain('Copyright 2010-2016 Mike Bostock')
    expect(notices).toContain('Copyright (c) 2017, Baidu Inc.')
    expect(notices).toContain('Copyright (c) Microsoft Corporation.')
  })

  it('declares the DSH default-model owner used by the Host bridge', () => {
    const peerDependencies = manifest.peerDependencies as JsonObject
    const devDependencies = manifest.devDependencies as JsonObject
    expect(peerDependencies['@deepseek-ai/dsh-agent-default-model']).toBe('>=0.1.0-rc.5 <0.2.0')
    expect(devDependencies['@deepseek-ai/dsh-agent-default-model']).toBe('0.1.0-rc.6')
  })

  it('does not ship runtime/config source that names the legacy data directory', () => {
    const violations = staticPublicationInputs().flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      const match = LEGACY_DATA_DIRECTORY_PATTERN.exec(source)
      if (match === null) return []
      const line = source.slice(0, match.index).split('\n').length
      return [`${relative(ROOT, file).split('\\').join('/')}:${line}`]
    })
    expect(violations).toEqual([])
  })

  it('does not commit machine-local absolute paths in repository text', () => {
    const violations = repositoryTextInputs().flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      const match = PRIVATE_REPOSITORY_PATH_PATTERN.exec(source)
      if (match === null) return []
      const line = source.slice(0, match.index).split('\n').length
      return [`${relative(ROOT, file).split('\\').join('/')}:${line}`]
    })
    expect(violations).toEqual([])
  })

  it('keeps documentation raster images below one megabyte', () => {
    const violations = walkFiles(resolve(ROOT, 'docs/assets'))
      .filter(file => /\.(?:jpe?g|png|webp)$/i.test(file))
      .filter(file => statSync(file).size >= MAX_DOCUMENTATION_IMAGE_BYTES)
      .map(file => `${relative(ROOT, file).split('\\').join('/')}:${statSync(file).size}`)
    expect(violations).toEqual([])
  })
})
