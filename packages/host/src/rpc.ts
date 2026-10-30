import { isMacroRange } from '../../contracts/src/macro-range.ts'
import { z } from 'zod'
import type { ConnectionRpcResult as RpcResult } from '@deepseek-ai/dsh-client-connection'
import type { HanaiEndpoint, HanaiRequest, HanaiResponse } from '../../contracts/src/index.ts'
import { isMarketDate } from '../../contracts/src/market-history.ts'
import { SCAN_FIELDS, scanQueryError, type MarketScanQuery, type ScanSort } from '../../contracts/src/market-scan.ts'

const empty = z.object({}).strict()
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)
const secId = z.string().regex(/^[01]\.\d{6}$/)
const groupName = z.string().trim().min(1).max(20)
const tradingDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const scanValue = z.number().finite().min(-1e12).max(1e12)
const scanQuery = z.object({
  search: z.string().trim().max(80), industries: z.array(z.string().trim().min(1).max(40)).max(20).optional(), page: z.number().int().min(1).max(1000),
  ranges: z.object(Object.fromEntries(Object.entries(SCAN_FIELDS).map(([key, field]) => [key, z.object(field.maximum ? { min: scanValue.optional(), max: scanValue.optional() } : { min: scanValue.optional() }).strict().optional()]))).strict(),
  sort: z.enum(['code', 'price', 'changePct', ...Object.keys(SCAN_FIELDS)]), order: z.enum(['asc', 'desc']),
}).strict().refine(value => scanQueryError(value as MarketScanQuery) === null, '筛选范围或排序无效')

const schemas = {
  'bootstrap': empty,
  'dashboard.get': z.object({ refresh: z.boolean().optional() }).strict(),
  'market.scan.query': z.object({ query: scanQuery, date: z.string().refine(isMarketDate).optional(), refresh: z.boolean().optional() }).strict(),
  'market.scan.history': z.object({ query: scanQuery }).strict(),
  'market.breadth': empty,
  'market.arms': empty,
  'market.ladder': empty,
  'market.distribution': empty,
  'market.indices': empty,
  'market.macro.query': z.object({ range: z.object({ from: tradingDate, to: tradingDate }).strict().refine(value => isMacroRange(value), '日期范围最长五年且不能晚于今天'), refresh: z.boolean().optional() }).strict(),
  'market.macro.indicators': z.object({ topic: z.enum(['credit', 'activity', 'prices', 'breadth']), range: z.object({ from: tradingDate, to: tradingDate }).strict().refine(value => isMacroRange(value), '日期范围最长五年且不能晚于今天'), refresh: z.boolean().optional() }).strict(),
  'market.macro.generate': empty,
  'market.macro.generation': empty,
  'market.macro.allDaily': z.object({ retryMissing: z.boolean().optional() }).strict(),
  'market.macro.all': empty,
  'market.macro.capital': z.object({ retryMissing: z.boolean().optional() }).strict(),
  'market.macro.daily': empty,
  'market.macro.etf': empty,
  'market.macro.index': empty,
  'market.intraday': empty,
  'market.signals': empty,
  'market.history.list': empty,
  'market.history.get': z.object({ date: z.string().refine(isMarketDate, '无效的历史日期') }).strict(),
  'sector.stocks': z.object({ sectorCode: z.string().trim().regex(/^(?:BK\d{4}|SINA:(?:new_|gn_)[A-Za-z0-9_]{1,60})$/) }).strict(),
  'security.sync': z.object({ force: z.boolean().optional() }).strict(),
  'security.search': z.object({ query: z.string().trim().min(1).max(80) }).strict(),
  'security.detail': z.object({ secId }).strict(),
  'security.quote': z.object({ secId }).strict(),
  'security.trend': z.object({ secId }).strict(),
  'security.kline': z.object({ secId, period: z.enum(['daily', 'weekly', 'monthly']), before: tradingDate.optional() }).strict(),
  'security.valuation': z.object({ secId }).strict(),
  'watch.list': empty,
  'watch.securities': empty,
  'watch.quotes': z.object({ groupId: identifier }).strict(),
  'watch.valuations': z.object({ groupId: identifier }).strict(),
  'watch.group.create': z.object({ name: groupName }).strict(),
  'watch.group.rename': z.object({ id: identifier, name: groupName }).strict(),
  'watch.group.remove': z.object({ id: identifier }).strict(),
  'watch.item.add': z.object({ groupId: identifier, secId }).strict(),
  'watch.item.remove': z.object({ groupId: identifier, secId }).strict(),
  'watch.item.move': z.object({ fromGroupId: identifier, toGroupId: identifier, secId }).strict(),
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
  'screener.list': empty,
  'screener.result': z.object({ id: identifier }).strict(),
  'screener.execute': z.object({ id: identifier }).strict(),
  'screener.get': z.object({ id: identifier }).strict(),
  'screener.remove': z.object({ id: identifier }).strict(),
  'screener.rename': z.object({ id: identifier, title: z.string().trim().min(1).max(80) }).strict(),
  'screener.create': z.object({
    openingMessage: z.string().trim().min(1).max(4000).optional(),
    model: z.object({ provider: z.string().trim().min(1).max(100), model: z.string().trim().min(1).max(200), reasoningEffort: z.string().trim().min(1).max(50).optional() }).strict().optional(),
  }).strict(),
  'research-chat.list': empty,
  'research-chat.get': z.object({ id: identifier }).strict(),
  'research-chat.remove': z.object({ id: identifier }).strict(),
  'research-chat.rename': z.object({ id: identifier, title: z.string().trim().min(1).max(80) }).strict(),
  'research-chat.upload': z.object({ id: identifier, name: z.string().trim().min(1).max(180), data: z.string().min(4).max(6990508) }).strict(),
  'research-chat.create': z.object({
    openingMessage: z.string().trim().min(1).max(4000).optional(),
    model: z.object({ provider: z.string().trim().min(1).max(100), model: z.string().trim().min(1).max(200), reasoningEffort: z.string().trim().min(1).max(50).optional() }).strict().optional(),
  }).strict(),
  'expert-chat.list': empty,
  'expert-chat.create': z.object({
    masterId: identifier,
    openingMessage: z.string().trim().min(1).max(4000).optional(),
    model: z.object({
      provider: z.string().trim().min(1).max(100),
      model: z.string().trim().min(1).max(200),
      reasoningEffort: z.string().trim().min(1).max(50).optional(),
    }).strict().optional(),
  }).strict(),
  'expert-chat.get': z.object({ id: identifier }).strict(),
  'expert-chat.remove': z.object({ id: identifier }).strict(),
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
