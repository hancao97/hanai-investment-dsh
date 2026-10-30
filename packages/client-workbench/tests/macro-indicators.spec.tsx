// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MacroPage } from '../src/market-macro.tsx'
import { buildMacroIndicatorOption } from '../src/macro-indicator-chart.ts'
import { MACRO_INDICATORS, type MacroIndicatorData, type MacroIndicatorQuery } from '../../contracts/src/macro-indicators.ts'
import { defaultMacroRange } from '../../contracts/src/macro-range.ts'
import { getChartPalette } from '../src/chart-options.ts'
import type { HanaiClient } from '../src/api.ts'
vi.mock('../src/echarts.tsx', () => ({ EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} /> }))
beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date('2026-10-29T20:00:00+08:00')) })
afterEach(() => { cleanup(); vi.useRealTimers() })
function fixture() {
  const range = defaultMacroRange()
  const value: MacroIndicatorQuery = { range, data: { social: { id: 'social', checkedRange: range, points: [{ date: '2026-04-30', values: { increment: 12345.678 } }], meta: { providerId: 'mofcom-macro', sourceName: '商务部公开数据', sourceTimestamp: '2026-04-30', fetchedAt: '2026-10-29T10:00:00Z', cacheState: 'fresh' } } }, running: false, queued: false, tasks: [{ id: 'loans', state: 'failed', error: '接口暂不可用' }, { id: 'social', state: 'completed', error: null }] }
  const call = vi.fn(async (endpoint: string) => endpoint === 'market.macro.indicators' ? value : { data: { range, etfs: null, index: null, daily: null, capital: null, allEtfs: null, allDaily: null }, task: { state: 'idle', panels: [] }, queued: [] })
  return { call, value, client: { call } as unknown as HanaiClient }
}
it('switches themes, retains independent applied ranges and cancels only old observation', async () => {
  const { call, client } = fixture()
  render(<MacroPage client={client} theme="light" />)
  expect(screen.getAllByRole('tab')).toHaveLength(5)
  await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
  const firstSignal = (call.mock.calls[0] as unknown as [string, unknown, AbortSignal])[2]
  fireEvent.click(screen.getByRole('tab', { name: '货币与信用' }))
  await screen.findByRole('img', { name: /社会融资规模增量/ })
  expect(firstSignal.aborted).toBe(true)
  expect(screen.getByText('月频 · 数据至 2026-04')).toBeVisible()
  expect(screen.getByText('商务部公开数据', { exact: false })).not.toBeVisible()
  fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2015-01-01' } })
  fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2018-01-01' } })
  fireEvent.click(screen.getByRole('button', { name: '查看图表' }))
  await waitFor(() => expect(call).toHaveBeenLastCalledWith('market.macro.indicators', { topic: 'credit', range: { from: '2015-01-01', to: '2018-01-01' }, refresh: false }, expect.any(AbortSignal)))
  fireEvent.click(screen.getByRole('tab', { name: '经济景气' }))
  await screen.findByRole('heading', { name: '采购经理指数（PMI）' })
  expect(screen.getByLabelText('开始日期')).toHaveValue('2021-10-29')
  fireEvent.click(screen.getByRole('tab', { name: '货币与信用' }))
  expect(screen.getByLabelText('开始日期')).toHaveValue('2015-01-01')
})
it('renders the market breadth topic and marks estimated historical points in the tooltip', async () => {
  const { client, call } = fixture()
  render(<MacroPage client={client} theme="light" />)
  fireEvent.click(screen.getByRole('tab', { name: '市场广度' }))
  await screen.findByRole('heading', { name: '成交额版阿姆氏指标' })
  expect(call).toHaveBeenLastCalledWith('market.macro.indicators', expect.objectContaining({ topic: 'breadth' }), expect.any(AbortSignal))
  const definition = MACRO_INDICATORS.find(row => row.id === 'arms')!
  const date = '2026-10-28'
  const data: MacroIndicatorData = { id: 'arms', checkedRange: { from: date, to: date }, points: [{ date, values: { trin: 0.5, adRatio: 2, amountRatio: 4 }, estimated: true }], meta: { providerId: '88ai-arms', sourceName: '88AI', sourceTimestamp: date, fetchedAt: '2026-10-29T10:00:00Z', cacheState: 'fresh' } }
  const option = buildMacroIndicatorOption(definition, data, { from: date, to: date }, getChartPalette('light')) as any
  expect(option.tooltip.formatter([{ value: [Date.parse(`${date}T00:00:00+08:00`), 0.5] }])).toContain('估算')
  expect(option.series).toHaveLength(3)
  expect(option.series.map((series: { name: string }) => series.name)).toEqual(['TRIN', '涨跌家数比', '涨跌成交额比'])
  expect(option.series[0].type).toBe('bar')
  expect(option.series[0].data).toEqual([[Date.parse(`${date}T00:00:00+08:00`), 0.5]])
  expect(option.series[1].markLine.data[0].yAxis).toBe(1)
})
it('omits confirmed market holidays but leaves missing trading observations empty', () => {
  const definition = MACRO_INDICATORS.find(row => row.id === 'arms')!
  const range = { from: '2026-09-30', to: '2026-10-09' }
  const data: MacroIndicatorData = { id: 'arms', checkedRange: range, points: [
    { date: '2026-09-30', values: { trin: 1, adRatio: 1, amountRatio: 1 } },
    { date: '2026-10-09', values: { trin: 2, adRatio: 2, amountRatio: 1 } },
  ], meta: { providerId: 'test', sourceName: 'test', sourceTimestamp: '2026-10-09', fetchedAt: '2026-10-29T10:00:00Z', cacheState: 'fresh' } }
  const option = buildMacroIndicatorOption(definition, data, range, getChartPalette('light'), ['2026-09-30', '2026-10-08', '2026-10-09']) as any
  const stamp = (date: string) => Date.parse(`${date}T00:00:00+08:00`)
  expect(option.series[0].data).toEqual([[stamp('2026-09-30'), 1], [stamp('2026-10-08'), null], [stamp('2026-10-09'), 2]])
  const withoutCalendar = buildMacroIndicatorOption(definition, data, range, getChartPalette('light')) as any
  expect(withoutCalendar.series[0].data).toContainEqual([stamp('2026-10-01'), null])
  const partialCalendar = buildMacroIndicatorOption(definition, data, range, getChartPalette('light'), ['2026-09-29', '2026-10-08', '2026-10-12']) as any
  expect(partialCalendar.series[0].data).toContainEqual([stamp('2026-10-09'), 2])
})
it('keeps per-indicator failure details and supports keyboard navigation without exposing long copy by default', async () => {
  const { client } = fixture()
  render(<MacroPage client={client} theme="dark" />)
  fireEvent.keyDown(screen.getByRole('tab', { name: '市场资金' }), { key: 'ArrowRight' })
  await screen.findByText('更新失败，保留本地数据')
  expect(screen.getByRole('tab', { name: '货币与信用' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByText('接口暂不可用')).not.toBeVisible()
  fireEvent.click(screen.getByLabelText('新增人民币贷款数据详情'))
  expect(screen.getByText('接口暂不可用')).toBeVisible()
})
it('observes background work and manual refresh targets only the chosen theme', async () => {
  const { client, call, value } = fixture()
  render(<MacroPage client={client} theme="light" />)
  fireEvent.click(screen.getByRole('tab', { name: '货币与信用' }))
  await screen.findByRole('button', { name: '更新当前主题' })
  await waitFor(() => expect(screen.getByRole('button', { name: '更新当前主题' })).toBeEnabled())
  value.running = true
  fireEvent.click(screen.getByRole('button', { name: '更新当前主题' }))
  await waitFor(() => expect(call).toHaveBeenLastCalledWith('market.macro.indicators', { topic: 'credit', range: defaultMacroRange(), refresh: true }, expect.any(AbortSignal)))
  await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
  expect(call).toHaveBeenLastCalledWith('market.macro.indicators', { topic: 'credit', range: defaultMacroRange(), refresh: false }, expect.any(AbortSignal))
})
it('does not bridge missing monthly values and gives PMI the 50 threshold', () => {
  const definition = MACRO_INDICATORS.find(row => row.id === 'pmi')!
  const option = buildMacroIndicatorOption(definition, undefined, { from: '2026-01-01', to: '2026-03-31' }, getChartPalette('light')) as any
  expect(option.series[0].connectNulls).toBe(false)
  expect(option.series[0].data).toHaveLength(3)
  expect(option.series[0].data.every((row: unknown[]) => row[1] === null)).toBe(true)
  expect(option.series[0].markLine.data[0].yAxis).toBe(50)
  expect(option.tooltip.valueFormatter(1234.567)).toBe('1,234.57')
  const single = buildMacroIndicatorOption(definition, { id: 'pmi', checkedRange: { from: '2026-01-01', to: '2026-01-31' }, points: [{ date: '2026-01-31', values: { manufacturing: 50, nonManufacturing: null } }], meta: { providerId: 'test', sourceName: 'test', sourceTimestamp: '2026-01-31', fetchedAt: '2026-10-29T10:00:00Z', cacheState: 'fresh' } }, { from: '2026-01-01', to: '2026-01-31' }, getChartPalette('light')) as any
  expect(single.series[0].showSymbol).toBe(true)
  expect(single.series[1].showSymbol).toBe(false)
})
it.each(['industry', 'retail'] as const)('connects %s cumulative observations over only the verified combined Jan-Feb period', id => {
  const definition = MACRO_INDICATORS.find(row => row.id === id)!
  const range = { from: '2025-12-01', to: '2026-05-31' }
  const data: MacroIndicatorData = { id, checkedRange: range, points: [
    { date: '2025-12-31', values: { yoy: 5, ytd: 6 } },
    { date: '2026-02-28', values: { yoy: null, ytd: 6.3 } },
    { date: '2026-03-31', values: { yoy: 5.4, ytd: 6.1 } },
    { date: '2026-05-31', values: { yoy: 5.5, ytd: 6 } },
  ], meta: { providerId: 'test', sourceName: 'test', sourceTimestamp: '2026-05-31', fetchedAt: '2026-10-29T10:00:00Z', cacheState: 'fresh' } }
  const before = structuredClone(data)
  const option = buildMacroIndicatorOption(definition, data, range, getChartPalette('light')) as any
  const stamp = (date: string) => Date.parse(`${date}T00:00:00+08:00`)
  const [monthly, cumulative] = option.series
  expect(monthly.data).toContainEqual([stamp('2026-01-31'), null])
  expect(monthly.data).toContainEqual([stamp('2026-02-28'), null])
  expect(cumulative.data.some((row: number[]) => row[0] === stamp('2026-01-31'))).toBe(false)
  expect(cumulative.data).toContainEqual([stamp('2026-02-28'), 6.3])
  expect(cumulative.data).toContainEqual([stamp('2026-04-30'), null])
  expect(cumulative.connectNulls).toBe(false)
  expect(cumulative.markPoint.label.formatter).toBe('1—2月')
  expect(cumulative.markPoint.data[0].coord).toEqual([stamp('2026-02-28'), 6.3])
  expect(option.tooltip.formatter([{ seriesName: '累计同比', value: [stamp('2026-02-28'), 6.3] }])).toBe('2026年1—2月（合并公布）\n当月同比：—（未单独公布）\n累计同比：6.30%')
  expect(option.tooltip.formatter([{ seriesName: '当月同比', value: [stamp('2026-01-31'), null] }, { seriesName: '累计同比', value: [stamp('2026-02-28'), 6.3] }])).toBe('2026-01\n当月同比：—\n累计同比：—')
  expect(data).toEqual(before)
  const unknown = buildMacroIndicatorOption(definition, { ...data, points: data.points.filter(row => row.date !== '2026-02-28') }, range, getChartPalette('light')) as any
  expect(unknown.series[1].data).toContainEqual([stamp('2026-01-31'), null])
  expect(unknown.series[1].markPoint).toBeUndefined()
})
