// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MarketPanelStatus } from '../src/market-panel-status.tsx'

const meta = { providerId: 'tencent', sourceName: '腾讯行情', sourceTimestamp: '2026-10-30T07:00:00Z', fetchedAt: '2026-10-30T07:05:00Z', cacheState: 'fresh' as const }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T10:00:00+08:00')) })
afterEach(() => { cleanup(); vi.useRealTimers() })
it('hides all successful source, time and live labels during the active session', () => {
  const { container } = render(<MarketPanelStatus items={[{ label: '分时', meta }, { label: '成交额', meta: { ...meta, cacheState: 'cached' } }]} />)
  expect(container.textContent).toBe('')
})
it.each(['2026-10-30T12:00:00+08:00', '2026-10-30T22:00:00+08:00'])('shows one resting cache hint at %s including US hours', time => {
  vi.setSystemTime(new Date(time))
  render(<MarketPanelStatus items={[{ label: '境内', meta }, { label: '海外', meta }]} />)
  expect(screen.getAllByText('休市缓存')).toHaveLength(1)
  expect(screen.queryByText(/腾讯|获取于|实时|最新数据/)).toBeNull()
})
it('shows the failing section only, retaining failure priority over resting hints', () => {
  vi.setSystemTime(new Date('2026-10-30T22:00:00+08:00'))
  render(<MarketPanelStatus items={[{ label: '分时', meta }, { label: '快讯', meta, failed: true }]} />)
  expect(screen.getByText('刷新失败')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toBe('快讯：更新失败，沿用缓存')
  expect(screen.queryByText('休市缓存')).toBeNull()
})
it('retains explicit historical labels without treating archived stale values as a new failure', () => {
  render(<MarketPanelStatus historical items={[{ label: '分时', meta: { ...meta, cacheState: 'stale' } }]} />)
  expect(screen.getByText('历史快照')).toBeTruthy()
  expect(screen.queryByText('刷新失败')).toBeNull()
})
it('does not mistake a successful aged closing quote for a failed request', () => {
  vi.setSystemTime(new Date('2026-10-30T22:00:00+08:00'))
  render(<MarketPanelStatus items={[{ label: '指数', meta: { ...meta, cacheState: 'stale' }, failed: false }]} />)
  expect(screen.getByText('休市缓存')).toBeTruthy()
  expect(screen.queryByText('刷新失败')).toBeNull()
})
