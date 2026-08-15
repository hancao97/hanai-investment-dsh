import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
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

function staticPublicationInputs(): string[] {
  const packageFiles = walkFiles(resolve(ROOT, 'packages')).filter((file) => {
    const path = relative(ROOT, file).split('\\').join('/')
    return path.includes('/src/') || path.startsWith('packages/masters/assets/')
  })
  const roots = [
    resolve(ROOT, 'package.json'),
    resolve(ROOT, 'cordis.patch.yml'),
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
})
