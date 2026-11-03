import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { npmDryRunFiles, parseNpmPackFiles, verifyClientBundle, verifyManifest, verifyPackedArtifacts, verifyPublicationPaths } from './verify-package.ts'
import { spawnSyncShell } from './win-spawn.ts'

/** Keep production dependencies and plugin helpers; never run build hooks on install. */
export function productionManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const { devDependencies: _dev, packageManager: _manager, scripts: _scripts, ...production } = manifest
  const scripts = manifest.scripts as Record<string, unknown> | undefined
  return { ...production, scripts: { 'profile:install': scripts?.['profile:install'], 'profile:verify': scripts?.['profile:verify'] } }
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
  verifyManifest(manifest)
  const files = npmDryRunFiles()
  verifyClientBundle(join(root, 'lib/client.js'))
  verifyPackedArtifacts(files)
  const temporaryRoot = resolve(tmpdir())
  const staging = mkdtempSync(join(temporaryRoot, 'hanai-plugin-pack-'))
  if (dirname(staging) !== temporaryRoot) throw new Error('Unexpected staging path')
  try {
    for (const file of files) {
      const source = join(root, file)
      if (!lstatSync(source).isFile()) throw new Error(`Refusing to package a link or non-file: ${file}`)
      const target = join(staging, file)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(source, target)
    }
    writeFileSync(join(staging, 'package.json'), `${JSON.stringify(productionManifest(manifest), null, 2)}\n`)
    const destination = join(root, 'dist')
    mkdirSync(destination, { recursive: true })
    const result = spawnSyncShell(process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['pack', '--ignore-scripts', '--json', '--loglevel', 'notice', '--pack-destination', destination],
      { cwd: staging, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`npm pack failed: ${String(result.stderr)}`)
    const packed = parseNpmPackFiles(String(result.stdout), String(result.stderr))
    verifyPublicationPaths(packed)
    if (!isDeepStrictEqual(packed, [...files].sort())) throw new Error('Packed files differ from the verified release inputs')
    console.log(`Plugin package: ${join(destination, `${String(manifest.name)}-${String(manifest.version)}.tgz`)} (${packed.length} files; no development environment)`)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
