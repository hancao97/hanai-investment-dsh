import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MarketHistoryStore } from '../../domain/src/market-history.ts'
import { HanaiDatabase } from '../../domain/src/database.ts'
import { DEFAULT_SCAN_QUERY, type MarketScanData } from '../../contracts/src/market-scan.ts'
import { MarketScanService, scanHistoryKey } from '../src/market-scan.ts'

const roots: string[] = [], databases: HanaiDatabase[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T10:00:00+08:00')) })
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hanai-scan-')); roots.push(root)
  const database = new HanaiDatabase(join(root, 'test.sqlite')); databases.push(database)
  const history = new MarketHistoryStore(database.sqlite)
  const load = vi.fn(async (query = DEFAULT_SCAN_QUERY): Promise<MarketScanData> => ({ query, total: 0, stocks: [], snapshotDate: '2026-10-30', collectedOn: '2026-10-30', meta: { providerId: '88ai-scan', sourceName: '88AI', sourceTimestamp: '2026-10-30', fetchedAt: new Date().toISOString(), cacheState: 'fresh' } }))
  return { database, history, load, service: new MarketScanService(load, history, database) }
}
it('persists successful queries in shared storage without polluting today-market dates or whole-page payloads', async () => {
  const { service, history, load } = fixture()
  const first = await service.query(DEFAULT_SCAN_QUERY)
  expect(first.data?.total).toBe(0)
  expect(history.list('market')).toEqual([]); expect(history.get('2026-10-30')).toBeNull()
  expect(history.get('2026-10-30', scanHistoryKey(DEFAULT_SCAN_QUERY))).not.toBeNull()
  expect(service.dates(DEFAULT_SCAN_QUERY)).toHaveLength(1)
  await service.query(DEFAULT_SCAN_QUERY); expect(load).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(25_001); await service.query(DEFAULT_SCAN_QUERY); expect(load).toHaveBeenCalledTimes(2)
})
it('keeps explicit historical queries local and does not mix different conditions, sort or page', async () => {
  const { service, load } = fixture(); await service.query(DEFAULT_SCAN_QUERY); load.mockClear()
  expect((await service.query(DEFAULT_SCAN_QUERY, '2026-10-30')).historical).toBe(true)
  expect((await service.query({ ...DEFAULT_SCAN_QUERY, page: 2 }, '2026-10-30')).data).toBeNull()
  expect((await service.query({ ...DEFAULT_SCAN_QUERY, sort: 'roe' }, '2026-10-30')).data).toBeNull()
  await expect(service.query(DEFAULT_SCAN_QUERY, '2026-10-30', true)).rejects.toThrow('只读')
  expect(load).not.toHaveBeenCalled()
})
it('preserves only the same successful query on source failure and keeps manual cooldown out of auto reads', async () => {
  const { service, load } = fixture(); const first = await service.query(DEFAULT_SCAN_QUERY)
  load.mockRejectedValue(new Error('offline'))
  const failed = await service.query(DEFAULT_SCAN_QUERY, undefined, true)
  expect(failed.data?.meta).toEqual({ ...first.data!.meta, cacheState: 'stale' })
  expect(failed.error).toContain('offline')
  await expect(service.query(DEFAULT_SCAN_QUERY, undefined, true)).rejects.toThrow('冷却')
  await vi.advanceTimersByTimeAsync(30_000)
  await service.query(DEFAULT_SCAN_QUERY); expect(load).toHaveBeenCalledTimes(3)
  expect((await service.query({ ...DEFAULT_SCAN_QUERY, search: 'other' })).data).toBeNull()
})
it('reuses a recently collected closed-market snapshot for six hours and canonicalizes range ordering', async () => {
  vi.setSystemTime(new Date('2026-10-30T18:00:00+08:00'))
  const { service, load } = fixture(); await service.query(DEFAULT_SCAN_QUERY)
  await vi.advanceTimersByTimeAsync(60 * 60_000); await service.query(DEFAULT_SCAN_QUERY); expect(load).toHaveBeenCalledTimes(1)
  expect(scanHistoryKey({ ...DEFAULT_SCAN_QUERY, ranges: { pe: { max: 20 }, roe: { min: 15 } } })).toBe(scanHistoryKey({ ...DEFAULT_SCAN_QUERY, ranges: { roe: { min: 15 }, pe: { max: 20 } } }))
})
it('does not replace a newer matching snapshot with a regressed source date', async () => {
  const { service, load } = fixture(); const first = await service.query(DEFAULT_SCAN_QUERY)
  load.mockResolvedValue({ ...first.data!, snapshotDate: '2026-10-29', meta: { ...first.data!.meta, sourceTimestamp: '2026-10-29' } })
  const result = await service.query(DEFAULT_SCAN_QUERY, undefined, true)
  expect(result.data?.snapshotDate).toBe('2026-10-30'); expect(result.error).toContain('倒退')
  expect(service.dates(DEFAULT_SCAN_QUERY)).toHaveLength(1)
})
