import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MarketDataService } from '../../src/providers/index.ts'
import { EastmoneyFinancialProvider } from '../../src/providers/financials.ts'
import { SinaProvider } from '../../src/providers/sina.ts'
import { TencentProvider } from '../../src/providers/tencent.ts'
import { FakeClock, HandlerHttpClient, jsonResponse } from '../helpers.ts'

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
const financials = JSON.parse(fixture('financials.json'))
const sinaStocks = JSON.parse(fixture('sina-stocks.json'))
const NOW = Date.parse('2026-10-01T10:00:00+08:00')
const clone = <T,>(value: T): T => structuredClone(value)

function response(url: string) {
  if (url.startsWith('https://qt.gtimg.cn/')) return { status: 200, body: fixture('tencent-quotes.txt') }
  if (url.includes('newSinaHy.php')) return { status: 200, body: fixture('sina-industries.txt') }
  if (url.includes('newFLJK.php')) return { status: 200, body: fixture('sina-concepts.txt') }
  if (url.includes('getHQNodeStockCount')) return jsonResponse('19')
  if (url.includes('getHQNodeData')) return jsonResponse(new URL(url).searchParams.get('node') === 'hs_a' ? sinaStocks.rank : sinaStocks.stocks)
  if (url.includes('RPT_F10_FINANCE_MAINFINADATA')) return jsonResponse(financials.finance)
  if (url.includes('RPT_SHAREBONUS_DET')) return jsonResponse(financials.dividends)
  return jsonResponse({}, 503)
}

describe('live-captured market fallback contracts', () => {
  it('restores financial fields, both boards, all rankings and drill-down under an Eastmoney quote outage', async () => {
    const http = new HandlerHttpClient(response)
    const service = new MarketDataService({ http, clock: new FakeClock(NOW), eastmoney: { minIntervalMs: 0, totalFailureThreshold: 1 } })
    const [dashboard, stock] = await Promise.all([service.getDashboard(), service.getStockQuoteMetrics('0.002594')])
    expect(dashboard.industry.sectors).toHaveLength(49)
    expect(dashboard.concept.sectors).toHaveLength(175)
    expect(dashboard.industry.sectors[0]).toMatchObject({ code: 'SINA:new_blhy', name: '玻璃行业', amount: 9_066_360_698, leaderName: '菲利华' })
    for (const kind of ['gainers', 'losers', 'amount', 'turnover'] as const) {
      expect(dashboard.ranks[kind]).toHaveLength(20)
      expect(dashboard.rankSources?.[kind].providerId).toBe('sina-fallback')
      expect(dashboard.ranks[kind].some(entry => /^\*?ST/i.test(entry.name))).toBe(false)
      const values = dashboard.ranks[kind].map(entry => kind === 'amount' ? entry.amount! : kind === 'turnover' ? entry.turnoverRate! : entry.changePct!)
      expect(values).toEqual([...values].sort((a, b) => kind === 'losers' ? a - b : b - a))
    }
    expect(dashboard.ranks.turnover.some(entry => entry.secId.startsWith('0.92'))).toBe(true)
    const drill = await service.getSectorStocks('SINA:new_blhy')
    expect(drill.stocks).toHaveLength(19)
    expect(drill.stocks[0]).toMatchObject({ name: '菲利华', volume: 211_579.51, amount: 2_036_282_237, marketCap: 49_902_014_623.44 })
    expect(drill.meta.sourceTimestamp).toBeNull()
    expect(stock.metrics).toMatchObject({ reportDate: '2026-06-30', reportName: '2026中报', totalRevenue: 344_815_421_000,
      netProfit: 12_325_408_000, roe: 4.86, eps: 1.35, totalShares: 9_117_197_565, floatShares: 3_487_068_722,
      averagePrice: 82.87, amplitude: 2.16, volumeRatio: 0.99 })
    expect(stock.metrics?.psTtm).toBeCloseTo(0.97691869)
    expect(stock.metrics?.peTtm).toBeCloseTo(25.80540827, 4)
    expect(stock.metrics?.peDynamic).toBeCloseTo(30.8125187, 4)
    expect(stock.metrics?.peStatic).toBeCloseTo(23.28560707, 4)
    expect(stock.metrics?.dividendYield).toBeCloseTo(0.42972032)
    expect(stock.sources.metrics?.providerId).toBe('eastmoney-financials')
  })

  it('coalesces financial refreshes, revalues cached reports with current prices, and retains stale reports on failure', async () => {
    const clock = new FakeClock(NOW)
    let online = true
    const http = new HandlerHttpClient(async url => {
      await Promise.resolve()
      return online ? response(url) : jsonResponse({}, 503)
    })
    const provider = new EastmoneyFinancialProvider(http, clock)
    const tencent = new TencentProvider(http, clock)
    const quote = (await tencent.getQuotes(['0.002594'])).quotes[0]!
    const [first, second] = await Promise.all([provider.getStockMetrics(quote.secId, quote, null), provider.getStockMetrics(quote.secId, quote, null)])
    expect(first?.psTtm).toEqual(second?.psTtm)
    expect(http.requests.filter(request => request.url.includes('RPT_'))).toHaveLength(2)
    const doubled = await provider.getStockMetrics(quote.secId, { ...quote, price: quote.price! * 2, marketCap: quote.marketCap! * 2 }, null)
    expect(doubled?.psTtm).toBeCloseTo(first!.psTtm! * 2)
    expect(doubled?.dividendYield).toBeCloseTo(first!.dividendYield! / 2)
    expect(doubled?.meta.cacheState).toBe('cached')
    online = false
    clock.advance(6 * 60 * 60_000 + 1)
    const stale = await provider.getStockMetrics(quote.secId, quote, null)
    expect(stale?.totalRevenue).toBe(first?.totalRevenue)
    expect(stale?.meta.cacheState).toBe('stale')
    const requests = http.requests.length
    await provider.getStockMetrics(quote.secId, quote, null)
    expect(http.requests).toHaveLength(requests)
  })

  it('keeps TTM and absent financial values null when the prior-year period or a field is unavailable', async () => {
    const finance = clone(financials.finance)
    finance.result.data = finance.result.data.filter((row: { REPORT_DATE: string }) => !row.REPORT_DATE.startsWith('2025-06-30'))
    finance.result.data[0].BPS = null
    const http = new HandlerHttpClient(url => url.includes('MAINFINADATA') ? jsonResponse(finance) : response(url))
    const quote = (await new TencentProvider(http, new FakeClock(NOW)).getQuotes(['0.002594'])).quotes[0]!
    const metrics = await new EastmoneyFinancialProvider(http, new FakeClock(NOW)).getStockMetrics(quote.secId, quote, null)
    expect(metrics?.peTtm).toBeNull()
    expect(metrics?.psTtm).toBeNull()
    expect(metrics?.bvps).toBeNull()
    expect(metrics?.totalRevenue).toBe(344_815_421_000)
  })

  it('counts only implemented trailing dividends and adjusts earlier cash for subsequent stock splits', async () => {
    const dividends = clone(financials.dividends)
    const row = dividends.result.data[0]
    dividends.result.count = 3
    dividends.result.data = [
      { ...row, EX_DIVIDEND_DATE: '2026-07-31 00:00:00', PRETAX_BONUS_RMB: 0, BONUS_RATIO: 10, IT_RATIO: null },
      { ...row, EX_DIVIDEND_DATE: '2026-03-01 00:00:00', PRETAX_BONUS_RMB: 10, BONUS_RATIO: null },
      { ...row, EX_DIVIDEND_DATE: '2026-11-01 00:00:00', PRETAX_BONUS_RMB: 100 },
    ]
    const http = new HandlerHttpClient(url => url.includes('SHAREBONUS') ? jsonResponse(dividends) : response(url))
    const clock = new FakeClock(NOW)
    const quote = (await new TencentProvider(http, clock).getQuotes(['0.002594'])).quotes[0]!
    const metrics = await new EastmoneyFinancialProvider(http, clock).getStockMetrics(quote.secId, { ...quote, price: 50 }, null)
    expect(metrics?.dividendYield).toBe(1)
  })

  it('does not turn a failed or mismatched dividend response into zero yield', async () => {
    const dividends = clone(financials.dividends)
    dividends.result.data[0].SECURITY_CODE = '600519'
    const http = new HandlerHttpClient(url => url.includes('SHAREBONUS') ? jsonResponse(dividends) : response(url))
    const clock = new FakeClock(NOW)
    const quote = (await new TencentProvider(http, clock).getQuotes(['0.002594'])).quotes[0]!
    const metrics = await new EastmoneyFinancialProvider(http, clock).getStockMetrics(quote.secId, quote, null)
    expect(metrics?.dividendYield).toBeNull()
    expect(metrics?.psTtm).toBeCloseTo(0.97691869)
  })

  it('does not execute malformed JavaScript and preserves cached sectors after an upstream failure', async () => {
    const clock = new FakeClock(NOW)
    let online = true
    const http = new HandlerHttpClient(url => online ? response(url) : { status: 200, body: 'var S_Finance_bankuai_sinaindustry = {}; globalThis.bad = true;' })
    const provider = new SinaProvider(http, clock)
    const first = await provider.getSectorBoard('industry')
    online = false
    clock.advance(30_001)
    const stale = await provider.getSectorBoard('industry')
    expect(stale?.sectors).toEqual(first?.sectors)
    expect(stale?.meta).toMatchObject({ cacheState: 'stale', fetchedAt: first?.meta.fetchedAt, sourceTimestamp: null })
    expect(await provider.getSectorStocks('SINA:hs_a&url=example')).toBeNull()
  })

  it('paginates full sector constituents and rejects a truncated response', async () => {
    const rows = Array.from({ length: 101 }, (_, index) => {
      const code = String(600000 + index)
      return { ...sinaStocks.stocks[0], symbol: `sh${code}`, code }
    })
    let truncate = false
    const http = new HandlerHttpClient(url => {
      if (url.includes('getHQNodeStockCount')) return jsonResponse('101')
      const page = Number(new URL(url).searchParams.get('page'))
      return jsonResponse(page === 1 ? rows.slice(0, 100) : truncate ? [] : rows.slice(100))
    })
    const provider = new SinaProvider(http, new FakeClock(NOW))
    expect((await provider.getSectorStocks('SINA:gn_x'))?.stocks).toHaveLength(101)
    provider.clearCache()
    truncate = true
    expect(await provider.getSectorStocks('SINA:gn_x')).toBeNull()
  })
})
