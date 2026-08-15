import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/tests/**/*.spec.ts', 'packages/**/tests/**/*.spec.tsx', 'tests/**/*.spec.ts'],
    server: {
      // The shared DSH Markdown primitive imports its KaTeX stylesheet. Keep
      // the package inside Vite's transform pipeline so jsdom tests do not ask
      // Node to load CSS as an ESM module.
      deps: { inline: ['@deepseek-ai/dsh-client-ui-primitives'] },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/contracts/src/**', 'packages/domain/src/**', 'packages/host/src/**'],
    },
  },
})
