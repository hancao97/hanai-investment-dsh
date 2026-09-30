import { createRequire } from 'node:module'
import {
  existsSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as DshBoot from '@deepseek-ai/dsh-app-boot'

export const BASE_BUNDLE = '@deepseek-ai/dsh-base'
export const WEB_APP_BUNDLE = '@deepseek-ai/dsh-web-app'
export const HANAI_BUNDLE = 'hanai-investment-dsh'
export const SUPPORTED_DSH_VERSION = '0.2.0-rc.2'
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

/**
 * Refuse to repurpose a profile that is not already Hanai-owned. The legacy
 * web-app dependency is accepted only so the installer can migrate it away.
 */
export function assertSafeProfileManifest(manifest: JsonObject, profile: string): void {
  const dependencies = object(manifest.dependencies ?? {}, `${profile}.dependencies`)
  const allowedDependencies = new Set([WEB_APP_BUNDLE, HANAI_BUNDLE])
  const unexpectedDependencies = Object.keys(dependencies).filter(name => !allowedDependencies.has(name))
  invariant(
    unexpectedDependencies.length === 0,
    `profile ${profile} 已存在且含有其他插件（${unexpectedDependencies.join(', ')}），为避免污染已拒绝修改`,
  )

  const dsh = object(manifest.dsh ?? {}, `${profile}.dsh`)
  const profileConfig = object(dsh.profile ?? {}, `${profile}.dsh.profile`)
  const bundles = stringArray(profileConfig.bundles ?? [], `${profile}.dsh.profile.bundles`)
  const allowedBundles = new Set<string>(EXPECTED_PROFILE_BUNDLES)
  const unexpectedBundles = bundles.filter(name => !allowedBundles.has(name))
  invariant(
    unexpectedBundles.length === 0,
    `profile ${profile} 已存在且含有其他组合层（${unexpectedBundles.join(', ')}），为避免覆盖已拒绝修改`,
  )
}

/**
 * Convert both a new custom profile and the legacy Hanai profile to the DSH
 * installation-owned bundle topology. The Web app remains a bundle layer but
 * is deliberately not a profile dependency.
 */
export function normalizeProfileManifest(manifest: JsonObject): JsonObject {
  const dependencies = { ...object(manifest.dependencies ?? {}, 'profile.dependencies') }
  delete dependencies[WEB_APP_BUNDLE]
  invariant(
    typeof dependencies[HANAI_BUNDLE] === 'string' && dependencies[HANAI_BUNDLE] !== '',
    `profile 尚未安装 ${HANAI_BUNDLE}`,
  )

  const dsh = { ...object(manifest.dsh ?? {}, 'profile.dsh') }
  const profile = { ...object(dsh.profile ?? {}, 'profile.dsh.profile') }
  profile.bundles = [...EXPECTED_PROFILE_BUNDLES]
  dsh.profile = profile
  return {
    ...manifest,
    dependencies,
    dsh,
  }
}

export function assertProfileContract(manifest: JsonObject, profile: string): void {
  const dependencies = object(manifest.dependencies ?? {}, `${profile}.dependencies`)
  invariant(
    !Object.hasOwn(dependencies, WEB_APP_BUNDLE),
    `${WEB_APP_BUNDLE} 不得是 profile dependency；请重新运行 profile:install 完成迁移`,
  )
  invariant(
    typeof dependencies[HANAI_BUNDLE] === 'string' && dependencies[HANAI_BUNDLE] !== '',
    `profile ${profile} 缺少 ${HANAI_BUNDLE} dependency`,
  )
  const unexpectedDependencies = Object.keys(dependencies).filter(name => name !== HANAI_BUNDLE)
  invariant(
    unexpectedDependencies.length === 0,
    `profile ${profile} 含有非 Hanai dependency：${unexpectedDependencies.join(', ')}`,
  )

  const dsh = object(manifest.dsh, `${profile}.dsh`)
  const profileConfig = object(dsh.profile, `${profile}.dsh.profile`)
  const bundles = stringArray(profileConfig.bundles, `${profile}.dsh.profile.bundles`)
  invariant(
    bundles.length === EXPECTED_PROFILE_BUNDLES.length
      && bundles.every((bundle, index) => bundle === EXPECTED_PROFILE_BUNDLES[index]),
    `profile ${profile} 的 bundles 必须严格为 ${EXPECTED_PROFILE_BUNDLES.join(' -> ')}`,
  )
}

/** Atomic manifest replacement; an interrupted write never leaves partial JSON. */
export function writeManifestAtomic(manifestPath: string, manifest: JsonObject): void {
  const temporary = `${manifestPath}.hanai-${String(process.pid)}.tmp`
  const mode = existsSync(manifestPath) ? statSync(manifestPath).mode : 0o644
  try {
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode })
    renameSync(temporary, manifestPath)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
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
    `profile node_modules 含有 DSH 内置包副本（${localPackages.join(', ')}）；请重新运行 profile:install 清理 shadow packages`,
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
    invariant(
      relative(profileDir, profileTools).startsWith('..'),
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
    : (process.env.PATH ?? '').split(delimiter).map(directory => resolve(directory, dshBin))
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
    const parent = dirname(directory)
    invariant(parent !== directory, `无法从 ${dshBin} 定位 @deepseek-ai/dsh 安装目录`)
    directory = parent
  }
}

export function assertComposedLayers(output: string): void {
  for (const bundle of EXPECTED_PROFILE_BUNDLES) {
    invariant(output.includes(`# == ${bundle}`) || output.includes(`patched by ${bundle}`), `独立 profile 缺少组合层：${bundle}`)
  }
}

export function manifestPathFor(dshHome: string, profile: string): string {
  return join(dshHome, 'profiles', profile, 'package.json')
}

export function profileDirForManifest(manifestPath: string): string {
  return dirname(manifestPath)
}
