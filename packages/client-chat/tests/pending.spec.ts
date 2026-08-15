import { describe, expect, it, vi } from 'vitest'
import type { PendingWait } from '@deepseek-ai/dsh-client-runtime/client'
import { answerApproval, answerQuestion, cancelQuestion } from '../src/pending.ts'

describe('pending response helpers', () => {
  it('encodes an approval with session and approval correlation', async () => {
    const respond = vi.fn().mockResolvedValue({ accepted: true })
    const wait = {
      kind: 'approval',
      key: 'a:rpc-1',
      sessionId: 'session-1',
      payload: { approvalId: 'approval-1', toolName: 'bash' },
      respond,
    } as unknown as PendingWait<'approval'>

    await answerApproval(wait, 'allowed-once')

    expect(respond).toHaveBeenCalledWith({
      ok: true,
      value: {
        sessionId: 'session-1',
        approvalId: 'approval-1',
        outcome: 'allowed-once',
      },
    })
  })

  it('answers and cancels a question batch with the wire protocol', async () => {
    const respond = vi.fn().mockResolvedValue({ accepted: true })
    const wait = {
      kind: 'question',
      key: 'q:rpc-2',
      sessionId: 'session-2',
      payload: { questions: [] },
      respond,
    } as unknown as PendingWait<'question'>
    const answer = { answers: [{ id: 'risk', selected: ['低'], custom: '补充' }] }

    await answerQuestion(wait, answer)
    await cancelQuestion(wait)

    expect(respond).toHaveBeenNthCalledWith(1, {
      ok: true,
      value: { sessionId: 'session-2', answer },
    })
    expect(respond).toHaveBeenNthCalledWith(2, {
      ok: false,
      error: {
        code: 'cancelled',
        message: 'the user closed this question request',
        details: {},
      },
    })
  })

  it('rejects a response receipt refused by the Host', async () => {
    const wait = {
      kind: 'approval',
      key: 'a:rpc-3',
      sessionId: 'session-3',
      payload: { approvalId: 'approval-3', toolName: 'bash' },
      respond: vi.fn().mockResolvedValue({ accepted: false, reason: 'not-pending' }),
    } as unknown as PendingWait<'approval'>

    await expect(answerApproval(wait, 'rejected')).rejects.toThrow('not-pending')
  })
})
