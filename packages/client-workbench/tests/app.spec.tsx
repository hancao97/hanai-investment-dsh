// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BootstrapData,
  DashboardData,
  MasterPersona,
  ProviderMeta,
  StockDetail,
  WatchGroup,
  WatchQuote,
} from '../../contracts/src/index.ts'
import { HanaiWorkbench } from '../src/app.tsx'
import type { HanaiClient } from '../src/api.ts'

afterEach(() => { cleanup() })

const fresh: ProviderMeta = {
  providerId: 'eastmoney',
  sourceName: '东方财富',
  sourceTimestamp: '2026-08-15T10:00:00+08:00',
  fetchedAt: '2026-08-15T10:00:01+08:00',
  cacheState: 'fresh',
}
const delayed: ProviderMeta = {
  ...fresh,
  providerId: 'eastmoney-delay',
  sourceName: '东方财富（延迟行情）',
  cacheState: 'stale',
}
const fallback: ProviderMeta = {
  ...fresh,
  providerId: 'tencent-fallback',
  sourceName: '腾讯行情（备源）',
}
const snapshot: ProviderMeta = {
  ...fresh,
  providerId: 'eastmoney-memory-cache',
  sourceName: '东方财富（最近成功快照）',
  cacheState: 'stale',
}

const masters: MasterPersona[] = [
  { id: 'buffett', name: '巴菲特', shortName: '巴', description: '关注护城河', color: '#55aaff', roleTag: '价值投资', tags: ['护城河'], defaultPrompt: '', version: '1.0.0' },
  { id: 'munger', name: '芒格', shortName: '芒', description: '坚持多元思维与纪律', color: '#d8ae61', roleTag: '多元思维', tags: ['纪律'], defaultPrompt: '', version: '1.0.0' },
]
const group: WatchGroup = {
  id: 'default',
  name: '默认自选',
  isDefault: true,
  secIds: ['1.600519'],
  items: [{ secId: '1.600519', addedAt: '2026-08-01T00:00:00Z', basePrice: 1400 }],
}
const bootstrap: BootstrapData = {
  theme: 'ocean',
  masters,
  groups: [group],
  judgements: [],
  diagnostics: {
    dataRoot: '/tmp/hanai',
    databasePath: '/tmp/hanai/hanai.db',
    dshHomeOwnedByHost: true,
    securityCount: 1,
    masterCount: 2,
    judgementCount: 0,
    latestMarketSuccess: null,
    latestValuationSuccess: null,
    version: '0.1.0',
  },
}
const dashboard: DashboardData = {
  overview: {
    indices: [{ code: '000001', name: '上证指数', price: 3500, change: 12, changePct: .34, amount: 800_000_000_000, upCount: 1200, downCount: 900, flatCount: 100 }],
    breadth: { up: 1200, down: 900, flat: 100, limitUp: 30, limitDown: 5, totalAmount: 800_000_000_000 },
    marketStatus: 'closed',
    meta: fresh,
  },
  industry: { type: 'industry', sectors: [], meta: fresh },
  concept: { type: 'concept', sectors: [], meta: fresh },
  ranks: { gainers: [], losers: [], amount: [], turnover: [] },
}
const watchQuote: WatchQuote = {
  secId: '1.600519', code: '600519', name: '贵州茅台', price: 1500, change: 10, changePct: .67,
  amount: 1_000_000, volume: 1000, turnoverRate: 1, marketCap: 2_000_000, floatCap: 1_800_000,
  pe: 25, pb: 8, high: 1510, low: 1480, open: 1490, prevClose: 1490,
  groupId: 'default', addedAt: '2026-08-01T00:00:00Z', basePrice: 1400, sinceAddedPct: 7.14,
}
const stockDetail: StockDetail = {
  security: { secId: '1.600519', code: '600519', name: '贵州茅台', exchange: 'SH', pinyinFull: 'guizhoumaotai', pinyinInitial: 'gzmt' },
  quote: watchQuote,
  metrics: null,
  trend: [], daily: [], weekly: [], monthly: [], valuation: null,
  sources: { quote: delayed, metrics: null, trend: fallback, daily: fresh, weekly: fresh, monthly: fresh, valuation: null },
}

describe('HanaiWorkbench parity flows', () => {
  it('opens judgement creation with the master selected from the persona gallery', async () => {
    render(<HanaiWorkbench client={makeClient()} />)
    await screen.findByRole('heading', { name: '市场全景' })

    fireEvent.click(screen.getByRole('button', { name: /大师图鉴/ }))
    fireEvent.click(screen.getByRole('button', { name: '与芒格开始研判 →' }))

    await screen.findByRole('heading', { name: '大师研判' })
    expect(screen.getByRole('button', { name: /芒格/, pressed: true })).not.toBeNull()
    expect(screen.getByRole('button', { name: /巴菲特/, pressed: false })).not.toBeNull()
  })

  it('shows session-aware dashboard, watch provenance, and independent stock/chart sources', async () => {
    render(<HanaiWorkbench client={makeClient()} />)
    await screen.findByRole('heading', { name: '市场全景' })

    await waitFor(() => {
      expect(document.querySelector('[data-data-status="session"]')?.textContent).toBe('已收盘')
    })
    expect(screen.queryByText('LIVE')).toBeNull()
    expect(screen.getAllByText('成交额').length).toBeGreaterThan(0)
    expect(document.querySelector('[aria-label="走势折线图"]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /自选观察/ }))
    expect((await screen.findAllByText('历史快照')).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/最近成功快照/).length).toBeGreaterThanOrEqual(1)

    fireEvent.click(screen.getByRole('button', { name: /搜索股票/ }))
    const dialog = await screen.findByRole('dialog', { name: '全局股票搜索' })
    const searchInput = within(dialog).getByPlaceholderText('输入代码、名称或拼音首字母…')
    fireEvent.change(searchInput, { target: { value: '茅台' } })
    await within(dialog).findByRole('button', { name: /贵州.*茅台/ })
    fireEvent.keyDown(searchInput, { key: 'Enter' })

    await screen.findByRole('heading', { name: '贵州茅台' })
    expect(screen.getByText('延迟行情')).not.toBeNull()
    expect(screen.getByText('备源降级')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '日K' }))
    expect(screen.getByText('最新数据')).not.toBeNull()
  })

  it('removes any live claim when refreshing retained dashboard data fails', async () => {
    render(<HanaiWorkbench client={makeClient({ failDashboardRefresh: true })} />)
    await screen.findByRole('heading', { name: '市场全景' })

    fireEvent.click(screen.getByRole('button', { name: '刷新数据 ↻' }))
    await waitFor(() => {
      expect(document.querySelector('[data-data-status="refresh-failed"]')?.textContent).toBe('刷新失败')
    })
    expect(screen.getByText(/刷新失败，保留上次数据/)).not.toBeNull()
  })
})

function makeClient(options: { failDashboardRefresh?: boolean } = {}): HanaiClient {
  const call = vi.fn(async (endpoint: string, request?: unknown) => {
    switch (endpoint) {
      case 'bootstrap': return bootstrap
      case 'dashboard.get': {
        if (options.failDashboardRefresh === true && (request as { refresh?: boolean } | undefined)?.refresh === true) {
          throw new Error('行情源暂时不可达')
        }
        return dashboard
      }
      case 'watch.quotes': return { quotes: [watchQuote], meta: snapshot }
      case 'watch.list': return [group]
      case 'security.search': return [{ ...stockDetail.security, price: 1500, changePct: .67 }]
      case 'security.detail': return stockDetail
      default: throw new Error(`unexpected endpoint: ${endpoint}`)
    }
  })
  return {
    ctx: {},
    call,
    models: vi.fn().mockResolvedValue([]),
  } as unknown as HanaiClient
}
