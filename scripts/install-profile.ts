import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSyncShell } from './win-spawn.ts'
import { stripPnpmRunSeparator } from './pnpm-run-args.ts'
import {
  assertComposedLayers,
  assertDshVersion,
  assertProfileContract,
  assertRuntimeIdentity,
  assertSafeProfileManifest,
  manifestPathFor,
  profileDirForManifest,
  readManifest,
} from './profile-contract.ts'

interface Options {
  dshBin: string
  profile: string
  packageSpec: string
}

const options = parse(stripPnpmRunSeparator(process.argv.slice(2)))
assertSafeExistingProfile(options.profile)
const dshVersion = assertDshVersion(commandOutput(options.dshBin, ['--version']))
const existingManifest = resolveProfileManifestPath(options.profile)
if (existsSync(existingManifest)) await assertRuntimeIdentity(profileDirForManifest(existingManifest), options.dshBin)

console.log(`Installing Hanai into Web DSH profile ${options.profile} with DSH ${dshVersion}…`)
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
const finalManifest = readManifest(profileManifestPath)
assertProfileContract(finalManifest, options.profile)
const composed = commandOutput(options.dshBin, ['--profile', options.profile, '--dump-default-config'])
assertComposedLayers(composed)
await assertRuntimeIdentity(profileDirForManifest(profileManifestPath), options.dshBin)
console.log(`\nPlugin ready. Start DSH and open 值见 from its sidebar:\n  dsh --profile ${options.profile}`)

function parse(args: string[]): Options {
  let profile = 'web'
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
  if (['headless', 'node_modules', '.', '..'].includes(profile.toLowerCase())) {
    throw new Error(`拒绝修改保留 profile：${profile}；请使用 Web profile（默认 web）`)
  }
  return { dshBin, profile, packageSpec: existsSync(packageSpec) ? resolve(packageSpec) : packageSpec }
}

function assertSafeExistingProfile(profile: string): void {
  const manifestPath = resolveProfileManifestPath(profile)
  if (!existsSync(manifestPath)) {
    if (profile !== 'web') throw new Error(`profile ${profile} 不存在；请使用已有 Web profile 或默认 web`)
    return
  }
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
  const result = spawnSyncShell(command, args, { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败：${String(result.stderr).trim()}`)
  return `${result.stdout}\n${result.stderr}`.trim()
}

function run(command: string, args: string[]): void {
  const result = spawnSyncShell(command, args, { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败（exit ${String(result.status)}）`)
}
