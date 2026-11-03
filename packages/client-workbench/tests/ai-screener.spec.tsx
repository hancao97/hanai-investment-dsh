// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ExpertChat, WatchGroup } from '../../contracts/src/index.ts'
import type { ScreeningRun } from '../../contracts/src/ai-screener.ts'
import { DEFAULT_SCAN_QUERY } from '../../contracts/src/market-scan.ts'
import { AiScreenerPage } from '../src/ai-screener.tsx'
import type { HanaiClient } from '../src/api.ts'

vi.mock('../../client-chat/src/index.tsx', () => ({ ChatPanel: () => <div>原生解析对话与审批</div> }))
const chat: ExpertChat = { id: 'r1', title: 'ROE不低于15%的银行股', masterId: 'ai-stock-screener', masterName: 'AI选股', masterVersion: '1', dshSessionId: 'session-r1', turnStatus: 'idle', modelProvider: null, model: null, reasoningEffort: null, createdAt: '2026-10-30T02:00:00Z', updatedAt: '2026-10-30T02:00:00Z', errorCode: null, errorMessage: null }
const groups: WatchGroup[] = [{ id: 'default', name: '我的自选', isDefault: true, secIds: [], items: [] }]
const query = { ...DEFAULT_SCAN_QUERY, industries: ['银行'], ranges: { roe: { min: 15 } } }
const run: ScreeningRun = { question: chat.title, status: 'ready', plan: { question: chat.title, interpretation: '银行行业，按ROE筛选', query, assumptions: [], unsupported: [] }, result: { historical: false, error: null, data: { query, total: 1, stocks: [{ secId: '1.600000', code: '600000', name: '测试银行', price: 10, changePct: 1, industry: '银行', pe: 12, pb: null, roe: 15, grossMargin: null, netMargin: 10, marketCap: 100, dividendYield: 0, netInflow5d: 0, revenueGrowth: null, profitGrowth: 1 }], snapshotDate: '2026-10-30', collectedOn: '2026-10-30', meta: { providerId: 'test', sourceName: '测试汇总', sourceTimestamp: '2026-10-30', fetchedAt: '2026-10-30T02:00:00Z', cacheState: 'fresh' } } }, error: null, startedAt: '2026-10-30T02:00:00Z', finishedAt: '2026-10-30T02:01:00Z' }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T10:00:00+08:00')) })
afterEach(() => { cleanup(); vi.useRealTimers() })
function setup(selectedId: string | null = null, overrides: Record<string, (...args: any[]) => unknown> = {}) {
  const call = vi.fn(async (endpoint: string, payload: any, signal?: AbortSignal) => {
    if (overrides[endpoint]) return overrides[endpoint]!(payload, signal)
    if (endpoint === 'screener.list') return [chat]
    if (endpoint === 'screener.create') return chat
    if (endpoint === 'screener.result' || endpoint === 'screener.execute') return run
    if (endpoint === 'screener.remove') return []
    if (endpoint === 'watch.item.add') return groups
    throw new Error(endpoint)
  })
  const client = { call, models: vi.fn(async () => [{ id: 'provider', name: '模型组', models: [{ id: 'model', name: '模型' }] }]) } as unknown as HanaiClient
  const onOpen = vi.fn(), onHome = vi.fn(), onStock = vi.fn(), onGroups = vi.fn()
  const props = { client, onOpen, onHome, onStock, groups, onGroups }
  const view = render(<AiScreenerPage {...props} selectedId={selectedId} />)
  return { call, onOpen, onHome, onStock, onGroups, select: (id: string | null) => view.rerender(<AiScreenerPage {...props} selectedId={id} />) }
}
it('fills editable starters and creates a DSH parsing task with the selected model', async () => {
  const view = setup(); await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: '市值与 ROE' }))
  expect((screen.getByLabelText('AI选股问题') as HTMLTextAreaElement).value).toContain('100 亿元')
  expect(view.call.mock.calls.some(([key]) => key === 'screener.create')).toBe(false)
  fireEvent.change(screen.getByLabelText('AI选股模型'), { target: { value: 'provider\0model' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '开始选股' })) })
  expect(view.call).toHaveBeenCalledWith('screener.create', expect.objectContaining({ model: { provider: 'provider', model: 'model' } }))
  expect(view.onOpen).toHaveBeenCalledWith('r1')
})
it('shows source-backed cards and coverage and only adds to watch after the user clicks', async () => {
  const view = setup('r1'); await act(async () => {})
  expect(screen.getByRole('heading', { name: '测试银行' })).not.toBeNull()
  expect(screen.getByText(/已核实条件命中 1 只/)).not.toBeNull()
  expect(screen.getByText(/字段覆盖/).textContent).toContain('ROE 1/1')
  expect(view.call.mock.calls.some(([key]) => key === 'watch.item.add')).toBe(false)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '加入当前自选' })) })
  expect(view.call).toHaveBeenCalledWith('watch.item.add', { groupId: 'default', secId: '1.600000' })
  expect(view.onGroups).toHaveBeenCalledWith(groups)
  fireEvent.click(screen.getByRole('button', { name: '查看当前K线与详情' })); expect(view.onStock).toHaveBeenCalledWith(expect.objectContaining({ secId: '1.600000' }))
})
it('keeps unsupported requirements visible and waits for explicit confirmation', async () => {
  const pending = { ...run, status: 'needs-confirmation', result: null, plan: { ...run.plan!, assumptions: ['低估值暂按PE≤20'], unsupported: ['连续季度改善未覆盖'] } }
  const view = setup('r1', { 'screener.result': () => pending }); await act(async () => {})
  expect(screen.getByText('连续季度改善未覆盖')).not.toBeNull()
  expect(screen.queryByRole('heading', { name: '测试银行' })).toBeNull()
  expect(view.call.mock.calls.some(([key]) => key === 'screener.execute')).toBe(false)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认上述口径，仅执行可用条件' })) })
  expect(view.call).toHaveBeenCalledWith('screener.execute', { id: 'r1' })
})
it('polls pending parsing tasks but stops result polling after completion', async () => {
  let count = 0
  const view = setup('r1', { 'screener.result': () => ++count === 1 ? { ...run, status: 'parsing', plan: null, result: null } : run }); await act(async () => {})
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  expect(screen.getByRole('heading', { name: '测试银行' })).not.toBeNull()
  const done = view.call.mock.calls.filter(([key]) => key === 'screener.result').length
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(view.call.mock.calls.filter(([key]) => key === 'screener.result')).toHaveLength(done)
})
it('ignores a late result after switching to a different history record', async () => {
  let release: (value: unknown) => void = () => {}
  let signal: AbortSignal | undefined
  const view = setup('r1', { 'screener.result': (payload, request) => payload.id === 'r1' ? (signal = request, new Promise(resolve => { release = resolve })) : null }); await act(async () => {})
  await act(async () => { view.select('r2') })
  expect(signal?.aborted).toBe(true)
  await act(async () => { release(run) })
  expect(screen.queryByRole('heading', { name: '测试银行' })).toBeNull()
})
it('preserves the question after a create failure and requires confirmation before deletion', async () => {
  const view = setup(null, { 'screener.create': () => { throw new Error('model offline') } }); await act(async () => {})
  fireEvent.change(screen.getByLabelText('AI选股问题'), { target: { value: 'ROE不低于15%' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '开始选股' })) })
  expect((screen.getByLabelText('AI选股问题') as HTMLTextAreaElement).value).toBe('ROE不低于15%')
  fireEvent.click(screen.getByRole('button', { name: `删除查询：${chat.title}` }))
  expect(view.call.mock.calls.some(([key]) => key === 'screener.remove')).toBe(false)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认删除' })) })
  expect(view.call).toHaveBeenCalledWith('screener.remove', { id: 'r1' })
})

it('retries failed parsing with the original question and model, keeps the draft and prevents duplicate requests', async () => {
  let release!: (value: ExpertChat) => void
  const original = { ...chat, modelProvider: 'original-provider', model: 'original-model', reasoningEffort: 'high' }
  const view = setup('r1', {
    'screener.list': () => [original],
    'screener.result': () => ({ ...run, status: 'failed', plan: null, result: null, error: '解析回合未完成：error' }),
    'screener.create': () => new Promise(resolve => { release = resolve }),
  })
  await act(async () => {})
  fireEvent.change(screen.getByLabelText('AI选股问题'), { target: { value: '尚未提交的新问题' } })
  fireEvent.change(screen.getByLabelText('AI选股模型'), { target: { value: 'provider\0model' } })
  const retry = screen.getByRole('button', { name: '重试解析' })
  await act(async () => { fireEvent.click(retry); fireEvent.click(retry) })
  expect(view.call.mock.calls.filter(([key]) => key === 'screener.create')).toHaveLength(1)
  expect(view.call).toHaveBeenCalledWith('screener.create', {
    openingMessage: run.question,
    model: { provider: 'original-provider', model: 'original-model', reasoningEffort: 'high' },
  })
  expect(screen.getByRole('button', { name: '正在重试…' }).hasAttribute('disabled')).toBe(true)
  await act(async () => { release({ ...original, id: 'retry-r1' }) })
  expect(view.onOpen).toHaveBeenCalledWith('retry-r1')
  expect((screen.getByLabelText('AI选股问题') as HTMLTextAreaElement).value).toBe('尚未提交的新问题')
  expect(screen.getAllByRole('button', { name: `删除查询：${chat.title}` })).toHaveLength(2)
  expect(view.call.mock.calls.some(([key]) => key === 'screener.execute' || key === 'screener.remove')).toBe(false)
})

it('keeps a failed parsing record retryable when creation fails, without using the unrelated composer model', async () => {
  const view = setup('r1', {
    'screener.result': () => ({ ...run, status: 'failed', plan: null, result: null, error: '解析失败' }),
    'screener.create': () => { throw new Error('model offline') },
  })
  await act(async () => {})
  fireEvent.change(screen.getByLabelText('AI选股模型'), { target: { value: 'provider\0model' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试解析' })) })
  expect(view.call).toHaveBeenCalledWith('screener.create', { openingMessage: run.question })
  expect(screen.getAllByRole('alert').some(node => node.textContent?.includes('model offline'))).toBe(true)
  expect(screen.getByRole('button', { name: '重试解析' }).hasAttribute('disabled')).toBe(false)
  expect(view.onOpen).not.toHaveBeenCalled()
})

it('retries candidate retrieval from a failed validated plan without creating another parsing task', async () => {
  const view = setup('r1', { 'screener.result': () => ({ ...run, status: 'failed', error: '扫描失败' }) })
  await act(async () => {})
  expect(screen.queryByRole('button', { name: '重试解析' })).toBeNull()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试候选查询' })) })
  expect(view.call).toHaveBeenCalledWith('screener.execute', { id: 'r1' })
  expect(view.call.mock.calls.some(([key]) => key === 'screener.create')).toBe(false)
})

it('does not reopen a retry after the user has left its history record', async () => {
  let release!: (value: ExpertChat) => void
  const view = setup('r1', {
    'screener.result': () => ({ ...run, status: 'failed', plan: null, result: null }),
    'screener.create': () => new Promise(resolve => { release = resolve }),
  })
  await act(async () => {})
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试解析' })) })
  await act(async () => { view.select(null) })
  await act(async () => { release({ ...chat, id: 'retry-r1' }) })
  expect(view.onOpen).not.toHaveBeenCalled()
})

it('displays the AI-generated formula, requires confirmation, and renders persistent progress and per-stock evidence', async () => {
  const formula = { match: 'all' as const, adjust: 'qfq' as const, rules: [{ kind: 'ma-cross' as const, short: 5, long: 20, direction: 'up' as const, within: 3 }] }
  let current = { ...run, status: 'needs-confirmation' as ScreeningRun['status'], plan: { ...run.plan!, technical: formula, query: DEFAULT_SCAN_QUERY, assumptions: ['最近3日是建议窗口，请确认'] }, result: null as ScreeningRun['result'] }
  const progress = { phase: 'finished' as const, asOf: '2026-10-29', catalogueDate: '2026-10-30', total: 5574, checked: 5574, matched: 1, unverified: 2, samples: [{ code: '600001', reason: '历史缺失' }], evidence: { '600000': [{ formula: 'MA5上穿MA20', matched: true, detail: '交叉日期2026-10-29' }] } }
  const view = setup('r1', { 'screener.result': () => current, 'screener.execute': () => { current = { ...current, status: 'ready', result: run.result, progress } as typeof current; return current } })
  await act(async () => {})
  expect(screen.getByText(/最近3个交易日内MA5上穿MA20/)).not.toBeNull()
  expect(view.call.mock.calls.some(([key]) => key === 'screener.execute')).toBe(false)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认公式并后台扫描' })) })
  expect(view.call).toHaveBeenCalledWith('screener.execute', { id: 'r1' })
  expect(screen.getByText(/已检查 5574\/5574/)).not.toBeNull()
  expect(screen.getByText(/MA5上穿MA20：满足；交叉日期2026-10-29/)).not.toBeNull()
  expect(screen.getByText(/600001：历史缺失/)).not.toBeNull()
  expect(screen.getByText('本地快照价 · 2026-10-30')).not.toBeNull()
  expect(screen.getByText('未附加财务或行业条件')).not.toBeNull()
})
