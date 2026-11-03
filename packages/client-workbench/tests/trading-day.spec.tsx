// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BootstrapData,
  DashboardData,
  ProviderMeta,
  TradingDayAnalysisData,
  TradingDayContextData,
  TradingDayDragonTigerData,
  TradingDayLimitPoolsData,
  TradingDaySnapshotRecord,
  TradingDayThemesData,
} from '../../contracts/src/index.ts'
import { HanaiWorkbench } from '../src/app.tsx'
import type { HanaiClient } from '../src/api.ts'
import { getChartPalette } from '../src/chart-options.ts'
import { buildIntradayOption } from '../src/trading-day.tsx'

vi.mock('../src/echarts.tsx', () => ({
  EChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel ?? 'ECharts 图表'} />,
}))

vi.mock('../../client-chat/src/index.tsx', () => ({
  ChatPanel: () => <section aria-label="对话">可继续对话</section>,
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const fresh: ProviderMeta = {
  providerId: 'eastmoney',
  sourceName: '东方财富',
  sourceTimestamp: '2026-10-20T15:00:00+08:00',
  fetchedAt: '2026-10-20T15:00:01+08:00',
  cacheState: 'fresh',
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

const bootstrap: BootstrapData = {
  theme: 'dark',
  masters: [],
  groups: [],
  judgements: [],
  expertChats: [],
  diagnostics: {
    dataRoot: '/tmp/hanai',
    databasePath: '/tmp/hanai/hanai.db',
    dshHomeOwnedByHost: true,
    securityCount: 1,
    masterCount: 0,
    judgementCount: 0,
    expertChatCount: 0,
    latestMarketSuccess: fresh.fetchedAt,
    latestValuationSuccess: fresh.fetchedAt,
    storage: { totalBytes: 4096, cacheBytes: 2048, marketCacheBytes: 1024, valuationCacheBytes: 1024, judgementsBytes: 512, expertChatsBytes: 256 },
    version: '0.1.0',
  },
}

const contextData: TradingDayContextData = {
  tradeDate: '2026-10-20',
  generatedAt: '2026-10-20T15:05:00+08:00',
  status: 'complete',
  indices: [],
  trend: {
    code: '000001',
    name: '上证指数',
    date: '2026-10-20',
    prevClose: 3500,
    points: [
      { time: '09:30', price: 3498, avgPrice: 3499, volume: 1000 },
      { time: '10:00', price: 3510, avgPrice: 3505, volume: 1200 },
    ],
  },
  turnover: { amount: 900_000_000_000, previousAmount: 800_000_000_000, previousTradeDate: '2026-10-17', changePct: 12.5 },
  margin: { tradeDate: '2026-10-20', total: 950_000_000_000, previousTotal: 940_000_000_000, change: 10_000_000_000, changePct: 1.06 },
  sources: [],
}

const ladderStock = (index: number) => ({
  code: `6000${String(index).padStart(2, '0')}`,
  name: `梯队股${index}`,
  price: 10,
  changePct: 10,
  amount: 100_000_000,
  turnoverRate: 5,
  marketCap: 1_000_000_000,
  boardCount: 6,
  firstLimitTime: null,
  lastLimitTime: null,
  reason: '算力租赁',
  boardType: '换手板',
  theme: '算力',
})

const limitPoolsData: TradingDayLimitPoolsData = {
  tradeDate: '2026-10-20',
  generatedAt: '2026-10-20T15:05:00+08:00',
  status: 'complete',
  stats: { limitUp: 60, limitDown: 5, broken: 10, sealRate: 85.7, breakRate: 14.3, firstBoard: 40, lianban: 20, maxBoard: 6, promotionRate: 42.5 },
  ladder: [
    {
      board: 6,
      label: '6 板',
      count: 12,
      stocks: Array.from({ length: 12 }, (_, index) => ladderStock(index + 1)),
    },
  ],
  yesterdayPerformance: { sample: 50, promoted: 20, avgChangePct: 3.2, medianChangePct: 2.1, upRate: 60 },
  sources: [],
}

const themesData: TradingDayThemesData = {
  tradeDate: '2026-10-20',
  generatedAt: '2026-10-20T15:05:00+08:00',
  status: 'complete',
  themes: Array.from({ length: 9 }, (_, index) => ({
    name: `题材${index + 1}`,
    count: 10 + index,
    maxBoard: 6,
    leaders: [`题材${index + 1}龙头甲`, `题材${index + 1}龙头乙`, `题材${index + 1}龙头丙`, `题材${index + 1}龙头丁`],
  })),
  drives: [{ tag: '算力', count: 20, maxBoard: 6, leaders: ['龙头甲'] }],
  sources: [],
}

const dragonTigerData: TradingDayDragonTigerData = {
  tradeDate: '2026-10-20',
  generatedAt: '2026-10-20T15:05:00+08:00',
  status: 'complete',
  entries: Array.from({ length: 14 }, (_, index) => ({
    code: `3000${String(index).padStart(2, '0')}`,
    name: `龙虎股${index + 1}`,
    reason: '日涨幅偏离值达 7%',
    netBuy: 100_000_000 + index,
    changePct: 9.98,
    turnoverRate: 12,
  })),
  sources: [],
}

const analysisData: TradingDayAnalysisData = {
  tradeDate: '2026-10-20',
  generatedAt: '2026-10-20T15:06:00+08:00',
  status: 'complete',
  axes: [
    { key: 'emotion', label: '情绪', value: '偏强', detail: '封板率维持高位', evidence: ['封板率 85.7%'], missing: [] },
    { key: 'cycle', label: '周期', value: '中段', detail: '主线仍在发酵', evidence: ['最高 6 板'], missing: [] },
    { key: 'mainline', label: '主线', value: '算力', detail: '宽度与高度同步', evidence: ['20 家'], missing: [] },
    { key: 'risk', label: '风险', value: '中', detail: '注意高位分歧', evidence: [], missing: ['融资余额更新滞后'] },
  ],
  mainlines: [
    { name: '算力', grade: 'A', score: 88, stage: '主升', height: 6, width: 20, depth: 3, evidence: ['龙头 6 板'], missing: [] },
  ],
  leaders: [{ code: '600001', name: '龙头甲', role: 'leader', boardCount: 6, rs5: 12, rs20: 30, marketCap: 10_000_000_000, note: '空间板' }],
  centerCandidates: [{ code: '600002', name: '中军乙', role: 'center', boardCount: 2, rs5: 8, rs20: 15, marketCap: 50_000_000_000, note: '' }],
  roles: [],
  verdict: { stage: '发酵', position: '中段', temperature: '偏热', confidence: .72, summary: '情绪偏强，主线明确，注意高位分歧。', gaps: ['融资余额滞后'] },
  scenarios: [
    { kind: 'above', title: '高开加速', trigger: '高度板高开且封单放大', response: '持股或加仓主线龙头' },
    { kind: 'match', title: '分化轮动', trigger: '高度板分歧但主线仍在', response: '去弱留强，关注补涨' },
    { kind: 'below', title: '退潮回踩', trigger: '高度板放量炸板', response: '降低仓位，等待冰点' },
  ],
  coverage: { analyzed: 4, total: 4, skipped: 0 },
  missingReasons: [],
  sources: [],
}

const snapshotDashboard: DashboardData = {
  ...dashboard,
  overview: {
    ...dashboard.overview,
    indices: dashboard.overview.indices.map(index => index.code === '000001' ? { ...index, name: '快照上证指数' } : index),
  },
}

const snapshotContext: TradingDayContextData = {
  ...contextData,
  tradeDate: '2026-10-17',
  generatedAt: '2026-10-17T15:05:00+08:00',
}

const snapshotPools: TradingDayLimitPoolsData = {
  ...limitPoolsData,
  tradeDate: '2026-10-17',
  ladder: [{ board: 6, label: '6 板', count: 1, stocks: [{ ...ladderStock(1), name: '快照梯队股' }] }],
}

const snapshotRecord: TradingDaySnapshotRecord = {
  tradeDate: '2026-10-17',
  capturedAt: '2026-10-17T15:10:00+08:00',
  status: 'complete',
  schemaVersion: 1,
  payload: {
    context: snapshotContext,
    limitPools: snapshotPools,
    themes: themesData,
    dragonTiger: dragonTigerData,
    analysis: analysisData,
    dashboard: snapshotDashboard,
  },
}

const snapshots = [
  { tradeDate: '2026-10-17', capturedAt: '2026-10-17T15:10:00+08:00', status: 'complete' as const },
]

type CallOverride = (request: unknown, signal?: AbortSignal) => unknown | Promise<unknown>

describe('trading day section', () => {
  it('renders every live group and keeps the review drawer collapsed by default', async () => {
    renderAt()
    await screen.findByRole('heading', { name: '今日交易数据' })

    const verdict = screen.getByRole('article', { name: '短线交易数据结论' })
    expect(within(verdict).getByText('短线交易数据结论')).not.toBeNull()
    expect(within(verdict).getByText('发酵')).not.toBeNull()
    expect(within(verdict).getByText('中段')).not.toBeNull()
    expect(within(verdict).getByText('偏热')).not.toBeNull()
    expect(within(verdict).getByText('72%')).not.toBeNull()
    expect(screen.getByRole('article', { name: '指数分时' })).not.toBeNull()
    expect(screen.getByLabelText('指数分时走势图')).not.toBeNull()
    expect(screen.queryByRole('heading', { name: '成交额对比与沪市融资余额' })).toBeNull()
    for (const title of ['情绪指标', '涨停梯队', '题材驱动', '晋级率', '昨日涨停表现']) {
      expect(screen.getByRole('heading', { name: title })).not.toBeNull()
    }

    const review = screen.getByRole('article', { name: '复盘分析' })
    const details = review.querySelector('details')
    expect(details?.open).toBe(false)
    fireEvent.click(within(review).getByText('复盘分析'))
    expect(details?.open).toBe(true)
    expect(within(review).getByText('四轴')).not.toBeNull()
    expect(within(review).getByText('主线分级')).not.toBeNull()
    expect(within(review).getByText('角色梯队')).not.toBeNull()
    expect(within(review).getByRole('heading', { name: '中军', level: 5 })).not.toBeNull()
    expect(within(review).getByRole('heading', { name: /龙虎榜/ })).not.toBeNull()
    expect(within(review).getByText('次日三套剧本')).not.toBeNull()
    expect(within(review).getByText('强于预期')).not.toBeNull()
  })

  it('renders the saved snapshot without issuing live requests after switching dates', async () => {
    const client = makeClient()
    renderAt(client)
    await screen.findByText('封板率')
    expect(screen.getByText('已保存 1 天')).not.toBeNull()

    const liveCalls = callCount(client, 'tradingDay.context')
    fireEvent.change(screen.getByRole('combobox', { name: '交易日选择' }), { target: { value: '2026-10-17' } })

    await screen.findByText('快照上证指数')
    expect(screen.getByText(/历史快照 · 保存于/)).not.toBeNull()
    expect(screen.getByText('快照梯队股')).not.toBeNull()
    expect(screen.getByRole('button', { name: '回到今日' })).not.toBeNull()
    expect(client.call).toHaveBeenCalledWith('tradingDay.snapshot', { date: '2026-10-17' })
    expect(callCount(client, 'tradingDay.context')).toBe(liveCalls)
    expect(callCount(client, 'tradingDay.snapshot')).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: '回到今日' }))
    await screen.findByText('封板率')
    expect(screen.getByRole('combobox', { name: '交易日选择' })).not.toBeNull()
  })

  it('shows an unavailable retry for a failed group while other blocks keep rendering', async () => {
    const client = makeClient({
      'tradingDay.limitPools': () => { throw new Error('限价池数据源不可用') },
    })
    renderAt(client)

    const ladder = await screen.findByRole('article', { name: '涨停梯队' })
    await within(ladder).findByText('不可用')
    expect(within(ladder).getByText('限价池数据源不可用')).not.toBeNull()
    expect(within(ladder).getByRole('button', { name: '重试' })).not.toBeNull()

    const sentiment = screen.getByRole('article', { name: '情绪指标' })
    expect(within(sentiment).getByText('不可用')).not.toBeNull()

    expect(screen.getByRole('article', { name: '指数分时' }).textContent).toContain('上证指数')
    expect(screen.getByRole('article', { name: '题材驱动' })).not.toBeNull()
    expect(screen.getByRole('region', { name: '龙虎榜' })).not.toBeNull()
    expect(screen.getByText('发酵')).not.toBeNull()
  })

  it('caps the ladder at 10 per board, themes at 8 with 3 leaders, and LHB at 20', async () => {
    renderAt()
    await screen.findByRole('heading', { name: '今日交易数据' })

    const ladder = screen.getByRole('article', { name: '涨停梯队' })
    expect(within(ladder).getAllByText(/^梯队股/)).toHaveLength(10)

    const themes = screen.getByRole('article', { name: '题材驱动' })
    expect(within(themes).getAllByRole('listitem')).toHaveLength(8)
    expect(within(themes).queryByText('题材9')).toBeNull()
    expect(within(themes).queryByText(/题材1龙头丁/)).toBeNull()
    expect(within(themes).getByText(/题材1龙头甲/)).not.toBeNull()

    const dragon = screen.getByRole('region', { name: '龙虎榜' })
    expect(within(dragon).getAllByRole('row')).toHaveLength(15)
    expect(within(dragon).getByText('龙虎股13')).not.toBeNull()
  })

  it('merges concurrent analysis requests instead of re-running them', async () => {
    let release: ((value: unknown) => void) | undefined
    let analyzeCalls = 0
    const client = makeClient({
      'tradingDay.analyze': () => {
        analyzeCalls += 1
        if (analyzeCalls === 1) {
          return new Promise((resolve) => {
            release = resolve
          })
        }
        return analysisData
      },
    })
    renderAt(client)
    await flush()
    expect(analyzeCalls).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await flush()
    expect(analyzeCalls).toBe(1)

    await act(async () => {
      release?.(analysisData)
      await Promise.resolve()
    })
    await flush()
    expect(analyzeCalls).toBe(1)
    expect(screen.getByText('发酵')).not.toBeNull()
  })

  it('polls the fast groups with save:false and never re-runs analysis on the timer', async () => {
    vi.useFakeTimers()
    // 固定到 2026-10-23（周五）10:00 北京时间，自动刷新只在开市时段生效。
    vi.setSystemTime(new Date('2026-10-23T02:00:00Z'))
    const client = makeClient()
    renderAt(client)
    await flush()

    expect(callCount(client, 'tradingDay.analyze')).toBe(1)
    expect(callCount(client, 'tradingDay.context')).toBe(1)
    expect(calls(client).some(([endpoint, request]) => endpoint === 'tradingDay.analyze' && (request as { save: boolean }).save === true)).toBe(true)

    const before = calls(client).length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    const polled = calls(client).slice(before)
    expect(polled.some(([endpoint]) => endpoint === 'dashboard.get')).toBe(true)
    expect(polled.some(([endpoint, request]) => endpoint === 'tradingDay.context' && (request as { save: boolean }).save === false)).toBe(true)
    expect(polled.some(([endpoint, request]) => endpoint === 'tradingDay.limitPools' && (request as { save: boolean }).save === false)).toBe(true)
    expect(polled.some(([endpoint]) => endpoint === 'tradingDay.analyze')).toBe(false)
  })

  it('limits manual refresh to once per minute while the market is open', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-23T02:00:00Z'))
    const client = makeClient()
    renderAt(client)
    await flush()

    const refreshButton = (): HTMLButtonElement =>
      screen.getByRole('button', { name: /刷新/ }) as HTMLButtonElement
    fireEvent.click(refreshButton())
    await flush()

    const afterFirst = calls(client).length
    expect(afterFirst).toBeGreaterThan(0)
    expect(refreshButton().disabled).toBe(true)
    expect(refreshButton().textContent).toContain('60s')

    fireEvent.click(refreshButton())
    await flush()
    expect(calls(client).length).toBe(afterFirst)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(refreshButton().disabled).toBe(false)
  })

  it('builds the intraday chart over the elapsed clock times only', () => {
    const option = buildIntradayOption(contextData.trend, getChartPalette('dark'))
    expect(option).not.toBeNull()
    const axes = option?.xAxis as Array<Record<string, unknown>>
    expect(axes).toHaveLength(2)
    for (const axis of axes) {
      expect(axis).toMatchObject({ type: 'category', data: ['09:30', '10:00'], boundaryGap: false })
    }
    const tooltip = option?.tooltip as { formatter: (params: unknown) => string }
    const html = tooltip.formatter([{ dataIndex: 1 }])
    expect(html).toContain('10:00')
    expect(html).toContain('3,510.00')
    expect(html).toContain('3,505.00')
  })
})

function renderAt(client = makeClient()): { client: HanaiClient } {
  return {
    client,
    ...render(<HanaiWorkbench client={client} initialPath="/dashboard" />),
  }
}

function makeClient(overrides: Record<string, CallOverride> = {}): HanaiClient {
  const call = vi.fn(async (endpoint: string, request?: unknown, signal?: AbortSignal) => {
    const override = overrides[endpoint]
    if (override !== undefined) return override(request, signal)
    switch (endpoint) {
      case 'bootstrap': return bootstrap
      case 'dashboard.get': return dashboard
      case 'tradingDay.context': return contextData
      case 'tradingDay.limitPools': return limitPoolsData
      case 'tradingDay.themes': return themesData
      case 'tradingDay.dragonTiger': return dragonTigerData
      case 'tradingDay.analyze': return analysisData
      case 'tradingDay.snapshots': return { snapshots }
      case 'tradingDay.snapshot': return snapshotRecord
      case 'sector.stocks': return { stocks: [], meta: fresh }
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

function callCount(client: HanaiClient, endpoint: string): number {
  return calls(client).filter(([called]) => called === endpoint).length
}

function calls(client: HanaiClient): Array<[string, unknown]> {
  return (client.call as unknown as ReturnType<typeof vi.fn>).mock.calls as unknown as Array<[string, unknown]>
}

async function flush(times = 40): Promise<void> {
  await act(async () => {
    for (let index = 0; index < times; index += 1) await Promise.resolve()
  })
}
