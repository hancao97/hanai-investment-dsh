import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { stripPnpmRunSeparator } from './pnpm-run-args.ts'
import {
  assertComposedLayers,
  assertProfileContract,
  assertRuntimeIdentity,
  manifestPathFor,
  profileDirForManifest,
  readManifest,
} from './profile-contract.ts'

const args = stripPnpmRunSeparator(process.argv.slice(2))
let profile = 'hanai-investment'
let dshBin = 'dsh'
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]
  if (argument === '--dsh-bin') dshBin = value(args, ++index, argument)
  else if (argument === '--profile') profile = value(args, ++index, argument)
  else if (argument?.startsWith('--')) throw new Error(`未知参数：${argument}`)
  else if (argument !== undefined) profile = argument
}
if (!/^[A-Za-z0-9._-]+$/.test(profile)) throw new Error('非法 profile 名称')
const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const manifestPath = manifestPathFor(dshHome, profile)
if (!existsSync(manifestPath)) throw new Error(`profile ${profile} 不存在：${manifestPath}`)
assertProfileContract(readManifest(manifestPath), profile)
const result = spawnSync(dshBin, ['--profile', profile, '--dump-default-config'], {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
})
if (result.error !== undefined) throw result.error
if (result.status !== 0) throw new Error(result.stderr || `profile verification failed: ${String(result.status)}`)
const output = `${result.stdout}\n${result.stderr}`
assertComposedLayers(output)
assertRuntimeIdentity(profileDirForManifest(manifestPath))
console.log(`Profile ${profile} has installation-owned DSH runtime packages and the Base → Web app → Hanai bundle stack.`)

function value(values: string[], index: number, flag: string): string {
  const result = values[index]
  if (result === undefined || result === '') throw new Error(`${flag} 缺少值`)
  return result
}
