// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MarketScanPage } from '../src/market-scan.tsx'
import { scanCsv } from '../src/market-scan-data.ts'
import type { HanaiClient } from '../src/api.ts'
import { DEFAULT_SCAN_QUERY, type MarketScanData, type MarketScanQuery } from '../../contracts/src/market-scan.ts'

const stock = { secId: '0.000001', code: '000001', name: '平安银行', industry: '银行', price: 10, changePct: 0, pe: 10, pb: null, roe: 15, profitGrowth: 1, revenueGrowth: 2, marketCap: 200, dividendYield: 3, netInflow5d: 0, netMargin: 10, grossMargin: null }
function data(query = DEFAULT_SCAN_QUERY): MarketScanData { return { query, total: 201, stocks: [stock], snapshotDate: '2026-10-30', collectedOn: '2026-10-30', meta: { providerId: '88ai-scan', sourceName: '88AI', sourceTimestamp: '2026-10-30', fetchedAt: '2026-10-30T02:00:00Z', cacheState: 'fresh' } } }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T10:00:00+08:00')) })
afterEach(() => { cleanup(); vi.useRealTimers() })
function setup(handler?: (payload: any, signal?: AbortSignal) => unknown) {
  const call = vi.fn(async (name: string, payload: any, signal?: AbortSignal) => {
    if (name === 'market.scan.history') return [{ date: '2026-10-30', capturedAt: data().meta.fetchedAt, panels: [] }]
    if (name === 'market.scan.query') return handler ? handler(payload, signal) : { data: data(payload.query), error: null, historical: Boolean(payload.date) }
    throw new Error(name)
  })
  const onStock = vi.fn(); render(<MarketScanPage client={{ call } as unknown as HanaiClient} onStock={onStock} />)
  return { call, onStock }
}
it('queries the full server aggregate for presets and preserves active advanced filters when collapsed', async () => {
  const view = setup(); await act(async () => {})
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '高股息' })) })
  expect(view.call).toHaveBeenCalledWith('market.scan.history', expect.anything(), expect.anything())
  const queryCalls = view.call.mock.calls.filter(([name]) => name === 'market.scan.query')
  expect(queryCalls.at(-1)?.[1].query.ranges).toEqual({ roe: { min: 8 }, dividendYield: { min: 3 } })
  expect(screen.getByLabelText('股息率下限')).not.toBeNull()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Expert OFF' })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Expert ON' })) })
  expect(screen.getByLabelText('股息率下限')).not.toBeNull()
})
it('sorts and paginates on the server, rather than sorting just the loaded page', async () => {
  const view = setup(); await act(async () => {})
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'ROE（%）' })) })
  expect(view.call.mock.calls.filter(([name]) => name === 'market.scan.query').at(-1)?.[1].query).toMatchObject({ sort: 'roe', order: 'desc', page: 1 })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下一页' })) })
  expect(view.call.mock.calls.filter(([name]) => name === 'market.scan.query').at(-1)?.[1].query.page).toBe(2)
  expect(screen.getByText('匹配 201 只 · 当前页 1 只')).not.toBeNull()
})
it('applies edited numeric ranges explicitly and rejects an inverted range without querying', async () => {
  const view = setup(); await act(async () => {})
  fireEvent.change(screen.getByLabelText('PE(TTM)下限'), { target: { value: '30' } })
  fireEvent.change(screen.getByLabelText('PE(TTM)上限'), { target: { value: '20' } })
  expect((screen.getByRole('button', { name: '应用筛选' }) as HTMLButtonElement).disabled).toBe(true)
  expect(view.call.mock.calls.filter(([name]) => name === 'market.scan.query')).toHaveLength(1)
})
it('keeps automatic polling independent of the manual cooldown', async () => {
  const view = setup(); await act(async () => {})
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新数据' })) })
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  const requests = view.call.mock.calls.filter(([name]) => name === 'market.scan.query')
  expect(requests).toHaveLength(3); expect(requests[1]?.[1].refresh).toBe(true); expect(requests[2]?.[1].refresh).toBeUndefined()
  expect((screen.getByRole('button', { name: '30秒后刷新' }) as HTMLButtonElement).disabled).toBe(true)
})
it('historical requests include the selected date, stop polling and disable live stock navigation', async () => {
  const view = setup(); await act(async () => {})
  await act(async () => { fireEvent.change(screen.getByLabelText('扫描历史日期'), { target: { value: '2026-10-30' } }) })
  const count = view.call.mock.calls.filter(([name]) => name === 'market.scan.query').length
  await act(async () => { await vi.advanceTimersByTimeAsync(90_000) })
  expect(view.call.mock.calls.filter(([name]) => name === 'market.scan.query')).toHaveLength(count)
  expect((screen.getByRole('button', { name: '平安银行' }) as HTMLButtonElement).disabled).toBe(true)
  expect(view.call.mock.calls.filter(([name]) => name === 'market.scan.query').at(-1)?.[1].date).toBe('2026-10-30')
})
it('does not display a failed new query as if it were the previous successful result', async () => {
  setup((payload: { query: MarketScanQuery }) => { if (payload.query.search) throw new Error('offline'); return { data: data(payload.query), error: null, historical: false } })
  await act(async () => {})
  fireEvent.change(screen.getByLabelText('扫描名称代码'), { target: { value: 'other' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '应用筛选' })) })
  expect(screen.queryByRole('button', { name: '平安银行' })).toBeNull(); expect(screen.getByRole('alert').textContent).toContain('offline')
})
it('aborts and rejects a late response after switching to historical data', async () => {
  let resolveOld: (value: unknown) => void = () => {}
  let oldSignal: AbortSignal | undefined
  setup((payload: { query: MarketScanQuery; date?: string }, signal) => {
    if (payload.date) return { data: { ...data(payload.query), stocks: [], total: 0 }, error: null, historical: true }
    oldSignal = signal; return new Promise(resolve => { resolveOld = resolve })
  })
  await act(async () => {})
  await act(async () => { fireEvent.change(screen.getByLabelText('扫描历史日期'), { target: { value: '2026-10-30' } }) })
  expect(oldSignal?.aborted).toBe(true)
  await act(async () => { resolveOld({ data: data(), error: null, historical: false }) })
  expect(screen.queryByRole('button', { name: '平安银行' })).toBeNull()
  expect(screen.getByText('本次查询没有匹配股票')).not.toBeNull()
})
it('exports only the displayed page with explicit query metadata and spreadsheet-safe source strings', () => {
  const value = data(); value.stocks[0] = { ...stock, name: '=HYPERLINK("bad")', industry: '银行,金融' }
  const csv = scanCsv(value)
  expect(csv).toContain('"\'000001"'); expect(csv).toContain('\'=HYPERLINK'); expect(csv).toContain('"银行,金融"'); expect(csv).toContain('实际查询')
  expect(csv.split('\r\n')).toHaveLength(2)
})
