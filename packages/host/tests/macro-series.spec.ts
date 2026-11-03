import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MacroSeries } from '../src/macro-series.ts'
import { MarketHistoryStore } from '../../domain/src/market-history.ts'
import { MACRO_ETFS } from '../../contracts/src/market-macro.ts'
import type { MacroRange } from '../../contracts/src/macro-range.ts'
import { defaultMacroRange } from '../../contracts/src/macro-range.ts'
import type { MarketFacade } from '../src/service.ts'

const disposables: Array<() => void> = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-29T20:00:00+08:00')) })
afterEach(() => { disposables.reverse().forEach(dispose => dispose()); disposables.length = 0; vi.useRealTimers() })
const range = { from: '2019-10-08', to: '2019-10-09' }
function setup() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE market_panel_snapshots(date TEXT, panel_key TEXT, version INTEGER, captured_at TEXT, observed_at TEXT, payload TEXT, meta TEXT, PRIMARY KEY(date,panel_key))')
  disposables.push(() => db.close())
  const history = new MarketHistoryStore(db)
  const settings = new Map<string, string>()
  const dates = (range: MacroRange) => [...new Set([range.from, range.to])]
  const meta = (range: MacroRange) => ({ providerId: 'test', sourceName: '公开来源', sourceTimestamp: range.to, fetchedAt: new Date().toISOString(), cacheState: 'fresh' as const })
  const market = {
    getMacroInputs: () => null,
    getMacroIndex: vi.fn(async (range: MacroRange) => ({ points: dates(range).map(date => ({ date, close: 4000 })), meta: meta(range) })),
    getMacroDaily: vi.fn(async (_previous, _inputs, range: MacroRange) => ({ points: dates(range).map(date => ({ date, assets: 100 })), expectedDays: dates(range).length, complete: true, meta: meta(range) })),
    getMacroCapital: vi.fn(async (_previous, _retry, range: MacroRange) => ({ points: dates(range).map(date => ({ date, floatCap: 500000 })), checkedMonths: [...new Set(dates(range).map(date => date.slice(0, 7).replace('-', '')))], complete: true, meta: meta(range) })),
    getMacroAllDaily: vi.fn(async (_previous, _inputs, _retry, range: MacroRange) => ({ funds: MACRO_ETFS.map(fund => ({ ...fund, listedOn: '2012-01-01' })), universeAsOf: new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10), points: dates(range).map(date => ({ date, assets: 120, fourAssets: 100, otherAssets: 20 })), expectedDays: dates(range).length, missingDates: [], complete: true, meta: meta(range) })),
    getMacroAllEtfs: vi.fn(async () => null), getMacroEtfs: vi.fn(async () => null),
  } satisfies Partial<MarketFacade>
  const create = () => {
    const series = new MacroSeries(market as unknown as MarketFacade, history, { getSetting: key => settings.get(key) ?? null, setSetting: (key, value) => { settings.set(key, value) } })
    disposables.push(() => series.dispose())
    return series
  }
  return { history, settings, market, create }
}

it('persists different old windows, deduplicates requests and displays cache after a new Host instance', async () => {
  const { create, history, market } = setup()
  const series = create()
  expect(series.query(range).task.state).toBe('running')
  series.query(range)
  await vi.waitFor(() => expect(series.query(range).task.state).not.toBe('running'))
  expect(market.getMacroIndex).toHaveBeenCalledTimes(1)
  expect(series.query(range).data.allDaily?.points).toHaveLength(2)
  expect(series.query(range).taskRange).toEqual(range)
  const older = { from: '2018-10-08', to: '2018-10-09' }
  series.query(older)
  await vi.waitFor(() => expect(series.query(older).task.state).not.toBe('running'))
  series.dispose()
  const restored = create()
  expect(restored.query(range).data.daily?.points[0]?.date).toBe(range.from)
  expect(restored.query(older).data.daily?.points[0]?.date).toBe(older.from)
  expect(history.list().filter(row => row.panels.includes('macro.series'))).toHaveLength(2)
  expect(market.getMacroIndex).toHaveBeenCalledTimes(2)
})

it('does one nightly update, catches up on startup and retains unfinished work for restart', async () => {
  const { create, market, settings } = setup()
  const series = create()
  series.start()
  await vi.waitFor(() => expect(market.getMacroIndex).toHaveBeenCalledTimes(1))
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(market.getMacroIndex).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(24 * 3_600_000)
  expect(market.getMacroIndex).toHaveBeenCalledTimes(2)
  series.dispose()
  const pending = { from: '2017-10-09', to: '2017-10-10' }
  settings.set('macro.series.work', JSON.stringify({ slot: '2026-10-30', attempts: [], queue: [pending] }))
  const restarted = create()
  restarted.start()
  await vi.waitFor(() => expect(market.getMacroIndex).toHaveBeenCalledTimes(3))
  expect(market.getMacroIndex).toHaveBeenLastCalledWith(pending)
})

it('backs off missing sources across page visits and permits a manual retry after cooldown', async () => {
  const { create, market } = setup()
  market.getMacroIndex.mockResolvedValue(null as never)
  const series = create()
  series.query(range)
  await vi.waitFor(() => expect(series.query(range).task.state).not.toBe('running'))
  series.query(range)
  expect(market.getMacroIndex).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(60_001)
  series.query(range, true)
  await vi.waitFor(() => expect(market.getMacroIndex).toHaveBeenCalledTimes(2))
  expect(() => series.query({ from: '2010-01-01', to: '2020-01-01' })).toThrow('最长五年')
})

it('merges overlapping pending windows and completes them after the active range', async () => {
  const { create, market } = setup()
  const load = market.getMacroIndex.getMockImplementation()!
  let release!: (value: Awaited<ReturnType<typeof load>>) => void
  market.getMacroIndex.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const series = create()
  series.query(range)
  series.query({ from: '2018-10-08', to: '2018-10-09' })
  const waiting = series.query({ from: '2018-10-09', to: '2018-10-12' })
  expect(waiting.queued).toEqual([{ from: '2018-10-08', to: '2018-10-12' }])
  release(await load(range))
  await vi.waitFor(() => expect(market.getMacroIndex).toHaveBeenCalledTimes(2))
  expect(market.getMacroIndex).toHaveBeenLastCalledWith({ from: '2018-10-08', to: '2018-10-12' })
})

it('merges same-month observations instead of adding a full-window snapshot for each end date', async () => {
  const { create, history } = setup()
  const series = create()
  series.query(range)
  await vi.waitFor(() => expect(series.query(range).task.state).not.toBe('running'))
  const next = { from: range.from, to: '2019-10-10' }
  series.query(next, true)
  await vi.waitFor(() => expect(series.query(next).task.state).not.toBe('running'))
  expect(history.list().filter(row => row.panels.includes('macro.series')).map(row => row.date)).toEqual(['2019-10-01'])
  expect(series.query(next).data.daily?.points.map(row => row.date)).toEqual(['2019-10-08', '2019-10-09', '2019-10-10'])
})

it('retries an older incomplete range on the next nightly pass without another page visit', async () => {
  const { create, market } = setup()
  market.getMacroIndex.mockResolvedValue(null as never)
  const series = create()
  series.query(range)
  await vi.waitFor(() => expect(series.query(range).task.state).not.toBe('running'))
  series.start()
  await vi.advanceTimersByTimeAsync(24 * 3_600_000 + 60_000)
  expect(market.getMacroIndex.mock.calls.filter(([row]) => row.from === range.from && row.to === range.to)).toHaveLength(2)
})

it('does not accumulate full five-year retries across successive failed nightly updates', async () => {
  vi.setSystemTime(new Date('2026-10-26T20:00:00+08:00'))
  const { create, market } = setup()
  market.getMacroIndex.mockResolvedValue(null as never)
  const series = create()
  series.start()
  await vi.advanceTimersByTimeAsync(48 * 3_600_000 + 60_000)
  const longWindows = market.getMacroIndex.mock.calls.map(([range]) => range).filter(range => Date.parse(range.to) - Date.parse(range.from) > 300 * 86_400_000)
  expect(longWindows).toHaveLength(3)
  expect(new Set(longWindows.map(range => `${range.from}:${range.to}`)).size).toBe(3)
})

it('retains failed work when a just-finished manual attempt cools down the startup update', async () => {
  vi.setSystemTime(new Date('2026-10-29T19:59:40+08:00'))
  const { create, market, settings } = setup()
  market.getMacroIndex.mockResolvedValue(null as never)
  const series = create()
  const range = defaultMacroRange()
  series.query(range, true)
  await vi.waitFor(() => expect(series.status().state).not.toBe('running'))
  vi.setSystemTime(new Date('2026-10-29T20:00:00+08:00'))
  series.start()
  expect(market.getMacroIndex).toHaveBeenCalledTimes(1)
  expect(JSON.parse(settings.get('macro.series.work')!).retry).toContainEqual(range)
})
