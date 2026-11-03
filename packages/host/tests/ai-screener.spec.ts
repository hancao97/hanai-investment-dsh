import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HanaiDatabase } from '../../domain/src/database.ts'
import { MarketHistoryStore } from '../../domain/src/market-history.ts'
import { ResearchWorkspace } from '../../domain/src/research-assistant.ts'
import { ensureHanaiLayout, resolveHanaiPaths } from '../../domain/src/paths.ts'
import { DEFAULT_SCAN_QUERY, type MarketScanData } from '../../contracts/src/market-scan.ts'
import { AiScreener, parseScreeningPlan } from '../src/ai-screener.ts'
import { MarketScanService } from '../src/market-scan.ts'
import type { TechnicalSource } from '../src/technical-screener.ts'
import type { MarketScanStock } from '../../contracts/src/market-scan.ts'
import type { TechnicalBar } from '../../contracts/src/technical-screen.ts'
import { TechnicalHistoryStore } from '../../domain/src/technical-history.ts'
import { SourceCircuitOpenError } from '../../domain/src/providers/source-circuit.ts'

const roots: string[] = [], databases: HanaiDatabase[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T10:00:00+08:00')) })
afterEach(() => { for (const database of databases.splice(0)) database.close(); for (const root of roots.splice(0)) { if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('hanai-ai-screen-')) throw new Error('Unexpected cleanup target'); rmSync(root, { recursive: true, force: true }) }; vi.useRealTimers() })
const question = '市值100亿元以上，ROE不低于15%'
function plan(extra = {}) { return { question, interpretation: '按当前财务汇总初筛市值和ROE', query: { ...DEFAULT_SCAN_QUERY, ranges: { marketCap: { min: 100 }, roe: { min: 15 } } }, assumptions: [] as string[], unsupported: [] as string[], ...extra } }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hanai-ai-screen-')); roots.push(root)
  const paths = resolveHanaiPaths(root); ensureHanaiLayout(paths)
  const database = new HanaiDatabase(paths.databasePath); databases.push(database)
  const workspace = new ResearchWorkspace(paths), cwd = workspace.prepare('run-1', null, {})
  const load = vi.fn(async (query = DEFAULT_SCAN_QUERY): Promise<MarketScanData> => ({ query, total: 0, stocks: [], collectedOn: '2026-10-30', snapshotDate: '2026-10-30', meta: { providerId: 'test', sourceName: '测试源', sourceTimestamp: '2026-10-30', fetchedAt: new Date().toISOString(), cacheState: 'fresh' } }))
  const scan = new MarketScanService(load, new MarketHistoryStore(database.sqlite), database)
  return { database, cwd, load, scan, engine: new AiScreener(database, workspace, scan), workspace }
}
it('executes a validated DSH plan through the shared scanner and stores a frozen local result', async () => {
  const { engine, cwd, load } = fixture(); engine.start('run-1', question)
  writeFileSync(join(cwd, 'screening-plan.json'), JSON.stringify(plan()))
  const run = await engine.complete('run-1')
  expect(run.status).toBe('ready'); expect(load).toHaveBeenCalledWith(expect.objectContaining({ ranges: { roe: { min: 15 }, marketCap: { min: 100 } } }), false)
  expect(engine.get('run-1')?.result?.data?.total).toBe(0)
  writeFileSync(join(cwd, 'screening-result.json'), '{"status":"ready","stocks":["fake"]}')
  expect(engine.get('run-1')?.result?.data?.stocks).toEqual([])
  expect((await engine.complete('run-1')).status).toBe('ready'); expect(load).toHaveBeenCalledTimes(1)
  engine.remove('run-1'); expect(engine.get('run-1')).toBeNull()
})
it('waits for confirmation of assumptions and unsupported requirements without silently dropping them', async () => {
  const { engine, cwd, load } = fixture(); engine.start('run-1', question)
  writeFileSync(join(cwd, 'screening-plan.json'), JSON.stringify(plan({ assumptions: ['ROE采用来源当前汇总，非指定年报'], unsupported: ['连续三个季度提升无法验证'] })))
  expect((await engine.complete('run-1')).status).toBe('needs-confirmation'); expect(load).not.toHaveBeenCalled()
  writeFileSync(join(cwd, 'screening-plan.json'), JSON.stringify(plan({ query: DEFAULT_SCAN_QUERY })))
  const result = await engine.execute('run-1'); expect(result.status).toBe('ready'); expect(result.plan?.unsupported).toHaveLength(1)
  expect(load.mock.calls[0]?.[0].ranges.roe?.min).toBe(15)
})
it('does not scan without meaningful conditions or accept a plan for another question', async () => {
  const { engine, cwd, load } = fixture(); engine.start('run-1', question)
  writeFileSync(join(cwd, 'screening-plan.json'), JSON.stringify(plan({ query: DEFAULT_SCAN_QUERY, unsupported: ['真实订单无数据'] })))
  expect((await engine.complete('run-1')).status).toBe('needs-confirmation')
  expect((await engine.execute('run-1')).status).toBe('needs-confirmation'); expect(load).not.toHaveBeenCalled()
  expect(() => parseScreeningPlan(plan({ question: 'another question' }), question)).toThrow('不一致')
  expect(() => parseScreeningPlan(plan({ query: { ...DEFAULT_SCAN_QUERY, url: 'https://example.com' } }), question)).toThrow()
})
it('reports invalid or missing plan artifacts instead of inventing candidate data', async () => {
  const { engine, cwd, load } = fixture(); engine.start('run-1', question)
  expect((await engine.complete('run-1')).status).toBe('failed'); expect(load).not.toHaveBeenCalled()
  writeFileSync(join(cwd, 'screening-plan.json'), JSON.stringify(plan()))
  expect((await engine.execute('run-1')).error).toContain('尚无已校验')
  expect(load).not.toHaveBeenCalled()
  engine.start('run-1', question); writeFileSync(join(cwd, 'screening-plan.json'), '{broken')
  expect((await engine.complete('run-1')).status).toBe('failed')
})
it('coalesces duplicate completions and can resume a confirmed scan from the frozen plan', async () => {
  const { engine, cwd, load, database, workspace, scan } = fixture(); engine.start('run-1', question)
  writeFileSync(join(cwd, 'screening-plan.json'), JSON.stringify(plan()))
  let release: (value: MarketScanData) => void = () => {}
  load.mockImplementation(query => new Promise(resolve => { release = resolve }))
  const first = engine.complete('run-1'), second = engine.complete('run-1')
  expect(engine.busy('run-1')).toBe(true); expect(load).toHaveBeenCalledTimes(1)
  expect(engine.get('run-1')?.status).toBe('scanning')
  release({ query: engine.get('run-1')!.plan!.query, total: 0, stocks: [], collectedOn: '2026-10-30', snapshotDate: null, meta: { providerId: 'test', sourceName: 'test', sourceTimestamp: null, fetchedAt: new Date().toISOString(), cacheState: 'fresh' } })
  await Promise.all([first, second]); expect(engine.busy('run-1')).toBe(false)
  database.setSetting('ai-screener.run.run-1', JSON.stringify({ ...engine.get('run-1')!, status: 'scanning', plan: plan({ assumptions: ['先前已确认'] }) }))
  writeFileSync(join(cwd, 'screening-plan.json'), '{late broken artifact')
  const resumed = new AiScreener(database, workspace, scan)
  expect((await resumed.complete('run-1')).status).toBe('ready')
})

const dates = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29']
const technical = { match: 'all', adjust: 'qfq', rules: [{ kind: 'price-ma', period: 2, relation: 'above' }] }
function technicalFixture(count = 102) {
  const f = fixture()
  const stocks: MarketScanStock[] = Array.from({ length: count }, (_, i) => ({ code: String(600000 + i), secId: `1.${600000 + i}`, name: `公司${i}`, industry: '测试', price: 14, changePct: 1, pe: null, pb: null, roe: null, profitGrowth: null, revenueGrowth: null, marketCap: null, dividendYield: null, netInflow5d: null, netMargin: null, grossMargin: null }))
  f.load.mockImplementation(async query => ({ query, total: count, stocks: stocks.slice((query.page - 1) * 100, query.page * 100), collectedOn: '2026-10-30', snapshotDate: '2026-10-29', meta: { providerId: 'test', sourceName: 'test', sourceTimestamp: '2026-10-29', fetchedAt: new Date().toISOString(), cacheState: 'fresh' } }))
  const bars: TechnicalBar[] = dates.map((date, i) => ({ date, open: 10 + i, close: 10 + i, high: 10 + i, low: 10 + i, volume: 100 }))
  const source: TechnicalSource = { calendar: vi.fn(async () => dates), bars: vi.fn(async () => bars), pool: vi.fn(async () => null) }
  const engine = new AiScreener(f.database, f.workspace, f.scan, source)
  engine.start('run-1', question)
  writeFileSync(join(f.cwd, 'screening-plan.json'), JSON.stringify(plan({ query: DEFAULT_SCAN_QUERY, technical })))
  return { ...f, engine, source, stocks, bars }
}

it('requires formula confirmation, scans every catalogue page and freezes only verified hits', async () => {
  const { engine, source, load } = technicalFixture()
  expect((await engine.complete('run-1')).status).toBe('needs-confirmation')
  expect(load).not.toHaveBeenCalled()
  expect(source.bars).not.toHaveBeenCalled()
  expect((await engine.execute('run-1')).status).toBe('scanning')
  await engine.complete('run-1')
  await vi.waitFor(() => expect(engine.get('run-1')?.status).toBe('ready'))
  const saved = engine.get('run-1')!
  expect(load).toHaveBeenCalledTimes(2)
  expect(source.bars).toHaveBeenCalledTimes(102)
  expect(saved.progress).toMatchObject({ checked: 102, total: 102, matched: 102, unverified: 0, asOf: '2026-10-29' })
  expect(saved.progress?.dataReady).toBe(102)
  expect(saved.progress?.funnel?.[0]).toMatchObject({ passed: 102, rejected: 0, unverified: 0 })
  expect(saved.result?.data?.total).toBe(102)
  expect(saved.result?.data?.stocks).toHaveLength(100)
  expect(saved.progress?.evidence['600000']?.[0]?.matched).toBe(true)
  expect((await engine.complete('run-1')).status).toBe('ready')
  expect(source.bars).toHaveBeenCalledTimes(102)
})

it('checkpoints batches, aborts without late writes and resumes from the next unprocessed stock', async () => {
  const { engine, source, bars, database, workspace, scan } = technicalFixture(6)
  let release!: (value: TechnicalBar[]) => void
  const pending = new Promise<TechnicalBar[]>(resolve => { release = resolve })
  vi.mocked(source.bars).mockImplementation(async code => Number(code) < 600003 ? bars : pending)
  await engine.complete('run-1'); await engine.execute('run-1')
  await vi.waitFor(() => expect(source.bars).toHaveBeenCalledTimes(5))
  expect(engine.get('run-1')?.progress?.checked).toBe(3)
  expect(engine.busy('run-1')).toBe(true)
  engine.dispose()
  const nextSource: TechnicalSource = { ...source, bars: vi.fn(async () => bars) }
  const resumed = new AiScreener(database, workspace, scan, nextSource)
  await resumed.complete('run-1')
  await vi.waitFor(() => expect(resumed.get('run-1')?.status).toBe('ready'))
  expect(nextSource.bars).toHaveBeenCalledTimes(3)
  expect(resumed.get('run-1')?.progress?.matched).toBe(6)
  release(bars); await Promise.resolve(); await Promise.resolve()
  expect(resumed.get('run-1')?.progress?.matched).toBe(6)
})

it('rejects catalogue drift instead of scanning a first-page or duplicate sample', async () => {
  const { engine, load, source, stocks } = technicalFixture(102)
  load.mockImplementation(async query => ({ query, total: 102, stocks: query.page === 1 ? stocks.slice(0, 100) : stocks.slice(0, 2), collectedOn: '2026-10-30', snapshotDate: '2026-10-29', meta: { providerId: 'test', sourceName: 'test', sourceTimestamp: '2026-10-29', fetchedAt: new Date().toISOString(), cacheState: 'fresh' } }))
  await engine.complete('run-1'); await engine.execute('run-1')
  await vi.waitFor(() => expect(engine.get('run-1')?.status).toBe('failed'))
  expect(engine.get('run-1')?.error).toContain('重复或分页缺失')
  expect(source.bars).not.toHaveBeenCalled()
})

it('records missing technical data separately and never turns it into a match', async () => {
  const { engine, source } = technicalFixture(3)
  vi.mocked(source.bars).mockImplementation(async () => { throw new Error('source unavailable') })
  await engine.complete('run-1'); await engine.execute('run-1')
  await vi.waitFor(() => expect(engine.get('run-1')?.status).toBe('ready'))
  expect(engine.get('run-1')?.progress).toMatchObject({ checked: 3, matched: 0, unverified: 3 })
  expect(engine.get('run-1')?.progress?.funnel?.[0]).toMatchObject({ passed: 0, rejected: 0, unverified: 3 })
  expect(engine.get('run-1')?.progress?.samples[0]?.reason).toContain('source unavailable')
  expect(engine.get('run-1')?.result?.data?.stocks).toEqual([])
})

it('checks historical pool membership against raw closes, rather than a fixed 10 percent guess', async () => {
  const f = technicalFixture(3)
  writeFileSync(join(f.cwd, 'screening-plan.json'), JSON.stringify(plan({ query: DEFAULT_SCAN_QUERY, technical: { match: 'all', adjust: 'qfq', rules: [{ kind: 'limit-up', days: 1, minimum: 1 }] } })))
  vi.mocked(f.source.pool).mockResolvedValue({ date: '2026-10-29', stocks: [{ code: '600000', name: '公司0', boards: 1, industry: '', firstSeal: '09:30:00', lastSeal: '15:00:00', reason: null, boardType: null, breaks: null, turnover: null }], promotion: null, broken: null, issues: [], meta: { providerId: 'test-pool', sourceName: '历史收盘池', sourceTimestamp: '2026-10-29', fetchedAt: new Date().toISOString(), cacheState: 'fresh' } })
  await f.engine.complete('run-1'); await f.engine.execute('run-1')
  await vi.waitFor(() => expect(f.engine.get('run-1')?.status).toBe('ready'))
  expect(f.source.bars).toHaveBeenCalledWith('600000', 'none', '2026-10-29', expect.any(AbortSignal))
  expect(f.engine.get('run-1')?.progress).toMatchObject({ matched: 1, unverified: 2 })
  expect(f.engine.get('run-1')?.result?.data?.stocks.map(row => row.code)).toEqual(['600000'])
})

it('serializes multiple technical jobs and starts the next job after a failed catalogue', async () => {
  const f = technicalFixture(3)
  const cwd = f.workspace.prepare('run-2', null, {})
  f.engine.start('run-2', question)
  writeFileSync(join(cwd, 'screening-plan.json'), JSON.stringify(plan({ query: DEFAULT_SCAN_QUERY, technical })))
  const original = f.load.getMockImplementation()!
  f.load.mockImplementationOnce(async () => { throw new Error('catalogue offline') }).mockImplementation(original)
  await f.engine.complete('run-1'); await f.engine.complete('run-2')
  await f.engine.execute('run-1'); await f.engine.execute('run-2')
  await vi.waitFor(() => expect(f.engine.get('run-2')?.status).toBe('ready'))
  expect(f.engine.get('run-1')?.status).toBe('failed')
  expect(f.engine.get('run-2')?.progress?.checked).toBe(3)
})

it('reuses persisted daily data for a different query and after host reconstruction', async () => {
  const f = technicalFixture(3)
  await f.engine.complete('run-1'); await f.engine.execute('run-1')
  await vi.waitFor(() => expect(f.engine.get('run-1')?.status).toBe('ready'))
  f.engine.dispose()
  const nextSource: TechnicalSource = { ...f.source, bars: vi.fn(async () => { throw new Error('offline') }) }
  const engine = new AiScreener(f.database, f.workspace, f.scan, nextSource)
  const cwd = f.workspace.prepare('run-2', null, {})
  engine.start('run-2', question)
  writeFileSync(join(cwd, 'screening-plan.json'), JSON.stringify(plan({ query: DEFAULT_SCAN_QUERY, technical })))
  await engine.complete('run-2'); await engine.execute('run-2')
  await vi.waitFor(() => expect(engine.get('run-2')?.status).toBe('ready'))
  expect(nextSource.bars).not.toHaveBeenCalled()
  expect(engine.get('run-2')?.progress).toMatchObject({ matched: 3, unverified: 0 })
})

it('retries previously unverified stocks after a circuit failure without redownloading verified inputs', async () => {
  const f = technicalFixture(6)
  vi.mocked(f.source.bars).mockImplementation(async code => {
    if (code === '600000') throw new Error('temporary timeout')
    if (Number(code) >= 600003) throw new SourceCircuitOpenError('tencent', Date.now() + 300000)
    return f.bars
  })
  await f.engine.complete('run-1'); await f.engine.execute('run-1')
  await vi.waitFor(() => expect(f.engine.get('run-1')?.status).toBe('failed'))
  expect(f.engine.get('run-1')?.progress).toMatchObject({ checked: 3, matched: 2, unverified: 1 })
  vi.mocked(f.source.bars).mockClear().mockResolvedValue(f.bars)
  await f.engine.execute('run-1')
  await vi.waitFor(() => expect(f.engine.get('run-1')?.status).toBe('ready'))
  expect(f.source.bars).toHaveBeenCalledTimes(4)
  expect(f.engine.get('run-1')?.progress).toMatchObject({ checked: 6, matched: 6, unverified: 0 })
  expect(f.engine.get('run-1')?.progress?.dataReady).toBe(6)
  expect(f.engine.get('run-1')?.progress?.funnel?.[0]).toMatchObject({ passed: 6, rejected: 0, unverified: 0 })
  expect(f.engine.get('run-1')?.result?.data?.stocks.map(stock => stock.code)).toEqual(f.stocks.map(stock => stock.code))
  expect(f.engine.get('run-1')?.progress?.samples).toEqual([])
})

it('uses existing raw facts in every rule statistic even when another rule already rejects the stock', async () => {
  const f = technicalFixture(1)
  const raw = f.bars.map(bar => ({ ...bar, high: bar.close + 1 }))
  new TechnicalHistoryStore(f.database.sqlite).write('600000', 'none', dates.at(-1)!, raw, 'tencent', new Date().toISOString())
  writeFileSync(join(f.cwd, 'screening-plan.json'), JSON.stringify(plan({ query: DEFAULT_SCAN_QUERY, technical: { match: 'all', adjust: 'qfq', rules: [
    { kind: 'price-ma', period: 2, relation: 'below' }, { kind: 'limit-up', days: 2, minimum: 1 },
  ] } })))
  await f.engine.complete('run-1'); await f.engine.execute('run-1')
  await vi.waitFor(() => expect(f.engine.get('run-1')?.status).toBe('ready'))
  const progress = f.engine.get('run-1')?.progress
  expect(progress).toMatchObject({ checked: 1, matched: 0, dataReady: 1 })
  expect(progress?.funnel).toEqual([expect.objectContaining({ rejected: 1, unverified: 0 }), expect.objectContaining({ rejected: 1, unverified: 0 })])
  expect(f.source.bars).not.toHaveBeenCalledWith('600000', 'none', dates.at(-1), expect.anything())
})
