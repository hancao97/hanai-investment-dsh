import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { stripPnpmRunSeparator } from './pnpm-run-args.ts'
import {
  assertComposedLayers,
  assertProfileContract,
  assertRuntimeIdentity,
  assertSafeProfileManifest,
  manifestPathFor,
  normalizeProfileManifest,
  profileDirForManifest,
  readManifest,
  writeManifestAtomic,
} from './profile-contract.ts'

interface Options {
  dshBin: string
  profile: string
  packageSpec: string
}

const options = parse(stripPnpmRunSeparator(process.argv.slice(2)))
assertSafeExistingProfile(options.profile)
const dshVersion = commandOutput(options.dshBin, ['--version']).match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0]
if (dshVersion === undefined) throw new Error('无法从 dsh --version 识别版本')

console.log(`Creating or migrating isolated DSH profile ${options.profile} with DSH ${dshVersion}…`)
// The released package and source-install flow are built before this script
// runs. Skipping lifecycle scripts avoids pnpm rebuilding the linked package.
run(options.dshBin, [
  'plugin',
  '--profile',
  options.profile,
  'add',
  '--ignore-scripts',
  '--workspace-root',
  options.packageSpec,
])

const profileManifestPath = resolveProfileManifestPath(options.profile)
const installedManifest = readManifest(profileManifestPath)
assertSafeProfileManifest(installedManifest, options.profile)
const normalizedManifest = normalizeProfileManifest(installedManifest)
writeManifestAtomic(profileManifestPath, normalizedManifest)

// DSH resolves in-box bundles from its own installation first. Keeping the Web
// app in dsh.profile.bundles while removing it from dependencies prevents a
// profile-local dsh-tools copy from shadowing the agent loop's service symbols.
run(options.dshBin, [
  'plugin',
  '--profile',
  options.profile,
  'install',
  '--ignore-scripts',
  '--workspace-root',
])

const finalManifest = readManifest(profileManifestPath)
assertProfileContract(finalManifest, options.profile)
const composed = commandOutput(options.dshBin, ['--profile', options.profile, '--dump-default-config'])
assertComposedLayers(composed)
// Profile boot heals DSH's installation-owned parent module fallback. Resolve
// identity only after the config dump has exercised that boot preparation.
assertRuntimeIdentity(profileDirForManifest(profileManifestPath))
console.log(`\nProfile ready. Start Hanai with:\n  dsh --profile ${options.profile}\n\nThe stock UI remains available with:\n  dsh web`)

function parse(args: string[]): Options {
  let profile = 'hanai-investment'
  let packageSpec = resolve('.')
  let dshBin = 'dsh'
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index]
    if (current === '--profile') profile = requiredValue(args, ++index, current)
    else if (current === '--package') packageSpec = requiredValue(args, ++index, current)
    else if (current === '--dsh-bin') dshBin = requiredValue(args, ++index, current)
    else throw new Error(`未知参数：${current}`)
  }
  if (!/^[A-Za-z0-9._-]+$/.test(profile)) throw new Error('profile 名称只能包含字母、数字、点、下划线或连字符')
  if (['web', 'headless', 'node_modules', '.', '..'].includes(profile.toLowerCase())) {
    throw new Error(`拒绝修改保留 profile：${profile}；请使用独立名称（默认 hanai-investment）`)
  }
  return { dshBin, profile, packageSpec }
}

function assertSafeExistingProfile(profile: string): void {
  const manifestPath = resolveProfileManifestPath(profile)
  if (!existsSync(manifestPath)) return
  assertSafeProfileManifest(readManifest(manifestPath), profile)
}

function resolveProfileManifestPath(profile: string): string {
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return manifestPathFor(dshHome, profile)
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index]
  if (value === undefined || value === '') throw new Error(`${flag} 缺少值`)
  return value
}

function commandOutput(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败：${result.stderr.trim()}`)
  return `${result.stdout}\n${result.stderr}`.trim()
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败（exit ${String(result.status)}）`)
}
