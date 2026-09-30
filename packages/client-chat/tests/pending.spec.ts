import { describe, expect, it, vi } from 'vitest'
import { answerApproval, answerQuestion, cancelQuestion, type ApprovalWait, type QuestionWait } from '../src/pending.ts'

describe('DSH pending interaction carriers', () => {
  it('settles an approval through its DSH-owned one-shot answer method', async () => {
    const answer = vi.fn().mockResolvedValue(undefined)
    const wait = { answer } as unknown as ApprovalWait
    await answerApproval(wait, 'allowed-once')
    expect(answer).toHaveBeenCalledWith('allowed-once')
  })

  it('answers a whole question batch and delegates dismissal to the carrier', async () => {
    const answer = vi.fn().mockResolvedValue(undefined)
    const dismiss = vi.fn().mockResolvedValue(undefined)
    const wait = { answer, dismiss } as unknown as QuestionWait
    const value = { answers: [{ id: 'risk', selected: ['低'], custom: '补充' }] }
    await answerQuestion(wait, value)
    await cancelQuestion(wait)
    expect(answer).toHaveBeenCalledWith(value)
    expect(dismiss).toHaveBeenCalledOnce()
  })

  it('propagates a withdrawn or already answered request failure', async () => {
    const wait = { answer: vi.fn().mockRejectedValue(new Error('not-pending')) } as unknown as ApprovalWait
    await expect(answerApproval(wait, 'rejected')).rejects.toThrow('not-pending')
  })
})
