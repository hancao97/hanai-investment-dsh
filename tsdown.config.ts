import { defineConfig } from 'tsdown'
import { hanaiClientBundle } from './tooling/dsh-client-bundle/index.ts'

export default defineConfig([
  {
    name: 'hanai-investment-dsh/host',
    entry: { index: 'packages/host/src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    dts: true,
    clean: true,
    sourcemap: true,
    outputOptions: {
      entryFileNames: '[name].js',
    },
  },
  {
    name: 'hanai-investment-dsh/profile-tools',
    entry: {
      'install-profile': 'scripts/install-profile.ts',
      'verify-profile': 'scripts/verify-profile.ts',
    },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: false,
    sourcemap: true,
    outputOptions: {
      entryFileNames: '[name].js',
    },
  },
  hanaiClientBundle('hanai-investment-dsh', 'packages/client-workbench/src/index.tsx'),
])
