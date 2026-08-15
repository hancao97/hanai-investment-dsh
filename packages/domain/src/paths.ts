import { chmodSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export interface HanaiPaths {
  root: string
  databaseDir: string
  databasePath: string
  cacheDir: string
  marketCacheDir: string
  valuationCacheDir: string
  judgementsDir: string
  exportsDir: string
  tmpDir: string
}

/** Resolve only the dedicated DSH-plugin data root; no previous product root is ever probed. */
export function resolveHanaiPaths(configured?: string): HanaiPaths {
  const candidate = configured?.trim() || process.env.HANAI_INVESTMENT_DSH_HOME?.trim()
  const root = candidate === undefined || candidate === ''
    ? join(homedir(), '.hanai-investment-dsh')
    : isAbsolute(candidate) ? resolve(candidate) : resolve(process.cwd(), candidate)
  return {
    root,
    databaseDir: join(root, 'db'),
    databasePath: join(root, 'db', 'hanai.sqlite'),
    cacheDir: join(root, 'cache'),
    marketCacheDir: join(root, 'cache', 'market'),
    valuationCacheDir: join(root, 'cache', 'valuation'),
    judgementsDir: join(root, 'judgements'),
    exportsDir: join(root, 'exports'),
    tmpDir: join(root, 'tmp'),
  }
}

export function ensureHanaiLayout(paths: HanaiPaths): void {
  const directories = [
    paths.root,
    paths.databaseDir,
    paths.cacheDir,
    paths.marketCacheDir,
    paths.valuationCacheDir,
    paths.judgementsDir,
    paths.exportsDir,
    paths.tmpDir,
  ]
  for (const directory of directories) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
  }
}
