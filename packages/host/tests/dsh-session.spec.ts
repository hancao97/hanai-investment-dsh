import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { DshSessionGateway } from '../src/dsh-session.ts'

describe('DshSessionGateway lifecycle', () => {
  it('pins the standard agent preset when creating a judgement session', async () => {
    const create = vi.fn(async () => ({
      result: {
        ok: true as const,
        value: { sessionId: 'hanai-judgement-standard', agentPreset: 'standard' },
      },
    }))
    const context = {
      apiProxy: { sessions: { create } },
    } as unknown as Context
    const gateway = new DshSessionGateway(context)

    await expect(gateway.create('judgement-standard', '/tmp/hanai-workspace')).resolves.toBe('hanai-judgement-standard')

    expect(create).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      payload: {
        cwd: '/tmp/hanai-workspace',
        sessionId: 'hanai-judgement-standard',
        agentPreset: 'standard',
      },
    }))
  })

  it.each([
    ['does not echo a preset', undefined, '未返回'],
    ['echoes a different preset', 'minimal', '"minimal"'],
  ])('archives the session when create %s', async (_case, agentPreset, actual) => {
    const archiveSession = vi.fn(async () => ({
      result: { ok: true as const, value: { archivedSessionIds: ['hanai-judgement-preset'] } },
    }))
    const context = {
      apiProxy: {
        sessions: {
          create: vi.fn(async () => ({
            result: {
              ok: true as const,
              value: {
                sessionId: 'hanai-judgement-preset',
                ...(agentPreset === undefined ? {} : { agentPreset }),
              },
            },
          })),
        },
        workspace: { archiveSession },
      },
    } as unknown as Context
    const gateway = new DshSessionGateway(context)

    await expect(gateway.create('judgement-preset', '/tmp/hanai-workspace'))
      .rejects.toThrow(`DSH Session 未使用必需的 Agent Preset "standard"（实际：${actual}）`)

    expect(archiveSession).toHaveBeenCalledOnce()
    expect(archiveSession).toHaveBeenCalledWith(expect.objectContaining({
      payload: { sessionId: 'hanai-judgement-preset' },
    }))
  })

  it('surfaces both an unexpected preset and its cleanup failure', async () => {
    const context = {
      apiProxy: {
        sessions: {
          create: vi.fn(async () => ({
            result: {
              ok: true as const,
              value: { sessionId: 'hanai-judgement-preset-cleanup', agentPreset: 'minimal' },
            },
          })),
        },
        workspace: {
          archiveSession: vi.fn(async () => ({
            result: {
              ok: false as const,
              error: { code: 'archive-failed', message: '归档不可用' },
            },
          })),
        },
      },
    } as unknown as Context
    const gateway = new DshSessionGateway(context)

    await expect(gateway.create('judgement-preset-cleanup', '/tmp/hanai-workspace')).rejects.toThrow(
      'DSH Session 未使用必需的 Agent Preset "standard"（实际："minimal"）；未绑定 Session 归档失败：DSH archive-failed: 归档不可用',
    )
  })

  it('archives the created session when model selection fails', async () => {
    const archiveSession = vi.fn(async () => ({
      result: { ok: true as const, value: { archivedSessionIds: ['hanai-judgement-1'] } },
    }))
    const context = {
      apiProxy: {
        sessions: {
          create: vi.fn(async () => ({
            result: { ok: true as const, value: { sessionId: 'hanai-judgement-1', agentPreset: 'standard' } },
          })),
          selectModel: vi.fn(async () => ({
            result: {
              ok: false as const,
              error: { code: 'invalid-model', message: '模型不可用' },
            },
          })),
        },
        workspace: { archiveSession },
      },
    } as unknown as Context
    const gateway = new DshSessionGateway(context)

    await expect(gateway.create('judgement-1', '/tmp/hanai-workspace', {
      provider: 'deepseek', model: 'missing-model',
    })).rejects.toThrow('DSH invalid-model: 模型不可用')

    expect(archiveSession).toHaveBeenCalledOnce()
    expect(archiveSession).toHaveBeenCalledWith(expect.objectContaining({
      payload: { sessionId: 'hanai-judgement-1' },
    }))
  })

  it('surfaces both model selection and cleanup failures', async () => {
    const context = {
      apiProxy: {
        sessions: {
          create: vi.fn(async () => ({
            result: { ok: true as const, value: { sessionId: 'hanai-judgement-2', agentPreset: 'standard' } },
          })),
          selectModel: vi.fn(async () => ({
            result: {
              ok: false as const,
              error: { code: 'invalid-model', message: '模型不可用' },
            },
          })),
        },
        workspace: {
          archiveSession: vi.fn(async () => ({
            result: {
              ok: false as const,
              error: { code: 'archive-failed', message: '归档不可用' },
            },
          })),
        },
      },
    } as unknown as Context
    const gateway = new DshSessionGateway(context)

    await expect(gateway.create('judgement-2', '/tmp/hanai-workspace', {
      provider: 'deepseek', model: 'missing-model',
    })).rejects.toThrow('DSH invalid-model: 模型不可用；未绑定 Session 归档失败：DSH archive-failed: 归档不可用')
  })
})
