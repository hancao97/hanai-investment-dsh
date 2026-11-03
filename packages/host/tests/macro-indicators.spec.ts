import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MacroIndicators } from '../src/macro-indicators.ts'
import { MarketHistoryStore } from '../../domain/src/market-history.ts'
import { MACRO_INDICATORS, type MacroIndicatorData, type MacroIndicatorId } from '../../contracts/src/macro-indicators.ts'
import { isMarketPanelPayload, marketHistoryPanel } from '../../contracts/src/market-history.ts'
import type { MacroRange } from '../../contracts/src/macro-range.ts'
import { selectMacroSeries } from '../../contracts/src/macro-series.ts'

const range = { from: '2026-08-01', to: '2026-09-30' }
const cleanups: Array<() => void> = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-29T20:00:00+08:00')) })
afterEach(() => { cleanups.reverse().forEach(fn => fn()); cleanups.length = 0; vi.useRealTimers() })
function setup() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE market_panel_snapshots(date TEXT, panel_key TEXT, version INTEGER, captured_at TEXT, observed_at TEXT, payload TEXT, meta TEXT, PRIMARY KEY(date,panel_key))')
  cleanups.push(() => db.close())
  const history = new MarketHistoryStore(db)
  const settings = new Map<string, string>()
  const load = vi.fn(async (id: MacroIndicatorId, range: MacroRange): Promise<MacroIndicatorData> => {
    const definition = MACRO_INDICATORS.find(row => row.id === id)!
    const dates: string[] = []
    const cursor = new Date(`${range.from.slice(0, 7)}-01T00:00:00Z`)
    while (cursor.toISOString().slice(0, 7) <= range.to.slice(0, 7)) {
      const date = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)
      if (date >= range.from && date <= range.to) dates.push(date)
      cursor.setUTCMonth(cursor.getUTCMonth() + 1)
    }
    return { id, checkedRange: range, points: (definition.frequency === 'daily' ? [range.to] : dates).map(date => ({ date, values: Object.fromEntries(definition.columns.map(column => [column.key, 5])) })), meta: { providerId: 'test', sourceName: '真实来源夹具', sourceTimestamp: range.to, fetchedAt: new Date().toISOString(), cacheState: 'fresh' } }
  })
  const create = () => {
    const worker = new MacroIndicators(load, history, { getSetting: key => settings.get(key) ?? null, setSetting: (key, value) => { settings.set(key, value) } })
    cleanups.push(() => worker.dispose())
    return worker
  }
  return { create, history, settings, load }
}
it('requests one year for breadth while returning only the selected display range', async () => {
  const { create, load } = setup()
  const worker = create()
  const shown = { from: '2026-08-01', to: '2026-10-29' }
  worker.query('breadth', shown)
  expect(load).toHaveBeenCalledWith('arms', { from: '2025-10-29', to: '2026-10-29' }, expect.any(AbortSignal))
  await vi.waitFor(() => expect(worker.query('breadth', shown).running).toBe(false))
  expect(worker.query('breadth', shown).data.arms?.points[0]?.date).toBe('2026-10-29')
})
it('saves all independent indicators in canonical monthly buckets and restores cache in a new Host', async () => {
  const { create, load, history } = setup()
  const worker = create()
  expect(worker.query('credit', range).running).toBe(true)
  worker.query('credit', range)
  await vi.waitFor(() => expect(worker.query('credit', range).running).toBe(false))
  expect(load).toHaveBeenCalledTimes(3)
  const bucket = marketHistoryPanel(history.get('2026-09-01'), 'macro.series')!
  expect(Object.keys(bucket.indicators!)).toEqual(expect.arrayContaining(['social', 'loans', 'money']))
  expect(isMarketPanelPayload('macro.series', bucket)).toBe(true)
  worker.dispose()
  expect(create().query('credit', range).data.money?.points).toHaveLength(2)
  expect(load).toHaveBeenCalledTimes(3)
  const { indicators: _indicators, ...legacy } = bucket
  const etf = { ...legacy, daily: { points: [{ date: range.to, assets: 100 }], expectedDays: 1, complete: true, meta: bucket.meta } }
  const merged = selectMacroSeries([bucket, etf], range)
  expect(merged.indicators?.money?.points).toHaveLength(1)
  expect(merged.daily?.points).toHaveLength(1)
})
it('one failed indicator preserves old data, completes others and backs off across reopenings', async () => {
  const { create, load } = setup()
  const worker = create()
  worker.query('credit', range)
  await vi.waitFor(() => expect(worker.query('credit', range).running).toBe(false))
  const old = worker.query('credit', range).data.social
  const original = load.getMockImplementation()!
  load.mockImplementation(async (id, range) => { if (id === 'social') throw new Error('source down'); return original(id, range) })
  await vi.advanceTimersByTimeAsync(60_001)
  worker.query('credit', range, true)
  await vi.waitFor(() => expect(worker.query('credit', range).running).toBe(false))
  expect(worker.query('credit', range).data.social).toEqual(old)
  expect(worker.query('credit', range).tasks.find(task => task.id === 'social')?.state).toBe('failed')
  expect(worker.query('credit', range).tasks.find(task => task.id === 'money')?.state).toBe('completed')
  const count = load.mock.calls.length
  worker.query('credit', range, true)
  expect(load).toHaveBeenCalledTimes(count)
  worker.dispose()
  const restored = create()
  restored.query('credit', range)
  expect(load).toHaveBeenCalledTimes(count)
  await vi.advanceTimersByTimeAsync(6 * 3_600_000)
  restored.tick('2026-10-29')
  await vi.waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(count))
})
it('resumes a persistent queue and isolates current-range task errors', async () => {
  const { create, settings, load } = setup()
  settings.set('macro.indicators.work', JSON.stringify({ slot: '2026-10-29', queue: [{ topic: 'activity', range }], attempts: [] }))
  const worker = create()
  worker.tick('2026-10-29')
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3))
  await vi.waitFor(() => expect(worker.query('activity', range).running).toBe(false))
  expect(worker.query('prices', range).tasks.every(task => !['pmi', 'industry', 'retail'].includes(task.id))).toBe(true)
})
it('rejects corrupt stored indicator fields and unknown IDs without dropping other valid panels', () => {
  const meta = { providerId: 'test', sourceName: 'test', sourceTimestamp: null, fetchedAt: new Date().toISOString(), cacheState: 'fresh' as const }
  const base = { range, etfs: null, index: null, daily: null, capital: null, allEtfs: null, allDaily: null, meta }
  expect(isMarketPanelPayload('macro.series', base)).toBe(true)
  expect(isMarketPanelPayload('macro.series', { ...base, indicators: { pmi: { id: 'pmi', checkedRange: range, meta, points: [{ date: range.to, values: { manufacturing: 50, nonManufacturing: 'bad' } }] } } })).toBe(false)
  expect(isMarketPanelPayload('macro.series', { ...base, indicators: { unknown: {} } })).toBe(false)
})
it('does one daily catch-up for all themes and resumes unfinished work after disposal', async () => {
  const { create, load, settings } = setup()
  const original = load.getMockImplementation()!
  let release!: () => void
  load.mockImplementationOnce(async (id, range) => { await new Promise<void>(resolve => { release = resolve }); return original(id, range) })
  const worker = create()
  worker.tick('2026-10-28')
  expect(load).toHaveBeenCalledTimes(3)
  const saved = JSON.parse(settings.get('macro.indicators.work')!)
  expect(saved.queue.map((work: { topic: string }) => work.topic)).toEqual(['credit', 'activity', 'prices', 'breadth'])
  worker.tick('2026-10-28')
  expect(JSON.parse(settings.get('macro.indicators.work')!).queue).toHaveLength(4)
  worker.dispose(); release()
  await vi.advanceTimersByTimeAsync(1)
  const restarted = create()
  restarted.tick('2026-10-28')
  await vi.waitFor(() => expect(JSON.parse(settings.get('macro.indicators.work')!).queue).toHaveLength(0))
  const count = load.mock.calls.length
  restarted.tick('2026-10-28')
  expect(load).toHaveBeenCalledTimes(count)
  vi.setSystemTime(new Date('2026-10-30T20:00:00+08:00'))
  restarted.tick('2026-10-30')
  await vi.waitFor(() => expect(load.mock.calls.length).toBe(count + 10))
})
it('merges pending overlapping ranges, rejects oversized ranges and never cancels the active job', async () => {
  const { create, load, settings } = setup()
  const original = load.getMockImplementation()!
  let release!: () => void
  load.mockImplementationOnce(async (id, range) => { await new Promise<void>(resolve => { release = resolve }); return original(id, range) })
  const worker = create()
  worker.query('credit', range)
  worker.query('activity', { from: '2025-01-01', to: '2025-06-30' })
  worker.query('activity', { from: '2025-06-01', to: '2025-12-31' })
  const saved = JSON.parse(settings.get('macro.indicators.work')!)
  expect(saved.queue[1]).toEqual({ topic: 'activity', range: { from: '2025-01-01', to: '2025-12-31' } })
  expect(() => worker.query('prices', { from: '2010-01-01', to: '2026-01-01' })).toThrow('最长五年')
  release()
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(6))
})
it('updates rolling daily windows incrementally without skipping the interval after a short saved window', async () => {
  const { create, load } = setup()
  const worker = create()
  const initial = { from: '2021-10-29', to: '2026-10-29' }
  worker.query('credit', initial)
  await vi.waitFor(() => expect(worker.query('credit', initial).running).toBe(false))
  vi.setSystemTime(new Date('2026-10-30T20:00:00+08:00'))
  const next = { from: '2021-10-30', to: '2026-10-30' }
  worker.query('credit', next)
  await vi.waitFor(() => expect(worker.query('credit', next).running).toBe(false))
  expect(load).toHaveBeenLastCalledWith('money', { from: '2025-10-01', to: '2026-10-30' }, expect.any(AbortSignal))
  const short = { from: '2018-01-01', to: '2018-12-31' }
  worker.query('activity', short)
  await vi.waitFor(() => expect(worker.query('activity', short).running).toBe(false))
  const expanded = { from: '2018-01-01', to: '2023-01-01' }
  worker.query('activity', expanded)
  await vi.waitFor(() => expect(worker.query('activity', expanded).running).toBe(false))
  expect(load).toHaveBeenLastCalledWith('retail', { from: '2018-12-31', to: '2023-01-01' }, expect.any(AbortSignal))
})
it('persists partial historical gaps and resumes from the gap after six hours instead of the recent lookback', async () => {
  const { create, load, settings } = setup()
  settings.set('macro.indicators.work', JSON.stringify({ slot: '2026-10-29', queue: [], attempts: [] }))
  const original = load.getMockImplementation()!
  let missing = true
  load.mockImplementation(async (id, range) => {
    const data = await original(id, range)
    return id === 'money' && missing ? { ...data, points: data.points.filter(row => row.date !== '2022-03-31') } : data
  })
  const range = { from: '2021-10-29', to: '2026-10-29' }
  const worker = create()
  worker.query('credit', range)
  await vi.waitFor(() => expect(worker.query('credit', range).running).toBe(false))
  expect(worker.query('credit', range).tasks.find(row => row.id === 'money')).toMatchObject({ state: 'partial', error: expect.stringContaining('2022-03-31') })
  worker.dispose()
  const restored = create()
  const attemptAt = JSON.parse(settings.get('macro.indicators.work')!).attempts[0].at as number
  vi.setSystemTime(attemptAt + 6 * 3_600_000 - 1)
  restored.tick('2026-10-29')
  expect(load).toHaveBeenCalledTimes(3)
  missing = false
  await vi.advanceTimersByTimeAsync(1)
  restored.tick('2026-10-29')
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(6))
  expect(load).toHaveBeenLastCalledWith('money', { from: '2022-03-31', to: '2026-10-29' }, expect.any(AbortSignal))
  await vi.waitFor(() => expect(restored.query('credit', range).running).toBe(false))
  expect(restored.query('credit', range).tasks.find(row => row.id === 'money')?.state).toBe('completed')
  expect(restored.query('credit', range).data.money?.points.some(row => row.date === '2022-03-31')).toBe(true)
})
