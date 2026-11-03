// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { useMarketDistribution } from '../src/market-distribution.tsx'
import type { HanaiClient } from '../src/api.ts'
import type { MarketDistributionData } from '../../contracts/src/market-distribution.ts'
import type { MarketHistorySnapshot } from '../../contracts/src/market-history.ts'

const data: MarketDistributionData = { total: 9, counts: { down10: 1, down5: 1, down2: 1, down0: 1, flat: 1, up0: 1, up2: 1, up5: 1, up10: 1 },
  meta: { providerId: 'sina-distribution', sourceName: '新浪涨跌分布', sourceTimestamp: null, fetchedAt: '2026-10-30T07:10:00Z', cacheState: 'fresh' } }
const snapshot: MarketHistorySnapshot = { date: '2026-10-30', capturedAt: data.meta.fetchedAt, panels: ['distribution'], records: { distribution: { key: 'distribution', version: 1, data, meta: data.meta, capturedAt: data.meta.fetchedAt } } }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T16:00:00+08:00')) })
afterEach(() => { cleanup(); vi.useRealTimers() })
function setup(saved: MarketHistorySnapshot | null, historical: boolean) {
  const call = vi.fn().mockResolvedValue(data)
  const reload = vi.fn(async () => {})
  const client = { call } as unknown as HanaiClient
  return { call, reload, ...renderHook(({ version }) => useMarketDistribution(client, saved, historical, true, version, reload), { initialProps: { version: 0 } }) }
}
it('reads explicit history without any realtime request', async () => {
  const { result, call } = setup(snapshot, true)
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(result.current.data).toEqual(data)
  expect(call).not.toHaveBeenCalled()
})
it('reuses current closing archives and retains them after a failed manual refresh', async () => {
  const { result, call, rerender } = setup(snapshot, false)
  expect(call).not.toHaveBeenCalled()
  expect(result.current.resting).toBe(true)
  call.mockResolvedValue(null)
  rerender({ version: 1 })
  await act(async () => {})
  expect(result.current.data).toEqual(data)
  expect(result.current.failed).toBe(true)
})
it('polls during market hours independently of the manual refresh version', async () => {
  vi.setSystemTime(new Date('2026-10-30T10:00:00+08:00'))
  const { call } = setup(null, false)
  await act(async () => {})
  expect(call).toHaveBeenCalledTimes(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(call).toHaveBeenCalledTimes(2)
})
