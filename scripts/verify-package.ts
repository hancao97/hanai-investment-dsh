import { spawnSync } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { runInNewContext } from 'node:vm'

type JsonObject = Record<string, unknown>

interface ClientHandoff {
  factory: (require: (specifier: string) => unknown) => unknown
  id: string
}

const PACKAGE_NAME = 'hanai-investment-dsh'
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const EXPECTED_KEYWORDS = [
  'deepseek',
  'deepseek-harness',
  'dsh-plugin',
  'investment',
  'a-share',
  'agent',
] as const

const EXPECTED_FILES = [
  'lib/**',
  'cordis.patch.yml',
  'packages/masters/assets/**',
  'THIRD_PARTY_NOTICES.md',
  'README.md',
  'LICENSE',
] as const

const EXPECTED_INJECT = [
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-ui-conversation',
] as const

// Keep the forbidden sentinel out of this verifier's own source text. This
// lets repository-wide literal scans distinguish the gate from a violation.
const LEGACY_DATA_DIRECTORY = `.${['hanai', 'investment'].join('-')}`
const LEGACY_DATA_DIRECTORY_PATTERN = new RegExp(
  `${escapeRegExp(LEGACY_DATA_DIRECTORY)}(?!-dsh)`,
)
const PRIVATE_BUILD_PATH_PATTERN = /(?:\/(?:Users|home)\/[^/\s]+\/|[A-Za-z]:\\Users\\[^\\\s]+\\|\/(?:private\/)?tmp\/)/

const REQUIRED_PACKED_FILES = [
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'cordis.patch.yml',
  'lib/client.js',
  'lib/client.js.map',
  'lib/index.d.ts',
  'lib/index.js',
  'lib/index.js.map',
  'lib/install-profile.js',
  'lib/verify-profile.js',
  'package.json',
] as const

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readJsonObject(file: string): JsonObject {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  invariant(isJsonObject(parsed), `${relativeToRoot(file)} must contain a JSON object`)
  return parsed
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expectObject(value: unknown, label: string): JsonObject {
  invariant(isJsonObject(value), `${label} must be an object`)
  return value
}

function expectExact(actual: unknown, expected: unknown, label: string): void {
  invariant(
    isDeepStrictEqual(actual, expected),
    `${label} differs from the publication contract\nexpected: ${format(expected)}\nactual:   ${format(actual)}`,
  )
}

function format(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value)
}

function relativeToRoot(file: string): string {
  return relative(PROJECT_ROOT, file).split('\\').join('/')
}

/** Validate the DSH discovery and npm publication contract in package.json. */
export function verifyManifest(manifest: JsonObject): void {
  expectExact(manifest.name, PACKAGE_NAME, 'package name')
  expectExact(manifest.type, 'module', 'package type')
  expectExact(manifest.main, './lib/index.js', 'package main')
  expectExact(manifest.types, './lib/index.d.ts', 'package types')
  expectExact(manifest.keywords, [...EXPECTED_KEYWORDS], 'package keywords')
  expectExact(manifest.files, [...EXPECTED_FILES], 'package files')

  const exportsMap = expectObject(manifest.exports, 'package exports')
  expectExact(Object.keys(exportsMap).sort(), [
    '.',
    './client',
    './cordis.patch.yml',
    './package.json',
  ].sort(), 'package export keys')
  expectExact(exportsMap['.'], {
    types: './lib/index.d.ts',
    default: './lib/index.js',
  }, 'root export')
  expectExact(exportsMap['./client'], './lib/client.js', 'client export')
  expectExact(exportsMap['./cordis.patch.yml'], './cordis.patch.yml', 'bundle patch export')
  expectExact(exportsMap['./package.json'], './package.json', 'package metadata export')

  const dsh = expectObject(manifest.dsh, 'dsh manifest')
  expectExact(Object.keys(dsh).sort(), ['bundle', 'client'], 'dsh roles')
  expectExact(dsh.bundle, { patch: './cordis.patch.yml' }, 'dsh bundle role')
  expectExact(dsh.client, {
    platform: 'web',
    inject: [...EXPECTED_INJECT],
  }, 'dsh client role')
}

/** Execute a built browser artifact only far enough to capture its lazy handoff. */
export function verifyClientBundle(bundleFile: string): ClientHandoff {
  invariant(existsSync(bundleFile), `${relativeToRoot(bundleFile)} is missing; run the build first`)
  const source = readFileSync(bundleFile, 'utf8')
  invariant(source.trim().length > 0, `${relativeToRoot(bundleFile)} is empty`)
  invariant(
    !/^\s*(?:import|export)\s/m.test(source),
    `${relativeToRoot(bundleFile)} must be a classic CJS-wrapper script, not a native ESM module`,
  )

  const registrations: unknown[] = []
  const windowObject = {
    __ModuleLoader__: {
      load(handoff: unknown): void {
        registrations.push(handoff)
      },
    },
  }

  runInNewContext(source, {
    console,
    window: windowObject,
  }, {
    filename: bundleFile,
    timeout: 2_000,
  })

  invariant(
    registrations.length === 1,
    `${relativeToRoot(bundleFile)} must register exactly one ModuleLoader handoff; got ${registrations.length}`,
  )
  const handoff = registrations[0]
  invariant(isJsonObject(handoff), 'client ModuleLoader handoff must be an object')
  expectExact(Object.keys(handoff).sort(), ['factory', 'id'], 'client ModuleLoader handoff keys')
  expectExact(handoff.id, PACKAGE_NAME, 'client ModuleLoader handoff id')
  invariant(typeof handoff.factory === 'function', 'client ModuleLoader handoff factory must be a function')
  invariant(handoff.factory.length === 1, 'client ModuleLoader factory must accept the injected require function')
  invariant(
    /return\s+module\.exports\s*;/.test(Function.prototype.toString.call(handoff.factory)),
    'client ModuleLoader factory must return module.exports',
  )
  return handoff as unknown as ClientHandoff
}

/** Verify the real npm allowlist, build outputs, source map, and data-root isolation. */
export function verifyPackedArtifacts(packedFiles: readonly string[]): void {
  const packed = new Set(packedFiles)
  for (const required of REQUIRED_PACKED_FILES) {
    invariant(packed.has(required), `npm package is missing required artifact: ${required}`)
    const absolute = resolve(PROJECT_ROOT, ...required.split('/'))
    invariant(
      existsSync(absolute) && readFileSync(absolute).byteLength > 0,
      `required package artifact is missing or empty: ${required}`,
    )
  }

  for (const file of packed) {
    invariant(
      file === 'package.json'
        || file === 'README.md'
        || file === 'LICENSE'
        || file === 'THIRD_PARTY_NOTICES.md'
        || file === 'cordis.patch.yml'
        || file.startsWith('lib/')
        || file.startsWith('packages/masters/assets/'),
      `npm package contains a file outside the publication allowlist: ${file}`,
    )
    invariant(!file.split('/').includes('..'), `npm package contains an unsafe path: ${file}`)
    const absolute = resolve(PROJECT_ROOT, ...file.split('/'))
    invariant(existsSync(absolute), `npm dry-run reported a missing file: ${file}`)
    const source = readFileSync(absolute, 'utf8')
    assertNoLegacyDataDirectory(source, file)
    if (file.startsWith('lib/')) assertNoPrivateBuildPath(source, file)
  }

  const assetRoot = resolve(PROJECT_ROOT, 'packages/masters/assets')
  invariant(existsSync(assetRoot), 'packages/masters/assets is missing')
  const assets = walkFiles(assetRoot).map(relativeToRoot)
  invariant(assets.length > 0, 'packages/masters/assets must contain at least one packaged master asset')
  for (const asset of assets) {
    invariant(packed.has(asset), `master asset is absent from npm package: ${asset}`)
  }

  const libRoot = resolve(PROJECT_ROOT, 'lib')
  for (const artifact of walkFiles(libRoot).map(relativeToRoot)) {
    invariant(packed.has(artifact), `build artifact is absent from npm package: ${artifact}`)
  }

  const sourceMap = readJsonObject(resolve(PROJECT_ROOT, 'lib/client.js.map'))
  expectExact(sourceMap.version, 3, 'client source map version')
  invariant(
    Array.isArray(sourceMap.sources)
      && sourceMap.sources.length > 0
      && sourceMap.sources.every((source) => typeof source === 'string' && source.length > 0),
    'lib/client.js.map must list its sources',
  )
  invariant(
    Array.isArray(sourceMap.sourcesContent)
      && sourceMap.sourcesContent.length === sourceMap.sources.length
      && sourceMap.sourcesContent.every((source) => typeof source === 'string'),
    'lib/client.js.map must embed one sourcesContent entry per source',
  )

  const notices = readFileSync(resolve(PROJECT_ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  for (const marker of [
    'Apache ECharts 5.6.0 — Apache License 2.0',
    'Apache ECharts 5.6.0 — NOTICE',
    'Apache ECharts bundled d3-derived code — BSD 3-Clause',
    'zrender 5.6.1 — BSD 3-Clause',
    'tslib 2.3.0 — ISC-style license',
  ]) {
    invariant(notices.includes(marker), `THIRD_PARTY_NOTICES.md is missing: ${marker}`)
  }
}

function assertNoLegacyDataDirectory(source: string, label: string): void {
  const match = LEGACY_DATA_DIRECTORY_PATTERN.exec(source)
  invariant(
    match === null,
    `${label} contains the legacy data directory literal at offset ${match?.index ?? -1}; published code may name only the isolated -dsh root`,
  )
}

function assertNoPrivateBuildPath(source: string, label: string): void {
  const match = PRIVATE_BUILD_PATH_PATTERN.exec(source)
  invariant(
    match === null,
    `${label} contains a machine-local absolute path at offset ${match?.index ?? -1}`,
  )
}

function walkFiles(root: string): string[] {
  const output: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = resolve(root, entry.name)
    if (entry.isDirectory()) output.push(...walkFiles(absolute))
    else if (entry.isFile()) output.push(absolute)
  }
  return output.sort()
}

function npmDryRunFiles(): string[] {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npm, ['pack', '--dry-run', '--ignore-scripts', '--loglevel', 'notice'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  invariant(result.error === undefined, `failed to start npm pack --dry-run: ${result.error?.message ?? ''}`)
  invariant(
    result.status === 0,
    `npm pack --dry-run failed with status ${result.status ?? 'unknown'}\n${result.stderr.trim()}`,
  )

  // npm 7's `pack --json` prints only the tarball name, while newer npm emits
  // structured JSON. The notice-level Contents block is stable across both
  // and preserves Unicode paths, so parse that actual packlist instead.
  const contentsStart = '=== Tarball Contents ==='
  const contentsEnd = '=== Tarball Details ==='
  const report = result.stderr.includes(contentsStart) ? result.stderr : result.stdout
  const lines = report.split(/\r?\n/)
  const start = lines.findIndex((line) => line.includes(contentsStart))
  const end = lines.findIndex((line, index) => index > start && line.includes(contentsEnd))
  invariant(start >= 0 && end > start, `npm pack --dry-run did not report a Contents block\n${report}`)
  const paths = lines.slice(start + 1, end).flatMap((line) => {
    const match = /^npm notice\s+\S+\s+(.+?)\s*$/.exec(line)
    return match?.[1] === undefined ? [] : [match[1]]
  })
  invariant(paths.length > 0, 'npm pack --dry-run reported an empty package')
  invariant(new Set(paths).size === paths.length, 'npm pack report contains duplicate file paths')
  return paths.sort()
}

export function main(): void {
  const manifest = readJsonObject(resolve(PROJECT_ROOT, 'package.json'))
  verifyManifest(manifest)
  const packedFiles = npmDryRunFiles()
  // npm 7 may run prepare despite --ignore-scripts, so inspect the artifact
  // after the dry-run and prove the exact bytes the packlist just selected.
  verifyClientBundle(resolve(PROJECT_ROOT, 'lib/client.js'))
  verifyPackedArtifacts(packedFiles)
  console.log(`verify-package: ${packedFiles.length} packed files conform`)
}

const invokedFile = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedFile === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error('verify-package failed:')
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
