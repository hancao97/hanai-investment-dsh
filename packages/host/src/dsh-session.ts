import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ModelSelectionInput } from '../../contracts/src/index.ts'

const HANAI_AGENT_PRESET = 'standard'

export class DshSessionGateway {
  constructor(private readonly ctx: Context) {}

  async create(judgementId: string, cwd: string, model?: ModelSelectionInput): Promise<string> {
    const requestedId = SessionId(`hanai-${judgementId}`)
    const created = await this.ctx.sessionController.create({
      cwd, sessionId: requestedId, agentPreset: HANAI_AGENT_PRESET,
    })
    if (created.agentPreset !== HANAI_AGENT_PRESET) {
      const actual = created.agentPreset === undefined ? '未返回' : `"${created.agentPreset}"`
      await this.rejectCreatedSession(
        created.sessionId,
        new Error(`DSH Session 未使用必需的 Agent Preset "${HANAI_AGENT_PRESET}"（实际：${actual}）`),
      )
    }
    if (model !== undefined) {
      try {
        await this.ctx.sessionController.selectModel({
          sessionId: created.sessionId,
          provider: model.provider,
          model: model.model,
          ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
        })
      } catch (error) {
        await this.rejectCreatedSession(created.sessionId, error)
      }
    }
    return created.sessionId
  }

  private async rejectCreatedSession(sessionId: string, error: unknown): Promise<never> {
    try {
      await this.archive(sessionId)
    } catch (cleanupError) {
      throw new Error(
        `${messageOf(error)}；未绑定 Session 归档失败：${messageOf(cleanupError)}`,
        { cause: error },
      )
    }
    throw error
  }

  /** DSH has no session deletion API; archiving is its durable orphan-cleanup primitive. */
  async archive(sessionId: string): Promise<void> {
    await this.ctx.workspaceController.archiveSession({ sessionId: SessionId(sessionId) })
  }

  async prompt(sessionId: string, text: string, mode: 'queue' | 'steer' = 'queue'): Promise<void> {
    await this.ctx.sessionController.prompt({
      requestId: randomUUID() as SessionRequestId,
      sessionId: SessionId(sessionId),
      mode,
      content: [{ type: 'text', text }],
    }, new AbortController().signal)
  }

  async history(sessionId: string, maxMessages = 10): Promise<SessionEvent[]> {
    const { events } = await this.ctx.sessionController.inspect(SessionId(sessionId))
    let messages = 0
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!
      if (event.type === 'user/message' || event.type === 'assistant/message') messages += 1
      if (messages > maxMessages) return events.slice(index + 1)
    }
    return [...events]
  }

  async isRunning(sessionId: string): Promise<boolean> {
    const list = await this.ctx.sessionController.list({}, new AbortController().signal)
    return list.items.find(item => item.sessionId === sessionId)?.running ?? false
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
