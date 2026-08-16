import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import type {
  AssistantBlock,
  ClientContext,
  PendingInteraction,
  QueuedMessage,
  SessionFace,
  ToolCallBlock,
  ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  answerApproval,
  answerQuestion,
  cancelQuestion,
  type ApprovalWait,
  type QuestionAnswer,
  type QuestionWait,
} from './pending.ts'
import { formatJson } from './format.ts'
import {
  useDshChatSession,
  useSessionSelector,
  type ChatSessionActions,
  type ChatSessions,
  toError,
} from './session.ts'
import css from './ChatPanel.module.css'

/** Stable workbench-facing integration contract. */
export interface ChatPanelProps {
  clientContext: ClientContext
  sessionId: string
  compact?: boolean
  /** Remove the inner title bar when the host already renders equivalent context. */
  hideHeader?: boolean
  /** Temporarily hide the composer while preserving history and pending responses. */
  readOnlyReason?: string
  title?: ReactNode
  intro?: ReactNode
  headerActions?: ReactNode
  onClose?: () => void
}

/** Workbench adapter: pass the browser plugin Context and judgement Session id. */
export function ChatPanel({
  clientContext,
  sessionId,
  compact = false,
  hideHeader = false,
  readOnlyReason,
  title,
  intro,
  headerActions,
  onClose,
}: ChatPanelProps) {
  return (
    <DshChatPanel
      sessions={clientContext.sessions}
      sessionId={sessionId}
      compact={compact}
      hideHeader={hideHeader}
      {...readOnlyReason === undefined ? {} : { readOnlyReason }}
      {...title === undefined ? {} : { title }}
      {...intro === undefined ? {} : { intro }}
      {...headerActions === undefined ? {} : { headerActions }}
      {...onClose === undefined ? {} : { onClose }}
    />
  )
}

export interface DshChatPanelProps {
  /** DSH browser runtime's `ctx.sessions` service. */
  sessions: ChatSessions
  /** Persistent Session id associated with a judgement/report. */
  sessionId: string | null | undefined
  /** Header label; defaults to “继续与大师对话”. */
  title?: ReactNode
  /** Optional report/version summary rendered before the conversation flow. */
  intro?: ReactNode
  /** Optional controls owned by the workbench (model picker, report link, etc.). */
  headerActions?: ReactNode
  /** Use the denser, single-line embedded layout. */
  compact?: boolean
  /** Remove the inner title bar when the host already renders equivalent context. */
  hideHeader?: boolean
  className?: string
  autoOpen?: boolean
  /** Workbench lifecycle guard, e.g. while the report turn is still sealing. */
  readOnlyReason?: string
  onClose?: () => void
}

/** Reset hook and composer state whenever the report points at another Session. */
export function DshChatPanel(props: DshChatPanelProps) {
  const instanceKey = props.sessionId == null || props.sessionId === ''
    ? '__hanai-no-session__'
    : props.sessionId
  return <DshChatPanelInstance key={instanceKey} {...props} />
}

/**
 * Completely custom React chat surface over DSH's folded Session object.
 * It imports no DSH Chat renderer, primitive component, Tailwind, or shadcn code.
 */
function DshChatPanelInstance({
  sessions,
  sessionId,
  title = '继续与大师对话',
  intro,
  headerActions,
  compact = false,
  hideHeader = false,
  className,
  autoOpen,
  readOnlyReason,
  onClose,
}: DshChatPanelProps) {
  const state = useDshChatSession({ sessions, sessionId, ...(autoOpen === undefined ? {} : { autoOpen }) })
  const rootClassName = [css.panel, compact ? css.compact : '', className ?? '']
    .filter(Boolean)
    .join(' ')

  return (
    <section className={rootClassName} aria-label="大师对话">
      {!hideHeader && (
        <header className={css.header}>
          <div className={css.headingGroup}>
            <span className={css.eyebrow}>HANAI WORTH</span>
            <h2 className={css.title}>{title}</h2>
          </div>
          <div className={css.headerActions}>
            {headerActions}
            {onClose !== undefined && (
              <button className={css.iconButton} type="button" onClick={onClose} aria-label="关闭对话">
                ×
              </button>
            )}
          </div>
        </header>
      )}

      {state.phase === 'idle' && (
        <EmptyState title="尚未创建对话" detail="完成大师研判后，会在这里关联可继续交流的 DSH Session。" />
      )}
      {state.phase === 'loading' && (
        <div className={css.loading} role="status">
          <span className={css.spinner} aria-hidden />
          正在载入大师的完整对话…
        </div>
      )}
      {state.phase === 'missing' && (
        <EmptyState title="对话已不可用" detail="找不到这份报告关联的 DSH Session，可能已被删除或尚未同步。" />
      )}
      {state.phase === 'error' && (
        <EmptyState title="载入对话失败" detail={state.error?.message ?? '未知错误'} tone="error" />
      )}
      {state.phase === 'ready' && state.session !== null && state.actions !== null && (
        <SessionView
          session={state.session}
          actions={state.actions}
          actionError={state.actionError}
          clearActionError={state.clearActionError}
          intro={intro}
          {...readOnlyReason === undefined ? {} : { readOnlyReason }}
        />
      )}
    </section>
  )
}

function EmptyState({
  title,
  detail,
  tone = 'normal',
}: {
  title: string
  detail: string
  tone?: 'normal' | 'error'
}) {
  return (
    <div className={tone === 'error' ? `${css.empty} ${css.emptyError}` : css.empty} role={tone === 'error' ? 'alert' : undefined}>
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  )
}

interface SessionViewProps {
  session: SessionFace
  actions: ChatSessionActions
  actionError: Error | null
  clearActionError(): void
  intro?: ReactNode
  readOnlyReason?: string
}

const SessionView = memo(function SessionView({
  session,
  actions,
  actionError,
  clearActionError,
  intro,
  readOnlyReason: externalReadOnlyReason,
}: SessionViewProps) {
  const order = useSessionSelector(session, snapshot => snapshot.chat.order)
  const queue = useSessionSelector(session, snapshot => snapshot.queue)
  const pending = useSessionSelector(session, snapshot => snapshot.pending)
  const running = useSessionSelector(session, snapshot => snapshot.running)
  const hasMore = useSessionSelector(session, snapshot => snapshot.hasMore)
  const loadingOlder = useSessionSelector(session, snapshot => snapshot.loadingOlder)
  const removed = useSessionSelector(session, snapshot => snapshot.removed)
  const promptError = useSessionSelector(session, snapshot => snapshot.promptError)
  const lastAgentError = useSessionSelector(session, snapshot => snapshot.lastAgentError)
  const subagent = useSessionSelector(session, snapshot => snapshot.subagent)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const viewport = scrollRef.current
    if (viewport === null) return
    if (typeof viewport.scrollTo === 'function') viewport.scrollTo({ top: viewport.scrollHeight, behavior })
    else viewport.scrollTop = viewport.scrollHeight
  }, [])

  useEffect(() => {
    atBottomRef.current = true
    const frame = scheduleFrame(() => { scrollToBottom() })
    return () => { cancelScheduledFrame(frame) }
  }, [scrollToBottom, session.sessionId])

  useEffect(() => {
    if (!atBottomRef.current) return
    const frame = scheduleFrame(() => { scrollToBottom() })
    return () => { cancelScheduledFrame(frame) }
  }, [order, scrollToBottom])

  const handleNodeUpdate = useCallback(() => {
    if (!atBottomRef.current) return
    scrollToBottom()
  }, [scrollToBottom])

  const handleScroll = useCallback(() => {
    const viewport = scrollRef.current
    if (viewport === null) return
    atBottomRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 72
  }, [])

  const loadOlder = useCallback(async () => {
    const viewport = scrollRef.current
    const beforeHeight = viewport?.scrollHeight ?? 0
    const beforeTop = viewport?.scrollTop ?? 0
    await actions.loadOlder()
    scheduleFrame(() => {
      const current = scrollRef.current
      if (current === null) return
      current.scrollTop = beforeTop + current.scrollHeight - beforeHeight
    })
  }, [actions])

  const sessionReadOnlyReason = removed
    ? '这条 Session 已被删除，历史仍可阅读。'
    : subagent?.address.mode === 'one-shot'
      ? '一次性子 Agent 对话不可继续。'
      : subagent !== null && !subagent.parentAvailable
        ? '父 Agent 当前不可用，暂时无法继续该子对话。'
        : null
  const readOnlyReason = externalReadOnlyReason ?? sessionReadOnlyReason

  return (
    <div className={css.session}>
      <div
        className={css.transcript}
        ref={scrollRef}
        onScroll={handleScroll}
        role="region"
        aria-label="大师对话记录"
        tabIndex={0}
      >
        {hasMore && (
          <button
            className={css.loadOlder}
            type="button"
            disabled={loadingOlder}
            onClick={() => { void loadOlder().catch(() => undefined) }}
          >
            {loadingOlder ? '正在载入…' : '载入更早记录'}
          </button>
        )}

        {intro !== undefined && <div className={css.intro}>{intro}</div>}

        {order.length === 0 && !running && (
          <div className={css.zeroConversation}>这条 Session 还没有可显示的对话。</div>
        )}

        <div
          className={css.flow}
          role="log"
          aria-label="对话记录"
          aria-live="polite"
          aria-relevant="additions"
        >
          {order.map(nodeKey => (
            <ChatNodeRow
              key={nodeKey}
              nodeKey={nodeKey}
              session={session}
              onUpdated={handleNodeUpdate}
            />
          ))}
          {running && (
            <div className={css.runningStatus} role="status">
              <span className={css.pulse} aria-hidden />
              大师正在研判
            </div>
          )}
        </div>
      </div>

      <div className={css.controls}>
        {pending.length > 0 && <PendingInteractions waits={pending} session={session} />}
        {queue.length > 0 && (
          <QueuePanel items={queue} actions={actions} readOnly={readOnlyReason !== null} />
        )}
        {(actionError !== null || promptError !== null || lastAgentError !== null) && (
          <div className={css.errorStrip} role="alert">
            <span>{actionError?.message ?? promptError?.error.message ?? lastAgentError}</span>
            {actionError !== null && (
              <button type="button" onClick={clearActionError} aria-label="关闭错误">×</button>
            )}
          </div>
        )}
        {readOnlyReason !== null
          ? <div className={css.readOnlyNotice}>{readOnlyReason}</div>
          : <Composer actions={actions} running={running} canSteer={subagent === null} />}
      </div>
    </div>
  )
})

const ChatNodeRow = memo(function ChatNodeRow({
  nodeKey,
  session,
  onUpdated,
}: {
  nodeKey: string
  session: SessionFace
  onUpdated(): void
}) {
  const node = useSessionSelector(session, snapshot => snapshot.chat.nodes.get(nodeKey)) as ChatNode | undefined

  useLayoutEffect(() => {
    if (node !== undefined) onUpdated()
  }, [node, onUpdated])

  if (node === undefined || node.visibility === 'hidden' || node.kind === 'turn-tail') return null

  switch (node.kind) {
    case 'user':
      return <MessageCard role="user" label="你"><ContentBlocks blocks={node.data.content} /></MessageCard>
    case 'steering':
      return <MessageCard role="user" label="你 · 插话"><ContentBlocks blocks={node.data.content} /></MessageCard>
    case 'context':
      return (
        <ContextCard label={`上下文 · ${node.data.provenance.label ?? node.data.provenance.role}`}>
          <ContentBlocks blocks={node.data.content} />
        </ContextCard>
      )
    case 'assistant-step':
      return (
        <MessageCard role="assistant" label={node.data.status === 'running' ? '大师 · 输出中' : '大师'}>
          <AssistantBlocks blocks={node.data.blocks} running={node.data.status === 'running'} />
          {node.data.status === 'interrupted' && <span className={css.interrupted}>已停止</span>}
        </MessageCard>
      )
    case 'tool-call':
      return <ToolCard block={node.data.root} depth={0} />
    case 'command':
      return <CommandCard command={node.data} />
    case 'manual-compaction':
      return (
        <div className={css.systemCard}>
          <CommandCard command={node.data.command} />
          {node.data.compaction !== null && <CompactionCard data={node.data.compaction} />}
        </div>
      )
    case 'compaction':
      return <CompactionCard data={node.data} />
    case 'model-retry':
      return (
        <div className={css.systemCard} role="status">
          模型请求重试 {node.data.current.retry}
          {node.data.current.retryState === 'scheduled' && `，约 ${Math.ceil(node.data.current.delayMs / 1000)} 秒后继续`}
          {node.data.current.retryState === 'cancelled' && '，已取消'}
        </div>
      )
    case 'turn-error':
      return <div className={`${css.systemCard} ${css.systemError}`} role="alert">本轮失败：{node.data.message}</div>
    case 'turn-max-tokens':
      return <div className={css.systemCard}>本轮达到最大输出长度，可发送“继续”让大师接着回答。</div>
    case 'unknown':
      return (
        <details className={css.systemCard}>
          <summary>未识别的会话事件：{node.data.type}</summary>
          <pre className={css.code}>{formatJson(node.data.data)}</pre>
        </details>
      )
    default:
      return null
  }
})

function MessageCard({ role, label, children }: { role: 'user' | 'assistant' | 'context'; label: string; children: ReactNode }) {
  return (
    <article className={`${css.message} ${css[`message_${role}`]}`}>
      <div className={css.messageLabel}>{label}</div>
      <div className={css.messageBody}>{children}</div>
    </article>
  )
}

function ContextCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className={css.contextCard}>
      <summary>{label}</summary>
      <div className={css.contextBody}>{children}</div>
    </details>
  )
}

function scheduleFrame(callback: FrameRequestCallback): number {
  return typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(callback)
    : window.setTimeout(() => { callback(performance.now()) }, 0)
}

function cancelScheduledFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle)
  else window.clearTimeout(handle)
}

function ContentBlocks({ blocks }: { blocks: readonly unknown[] }) {
  return <>{blocks.map((block, index) => <ContentBlockView key={index} block={block} />)}</>
}

function ContentBlockView({ block }: { block: unknown }) {
  if (typeof block !== 'object' || block === null) return <pre className={css.text}>{String(block)}</pre>
  const value = block as Record<string, unknown>
  switch (value.type) {
    case 'text':
      return <div className={css.text}>{typeof value.text === 'string' ? value.text : ''}</div>
    case 'reasoning':
      return (
        <details className={css.reasoning}>
          <summary>思考过程</summary>
          <div className={css.text}>{typeof value.text === 'string' ? value.text : ''}</div>
        </details>
      )
    case 'image':
      return <div className={css.attachment}>图片附件</div>
    case 'tool-call':
      return (
        <details className={css.inlineTool}>
          <summary>准备调用工具 · {typeof value.name === 'string' ? value.name : 'unknown'}</summary>
          <pre className={css.code}>{formatJson(value.arguments)}</pre>
        </details>
      )
    case 'tool-result':
      return Array.isArray(value.content)
        ? <ContentBlocks blocks={value.content} />
        : <pre className={css.code}>{formatJson(value)}</pre>
    default:
      return <pre className={css.code}>{formatJson(value)}</pre>
  }
}

function AssistantBlocks({ blocks, running }: { blocks: readonly AssistantBlock[]; running: boolean }) {
  if (blocks.length === 0 && running) return <span className={css.muted}>正在组织观点…</span>
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'text': return <div className={css.text} key={index}>{block.text}<StreamingCaret show={running && index === blocks.length - 1} /></div>
          case 'reasoning': return (
            <details className={css.reasoning} key={index} open={running || undefined}>
              <summary>{running ? '正在思考' : '思考过程'}</summary>
              <div className={css.text}>{block.text}</div>
            </details>
          )
          case 'image': return <div className={css.attachment} key={index}>大师生成的图片</div>
          case 'tool-call': return (
            <details className={css.inlineTool} key={index}>
              <summary>准备调用工具 · {block.name || 'unknown'}</summary>
              <pre className={css.code}>{formatJson(block.argsRaw)}</pre>
            </details>
          )
          case 'other': return <pre className={css.code} key={index}>{formatJson(block.block)}</pre>
        }
      })}
    </>
  )
}

function StreamingCaret({ show }: { show: boolean }) {
  return show ? <span className={css.caret} aria-hidden /> : null
}

function ToolCard({ block, depth }: { block: ToolCallBlock; depth: number }) {
  const settled = isSettledTool(block)
  const name = settled ? block.call?.name ?? block.callId : block.name
  const args = settled ? block.call?.argsRaw ?? '' : block.argsRaw
  const argsPreview = inlinePreview(args)
  const failed = settled && block.isError
  return (
    <article className={`${css.tool} ${failed ? css.toolError : ''}`} data-depth={depth}>
      <details open={!settled || failed || undefined}>
        <summary className={css.toolSummary}>
          <span className={settled ? css.toolSettled : css.toolRunning} aria-hidden />
          <span className={css.toolName} title={name || 'unknown tool'}>{name || 'unknown tool'}</span>
          <span className={css.toolArgsPreview} title={args}>{argsPreview}</span>
          <span className={css.toolState}>{settled ? failed ? '失败' : '完成' : '运行中'}</span>
        </summary>
        {args !== '' && (
          <div className={css.toolSection}>
            <span>参数</span>
            <div className={css.toolSectionBody}>
              <pre className={css.code}>{formatJson(args)}</pre>
            </div>
          </div>
        )}
        {settled && (
          <div className={css.toolSection}>
            <span>结果</span>
            <div className={css.toolSectionBody}>
              <ContentBlocks blocks={block.content} />
              {block.error !== undefined && <pre className={css.code}>{formatJson(block.error)}</pre>}
            </div>
          </div>
        )}
      </details>
      {block.subCalls.length > 0 && (
        <div className={css.subTools}>
          {block.subCalls.map(child => <ToolCard key={child.callId} block={child} depth={depth + 1} />)}
        </div>
      )}
    </article>
  )
}

function inlinePreview(value: string, limit = 92): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length <= limit) return compact
  return `${compact.slice(0, limit - 1)}…`
}

function isSettledTool(block: ToolCallBlock): block is ToolResultNode {
  return 'kind' in block && block.kind === 'tool-result'
}

function CommandCard({ command }: { command: Extract<ChatNode, { kind: 'command' }>['data'] }) {
  const name = command.name === null ? '未知命令' : `/${command.name}${command.args ?? ''}`
  return (
    <details className={css.systemCard}>
      <summary>{name} · {command.outcome === null ? '执行中' : command.outcome.kind === 'success' ? '完成' : '失败'}</summary>
      {command.outcome?.text !== undefined && <div className={css.text}>{command.outcome.text}</div>}
    </details>
  )
}

function CompactionCard({ data }: { data: Extract<ChatNode, { kind: 'compaction' }>['data'] }) {
  return (
    <details className={css.systemCard}>
      <summary>上下文已压缩{data.shadowedItemCount === null ? '' : ` · ${data.shadowedItemCount} 项`}</summary>
      {data.summary !== null && <div className={css.text}>{data.summary}</div>}
    </details>
  )
}

function QueuePanel({
  items,
  actions,
  readOnly,
}: {
  items: readonly QueuedMessage[]
  actions: ChatSessionActions
  readOnly: boolean
}) {
  return (
    <section className={css.queue} aria-label="待处理消息">
      <div className={css.sectionTitle}>待处理消息 · {items.length}</div>
      {items.map(item => (
        <QueueRow key={item.id} item={item} actions={actions} readOnly={readOnly} />
      ))}
    </section>
  )
}

function QueueRow({
  item,
  actions,
  readOnly,
}: {
  item: QueuedMessage
  actions: ChatSessionActions
  readOnly: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.text ?? '')
  const [busy, setBusy] = useState<'edit' | 'remove' | 'steer' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!editing) setDraft(item.text ?? '')
  }, [editing, item.text])

  useEffect(() => {
    if (readOnly) setEditing(false)
  }, [readOnly])

  const invoke = async (kind: NonNullable<typeof busy>, operation: () => Promise<void>) => {
    setBusy(kind)
    setError(null)
    try {
      await operation()
      setEditing(false)
    } catch (cause) {
      setError(toError(cause).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={css.queueRow}>
      <span className={css.queueBadge}>{item.placement === 'queued' ? '排队' : item.placement === 'steering' ? '插话中' : '上下文'}</span>
      {editing && !readOnly ? (
        <textarea className={css.queueEdit} value={draft} onChange={event => { setDraft(event.target.value) }} aria-label="编辑排队消息" />
      ) : (
        <span className={css.queuePreview}>{item.preview}</span>
      )}
      {item.placement === 'queued' && !readOnly && (
        <div className={css.queueActions}>
          {editing ? (
            <>
              <button type="button" disabled={busy !== null || draft.trim() === ''} onClick={() => { void invoke('edit', () => actions.editQueue(item, draft)) }}>保存</button>
              <button type="button" disabled={busy !== null} onClick={() => { setEditing(false) }}>取消</button>
            </>
          ) : (
            <>
              {item.text !== null && <button type="button" disabled={busy !== null} onClick={() => { setEditing(true) }}>编辑</button>}
              <button type="button" disabled={busy !== null} onClick={() => { void invoke('steer', () => actions.steerQueue(item)) }}>立即插入</button>
              <button type="button" disabled={busy !== null} onClick={() => { void invoke('remove', () => actions.removeQueue(item)) }}>移除</button>
            </>
          )}
        </div>
      )}
      {error !== null && <span className={css.rowError} role="alert">{error}</span>}
    </div>
  )
}

function PendingInteractions({
  waits,
  session,
}: {
  waits: readonly PendingInteraction[]
  session: SessionFace
}) {
  return (
    <section
      className={css.pending}
      aria-label="等待你的决定"
      aria-live="polite"
      aria-relevant="additions"
    >
      {waits.map(wait => wait.kind === 'approval'
        ? <ApprovalCard key={wait.key} wait={wait} session={session} />
        : <QuestionCard key={wait.key} wait={wait} />)}
    </section>
  )
}

function ApprovalCard({ wait, session }: { wait: ApprovalWait; session: SessionFace }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const call = useSessionSelector(session, snapshot => (
    wait.payload.callId === undefined
      ? null
      : findToolCall(snapshot, String(wait.payload.callId))
  ))
  const callName = call === null
    ? wait.payload.toolName
    : isSettledTool(call) ? call.call?.name ?? call.callId : call.name
  const callArgs = call === null
    ? null
    : isSettledTool(call) ? call.call?.argsRaw ?? '' : call.argsRaw

  const decide = async (outcome: 'allowed-once' | 'rejected') => {
    setBusy(true)
    setError(null)
    try {
      await answerApproval(wait, outcome)
    } catch (cause) {
      setBusy(false)
      setError(toError(cause).message)
    }
  }

  return (
    <article className={css.pendingCard}>
      <div className={css.sectionTitle}>工具授权</div>
      <strong>{wait.payload.reason ?? `大师希望调用 ${wait.payload.toolName}`}</strong>
      <span className={css.pendingDetail}>工具：{wait.payload.toolName}</span>
      {callArgs !== null && (
        <details className={css.inlineTool} open>
          <summary>将执行：{callName}</summary>
          <pre className={css.code}>{callArgs === '' ? '（无参数）' : formatJson(callArgs)}</pre>
        </details>
      )}
      <div className={css.pendingActions}>
        <button className={css.primaryButton} type="button" disabled={busy} onClick={() => { void decide('allowed-once') }}>仅本次允许</button>
        <button type="button" disabled={busy} onClick={() => { void decide('rejected') }}>拒绝</button>
      </div>
      {error !== null && <span className={css.rowError} role="alert">{error}</span>}
    </article>
  )
}

function findToolCall(snapshot: ReturnType<SessionFace['getSnapshot']>, callId: string): ToolCallBlock | null {
  for (const nodeKey of snapshot.chat.order) {
    const node = snapshot.chat.nodes.get(nodeKey) as ChatNode | undefined
    if (node?.kind !== 'tool-call') continue
    const pending: ToolCallBlock[] = [node.data.root]
    while (pending.length > 0) {
      const candidate = pending.pop() as ToolCallBlock
      if (candidate.callId === callId) return candidate
      pending.push(...candidate.subCalls)
    }
  }
  return null
}

interface QuestionDraft {
  selected: string[]
  custom: string
}

function QuestionCard({ wait }: { wait: QuestionWait }) {
  const questions = wait.payload.questions
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() => questions.map(() => ({ selected: [], custom: '' })))
  const [busy, setBusy] = useState<'answer' | 'cancel' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const update = (index: number, transform: (draft: QuestionDraft) => QuestionDraft) => {
    setDrafts(current => current.map((draft, draftIndex) => draftIndex === index ? transform(draft) : draft))
    setError(null)
  }

  const choose = (index: number, label: string, multiSelect: boolean) => {
    update(index, (draft) => {
      if (!multiSelect) return { selected: [label], custom: '' }
      const selected = draft.selected.includes(label)
        ? draft.selected.filter(value => value !== label)
        : [...draft.selected, label]
      return { ...draft, selected }
    })
  }

  const submit = async () => {
    const incomplete = drafts.findIndex(draft => draft.selected.length === 0 && draft.custom.trim() === '')
    if (incomplete >= 0) {
      setError(`请回答第 ${incomplete + 1} 个问题`)
      return
    }
    const answer: QuestionAnswer = {
      answers: questions.map((question, index) => {
        const draft = drafts[index] as QuestionDraft
        const custom = draft.custom.trim()
        return {
          id: question.id,
          selected: custom === '' || question.multiSelect === true ? draft.selected : [],
          ...(custom === '' ? {} : { custom }),
        }
      }),
    }
    setBusy('answer')
    setError(null)
    try {
      await answerQuestion(wait, answer)
    } catch (cause) {
      setBusy(null)
      setError(toError(cause).message)
    }
  }

  const cancel = async () => {
    setBusy('cancel')
    setError(null)
    try {
      await cancelQuestion(wait)
    } catch (cause) {
      setBusy(null)
      setError(toError(cause).message)
    }
  }

  return (
    <article className={css.pendingCard}>
      <div className={css.sectionTitle}>大师需要你的补充</div>
      {questions.map((question, index) => {
        const draft = drafts[index] as QuestionDraft
        const options = question.options ?? []
        return (
          <fieldset className={css.question} key={question.id}>
            <legend>{question.header ?? question.question}</legend>
            {question.header !== undefined && <span className={css.pendingDetail}>{question.question}</span>}
            {question.detail !== undefined && <div className={css.questionDetail}>{question.detail}</div>}
            {options.length > 0 && (
              <div className={css.options}>
                {options.map(option => (
                  <label className={css.option} key={option.label}>
                    <input
                      type={question.multiSelect === true ? 'checkbox' : 'radio'}
                      name={`${wait.key}-${question.id}`}
                      checked={draft.selected.includes(option.label)}
                      disabled={busy !== null}
                      onChange={() => { choose(index, option.label, question.multiSelect === true) }}
                    />
                    <span><strong>{option.label}</strong>{option.description !== undefined && <small>{option.description}</small>}</span>
                  </label>
                ))}
              </div>
            )}
            <textarea
              className={css.customAnswer}
              value={draft.custom}
              disabled={busy !== null}
              placeholder={options.length > 0 ? '其他答案（可选）' : '请输入回答'}
              aria-label={`${question.question}的自定义回答`}
              onChange={(event) => {
                const custom = event.target.value
                update(index, current => ({
                  selected: question.multiSelect === true ? current.selected : [],
                  custom,
                }))
              }}
            />
          </fieldset>
        )
      })}
      <div className={css.pendingActions}>
        <button className={css.primaryButton} type="button" disabled={busy !== null} onClick={() => { void submit() }}>提交回答</button>
        <button type="button" disabled={busy !== null} onClick={() => { void cancel() }}>取消请求</button>
      </div>
      {error !== null && <span className={css.rowError} role="alert">{error}</span>}
    </article>
  )
}

function Composer({
  actions,
  running,
  canSteer,
}: {
  actions: ChatSessionActions
  running: boolean
  canSteer: boolean
}) {
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<'queue' | 'steer'>('queue')
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const composingRef = useRef(false)
  const compositionTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if ((!running || !canSteer) && mode === 'steer') setMode('queue')
  }, [canSteer, mode, running])

  useEffect(() => () => {
    if (compositionTimerRef.current !== null) window.clearTimeout(compositionTimerRef.current)
  }, [])

  const send = async () => {
    const text = draft.trim()
    if (text === '' || busy) return
    setBusy(true)
    setError(null)
    setDraft('')
    try {
      await actions.send(text, canSteer ? mode : 'queue')
    } catch (cause) {
      setDraft(current => current === '' ? text : current)
      setError(toError(cause).message)
    } finally {
      setBusy(false)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void send()
  }

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // keyCode 229 is retained for browsers that omit nativeEvent.isComposing.
    if (
      event.key !== 'Enter'
      || event.shiftKey
      || composingRef.current
      || event.nativeEvent.isComposing
      || event.nativeEvent.keyCode === 229
    ) return
    event.preventDefault()
    void send()
  }

  const stop = async () => {
    if (stopping) return
    setStopping(true)
    setError(null)
    try {
      await actions.cancel()
    } catch (cause) {
      setError(toError(cause).message)
    } finally {
      setStopping(false)
    }
  }

  return (
    <form className={css.composer} onSubmit={submit}>
      <textarea
        className={css.composerInput}
        value={draft}
        disabled={busy}
        rows={3}
        aria-label="继续与大师对话"
        placeholder="追问大师的判断依据、风险或下一步观察点…"
        onChange={event => { setDraft(event.target.value) }}
        onKeyDown={keyDown}
        onCompositionStart={() => {
          if (compositionTimerRef.current !== null) window.clearTimeout(compositionTimerRef.current)
          compositionTimerRef.current = null
          composingRef.current = true
        }}
        onCompositionEnd={() => {
          compositionTimerRef.current = window.setTimeout(() => {
            composingRef.current = false
            compositionTimerRef.current = null
          }, 10)
        }}
      />
      <div className={css.composerFooter}>
        <div className={css.modeSwitch} role="group" aria-label="发送方式">
          <button
            className={mode === 'queue' ? css.modeActive : ''}
            type="button"
            aria-pressed={mode === 'queue'}
            onClick={() => { setMode('queue') }}
          >排队</button>
          <button
            className={mode === 'steer' ? css.modeActive : ''}
            type="button"
            aria-pressed={mode === 'steer'}
            disabled={!running || !canSteer}
            onClick={() => { setMode('steer') }}
          >立即插话</button>
        </div>
        <div className={css.sendActions}>
          {running && (
            <button className={css.stopButton} type="button" disabled={busy || stopping} onClick={() => { void stop() }}>{stopping ? '停止中…' : '停止'}</button>
          )}
          <button className={css.sendButton} type="submit" disabled={busy || draft.trim() === ''}>
            {busy ? '发送中…' : mode === 'steer' ? '插话' : '发送'}
          </button>
        </div>
      </div>
      {error !== null && <span className={css.rowError} role="alert">{error}</span>}
    </form>
  )
}
