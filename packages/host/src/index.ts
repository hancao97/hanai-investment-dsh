import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { HanaiDatabase } from '../../domain/src/database.ts'
import { resolveHanaiPaths, ensureHanaiLayout } from '../../domain/src/paths.ts'
import { ReportStore } from '../../domain/src/reports.ts'
import { MarketDataService } from '../../domain/src/providers/index.ts'
import {
  resolveMasterAssetsRoot,
  validateMasterAssets,
} from '../../masters/src/index.ts'
import { DshSessionGateway } from './dsh-session.ts'
import { badRequest, internalError, isHanaiEndpoint, ok, parseHanaiRequest } from './rpc.ts'
import { HanaiService } from './service.ts'

export const name = 'hanai-investment-dsh'
export const inject = ['connection', 'apiProxy', 'sessions', 'agentDefaultModel']
export const VERSION = '0.1.0'

export interface Config {
  dataRoot?: string
  requestTimeoutMs?: number
  reportMinChars?: number
}

export const Config: z<Config> = z.object({
  dataRoot: z.string(),
  requestTimeoutMs: z.natural().min(1_000).default(12_000),
  reportMinChars: z.natural().min(400).default(800),
})

/** Mount the Host business plane and its loopback-only browser RPC channel. */
export function apply(ctx: Context, config: Config = {}): void {
  const paths = resolveHanaiPaths(config.dataRoot)
  ensureHanaiLayout(paths)
  const assetsRoot = resolveMasterAssetsRoot(import.meta.url)
  validateMasterAssets(assetsRoot)
  const database = new HanaiDatabase(paths.databasePath)
  const reports = new ReportStore(paths, assetsRoot, config.reportMinChars ?? 800)
  const market = new MarketDataService({
    valuationCacheDir: paths.valuationCacheDir,
    eastmoney: { timeoutMs: config.requestTimeoutMs ?? 12_000 },
    gurufocus: { timeoutMs: config.requestTimeoutMs ?? 12_000 },
  })
  const service = new HanaiService({
    paths,
    database,
    reports,
    sessions: new DshSessionGateway(ctx),
    defaultModel: ctx.agentDefaultModel,
    market,
    version: VERSION,
  })

  ctx.connection.rpc.handle('/hanai', async (endpoint, payload, signal) => {
    if (!isHanaiEndpoint(endpoint)) return badRequest(`未知 Hanai endpoint：${endpoint}`)
    try {
      const request = parseHanaiRequest(endpoint, payload)
      return ok(await service.call(endpoint, request, signal))
    } catch (error) {
      if (isValidationError(error)) return badRequest(error.message)
      return internalError(error)
    }
  }, { authority: 'loopback' })

  ctx.on('session/event', (session, event: SessionEvent) => {
    try {
      service.handleSessionEvent(String(session.id), event)
    } catch (error) {
      console.error('[hanai-investment-dsh] failed to observe DSH session event:', error)
    }
  })

  ctx.effect(() => () => database.close(), 'hanai-investment-dsh: close database')
  void service.recover().catch((error) => {
    console.error('[hanai-investment-dsh] recovery failed:', error)
  })
}

function isValidationError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'ZodError'
}
