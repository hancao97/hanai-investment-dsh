import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  BASE_BUNDLE,
  EXPECTED_PROFILE_BUNDLES,
  HANAI_BUNDLE,
  WEB_APP_BUNDLE,
  assertComposedLayers,
  assertProfileContract,
  assertSafeProfileManifest,
  normalizeProfileManifest,
  profileLocalDshPackages,
  readManifest,
  writeManifestAtomic,
} from './profile-contract.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function legacyManifest(): Record<string, unknown> {
  return {
    name: 'dsh-profile-hanai-investment',
    private: true,
    dependencies: {
      [WEB_APP_BUNDLE]: '0.1.0-rc.6',
      [HANAI_BUNDLE]: 'link:/checkout/hanai-investment-dsh',
    },
    dsh: {
      profile: {
        bundles: [...EXPECTED_PROFILE_BUNDLES],
      },
    },
  }
}

describe('Hanai DSH profile contract', () => {
  it('migrates the legacy web-app dependency while preserving it as an ordered bundle', () => {
    const normalized = normalizeProfileManifest(legacyManifest())

    expect(normalized).toMatchObject({
      dependencies: {
        [HANAI_BUNDLE]: 'link:/checkout/hanai-investment-dsh',
      },
      dsh: {
        profile: {
          bundles: [BASE_BUNDLE, WEB_APP_BUNDLE, HANAI_BUNDLE],
        },
      },
    })
    expect((normalized.dependencies as Record<string, unknown>)).not.toHaveProperty(WEB_APP_BUNDLE)
    expect(() => assertProfileContract(normalized, 'hanai-investment')).not.toThrow()
  })

  it('fails closed for unrelated dependencies or bundle layers', () => {
    const dependencyProfile = legacyManifest()
    ;(dependencyProfile.dependencies as Record<string, unknown>)['another-plugin'] = '1.0.0'
    expect(() => assertSafeProfileManifest(dependencyProfile, 'hanai-investment')).toThrow(/其他插件/)

    const bundleProfile = legacyManifest()
    ;(((bundleProfile.dsh as Record<string, unknown>).profile as Record<string, unknown>).bundles as string[]).push('another-bundle')
    expect(() => assertSafeProfileManifest(bundleProfile, 'hanai-investment')).toThrow(/其他组合层/)
  })

  it('rejects a direct web-app dependency even when all bundle names look correct', () => {
    expect(() => assertProfileContract(legacyManifest(), 'hanai-investment')).toThrow(
      /不得是 profile dependency/,
    )
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

  it('atomically writes valid JSON manifests', () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'hanai-profile-contract-'))
    temporaryDirectories.push(profileDir)
    const manifestPath = join(profileDir, 'package.json')
    writeFileSync(manifestPath, '{"before":true}\n')

    const normalized = normalizeProfileManifest(legacyManifest())
    writeManifestAtomic(manifestPath, normalized)

    expect(readManifest(manifestPath)).toEqual(normalized)
    expect(readFileSync(manifestPath, 'utf8')).toMatch(/\n$/)
  })

  it('requires all three composed bundle markers', () => {
    const output = EXPECTED_PROFILE_BUNDLES.map(bundle => `# == ${bundle}`).join('\n')
    expect(() => assertComposedLayers(output)).not.toThrow()
    expect(() => assertComposedLayers(`# == ${BASE_BUNDLE}`)).toThrow(/缺少组合层/)
  })
})
