// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BootstrapData,
  DashboardData,
  Judgement,
  JudgementDetail,
  MasterPersona,
  ProviderMeta,
  StockDetail,
  WatchGroup,
  WatchQuote,
  WatchValuation,
} from '../../contracts/src/index.ts'
import { HanaiWorkbench } from '../src/app.tsx'
import type { HanaiClient } from '../src/api.ts'

vi.mock('../src/echarts.tsx', () => ({
  EChart: ({ ariaLabel, option, onChartClick, onDataZoom, onAxisPointerUpdate, onPointerLeave }: { ariaLabel?: string; option?: { series?: Array<{ name?: string; data?: number[][] }> }; onChartClick?: (params: unknown) => void; onDataZoom?: (params: unknown) => void; onAxisPointerUpdate?: (params: unknown) => void; onPointerLeave?: () => void }) => {
    const candles = option?.series?.find(item => item.name === 'K 线')?.data ?? []
    const latestClose = candles.at(-1)?.[1]
    return <div
      role="img"
      aria-label={ariaLabel ?? 'ECharts 图表'}
      data-latest-kline-close={latestClose ?? ''}
      onClick={() => onChartClick?.({ data: { sectorCode: 'BK0475', name: '电子' } })}
      onDoubleClick={() => onDataZoom?.({ start: 0, end: 100, startValue: 0, endValue: 1 })}
      onMouseMove={() => onAxisPointerUpdate?.({ axesInfo: [{ axisDim: 'x', axisIndex: 0, value: '2026-08-14' }] })}
      onMouseLeave={() => onPointerLeave?.()}
    />
  },
}))

vi.mock('../../client-chat/src/index.tsx', () => ({
  ChatPanel: ({ title, readOnlyReason, sessionId, compact, hideHeader }: { title?: string; readOnlyReason?: string; sessionId: string; compact?: boolean; hideHeader?: boolean }) => (
    <section aria-label={title ?? '对话'} data-compact={compact ? 'true' : 'false'} data-hide-header={hideHeader ? 'true' : 'false'}>{readOnlyReason ?? '可继续对话'} · {sessionId}</section>
  ),
}))

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '#/dashboard')
})

const fresh: ProviderMeta = {
  providerId: 'eastmoney',
  sourceName: '东方财富',
  sourceTimestamp: '2026-08-15T10:00:00+08:00',
  fetchedAt: '2026-08-15T10:00:01+08:00',
  cacheState: 'fresh',
}

const stale: ProviderMeta = {
  ...fresh,
  providerId: 'eastmoney-cache',
  sourceName: '东方财富（最近成功快照）',
  cacheState: 'stale',
}

const valuationFresh: ProviderMeta = {
  providerId: 'gurufocus-cn-prototype',
  sourceName: '价值大师网（个人研究接口，未获再分发授权）',
  sourceTimestamp: '2026-08-15',
  fetchedAt: '2026-08-15T10:02:00+08:00',
  cacheState: 'cached',
}

const masters: MasterPersona[] = [
  { id: 'buffett', name: '沃伦 · 巴菲特', shortName: '巴', description: '关注护城河、内在价值与资本配置。', color: '#43bc83', roleTag: '价值投资', tags: ['护城河', '内在价值'], defaultPrompt: '', version: '1.0.0' },
  { id: 'munger', name: '查理 · 芒格', shortName: '芒', description: '坚持多元思维与认知纪律。', color: '#6d98ef', roleTag: '多元思维', tags: ['逆向思考', '纪律'], defaultPrompt: '', version: '1.0.0' },
]

const group: WatchGroup = {
  id: 'default',
  name: '默认自选',
  isDefault: true,
  secIds: ['1.600519'],
  items: [{ secId: '1.600519', addedAt: '2026-08-01T00:00:00Z', basePrice: 1400 }],
}

const secondGroup: WatchGroup = {
  id: 'second',
  name: '观察组',
  isDefault: false,
  secIds: ['0.000001'],
  items: [{ secId: '0.000001', addedAt: '2026-08-02T00:00:00Z', basePrice: 10 }],
}

const readyJudgement: Judgement = {
  id: 'judgement-ready',
  secId: '1.600519',
  code: '600519',
  stockName: '贵州茅台',
  masterId: 'buffett',
  masterName: '沃伦 · 巴菲特',
  masterVersion: '1.0.0',
  dshSessionId: 'session-ready',
  reportStatus: 'ready',
  turnStatus: 'idle',
  latestReportVersion: 1,
  modelProvider: 'deepseek',
  model: 'deepseek-chat',
  reasoningEffort: null,
  createdAt: '2026-08-15T09:00:00+08:00',
  updatedAt: '2026-08-15T09:10:00+08:00',
  completedAt: '2026-08-15T09:10:00+08:00',
  errorCode: null,
  errorMessage: null,
}

const generatingJudgement: Judgement = {
  ...readyJudgement,
  id: 'judgement-generating',
  dshSessionId: 'session-generating',
  reportStatus: 'generating',
  turnStatus: 'running',
  latestReportVersion: null,
  completedAt: null,
}

const failedJudgement: Judgement = {
  ...generatingJudgement,
  id: 'judgement-failed',
  reportStatus: 'failed',
  turnStatus: 'idle',
  errorCode: 'RUN_FAILED',
  errorMessage: '研判执行失败',
}

const bootstrap: BootstrapData = {
  theme: 'dark',
  masters,
  groups: [group],
  judgements: [readyJudgement, generatingJudgement],
  diagnostics: {
    dataRoot: '/tmp/hanai',
    databasePath: '/tmp/hanai/hanai.db',
    dshHomeOwnedByHost: true,
    securityCount: 1,
    masterCount: 2,
    judgementCount: 2,
    latestMarketSuccess: fresh.fetchedAt,
    latestValuationSuccess: fresh.fetchedAt,
    storage: { totalBytes: 4096, cacheBytes: 2048, marketCacheBytes: 1024, valuationCacheBytes: 1024, judgementsBytes: 512 },
    version: '0.1.0',
  },
}

const dashboard: DashboardData = {
  overview: {
    indices: [
      { code: '000001', name: '上证指数', price: 3500, change: 12, changePct: .34, amount: 800_000_000_000, upCount: 1200, downCount: 900, flatCount: 100 },
      { code: '399001', name: '深证成指', price: 11000, change: -8, changePct: -.07, amount: 700_000_000_000, upCount: null, downCount: null, flatCount: null },
    ],
    breadth: { up: 1200, down: 900, flat: 100, limitUp: 30, limitDown: 5, totalAmount: 1_500_000_000_000 },
    marketStatus: 'closed',
    meta: fresh,
  },
  industry: {
    type: 'industry',
    sectors: [{ code: 'BK0475', name: '电子', changePct: 1.78, amount: 320_000_000_000, upCount: 80, downCount: 25, leaderName: '示例股份', leaderCode: '600000', leaderChangePct: 4.1 }],
    meta: fresh,
  },
  concept: { type: 'concept', sectors: [], meta: fresh },
  ranks: { gainers: [], losers: [], amount: [], turnover: [] },
}

const watchQuote: WatchQuote = {
  secId: '1.600519', code: '600519', name: '贵州茅台', price: 1500, change: 10, changePct: .67,
  amount: 1_000_000, volume: 1000, turnoverRate: 1, marketCap: 2_000_000, floatCap: 1_800_000,
  pe: 25, pb: 8, high: 1510, low: 1480, open: 1490, prevClose: 1490,
  groupId: 'default', addedAt: '2026-08-01T00:00:00Z', basePrice: 1400, sinceAddedPct: 7.14,
}

const watchQuoteMissing: WatchQuote = {
  ...watchQuote,
  secId: '0.000001',
  code: '000001',
  name: '缺失数据',
  change: null,
  changePct: null,
  amount: null,
  marketCap: null,
  pe: null,
  addedAt: '2026-07-01T00:00:00Z',
}

const secondWatchQuote: WatchQuote = {
  ...watchQuoteMissing,
  name: '观察组股票',
  groupId: secondGroup.id,
  addedAt: secondGroup.items[0]?.addedAt ?? '2026-08-02T00:00:00Z',
}

const watchValuation: WatchValuation = {
  secId: watchQuote.secId,
  fairValue: 1800,
  valuationRank: 4,
  meta: valuationFresh,
}

const stockDetail: StockDetail = {
  security: { secId: '1.600519', code: '600519', name: '贵州茅台', exchange: 'SH', pinyinFull: 'guizhoumaotai', pinyinInitial: 'gzmt' },
  quote: watchQuote,
  metrics: null,
  trend: [{ time: '09:30', price: 1495, avgPrice: 1495, volume: 100 }],
  trendPrevClose: 1490,
  daily: [
    { date: '2026-08-14', open: 1480, close: 1490, high: 1500, low: 1470, volume: 2000, amount: null },
    { date: '2026-08-15', open: 1490, close: 1500, high: 1510, low: 1480, volume: 2500, amount: null },
  ],
  weekly: [],
  monthly: [],
  valuation: {
    stockId: '600519',
    ivDcf: 1470,
    medps: 1450,
    gfScore: 78,
    valuationRank: 2,
    dimensions: { financialStrength: 8, profitability: 9, growth: 7, gfValue: 6, momentum: 5 },
    series: { price: [['2026-08-14', 1490], ['2026-08-15', 1500]], medps: [['2026-08-14', 1440], ['2026-08-15', 1450]] },
    meta: fresh,
  },
  sources: { quote: fresh, metrics: null, trend: fresh, daily: fresh, weekly: null, monthly: null, valuation: fresh },
}

describe('HanaiWorkbench old-client parity', () => {
  it('pins the original shell and chart geometry while light/dark stays token-only', () => {
    const css = readFileSync(join(process.cwd(), 'packages/client-workbench/src/styles.module.css'), 'utf8')
    expect(css).toContain('width: 176px;')
    expect(css).toContain('height: 46px;')
    expect(css).toContain('padding: 14px 8px 18px;')
    expect(css).toContain('grid-template-columns: minmax(0, 1.65fr) minmax(300px, 1fr);')
    expect(css).toContain('.priceChart { height: 380px;')
    expect(css).toContain('.radarChart { height: 210px;')
    expect(css).toContain('.valuationChart { height: 260px;')
    expect(css.match(/\[data-theme='light'\]/g)?.length).toBe(1)
    expect(css).not.toMatch(/ocean|jade|marketing/i)
  })

  it('restores the five original navigation entries and hash history under the Hanai Worth brand', async () => {
    const { container } = renderAt('/dashboard')
    await screen.findByRole('heading', { name: '今日市场' })

    expect(screen.getByLabelText('Hanai Worth · 值见').textContent).toContain('WORTH · 值见')
    expect(document.title).toBe('今日市场 — Hanai Worth · 值见')
    const nav = screen.getByRole('navigation', { name: '主导航' })
    expect(within(nav).getAllByRole('button').map(button => button.querySelector('span:last-child')?.textContent)).toEqual([
      '今日市场', '自选与发现', '大师研判', '专家中心', '设置与诊断',
    ])
    expect(container.querySelector('[data-theme="dark"]')).not.toBeNull()
    expect(screen.queryByText('市场全景')).toBeNull()
    expect(screen.queryByText('大师图鉴')).toBeNull()

    fireEvent.click(within(nav).getByRole('button', { name: /自选与发现/ }))
    await screen.findByRole('heading', { name: '自选与发现' })
    expect(window.location.hash).toBe('#/watch')
    expect(document.title).toBe('自选与发现 — Hanai Worth · 值见')
  })

  it('keeps the sidebar footer empty regardless of provider health timestamps', async () => {
    const { container } = renderAt('/dashboard')
    await screen.findByRole('heading', { name: '今日市场' })
    expect(within(container.querySelector('aside')!).queryByText('行情源')).toBeNull()
    expect(screen.queryByText(/DSH 状态/)).toBeNull()
    cleanup()

    for (const timestamp of [null, '', 'invalid-date'] as const) {
      const client = makeClient({
        bootstrap: () => ({
          ...bootstrap,
          diagnostics: { ...bootstrap.diagnostics, latestMarketSuccess: timestamp },
        }),
      })
      renderAt('/dashboard', client)
      await screen.findByRole('heading', { name: '今日市场' })
      expect(screen.queryByText('行情源')).toBeNull()
      expect(screen.queryByText(/未提供|尚无成功记录/)).toBeNull()
      cleanup()
    }
  })

  it('uses the standard Fullscreen API and follows browser-driven exit state', async () => {
    const documentDescriptors = {
      fullscreenEnabled: Object.getOwnPropertyDescriptor(document, 'fullscreenEnabled'),
      fullscreenElement: Object.getOwnPropertyDescriptor(document, 'fullscreenElement'),
      exitFullscreen: Object.getOwnPropertyDescriptor(document, 'exitFullscreen'),
    }
    const requestDescriptor = Object.getOwnPropertyDescriptor(document.documentElement, 'requestFullscreen')
    let fullscreenElement: Element | null = null
    const requestFullscreen = vi.fn(async (_options?: FullscreenOptions) => {
      fullscreenElement = document.documentElement
      document.dispatchEvent(new Event('fullscreenchange'))
    })
    const exitFullscreen = vi.fn(async () => {
      fullscreenElement = null
      document.dispatchEvent(new Event('fullscreenchange'))
    })

    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true })
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement })
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exitFullscreen })
    Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, value: requestFullscreen })

    try {
      renderAt('/dashboard')
      await screen.findByRole('heading', { name: '今日市场' })
      fireEvent.click(await screen.findByRole('button', { name: '进入网页全屏' }))
      await waitFor(() => expect(requestFullscreen).toHaveBeenCalledWith({ navigationUI: 'hide' }))
      expect(await screen.findByRole('button', { name: '退出网页全屏' })).not.toBeNull()

      await act(async () => {
        fullscreenElement = null
        document.dispatchEvent(new Event('fullscreenchange'))
      })
      expect(await screen.findByRole('button', { name: '进入网页全屏' })).not.toBeNull()

      await act(async () => {
        fullscreenElement = document.documentElement
        document.dispatchEvent(new Event('fullscreenchange'))
      })
      fireEvent.click(await screen.findByRole('button', { name: '退出网页全屏' }))
      await waitFor(() => expect(exitFullscreen).toHaveBeenCalledTimes(1))
      expect(await screen.findByRole('button', { name: '进入网页全屏' })).not.toBeNull()
    } finally {
      cleanup()
      restoreOwnProperty(document, 'fullscreenEnabled', documentDescriptors.fullscreenEnabled)
      restoreOwnProperty(document, 'fullscreenElement', documentDescriptors.fullscreenElement)
      restoreOwnProperty(document, 'exitFullscreen', documentDescriptors.exitFullscreen)
      restoreOwnProperty(document.documentElement, 'requestFullscreen', requestDescriptor)
    }
  })

  it('does not show a fullscreen control when the browser disables the API', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(document, 'fullscreenEnabled')
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => false })
    try {
      renderAt('/dashboard')
      await screen.findByRole('heading', { name: '今日市场' })
      expect(screen.queryByRole('button', { name: /网页全屏/ })).toBeNull()
    } finally {
      cleanup()
      restoreOwnProperty(document, 'fullscreenEnabled', descriptor)
    }
  })

  it('requires both fullscreen entry and exit methods before showing the control', async () => {
    const enabledDescriptor = Object.getOwnPropertyDescriptor(document, 'fullscreenEnabled')
    const exitDescriptor = Object.getOwnPropertyDescriptor(document, 'exitFullscreen')
    const requestDescriptor = Object.getOwnPropertyDescriptor(document.documentElement, 'requestFullscreen')
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true })
    try {
      Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: vi.fn() })
      Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, value: undefined })
      renderAt('/dashboard')
      await screen.findByRole('heading', { name: '今日市场' })
      expect(screen.queryByRole('button', { name: /网页全屏/ })).toBeNull()
      cleanup()

      Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, value: vi.fn() })
      Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: undefined })
      renderAt('/dashboard')
      await screen.findByRole('heading', { name: '今日市场' })
      expect(screen.queryByRole('button', { name: /网页全屏/ })).toBeNull()
    } finally {
      cleanup()
      restoreOwnProperty(document, 'fullscreenEnabled', enabledDescriptor)
      restoreOwnProperty(document, 'exitFullscreen', exitDescriptor)
      restoreOwnProperty(document.documentElement, 'requestFullscreen', requestDescriptor)
    }
  })

  it('keeps the fullscreen label stable when the browser rejects entry or exit', async () => {
    const enabledDescriptor = Object.getOwnPropertyDescriptor(document, 'fullscreenEnabled')
    const elementDescriptor = Object.getOwnPropertyDescriptor(document, 'fullscreenElement')
    const exitDescriptor = Object.getOwnPropertyDescriptor(document, 'exitFullscreen')
    const requestDescriptor = Object.getOwnPropertyDescriptor(document.documentElement, 'requestFullscreen')
    let fullscreenElement: Element | null = null
    const requestFullscreen = vi.fn().mockRejectedValue(new Error('entry denied'))
    const exitFullscreen = vi.fn().mockRejectedValue(new Error('exit denied'))
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true })
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement })
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exitFullscreen })
    Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, value: requestFullscreen })
    try {
      renderAt('/dashboard')
      await screen.findByRole('heading', { name: '今日市场' })
      fireEvent.click(await screen.findByRole('button', { name: '进入网页全屏' }))
      await waitFor(() => expect(requestFullscreen).toHaveBeenCalledTimes(1))
      expect(screen.getByRole('button', { name: '进入网页全屏' })).not.toBeNull()

      await act(async () => {
        fullscreenElement = document.documentElement
        document.dispatchEvent(new Event('fullscreenchange'))
      })
      fireEvent.click(await screen.findByRole('button', { name: '退出网页全屏' }))
      await waitFor(() => expect(exitFullscreen).toHaveBeenCalledTimes(1))
      expect(screen.getByRole('button', { name: '退出网页全屏' })).not.toBeNull()
    } finally {
      cleanup()
      restoreOwnProperty(document, 'fullscreenEnabled', enabledDescriptor)
      restoreOwnProperty(document, 'fullscreenElement', elementDescriptor)
      restoreOwnProperty(document, 'exitFullscreen', exitDescriptor)
      restoreOwnProperty(document.documentElement, 'requestFullscreen', requestDescriptor)
    }
  })

  it('keeps the dashboard order and renders an ECharts treemap with in-place sector drill-down', async () => {
    renderAt('/dashboard')
    await screen.findByRole('heading', { name: '今日市场' })

    const breadth = screen.getByRole('heading', { name: '市场宽度' })
    const heat = screen.getByRole('heading', { name: '板块热力' })
    const rank = screen.getByRole('heading', { name: '榜单' })
    expect(breadth.compareDocumentPosition(heat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(heat.compareDocumentPosition(rank) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(screen.getByRole('img', { name: '板块成交额热力图' }))
    await screen.findByRole('heading', { name: '板块热力 · 电子' })
    expect(screen.queryByRole('dialog', { name: /电子/ })).toBeNull()
  })

  it('keeps only the latest sector drill response when an aborted request resolves late', async () => {
    const first = deferred<{ stocks: WatchQuote[]; meta: ProviderMeta }>()
    const second = deferred<{ stocks: WatchQuote[]; meta: ProviderMeta }>()
    const signals: AbortSignal[] = []
    let requestIndex = 0
    const client = makeClient({
      'sector.stocks': (_request, signal) => {
        if (signal !== undefined) signals.push(signal)
        return requestIndex++ === 0 ? first.promise : second.promise
      },
    })
    renderAt('/dashboard', client)
    await screen.findByRole('heading', { name: '今日市场' })

    fireEvent.click(screen.getByRole('img', { name: '板块成交额热力图' }))
    fireEvent.click(await screen.findByRole('button', { name: '← 返回板块' }))
    expect(signals[0]?.aborted).toBe(true)
    fireEvent.click(screen.getByRole('img', { name: '板块成交额热力图' }))

    await act(async () => {
      second.resolve({ stocks: [{ ...watchQuote, name: '最新批次' }], meta: fresh })
      await second.promise
    })
    expect(await screen.findByText('最新批次')).not.toBeNull()

    await act(async () => {
      first.resolve({ stocks: [{ ...watchQuote, name: '迟到批次' }], meta: fresh })
      await first.promise
    })
    expect(screen.queryByText('迟到批次')).toBeNull()
    expect(screen.getByText('最新批次')).not.toBeNull()
  })

  it('restores watch columns, default added-date sort, three-state sorting, and group manager', async () => {
    renderAt('/watch')
    await screen.findByRole('heading', { name: '自选与发现' })
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent?.trim())).toEqual([
      '名称', '最新价', '涨跌幅', '成交额', '换手率', '总市值', 'PE(动)', 'PB', '合理估值', '距现价', '加入日期 ↓', '加入以来', '',
    ])
    expect(within(table).getByLabelText('查看 贵州茅台 600519').tabIndex).toBe(0)
    expect(within(table).getByText('1,800.00')).not.toBeNull()
    expect(within(table).getByText('+20.00%')).not.toBeNull()
    expect(within(table).getByText('+300.00 元')).not.toBeNull()

    const changeHead = within(table).getByRole('button', { name: '涨跌幅' })
    fireEvent.click(changeHead)
    expect(changeHead.closest('th')?.getAttribute('aria-sort')).toBe('descending')
    expect(within(table).getAllByLabelText(/查看 /).map(row => row.getAttribute('aria-label'))).toEqual(['查看 贵州茅台 600519', '查看 缺失数据 000001'])
    fireEvent.click(changeHead)
    expect(changeHead.closest('th')?.getAttribute('aria-sort')).toBe('ascending')
    expect(within(table).getAllByLabelText(/查看 /).map(row => row.getAttribute('aria-label'))).toEqual(['查看 贵州茅台 600519', '查看 缺失数据 000001'])
    fireEvent.click(changeHead)
    expect(within(table).getByRole('button', { name: /加入日期/ }).closest('th')?.getAttribute('aria-sort')).toBe('descending')

    fireEvent.click(screen.getByRole('button', { name: '管理分组' }))
    expect(await screen.findByRole('dialog', { name: '管理自选分组' })).not.toBeNull()
  })

  it('shows a table-shaped quote skeleton, then fills valuation cells from one group request', async () => {
    const quotes = deferred<{ quotes: WatchQuote[]; meta: ProviderMeta }>()
    const valuations = deferred<{ valuations: WatchValuation[]; meta: ProviderMeta | null }>()
    const client = makeClient({
      'watch.quotes': () => quotes.promise,
      'watch.valuations': () => valuations.promise,
    })
    renderAt('/watch', client)
    await screen.findByRole('heading', { name: '自选与发现' })
    expect(screen.getByRole('status', { name: '正在加载自选行情' })).not.toBeNull()

    await act(async () => {
      quotes.resolve({ quotes: [watchQuote], meta: fresh })
      await quotes.promise
    })
    const table = await screen.findByRole('table')
    expect(screen.queryByRole('status', { name: '正在加载自选行情' })).toBeNull()
    expect(within(table).queryByText('1,800.00')).toBeNull()

    await act(async () => {
      valuations.resolve({ valuations: [watchValuation], meta: valuationFresh })
      await valuations.promise
    })
    expect(await within(table).findByText('1,800.00')).not.toBeNull()
  })

  it('refreshes quotes and daily valuations together from one explicit action', async () => {
    let quoteCalls = 0
    let valuationCalls = 0
    const client = makeClient({
      'watch.quotes': () => {
        quoteCalls += 1
        return { quotes: [watchQuote], meta: fresh }
      },
      'watch.valuations': () => {
        valuationCalls += 1
        return { valuations: [watchValuation], meta: valuationFresh }
      },
    })
    renderAt('/watch', client)
    await screen.findByLabelText('查看 贵州茅台 600519')
    await screen.findByText('1,800.00')
    expect([quoteCalls, valuationCalls]).toEqual([1, 1])

    fireEvent.click(screen.getByRole('button', { name: '刷新当前自选分组' }))
    await waitFor(() => expect([quoteCalls, valuationCalls]).toEqual([2, 2]))
  })

  it('deletes a settled judgement only after explicit confirmation and protects active runs', async () => {
    const removeRequests: unknown[] = []
    const client = makeClient({
      'judgement.remove': request => {
        removeRequests.push(request)
        return [generatingJudgement]
      },
    })
    renderAt('/judgements', client)
    await screen.findByRole('heading', { name: '大师研判' })

    const activeDelete = screen.getByRole('button', { name: /删除进行中研判/ })
    expect((activeDelete as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /删除已完成研判/ }))

    const dialog = await screen.findByRole('dialog', { name: '删除研判报告' })
    expect(within(dialog).getByText(/全部报告版本和本地工作文件/)).not.toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))

    await waitFor(() => expect(removeRequests).toEqual([{ id: readyJudgement.id }]))
    expect(screen.queryByRole('dialog', { name: '删除研判报告' })).toBeNull()
    expect(screen.queryByRole('button', { name: /删除已完成研判/ })).toBeNull()
    expect(screen.getByText('研判报告已删除')).not.toBeNull()
  })

  it('cancels a previous watch-group batch and ignores its late rows', async () => {
    const first = deferred<{ quotes: WatchQuote[]; meta: ProviderMeta }>()
    const second = deferred<{ quotes: WatchQuote[]; meta: ProviderMeta }>()
    const requests: Array<{ groupId: string; signal?: AbortSignal }> = []
    const client = makeClient({
      bootstrap: () => ({ ...bootstrap, groups: [group, secondGroup] }),
      'watch.quotes': (request, signal) => {
        const groupId = (request as { groupId: string }).groupId
        requests.push({ groupId, ...(signal === undefined ? {} : { signal }) })
        return groupId === group.id ? first.promise : second.promise
      },
    })
    renderAt('/watch', client)
    await screen.findByRole('heading', { name: '自选与发现' })
    await waitFor(() => expect(requests.some(request => request.groupId === group.id)).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: /观察组/ }))
    await waitFor(() => expect(requests.some(request => request.groupId === secondGroup.id)).toBe(true))
    expect(requests.find(request => request.groupId === group.id)?.signal?.aborted).toBe(true)

    await act(async () => {
      second.resolve({ quotes: [secondWatchQuote], meta: fresh })
      await second.promise
    })
    expect(await screen.findByLabelText('查看 观察组股票 000001')).not.toBeNull()

    await act(async () => {
      first.resolve({ quotes: [watchQuote], meta: fresh })
      await first.promise
    })
    expect(screen.queryByLabelText('查看 贵州茅台 600519')).toBeNull()
    expect(screen.getByLabelText('查看 观察组股票 000001')).not.toBeNull()
  })

  it('binds a watch-row mutation to the group batch that produced the row', async () => {
    const removal = deferred<WatchGroup[]>()
    const removeRequests: unknown[] = []
    const client = makeClient({
      bootstrap: () => ({ ...bootstrap, groups: [group, secondGroup] }),
      'watch.quotes': request => (request as { groupId: string }).groupId === group.id
        ? { quotes: [watchQuote], meta: fresh }
        : { quotes: [secondWatchQuote], meta: fresh },
      'watch.item.remove': request => {
        removeRequests.push(request)
        return removal.promise
      },
    })
    renderAt('/watch', client)
    await screen.findByLabelText('查看 贵州茅台 600519')

    fireEvent.click(screen.getByRole('button', { name: '移除' }))
    fireEvent.click(screen.getByRole('button', { name: /观察组/ }))

    expect(removeRequests).toEqual([{ groupId: group.id, secId: watchQuote.secId }])
    await act(async () => {
      removal.resolve([group, secondGroup])
      await removal.promise
    })
    expect(await screen.findByLabelText('查看 观察组股票 000001')).not.toBeNull()
  })

  it('deep-links to the old stock layout with daily K-line and a separate valuation curve', async () => {
    renderAt('/stock/1.600519')
    await screen.findByRole('heading', { name: '贵州茅台' })

    expect(window.location.hash).toBe('#/stock/1.600519')
    expect(screen.getByRole('button', { name: '日K' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: /^(3年|5年|10年|全部)$/ })).toBeNull()
    expect(screen.getByRole('img', { name: '日K线图' })).not.toBeNull()
    expect(screen.getByRole('group', { name: '均线组合模式' })).not.toBeNull()
    expect(screen.getByRole('button', { name: '短线 MA5 / MA10' }).getAttribute('aria-pressed')).toBe('true')
    const turningToggle = screen.getByRole('button', { name: '变盘点' })
    expect(turningToggle.getAttribute('aria-pressed')).toBe('true')
    expect(turningToggle.textContent).toContain('显示')
    fireEvent.click(turningToggle)
    expect(turningToggle.getAttribute('aria-pressed')).toBe('false')
    expect(turningToggle.textContent).toContain('隐藏')
    expect(screen.queryByLabelText('量价观察标记：分歧、弱收、深跌、强收、长影、回稳')).toBeNull()
    expect(screen.queryByLabelText('K线行情数据')).toBeNull()
    expect(screen.queryByLabelText('量价观察标记')).toBeNull()
    expect(screen.queryByText('当前 K 线未触发高胜率量价条件')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '中线 MA20 / MA60' }))
    expect(screen.getByRole('button', { name: '中线 MA20 / MA60' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('MA20')).not.toBeNull()
    expect(screen.getByText('MA60')).not.toBeNull()
    expect(screen.getByText('最新 K 每 15 秒刷新并动态重算 · 标记点悬浮查看历史后续')).not.toBeNull()
    expect(screen.queryByText(/买点|卖点/)).toBeNull()
    expect(screen.getByRole('heading', { name: '价值判断' })).not.toBeNull()
    expect(screen.getByText('大师价值')).not.toBeNull()
    expect(screen.getByRole('heading', { name: '价值曲线' })).not.toBeNull()
    expect(screen.getByRole('img', { name: '价格与大师价值曲线' })).not.toBeNull()
    expect(screen.getByText(/价值线末端为供应商预测/)).not.toBeNull()
  })

  it('loads quote, daily K, and valuation independently and lazily requests longer periods', async () => {
    const quote = deferred<{
      quote: StockDetail['quote']
      metrics: StockDetail['metrics']
      sources: Pick<StockDetail['sources'], 'quote' | 'metrics'>
    }>()
    const daily = deferred<{ period: 'daily'; bars: StockDetail['daily']; meta: ProviderMeta | null; hasMore: boolean }>()
    const olderDaily = deferred<{ period: 'daily'; bars: StockDetail['daily']; meta: ProviderMeta | null; hasMore: boolean }>()
    const weekly = deferred<{ period: 'weekly'; bars: StockDetail['weekly']; meta: ProviderMeta | null; hasMore: boolean }>()
    const valuation = deferred<never>()
    const surfaceCalls: Array<{ endpoint: string; request: unknown }> = []
    const client = makeClient({
      'security.quote': request => {
        surfaceCalls.push({ endpoint: 'security.quote', request })
        return quote.promise
      },
      'security.kline': request => {
        surfaceCalls.push({ endpoint: 'security.kline', request })
        const { period, before } = request as { period: string; before?: string }
        if (period === 'daily' && before !== undefined) return olderDaily.promise
        if (period === 'daily') return daily.promise
        if (period === 'weekly') return weekly.promise
        throw new Error(`unexpected period: ${period}`)
      },
      'security.valuation': request => {
        surfaceCalls.push({ endpoint: 'security.valuation', request })
        return valuation.promise
      },
    })
    renderAt('/stock/1.600519', client)
    await screen.findByRole('heading', { name: '贵州茅台' })

    expect(surfaceCalls.some(call => call.endpoint === 'security.quote')).toBe(true)
    expect(surfaceCalls.some(call => call.endpoint === 'security.kline' && (call.request as { period: string }).period === 'daily')).toBe(true)
    expect(surfaceCalls.some(call => call.endpoint === 'security.valuation')).toBe(true)
    expect(surfaceCalls.some(call => call.endpoint === 'security.kline' && (call.request as { period: string }).period === 'weekly')).toBe(false)
    expect(surfaceCalls.some(call => call.endpoint === 'security.kline' && (call.request as { period: string }).period === 'monthly')).toBe(false)
    expect(client.call).not.toHaveBeenCalledWith('security.detail', expect.anything())
    expect(client.call).not.toHaveBeenCalledWith('security.detail', expect.anything(), expect.anything())
    expect(screen.getByRole('status', { name: '正在加载估值数据' })).not.toBeNull()
    expect(screen.getByRole('status', { name: '正在加载估值曲线' })).not.toBeNull()
    expect(screen.queryByText('估值数据暂不可用')).toBeNull()
    expect(screen.queryByText('暂无估值曲线')).toBeNull()

    await act(async () => {
      daily.resolve({ period: 'daily', bars: stockDetail.daily, meta: fresh, hasMore: true })
      await daily.promise
    })
    const dailyChart = await screen.findByRole('img', { name: '日K线图' })
    fireEvent.doubleClick(dailyChart)
    await waitFor(() => expect(surfaceCalls).toContainEqual({
      endpoint: 'security.kline',
      request: { secId: '1.600519', period: 'daily', before: '2026-08-14' },
    }))
    expect(screen.getByRole('status', { name: '正在加载更早行情' })).not.toBeNull()
    await act(async () => {
      olderDaily.resolve({
        period: 'daily',
        bars: [{ date: '2023-08-15', open: 1400, close: 1410, high: 1420, low: 1390, volume: 1800, amount: 1_800_000 }],
        meta: fresh,
        hasMore: false,
      })
      await olderDaily.promise
    })
    expect(screen.queryByRole('status', { name: '正在加载更早行情' })).toBeNull()
    expect(screen.getByText(/已加载完整历史/)).not.toBeNull()

    await act(async () => {
      valuation.reject(new Error('valuation offline'))
      try { await valuation.promise } catch { /* expected */ }
    })
    expect(screen.getByRole('img', { name: '日K线图' })).not.toBeNull()
    expect(screen.getByText('估值数据暂不可用')).not.toBeNull()
    expect(screen.getByText('暂无估值曲线')).not.toBeNull()
    expect(screen.queryByRole('status', { name: '正在加载估值数据' })).toBeNull()
    expect(screen.queryByRole('status', { name: '正在加载估值曲线' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '周K' }))
    await waitFor(() => expect(surfaceCalls.some(call => call.endpoint === 'security.kline' && (call.request as { period: string }).period === 'weekly')).toBe(true))
    expect(surfaceCalls.some(call => call.endpoint === 'security.kline' && (call.request as { period: string }).period === 'monthly')).toBe(false)
    await act(async () => {
      weekly.resolve({ period: 'weekly', bars: stockDetail.daily, meta: fresh, hasMore: false })
      await weekly.promise
    })
    expect(await screen.findByRole('img', { name: '周K线图' })).not.toBeNull()

    await act(async () => {
      quote.resolve({ quote: stockDetail.quote, metrics: stockDetail.metrics, sources: { quote: fresh, metrics: null } })
      await quote.promise
    })
    expect(screen.getByRole('heading', { name: '贵州茅台' })).not.toBeNull()
  })

  it('refreshes the active daily, weekly, and monthly K line every 15 seconds', async () => {
    vi.useFakeTimers()
    const calls = { daily: 0, weekly: 0, monthly: 0 }
    const client = makeClient({
      'security.kline': request => {
        const period = (request as { period: keyof typeof calls }).period
        calls[period] += 1
        const bars = stockDetail.daily.map((bar, index) => index === stockDetail.daily.length - 1
          ? { ...bar, close: bar.close + calls[period] }
          : bar)
        return { period, bars, meta: { ...fresh, fetchedAt: `2026-08-15T10:00:${String(calls[period]).padStart(2, '0')}+08:00` }, hasMore: period === 'daily' }
      },
    })

    try {
      renderAt('/stock/1.600519', client)
      await act(async () => {
        for (let index = 0; index < 8; index += 1) await Promise.resolve()
      })

      expect(calls).toEqual({ daily: 1, weekly: 0, monthly: 0 })
      expect(screen.getByRole('img', { name: '日K线图' }).getAttribute('data-latest-kline-close')).toBe('1501')

      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
      expect(calls.daily).toBe(2)
      expect(screen.getByRole('img', { name: '日K线图' }).getAttribute('data-latest-kline-close')).toBe('1502')

      fireEvent.click(screen.getByRole('button', { name: '周K' }))
      await act(async () => {
        for (let index = 0; index < 4; index += 1) await Promise.resolve()
      })
      expect(calls.weekly).toBe(1)
      expect(screen.getByRole('img', { name: '周K线图' }).getAttribute('data-latest-kline-close')).toBe('1501')

      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
      expect(calls.weekly).toBe(2)
      expect(screen.getByRole('img', { name: '周K线图' }).getAttribute('data-latest-kline-close')).toBe('1502')

      fireEvent.click(screen.getByRole('button', { name: '月K' }))
      await act(async () => {
        for (let index = 0; index < 4; index += 1) await Promise.resolve()
      })
      expect(calls.monthly).toBe(1)
      expect(screen.getByRole('img', { name: '月K线图' }).getAttribute('data-latest-kline-close')).toBe('1501')

      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
      expect(calls.monthly).toBe(2)
      expect(screen.getByRole('img', { name: '月K线图' }).getAttribute('data-latest-kline-close')).toBe('1502')
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('keeps experts informational and exposes only conventional light/dark themes', async () => {
    const { client } = renderAt('/personas')
    await screen.findByRole('heading', { name: '专家中心' })
    expect(screen.getByText('沃伦 · 巴菲特')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /开始研判/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /设置与诊断/ }))
    await screen.findByRole('heading', { name: '设置与诊断' })
    const lightTheme = screen.getByText('亮色模式').closest('button')
    const darkTheme = screen.getByText('黑夜模式').closest('button')
    expect(lightTheme).not.toBeNull()
    expect(darkTheme).not.toBeNull()
    expect(screen.queryByText(/Ocean|Jade|花|澄|青/i)).toBeNull()
    if (lightTheme !== null) fireEvent.click(lightTheme)
    await waitFor(() => expect(client.call).toHaveBeenCalledWith('theme.set', { theme: 'light' }))
  })

  it('renders the complete Host-provided expert description and methods without a UI summary or clamp', async () => {
    const fullDescription = '使用公开材料提炼本分、消费者导向、组织授权和长期价值投资框架，以中性思维顾问方式分析企业、投资、经营、合作或人生决策。基于 6 维调研和 79 个可追溯引用标识，含 6 个模型、10 条启发式。仅当用户明确点名段永平、要求分析其公开观点或思维方式时触发；默认不角色扮演。'
    const longFormMaster: MasterPersona = {
      ...masters[0]!,
      name: '段永平',
      shortName: '段',
      description: fullDescription,
      roleTag: '价值投资',
      tags: ['本分', '消费者导向', '长期价值'],
    }
    const client = makeClient({ bootstrap: () => ({ ...bootstrap, masters: [longFormMaster, masters[1]!] }) })
    renderAt('/personas', client)

    const card = await screen.findByRole('article', { name: '段永平专家信息' })
    expect(within(card).getByText(fullDescription).textContent).toBe(fullDescription)
    expect(within(card).getByText('价值投资')).not.toBeNull()
    expect(within(card).getByText('本分')).not.toBeNull()
    expect(within(card).getByText('消费者导向')).not.toBeNull()
    expect(within(card).getByText('长期价值')).not.toBeNull()
    expect(within(card).queryByRole('button')).toBeNull()

    const css = readFileSync(join(process.cwd(), 'packages/client-workbench/src/styles.module.css'), 'utf8')
    const descriptionRule = /\.personaDescription\s*\{([^}]+)\}/.exec(css)?.[1] ?? ''
    expect(descriptionRule).toContain('white-space: pre-wrap;')
    expect(descriptionRule).toContain('overflow-wrap: anywhere;')
    expect(descriptionRule).not.toMatch(/line-clamp|max-height|text-overflow|overflow:\s*hidden/)
  })

  it('keeps every settings and diagnostic control in the compact hierarchy', async () => {
    const { client } = renderAt('/settings')
    await screen.findByRole('heading', { name: '设置与诊断' })
    await waitFor(() => expect(client.credential).toHaveBeenCalled())

    for (const section of ['DSH Agent', 'DeepSeek API Key', '数据源', '本地存储', '界面主题', '关于与声明']) {
      expect(screen.getByRole('heading', { name: section })).not.toBeNull()
    }
    expect(screen.getByLabelText('默认模型')).not.toBeNull()
    const keyInput = screen.getByLabelText('写入新的 API Key')
    expect(keyInput.getAttribute('type')).toBe('password')
    expect(keyInput.getAttribute('autocomplete')).toBe('off')
    for (const action of ['重新检测连接', '安全保存', '移除', '立即同步主数据', '打开数据目录', '清理行情缓存', '清理估值缓存', '亮色模式', '黑夜模式']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${action}`) })).not.toBeNull()
    }
    expect(screen.getByText('清理缓存不会删除自选、专家与研判报告。')).not.toBeNull()
    expect(screen.getAllByText(bootstrap.diagnostics.dataRoot).length).toBeGreaterThan(0)
    expect(screen.getByText(/Hanai Worth · 值见/)).not.toBeNull()
    expect(screen.getByText(/价格有报价，价值靠研究/)).not.toBeNull()
  })

  it('shows a read-only live process while generating and report/process/chat only after ready', async () => {
    renderAt('/judgements/judgement-generating')
    await screen.findByRole('heading', { name: /贵州茅台/ })
    const liveProcess = screen.getByLabelText('实时研判过程')
    expect(liveProcess.textContent).toContain('报告生成期间仅查看执行过程')
    expect(liveProcess.getAttribute('data-compact')).toBe('true')
    expect(liveProcess.getAttribute('data-hide-header')).toBe('true')
    expect(screen.queryByRole('button', { name: '继续对话' })).toBeNull()

    const css = readFileSync(join(process.cwd(), 'packages/client-workbench/src/styles.module.css'), 'utf8')
    const liveRule = /\.liveProcess\s*\{([^}]+)\}/.exec(css)?.[1] ?? ''
    expect(liveRule).toContain('grid-template-rows: auto minmax(0, 1fr);')
    expect(liveRule).toContain('height: calc(100vh - 150px);')
    cleanup()

    renderAt('/judgements/judgement-ready')
    await screen.findByRole('heading', { name: /贵州茅台/ })
    expect(screen.getByRole('heading', { name: '研判报告' })).not.toBeNull()
    expect(screen.getByRole('button', { name: '查看研判过程' })).not.toBeNull()
    expect(screen.getByRole('button', { name: '继续对话' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '查看研判过程' }))
    const archivedProcess = await screen.findByLabelText('研判过程')
    expect(archivedProcess.textContent).toContain('已归档的研判过程为只读记录')
    expect(archivedProcess.getAttribute('data-compact')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '继续对话' }))
    const continuedChat = await screen.findByLabelText('继续与沃伦 · 巴菲特对话')
    expect(continuedChat.textContent).toContain('可继续对话')
    expect(continuedChat.getAttribute('data-compact')).toBe('true')
  })

  it('keeps judgement detail and continuation session bound to the latest route', async () => {
    const oldRequest = deferred<JudgementDetail>()
    const nextRequest = deferred<JudgementDetail>()
    const signals = new Map<string, AbortSignal>()
    const nextJudgement: Judgement = {
      ...readyJudgement,
      id: 'judgement-next',
      stockName: '新路由公司',
      dshSessionId: 'session-next',
    }
    const nextDetail: JudgementDetail = {
      judgement: nextJudgement,
      reports: [{
        judgementId: nextJudgement.id,
        version: 1,
        content: '# 新报告',
        sha256: 'next',
        sizeBytes: 64,
        sealedAt: nextJudgement.completedAt ?? nextJudgement.updatedAt,
        modelProvider: nextJudgement.modelProvider,
        model: nextJudgement.model,
      }],
    }
    const client = makeClient({
      'judgement.get': (request, signal) => {
        const requestId = (request as { id: string }).id
        if (signal !== undefined) signals.set(requestId, signal)
        return requestId === nextJudgement.id ? nextRequest.promise : oldRequest.promise
      },
    })
    renderAt('/judgements/judgement-ready', client)
    await waitFor(() => expect(signals.has(readyJudgement.id)).toBe(true))

    await act(async () => {
      window.history.pushState(null, '', `#/judgements/${nextJudgement.id}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await waitFor(() => expect(signals.has(nextJudgement.id)).toBe(true))
    expect(signals.get(readyJudgement.id)?.aborted).toBe(true)

    await act(async () => {
      nextRequest.resolve(nextDetail)
      await nextRequest.promise
    })
    expect(await screen.findByRole('heading', { name: /新路由公司/ })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '继续对话' }))
    expect((await screen.findByLabelText('继续与沃伦 · 巴菲特对话')).textContent).toContain('session-next')

    await act(async () => {
      oldRequest.resolve(detailFor(readyJudgement.id))
      await oldRequest.promise
    })
    expect(screen.queryByRole('heading', { name: /贵州茅台/ })).toBeNull()
    expect(screen.getByLabelText('继续与沃伦 · 巴菲特对话').textContent).toContain('session-next')
  })

  it('retries a failed judgement with the original stock and master preselected', async () => {
    renderAt('/judgements/judgement-failed')
    await screen.findByRole('heading', { name: /贵州茅台/ })
    fireEvent.click(screen.getByRole('button', { name: '重新研判' }))

    const dialog = await screen.findByRole('dialog', { name: '新建大师研判' })
    expect(within(dialog).getByText('贵州茅台')).not.toBeNull()
    expect(within(dialog).getByRole('button', { name: /沃伦 · 巴菲特/, pressed: true })).not.toBeNull()
    expect(window.location.hash).toBe('#/judgements')
  })
})

function renderAt(path: string, client = makeClient()): { client: HanaiClient } & ReturnType<typeof render> {
  window.history.replaceState(null, '', `#${path}`)
  return { client, ...render(<HanaiWorkbench client={client} />) }
}

type CallOverride = (request: unknown, signal?: AbortSignal) => unknown | Promise<unknown>

function makeClient(overrides: Record<string, CallOverride> = {}): HanaiClient {
  const call = vi.fn(async (endpoint: string, request?: unknown, signal?: AbortSignal) => {
    const override = overrides[endpoint]
    if (override !== undefined) return override(request, signal)
    switch (endpoint) {
      case 'bootstrap': return bootstrap
      case 'dashboard.get': return dashboard
      case 'sector.stocks': return { stocks: [watchQuote], meta: fresh }
      case 'watch.quotes': return { quotes: [watchQuote, watchQuoteMissing], meta: stale }
      case 'watch.valuations': return {
        valuations: [watchValuation, { secId: watchQuoteMissing.secId, fairValue: null, valuationRank: null, meta: null }],
        meta: valuationFresh,
      }
      case 'watch.list': return [group]
      case 'security.search': return [{ ...stockDetail.security, price: 1500, changePct: .67 }]
      case 'security.detail': return stockDetail
      case 'security.quote': return { quote: stockDetail.quote, metrics: stockDetail.metrics, sources: { quote: fresh, metrics: null } }
      case 'security.trend': return { trend: stockDetail.trend, trendPrevClose: stockDetail.trendPrevClose, meta: fresh }
      case 'security.kline': {
        const period = (request as { period: 'daily' | 'weekly' | 'monthly' }).period
        return { period, bars: stockDetail[period], meta: stockDetail.sources[period], hasMore: period === 'daily' }
      }
      case 'security.valuation': return { valuation: stockDetail.valuation, meta: fresh }
      case 'judgement.list': return bootstrap.judgements
      case 'judgement.remove': return bootstrap.judgements.filter(item => item.id !== (request as { id: string }).id)
      case 'judgement.get': return detailFor((request as { id: string }).id)
      case 'theme.set': return request
      case 'cache.clear': return { scope: (request as { scope: 'market' | 'valuation' }).scope, removedFiles: 0, freedBytes: 0 }
      case 'storage.openDataRoot': return { opened: true, dataRoot: bootstrap.diagnostics.dataRoot }
      default: throw new Error(`unexpected endpoint: ${endpoint}`)
    }
  })
  return {
    ctx: {},
    call,
    isLoopback: true,
    credential: vi.fn().mockResolvedValue({ configured: false, writable: true }),
    setDeepSeekKey: vi.fn().mockResolvedValue(undefined),
    unsetDeepSeekKey: vi.fn().mockResolvedValue(undefined),
    models: vi.fn().mockResolvedValue([]),
    defaultModel: vi.fn().mockResolvedValue(null),
    setDefaultModel: vi.fn(),
  } as unknown as HanaiClient
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

function restoreOwnProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined) {
  if (descriptor === undefined) Reflect.deleteProperty(target, key)
  else Object.defineProperty(target, key, descriptor)
}

function detailFor(id: string): JudgementDetail {
  const judgement = id === generatingJudgement.id ? generatingJudgement : id === failedJudgement.id ? failedJudgement : readyJudgement
  return {
    judgement,
    reports: judgement.reportStatus === 'ready' ? [{
      judgementId: judgement.id,
      version: 1,
      content: '# 投资结论\n\n价值与风险并重。',
      sha256: 'test',
      sizeBytes: 128,
      sealedAt: judgement.completedAt ?? judgement.updatedAt,
      modelProvider: judgement.modelProvider,
      model: judgement.model,
    }] : [],
  }
}
