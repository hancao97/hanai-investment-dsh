import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { TechnicalHistoryStore } from '../src/technical-history.ts'
import type { TechnicalBar } from '../../contracts/src/technical-screen.ts'

const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  return { db, store: new TechnicalHistoryStore(db) }
}
const bar = (date: string, close = 10): TechnicalBar => ({ date, open: close, high: close, low: close, close, volume: 100 })
const fetched = '2026-10-31T08:00:00.000Z'

it('persists daily inputs independently of query history and can reopen the store', () => {
  const { store, db } = fixture(), bars = [bar('2026-10-29'), bar('2026-10-30')]
  store.write('600519', 'qfq', '2026-10-30', bars, 'fixture', fetched)
  expect(new TechnicalHistoryStore(db).read('600519', 'qfq', '2026-10-30')).toEqual(bars)
  expect(store.read('600519', 'none', '2026-10-30')).toBeNull()
  expect(store.read('600519', 'qfq', '2026-10-29')).toBeNull()
})

it('replaces the complete adjusted basis and never mixes prices across adjustment dates', () => {
  const { store } = fixture()
  store.write('600519', 'qfq', '2026-10-29', [bar('2026-10-28', 10), bar('2026-10-29', 11)], 'fixture', fetched)
  store.write('600519', 'qfq', '2026-10-30', [bar('2026-10-29', 5), bar('2026-10-30', 6)], 'fixture', fetched)
  expect(store.read('600519', 'qfq', '2026-10-30')).toEqual([bar('2026-10-29', 5), bar('2026-10-30', 6)])
  store.write('600519', 'qfq', '2026-10-29', [bar('2026-10-29', 99)], 'fixture', fetched)
  expect(store.read('600519', 'qfq', '2026-10-30')?.at(-1)?.close).toBe(6)
})

it('accumulates raw history and preserves newer corrections when older backfills arrive', () => {
  const { store } = fixture()
  store.write('600519', 'none', '2026-10-29', [bar('2026-10-28'), bar('2026-10-29')], 'fixture', fetched)
  store.write('600519', 'none', '2026-10-30', [bar('2026-10-29', 12), bar('2026-10-30')], 'fixture', fetched)
  store.write('600519', 'none', '2026-10-29', [bar('2026-10-29', 99)], 'fixture', '2026-10-30T08:00:00.000Z')
  expect(store.read('600519', 'none', '2026-10-30')).toEqual([bar('2026-10-28'), bar('2026-10-29', 12), bar('2026-10-30')])
  expect(store.read('600519', 'none', '2026-10-29')?.at(-1)?.close).toBe(12)
  expect(store.read('600519', 'none', '2026-10-27')).toBeNull()
})

it('rejects stale, empty or invalid input without replacing previously valid data', () => {
  const { store } = fixture(), bars = [bar('2026-10-30')]
  store.write('600519', 'qfq', '2026-10-30', bars, 'fixture', fetched)
  expect(() => store.write('600519', 'qfq', '2026-10-30', [bar('2026-10-27')], 'fixture', fetched)).toThrow('日线滞后')
  for (const invalid of [[], [bar('2026-10-30'), bar('2026-10-30')], [{ ...bar('2026-10-30'), high: 9 }]]) {
    expect(() => store.write('600519', 'qfq', '2026-10-30', invalid, 'fixture', fetched)).toThrow()
  }
  expect(store.read('600519', 'qfq', '2026-10-30')).toEqual(bars)
})

it('finds reusable paired windows without treating a single basis or empty adjusted payload as ready', () => {
  const { store, db } = fixture()
  store.write('600519', 'none', '2026-10-30', [bar('2026-10-30')], 'fixture', fetched)
  expect(store.readyCodes('2026-10-30').size).toBe(0)
  store.write('600519', 'qfq', '2026-10-30', [bar('2026-10-30')], 'fixture', fetched)
  expect([...store.readyCodes('2026-10-30')]).toEqual(['600519'])
  expect(store.readyCodes('2026-11-02').size).toBe(0)
  db.prepare("UPDATE stock_daily_basis SET payload='[]' WHERE adjustment='qfq'").run()
  expect(store.readyCodes('2026-10-30').size).toBe(0)
})

it('persists dated positive-only limit facts without turning missing dates into empty successes', () => {
  const { store, db } = fixture()
  const input = { date: '2026-10-30', codes: ['600519'], source: 'fixture', scope: 'source-pool-positive-only' as const, fetchedAt: fetched }
  store.writeLimitPool(input)
  expect(new TechnicalHistoryStore(db).limitPool('2026-10-30')).toEqual(input)
  expect(store.limitPool('2026-10-29')).toBeNull()
  expect(() => store.writeLimitPool({ ...input, codes: ['600519', '600519'] })).toThrow()
  store.writeLimitPool({ ...input, codes: [], fetchedAt: '2026-10-30T08:00:00.000Z' })
  expect(store.limitPool('2026-10-30')?.codes).toEqual(['600519'])
})

it('preserves source amounts including real zero without inventing amounts for old rows', () => {
  const { store } = fixture()
  store.write('600519', 'none', '2026-10-30', [{ ...bar('2026-10-29'), amount: 0 }, { ...bar('2026-10-30'), amount: null }], 'fixture', fetched)
  expect(store.read('600519', 'none', '2026-10-30')?.map(row => row.amount)).toEqual([0, null])
})

it('retains BaoStock state and raw priority while allowing fallback dates and complete qfq replacement', () => {
  const { store } = fixture()
  const primary = { ...bar('2026-10-29'), prevClose: 9.9, tradeStatus: 1 as const, isST: true, peTtm: 8, pb: 1 }
  store.write('600519', 'none', '2026-10-29', [primary], 'baostock', fetched)
  store.write('600519', 'none', '2026-10-30', [bar('2026-10-29', 12), bar('2026-10-30')], 'tencent', '2026-10-31T09:00:00.000Z')
  expect(store.read('600519', 'none', '2026-10-30')).toEqual([primary, bar('2026-10-30')])
  store.write('600519', 'qfq', '2026-10-29', [primary], 'baostock', fetched)
  store.write('600519', 'qfq', '2026-10-30', [bar('2026-10-29', 5), bar('2026-10-30', 6)], 'tencent', fetched)
  expect(store.read('600519', 'qfq', '2026-10-30')?.map(row => row.close)).toEqual([5, 6])
})
