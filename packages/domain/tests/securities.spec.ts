import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StockQuote } from '../../contracts/src/index.ts'
import { HanaiDatabase } from '../src/database.ts'
import { SecuritiesService, type SecurityDataProvider } from '../src/securities.ts'
import type { EastmoneySecurityRow } from '../src/providers/eastmoney.ts'
import { MarketDataService } from '../src/providers/index.ts'
import { FakeClock } from './helpers.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function securityRows(): EastmoneySecurityRow[] {
  const rows: EastmoneySecurityRow[] = [
    { market: 1, code: '600000', name: '浦发银行' },
    { market: 0, code: '000001', name: '平安银行' },
  ]
  for (let index = 2; index < 1000; index += 1) {
    rows.push({ market: 0, code: String(100000 + index), name: `测试证券${index}` })
  }
  return rows
}

function quote(secId: string): StockQuote {
  return {
    secId,
    code: secId.split('.')[1] ?? '',
    name: '平安银行',
    price: 12.34,
    change: 0.1,
    changePct: 0.82,
    amount: null,
    volume: null,
    turnoverRate: null,
    marketCap: null,
    floatCap: null,
    pe: null,
    pb: null,
    high: null,
    low: null,
    open: null,
    prevClose: null,
  }
}

class FakeSecurityProvider implements SecurityDataProvider {
  rows = securityRows()
  syncCalls = 0
  quoteCalls = 0
  quotesFail = false

  async getAllSecurities(): Promise<EastmoneySecurityRow[]> {
    this.syncCalls += 1
    return this.rows
  }

  async getQuotes(secIds: readonly string[]): Promise<{ quotes: StockQuote[] }> {
    this.quoteCalls += 1
    if (this.quotesFail) throw new Error('offline')
    return { quotes: secIds.includes('0.000001') ? [quote('0.000001')] : [] }
  }
}

function database(): HanaiDatabase {
  const root = mkdtempSync(join(tmpdir(), 'hanai-securities-'))
  roots.push(root)
  return new HanaiDatabase(join(root, 'hanai.sqlite'))
}

describe('SecuritiesService', () => {
  it('prefers BaoStock names and supplements missing markets without dropping the existing universe on failure', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-02T20:00:00+08:00'))
    const db = database(), market = new MarketDataService({ clock: new FakeClock(Date.now()) })
    try {
      const primary = securityRows().map(row => ({ ...row, name: `BaoStock-${row.name}` }))
      const primaryFetch = vi.spyOn(market.baostock, 'securities').mockResolvedValue(primary)
      const sina = vi.spyOn(market.sina, 'getAllSecurities').mockResolvedValue([...securityRows(), { market: 0, code: '920001', name: '北交所补缺' }])
      vi.spyOn(market.eastmoney, 'getAllSecurities').mockResolvedValue([])
      await market.syncScreeningSecurities(db, new AbortController().signal)
      expect(db.securityCount()).toBe(1001)
      expect(db.getSecurity('1.600000')?.name).toBe('BaoStock-浦发银行')
      expect(db.getSecurity('0.920001')?.name).toBe('北交所补缺')
      await market.syncScreeningSecurities(db, new AbortController().signal, false)
      expect(primaryFetch).toHaveBeenCalledTimes(1)
      expect(sina).toHaveBeenCalledTimes(1)
      sina.mockRejectedValue(new Error('supplement unavailable'))
      await expect(market.syncScreeningSecurities(db, new AbortController().signal)).rejects.toThrow('保留本地名录')
      expect(db.securityCount()).toBe(1001)
    } finally { market.dispose(); db.close(); vi.useRealTimers() }
  })
  it('does not write a late catalogue response after the host aborts and closes its database', async () => {
    const db = database(), provider = new FakeSecurityProvider(), controller = new AbortController()
    let release!: (rows: EastmoneySecurityRow[]) => void
    vi.spyOn(provider, 'getAllSecurities').mockReturnValue(new Promise(resolve => { release = resolve }))
    const service = new SecuritiesService(db, provider)
    const pending = service.sync(true, controller.signal)
    controller.abort(); db.close(); release(securityRows())
    await expect(pending).rejects.toBe(controller.signal.reason)
  })
  it('installs the fallback snapshot through the market facade and retains it when every source fails', async () => {
    const db = database()
    try {
      const market = new MarketDataService({ clock: new FakeClock(Date.parse('2026-10-26T10:00:00+08:00')) })
      const sina = vi.spyOn(market.sina, 'getAllSecurities').mockResolvedValue(securityRows())
      vi.spyOn(market.eastmoney, 'getAllSecurities').mockResolvedValue([])
      const synced = await market.syncSecurities(db, true)
      expect(synced.count).toBe(1000)
      expect(db.getSetting('security.master.source')).toBe('新浪')
      expect(db.getSecurity('0.000001')).toMatchObject({ name: '平安银行', exchange: 'SZ' })
      await market.syncSecurities(db, false)
      expect(sina).toHaveBeenCalledTimes(1)
      sina.mockRejectedValue(new Error('offline'))
      expect(await market.syncSecurities(db, true)).toEqual(synced)
      expect(db.getSetting('security.master.source')).toBe('新浪')
      expect(db.getSecurity('0.000001')?.name).toBe('平安银行')
    } finally {
      db.close()
    }
  })

  it('atomically installs a complete snapshot and searches code/name/pinyin with quote enrichment', async () => {
    const db = database()
    const provider = new FakeSecurityProvider()
    const clock = new FakeClock(new Date('2026-08-15T10:00:00+08:00').getTime())
    const service = new SecuritiesService(db, provider, { clock })

    const synced = await service.sync(true)
    const byPinyin = await service.search('payh')
    const byCode = await service.search('6000')

    expect(synced).toEqual({ count: 1000, updatedAt: '2026-08-15T02:00:00.000Z' })
    expect(service.get('0.000001')).toMatchObject({ name: '平安银行', exchange: 'SZ', pinyinInitial: 'payh' })
    expect(byPinyin[0]).toMatchObject({ secId: '0.000001', price: 12.34, changePct: 0.82 })
    expect(byCode[0]).toMatchObject({ secId: '1.600000', name: '浦发银行' })
    db.close()
  })

  it('skips a fresh daily sync and never replaces existing data with an incomplete snapshot', async () => {
    const db = database()
    const provider = new FakeSecurityProvider()
    const clock = new FakeClock(new Date('2026-08-15T10:00:00+08:00').getTime())
    const service = new SecuritiesService(db, provider, { clock })

    await service.sync(true)
    const skipped = await service.sync(false)
    provider.rows = [{ market: 1, code: '600519', name: '贵州茅台' }]
    clock.advance(25 * 60 * 60 * 1000)
    const preserved = await service.sync(true)

    expect(provider.syncCalls).toBe(2)
    expect(skipped.count).toBe(1000)
    expect(preserved).toEqual(skipped)
    expect(db.getSecurity('0.000001')?.name).toBe('平安银行')
    db.close()
  })

  it('keeps local search available when quote enrichment fails', async () => {
    const db = database()
    const provider = new FakeSecurityProvider()
    provider.quotesFail = true
    const service = new SecuritiesService(db, provider)
    await service.sync(true)

    const results = await service.search('平安')

    expect(results[0]).toMatchObject({ name: '平安银行', price: null, changePct: null })
    db.close()
  })
})
