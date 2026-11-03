import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketDataService } from '../../src/providers/index.ts'
import { SinaProvider } from '../../src/providers/sina.ts'
import { FakeClock, HandlerHttpClient, jsonResponse } from '../helpers.ts'

const NOW = Date.parse('2026-10-26T10:00:00+08:00')
const rows = Array.from({ length: 1001 }, (_, index) => {
  const symbol = index === 0 ? 'bj920000' : index === 1 ? 'sz000001' : `sh${600000 + index}`
  return { symbol, code: symbol.slice(2), name: index === 2 ? '*ST测试' : `证券${index}`, trade: '0.000', settlement: '10.000', volume: 0 }
})
const securities = rows.map(row => ({ code: row.code, name: row.name, market: row.symbol.startsWith('sh') ? 1 : 0 }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

function sinaHttp(mode: 'complete' | 'truncated' | 'duplicate' | 'invalid' | 'no-count') {
  return new HandlerHttpClient(url => {
    if (url.includes('getHQNodeStockCount')) return jsonResponse(mode === 'no-count' ? [] : String(rows.length))
    const page = Number(new URL(url).searchParams.get('page'))
    if (mode === 'truncated' && page === 2) return jsonResponse([])
    const offset = mode === 'duplicate' ? 0 : (page - 1) * 100
    return jsonResponse(rows.slice(offset, offset + 100).map(row => mode === 'invalid' ? { ...row, code: 'bad' } : row))
  })
}

describe('security master fallback', () => {
  it('does not probe or record successful source calls when reading diagnostics or requesting no securities', async () => {
    const http = sinaHttp('complete')
    const service = new MarketDataService({ http, clock: new FakeClock(NOW) })
    const before = service.getSourceDiagnostics()
    expect(before.every(source => source.lastAttemptAt === null)).toBe(true)
    expect((await service.getQuotes([])).quotes).toEqual([])
    expect(service.getSourceDiagnostics()).toEqual(before)
    expect(http.requests).toHaveLength(0)
  })

  it('paginates the full Sina list including Beijing, ST and suspended securities without requiring prices', async () => {
    const http = sinaHttp('complete')
    const clock = new FakeClock(NOW)
    const result = await new SinaProvider(http, clock).getAllSecurities()
    expect(result).toEqual(securities)
    expect(result[0]).toEqual({ market: 0, code: '920000', name: '证券0' })
    expect(http.requests).toHaveLength(12)
    expect(clock.sleeps).toEqual(Array(10).fill(120))
    expect(http.requests.slice(1).every(({ url }) => new URL(url).searchParams.get('sort') === 'symbol')).toBe(true)
  })

  it('retries only a transient short page and retains the full market snapshot', async () => {
    const complete = sinaHttp('complete')
    const pages: number[] = []
    let shortPages = 0
    const http = new HandlerHttpClient((url, request) => {
      if (url.includes('getHQNodeData')) {
        const page = Number(new URL(url).searchParams.get('page'))
        pages.push(page)
        if (page === 2 && shortPages++ < 2) return jsonResponse(shortPages === 1 ? [] : rows.slice(100, 150))
      }
      return complete.request(url, request)
    })
    const clock = new FakeClock(NOW)
    expect(await new SinaProvider(http, clock).getAllSecurities()).toEqual(securities)
    expect(pages.filter(page => page === 1)).toHaveLength(1)
    expect(pages.filter(page => page === 2)).toHaveLength(3)
    expect(clock.sleeps.filter(ms => ms >= 500)).toEqual([500, 1000])
  })

  it('bounds retries and reports the failed page when a short page never recovers', async () => {
    const http = sinaHttp('truncated')
    await expect(new SinaProvider(http, new FakeClock(NOW)).getAllSecurities()).rejects.toThrow('第 2 页不完整（0/100 条）')
    expect(http.requests.filter(({ url }) => new URL(url).searchParams.get('page') === '2')).toHaveLength(3)
    expect(http.requests.some(({ url }) => new URL(url).searchParams.get('page') === '3')).toBe(false)
  })

  it.each(['truncated', 'duplicate', 'invalid', 'no-count'] as const)('rejects a %s snapshot', async mode => {
    await expect(new SinaProvider(sinaHttp(mode), new FakeClock(NOW)).getAllSecurities()).rejects.toThrow('主数据')
  })

  it('uses Sina first and falls back to Eastmoney when Sina fails', async () => {
    const service = new MarketDataService({ http: sinaHttp('complete'), clock: new FakeClock(NOW) })
    const primary = vi.spyOn(service.sina, 'getAllSecurities').mockResolvedValue(securities)
    const fallback = vi.spyOn(service.eastmoney, 'getAllSecurities').mockResolvedValue(securities)
    expect(await service.getAllSecurities()).toEqual(securities)
    expect(fallback).not.toHaveBeenCalled()
    primary.mockRejectedValue(new Error('offline'))
    expect(await service.getAllSecurities()).toEqual(securities)
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('counts empty, partial and duplicate lists as failures, skips a source after three failures and recovers after five minutes', async () => {
    const clock = new FakeClock(NOW)
    const service = new MarketDataService({ clock })
    const primary = vi.spyOn(service.sina, 'getAllSecurities')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(securities.slice(0, 999))
      .mockResolvedValueOnce(Array(1001).fill(securities[0]))
      .mockResolvedValue(securities)
    const fallback = vi.spyOn(service.eastmoney, 'getAllSecurities').mockResolvedValue(securities)
    vi.spyOn(service.sina, 'getSectorStocks').mockResolvedValue(null)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await service.getAllSecurities()).toEqual(securities)
      await service.getSectorStocks('SINA:new_x')
    }
    expect(primary).toHaveBeenCalledTimes(3)
    expect(fallback).toHaveBeenCalledTimes(4)
    clock.advance(5 * 60_000)
    expect(await service.getAllSecurities()).toEqual(securities)
    expect(primary).toHaveBeenCalledTimes(4)
    expect(fallback).toHaveBeenCalledTimes(4)
  })

  it('resets consecutive failures after a complete snapshot succeeds', async () => {
    const service = new MarketDataService({ clock: new FakeClock(NOW) })
    const primary = vi.spyOn(service.sina, 'getAllSecurities')
      .mockResolvedValueOnce([]).mockResolvedValueOnce([])
      .mockResolvedValueOnce(securities)
      .mockResolvedValueOnce([]).mockResolvedValueOnce([])
      .mockResolvedValue(securities)
    vi.spyOn(service.eastmoney, 'getAllSecurities').mockResolvedValue(securities)
    for (let attempt = 0; attempt < 6; attempt += 1) expect(await service.getAllSecurities()).toEqual(securities)
    expect(primary).toHaveBeenCalledTimes(6)
  })

  it('also opens the Eastmoney circuit when both sources fail and returns no replacement snapshot', async () => {
    const service = new MarketDataService({ clock: new FakeClock(NOW) })
    const primary = vi.spyOn(service.sina, 'getAllSecurities').mockRejectedValue(new Error('offline'))
    const fallback = vi.spyOn(service.eastmoney, 'getAllSecurities').mockResolvedValue([])
    for (let attempt = 0; attempt < 4; attempt += 1) expect(await service.getAllSecurities()).toEqual([])
    expect(primary).toHaveBeenCalledTimes(3)
    expect(fallback).toHaveBeenCalledTimes(3)
  })
})
