import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MacroGeneration } from '../src/macro-generation.ts'
import { MACRO_ETFS } from '../../contracts/src/market-macro.ts'

const meta = { providerId: 'test', sourceName: '公开数据', sourceTimestamp: '2026-10-27', fetchedAt: '2026-10-28T02:00:00Z', cacheState: 'fresh' as const }
const daily = { points: [{ date: '2026-10-27', assets: 400 }], expectedDays: 1, complete: true, meta }
const all = { ...daily, funds: MACRO_ETFS.map(fund => ({ ...fund, listedOn: '2012-01-01' })), universeAsOf: '2026-10-28',
  points: [{ date: '2026-10-27', assets: 450, fourAssets: 400, otherAssets: 50 }], missingDates: [] }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-28T10:00:00+08:00')) })
afterEach(() => vi.useRealTimers())

describe('host macro background generation', () => {
  it('continues reference-day progress after all months are checked and finishes partial on real gaps', async () => {
    let calls = 0
    const reference = { points: [], checkedDates: ['2026-10-26'], missingDates: [{ date: '2026-10-26', reason: 'missing one stock' }], expectedDays: 2, complete: false, meta }
    const load = vi.fn(async (endpoint: string) => {
      if (endpoint !== 'market.macro.capital') return daily
      calls++
      return { points: [{ date: '2026-09-30', floatCap: 500000 }], checkedMonths: ['202609', '202610'], complete: calls > 1,
        reference: calls === 1 ? reference : { ...reference, checkedDates: [...reference.checkedDates, '2026-10-27'], complete: true }, meta }
    })
    const job = new MacroGeneration(load)
    job.start()
    await vi.waitFor(() => expect(job.get().state).toBe('partial'))
    expect(calls).toBe(2)
    expect(job.get().panels.find(panel => panel.endpoint === 'market.macro.capital')).toMatchObject({ state: 'partial', checked: 4, total: 4, missing: 1 })
  })
  it('reports chart snapshot write failures instead of reporting a successful generation', async () => {
    const finish = vi.fn(() => { throw new Error('snapshot write failed') })
    const job = new MacroGeneration(async () => daily, finish)
    job.start()
    await vi.waitFor(() => expect(job.get().state).toBe('partial'))
    expect(job.get().archiveError).toBe('snapshot write failed')
    expect(finish).toHaveBeenCalledTimes(1)
  })
  it('returns immediately, deduplicates starts, continues batches without a browser, then stays idle', async () => {
    let release!: (value: typeof all) => void
    let batches = 0
    const load = vi.fn(async (endpoint: string) => {
      if (endpoint !== 'market.macro.allDaily') return daily
      if (++batches === 1) return new Promise<typeof all>(resolve => { release = resolve })
      return { ...all, points: [{ date: '2026-10-26', assets: 440, fourAssets: 390, otherAssets: 50 }, ...all.points], expectedDays: 2 }
    })
    const job = new MacroGeneration(load)
    expect(job.get().state).toBe('idle')
    expect(job.start().state).toBe('running')
    expect(job.start().state).toBe('running')
    expect(batches).toBe(1)
    release({ ...all, expectedDays: 2, complete: false })
    await vi.waitFor(() => expect(job.get().state).toBe('completed'))
    expect(load.mock.calls.filter(([endpoint]) => endpoint === 'market.macro.allDaily').map(args => (args as unknown[])[1])).toEqual([true, false])
    job.start()
    expect(batches).toBe(2)
    const count = load.mock.calls.length
    await vi.advanceTimersByTimeAsync(6 * 3_600_000)
    expect(load).toHaveBeenCalledTimes(count)
    expect(job.start().state).toBe('running')
    await vi.waitFor(() => expect(job.get().state).toBe('completed'))
    expect(batches).toBe(3)
  })

  it('isolates failures, reports unresolved gaps and stops when a provider makes no progress', async () => {
    const load = vi.fn(async (endpoint: string) => {
      if (endpoint === 'market.macro.index') return null
      if (endpoint === 'market.macro.daily') return { ...daily, expectedDays: 2, complete: false }
      if (endpoint === 'market.macro.allDaily') return { ...all, expectedDays: 2, complete: false, missingDates: [{ date: '2026-10-26', reason: '缺净值' }] }
      return daily
    })
    const job = new MacroGeneration(load)
    job.start()
    await vi.waitFor(() => expect(job.get().state).toBe('partial'))
    expect(job.get().panels.find(panel => panel.endpoint === 'market.macro.allDaily')).toMatchObject({ state: 'partial', checked: 2, missing: 1 })
    expect(job.get().panels.find(panel => panel.endpoint === 'market.macro.daily')?.error).toContain('未取得更多数据')
    expect(job.get().panels.find(panel => panel.endpoint === 'market.macro.index')?.state).toBe('failed')
    expect(load.mock.calls.filter(([endpoint]) => endpoint === 'market.macro.daily')).toHaveLength(2)
  })

  it('stops scheduling further batches when the host disposes', async () => {
    const releases: Array<(value: typeof daily) => void> = []
    const load = vi.fn(() => new Promise<typeof daily>(resolve => { releases.push(resolve) }))
    const job = new MacroGeneration(load)
    job.start()
    job.dispose()
    releases.forEach(release => release({ ...daily, expectedDays: 2, complete: false }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(load).toHaveBeenCalledTimes(6)
    expect(() => job.start()).toThrow('关闭')
  })
})
