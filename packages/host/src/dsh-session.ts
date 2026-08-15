import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ModelSelectionInput } from '../../contracts/src/index.ts'

export class DshSessionGateway {
  constructor(private readonly ctx: Context) {}

  async create(judgementId: string, cwd: string, model?: ModelSelectionInput): Promise<string> {
    const requestedId = SessionId(`hanai-${judgementId}`)
    const response = await this.ctx.apiProxy.sessions.create({
      rpcId: RpcId(randomUUID()),
      payload: { cwd, sessionId: requestedId },
    })
    const created = unwrap(response.result)
    if (model !== undefined) {
      try {
        const selected = await this.ctx.apiProxy.sessions.selectModel({
          rpcId: RpcId(randomUUID()),
          payload: {
            sessionId: created.sessionId,
            provider: model.provider,
            model: model.model,
            ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
          },
        })
        unwrap(selected.result)
      } catch (error) {
        try {
          await this.archive(created.sessionId)
        } catch (cleanupError) {
          throw new Error(
            `${messageOf(error)}；未绑定 Session 归档失败：${messageOf(cleanupError)}`,
            { cause: error },
          )
        }
        throw error
      }
    }
    return created.sessionId
  }

  /** DSH has no session deletion API; archiving is its durable orphan-cleanup primitive. */
  async archive(sessionId: string): Promise<void> {
    const response = await this.ctx.apiProxy.workspace.archiveSession({
      rpcId: RpcId(randomUUID()),
      payload: { sessionId: SessionId(sessionId) },
    })
    unwrap(response.result)
  }

  async prompt(sessionId: string, text: string, mode: 'queue' | 'steer' = 'queue'): Promise<void> {
    const response = await this.ctx.apiProxy.sessions.prompt({
      rpcId: RpcId(randomUUID()),
      payload: {
        sessionId: SessionId(sessionId),
        mode,
        content: [{ type: 'text', text }],
      },
    })
    unwrap(response.result)
  }

  async history(sessionId: string, maxMessages = 10): Promise<SessionEvent[]> {
    const response = await this.ctx.apiProxy.sessions.history({
      rpcId: RpcId(randomUUID()),
      payload: { sessionId: SessionId(sessionId), maxMessages },
    })
    return unwrap(response.result).events.map(entry => entry.event)
  }

  async isRunning(sessionId: string): Promise<boolean> {
    const response = await this.ctx.apiProxy.sessions.list({
      rpcId: RpcId(randomUUID()),
      payload: {},
    })
    return unwrap(response.result).items.find(item => item.sessionId === sessionId)?.running ?? false
  }
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!result.ok) throw new Error(`DSH ${result.error.code}: ${result.error.message}`)
  return result.value
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
