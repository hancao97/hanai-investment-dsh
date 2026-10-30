export const AI_SCREENER_ID = 'ai-stock-screener'
import type { MarketScanQuery, MarketScanResult } from './market-scan.ts'

export interface ScreeningPlan {
  question: string
  interpretation: string
  query: MarketScanQuery
  assumptions: string[]
  unsupported: string[]
}
export interface ScreeningRun {
  question: string
  status: 'parsing' | 'needs-confirmation' | 'scanning' | 'ready' | 'failed'
  plan: ScreeningPlan | null
  result: MarketScanResult | null
  error: string | null
  startedAt: string
  finishedAt: string | null
}
export const SCREENER_STARTERS = [
  { title: '低估值高分红', icon: '息', question: '筛选低估值、高分红的银行股，核实股息率口径、分红持续性与资产质量。' },
  { title: '半导体盈利改善', icon: '芯', question: '寻找半导体行业毛利率持续改善的公司，列出最近三期数据和原始财报依据。' },
  { title: 'AI 订单落地', icon: 'AI', question: '寻找 AI 产业链中有实际订单落地的 A 股公司，区分已公告订单、意向协议和市场传闻。' },
  { title: '消费放量突破', icon: '势', question: '寻找消费板块近期放量突破的候选股，说明突破区间、量能比较窗口和行情日期。' },
  { title: '制造业质量成长', icon: '质', question: '寻找毛利率连续三个季度提升、经营现金流改善的制造业公司，区分单季与累计口径。' },
  { title: '市值与 ROE', icon: '值', question: '筛选总市值大于 100 亿元、最近年报 ROE 超过 15% 的 A 股，说明 ROE 口径及数据日期。' },
] as const
