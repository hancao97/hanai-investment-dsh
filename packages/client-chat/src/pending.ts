import type { PendingApproval, ApprovalDecision } from '@deepseek-ai/dsh-client-ui-approval/client'
import type { PendingQuestion, QuestionAnswer } from '@deepseek-ai/dsh-client-ui-user-questions/client'

export type ApprovalWait = PendingApproval
export type QuestionWait = PendingQuestion
export type ApprovalOutcome = ApprovalDecision
export type { QuestionAnswer }
export type QuestionAnswerItem = QuestionAnswer['answers'][number]

/** DSH owns correlation, cancellation and one-shot Remote waterfall settlement. */
export async function answerApproval(wait: ApprovalWait, outcome: ApprovalOutcome): Promise<void> {
  await wait.answer(outcome)
}

export async function answerQuestion(wait: QuestionWait, answer: QuestionAnswer): Promise<void> {
  await wait.answer(answer)
}

export async function cancelQuestion(wait: QuestionWait): Promise<void> {
  await wait.dismiss()
}
