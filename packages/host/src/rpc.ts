import { z } from 'zod'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { HanaiEndpoint, HanaiRequest, HanaiResponse } from '../../contracts/src/index.ts'

const empty = z.object({}).strict()
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)
const secId = z.string().regex(/^[01]\.\d{6}$/)
const groupName = z.string().trim().min(1).max(20)
const followUpTitle = z.string().trim().min(1).max(160)
const dueDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const predictionStatement = z.string().trim().min(1).max(200)
const predictionCriteria = z.string().trim().min(1).max(300)

const schemas = {
  'bootstrap': empty,
  'dashboard.get': z.object({ refresh: z.boolean().optional() }).strict(),
  'sector.stocks': z.object({ sectorCode: z.string().trim().regex(/^BK\d{4}$/) }).strict(),
  'security.sync': z.object({ force: z.boolean().optional() }).strict(),
  'security.search': z.object({ query: z.string().trim().min(1).max(80) }).strict(),
  'security.detail': z.object({ secId }).strict(),
  'security.quote': z.object({ secId }).strict(),
  'security.trend': z.object({ secId }).strict(),
  'security.kline': z.object({ secId, period: z.enum(['daily', 'weekly', 'monthly']) }).strict(),
  'security.valuation': z.object({ secId }).strict(),
  'watch.list': empty,
  'watch.quotes': z.object({ groupId: identifier }).strict(),
  'watch.valuations': z.object({ groupId: identifier }).strict(),
  'watch.researchCoverage': z.object({ groupId: identifier }).strict(),
  'watch.group.create': z.object({ name: groupName }).strict(),
  'watch.group.rename': z.object({ id: identifier, name: groupName }).strict(),
  'watch.group.remove': z.object({ id: identifier }).strict(),
  'watch.item.add': z.object({ groupId: identifier, secId }).strict(),
  'watch.item.remove': z.object({ groupId: identifier, secId }).strict(),
  'watch.item.move': z.object({ fromGroupId: identifier, toGroupId: identifier, secId }).strict(),
  'research.followup.list': z.object({ secId }).strict(),
  'research.followup.create': z.object({
    secId,
    judgementId: identifier.optional(),
    reportVersion: z.number().int().positive().optional(),
    title: followUpTitle,
    dueDate: dueDate.optional(),
  }).strict(),
  'research.followup.update': z.object({
    id: identifier,
    completed: z.boolean().optional(),
    title: followUpTitle.optional(),
    dueDate: dueDate.nullable().optional(),
  }).strict().refine(value => value.completed !== undefined || value.title !== undefined || value.dueDate !== undefined, {
    message: '至少提供一个需要更新的字段',
  }),
  'research.followup.remove': z.object({ id: identifier }).strict(),
  'research.inbox': z.object({ status: z.enum(['open', 'done', 'all']).optional() }).strict(),
  'research.prediction.list': z.object({ secId }).strict(),
  'research.prediction.create': z.object({
    secId,
    judgementId: identifier.optional(),
    reportVersion: z.number().int().positive().optional(),
    statement: predictionStatement,
    resolutionCriteria: predictionCriteria,
    probabilityPct: z.number().int().min(1).max(99),
    dueDate,
  }).strict(),
  'research.prediction.resolve': z.object({
    id: identifier,
    outcome: z.enum(['occurred', 'not-occurred', 'invalid']),
  }).strict(),
  'research.prediction.inbox': z.object({ status: z.enum(['pending', 'resolved', 'all']).optional() }).strict(),
  'research.quality': empty,
  'research.compare': z.object({ secId }).strict(),
  'judgement.list': empty,
  'judgement.create': z.object({
    secId,
    masterId: identifier,
    prompt: z.string().trim().max(4000).optional(),
    model: z.object({
      provider: z.string().trim().min(1).max(100),
      model: z.string().trim().min(1).max(200),
      reasoningEffort: z.string().trim().min(1).max(50).optional(),
    }).strict().optional(),
  }).strict(),
  'judgement.get': z.object({ id: identifier }).strict(),
  'judgement.revise': z.object({ id: identifier, instruction: z.string().trim().min(1).max(4000) }).strict(),
  'judgement.remove': z.object({ id: identifier }).strict(),
  'model.default.get': empty,
  'model.default.set': z.object({
    provider: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(200),
    reasoningEffort: z.string().trim().min(1).max(50).optional(),
  }).strict(),
  'theme.set': z.object({ theme: z.enum(['light', 'dark']) }).strict(),
  'diagnostics.get': empty,
  'cache.clear': z.object({ scope: z.enum(['market', 'valuation']) }).strict(),
  'storage.openDataRoot': empty,
} satisfies Record<HanaiEndpoint, z.ZodType>

export function isHanaiEndpoint(endpoint: string): endpoint is HanaiEndpoint {
  return Object.hasOwn(schemas, endpoint)
}

export function parseHanaiRequest<K extends HanaiEndpoint>(endpoint: K, payload: unknown): HanaiRequest<K> {
  return schemas[endpoint].parse(payload) as HanaiRequest<K>
}

export function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

export function badRequest(message: string): RpcResult<never> {
  return {
    ok: false,
    error: { code: 'bad-request', message, details: { issues: [] } },
  }
}

export function internalError(error: unknown): RpcResult<never> {
  return {
    ok: false,
    error: {
      code: 'internal',
      message: safeErrorMessage(error),
      details: {},
    },
  }
}

export interface HanaiRpcHandler {
  call<K extends HanaiEndpoint>(endpoint: K, request: HanaiRequest<K>, signal: AbortSignal):
  Promise<HanaiResponse<K>>
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // Do not echo credential-shaped strings through the generic business boundary.
  return message.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
}
