// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Diagnostics } from '../../contracts/src/index.ts'
import { DataSources } from '../src/data-sources.tsx'

const NOW = Date.parse('2026-10-26T10:00:00+08:00')
const diagnostics: Diagnostics = {
  dataRoot: '', databasePath: '', dshHomeOwnedByHost: true, securityCount: 0, masterCount: 0,
  judgementCount: 0, expertChatCount: 0, latestMarketSuccess: new Date(NOW).toISOString(), latestValuationSuccess: null,
  marketSources: [], valuationSources: [], securitySource: null, latestSecuritySuccess: null, securitySyncAvailableAt: null,
  sourceAttempts: [{ source: 'sina', sourceName: '新浪', scope: 'security', lastAttemptAt: new Date(NOW).toISOString(),
    lastSuccessAt: null, lastError: '列表不完整', failures: 0, openUntil: new Date(NOW + 300_000).toISOString() }],
  storage: { totalBytes: 0, cacheBytes: 0, marketCacheBytes: 0, valuationCacheBytes: 0, judgementsBytes: 0, expertChatsBytes: 0 }, version: 'test',
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(() => { cleanup(); vi.useRealTimers() })

it('updates the local breaker countdown and shows eligibility rather than claiming recovery', () => {
  const { container } = render(<DataSources diagnostics={diagnostics} />)
  const details = container.querySelector('details')!
  details.open = true
  fireEvent(details, new Event('toggle'))
  expect(screen.getByText('已熔断，300 秒后可重试')).not.toBeNull()
  act(() => vi.advanceTimersByTime(1000))
  expect(screen.getByText('已熔断，299 秒后可重试')).not.toBeNull()
  act(() => vi.advanceTimersByTime(299_000))
  expect(screen.getByText('最近调用失败')).not.toBeNull()
  expect(screen.getByText(/失败原因：列表不完整/)).not.toBeNull()
})

it('does not infer source availability from a historical success timestamp', () => {
  const { container } = render(<DataSources diagnostics={diagnostics} />)
  expect(screen.getByText('行情快照 · 来源待确认')).not.toBeNull()
  expect(container.querySelector('[class*="statusOk"]')).toBeNull()
})
