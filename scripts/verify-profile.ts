import { spawnSync } from 'node:child_process'

import { stripPnpmRunSeparator } from './pnpm-run-args.ts'

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
const result = spawnSync(dshBin, ['--profile', profile, '--dump-default-config'], {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
})
if (result.error !== undefined) throw result.error
if (result.status !== 0) throw new Error(result.stderr || `profile verification failed: ${String(result.status)}`)
const output = `${result.stdout}\n${result.stderr}`
for (const expected of ['@deepseek-ai/dsh-web-app', 'hanai-investment-dsh']) {
  if (!output.includes(expected)) throw new Error(`独立 profile 缺少组合层：${expected}`)
}
console.log(`Profile ${profile} includes the DSH Web app and Hanai bundle.`)

function value(values: string[], index: number, flag: string): string {
  const result = values[index]
  if (result === undefined || result === '') throw new Error(`${flag} 缺少值`)
  return result
}
