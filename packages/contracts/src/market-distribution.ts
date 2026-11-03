import type { ProviderMeta } from './index.ts'

export const DISTRIBUTION_BINS = [
  ['down10', '<-10%'], ['down5', '-10～-5%'], ['down2', '-5～-2%'], ['down0', '-2～0%'],
  ['flat', '平盘'], ['up0', '0～2%'], ['up2', '2～5%'], ['up5', '5～10%'], ['up10', '≥10%'],
] as const

export interface MarketDistributionData {
  total: number
  counts: Record<(typeof DISTRIBUTION_BINS)[number][0], number>
  meta: ProviderMeta
}
