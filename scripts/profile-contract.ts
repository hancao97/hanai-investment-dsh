import { createRequire } from 'node:module'
import {
  existsSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as DshBoot from '@deepseek-ai/dsh-app-boot'

export const BASE_BUNDLE = '@deepseek-ai/dsh-base'
export const WEB_APP_BUNDLE = '@deepseek-ai/dsh-web-app'
export const HANAI_BUNDLE = 'hanai-investment-dsh'
export const SUPPORTED_DSH_VERSION = '0.2.1-rc.2'
export const EXPECTED_PROFILE_BUNDLES = [
  BASE_BUNDLE,
  WEB_APP_BUNDLE,
  HANAI_BUNDLE,
] as const

type JsonObject = Record<string, unknown>

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Reject a CLI mismatch before changing a profile or composing its runtime. */
export function assertDshVersion(output: string): string {
  const version = output.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0]
  invariant(version === SUPPORTED_DSH_VERSION,
    `Hanai 需要 DSH ${SUPPORTED_DSH_VERSION}，当前为 ${version ?? '无法识别'}；请先更新 dsh CLI`)
  return version
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function object(value: unknown, label: string): JsonObject {
  invariant(isObject(value), `${label} 必须是 JSON object`)
  return value
}

function stringArray(value: unknown, label: string): string[] {
  invariant(Array.isArray(value) && value.every(item => typeof item === 'string'), `${label} 必须是字符串数组`)
  return value
}

export function readManifest(manifestPath: string): JsonObject {
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  return object(parsed, manifestPath)
}

/** Validate an existing Web profile without rewriting other plugins or settings. */
export function assertSafeProfileManifest(manifest: JsonObject, profile: string): void {
  const dependencies = object(manifest.dependencies ?? {}, `${profile}.dependencies`)
  invariant(Object.values(dependencies).every(value => typeof value === 'string' && value !== ''),
    `profile ${profile} 的 dependencies 必须是非空字符串`)
  invariant(!Object.hasOwn(dependencies, WEB_APP_BUNDLE),
    `${WEB_APP_BUNDLE} 不得是 profile dependency；请先用 DSH CLI 移除该内置包依赖并保留 Web bundle`)
  const dsh = object(manifest.dsh, `${profile}.dsh`)
  const config = object(dsh.profile, `${profile}.dsh.profile`)
  const bundles = stringArray(config.bundles, `${profile}.dsh.profile.bundles`)
  invariant(new Set(bundles).size === bundles.length, `profile ${profile} 的 bundles 不得重复`)
  const base = bundles.indexOf(BASE_BUNDLE)
  const web = bundles.indexOf(WEB_APP_BUNDLE)
  const hanai = bundles.indexOf(HANAI_BUNDLE)
  invariant(base >= 0 && web > base && (hanai < 0 || hanai > web),
    `profile ${profile} 必须按 Base → Web app → Hanai 的相对顺序装配；允许其它插件`)
}

export function assertProfileContract(manifest: JsonObject, profile: string): void {
  assertSafeProfileManifest(manifest, profile)
  const dependencies = object(manifest.dependencies ?? {}, `${profile}.dependencies`)
  invariant(typeof dependencies[HANAI_BUNDLE] === 'string' && dependencies[HANAI_BUNDLE] !== '',
    `profile ${profile} 缺少 ${HANAI_BUNDLE} dependency`)
  const config = object(object(manifest.dsh, `${profile}.dsh`).profile, `${profile}.dsh.profile`)
  invariant(stringArray(config.bundles, `${profile}.bundles`).includes(HANAI_BUNDLE),
    `profile ${profile} 缺少 ${HANAI_BUNDLE} bundle`)
}

/**
 * A profile-local copy of an in-box DSH package can split service-definition
 * symbols from their providers. All of these packages must resolve through
 * DSH's installation-owned runtime resolution instead.
 */
export function profileLocalDshPackages(profileDir: string): string[] {
  const scopeDir = join(profileDir, 'node_modules', '@deepseek-ai')
  if (!existsSync(scopeDir)) return []
  return readdirSync(scopeDir, { withFileTypes: true })
    .filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && entry.name.startsWith('dsh-'))
    .map(entry => `@deepseek-ai/${entry.name}`)
    .sort()
}

/**
 * Prove the agent loop and profile resolve the exact same dsh-tools module,
 * not merely files with the same package version and bytes.
 */
export async function assertRuntimeIdentity(profileDir: string, dshBin = 'dsh'): Promise<void> {
  const localPackages = profileLocalDshPackages(profileDir)
  invariant(
    localPackages.length === 0,
    `profile node_modules 含有 DSH 内置包副本（${localPackages.join(', ')}）；请先备份并通过 DSH CLI 排查内置包重复安装；安装器不会删除其它插件`,
  )

  // DSH 0.2 routes packages in memory. Use the selected CLI's own boot and
  // Cordis modules so this check exercises the same resolver as a real launch.
  const installAnchor = resolveDshInstallAnchor(dshBin)
  const installRequire = createRequire(installAnchor)
  const boot = await import(pathToFileURL(installRequire.resolve('@deepseek-ai/dsh-app-boot')).href) as typeof DshBoot
  const { Context } = await import(pathToFileURL(installRequire.resolve('@deepseek-ai/cordis')).href) as typeof import('@deepseek-ai/cordis')
  const profile = boot.loadProfileDirectory('hanai', profileDir, installAnchor)
  invariant(profile.skippedBundles.length === 0, 'DSH 跳过了不兼容的 profile bundle')
  const resolution = await boot.createRuntimeResolution({
    installAnchor,
    profile,
    home: dirname(dirname(profileDir)),
  })
  const ctx = new Context()
  try {
    await ctx.plugin(boot.PluginPackages, { resolution })
    const profileRequire = createRequire(join(profileDir, 'package.json'))
    const profileTools = realpathSync(profileRequire.resolve('@deepseek-ai/dsh-tools'))
    const agentLoop = realpathSync(profileRequire.resolve('@deepseek-ai/dsh-agent-loop'))
    const agentLoopTools = realpathSync(createRequire(agentLoop).resolve('@deepseek-ai/dsh-tools'))
    invariant(
      profileTools === agentLoopTools,
      `DSH runtime identity 分裂：profile 使用 ${profileTools}，agent-loop 使用 ${agentLoopTools}`,
    )
    // Windows 上 profile 与 dsh 安装可能分属不同盘符，relative 跨盘会返回
    // 目标绝对路径；绝对路径同样说明 dsh-tools 不在 profile 目录内。
    const toolsRelative = relative(profileDir, profileTools)
    invariant(
      toolsRelative.startsWith('..') || isAbsolute(toolsRelative),
      `dsh-tools 错误地从 profile 内解析：${profileTools}`,
    )
  } finally {
    await ctx.fiber.dispose()
  }
}

/** Follow the selected npm CLI, rather than guessing a global install prefix. */
export function resolveDshInstallAnchor(dshBin: string): string {
  const candidates = dshBin.includes('/') || dshBin.includes('\\')
    ? [resolve(dshBin)]
    : (process.env.PATH ?? '').split(delimiter).flatMap(directory => [
        resolve(directory, dshBin),
        // Windows npm 全局布局的可执行体是 .cmd/.ps1 shim。
        resolve(directory, `${dshBin}.cmd`),
        resolve(directory, `${dshBin}.ps1`),
      ])
  const executable = candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile())
  invariant(executable !== undefined, `无法定位 dsh CLI：${dshBin}`)
  let directory = dirname(realpathSync(executable))
  while (true) {
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = readManifest(manifestPath)
      if (manifest.name === '@deepseek-ai/dsh') {
        assertDshVersion(String(manifest.version))
        return manifestPath
      }
    }
    // npm 全局布局：bin shim 与实际包分居两处，包在 bin 目录的
    // node_modules/@deepseek-ai/dsh 下，向上逐层探测。
    const siblingPath = join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    if (existsSync(siblingPath)) {
      const manifest = readManifest(siblingPath)
      if (manifest.name === '@deepseek-ai/dsh') {
        assertDshVersion(String(manifest.version))
        return siblingPath
      }
    }
    const parent = dirname(directory)
    invariant(parent !== directory, `无法从 ${dshBin} 定位 @deepseek-ai/dsh 安装目录`)
    directory = parent
  }
}

export function assertComposedLayers(output: string): void {
  for (const bundle of EXPECTED_PROFILE_BUNDLES) {
    invariant(output.includes(`# == ${bundle}`) || output.includes(`patched by ${bundle}`), `profile 缺少组合层：${bundle}`)
  }
}

export function manifestPathFor(dshHome: string, profile: string): string {
  return join(dshHome, 'profiles', profile, 'package.json')
}

export function profileDirForManifest(manifestPath: string): string {
  return dirname(manifestPath)
}
