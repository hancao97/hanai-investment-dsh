// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MarketLadderPanels, useMarketLadder, ladderThemes } from '../src/market-ladder.tsx'
import type { MarketLadderData } from '../../contracts/src/market-ladder.ts'
import type { MarketHistorySnapshot } from '../../contracts/src/market-history.ts'
import type { HanaiClient } from '../src/api.ts'

const meta = { providerId: 'ths-limit-reason', sourceName: '同花顺涨停池', sourceTimestamp: '2026-10-30', fetchedAt: '2026-10-30T15:10:00+08:00', cacheState: 'fresh' as const }
const stock = (code: string, boards = 1) => ({ code, name: `梯队股${code}`, boards, industry: '食品', reason: '食品+业绩增长+食品', boardType: '换手板', firstSeal: '09:30:00', lastSeal: '10:00:00', breaks: 1, turnover: 12 })
const data: MarketLadderData = { yesterdayPerformance: null, method: 'source-board-types-v1', date: '2026-10-30', stocks: [stock('001219', 3), ...Array.from({ length: 9 }, (_, i) => stock(`60000${i}`))], promotion: { eligible: 20, promoted: 1 }, broken: 5, issues: [], meta }
const snapshot: MarketHistorySnapshot = { date: data.date, capturedAt: meta.fetchedAt, panels: ['ladder'], records: { ladder: { key: 'ladder', version: 1, data, meta, capturedAt: meta.fetchedAt } } }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T16:00:00+08:00')) })
afterEach(() => { cleanup(); vi.useRealTimers() })

it('shows missing ladder levels, caps first boards, retains metrics and opens a stock', () => {
  const onStock = vi.fn()
  render(<MarketLadderPanels data={data} historical={false} failed={false} pending={false} onStock={onStock} />)
  const card = screen.getByRole('article', { name: '涨停梯队' })
  expect(within(card).getByLabelText('2板梯队').textContent).toContain('0只')
  const first = within(card).getByLabelText('首板梯队')
  expect(within(first).getAllByRole('button')).toHaveLength(7)
  fireEvent.click(within(first).getByRole('button', { name: '展开其余 3 只' }))
  expect(within(first).getAllByRole('button')).toHaveLength(10)
  expect(within(card).getByLabelText('今日梯队摘要').textContent).toContain('5.0%')
  expect(within(card).getByText('33.3%')).toBeTruthy()
  fireEvent.click(within(card).getByRole('button', { name: /梯队股001219/ }))
  expect(onStock).toHaveBeenCalledWith(expect.objectContaining({ secId: '0.001219' }))
  expect(ladderThemes(data).map(row => row.count)).toEqual([10, 10])
})

it('shows zero-denominator and absent values as unavailable, not zero rates', () => {
  render(<MarketLadderPanels data={{ ...data, promotion: { eligible: 0, promoted: 0 }, broken: null }} historical={false} failed={false} pending={false} onStock={() => {}} />)
  expect(within(screen.getByLabelText('今日梯队摘要')).getAllByText('—')).toHaveLength(2)
})
it('shows yesterday performance in its own compact row with red/green counts in the tooltip', () => {
  render(<MarketLadderPanels data={{ ...data, yesterdayPerformance: { sample: 39, average: -0.68, median: -0.28, up: 19, down: 20, flat: 0, meta } }} historical={false} failed={false} pending={false} onStock={() => {}} />)
  const summary = screen.getByLabelText('昨日涨停今日表现')
  expect(within(summary).getByText('-0.68%')).toBeTruthy()
  expect(within(summary).getByText('-0.28%')).toBeTruthy()
  expect(summary.textContent).toContain('48.7%')
  expect(within(summary).getByTitle('翻红 19只 · 翻绿 20只 · 平盘 0只')).toBeTruthy()
})
it('shows explicit board types and does not infer a T board just from break counts', () => {
  const stocks = ['一字板', 'T字板', '换手板', null].map((boardType, i) => ({ ...stock(`60000${i}`), boardType, breaks: 3 }))
  render(<MarketLadderPanels data={{ ...data, stocks }} historical={false} failed={false} pending={false} onStock={() => {}} />)
  for (const label of ['一字板', 'T字板', '换手板', '板型待确认']) expect(screen.getByText(label)).toBeTruthy()
  expect(screen.queryByText('已封板')).toBeNull()
  expect(screen.queryByText('开板回封')).toBeNull()
})

function setup(historical: boolean, saved: MarketHistorySnapshot | null = snapshot) {
  const call = vi.fn().mockResolvedValue(data)
  const reload = vi.fn(async () => {})
  const client = { call } as unknown as HanaiClient
  return { call, ...renderHook(({ version }) => useMarketLadder(client, saved, historical, true, version, reload), { initialProps: { version: 0 } }) }
}
it('reads explicit history with no live requests and reports missing history locally', async () => {
  const view = setup(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(90_000) })
  expect(view.result.current.data).toEqual(data)
  expect(view.call).not.toHaveBeenCalled()
  const missing = setup(true, null)
  expect(missing.result.current.data).toBeNull()
  expect(missing.call).not.toHaveBeenCalled()
})
it('updates legacy default archives once for board types while explicit history stays readonly', async () => {
  const legacy = { ...data }
  delete legacy.method
  const saved = { ...snapshot, records: { ladder: { ...snapshot.records.ladder!, data: legacy } } }
  const historical = setup(true, saved)
  await act(async () => {})
  expect(historical.call).not.toHaveBeenCalled()
  const current = setup(false, saved)
  await act(async () => {})
  expect(current.call).toHaveBeenCalledTimes(1)
})
it('keeps the closing archive after manual failure and polls when market opens regardless of manual version', async () => {
  const view = setup(false)
  expect(view.call).not.toHaveBeenCalled()
  view.call.mockRejectedValue(new Error('offline'))
  view.rerender({ version: 1 })
  await act(async () => {})
  expect(view.result.current.data).toEqual(data)
  expect(view.result.current.failed).toBe(true)
  view.unmount()
  vi.setSystemTime(new Date('2026-11-02T10:00:00+08:00'))
  const live = setup(false, null)
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(live.call).toHaveBeenCalledTimes(2)
})
