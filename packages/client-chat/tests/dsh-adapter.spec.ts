import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '../src/dsh-adapter.ts'
import { createChatSessions } from '../src/dsh-adapter.ts'
import { describe, expect, it, vi } from 'vitest'

function observable<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    listeners,
    getSnapshot: () => value,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    publish(next: T) { value = next; for (const listener of listeners) listener() },
  }
}

function harness() {
  const lifecycle = observable({ sessionId: 'session-1', running: false, openState: 'open' })
  const chat = observable({ order: ['assistant-1'], nodes: { get: () => undefined } })
  const inbox = observable({
    'next-turn': [{ id: 'queue-1', content: [{ type: 'text', text: '下一问' }] }],
    'next-step': [{ id: 'steer-1', content: [{ type: 'text', text: '立即补充' }] }],
  })
  const status = observable(new Map<string, { pendingInteraction?: unknown }>())
  const native = {
    ...lifecycle,
    sessionId: 'session-1',
    projections: { faceOf: vi.fn(() => inbox) },
    beginSubmission: vi.fn(), prompt: vi.fn().mockResolvedValue({ ok: true }),
    cancel: vi.fn(), loadOlder: vi.fn(), loadThrough: vi.fn(), updateQueue: vi.fn(),
    rename: vi.fn(), command: vi.fn(), readAttachment: vi.fn(),
  }
  const release = vi.fn()
  const reference = { binding: { session: native }, ready: Promise.resolve(), release }
  const retain = vi.fn(() => reference)
  const conversation = { activate: vi.fn(), target: vi.fn(() => chat) }
  const binding = vi.fn(() => conversation)
  const context = {
    sessions: { list: observable({}), retain },
    uiConversation: { binding },
    uiSession: { sessionStatus: status },
  } as unknown as Context
  return { context, lifecycle, chat, inbox, status, native, release, retain, conversation, binding, reference }
}

describe('DSH 0.2 chat source ownership', () => {
  it('retains an explicit session and joins separately published transcript, inbox, and interaction state', () => {
    const h = harness()
    const reference = createChatSessions(h.context).retain('session-1' as SessionId)
    expect(h.retain).toHaveBeenCalledWith('session-1', { source: 'hanaiChat' })
    expect(h.conversation.activate).toHaveBeenCalledWith('chat')
    const before = reference.session.getSnapshot()
    expect(reference.session.getSnapshot()).toBe(before)
    expect(before.chat.order).toEqual(['assistant-1'])
    expect(before.queue).toEqual([
      { id: 'queue-1', placement: 'queued', text: '下一问', preview: '下一问' },
      { id: 'steer-1', placement: 'steering', text: '立即补充', preview: '立即补充' },
    ])
    const listener = vi.fn()
    const unsubscribe = reference.session.subscribe(listener)
    const pending = { kind: 'approval', key: 'approval-1' }
    h.status.publish(new Map([['session-1', { pendingInteraction: pending }]]))
    expect(listener).toHaveBeenCalledOnce()
    expect(reference.session.getSnapshot().pending).toEqual([pending])
    expect(reference.session.getSnapshot()).not.toBe(before)
    h.chat.publish({ order: ['assistant-1', 'assistant-2'], nodes: { get: () => undefined } })
    expect(reference.session.getSnapshot().chat.order).toHaveLength(2)
    unsubscribe()
    reference.release()
  })

  it('releases every source subscription and the underlying reference exactly once', () => {
    const h = harness()
    const reference = createChatSessions(h.context).retain('session-1' as SessionId)
    const listener = vi.fn()
    reference.session.subscribe(listener)
    reference.release()
    reference.release()
    expect(h.release).toHaveBeenCalledOnce()
    for (const source of [h.lifecycle, h.chat, h.inbox, h.status]) expect(source.listeners.size).toBe(0)
    h.lifecycle.publish({ sessionId: 'session-1', running: true, openState: 'open' })
    expect(listener).not.toHaveBeenCalled()
  })

  it('releases a reference when the conversation assembly cannot bind it', () => {
    const h = harness()
    h.binding.mockImplementation(() => { throw new Error('unknown session') })
    expect(() => createChatSessions(h.context).retain('session-1' as SessionId)).toThrow('unknown session')
    expect(h.release).toHaveBeenCalledOnce()
  })
})
