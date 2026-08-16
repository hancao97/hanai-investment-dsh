// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ConversationSnapshot,
  ISessions,
  SessionFace,
  SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import { DshChatPanel } from '../src/ChatPanel.tsx'

afterEach(() => { cleanup() })

describe('DshChatPanel', () => {
  it('opens the report session, renders folded streaming nodes, and sends queue/steer prompts', async () => {
    const assistant = assistantNode('正在检查现金流', 'running')
    const harness = makeHarness([assistant], true)

    render(<DshChatPanel sessions={harness.sessions} sessionId="session-1" />)

    expect(screen.getByText('HANAI WORTH')).not.toBeNull()
    expect(screen.getByRole('region', { name: '大师对话记录' })).not.toBeNull()
    expect(screen.getByText('正在检查现金流')).not.toBeNull()
    await waitFor(() => { expect(harness.open).toHaveBeenCalledWith('session-1') })

    const input = screen.getByLabelText('继续与大师对话')
    fireEvent.change(input, { target: { value: '请给出最重要的反证' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => {
      expect(harness.prompt).toHaveBeenCalledWith(
        [{ type: 'text', text: '请给出最重要的反证' }],
        'queue',
      )
    })

    fireEvent.click(screen.getByRole('button', { name: '立即插话' }))
    fireEvent.change(input, { target: { value: '先回答风险' } })
    fireEvent.click(screen.getByRole('button', { name: '插话' }))
    await waitFor(() => {
      expect(harness.prompt).toHaveBeenLastCalledWith(
        [{ type: 'text', text: '先回答风险' }],
        'steer',
      )
    })

    act(() => {
      harness.publish([assistantNode('现金流检查完成', 'settled')], false)
    })
    expect(screen.getByText('现金流检查完成')).not.toBeNull()
  })

  it('resets local composer state when the linked session id changes', () => {
    const harness = makeHarness([], false)
    const view = render(<DshChatPanel sessions={harness.sessions} sessionId="session-1" />)

    const input = screen.getByLabelText('继续与大师对话') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '只属于第一条报告的草稿' } })
    expect(input.value).toBe('只属于第一条报告的草稿')

    view.rerender(<DshChatPanel sessions={harness.sessions} sessionId={null} />)
    expect(screen.queryByLabelText('继续与大师对话')).toBeNull()

    view.rerender(<DshChatPanel sessions={harness.sessions} sessionId="session-1" />)
    expect((screen.getByLabelText('继续与大师对话') as HTMLTextAreaElement).value).toBe('')
  })

  it('supports compact headerless embeds and keeps context folded by default', () => {
    const harness = makeHarness([contextNode()], false)

    render(
      <DshChatPanel
        sessions={harness.sessions}
        sessionId="session-1"
        compact
        hideHeader
      />,
    )

    expect(screen.queryByText('HANAI WORTH')).toBeNull()
    expect(screen.queryByRole('heading', { name: '继续与大师对话' })).toBeNull()
    const summary = screen.getByText('上下文 · AGENTS.md')
    expect((summary.closest('details') as HTMLDetailsElement).open).toBe(false)
  })

  it('does not send the Safari closing Enter while Chinese IME composition settles', async () => {
    const harness = makeHarness([], false)
    render(<DshChatPanel sessions={harness.sessions} sessionId="session-1" />)
    const input = screen.getByLabelText('继续与大师对话')

    fireEvent.change(input, { target: { value: '检查估值' } })
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(harness.prompt).not.toHaveBeenCalled()

    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(harness.prompt).not.toHaveBeenCalled()

    await new Promise(resolve => { window.setTimeout(resolve, 15) })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(harness.prompt).toHaveBeenCalledTimes(1) })
  })

  it('keeps a staged deleted session readable after it leaves the session list', () => {
    const harness = makeHarness([], false, { removed: true }, false)

    render(<DshChatPanel sessions={harness.sessions} sessionId="session-1" />)

    expect(screen.getByText('这条 Session 已被删除，历史仍可阅读。')).not.toBeNull()
    expect(screen.queryByLabelText('继续与大师对话')).toBeNull()
    expect(screen.queryByText('对话已不可用')).toBeNull()
  })

  it('does not offer ordinary-session steer semantics for a continuable subagent', async () => {
    const harness = makeHarness([], true, {
      subagent: {
        address: { mode: 'continuable' },
        parentAvailable: true,
      } as never,
    })
    render(<DshChatPanel sessions={harness.sessions} sessionId="session-1" />)

    expect((screen.getByRole('button', { name: '立即插话' }) as HTMLButtonElement).disabled).toBe(true)
    const input = screen.getByLabelText('继续与大师对话')
    fireEvent.change(input, { target: { value: '继续检查' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => {
      expect(harness.prompt).toHaveBeenCalledWith([{ type: 'text', text: '继续检查' }], 'queue')
    })
  })

  it('loads older history, cancels a run, and operates on queued messages', async () => {
    const harness = makeHarness([], true, {
      hasMore: true,
      queue: [{
        id: 'queue-1' as never,
        messageId: 'message-1' as never,
        placement: 'queued',
        content: [{ type: 'text', text: '稍后检查估值' }],
        preview: '稍后检查估值',
        text: '稍后检查估值',
      }],
    })

    render(<DshChatPanel sessions={harness.sessions} sessionId="session-1" />)

    fireEvent.click(screen.getByRole('button', { name: '载入更早记录' }))
    await waitFor(() => { expect(harness.loadOlder).toHaveBeenCalledTimes(1) })

    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    await waitFor(() => { expect(harness.cancel).toHaveBeenCalledTimes(1) })

    fireEvent.click(screen.getByRole('button', { name: '立即插入' }))
    await waitFor(() => {
      expect(harness.updateQueue).toHaveBeenCalledWith('queue-1', { kind: 'steer' })
    })
  })

  it('answers an approval directly from the custom panel', async () => {
    const respond = vi.fn().mockResolvedValue({ accepted: true })
    const harness = makeHarness([toolNode(false)], false, {
      pending: [{
        kind: 'approval',
        key: 'a:approval-rpc',
        sessionId: 'session-1' as never,
        payload: {
          approvalId: 'approval-1' as never,
          callId: 'tool-1' as never,
          toolName: 'financial_lookup',
          reason: '读取最新公告',
        },
        respond,
      } as never],
    })

    render(<DshChatPanel sessions={harness.sessions} sessionId="session-1" />)
    expect(screen.getByText('将执行：financial_lookup')).not.toBeNull()
    expect(screen.getAllByText(/"code": "600519"/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '仅本次允许' }))

    await waitFor(() => {
      expect(respond).toHaveBeenCalledWith({
        ok: true,
        value: {
          sessionId: 'session-1',
          approvalId: 'approval-1',
          outcome: 'allowed-once',
        },
      })
    })
  })

  it('keeps pending responses available while an external lifecycle guard hides the composer', async () => {
    const respond = vi.fn().mockResolvedValue({ accepted: true })
    const harness = makeHarness([], true, {
      queue: [{
        id: 'queue-1' as never,
        messageId: 'message-1' as never,
        placement: 'queued',
        content: [{ type: 'text', text: '稍后检查估值' }],
        preview: '稍后检查估值',
        text: '稍后检查估值',
      }],
      pending: [{
        kind: 'approval',
        key: 'a:approval-rpc',
        sessionId: 'session-1' as never,
        payload: { approvalId: 'approval-1' as never, toolName: 'web', reason: '读取最新公告' },
        respond,
      } as never],
    })

    render(
      <DshChatPanel
        sessions={harness.sessions}
        sessionId="session-1"
        readOnlyReason="报告封存完成后即可继续对话"
      />,
    )

    expect(screen.queryByLabelText('继续与大师对话')).toBeNull()
    expect(screen.getByText('报告封存完成后即可继续对话')).not.toBeNull()
    expect(screen.getByText('稍后检查估值')).not.toBeNull()
    expect(screen.queryByRole('button', { name: '立即插入' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '仅本次允许' }))
    await waitFor(() => { expect(respond).toHaveBeenCalledTimes(1) })
  })

  it('renders tool activity through settlement and submits structured question answers', async () => {
    const respond = vi.fn().mockResolvedValue({ accepted: true })
    const harness = makeHarness([toolNode(false)], true, {
      pending: [{
        kind: 'question',
        key: 'q:question-rpc',
        sessionId: 'session-1' as never,
        payload: {
          questions: [{
            id: 'valuation',
            question: '估值假设应如何调整？',
            options: [{ label: '维持' }, { label: '下调估值', description: '使用更保守的倍数' }],
          }],
        },
        respond,
      } as never],
    })

    render(<DshChatPanel sessions={harness.sessions} sessionId="session-1" />)
    expect(screen.getByText('financial_lookup')).not.toBeNull()
    expect(screen.getByText('{"code":"600519"}')).not.toBeNull()
    expect(screen.getByText('运行中')).not.toBeNull()
    expect((screen.getByText('financial_lookup').closest('details') as HTMLDetailsElement).open).toBe(true)

    fireEvent.click(screen.getByRole('radio', { name: /下调估值/ }))
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }))
    await waitFor(() => {
      expect(respond).toHaveBeenCalledWith({
        ok: true,
        value: {
          sessionId: 'session-1',
          answer: { answers: [{ id: 'valuation', selected: ['下调估值'] }] },
        },
      })
    })

    act(() => { harness.publish([toolNode(true)], false) })
    expect(screen.getByText('完成')).not.toBeNull()
    expect(screen.getByText('自由现金流为正')).not.toBeNull()
    expect((screen.getByText('financial_lookup').closest('details') as HTMLDetailsElement).open).toBe(false)
  })
})

function assistantNode(text: string, status: 'running' | 'settled') {
  return {
    key: 'assistant:1:1',
    id: 'assistant:1:1',
    kind: 'assistant-step',
    target: 'chat',
    anchorSeq: 2,
    location: { kind: 'unresolved' },
    visibility: 'visible',
    data: {
      status,
      turn: 1,
      step: 1,
      blocks: [{ kind: 'text', text }],
      time: 1,
    },
  }
}

function contextNode() {
  return {
    key: 'context:1',
    id: 'context:1',
    kind: 'context',
    target: 'chat',
    anchorSeq: 1,
    location: { kind: 'unresolved' },
    visibility: 'visible',
    data: {
      provenance: { role: 'system', label: 'AGENTS.md' },
      content: [{ type: 'text', text: '研究上下文' }],
    },
  }
}

function toolNode(settled: boolean) {
  const running = {
    callId: 'tool-1',
    name: 'financial_lookup',
    argsRaw: '{"code":"600519"}',
    turn: 1,
    step: 1,
    time: 1,
    callView: null,
    subCalls: [],
  }
  return {
    key: 'tool:1',
    id: 'tool:1',
    kind: 'tool-call',
    target: 'chat',
    anchorSeq: 3,
    location: { kind: 'unresolved' },
    visibility: 'visible',
    data: {
      root: settled ? {
        kind: 'tool-result',
        seq: 4,
        time: 2,
        callId: 'tool-1',
        call: { name: running.name, argsRaw: running.argsRaw },
        callTime: 1,
        content: [{ type: 'text', text: '自由现金流为正' }],
        isError: false,
        callView: null,
        resultView: null,
        subCalls: [],
      } : running,
    },
  }
}

function makeHarness(
  initialNodes: unknown[],
  running: boolean,
  overrides: Partial<ConversationSnapshot> = {},
  listed = true,
) {
  const sessionId = 'session-1' as SessionId
  const listeners = new Set<() => void>()
  let nodes = initialNodes
  let snapshot = makeSnapshot(sessionId, nodes, running, overrides)
  const prompt = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
  const cancel = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
  const updateQueue = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
  const loadOlder = vi.fn().mockResolvedValue(undefined)
  const session = {
    sessionId,
    projections: { faceOf: vi.fn() },
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    prompt,
    cancel,
    updateQueue,
    loadOlder,
    rename: vi.fn(),
    command: vi.fn(),
    readAttachment: vi.fn(),
  } as unknown as SessionFace
  const listSnapshot = {
    ids: listed ? [sessionId] : [],
    byId: listed ? {
      [sessionId]: {
        id: sessionId,
        displayTitle: '大师研判',
        running,
        blank: false,
        updatedAt: 1,
      },
    } : {},
    current: undefined,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
  const open = vi.fn()
  const sessions = {
    list: {
      getSnapshot: () => listSnapshot,
      subscribe: () => () => {},
    },
    open,
    binding: (id: SessionId) => id === sessionId ? { sessionId, session, ctx: {} } : undefined,
  } as unknown as Pick<ISessions, 'list' | 'open' | 'binding'>

  return {
    sessions,
    session,
    open,
    prompt,
    cancel,
    updateQueue,
    loadOlder,
    publish(nextNodes: unknown[], nextRunning: boolean) {
      nodes = nextNodes
      snapshot = makeSnapshot(sessionId, nodes, nextRunning, overrides)
      for (const listener of listeners) listener()
    },
  }
}

function makeSnapshot(
  sessionId: SessionId,
  nodes: unknown[],
  running: boolean,
  overrides: Partial<ConversationSnapshot>,
): ConversationSnapshot {
  const byKey = new Map(nodes.map(node => [(node as { key: string }).key, node]))
  return {
    sessionId,
    views: { get: () => undefined },
    chat: {
      order: [...byKey.keys()],
      nodes: { get: key => byKey.get(key) as never, values: () => [...byKey.values()] as never },
      locations: { getTurn: () => [], getStep: () => [] },
      timeline: { turnOrder: [], turns: new Map() },
      legacy: { nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [] },
    },
    nodes: [],
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: [],
    pending: [],
    queue: [],
    running,
    subagent: null,
    composerPhase: 'active',
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
    ...overrides,
  } as ConversationSnapshot
}
