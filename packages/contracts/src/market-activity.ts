import type { ProviderMeta, TrendPoint } from './index.ts'

export interface MarketIntradayData {
  date: string
  points: TrendPoint[]
  prevClose: number | null
  meta: ProviderMeta
}

export interface MarketSectorSignal {
  time: string
  name: string
  code: string
  title: string
  direction: 'up' | 'down'
}

export interface MarketSignalsData {
  method?: 'ths-sector-events-v2'
  date: string
  signals: MarketSectorSignal[]
  meta: ProviderMeta
}
