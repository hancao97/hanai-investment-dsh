import { expect, it } from 'vitest'
import { productionManifest } from './pack.ts'

it('removes development dependencies and build hooks while preserving the runtime contract', () => {
  const manifest = {
    name: 'hanai-investment-dsh', main: './lib/index.js', files: ['lib/**'],
    dependencies: { zod: '4.1.11' }, peerDependencies: { '@deepseek-ai/cordis': '>=4 <5' },
    dsh: { bundle: { patch: './cordis.patch.yml' } }, exports: { './client': './lib/client.js' },
    packageManager: 'pnpm@11.7.0', devDependencies: { vitest: '4.1.8' },
    scripts: { prepare: 'pnpm run build', build: 'tsdown', test: 'vitest', 'pack:plugin': 'tsx scripts/pack.ts', 'profile:install': 'node lib/install-profile.js', 'profile:verify': 'node lib/verify-profile.js' },
  }
  const before = structuredClone(manifest)
  expect(productionManifest(manifest)).toEqual({
    name: manifest.name, main: manifest.main, files: manifest.files,
    dependencies: manifest.dependencies, peerDependencies: manifest.peerDependencies,
    dsh: manifest.dsh, exports: manifest.exports,
    scripts: { 'profile:install': 'node lib/install-profile.js', 'profile:verify': 'node lib/verify-profile.js' },
  })
  expect(manifest).toEqual(before)
})
