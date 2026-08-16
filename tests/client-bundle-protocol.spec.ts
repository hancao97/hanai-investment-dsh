import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

interface ClientHandoff {
  factory: (require: (specifier: string) => unknown) => unknown
  id: string
}

const PACKAGE_NAME = 'hanai-investment-dsh'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ADAPTER_FILE = resolve(ROOT, 'tooling/dsh-client-bundle/index.ts')
const BUNDLE_FILE = resolve(ROOT, 'lib/client.js')
const adapterSource = readFileSync(ADAPTER_FILE, 'utf8')
const bundleSource = existsSync(BUNDLE_FILE) ? readFileSync(BUNDLE_FILE, 'utf8') : undefined

function captureHandoff(source: string): ClientHandoff {
  const handoffs: unknown[] = []
  runInNewContext(source, {
    console,
    window: {
      __ModuleLoader__: {
        load(handoff: unknown): void {
          handoffs.push(handoff)
        },
      },
    },
  }, {
    filename: BUNDLE_FILE,
    timeout: 2_000,
  })

  expect(handoffs).toHaveLength(1)
  const handoff = handoffs[0]
  expect(handoff).not.toBeNull()
  expect(typeof handoff).toBe('object')
  return handoff as ClientHandoff
}

function literalRequires(source: string): string[] {
  const sourceFile = ts.createSourceFile('client.js', source, ts.ScriptTarget.ESNext, false, ts.ScriptKind.JS)
  const specifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'require'
      && node.arguments.length === 1
    ) {
      const argument = node.arguments[0]
      if (argument && ts.isStringLiteralLike(argument)) specifiers.push(argument.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return specifiers.filter((specifier, index, all) => all.indexOf(specifier) === index).sort()
}

describe('out-of-tree DSH client bundle adapter', () => {
  it('encodes the lazy CJS ModuleLoader closure in the build configuration', () => {
    expect(adapterSource).toContain("format: 'cjs'")
    expect(adapterSource).toContain("platform: 'browser'")
    expect(adapterSource).toContain('clean: false')
    expect(adapterSource).toContain('codeSplitting: false')
    expect(adapterSource).toContain("entryFileNames: 'client.js'")
    expect(adapterSource).toContain(
      'banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`',
    )
    expect(adapterSource).toContain("footer: 'return module.exports; } });'")
    expect(adapterSource).toContain(
      "intro: 'var module = { exports: {} }; var exports = module.exports;'",
    )
  })

  it('keeps platform packages external for the loader-injected require', () => {
    expect(adapterSource).toContain('external: [...PLATFORM_MODULES]')
    expect(adapterSource).toContain('noExternal: (specifier: string) =>')
    expect(adapterSource).toContain("'react/jsx-runtime'")
    expect(adapterSource).toContain("'@deepseek-ai/cordis'")
    expect(adapterSource).toContain("'@deepseek-ai/dsh-client-runtime/client'")
  })
})

describe.skipIf(bundleSource === undefined)('built DSH client bundle', () => {
  it('is a classic script that performs exactly one lazy factory registration', () => {
    expect(bundleSource).not.toMatch(/^\s*(?:import|export)\s/m)
    expect(bundleSource).not.toMatch(/(?:\/(?:Users|home)\/[^/\s]+\/|[A-Za-z]:\\Users\\[^\\\s]+\\|\/(?:private\/)?tmp\/)/)

    const handoff = captureHandoff(bundleSource!)
    expect(Object.keys(handoff).sort()).toEqual(['factory', 'id'])
    expect(handoff.id).toBe(PACKAGE_NAME)
    expect(handoff.factory).toBeTypeOf('function')
    expect(handoff.factory).toHaveLength(1)
    expect(Function.prototype.toString.call(handoff.factory)).toMatch(/return\s+module\.exports\s*;/)
  })

  it('materializes through injected modules and returns Cordis plugin exports', async () => {
    const handoff = captureHandoff(bundleSource!)
    const specifiers = literalRequires(bundleSource!)
    expect(specifiers.length).toBeGreaterThan(0)

    const moduleEntries = await Promise.all(specifiers.map(async (specifier) => (
      [specifier, await import(specifier)] as const
    )))
    const modules = new Map<string, unknown>(moduleEntries)
    const requested: string[] = []
    const exports = handoff.factory((specifier) => {
      requested.push(specifier)
      if (!modules.has(specifier)) throw new Error(`unexpected client bundle require: ${specifier}`)
      return modules.get(specifier)
    })

    expect(exports).not.toBeNull()
    expect(typeof exports).toBe('object')
    const plugin = exports as Record<string, unknown>
    expect(plugin.apply).toBeTypeOf('function')
    expect(plugin.inject).toSatisfy((value: unknown) => (
      Array.isArray(value) && value.every((item) => typeof item === 'string')
    ))
    expect(new Set(requested).size).toBeGreaterThan(0)
  })
})
