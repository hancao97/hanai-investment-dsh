import { describe, expect, it, vi } from 'vitest'
import { EastmoneyProvider } from '../../src/providers/eastmoney.ts'
import { GuruFocusProvider, MemoryValuationCache } from '../../src/providers/gurufocus.ts'
import { MarketDataService } from '../../src/providers/index.ts'
import { TencentProvider } from '../../src/providers/tencent.ts'
import {
  FakeClock,
  HandlerHttpClient,
  jsonResponse,
  loadProviderFixtures,
} from '../helpers.ts'

const fixtures = loadProviderFixtures()
const NOW = new Date('2026-08-15T10:00:00+08:00').getTime()

describe('EastmoneyProvider', () => {
  it('falls back to the delay cluster and preserves breadth and amount semantics', async () => {
    const clock = new FakeClock(NOW)
    const http = new HandlerHttpClient(url => {
      if (url.startsWith('https://push2ex.eastmoney.com/')) return jsonResponse(fixtures.eastmoney.breadth)
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/api/qt/stock/get')) {
        if (parsed.hostname !== 'push2delay.eastmoney.com') return jsonResponse({}, 503)
        const secId = parsed.searchParams.get('secid') ?? ''
        return jsonResponse({ data: fixtures.eastmoney.indices[secId] })
      }
      return jsonResponse({}, 404)
    })
    const provider = new EastmoneyProvider(http, { clock, minIntervalMs: 0 })

    const overview = await provider.getMarketOverview()

    expect(overview.indices).toHaveLength(6)
    expect(overview.breadth).toMatchObject({ up: 1250, down: 920, flat: 100, limitUp: 50, limitDown: 20 })
    expect(overview.breadth.totalAmount).toBe(1_100_000_000_000)
    expect(overview.meta).toMatchObject({ providerId: 'eastmoney-delay', cacheState: 'stale' })
  })

  it('parses sector and stock metrics fixtures with the original field mapping', async () => {
    const clock = new FakeClock(NOW)
    const http = new HandlerHttpClient(url => {
      if (url.includes('/api/qt/clist/get')) return jsonResponse(fixtures.eastmoney.sector)
      if (url.includes('/api/qt/stock/get')) return jsonResponse(fixtures.eastmoney.metrics)
      return jsonResponse({}, 404)
    })
    const provider = new EastmoneyProvider(http, { clock, minIntervalMs: 0 })

    const sector = await provider.getSectorBoard('industry')
    const metrics = await provider.getStockMetrics('1.600519')

    expect(sector.sectors[0]).toMatchObject({ code: 'BK001', name: '半导体', amount: 12_300_000_000 })
    expect(metrics).toMatchObject({
      secId: '1.600519',
      code: '600519',
      peDynamic: 25.2,
      peStatic: 24.5,
      peTtm: 24.8,
      volume: 10_000,
      listingDate: '2001-08-27',
    })
  })

  it('returns the last successful quote as stale when both clusters fail', async () => {
    const clock = new FakeClock(NOW)
    let online = true
    const http = new HandlerHttpClient(url => {
      if (online && url.includes('/api/qt/ulist.np/get')) return jsonResponse(fixtures.eastmoney.quote)
      return jsonResponse({}, 503)
    })
    const provider = new EastmoneyProvider(http, { clock, minIntervalMs: 0 })

    const fresh = await provider.getQuotes(['1.600519'])
    online = false
    const stale = await provider.getQuotes(['1.600519'])

    expect(fresh.quotes[0]).toMatchObject({ name: '贵州茅台', price: 1480.5 })
    expect(fresh.meta.cacheState).toBe('fresh')
    expect(stale.quotes).toEqual(fresh.quotes)
    expect(stale.meta).toMatchObject({ providerId: 'eastmoney-memory-cache', cacheState: 'stale' })
  })

  it('clears the real in-memory quote fallback without changing fetch behavior', async () => {
    const clock = new FakeClock(NOW)
    let online = true
    const http = new HandlerHttpClient(url => {
      if (online && url.includes('/api/qt/ulist.np/get')) return jsonResponse(fixtures.eastmoney.quote)
      return jsonResponse({}, 503)
    })
    const provider = new EastmoneyProvider(http, {
      clock,
      minIntervalMs: 0,
      realtimeFailureThreshold: 99,
      totalFailureThreshold: 99,
    })

    await provider.getQuotes(['1.600519'])
    online = false
    await expect(provider.getQuotes(['1.600519'])).resolves.toMatchObject({
      meta: { providerId: 'eastmoney-memory-cache' },
    })
    expect(provider.clearQuoteCache()).toBe(1)
    expect(provider.clearQuoteCache()).toBe(0)
    const afterClear = await provider.getQuotes(['1.600519'])
    expect(afterClear.quotes).toEqual([])
  })

  it('uses Tencent K-line fallback and keeps missing amount as null', async () => {
    const clock = new FakeClock(NOW)
    const http = new HandlerHttpClient(url => {
      if (url.includes('web.ifzq.gtimg.cn/appstock/app/fqkline/get')) {
        return jsonResponse(fixtures.tencent.kline)
      }
      return jsonResponse({}, 503)
    })
    const provider = new EastmoneyProvider(http, { clock, minIntervalMs: 0 })

    const result = await provider.getKline('1.600519', '101')

    expect(result.meta.providerId).toBe('tencent-fallback')
    expect(result.bars).toHaveLength(2)
    expect(result.bars[0]?.amount).toBeNull()
    expect(result.bars[0]?.volume).toBe(1000)
  })

  it('uses forward-adjusted paging for daily bars and full history for weekly bars', async () => {
    const clock = new FakeClock(NOW)
    const urls: string[] = []
    const http = new HandlerHttpClient(url => {
      if (url.includes('/api/qt/stock/kline/get')) {
        urls.push(url)
        return jsonResponse(fixtures.eastmoney.kline)
      }
      return jsonResponse({}, 404)
    })
    const provider = new EastmoneyProvider(http, { clock, minIntervalMs: 0 })

    const daily = await provider.getKline('1.600436', '101', '2018-06-08')
    const weekly = await provider.getKline('1.600436', '102')
    const dailyQuery = new URL(urls[0] ?? 'https://invalid.test').searchParams
    const weeklyQuery = new URL(urls[1] ?? 'https://invalid.test').searchParams

    expect(dailyQuery.get('fqt')).toBe('1')
    expect(dailyQuery.get('beg')).toBe('20150607')
    expect(dailyQuery.get('end')).toBe('20180607')
    expect(daily.hasMore).toBe(true)
    expect(weeklyQuery.get('fqt')).toBe('1')
    expect(weeklyQuery.get('beg')).toBe('19900101')
    expect(weeklyQuery.get('end')).toBe('20500101')
    expect(weekly.hasMore).toBe(false)
  })

  it('marks an empty successful daily history page as exhausted', async () => {
    const clock = new FakeClock(NOW)
    const http = new HandlerHttpClient(url => url.includes('/api/qt/stock/kline/get')
      ? jsonResponse({ data: { klines: [] } })
      : jsonResponse({}, 404))
    const provider = new EastmoneyProvider(http, { clock, minIntervalMs: 0 })

    const result = await provider.getKline('1.600436', '101', '1994-01-01')

    expect(result.bars).toEqual([])
    expect(result.hasMore).toBe(false)
    expect(http.requests).toHaveLength(1)
  })

  it('serializes requests through the injected clock and opens then closes its circuit breaker', async () => {
    const clock = new FakeClock(NOW)
    let online = true
    const http = new HandlerHttpClient(() => online
      ? jsonResponse(fixtures.eastmoney.sector)
      : jsonResponse({}, 503))
    const provider = new EastmoneyProvider(http, {
      clock,
      minIntervalMs: 120,
      realtimeFailureThreshold: 99,
      totalFailureThreshold: 2,
      breakerOpenMs: 1000,
    })

    await provider.getSectorBoard('industry')
    await provider.getSectorBoard('industry')
    expect(clock.sleeps).toContain(120)

    online = false
    await provider.getSectorBoard('industry')
    await provider.getSectorBoard('industry')
    await expect(provider.getSectorBoard('industry')).rejects.toThrow('行情源限流熔断中')

    clock.advance(1001)
    online = true
    await expect(provider.getSectorBoard('industry')).resolves.toMatchObject({ type: 'industry' })
  })

  it('rejects a security snapshot below 95 percent of the supplier total', async () => {
    const clock = new FakeClock(NOW)
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      f12: String(600000 + index),
      f13: 1,
      f14: `证券${index}`,
    }))
    const http = new HandlerHttpClient(url => {
      const page = new URL(url).searchParams.get('pn')
      return page === '1'
        ? jsonResponse({ data: { total: 200, diff: firstPage } })
        : jsonResponse({}, 503)
    })
    const provider = new EastmoneyProvider(http, { clock, minIntervalMs: 0 })

    await expect(provider.getAllSecurities()).resolves.toEqual([])
  })
})

describe('TencentProvider', () => {
  it('converts cumulative hands into per-minute volume and derives average price', async () => {
    const clock = new FakeClock(NOW)
    const http = new HandlerHttpClient(url => {
      if (url.includes('/minute/query')) return jsonResponse(fixtures.tencent.trend)
      return jsonResponse({}, 404)
    })
    const provider = new TencentProvider(http, clock)

    const result = await provider.getTrend('1.600519')

    expect(result?.prevClose).toBe(1462.2)
    expect(result?.points).toEqual([
      { time: '09:30', price: 1470, avgPrice: 1470, volume: 100 },
      { time: '09:31', price: 1472, avgPrice: 1471, volume: 60 },
    ])
  })

  it('keeps qfq and sends an exclusive end date when paging older daily bars', async () => {
    const clock = new FakeClock(NOW)
    let requestedUrl = ''
    const http = new HandlerHttpClient(url => {
      requestedUrl = url
      return jsonResponse(fixtures.tencent.kline)
    })
    const provider = new TencentProvider(http, clock)

    const result = await provider.getKline('1.600519', '101', '2018-06-08')

    expect(new URL(requestedUrl).searchParams.get('param')).toBe('sh600519,day,,2018-06-07,800,qfq')
    expect(result?.hasMore).toBe(true)
  })

  it('walks Tencent weekly pages back to the listing period and de-duplicates them', async () => {
    const clock = new FakeClock(NOW)
    const http = new HandlerHttpClient(url => {
      const param = new URL(url).searchParams.get('param') ?? ''
      const end = param.split(',')[3] ?? ''
      const rows = end === ''
        ? [
            ['2014-02-28', '100', '101', '102', '99', '1000'],
            ['2026-08-20', '130', '131', '132', '129', '2000'],
          ]
        : end === '2014-02-27'
          ? [
              ['2003-06-20', '10', '11', '12', '9', '3000'],
              ['2014-02-21', '98', '100', '101', '97', '1500'],
            ]
          : []
      return jsonResponse({ code: 0, data: { sh600436: { qfqweek: rows } } })
    })
    const provider = new TencentProvider(http, clock)

    const result = await provider.getFullKline('1.600436', '102')

    expect(result?.bars.map(bar => bar.date)).toEqual([
      '2003-06-20',
      '2014-02-21',
      '2014-02-28',
      '2026-08-20',
    ])
    expect(result?.hasMore).toBe(false)
    expect(http.requests).toHaveLength(3)
  })
})

describe('GuruFocusProvider', () => {
  it('selects the latest non-future value, caches for one day, then falls back stale', async () => {
    const clock = new FakeClock(NOW)
    let online = true
    let screenerBody: unknown
    const http = new HandlerHttpClient((url, request) => {
      if (!online) return jsonResponse({}, 503)
      if (url.includes('/_api/chart/')) return jsonResponse(fixtures.gurufocus.chart)
      if (url.includes('/_api/screener')) {
        screenerBody = JSON.parse(request.body ?? '{}')
        return jsonResponse(fixtures.gurufocus.screener)
      }
      return jsonResponse({}, 404)
    })
    const provider = new GuruFocusProvider(http, {
      clock,
      cache: new MemoryValuationCache(),
    })

    const fresh = await provider.getValuation('SH', '600519')
    const cached = await provider.getValuation('SH', '600519')
    clock.advance(24 * 60 * 60 * 1000 + 1)
    online = false
    const stale = await provider.getValuation('SH', '600519')

    expect(fresh).toMatchObject({
      stockId: 'SHSE:600519',
      ivDcf: 1234.5,
      medps: 1000,
      gfScore: 91,
      valuationRank: 6,
    })
    expect(fresh?.series.medps).toHaveLength(3)
    expect(cached?.meta.cacheState).toBe('cached')
    expect(stale?.meta.cacheState).toBe('stale')
    expect((screenerBody as { exchanges: string[] }).exchanges).toEqual(['SHSE'])
    expect(http.requests).toHaveLength(4)
  })

  it('routes Beijing securities through BJSE for both chart and screener requests', async () => {
    const clock = new FakeClock(NOW)
    let body: { exchanges?: string[] } = {}
    const http = new HandlerHttpClient((url, request) => {
      if (url.includes('/_api/chart/')) return jsonResponse(fixtures.gurufocus.chart)
      body = JSON.parse(request.body ?? '{}') as { exchanges?: string[] }
      return jsonResponse({ data: [] })
    })
    const provider = new GuruFocusProvider(http, { clock })

    await provider.getValuation('BJ', '430047')

    expect(http.requests.some(request => request.url.includes('BJSE%3A430047'))).toBe(true)
    expect(body.exchanges).toEqual(['BJSE'])
  })
})

describe('MarketDataService', () => {
  it('composes a stock detail with non-blocking provider results for the Host', async () => {
    const clock = new FakeClock(NOW)
    const http = new HandlerHttpClient((url) => {
      if (url.includes('/api/qt/ulist.np/get')) return jsonResponse(fixtures.eastmoney.quote)
      if (url.includes('/api/qt/stock/get')) return jsonResponse(fixtures.eastmoney.metrics)
      if (url.includes('/api/qt/stock/trends2/get')) return jsonResponse(fixtures.eastmoney.trend)
      if (url.includes('/api/qt/stock/kline/get')) return jsonResponse(fixtures.eastmoney.kline)
      if (url.includes('/_api/chart/')) return jsonResponse(fixtures.gurufocus.chart)
      if (url.includes('/_api/screener')) return jsonResponse(fixtures.gurufocus.screener)
      return jsonResponse({}, 404)
    })
    const service = new MarketDataService({
      http,
      clock,
      eastmoney: { minIntervalMs: 0 },
    })

    const detail = await service.getStockDetail('1.600519', {
      secId: '1.600519',
      code: '600519',
      name: '贵州茅台',
      exchange: 'SH',
      pinyinFull: 'guizhoumaotai',
      pinyinInitial: 'gzmt',
    })

    expect(detail.security?.name).toBe('贵州茅台')
    expect(detail.quote?.price).toBe(1480.5)
    expect(detail.metrics?.industry).toBe('白酒')
    expect(detail.trend).toHaveLength(2)
    expect(detail.trendPrevClose).toBe(1462.2)
    expect(detail.daily).toHaveLength(2)
    expect(detail.weekly).toHaveLength(2)
    expect(detail.monthly).toHaveLength(2)
    expect(detail.valuation?.medps).toBe(1000)
    expect(detail.sources.quote?.providerId).toBe('eastmoney')
    expect(detail.sources.trend?.providerId).toBe('eastmoney')
    expect(detail.sources.daily?.providerId).toBe('eastmoney')
    expect(detail.sources.valuation?.providerId).toBe('gurufocus-cn-prototype')
  })

  it('keeps the trend provider previous close when the quote surface is unavailable', async () => {
    const clock = new FakeClock(NOW)
    const service = new MarketDataService({
      http: new HandlerHttpClient(() => jsonResponse({}, 503)),
      clock,
      eastmoney: { minIntervalMs: 0 },
    })
    vi.spyOn(service.eastmoney, 'getQuotes').mockRejectedValue(new Error('quote unavailable'))
    vi.spyOn(service.eastmoney, 'getStockMetrics').mockResolvedValue(null)
    vi.spyOn(service.eastmoney, 'getTrend').mockResolvedValue({
      points: [{ time: '09:30', price: 1470, avgPrice: 1470, volume: 100 }],
      prevClose: 1462.2,
      meta: {
        providerId: 'tencent-fallback', sourceName: '腾讯证券', sourceTimestamp: null,
        fetchedAt: '2026-08-15T02:00:00.000Z', cacheState: 'fresh',
      },
    })
    vi.spyOn(service.eastmoney, 'getKline').mockRejectedValue(new Error('kline unavailable'))
    vi.spyOn(service.gurufocus, 'getValuation').mockResolvedValue(null)

    const detail = await service.getStockDetail('1.600519')

    expect(detail.quote).toBeNull()
    expect(detail.trend).toHaveLength(1)
    expect(detail.trendPrevClose).toBe(1462.2)
    expect(detail.sources.quote).toBeNull()
    expect(detail.sources.trend?.providerId).toBe('tencent-fallback')
  })

  it('fetches quote and metrics without touching trend, k-line, or valuation providers', async () => {
    const service = new MarketDataService({
      http: new HandlerHttpClient(() => jsonResponse({}, 503)),
      clock: new FakeClock(NOW),
      eastmoney: { minIntervalMs: 0 },
    })
    const quotes = vi.spyOn(service.eastmoney, 'getQuotes').mockRejectedValue(new Error('offline'))
    const metrics = vi.spyOn(service.eastmoney, 'getStockMetrics').mockResolvedValue(null)
    const trend = vi.spyOn(service.eastmoney, 'getTrend')
    const kline = vi.spyOn(service.eastmoney, 'getKline')
    const valuation = vi.spyOn(service.gurufocus, 'getValuation')

    await expect(service.getStockQuoteMetrics('1.600519')).resolves.toEqual({
      quote: null,
      metrics: null,
      sources: { quote: null, metrics: null },
    })
    expect(quotes).toHaveBeenCalledOnce()
    expect(metrics).toHaveBeenCalledOnce()
    expect(trend).not.toHaveBeenCalled()
    expect(kline).not.toHaveBeenCalled()
    expect(valuation).not.toHaveBeenCalled()
  })

  it('keeps independently available detail surfaces when one facade request rejects', async () => {
    const service = new MarketDataService({
      http: new HandlerHttpClient(() => jsonResponse({}, 503)),
      clock: new FakeClock(NOW),
      eastmoney: { minIntervalMs: 0 },
    })
    vi.spyOn(service, 'getStockQuoteMetrics').mockRejectedValue(new Error('quote facade failed'))
    vi.spyOn(service, 'getTrend').mockResolvedValue({
      trend: [{ time: '09:30', price: 1470, avgPrice: 1470, volume: 100 }],
      trendPrevClose: 1462.2,
      meta: null,
    })
    vi.spyOn(service, 'getKline').mockImplementation(async (_secId, period) => ({
      period,
      bars: period === 'daily'
        ? [{ date: '2026-08-15', open: 1460, close: 1470, high: 1480, low: 1450, volume: 1000, amount: null }]
        : [],
      meta: null,
      hasMore: period === 'daily',
    }))
    vi.spyOn(service, 'getValuation').mockResolvedValue({ valuation: null, meta: null })

    const detail = await service.getStockDetail('1.600519')

    expect(detail.quote).toBeNull()
    expect(detail.metrics).toBeNull()
    expect(detail.trend).toHaveLength(1)
    expect(detail.daily).toHaveLength(1)
    expect(detail.weekly).toEqual([])
    expect(detail.monthly).toEqual([])
  })
})
