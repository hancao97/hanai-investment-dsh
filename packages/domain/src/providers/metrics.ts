import type { ProviderMeta, StockMetrics, StockQuote } from '../../../contracts/src/index.ts'

export function metricsFromQuote(secId: string, quote: StockQuote | null, meta: ProviderMeta): StockMetrics {
  return {
    secId, code: secId.slice(2), name: quote?.name ?? '',
    price: quote?.price ?? null, change: quote?.change ?? null, changePct: quote?.changePct ?? null,
    open: quote?.open ?? null, high: quote?.high ?? null, low: quote?.low ?? null, prevClose: quote?.prevClose ?? null,
    volume: quote?.volume ?? null, amount: quote?.amount ?? null, turnoverRate: quote?.turnoverRate ?? null,
    marketCap: quote?.marketCap ?? null, floatCap: quote?.floatCap ?? null, pb: quote?.pb ?? null,
    averagePrice: null, amplitude: null, mainNetInflow: null, volumeRatio: null,
    totalShares: null, floatShares: null, peDynamic: null, peTtm: null, peStatic: null, psTtm: null,
    roe: null, totalRevenue: null, revenueYoy: null, netProfit: null, netProfitYoy: null,
    grossMargin: null, netMargin: null, debtRatio: null, dividendYield: null, eps: null, bvps: null,
    listingDate: null, industry: null, meta,
  }
}

export function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : null
}
