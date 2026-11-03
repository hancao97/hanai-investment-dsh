import { z } from 'zod'

const period = z.number().int().min(2).max(250)
const lookback = z.number().int().min(1).max(60)
const offset = z.number().int().min(0).max(60).optional()
export const technicalRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ma-spread'), periods: z.array(period).min(2).max(8).refine(v => new Set(v).size === v.length), maxPercent: z.number().finite().min(0).max(100), days: lookback, offset }).strict(),
  z.object({ kind: z.literal('ma-cross'), short: period, long: period, direction: z.enum(['up', 'down']), within: lookback, offset }).strict().refine(v => v.short < v.long),
  z.object({ kind: z.literal('ma-turn'), period, direction: z.enum(['up', 'down']), offset }).strict(),
  z.object({ kind: z.literal('ma-slope'), period, direction: z.enum(['up', 'down']), days: lookback, offset }).strict(),
  z.object({ kind: z.literal('price-ma'), period, relation: z.enum(['above', 'below']), offset }).strict(),
  z.object({ kind: z.literal('limit-up'), days: lookback, minimum: z.number().int().min(1).max(60), offset }).strict().refine(v => v.minimum <= v.days),
])
export const technicalFormulaSchema = z.object({
  match: z.enum(['all', 'any']), adjust: z.enum(['qfq', 'none']),
  rules: z.array(technicalRuleSchema).min(1).max(20),
}).strict()
export type TechnicalRule = z.infer<typeof technicalRuleSchema>
export type TechnicalFormula = z.infer<typeof technicalFormulaSchema>
export interface TechnicalBar {
  date: string; open: number; high: number; low: number; close: number; volume: number; amount?: number | null | undefined
  prevClose?: number | null | undefined; turnoverRate?: number | null | undefined; tradeStatus?: 0 | 1 | undefined
  isST?: boolean | undefined; peTtm?: number | null | undefined; pb?: number | null | undefined
}
export interface TechnicalHistoryInput { bars: TechnicalBar[]; source: string; fetchedAt: string }
export const historicalLimitPoolSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  codes: z.array(z.string().regex(/^\d{6}$/)).max(20000).refine(codes => new Set(codes).size === codes.length),
  source: z.string().min(1).max(200), fetchedAt: z.string().datetime(),
  scope: z.literal('source-pool-positive-only'),
}).strict()
export type HistoricalLimitPool = z.infer<typeof historicalLimitPoolSchema>
export interface TechnicalEvidence { formula: string; matched: boolean | null; detail: string }
export interface TechnicalDecision { matched: boolean | null; evidence: TechnicalEvidence[] }
export interface TechnicalProgress {
  phase: 'universe' | 'history' | 'scanning' | 'finished'
  asOf: string | null
  catalogueDate: string | null
  total: number
  checked: number
  matched: number
  unverified: number
  samples: Array<{ code: string; reason: string }>
  evidence: Record<string, TechnicalEvidence[]>
  dataReady?: number | undefined
  funnel?: Array<{ formula: string; passed: number; rejected: number; unverified: number }> | undefined
  limitPools?: { requested: number; available: number; missingDates: string[] } | undefined
}
const evidenceSchema = z.object({ formula: z.string().max(1000), matched: z.boolean().nullable(), detail: z.string().max(3000) }).strict()
export const technicalProgressSchema = z.object({
  phase: z.enum(['universe', 'history', 'scanning', 'finished']), asOf: z.string().nullable(), catalogueDate: z.string().nullable(),
  total: z.number().int().min(0).max(20000), checked: z.number().int().min(0).max(20000),
  matched: z.number().int().min(0).max(20000), unverified: z.number().int().min(0).max(20000),
  samples: z.array(z.object({ code: z.string().regex(/^\d{6}$/), reason: z.string().max(3000) }).strict()).max(20),
  evidence: z.record(z.string().regex(/^\d{6}$/), z.array(evidenceSchema).max(20)),
  dataReady: z.number().int().min(0).max(20000).optional(),
  funnel: z.array(z.object({ formula: z.string().max(1000), passed: z.number().int().nonnegative(), rejected: z.number().int().nonnegative(), unverified: z.number().int().nonnegative() }).strict()).max(20).optional(),
  limitPools: z.object({ requested: z.number().int().min(0).max(120), available: z.number().int().min(0).max(120), missingDates: z.array(z.string()).max(120) }).strict()
    .refine(value => value.available + value.missingDates.length === value.requested).optional(),
}).strict().refine(value => value.checked <= value.total && value.matched + value.unverified <= value.checked && Object.keys(value.evidence).length <= 100
  && (value.dataReady === undefined || value.dataReady <= value.checked)
  && (!value.funnel || value.funnel.every(step => step.passed + step.rejected + step.unverified === value.checked)))
export function describeTechnicalRule(rule: TechnicalRule): string {
  const at = rule.offset ? `截至基准日前${rule.offset}个市场交易日：` : ''
  switch (rule.kind) {
    case 'ma-spread': return `${at}连续${rule.days}个交易日，MA${rule.periods.join('/')}极差÷最小均线≤${rule.maxPercent}%`
    case 'ma-cross': return `${at}最近${rule.within}个交易日内MA${rule.short}${rule.direction === 'up' ? '上穿' : '下穿'}MA${rule.long}（前日含相等）`
    case 'ma-turn': return `${at}MA${rule.period}最新斜率${rule.direction === 'up' ? '由非正转正' : '由非负转负'}`
    case 'ma-slope': return `${at}MA${rule.period}连续${rule.days}个交易日${rule.direction === 'up' ? '上行' : '下行'}`
    case 'price-ma': return `${at}最新收盘价${rule.relation === 'above' ? '高于' : '低于'}MA${rule.period}`
    case 'limit-up': return `${at}最近${rule.days}个市场交易日内至少${rule.minimum}次收盘涨停（历史池与不复权收盘核验）`
  }
}
