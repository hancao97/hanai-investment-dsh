import { spawnSync, type SpawnSyncOptions } from 'node:child_process'

/**
 * Windows 上 dsh/npm 是 .cmd shim，spawnSync 不带 shell 直接调用会 ENOENT。
 * 统一走这里：非 Windows 保持原样；Windows 经 cmd shell 执行，
 * 参数含空格或 cmd 元字符时加引号。
 */
export function spawnSyncShell(command: string, args: string[], options: SpawnSyncOptions) {
  if (process.platform !== 'win32') return spawnSync(command, args, options)
  const line = [command, ...args].map(quoteWindowsArg).join(' ')
  return spawnSync(line, { ...options, shell: true })
}

function quoteWindowsArg(arg: string): string {
  return /[\s"&|<>^]/.test(arg) ? `"${arg}"` : arg
}
