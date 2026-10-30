// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MacroPage } from '../src/market-macro.tsx'
import type { HanaiClient } from '../src/api.ts'
import type { HanaiResponse } from '../../contracts/src/index.ts'
import { defaultMacroRange } from '../../contracts/src/macro-range.ts'
vi.mock('../src/echarts.tsx', () => ({ EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} /> }))
beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date('2026-10-29T20:00:00+08:00')) })
afterEach(() => { cleanup(); vi.useRealTimers() })
function fixture() {
 const meta = { providerId: 'sse-statistics', sourceName: '上交所统计月报', sourceTimestamp: '2026-09-30', fetchedAt: '2026-10-29T10:00:00Z', cacheState: 'fresh' as const }
 const value: HanaiResponse<'market.macro.query'> = { data: { range: defaultMacroRange(), etfs: null, index: null, daily: { points: [{ date: '2026-09-30', assets: 3400 }], expectedDays: 1, complete: true, meta }, capital: { points: [{ date: '2026-09-30', floatCap: 500000 }], checkedMonths: ['202609'], complete: true, meta }, allEtfs: null, allDaily: null, meta }, task: { state: 'idle', startedAt: null, finishedAt: null, availableAt: 0, panels: [] }, taskRange: null, activeRange: null, queued: [] }
 const call = vi.fn(async () => value)
 return { value, call, client: { call } as unknown as HanaiClient }
}
it('reads a range with cached data and source metadata, without a generated-history selector', async () => {
 const { call, client } = fixture()
 render(<MacroPage client={client} theme="light" />)
 await screen.findByText(/2026-09-30 · 四只合计/)
 expect(call).toHaveBeenCalledWith('market.macro.query', { range: { from: '2021-10-29', to: '2026-10-29' }, refresh: false }, expect.any(AbortSignal))
 expect(screen.queryByRole('combobox')).toBeNull()
 const header = within(screen.getByRole('heading', { name: '沪深300 ETF规模与流通市值占比' }).closest('header')!)
 expect(header.queryByText(/上交所统计月报/)).toBeNull()
 const details = screen.getByLabelText('数据详情').closest('details')!
 const source = screen.getAllByText(/上交所统计月报/)[0]!
 expect(details).not.toHaveAttribute('open')
 expect(source).not.toBeVisible()
 const count = call.mock.calls.length
 fireEvent.click(screen.getByLabelText('数据详情'))
 expect(details).toHaveAttribute('open')
 expect(source).toBeVisible()
 expect(screen.getByText(/日频规模按交易所同日份额/)).toBeVisible()
 fireEvent.click(screen.getByLabelText('数据详情'))
 expect(details).not.toHaveAttribute('open')
 expect(call).toHaveBeenCalledTimes(count)
 expect(screen.getByRole('button', { name: '更新数据' })).toBeTruthy()
})
it('validates five years and queries older selected dates instead of history snapshots', async () => {
 const { call, client } = fixture()
 render(<MacroPage client={client} theme="light" />)
 await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
 fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2015-01-01' } })
 fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2021-01-01' } })
 fireEvent.click(screen.getByRole('button', { name: '查看图表' }))
 expect(screen.getByRole('alert').textContent).toContain('最长五年')
 expect(call).toHaveBeenCalledTimes(1)
 fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2020-01-01' } })
 fireEvent.click(screen.getByRole('button', { name: '查看图表' }))
 await waitFor(() => expect(call).toHaveBeenLastCalledWith('market.macro.query', { range: { from: '2015-01-01', to: '2020-01-01' }, refresh: false }, expect.any(AbortSignal)))
})
it('observes background progress and cancels only observation on unmount', async () => {
 const { value, call, client } = fixture()
 value.task.state = 'running'
 const view = render(<MacroPage client={client} theme="light" />)
 await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
 await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
 expect(call.mock.calls.length).toBeGreaterThan(1)
 const last = (call.mock.calls.at(-1) as unknown as [string, unknown, AbortSignal])[2]
 view.unmount()
 expect(last.aborted).toBe(true)
 const count = call.mock.calls.length
 await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
 expect(call).toHaveBeenCalledTimes(count)
})
it('manual updates use the current range and retain data if observation fails', async () => {
 const { call, client } = fixture()
 render(<MacroPage client={client} theme="light" />)
 await screen.findByText(/2026-09-30 · 四只合计/)
 call.mockRejectedValueOnce(new Error('network'))
 fireEvent.click(screen.getByRole('button', { name: '更新数据' }))
 await screen.findByRole('alert')
 expect(call).toHaveBeenLastCalledWith('market.macro.query', expect.objectContaining({ refresh: true }), expect.any(AbortSignal))
 expect(screen.getByText(/2026-09-30 · 四只合计/)).toBeTruthy()
})

it('does not label the current data as failed because a different range failed', async () => {
 const { value, client } = fixture()
 value.task.state = 'partial'
 value.task.panels = [{ endpoint: 'market.macro.capital', label: '沪深300流通市值', state: 'failed', checked: 0, total: 1, missing: 0, error: '旧区间分母缺失' }]
 value.taskRange = { from: '2018-01-01', to: '2019-01-01' }
 const view = render(<MacroPage client={client} theme="light" />)
 await screen.findByText(/2026-09-30 · 四只合计/)
 expect(screen.queryByText('刷新失败')).toBeNull()
 expect(screen.queryByText('旧区间分母缺失')).toBeNull()
 view.unmount()
 value.taskRange = defaultMacroRange()
 render(<MacroPage client={client} theme="light" />)
 fireEvent.click(await screen.findByLabelText('数据详情'))
 await screen.findByText('旧区间分母缺失')
 expect(screen.getByText('刷新失败')).toBeVisible()
})

it('keeps source dates and an incomplete reference visible while detailed copy is collapsed', async () => {
 const { value, client } = fixture()
 const meta = value.data.daily!.meta
 value.data.daily = { ...value.data.daily!, points: [{ date: '2026-10-28', assets: 3400 }], expectedDays: 2, complete: false }
 value.data.index = { points: [{ date: '2026-10-29', close: 4100 }], meta }
 value.data.capital!.reference = { points: [{ date: '2026-10-28', floatCap: 490000, membershipDate: '2026-10-26' }], checkedDates: ['2026-10-28'], missingDates: [], expectedDays: 2, complete: false, meta }
 render(<MacroPage client={client} theme="light" />)
 await screen.findByText('分母参考待补 1 日')
 const brief = within(screen.getByLabelText('宏观数据摘要'))
 expect(brief.getByText('ETF至 2026-10-28')).toBeVisible()
 expect(brief.getByText('指数至 2026-10-29')).toBeVisible()
 expect(brief.getByText('月报至 2026-09-30')).toBeVisible()
 expect(brief.getByText('部分数据待补齐')).toBeVisible()
 expect(screen.getByText(/日频规模按交易所同日份额/)).not.toBeVisible()
})

it('warns about missing denominators even when part of the ratio series is available', async () => {
 const { value, client } = fixture()
 const meta = value.data.daily!.meta
 value.data.daily = { points: [{ date: '2026-09-29', assets: 3300 }, { date: '2026-09-30', assets: 3400 }], expectedDays: 2, complete: true, meta }
 value.data.index = { points: [{ date: '2026-09-29', close: 4000 }, { date: '2026-09-30', close: 4100 }], meta }
 render(<MacroPage client={client} theme="light" />)
 await screen.findByText(/2026-09-30 · 四只合计/)
 expect(screen.getByText('部分数据待补齐')).toBeVisible()
 expect(screen.getByLabelText('数据详情').closest('details')).not.toHaveAttribute('open')
})
