import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HanaiDatabase } from '../src/database.ts'
import { MarketHistoryStore } from '../src/market-history.ts'
import { marketDateFromMeta } from '../../contracts/src/market-history.ts'
import type { MarketOverview, ProviderMeta } from '../../contracts/src/index.ts'
import { marketHistoryPanel } from '../../contracts/src/market-history.ts'

const roots: string[] = []
const databases: HanaiDatabase[] = []
const NOW = Date.parse('2026-10-27T10:00:00+08:00')
const meta: ProviderMeta = { providerId: 'test', sourceName: '测试数据', sourceTimestamp: '2026-10-27T02:00:00.000Z', fetchedAt: new Date(NOW).toISOString(), cacheState: 'fresh' }
const breadth = { up: 2, down: 3, flat: 0, limitUp: 0, limitDown: 1, qdate: '2026-10-27', meta }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'hanai-market-history-'))
  roots.push(root)
  const path = join(root, 'history.sqlite')
  const db = new HanaiDatabase(path)
  databases.push(db)
  return { db, path, store: new MarketHistoryStore(db.sqlite) }
}

describe('daily market panel history', () => {
  it('lists only market dates and market capture times while retaining all macro history internally', () => {
    const { store } = setup()
    const macro = { points: [{ date: '2026-10-26', close: 4000 }], meta }
    const early = '2026-10-27T01:00:00Z', later = '2026-10-27T02:00:00Z'
    store.save('macro.index', macro, meta, '2026-10-01', later)
    store.save('macro.index', macro, meta, '2026-10-27', later)
    store.save('breadth', breadth, meta, '2026-10-27', early)
    store.save('global.indices', { indices: [{ code: 'HSI', name: '恒生指数', price: 20000, change: 0, changePct: 0, amount: null, marketDate: '2026-10-26', meta }], meta }, meta, '2026-10-26', early)
    store.save('sector:BK0001', { stocks: [], meta }, meta, '2026-10-25', early)
    expect(store.list('market')).toEqual([
      { date: '2026-10-27', capturedAt: early, panels: ['breadth'] },
      { date: '2026-10-26', capturedAt: early, panels: ['global.indices'] },
      { date: '2026-10-25', capturedAt: early, panels: ['sector:BK0001'] },
    ])
    expect(store.list()).toHaveLength(4)
    expect(marketHistoryPanel(store.get('2026-10-01'), 'macro.index')).toEqual(macro)
    expect(store.get('2026-10-27')?.panels).toEqual(['breadth', 'macro.index'])
  })
  it('merges overseas rows by source time without replacing saved quotes with missing or older results', () => {
    const { store } = setup()
    const batch = { ...meta, sourceTimestamp: null }
    const row = (code: string, price: number | null, source = meta) => ({ code, name: code, price, change: 0, changePct: 0, amount: null, marketDate: '2026-10-27', meta: source })
    store.save('global.indices', { indices: [row('HSI', 100), row('IXIC', 200)], meta: batch }, batch)
    const later = { ...meta, sourceTimestamp: '2026-10-27T03:00:00Z', fetchedAt: '2026-10-27T03:01:00Z' }
    const next = { ...batch, fetchedAt: later.fetchedAt }
    store.save('global.indices', { indices: [row('HSI', null, { ...later, cacheState: 'unavailable' }), row('IXIC', 201, later)], meta: next }, next)
    expect(marketHistoryPanel(store.get('2026-10-27'), 'global.indices')?.indices).toEqual([row('HSI', 100), row('IXIC', 201, later)])
    const before = store.get('2026-10-27')
    store.save('global.indices', { indices: [row('HSI', 99), row('IXIC', 199)], meta: next }, next)
    expect(store.get('2026-10-27')).toEqual(before)
  })
  it('merges newer partial indices with per-index times and never sums a retained old constituent', () => {
    const { store } = setup()
    const index = (code: string, price: number, amount: number, source = meta) => ({ code, name: code, price, amount, change: 0, changePct: 0, upCount: null, downCount: null, flatCount: null, meta: source })
    const overview: MarketOverview = { indices: ['000001', '399001', '399006', '000300', '000688', '899050'].map(code => index(code, 100, 10)),
      breadth: { up: null, down: null, flat: null, limitUp: null, limitDown: null, totalAmount: 20 }, meta, marketStatus: 'trading' }
    store.save('overview', overview, meta)
    const close = { ...meta, sourceTimestamp: '2026-10-27T07:00:00Z', cacheState: 'stale' as const }
    store.save('overview', { ...overview, meta: close, indices: overview.indices.slice(0, 5).map(row => index(row.code, 200, 20, close)) }, close)
    let restored = marketHistoryPanel(store.get('2026-10-27'), 'overview')!
    expect(restored.indices).toHaveLength(6)
    expect(restored.indices.find(row => row.code === '899050')).toMatchObject({ price: 100, meta })
    expect(restored.indices.find(row => row.code === '000001')).toMatchObject({ price: 200, meta: close })
    expect(restored.breadth.totalAmount).toBe(40)
    const later = { ...close, sourceTimestamp: '2026-10-27T07:01:00Z' }
    store.save('overview', { ...overview, meta: later, indices: [index('000001', 201, 21, later)] }, later)
    restored = marketHistoryPanel(store.get('2026-10-27'), 'overview')!
    expect(restored.breadth.totalAmount).toBeNull()
    expect(restored.indices.find(row => row.code === '399001')?.price).toBe(200)
    const before = store.get('2026-10-27')
    store.save('overview', overview, meta)
    expect(store.get('2026-10-27')).toEqual(before)
    // One index can advance while the newest timestamp of the whole panel stays unchanged.
    const intermediate = { ...meta, sourceTimestamp: '2026-10-27T06:00:00Z' }
    store.save('overview', { ...overview, indices: [index('899050', 150, 15, intermediate)] }, meta)
    expect(marketHistoryPanel(store.get('2026-10-27'), 'overview')?.indices.find(row => row.code === '899050')?.price).toBe(150)
  })

  it('persists complete payloads across restart and merges independent and future panels', () => {
    const { db, path, store } = setup()
    store.save('breadth', breadth, meta)
    store.save('future.sentiment', { temperature: 56, reasons: ['真实记录'] }, meta)
    expect(store.get('2026-10-27')?.panels).toEqual(['breadth', 'future.sentiment'])
    db.close()
    databases.splice(databases.indexOf(db), 1)
    const restarted = new HanaiDatabase(path)
    databases.push(restarted)
    const record = new MarketHistoryStore(restarted.sqlite).get('2026-10-27')!
    expect(record.records.breadth?.data).toEqual(breadth)
    expect(record.records['future.sentiment']?.data).toEqual({ temperature: 56, reasons: ['真实记录'] })
  })

  it('never overwrites a successful panel with unavailable, stale, cached or out-of-order data', () => {
    const { store } = setup()
    store.save('breadth', breadth, meta)
    const first = store.get('2026-10-27')
    for (const cacheState of ['unavailable', 'stale', 'cached'] as const) store.save('breadth', { ...breadth, up: 99 }, { ...meta, cacheState })
    store.save('breadth', { ...breadth, up: 98 }, { ...meta, sourceTimestamp: '2026-10-27T01:59:00.000Z' })
    expect(store.get('2026-10-27')).toEqual(first)
    vi.advanceTimersByTime(60_000)
    const nextMeta = { ...meta, sourceTimestamp: '2026-10-27T02:01:00.000Z', fetchedAt: new Date().toISOString() }
    store.save('breadth', { ...breadth, up: 4, meta: nextMeta }, nextMeta)
    expect(store.get('2026-10-27')?.records.breadth?.data).toMatchObject({ up: 4 })
  })

  it('does not silently delete dates older than ninety days', () => {
    const { store } = setup()
    for (let index = 0; index < 95; index += 1) {
      const timestamp = NOW - index * 86_400_000
      const valueMeta = { ...meta, sourceTimestamp: new Date(timestamp).toISOString(), fetchedAt: new Date(timestamp).toISOString() }
      store.save('future.panel', { index }, valueMeta)
    }
    expect(store.list()).toHaveLength(95)
    expect(store.list()[0]?.date).toBe('2026-10-27')
  })

  it('archives explicitly dated closing data even when stale, but a failed retry cannot replace it', () => {
    const { store } = setup()
    const closedMeta = { ...meta, cacheState: 'stale' as const, sourceTimestamp: '2026-10-26T07:00:00Z' }
    store.save('breadth', { ...breadth, qdate: '2026-10-26', meta: closedMeta }, closedMeta)
    expect(store.get('2026-10-26')?.panels).toEqual(['breadth'])
    const first = store.get('2026-10-26')
    store.save('breadth', { ...breadth, qdate: '2026-10-26', up: 99 }, { ...closedMeta, sourceTimestamp: '2026-10-26T07:01:00Z' })
    expect(store.get('2026-10-26')).not.toEqual(first)
    const previous = store.get('2026-10-26')
    store.save('breadth', { ...breadth, qdate: '2026-10-26', up: 999 }, { ...closedMeta, fetchedAt: new Date(NOW + 60_000).toISOString() })
    expect(store.get('2026-10-26')).toEqual(previous)
    store.save('breadth', breadth, meta)
    const closingMeta = { ...meta, sourceTimestamp: '2026-10-27T07:00:00Z', cacheState: 'stale' as const }
    store.save('breadth', { ...breadth, up: 5, meta: closingMeta }, closingMeta)
    expect(store.get('2026-10-27')?.records.breadth?.data).toMatchObject({ up: 5 })
    store.save('future.unknown-date', { count: 1 }, { ...closedMeta, sourceTimestamp: null })
    expect(store.get('2026-10-27')?.panels).toEqual(['breadth'])
  })

  it('keeps other panels available when a panel is damaged or uses a newer schema', () => {
    const { db, store } = setup()
    store.save('breadth', breadth, meta)
    store.save('future.corrupt', { ready: true }, meta)
    db.sqlite.prepare("UPDATE market_panel_snapshots SET payload = 'broken' WHERE panel_key = 'future.corrupt'").run()
    expect(store.get('2026-10-27')?.panels).toEqual(['breadth'])
    db.sqlite.prepare("UPDATE market_panel_snapshots SET version = 99 WHERE panel_key = 'breadth'").run()
    expect(store.get('2026-10-27')).toBeNull()
  })

  it('uses the actual source date and Beijing timezone instead of the request date', () => {
    expect(marketDateFromMeta({ ...meta, sourceTimestamp: '2026-10-26T23:30:00Z' })).toBe('2026-10-27')
    expect(marketDateFromMeta({ ...meta, sourceTimestamp: '2026-10-26' })).toBe('2026-10-26')
    const { store } = setup()
    store.save('breadth', { ...breadth, qdate: '2026-10-26' }, { ...meta, sourceTimestamp: '2026-10-26T07:00:00Z' })
    expect(store.get('2026-10-27')).toBeNull()
    expect(store.get('2026-10-26')).not.toBeNull()
  })

  it('rejects invalid dates, malformed known payloads and unknown response shapes', () => {
    const { store } = setup()
    expect(() => store.get('2026-02-30')).toThrow('日期')
    expect(() => store.save('breadth', { up: '0' }, meta)).toThrow('数据')
    expect(store.get('2026-10-26')).toBeNull()
  })
})
