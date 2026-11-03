import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HanaiDatabase } from '../../domain/src/database.ts'
import { TechnicalHistoryStore } from '../../domain/src/technical-history.ts'
import type { TechnicalBar } from '../../contracts/src/technical-screen.ts'
import { StockDataSync } from '../src/stock-data.ts'
import { TechnicalData } from '../src/technical-data.ts'
import { SourceCircuitOpenError } from '../../domain/src/providers/source-circuit.ts'
import type { TechnicalSource } from '../src/technical-screener.ts'

const tasks: Array<StockDataSync | TechnicalData> = [], databases: HanaiDatabase[] = [], roots: string[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T20:00:00+08:00')) })
afterEach(() => {
  for (const task of tasks.splice(0)) task.dispose()
  for (const db of databases.splice(0)) db.close()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('hanai-stock-data-')) throw new Error('Unexpected cleanup target')
    rmSync(root, { recursive: true, force: true })
  }
  vi.useRealTimers()
})
const bars: TechnicalBar[] = [{ date: '2026-10-30', open: 10, high: 10, low: 10, close: 10, volume: 100 }]
function fixture(count = 3) {
  const root = mkdtempSync(join(tmpdir(), 'hanai-stock-data-')); roots.push(root)
  const db = new HanaiDatabase(join(root, 'test.sqlite')); databases.push(db)
  for (let i = 0; i < count; i++) db.sqlite.prepare('INSERT INTO security_master VALUES(?, ?, ?, ?, ?, ?, ?)')
    .run(`1.${600000 + i}`, String(600000 + i), `公司${i}`, 'SH', '', '', new Date().toISOString())
  const source: TechnicalSource = { calendar: vi.fn(async () => ['2026-10-30']), bars: vi.fn(async () => bars), pool: vi.fn(async () => null) }
  const task = new StockDataSync(db, source); tasks.push(task)
  return { db, source, task }
}

it('syncs both price bases outside page requests and reuses persisted inputs on retry', async () => {
  const { task, source, db } = fixture()
  task.request()
  await vi.waitFor(() => expect(task.status().phase).toBe('finished'))
  expect(task.status()).toMatchObject({ checked: 3, completed: 3, failed: 0, latestCompleteDate: '2026-10-30' })
  expect(source.bars).toHaveBeenCalledTimes(6)
  expect(task.status().sources).toEqual(expect.arrayContaining([expect.objectContaining({ adjustment: 'none', count: 3, newestDate: '2026-10-30' })]))
  expect(new TechnicalHistoryStore(db.sqlite).read('600000', 'none', '2026-10-30')).toEqual(bars)
  expect(() => task.request()).toThrow('冷却')
  await vi.advanceTimersByTimeAsync(60000)
  task.request()
  await vi.waitFor(() => expect(task.status().phase).toBe('finished'))
  expect(source.bars).toHaveBeenCalledTimes(6)
})

it('shows reusable windows before remote preparation and does not wait between local batches', async () => {
  const { db, source } = fixture(400)
  const history = new TechnicalHistoryStore(db.sqlite)
  for (let i = 0; i < 400; i++) for (const adjust of ['none', 'qfq'] as const) history.write(String(600000 + i), adjust, '2026-10-30', bars, 'tencent', new Date().toISOString())
  db.setSetting('stock-data.calendar', JSON.stringify({ through: '2026-10-30', dates: ['2026-10-30'] }))
  history.writeLimitPool({ date: '2026-10-30', codes: [], source: 'fixture', fetchedAt: new Date().toISOString(), scope: 'source-pool-positive-only' })
  let release!: () => void
  const refresh = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
  const task = new StockDataSync(db, source, refresh); tasks.push(task)
  const started = Date.now()
  expect(task.request()).toMatchObject({ asOf: '2026-10-30', checked: 400, completed: 400, reused: { daily: 400 } })
  release()
  await vi.waitFor(() => expect(task.status().phase).toBe('finished'))
  expect(Date.now() - started).toBeLessThan(500)
  expect(source.bars).not.toHaveBeenCalled()
  expect(source.calendar).not.toHaveBeenCalled()
  expect(source.pool).not.toHaveBeenCalled()
})

it('retains failures as retryable gaps and does not claim complete coverage', async () => {
  const { task, source } = fixture(2)
  vi.mocked(source.bars).mockImplementation(async code => { if (code === '600000') throw new Error('timeout'); return bars })
  task.request()
  await vi.waitFor(() => expect(task.status().phase).toBe('finished'))
  expect(task.status()).toMatchObject({ completed: 1, failed: 1, latestCompleteDate: null })
  expect(task.status().samples).toEqual([{ code: '600000', reason: 'timeout' }])
  await vi.advanceTimersByTimeAsync(60000)
  vi.mocked(source.bars).mockClear().mockResolvedValue(bars)
  task.request()
  await vi.waitFor(() => expect(task.status().phase).toBe('finished'))
  expect(task.status()).toMatchObject({ completed: 2, failed: 0, latestCompleteDate: '2026-10-30' })
  expect(source.bars).toHaveBeenCalledTimes(2)
})

it('queues financial gaps independently and keeps successful per-stock checks across restart', async () => {
  const { db, source } = fixture(3), history = new TechnicalHistoryStore(db.sqlite)
  for (let i = 0; i < 3; i++) for (const adjust of ['none', 'qfq'] as const) history.write(String(600000 + i), adjust, '2026-10-30', bars, 'tencent', new Date().toISOString())
  db.setSetting('stock-data.calendar', JSON.stringify({ through: '2026-10-30', dates: ['2026-10-30'] }))
  const ready = new Set(['600000', '600001'])
  const metrics = vi.fn(async (code: string) => { ready.add(code) })
  const task = new StockDataSync(db, source, undefined, metrics, () => ready); tasks.push(task)
  expect(task.request()).toMatchObject({ checked: 3, reused: { daily: 3, financial: 2 }, financial: { checked: 2, completed: 2 } })
  await vi.waitFor(() => expect(task.status().phase).toBe('finished'))
  expect(metrics).toHaveBeenCalledExactlyOnceWith('600002', expect.any(AbortSignal))
  expect(source.bars).not.toHaveBeenCalled()
  const restarted = new StockDataSync(db, source, undefined, metrics, () => ready); tasks.push(restarted)
  await vi.advanceTimersByTimeAsync(60000)
  restarted.request()
  await vi.waitFor(() => expect(restarted.status().phase).toBe('finished'))
  expect(metrics).toHaveBeenCalledTimes(1)
  expect(restarted.status().reused).toEqual({ daily: 3, financial: 3 })
})

it('requests new price bases and financial facts when the market baseline advances', async () => {
  const { db, source } = fixture(1)
  const metrics = vi.fn(async () => {})
  const task = new StockDataSync(db, source, undefined, metrics); tasks.push(task)
  await task.ensure()
  vi.setSystemTime(new Date('2026-11-02T20:00:00+08:00'))
  vi.mocked(source.calendar).mockResolvedValue(['2026-10-30', '2026-11-02'])
  vi.mocked(source.bars).mockResolvedValue([{ ...bars[0]!, date: '2026-11-02' }])
  await task.ensure()
  expect(task.status()).toMatchObject({ asOf: '2026-11-02', completed: 1, reused: { daily: 0, financial: 0 } })
  expect(source.bars).toHaveBeenCalledTimes(4)
  expect(metrics).toHaveBeenCalledTimes(2)
})

it('checkpoints a running task on shutdown and ignores late data before restarting', async () => {
  const { task, source, db } = fixture(3)
  let release!: (value: TechnicalBar[]) => void
  const pending = new Promise<TechnicalBar[]>(resolve => { release = resolve })
  vi.mocked(source.bars).mockImplementation(async code => code === '600002' ? pending : bars)
  task.request()
  await vi.waitFor(() => expect(task.status().checked).toBe(2))
  task.dispose()
  const saved = db.getSetting('stock-data.work')
  release(bars); await Promise.resolve(); await Promise.resolve()
  expect(db.getSetting('stock-data.work')).toBe(saved)
  const nextSource = { ...source, bars: vi.fn(async () => bars) }
  const restarted = new StockDataSync(db, nextSource); tasks.push(restarted)
  restarted.start()
  await vi.waitFor(() => expect(restarted.status().phase).toBe('finished'))
  expect(nextSource.bars).toHaveBeenCalledTimes(2)
  expect(restarted.status().completed).toBe(3)
})

it('does not consume a manual cooldown in the evening scheduler or auto-resume a user pause', async () => {
  const { task, source } = fixture(1)
  task.start()
  await vi.waitFor(() => expect(task.status().phase).toBe('finished'))
  expect(task.status().availableAt).toBeNull()
  task.request()
  task.pause()
  await vi.advanceTimersByTimeAsync(7 * 3600000)
  expect(task.status().phase).toBe('paused')
  expect(source.bars).toHaveBeenCalledTimes(2)
})

it('coalesces identical requests across consumers and uses at most two daily download slots', async () => {
  const { db, source } = fixture()
  let release!: (value: TechnicalBar[]) => void
  const pending = new Promise<TechnicalBar[]>(resolve => { release = resolve })
  vi.mocked(source.bars).mockReturnValue(pending)
  const data = new TechnicalData(db, source); tasks.push(data)
  const signal = new AbortController().signal
  const jobs = [data.bars('600000', 'none', '2026-10-30', signal), data.bars('600000', 'none', '2026-10-30', signal),
    data.bars('600001', 'none', '2026-10-30', signal), data.bars('600002', 'none', '2026-10-30', signal)]
  expect(source.bars).toHaveBeenCalledTimes(2)
  release(bars)
  await Promise.all(jobs)
  expect(source.bars).toHaveBeenCalledTimes(3)
  await data.bars('600002', 'none', '2026-10-30', signal)
  expect(source.bars).toHaveBeenCalledTimes(3)
})

it('keeps a shared download alive for another consumer when one observer aborts', async () => {
  const { db, source } = fixture()
  let release!: (value: TechnicalBar[]) => void
  vi.mocked(source.bars).mockReturnValue(new Promise(resolve => { release = resolve }))
  const data = new TechnicalData(db, source); tasks.push(data)
  const cancelled = new AbortController(), observer = new AbortController()
  const first = data.bars('600000', 'none', '2026-10-30', cancelled.signal)
  const rejection = expect(first).rejects.toThrow()
  const second = data.bars('600000', 'none', '2026-10-30', observer.signal)
  cancelled.abort(); release(bars)
  await rejection
  expect(await second).toMatchObject({ bars })
  expect(source.bars).toHaveBeenCalledTimes(1)
})

it('uses a raw correction overlap while always fetching a complete new qfq basis', async () => {
  const { db, source } = fixture()
  const store = new TechnicalHistoryStore(db.sqlite)
  store.write('600000', 'none', '2026-10-29', [{ ...bars[0]!, date: '2026-10-29' }], 'fixture', '2026-10-29T12:00:00.000Z')
  const data = new TechnicalData(db, source); tasks.push(data)
  const signal = new AbortController().signal
  await data.bars('600000', 'none', '2026-10-30', signal)
  expect(source.bars).toHaveBeenCalledWith('600000', 'none', '2026-10-30', expect.any(AbortSignal), 40)
  await data.bars('600000', 'qfq', '2026-10-30', signal)
  expect(source.bars).toHaveBeenCalledWith('600000', 'qfq', '2026-10-30', expect.any(AbortSignal))
  expect(store.read('600000', 'none', '2026-10-30')?.map(bar => bar.date)).toEqual(['2026-10-29', '2026-10-30'])
})

it('persists shared historical pool facts and retains them on a later source failure', async () => {
  const { db, source } = fixture()
  const pool = { date: '2026-10-30', codes: ['600000'], source: 'fixture-pool', fetchedAt: new Date().toISOString(), scope: 'source-pool-positive-only' as const }
  const load = vi.fn(async () => pool)
  const data = new TechnicalData(db, { ...source, limitPool: load }); tasks.push(data)
  const signal = new AbortController().signal
  expect(await data.limitPool('2026-10-30', signal)).toEqual(pool)
  const offline = vi.fn(async () => { throw new Error('offline') })
  const second = new TechnicalData(db, { ...source, limitPool: offline }); tasks.push(second)
  expect(await second.limitPool('2026-10-30', signal)).toEqual(pool)
  expect(offline).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(6 * 3600000)
  expect(await second.limitPool('2026-10-30', signal)).toEqual(pool)
  expect(offline).toHaveBeenCalledTimes(1)
})

it('backs off automatic retries for six hours after a long-running failure, not after its start', async () => {
  const { task, source } = fixture(1)
  let reject!: (cause: Error) => void
  vi.mocked(source.bars).mockReturnValue(new Promise((_resolve, fail) => { reject = fail }))
  task.request()
  await vi.waitFor(() => expect(source.bars).toHaveBeenCalledTimes(1))
  vi.setSystemTime(Date.now() + 5 * 3600000)
  reject(new Error('late timeout'))
  await vi.waitFor(() => expect(task.status().phase).toBe('finished'))
  task.start()
  await vi.advanceTimersByTimeAsync(6 * 3600000 - 60000)
  expect(source.bars).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(60000)
  await vi.waitFor(() => expect(source.bars).toHaveBeenCalledTimes(2))
})

it('refreshes the securities catalogue in the host even when no page opened or catalogue existed', async () => {
  const { db, source } = fixture(0)
  const refresh = vi.fn(async (signal: AbortSignal) => {
    signal.throwIfAborted()
    db.sqlite.prepare('INSERT INTO security_master VALUES(?, ?, ?, ?, ?, ?, ?)').run('1.600000', '600000', '样本', 'SH', '', '', new Date().toISOString())
  })
  const task = new StockDataSync(db, source, refresh); tasks.push(task)
  task.start()
  await vi.waitFor(() => expect(task.status().phase).toBe('finished'))
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(task.status()).toMatchObject({ total: 1, completed: 1, latestCompleteDate: '2026-10-30' })
})

it('continues known stocks after a catalogue failure but never labels the range fully current', async () => {
  const { db, source } = fixture(1)
  const task = new StockDataSync(db, source, async () => { throw new Error('catalogue offline') }); tasks.push(task)
  task.request()
  await vi.waitFor(() => expect(task.status().phase).toBe('finished'))
  expect(task.status()).toMatchObject({ completed: 1, latestCompleteDate: null })
  expect(task.status().error).toContain('沿用本地范围')
})

it('preserves an explicit pause received at the final batch checkpoint', async () => {
  const { db, task } = fixture(1)
  const original = db.setSetting.bind(db)
  let paused = false
  vi.spyOn(db, 'setSetting').mockImplementation((key, value) => {
    original(key, value)
    if (key === 'stock-data.work' && !paused) {
      const work = JSON.parse(value)
      if (work.phase === 'running' && work.cursor === 1) { paused = true; task.pause() }
    }
  })
  task.request()
  await vi.waitFor(() => expect(paused).toBe(true))
  await Promise.resolve()
  expect(task.status().phase).toBe('paused')
  expect(JSON.parse(db.getSetting('stock-data.work')!).phase).toBe('paused')
})

it('persists financial failures separately without discarding successfully prepared price inputs', async () => {
  const { db, source } = fixture(2)
  const metrics = vi.fn(async (code: string) => { if (code === '600001') throw new Error('reports offline') })
  const task = new StockDataSync(db, source, undefined, metrics); tasks.push(task)
  await task.ensure()
  expect(task.status()).toMatchObject({ phase: 'finished', completed: 2, failed: 0,
    financial: { checked: 2, completed: 1, failed: 1, samples: [{ code: '600001', reason: 'reports offline' }] } })
  const reopened = new StockDataSync(db, source, undefined, metrics); tasks.push(reopened)
  expect(reopened.status().financial).toEqual(task.status().financial)
  expect(new TechnicalHistoryStore(db.sqlite).read('600001', 'qfq', '2026-10-30')).not.toBeNull()
})

it('continues independent financial gaps when daily sources are circuit-open', async () => {
  const { db, source } = fixture(3)
  vi.mocked(source.bars).mockRejectedValue(new SourceCircuitOpenError('tencent-daily', Date.now() + 300000))
  const metrics = vi.fn(async () => {})
  const task = new StockDataSync(db, source, undefined, metrics); tasks.push(task)
  await expect(task.ensure()).rejects.toThrow('熔断')
  expect(source.bars).toHaveBeenCalledTimes(2)
  expect(metrics).toHaveBeenCalledTimes(3)
  expect(task.status()).toMatchObject({ phase: 'failed', checked: 2, financial: { checked: 3, completed: 3 } })
})

it('does not advance a paused checkpoint while a financial request is returning', async () => {
  const { db, source } = fixture(1)
  let release!: () => void
  const metrics = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
  const task = new StockDataSync(db, source, undefined, metrics); tasks.push(task)
  task.request()
  await vi.waitFor(() => expect(metrics).toHaveBeenCalledOnce())
  task.pause(); release()
  await Promise.resolve(); await Promise.resolve()
  expect(task.status()).toMatchObject({ phase: 'paused', checked: 1, financial: { completed: 0 } })
  await expect(task.ensure()).rejects.toThrow('已暂停')
})

it('does not invent financial checks for a legacy daily-data checkpoint or rewrite it while reading', () => {
  const { db, source } = fixture(0)
  const codes = Array.from({ length: 5576 }, (_, i) => String(600000 + i))
  const saved = JSON.stringify({ phase: 'failed', asOf: '2026-10-30', latestCompleteDate: null, codes, cursor: 2754, completed: 2724,
    errors: Object.fromEntries(codes.slice(0, 30).map(code => [code, '日线失败'])), updatedAt: '2026-11-02T02:42:00.000Z',
    availableAt: null, attemptedAt: Date.now(), error: '数据源 88ai-technical 已熔断，稍后重试' })
  db.setSetting('stock-data.work', saved)
  const reopened = new StockDataSync(db, source); tasks.push(reopened)
  expect(reopened.status()).toMatchObject({ total: 5576, checked: 2754, completed: 2724, failed: 30,
    task: { origin: 'legacy', startedAt: null }, financial: { checked: 0, completed: 0, failed: 0 } })
  expect(db.getSetting('stock-data.work')).toBe(saved)
  expect(source.bars).not.toHaveBeenCalled()
})

it('archives the legacy error when starting a new local task and reuses the existing price windows', async () => {
  const { db, source } = fixture(1)
  const history = new TechnicalHistoryStore(db.sqlite)
  for (const adjust of ['none', 'qfq'] as const) history.write('600000', adjust, '2026-10-30', bars, 'tencent', new Date().toISOString())
  const oldError = '数据源 88ai-technical 已熔断'
  db.setSetting('stock-data.work', JSON.stringify({ phase: 'failed', asOf: '2026-10-30', latestCompleteDate: null,
    codes: ['600000'], cursor: 1, completed: 1, errors: {}, updatedAt: '2026-10-30T02:42:00.000Z', availableAt: null, attemptedAt: Date.now(), error: oldError }))
  const metrics = vi.fn(async () => {})
  const task = new StockDataSync(db, source, undefined, metrics); tasks.push(task)
  const startedAt = new Date().toISOString()
  task.request()
  await vi.waitFor(() => expect(task.status().phase).toBe('finished'))
  expect(task.status()).toMatchObject({ error: null, task: { origin: 'local', startedAt },
    previousError: { message: oldError, recordedAt: '2026-10-30T02:42:00.000Z', origin: 'legacy' }, financial: { checked: 1, completed: 1, failed: 0 } })
  expect(source.bars).not.toHaveBeenCalled()
  expect(history.read('600000', 'none', '2026-10-30')).toEqual(bars)
  const reopened = new StockDataSync(db, source, undefined, metrics); tasks.push(reopened)
  expect(reopened.status().previousError).toEqual(task.status().previousError)
})

it('verifies missing legacy inputs and does not repeat successful financial checks on the same baseline', async () => {
  const { db, source } = fixture(2)
  db.setSetting('stock-data.work', JSON.stringify({ phase: 'running', asOf: '2026-10-30', through: '2026-10-30', latestCompleteDate: null,
    codes: ['600000', '600001'], cursor: 1, completed: 1, errors: {}, updatedAt: '2026-10-30T02:42:00.000Z',
    availableAt: null, attemptedAt: Date.now(), error: '上次88AI错误' }))
  const metrics = vi.fn(async () => {})
  const task = new StockDataSync(db, source, undefined, metrics); tasks.push(task)
  task.start()
  await vi.waitFor(() => expect(task.status().phase).toBe('finished'))
  expect(task.status()).toMatchObject({ checked: 2, error: null, task: { origin: 'local' }, financial: { checked: 2, completed: 2 },
    previousError: { message: '上次88AI错误', origin: 'legacy' } })
  await vi.advanceTimersByTimeAsync(6 * 3600000 - 60000)
  expect(metrics).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(120000)
  await vi.waitFor(() => expect(task.status().financial?.checked).toBe(2))
  expect(task.status().financial).toMatchObject({ checked: 2, completed: 2, failed: 0 })
  expect(metrics).toHaveBeenCalledTimes(2)
})
