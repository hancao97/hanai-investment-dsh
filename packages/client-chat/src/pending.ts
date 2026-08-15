import type { PendingWait } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ApprovalResponsePayload,
  QuestionResponsePayload,
} from '@deepseek-ai/dsh-client-connection/client'

export type ApprovalWait = PendingWait<'approval'>
export type QuestionWait = PendingWait<'question'>
export type ApprovalOutcome = ApprovalResponsePayload['outcome']
export type QuestionAnswer = QuestionResponsePayload['answer']
export type QuestionAnswerItem = QuestionAnswer['answers'][number]

/** Answer a DSH approval request with the Host's exact audit correlation. */
export async function answerApproval(wait: ApprovalWait, outcome: ApprovalOutcome): Promise<void> {
  const receipt = await wait.respond({
    ok: true,
    value: {
      sessionId: wait.sessionId,
      approvalId: wait.payload.approvalId,
      outcome,
    },
  })
  assertReceipt('approval', receipt)
}

/** Answer an entire DSH question batch in one response. */
export async function answerQuestion(wait: QuestionWait, answer: QuestionAnswer): Promise<void> {
  const receipt = await wait.respond({
    ok: true,
    value: { sessionId: wait.sessionId, answer },
  })
  assertReceipt('question', receipt)
}

/** Cancel a DSH question batch, allowing the waiting tool call to settle. */
export async function cancelQuestion(wait: QuestionWait): Promise<void> {
  const receipt = await wait.respond({
    ok: false,
    error: {
      code: 'cancelled',
      message: 'the user closed this question request',
      details: {},
    },
  })
  assertReceipt('question cancellation', receipt)
}

function assertReceipt(operation: string, receipt: { accepted: boolean; reason?: string }): void {
  if (receipt.accepted) return
  throw new Error(`${operation} response rejected: ${receipt.reason ?? 'unknown reason'}`)
}
