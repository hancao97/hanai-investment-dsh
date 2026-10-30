import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  BASE_BUNDLE,
  EXPECTED_PROFILE_BUNDLES,
  HANAI_BUNDLE,
  WEB_APP_BUNDLE,
  assertComposedLayers,
  assertDshVersion,
  assertProfileContract,
  assertSafeProfileManifest,
  profileLocalDshPackages,
} from './profile-contract.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function manifest(bundles = [...EXPECTED_PROFILE_BUNDLES] as string[]): Record<string, unknown> {
  return {
    dependencies: { [HANAI_BUNDLE]: 'link:../hanai-investment-dsh', 'other-plugin': '1.0.0' },
    dsh: { profile: { bundles, patchReload: 'live' } },
  }
}

describe('Hanai DSH profile contract', () => {
  it('accepts only the verified CLI release before profile mutation', () => {
    expect(assertDshVersion('0.2.1-rc.2\n')).toBe('0.2.1-rc.2')
    expect(() => assertDshVersion('0.2.0-rc.2')).toThrow(/请先更新/)
    expect(() => assertDshVersion('0.2.1-rc.3')).toThrow(/需要 DSH/)
    expect(() => assertDshVersion('unknown')).toThrow(/无法识别/)
  })

  it('accepts other plugins anywhere without modifying their order or settings', () => {
    const input = manifest([BASE_BUNDLE, 'other-plugin', WEB_APP_BUNDLE, 'auth-plugin', HANAI_BUNDLE, 'last-plugin'])
    const before = structuredClone(input)
    expect(() => assertSafeProfileManifest(input, 'web')).not.toThrow()
    expect(() => assertProfileContract(input, 'web')).not.toThrow()
    expect(input).toEqual(before)
  })

  it('accepts an existing web profile before Hanai is installed', () => {
    expect(() => assertSafeProfileManifest({ dsh: { profile: { bundles: [BASE_BUNDLE, WEB_APP_BUNDLE] } } }, 'web')).not.toThrow()
    expect(() => assertProfileContract(manifest([BASE_BUNDLE, WEB_APP_BUNDLE]), 'web')).toThrow(/缺少.*bundle/)
  })

  it('rejects missing, duplicate, or misordered core bundles', () => {
    for (const bundles of [[BASE_BUNDLE], [WEB_APP_BUNDLE, BASE_BUNDLE, HANAI_BUNDLE], [BASE_BUNDLE, HANAI_BUNDLE, WEB_APP_BUNDLE], [...EXPECTED_PROFILE_BUNDLES, HANAI_BUNDLE]]) {
      expect(() => assertProfileContract(manifest(bundles), 'web')).toThrow()
    }
    const input = manifest()
    input.dependencies = {}
    expect(() => assertProfileContract(input, 'web')).toThrow(/缺少.*dependency/)
  })

  it('rejects a direct web-app dependency before installation', () => {
    const input = manifest()
    ;(input.dependencies as Record<string, unknown>)[WEB_APP_BUNDLE] = '0.2.1-rc.2'
    expect(() => assertSafeProfileManifest(input, 'web')).toThrow(/不得是 profile dependency/)
  })

  it('detects profile-local DSH shadow packages', () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'hanai-profile-contract-'))
    temporaryDirectories.push(profileDir)
    mkdirSync(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-tools'), { recursive: true })
    mkdirSync(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-client-runtime'), { recursive: true })
    mkdirSync(join(profileDir, 'node_modules', '@deepseek-ai', 'cordis'), { recursive: true })

    expect(profileLocalDshPackages(profileDir)).toEqual([
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-tools',
    ])
  })

  it('requires all three composed bundle markers', () => {
    const output = EXPECTED_PROFILE_BUNDLES.map(bundle => `# == ${bundle}`).join('\n')
    expect(() => assertComposedLayers(output)).not.toThrow()
    expect(() => assertComposedLayers(`# == ${BASE_BUNDLE}`)).toThrow(/缺少组合层/)
  })
})
