import type { ProviderMeta } from './index.ts'

/** 88AI reports turnover, not the share volume used by classical TRIN. */
export interface MarketArmsPoint {
  date: string
  time: string | null
  upCount: number
  downCount: number
  flatCount: number
  upAmount: number | null
  downAmount: number | null
  trin: number | null
  adRatio: number | null
  amountRatio: number | null
  estimated: boolean
}

export interface MarketArmsData {
  point: MarketArmsPoint
  meta: ProviderMeta
}
