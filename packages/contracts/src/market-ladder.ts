import type { ProviderMeta } from './index.ts'

export const LADDER_BOARD_TYPE_METHOD = 'source-board-types-v1' as const
export function limitBoardType(value: unknown): '一字板' | 'T字板' | '换手板' | null {
  const label = typeof value === 'string' ? value.trim().replace(/^t/, 'T') : ''
  return label === '一字板' || label === 'T字板' || label === '换手板' ? label : null
}

export interface LimitUpStock {
  code: string
  name: string
  boards: number
  industry: string
  reason: string | null
  boardType: string | null
  firstSeal: string
  lastSeal: string
  breaks: number | null
  turnover: number | null
}

export interface YesterdayLimitPerformance {
  sample: number
  average: number | null
  median: number | null
  up: number
  down: number
  flat: number
  meta: ProviderMeta
}

export interface MarketLadderData {
  yesterdayPerformance?: YesterdayLimitPerformance | null
  method?: typeof LADDER_BOARD_TYPE_METHOD
  date: string
  stocks: LimitUpStock[]
  promotion: { eligible: number; promoted: number } | null
  broken: number | null
  issues: string[]
  meta: ProviderMeta
}
