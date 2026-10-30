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
