// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HanaiClient } from '../src/api.ts'
import { usePreviousTurnover } from '../src/market-turnover.ts'
import type { MarketHistorySnapshot, MarketHistorySummary } from '../../contracts/src/market-history.ts'

const archived = (date = '2026-10-29', time = '15:10:00'): MarketHistorySnapshot => {
  const meta = { providerId: 'tencent', sourceName: '腾讯行情', sourceTimestamp: `${date}T${time}+08:00`, fetchedAt: `${date}T${time}+08:00`, cacheState: 'fresh' as const }
  const data = { indices: [], breadth: { up: null, down: null, flat: null, limitUp: null, limitDown: null, totalAmount: 1.5e12 }, marketStatus: 'closed', meta }
  return { date, capturedAt: meta.fetchedAt, panels: ['overview'], records: { overview: { key: 'overview', version: 1, capturedAt: meta.fetchedAt, data, meta } } }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T16:00:00+08:00')) })
afterEach(() => { cleanup(); vi.useRealTimers() })

function setup(snapshot = archived(), date = '2026-10-30', listed = true) {
  const call = vi.fn().mockResolvedValue(snapshot)
  const client = { call } as unknown as HanaiClient
  const summaries: MarketHistorySummary[] = listed ? [snapshot] : []
  return { call, ...renderHook(({ date, snapshots }) => usePreviousTurnover(client, date, snapshots, 0), { initialProps: { date, snapshots: summaries } }) }
}

it('reads the preceding closing archive once without requesting live data', async () => {
  const { call, result, rerender } = setup()
  await act(async () => {})
  expect(call).toHaveBeenCalledWith('market.history.get', { date: '2026-10-29' }, expect.any(AbortSignal))
  expect(result.current.data?.breadth.totalAmount).toBe(1.5e12)
  rerender({ date: '2026-10-30', snapshots: [{ ...archived() }] })
  await act(async () => {})
  expect(call).toHaveBeenCalledTimes(1)
})

it('skips weekends relative to the selected date', async () => {
  const { result } = setup(archived('2026-10-23'), '2026-10-26')
  await act(async () => {})
  expect(result.current.date).toBe('2026-10-23')
  expect(result.current.data?.breadth.totalAmount).toBe(1.5e12)
})

it('does not substitute an intraday or older archive for yesterday closing turnover', async () => {
  const partial = setup(archived('2026-10-29', '10:00:00'))
  await act(async () => {})
  expect(partial.result.current.data).toBeNull()
  const missing = setup(archived('2026-10-28'))
  await act(async () => {})
  expect(missing.call).not.toHaveBeenCalled()
  expect(missing.result.current.data).toBeNull()
})

it('does not carry turnover into a different selected date when that archive is missing', async () => {
  const { result, rerender } = setup()
  await act(async () => {})
  expect(result.current.data).not.toBeNull()
  rerender({ date: '2026-10-28', snapshots: [] })
  expect(result.current.data).toBeNull()
})
