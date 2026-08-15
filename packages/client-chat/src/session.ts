import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type {
  ConversationSnapshot,
  ISessions,
  QueuedMessage,
  SessionFace,
  SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'

/** Smallest DSH Sessions surface needed by the standalone chat panel. */
export type ChatSessions = Pick<ISessions, 'list' | 'open' | 'binding'>

export type ChatSessionPhase = 'idle' | 'loading' | 'ready' | 'missing' | 'error'

export interface UseDshChatSessionOptions {
  /** Runtime-owned DSH Sessions service (`ctx.sessions`). */
  sessions: ChatSessions
  /** Persistent ordinary DSH Session id stored on the Hanai judgement. */
  sessionId: string | null | undefined
  /** Select the requested Session so DSH opens and maintains its folded history window. */
  autoOpen?: boolean
}

export interface ChatSessionActions {
  send(text: string, mode: 'queue' | 'steer'): Promise<void>
  cancel(): Promise<void>
  loadOlder(): Promise<void>
  editQueue(item: QueuedMessage, text: string): Promise<void>
  removeQueue(item: QueuedMessage): Promise<void>
  steerQueue(item: QueuedMessage): Promise<void>
}

export interface DshChatSessionState {
  phase: ChatSessionPhase
  session: SessionFace | null
  snapshot: ConversationSnapshot | null
  error: Error | null
  actionError: Error | null
  actions: ChatSessionActions | null
  clearActionError(): void
}

const NOOP_SUBSCRIBE = (): (() => void) => () => {}

/** Convert a DSH RPC result into an exception-friendly component action. */
function assertAccepted(
  operation: string,
  result: { ok: true } | { ok: false; error: { code: string; message: string } },
): void {
  if (result.ok) return
  throw new Error(`${operation} failed: ${result.error.code}: ${result.error.message}`)
}

/**
 * Subscribe to a Session selector without importing DSH's React renderer.
 * Equal selections retain their previous identity, which lets memoized chat rows
 * ignore unrelated stream and queue publications.
 */
export function useSessionSelector<Selected>(
  session: SessionFace,
  selector: (snapshot: ConversationSnapshot) => Selected,
  equal: (left: Selected, right: Selected) => boolean = Object.is,
): Selected {
  const selectorRef = useRef(selector)
  const equalRef = useRef(equal)
  const selectedRef = useRef<{ value: Selected } | undefined>(undefined)
  selectorRef.current = selector
  equalRef.current = equal

  const getSelected = useCallback((): Selected => {
    const next = selectorRef.current(session.getSnapshot())
    const previous = selectedRef.current
    if (previous !== undefined && equalRef.current(previous.value, next)) return previous.value
    selectedRef.current = { value: next }
    return next
  }, [session])

  const subscribe = useCallback((listener: () => void): (() => void) => {
    let previous = getSelected()
    return session.subscribe(() => {
      const next = getSelected()
      if (equalRef.current(previous, next)) return
      previous = next
      listener()
    })
  }, [getSelected, session])

  return useSyncExternalStore(subscribe, getSelected, getSelected)
}

/**
 * Resolve, select, and observe one persisted DSH Session.
 * `sessions.open()` is intentional: DSH only opens/folds history for its current
 * Session, while `binding()` alone is a side-effect-free resolver.
 */
export function useDshChatSession({
  sessions,
  sessionId,
  autoOpen = true,
}: UseDshChatSessionOptions): DshChatSessionState {
  const subscribeList = useCallback(
    (listener: () => void) => sessions.list.subscribe(listener),
    [sessions],
  )
  const getList = useCallback(() => sessions.list.getSnapshot(), [sessions])
  const list = useSyncExternalStore(subscribeList, getList, getList)
  const brandedId = sessionId == null ? null : sessionId as SessionId
  const listed = brandedId !== null && list.byId[brandedId] !== undefined
  const session = brandedId === null ? null : sessions.binding(brandedId)?.session ?? null
  const [openError, setOpenError] = useState<Error | null>(null)
  const [actionError, setActionError] = useState<Error | null>(null)

  useEffect(() => {
    setOpenError(null)
    setActionError(null)
  }, [sessionId])

  useEffect(() => {
    if (!autoOpen || brandedId === null || !listed || list.current === brandedId) return
    try {
      sessions.open(brandedId)
    } catch (cause) {
      setOpenError(toError(cause))
    }
  }, [autoOpen, brandedId, list.current, listed, sessions])

  const subscribeSession = useCallback(
    (listener: () => void) => session?.subscribe(listener) ?? NOOP_SUBSCRIBE(),
    [session],
  )
  const getSessionSnapshot = useCallback(
    () => session?.getSnapshot(),
    [session],
  )
  const snapshot = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionSnapshot,
  ) ?? null

  const run = useCallback(async (operation: () => Promise<void>): Promise<void> => {
    setActionError(null)
    try {
      await operation()
    } catch (cause) {
      const error = toError(cause)
      setActionError(error)
      throw error
    }
  }, [])

  const actions = useMemo<ChatSessionActions | null>(() => session === null ? null : ({
    send: (text, mode) => run(async () => {
      const result = await session.prompt([{ type: 'text', text }], mode)
      assertAccepted('session.prompt', result)
    }),
    cancel: () => run(async () => {
      const result = await session.cancel()
      assertAccepted('session.cancel', result)
    }),
    loadOlder: () => run(() => session.loadOlder()),
    editQueue: (item, text) => run(async () => {
      const result = await session.updateQueue(item.id, {
        kind: 'edit',
        content: [{ type: 'text', text }],
      })
      assertAccepted('session.updateQueue(edit)', result)
    }),
    removeQueue: item => run(async () => {
      const result = await session.updateQueue(item.id, { kind: 'remove' })
      assertAccepted('session.updateQueue(remove)', result)
    }),
    steerQueue: item => run(async () => {
      const result = await session.updateQueue(item.id, { kind: 'steer' })
      if (!result.ok && (
        result.error.code === 'steer-unavailable'
        || result.error.code === 'queue-item-not-found'
      )) return
      assertAccepted('session.updateQueue(steer)', result)
    }),
  }), [run, session])
  const clearActionError = useCallback(() => { setActionError(null) }, [])

  let phase: ChatSessionPhase
  let error: Error | null = openError
  if (sessionId == null || sessionId === '') phase = 'idle'
  else if (openError !== null) phase = 'error'
  else if (list.phase === 'pending') phase = 'loading'
  else if (session === null) phase = 'missing'
  // DSH removes a deleted ordinary Session from list.byId, but deliberately
  // stages its binding and folded snapshot so the selected transcript remains
  // readable. Preserve that tombstone before applying the list membership gate.
  else if (snapshot?.removed === true) phase = 'ready'
  else if (!listed) phase = 'missing'
  else if (snapshot === null || snapshot.openState === 'cold' || snapshot.openState === 'loading') phase = 'loading'
  else if (snapshot.openState === 'error') {
    phase = 'error'
    error = new Error(snapshot.openError?.message ?? 'DSH Session history could not be opened')
  } else phase = 'ready'

  return {
    phase,
    session,
    snapshot,
    error,
    actionError,
    actions,
    clearActionError,
  }
}

export function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}
