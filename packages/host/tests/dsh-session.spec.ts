import type { Context } from '@deepseek-ai/cordis'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { DshSessionGateway } from '../src/dsh-session.ts'

function gateway(doubles: Record<string, unknown> = {}, archiveSession = vi.fn().mockResolvedValue({})) {
  const create = vi.fn().mockResolvedValue({ sessionId: 'hanai-test', agentPreset: 'standard' })
  const context = {
    sessionController: { create, ...doubles },
    workspaceController: { archiveSession },
  } as unknown as Context
  return { gateway: new DshSessionGateway(context), create, archiveSession }
}

describe('DshSessionGateway controller lifecycle', () => {
  it('pins the standard preset and applies the requested model to the created session', async () => {
    const selectModel = vi.fn().mockResolvedValue({})
    const harness = gateway({ selectModel })
    await expect(harness.gateway.create('test', '/tmp/hanai-workspace', {
      provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'high',
    })).resolves.toBe('hanai-test')
    expect(harness.create).toHaveBeenCalledWith({
      cwd: '/tmp/hanai-workspace', sessionId: 'hanai-test', agentPreset: 'standard',
    })
    expect(selectModel).toHaveBeenCalledWith({
      sessionId: 'hanai-test', provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'high',
    })
  })

  it.each([undefined, 'minimal'])('archives a session that echoes the wrong preset: %s', async agentPreset => {
    const harness = gateway({ create: vi.fn().mockResolvedValue({ sessionId: 'hanai-test', agentPreset }) })
    await expect(harness.gateway.create('test', '/tmp/hanai-workspace')).rejects.toThrow('必需的 Agent Preset')
    expect(harness.archiveSession).toHaveBeenCalledWith({ sessionId: 'hanai-test' })
  })

  it('archives the created session when the direct controller rejects model selection', async () => {
    const harness = gateway({ selectModel: vi.fn().mockRejectedValue(new Error('模型不可用')) })
    await expect(harness.gateway.create('test', '/tmp/hanai-workspace', {
      provider: 'deepseek', model: 'missing',
    })).rejects.toThrow('模型不可用')
    expect(harness.archiveSession).toHaveBeenCalledWith({ sessionId: 'hanai-test' })
  })

  it('surfaces both the selection failure and its cleanup failure', async () => {
    const harness = gateway(
      { selectModel: vi.fn().mockRejectedValue(new Error('模型不可用')) },
      vi.fn().mockRejectedValue(new Error('归档不可用')),
    )
    await expect(harness.gateway.create('test', '/tmp/hanai-workspace', {
      provider: 'deepseek', model: 'missing',
    })).rejects.toThrow('模型不可用；未绑定 Session 归档失败：归档不可用')
  })

  it('surfaces both the preset mismatch and its cleanup failure', async () => {
    const harness = gateway(
      { create: vi.fn().mockResolvedValue({ sessionId: 'hanai-test', agentPreset: 'minimal' }) },
      vi.fn().mockRejectedValue(new Error('归档不可用')),
    )
    await expect(harness.gateway.create('test', '/tmp/hanai-workspace'))
      .rejects.toThrow('实际："minimal"）；未绑定 Session 归档失败：归档不可用')
  })

  it('gives each admitted prompt a fresh correlation id and forwards queue/steer', async () => {
    const prompt = vi.fn().mockResolvedValue({ accepted: true })
    const harness = gateway({ prompt })
    await harness.gateway.prompt('hanai-test', '第一问')
    await harness.gateway.prompt('hanai-test', '先回答风险', 'steer')
    expect(prompt).toHaveBeenNthCalledWith(1, {
      sessionId: 'hanai-test', requestId: expect.any(String), mode: 'queue', content: [{ type: 'text', text: '第一问' }],
    }, expect.any(AbortSignal))
    expect(prompt.mock.calls[1]![0].mode).toBe('steer')
    expect(prompt.mock.calls[0]![0].requestId).not.toBe(prompt.mock.calls[1]![0].requestId)
  })

  it('reads a cold session without activating its agent and retains trailing lifecycle events', async () => {
    const events = [
      { type: 'user/message', seq: SessionSeq(0) },
      { type: 'assistant/message', seq: SessionSeq(1) },
      { type: 'turn/end', seq: SessionSeq(2) },
    ] as SessionEvent[]
    const inspect = vi.fn().mockResolvedValue({ events })
    const harness = gateway({ inspect })
    await expect(harness.gateway.history('hanai-test', 1)).resolves.toEqual(events.slice(1))
    expect(inspect).toHaveBeenCalledWith('hanai-test')
  })

  it('uses host catalog running state and treats an absent session as idle', async () => {
    const list = vi.fn().mockResolvedValue({ items: [{ sessionId: 'hanai-test', running: true }] })
    const harness = gateway({ list })
    await expect(harness.gateway.isRunning('hanai-test')).resolves.toBe(true)
    await expect(harness.gateway.isRunning('missing')).resolves.toBe(false)
  })
})
