import type { Context } from '@deepseek-ai/cordis'
import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import type { ISessions, SessionSnapshot, SessionFace as DshSessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PendingApproval } from '@deepseek-ai/dsh-client-ui-approval/client'
import type { PendingQuestion } from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export type { SessionId }
export type PendingInteraction = PendingApproval | PendingQuestion

export interface QueuedMessage {
  readonly id: MessageId
  readonly placement: 'queued' | 'steering'
  readonly text: string | null
  readonly preview: string
}

/** Hanai's read model joins DSH-owned sources without storing transcript data. */
export interface ConversationSnapshot extends SessionSnapshot {
  readonly chat: Pick<ChatSnapshot, 'order' | 'nodes'>
  readonly queue: readonly QueuedMessage[]
  readonly pending: readonly PendingInteraction[]
}

export type SessionFace = Omit<DshSessionFace, 'getSnapshot'> & {
  getSnapshot(): ConversationSnapshot
}

export interface ChatSessionReference {
  readonly session: SessionFace
  readonly ready: Promise<unknown>
  release(): void
}

export interface ChatSessions {
  readonly list: ISessions['list']
  retain(id: SessionId): ChatSessionReference
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    hanaiChat: unknown
  }
}

const EMPTY_CHAT = { order: [], nodes: { get: () => undefined } } as unknown as ChatSnapshot
const EMPTY_INBOX: InboxState = { 'next-turn': [], 'next-step': [] }

/** Hold one DSH generation for each mounted Hanai chat and release it on exit. */
export function createChatSessions(ctx: Context): ChatSessions {
  return {
    list: ctx.sessions.list,
    retain(id) {
      const reference = ctx.sessions.retain(id, { source: 'hanaiChat' })
      const disposers: (() => void)[] = []
      try {
        const binding = reference.binding
        const native = binding.session
        const conversation = ctx.uiConversation.binding(binding)
        conversation.activate('chat')
        const chat = conversation.target('chat')
        const inbox = native.projections.faceOf('inbox')
        const status = ctx.uiSession.sessionStatus
        let cached: ConversationSnapshot | undefined
        const listeners = new Set<() => void>()
        const publish = () => {
          cached = undefined
          for (const listener of listeners) listener()
        }
        for (const source of [native, chat, inbox, status]) disposers.push(source.subscribe(publish))
        const session: SessionFace = {
          sessionId: native.sessionId,
          projections: native.projections,
          beginSubmission: native.beginSubmission.bind(native),
          prompt: native.prompt.bind(native),
          cancel: native.cancel.bind(native),
          loadOlder: native.loadOlder.bind(native),
          loadThrough: native.loadThrough.bind(native),
          updateQueue: native.updateQueue.bind(native),
          rename: native.rename.bind(native),
          command: native.command.bind(native),
          readAttachment: native.readAttachment.bind(native),
          subscribe(listener) {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          },
          getSnapshot() {
            if (cached !== undefined) return cached
            const pending = status.getSnapshot().get(id)?.pendingInteraction
            const input = (inbox.getSnapshot() as InboxState | undefined) ?? EMPTY_INBOX
            cached = {
              ...native.getSnapshot(),
              chat: chat.getSnapshot() ?? EMPTY_CHAT,
              queue: [
                ...input['next-turn'].map(message => queuedMessage(message, 'queued')),
                ...input['next-step'].map(message => queuedMessage(message, 'steering')),
              ],
              pending: pending?.kind === 'approval' || pending?.kind === 'question' || pending?.kind === 'plan-review'
                ? [pending as PendingInteraction]
                : [],
            }
            return cached
          },
        }
        let released = false
        return {
          session,
          ready: reference.ready,
          release() {
            if (released) return
            released = true
            for (const dispose of disposers) dispose()
            listeners.clear()
            reference.release()
          },
        }
      } catch (error) {
        for (const dispose of disposers) dispose()
        void reference.ready.catch(() => {})
        reference.release()
        throw error
      }
    },
  }
}

function queuedMessage(message: UserMessage, placement: QueuedMessage['placement']): QueuedMessage {
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  const textOnly = message.content.every(block => block.type === 'text')
  return { id: message.id, placement, text: textOnly ? text : null, preview: text || '附件消息' }
}
