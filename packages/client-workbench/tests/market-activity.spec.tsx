// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketActivityPanel, buildMarketActivityOption } from '../src/market-activity.tsx'
import { LIGHT_CHART_PALETTE } from '../src/chart-options.ts'
import type { HanaiClient } from '../src/api.ts'
import type { MarketHistorySnapshot } from '../../contracts/src/market-history.ts'
import type { MarketIntradayData, MarketSignalsData } from '../../contracts/src/market-activity.ts'

vi.mock('../src/echarts.tsx', () => ({ EChart: ({ ariaLabel, option }: { ariaLabel: string; option: { series: Array<{ name?: string; data?: Array<{ name: string }> }> } }) => <div aria-label={ariaLabel}>{option.series.find(series => series.name === '板块异动')?.data?.map((point, index) => <span key={index}>{point.name}</span>)}</div> }))
const meta = { providerId: 'tencent', sourceName: '腾讯行情', sourceTimestamp: '2026-10-27T07:00:00Z', fetchedAt: '2026-10-27T07:06:00Z', cacheState: 'fresh' as const }
const trend: MarketIntradayData = { date: '2026-10-27', prevClose: 3600, points: [{ time: '09:30', price: 3601, avgPrice: 3600, volume: 0 }, { time: '15:00', price: 3610, avgPrice: 3605, volume: 10 }], meta }
const signals: MarketSignalsData = { date: trend.date, method: 'ths-sector-events-v2', signals: [{ time: '09:30', name: '机器人', code: '886069', title: '机器人板块上涨', direction: 'up' }], meta }
const archived = (): MarketHistorySnapshot => ({ date: trend.date, panels: ['intraday', 'signals'], capturedAt: meta.fetchedAt, records: {
  intraday: { key: 'intraday', version: 1, capturedAt: meta.fetchedAt, data: trend, meta },
  signals: { key: 'signals', version: 1, capturedAt: meta.fetchedAt, data: signals, meta },
} })
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T10:00:00+08:00')) })
afterEach(() => { cleanup(); vi.useRealTimers() })
function setup(snapshot: MarketHistorySnapshot | null = null, historical = false) {
  const call = vi.fn(async (endpoint: string, _request?: unknown, _signal?: AbortSignal) => endpoint === 'market.intraday' ? trend : signals)
  const client = { call } as unknown as HanaiClient
  const props = { client, snapshot, historical, palette: LIGHT_CHART_PALETTE, refreshVersion: 0, onArchived: vi.fn(async () => {}) }
  return { call, props, ...render(<MarketActivityPanel {...props} />) }
}
describe('market activity panel', () => {
  it('shows lunch status for fresh data and retains failure precedence', async () => {
    vi.setSystemTime(new Date('2026-10-27T12:12:00+08:00'))
    const { call, props, rerender } = setup()
    rerender(<MarketActivityPanel {...props} marketStatus="break" />)
    await act(async () => {})
    expect(screen.getByText('休市缓存')).toBeTruthy()
    call.mockRejectedValue(new Error('offline'))
    rerender(<MarketActivityPanel {...props} marketStatus="break" refreshVersion={1} />)
    await act(async () => {})
    expect(screen.getByText('刷新失败')).toBeTruthy()
    expect(screen.queryByText('休市缓存')).toBeNull()
  })
  it('opens a page dialog, restores on button or Escape, and never refetches for resizing', async () => {
    const saved = {
      show: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal'),
      close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close'),
    }
    const show = vi.fn(function (this: HTMLDialogElement) { this.open = true })
    const close = vi.fn(function (this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')) })
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: show })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: close })
    try {
      const { call } = setup()
      await act(async () => {})
      const card = screen.getByLabelText('大盘异动')
      card.style.padding = '0 24px'
      Object.defineProperty(card, 'clientWidth', { configurable: true, value: 800 })
      vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ x: 176, left: 176, top: 46, bottom: 446, width: 800, height: 400, right: 976, y: 46, toJSON: () => ({}) })
      const before = call.mock.calls.length
      fireEvent.click(screen.getByRole('button', { name: '放大大盘异动' }))
      await act(async () => {})
      const dialog = screen.getByRole('dialog', { name: '放大的大盘异动' }) as HTMLDialogElement
      expect(show).toHaveBeenCalledTimes(1)
      expect(dialog.style.left).toBe('200px')
      expect(dialog.style.width).toBe('752px')
      Object.defineProperty(card, 'clientWidth', { configurable: true, value: 600 })
      fireEvent(window, new Event('resize'))
      expect(dialog.style.width).toBe('552px')
      expect(within(dialog).getByText('机器人')).toBeTruthy()
      expect(document.fullscreenElement ?? null).toBeNull()
      fireEvent.click(within(dialog).getByRole('button', { name: '缩小大盘异动' }))
      await act(async () => {})
      expect(close).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('dialog')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: '放大大盘异动' }))
      await act(async () => {})
      fireEvent(dialog, new Event('cancel'))
      await act(async () => {})
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.getByRole('button', { name: '放大大盘异动' }).getAttribute('aria-pressed')).toBe('false')
      expect(call.mock.calls.length).toBe(before)
      expect(screen.getByText('机器人')).toBeTruthy()
    } finally {
      cleanup()
      for (const [key, descriptor] of [['showModal', saved.show], ['close', saved.close]] as const) {
        if (descriptor !== undefined) Object.defineProperty(HTMLDialogElement.prototype, key, descriptor)
        else Reflect.deleteProperty(HTMLDialogElement.prototype, key)
      }
    }
  })
  it('shows and refreshes prices while a slow news request is still pending', async () => {
    const call = vi.fn((endpoint: string) => endpoint === 'market.intraday' ? Promise.resolve(trend) : new Promise(() => {}))
    render(<MarketActivityPanel client={{ call } as unknown as HanaiClient} snapshot={null} historical={false} palette={LIGHT_CHART_PALETTE} refreshVersion={0} onArchived={async () => {}} />)
    await act(async () => {})
    expect(screen.getByLabelText('大盘异动分时走势图')).toBeTruthy()
    expect(screen.getByText('正在读取异动快讯…')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(call.mock.calls.filter(([endpoint]) => endpoint === 'market.intraday')).toHaveLength(2)
    expect(call.mock.calls.filter(([endpoint]) => endpoint === 'market.signals')).toHaveLength(1)
  })

  it('keeps newer displayed archives when a refresh returns an older trend or another trading day', async () => {
    vi.setSystemTime(new Date('2026-10-27T18:00:00+08:00'))
    const { call, props, rerender } = setup(archived())
    await act(async () => {})
    call.mockImplementation(async endpoint => endpoint === 'market.intraday'
      ? { ...trend, meta: { ...meta, sourceName: '旧行情', sourceTimestamp: '2026-10-27T06:00:00Z', fetchedAt: new Date().toISOString() } }
      : { ...signals, date: '2026-10-26', meta: { ...meta, fetchedAt: new Date().toISOString() } })
    rerender(<MarketActivityPanel {...props} refreshVersion={1} />)
    await act(async () => {})
    expect(screen.queryByText(/旧行情/)).toBeNull()
    expect(screen.getByText('机器人')).toBeTruthy()
  })
  it('renders the trend independently, annotates same-day signals, and polls without manual cooldown', async () => {
    const { call, props, rerender } = setup()
    await act(async () => {})
    expect(screen.getByLabelText('大盘异动分时走势图')).toBeTruthy()
    expect(screen.getByText('机器人').closest('[aria-label="大盘异动分时走势图"]')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '大盘异动' }).closest('header')?.textContent).not.toMatch(/腾讯行情|同花顺|数据时间|获取于/)
    rerender(<MarketActivityPanel {...props} refreshVersion={1} />)
    await act(async () => {})
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(call.mock.calls.filter(([endpoint]) => endpoint === 'market.intraday')).toHaveLength(3)
    const option = buildMarketActivityOption(trend, signals, LIGHT_CHART_PALETTE)!
    const scatter = (option.series as Array<{ name?: string; data?: Array<{ value: number[]; label: { show: boolean; formatter: () => string } }> }>).find(series => series.name === '板块异动')!
    expect(scatter.data?.[0]).toMatchObject({ value: [0, 3601], label: { show: true } })
    expect(scatter.data?.[0]?.label.formatter()).toBe('机器人')
    const layout = (scatter as unknown as { labelLayout: (params: { labelRect: { x: number; y: number; width: number } }) => unknown }).labelLayout
    expect(layout({ labelRect: { x: 40, y: 10, width: 30 } })).toMatchObject({ x: 55, y: 10, moveOverlap: 'shiftY', hideOverlap: false })
    const tooltip = option.tooltip as { formatter: (value: unknown) => string }
    expect(tooltip.formatter([{ dataIndex: 0 }])).toContain(' 点')
    expect(tooltip.formatter([{ dataIndex: 0 }])).not.toContain(' 元')
    expect((buildMarketActivityOption(trend, { ...signals, date: '2026-10-26' }, LIGHT_CHART_PALETTE)!.series as Array<{ data: unknown[] }>).at(-1)?.data).toEqual([])
  })

  it('loads only the selected archive in historical mode and aborts pending live requests', async () => {
    const { call, props, rerender } = setup()
    const signal = call.mock.calls[0]?.[2] as AbortSignal | undefined
    rerender(<MarketActivityPanel {...props} historical snapshot={archived()} />)
    await act(async () => {})
    expect(signal?.aborted).toBe(true)
    expect(screen.getByText('机器人')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(call).toHaveBeenCalledTimes(2)
    rerender(<MarketActivityPanel {...props} historical snapshot={null} />)
    expect(screen.getByText('该日期未保存大盘分时')).toBeTruthy()
    expect(screen.getByText('该日期未保存板块异动')).toBeTruthy()
  })

  it('uses a complete closing archive without requests and keeps it after a failed manual refresh', async () => {
    vi.setSystemTime(new Date('2026-10-27T18:00:00+08:00'))
    const { call, props, rerender } = setup(archived())
    await act(async () => {})
    expect(call).not.toHaveBeenCalled()
    expect(screen.getByText('休市缓存').closest('header')).toBeTruthy()
    call.mockRejectedValue(new Error('offline'))
    rerender(<MarketActivityPanel {...props} refreshVersion={1} />)
    await act(async () => {})
    expect(screen.getByLabelText('大盘异动分时走势图')).toBeTruthy()
    expect(screen.getByText('机器人')).toBeTruthy()
    expect(screen.getByText(/上证分时：更新失败，沿用缓存/)).toBeTruthy()
    expect(screen.getByText('刷新失败').closest('header')).toBeTruthy()
    expect(screen.queryByText('最新数据')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('refreshes old truncated news archives once in default mode but preserves explicit history', async () => {
    vi.setSystemTime(new Date('2026-10-27T18:00:00+08:00'))
    const snapshot = archived()
    snapshot.records.signals!.data = { ...signals, method: undefined }
    const { call, props, rerender } = setup(snapshot)
    await act(async () => {})
    expect(call.mock.calls.map(([endpoint]) => endpoint)).toEqual(['market.signals'])
    call.mockClear()
    rerender(<MarketActivityPanel {...props} historical />)
    await act(async () => {})
    expect(call).not.toHaveBeenCalled()
    expect(screen.getByText('旧版异动快照，仅保存了部分事件')).toBeTruthy()
    expect(screen.getByText('历史快照').closest('header')).toBeTruthy()
  })
})
