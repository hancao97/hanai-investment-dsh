// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HanaiClient } from '../src/api.ts'
import { StockDataPanel, StockDataReadiness } from '../src/stock-data.tsx'
import type { StockDataStatus } from '../../contracts/src/stock-data.ts'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T20:00:00+08:00')) })
afterEach(() => { cleanup(); vi.useRealTimers() })
it('observes and controls the host queue without cancelling it on unmount', async () => {
  let status: StockDataStatus = { phase: 'idle', asOf: null, latestCompleteDate: null, total: 0, checked: 0, completed: 0, failed: 0,
    updatedAt: null, availableAt: null, error: null, samples: [] }
  const call = vi.fn(async (endpoint: string) => {
    if (endpoint === 'stock-data.sync') status = { ...status, phase: 'running', total: 3, asOf: '2026-10-30' }
    if (endpoint === 'stock-data.pause') status = { ...status, phase: 'paused' }
    return status
  })
  const view = render(<StockDataPanel client={{ call } as unknown as HanaiClient} />)
  await act(async () => {})
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '同步 / 重试选股数据' })) })
  expect(screen.getByText(/后台同步中/)).not.toBeNull()
  expect(screen.getByRole('button', { name: '同步 / 重试选股数据' }).hasAttribute('disabled')).toBe(true)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '暂停同步' })) })
  expect(screen.getByRole('button', { name: '继续同步选股数据' })).not.toBeNull()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '继续同步选股数据' })) })
  view.unmount()
  const count = call.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(call).toHaveBeenCalledTimes(count)
  expect(call.mock.calls.filter(([endpoint]) => endpoint === 'stock-data.pause')).toHaveLength(1)
})

it('shows data readiness with a management entry and does not start a sync while observing', async () => {
  const call = vi.fn(async () => ({ phase: 'finished', latestCompleteDate: '2026-10-30' }))
  const onSettings = vi.fn()
  render(<StockDataReadiness client={{ call } as unknown as HanaiClient} onSettings={onSettings} />)
  await act(async () => {})
  expect(screen.getByText(/最近全量成功 2026-10-30/)).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '选股数据管理' }))
  expect(onSettings).toHaveBeenCalledTimes(1)
  expect(call.mock.calls).toHaveLength(1)
  expect(call).toHaveBeenCalledWith('stock-data.status', {}, expect.any(AbortSignal))
})

it('shows locally reused coverage separately from outstanding preparation', async () => {
  const status: StockDataStatus = { phase: 'running', asOf: '2026-11-02', latestCompleteDate: null,
    total: 5576, checked: 5572, completed: 5572, failed: 0, updatedAt: '2026-11-03T01:31:00Z', availableAt: null,
    error: null, samples: [], reused: { daily: 5572, financial: 5400 },
    financial: { checked: 5400, completed: 5400, failed: 0, samples: [] } }
  render(<StockDataPanel client={{ call: vi.fn(async () => status) } as unknown as HanaiClient} />)
  await act(async () => {})
  expect(screen.getByText(/本轮本地复用：日线 5572 只 · 报价\/财报 5400 只/)).not.toBeNull()
  expect(screen.getByText(/检查失败 0 只 · 未检查 4 只/)).not.toBeNull()
})

it('separates legacy errors, unprocessed stocks and financial work that was never checked', async () => {
  const status: StockDataStatus = { phase: 'failed', asOf: '2026-10-30', latestCompleteDate: null,
    total: 5576, checked: 2754, completed: 2724, failed: 30, updatedAt: '2026-11-02T02:42:00Z', availableAt: null,
    error: '数据源 88ai-technical 已熔断', samples: [], task: { origin: 'legacy', startedAt: null },
    financial: { checked: 0, completed: 0, failed: 0, samples: [] } }
  const call = vi.fn(async () => status)
  render(<StockDataPanel client={{ call } as unknown as HanaiClient} />)
  await act(async () => {})
  expect(screen.getByText(/升级前任务 · 同步中断/)).not.toBeNull()
  expect(screen.getByText(/检查失败 30 只 · 未检查 2822 只/)).not.toBeNull()
  expect(screen.getByText(/报价\/财报：尚未检查 · 未检查 5576 只/)).not.toBeNull()
  expect(screen.getByText(/升级前任务最后错误 · 记录时间/)).not.toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByText(/不表示当前正在访问对应接口/)).not.toBeNull()
  expect(call).toHaveBeenCalledTimes(1)
})

it('shows independent financial counts and keeps a current failure distinct from the previous error', async () => {
  const status: StockDataStatus = { phase: 'failed', asOf: '2026-10-30', latestCompleteDate: null, total: 20, checked: 9, completed: 8, failed: 1,
    updatedAt: new Date().toISOString(), availableAt: null, error: '腾讯请求超时', samples: [],
    task: { origin: 'local', startedAt: new Date().toISOString() }, previousError: { message: '旧88AI错误', recordedAt: null, origin: 'legacy' },
    financial: { checked: 3, completed: 2, failed: 1, samples: [{ code: '600000', reason: '财报缺失' }] } }
  render(<StockDataPanel client={{ call: vi.fn(async () => status) } as unknown as HanaiClient} />)
  await act(async () => {})
  expect(screen.getByText(/报价\/财报：已检查 3 \/ 20 只 · 有效响应 2 只 · 检查失败 1 只 · 未检查 17 只/)).not.toBeNull()
  expect(screen.getByRole('alert').textContent).toContain('腾讯请求超时')
  expect(screen.getByRole('alert').textContent).not.toContain('旧88AI错误')
  expect(screen.getByText(/升级前任务最后错误 · 记录时间 未记录/)).not.toBeNull()
  expect(screen.getByText(/报价\/财报检查失败原因/)).not.toBeNull()
})

it('does not call an unversioned host error a current local-task failure', async () => {
  const status: StockDataStatus = { phase: 'failed', asOf: null, latestCompleteDate: null, total: 0, checked: 0, completed: 0, failed: 0,
    updatedAt: null, availableAt: null, error: '旧宿主返回的错误', samples: [] }
  render(<StockDataPanel client={{ call: vi.fn(async () => status) } as unknown as HanaiClient} />)
  await act(async () => {})
  expect(screen.getByRole('alert').textContent).toContain('任务提示（来源未记录）')
  expect(screen.getByRole('alert').textContent).not.toContain('本轮任务提示')
  expect(screen.getByText('报价/财报：暂无独立进度记录')).not.toBeNull()
})
