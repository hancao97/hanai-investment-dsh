import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { DshSessionGateway } from '../src/dsh-session.ts'

describe('DshSessionGateway lifecycle', () => {
  it('archives the created session when model selection fails', async () => {
    const archiveSession = vi.fn(async () => ({
      result: { ok: true as const, value: { archivedSessionIds: ['hanai-judgement-1'] } },
    }))
    const context = {
      apiProxy: {
        sessions: {
          create: vi.fn(async () => ({
            result: { ok: true as const, value: { sessionId: 'hanai-judgement-1' } },
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
            result: { ok: true as const, value: { sessionId: 'hanai-judgement-2' } },
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
