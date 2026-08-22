/**
 * Minimal out-of-tree DSH client bundle adapter.
 *
 * Derived from deepseek-harness packages/client/tsdown.client.ts at
 * b150a551b8d465e31e418e1b2eaf5e79bbb7d28e (MIT). The adapter intentionally
 * keeps only the public loader closure, default module-table externals, the
 * client bundle purity guard and CSS Modules behavior needed by this plugin.
 * Compatibility is covered by package and real-profile smoke tests.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative as relativePath, resolve as resolvePath, sep } from 'node:path'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

const CSS_VIRTUAL_PREFIX = '\0hanai-dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

const DEFAULT_CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
] as const

/** Build one DSH Module Loader compatible, single-file browser client. */
export function hanaiClientBundle(id: string, entry: string): UserConfig {
  const projectRoot = resolvePath('.')
  const isRequested = (specifier: string): boolean => DEFAULT_CLIENT_EXTERNALS.includes(specifier as never)
  return {
    name: `${id}/client`,
    entry: { client: entry },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: isRequested,
      alwaysBundle: (specifier: string) => !isRequested(specifier),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [{
      name: 'hanai-dsh-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/') || isRequested(source)) return null
        throw new Error(
          `client bundle purity: "${source}" is not a default DSH client external; `
          + 'use a type-only import or extend the adapter and dsh.client.external manifest together',
        )
      },
    }, {
      name: 'hanai-dsh-css-modules-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        const absolute = importer === undefined ? source : sourceAssetPath(source, importer)
        const assetId = projectAssetId(projectRoot, absolute)
        return CSS_VIRTUAL_PREFIX + assetId + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const assetId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        const fileId = resolvePath(projectRoot, ...assetId.split('/'))
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const output = transform({
          filename: assetId,
          code: source,
          cssModules: { pattern: 'hanai_[hash]_[local]' },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        for (const [local, exported] of Object.entries(output.exports ?? {})) classMap[local] = exported.name
        const tagId = `${id}/${basename(fileId)}`
        return [
          `const css = ${JSON.stringify(output.code.toString())};`,
          `const tagId = ${JSON.stringify(tagId)};`,
          "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
          "  const tag = document.createElement('style');",
          `  tag.dataset.plugin = ${JSON.stringify(id)};`,
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          `export default ${JSON.stringify(classMap)};`,
        ].join('\n')
      },
    }],
    outputOptions: {
      // Keep browser-only dynamic modules lazy, but inline them into the single
      // distributable required by the DSH ModuleLoader protocol.
      codeSplitting: false,
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

function projectAssetId(projectRoot: string, absolute: string): string {
  const relative = relativePath(projectRoot, absolute)
  if (relative === '' || relative === '..' || relative.startsWith(`..${sep}`) || isAbsolute(relative)) {
    throw new Error(`CSS Module must live inside the plugin project: ${basename(absolute)}`)
  }
  return relative.split(sep).join('/')
}

function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = `${sep}lib${sep}types${sep}`
  const boundary = emitted.indexOf(marker)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + marker.length))
}
