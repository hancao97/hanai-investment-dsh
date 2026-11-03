import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HanaiDatabase } from '../../domain/src/database.ts'
import { ResearchWorkspace } from '../../domain/src/research-assistant.ts'
import { resolveHanaiPaths, ensureHanaiLayout } from '../../domain/src/paths.ts'
import { TechnicalHistoryStore } from '../../domain/src/technical-history.ts'
import { DEFAULT_SCAN_QUERY, isMarketScanData } from '../../contracts/src/market-scan.ts'
import type { StockQuoteMetricsData } from '../../contracts/src/index.ts'
import { LocalScreening } from '../src/local-screening.ts'
import { TechnicalData } from '../src/technical-data.ts'
import { AiScreener } from '../src/ai-screener.ts'

const roots: string[] = [], databases: HanaiDatabase[] = [], engines: AiScreener[] = [], services: TechnicalData[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T20:00:00+08:00')) })
afterEach(() => {
  engines.splice(0).forEach(v => v.dispose()); services.splice(0).forEach(v => v.dispose())
  databases.splice(0).forEach(v => v.close()); roots.splice(0).forEach(v => rmSync(v, { recursive: true, force: true })); vi.useRealTimers()
})
function fixture(count = 3) {
  const root = mkdtempSync(join(tmpdir(), 'hanai-local-screen-')); roots.push(root)
  const paths = resolveHanaiPaths(root); ensureHanaiLayout(paths)
  const db = new HanaiDatabase(paths.databasePath); databases.push(db)
  for (let i = 0; i < count; i++) db.sqlite.prepare('INSERT INTO security_master VALUES(?,?,?,?,?,?,?)')
    .run(`1.${600000 + i}`, String(600000 + i), `公司${i}`, 'SH', '', '', new Date().toISOString())
  return { root, paths, db, local: new LocalScreening(db) }
}
function metrics(code = '600000', roe: number | null = 15): StockQuoteMetricsData {
  const quoteMeta = { providerId: 'tencent', sourceName: '腾讯', sourceTimestamp: '2026-10-30T15:00:00+08:00', fetchedAt: new Date().toISOString(), cacheState: 'fresh' }
  const reportMeta = { ...quoteMeta, providerId: 'eastmoney-financials', sourceTimestamp: '2026-09-30' }
  return { quote: { code, price: 10, marketCap: 100e8, changePct: 1, pb: 2 },
    metrics: { code, roe, peTtm: 12, netProfitYoy: 20, revenueYoy: 10, grossMargin: 40, netMargin: 15, industry: '银行', dividendYield: 3, reportDate: '2026-09-30', meta: reportMeta },
    sources: { quote: quoteMeta, metrics: reportMeta, industry: quoteMeta } } as unknown as StockQuoteMetricsData
}
it('enumerates the complete local master without a remote directory or invented financial values', async () => {
  const { local } = fixture(103)
  const first = await local.query({ ...DEFAULT_SCAN_QUERY, sort: 'code', order: 'asc' })
  const second = await local.query({ ...DEFAULT_SCAN_QUERY, sort: 'code', order: 'asc', page: 2 })
  expect(first.data?.total).toBe(103); expect(first.data?.stocks).toHaveLength(100); expect(second.data?.stocks).toHaveLength(3)
  expect(first.data?.stocks[0]).toMatchObject({ pe: null, roe: null, price: null })
  expect(isMarketScanData(first.data)).toBe(true)
  expect(second.data?.revision).toBe(first.data?.revision)
})
it('filters owned financial facts with units, exact industry and explicit missing coverage', async () => {
  const { local } = fixture(); local.write('600000', metrics()); local.write('600001', metrics('600001', 0))
  const result = await local.query({ ...DEFAULT_SCAN_QUERY, ranges: { roe: { min: 10 }, marketCap: { min: 90 } }, industries: ['银行'] })
  expect(result.data?.total).toBe(1); expect(result.data?.stocks[0]?.marketCap).toBe(100)
  expect(result.data?.stocks[0]?.facts?.roe).toMatchObject({ source: 'eastmoney-financials', date: '2026-09-30', reportDate: '2026-09-30' })
  expect(result.data?.coverage).toMatchObject({ universe: 3, unverified: 1, missingFields: ['industry', 'marketCap', 'roe'] })
  expect(isMarketScanData(result.data)).toBe(true)
  const zero = await local.query({ ...DEFAULT_SCAN_QUERY, search: '600001', ranges: { roe: { min: 0, max: 0 } } })
  expect(zero.data?.total).toBe(1)
})

it('reuses only complete, current financial facts and expires preparation readiness after six hours', async () => {
  const { local, db } = fixture(3)
  local.write('600000', metrics('600000', 0))
  local.write('600001', metrics('600001', null))
  db.setSetting('stock-data.metrics.600002', '{invalid')
  expect([...local.readyCodes('2026-10-30')]).toEqual(['600000'])
  expect(() => local.write('600002', null)).toThrow('保留已有数据')
  expect(db.getSetting('stock-data.metrics.600002')).toBe('{invalid')
  local.write('600002', metrics('600002'))
  expect(local.readyCodes('2026-10-30').has('600002')).toBe(true)
  expect(local.readyCodes('2026-11-02').size).toBe(0)
  await vi.advanceTimersByTimeAsync(6 * 3600000)
  expect(local.readyCodes('2026-10-30').size).toBe(0)
})

it('prefers BaoStock daily facts per field and fills cumulative reports and market cap from fallback', async () => {
  const { local, db } = fixture(1)
  const fact = { value: 8, source: 'baostock', date: '2026-10-30', reportDate: null, fetchedAt: new Date().toISOString() }
  local.write('600000', metrics(), { pe: fact, price: { ...fact, value: 10.5 } })
  const result = await local.query({ ...DEFAULT_SCAN_QUERY, ranges: { pe: { max: 9 } } })
  expect(result.data?.stocks[0]).toMatchObject({ pe: 8, price: 10.5, marketCap: 100, roe: 15 })
  expect(result.data?.stocks[0]?.facts?.pe).toMatchObject({ source: 'baostock', reportDate: null })
  expect(result.data?.stocks[0]?.facts?.roe?.source).toBe('eastmoney-financials')
  local.write('600000', metrics())
  expect(JSON.parse(db.getSetting('stock-data.metrics.600000')!).pe.source).toBe('baostock')
  expect(JSON.parse(db.getSetting('stock-data.metrics.600000')!).pe.value).toBe(8)
  await vi.advanceTimersByTimeAsync(6 * 3600000)
  local.write('600000', metrics())
  expect(JSON.parse(db.getSetting('stock-data.metrics.600000')!).pe.source).not.toBe('baostock')
  expect(local.readyCodes('2026-10-30').has('600000')).toBe(true)
})

it('retains valid BaoStock-only facts when fallback metrics are unavailable without inventing the missing fields', async () => {
  const { local } = fixture(1)
  local.write('600000', null, { price: { value: 10, source: 'baostock', date: '2026-10-30', reportDate: null, fetchedAt: new Date().toISOString() } })
  const result = await local.query({ ...DEFAULT_SCAN_QUERY, ranges: { roe: { min: 0 } } })
  expect(result.data?.total).toBe(0)
  expect(result.data?.coverage).toMatchObject({ unverified: 1, missingFields: ['roe'] })
  const all = await local.query({ ...DEFAULT_SCAN_QUERY, sort: 'code' })
  expect(all.data?.stocks[0]).toMatchObject({ price: 10, roe: null, marketCap: null })
})
it('retains old facts after unavailable responses and excludes stale facts from a new baseline', async () => {
  const { db, local } = fixture(); local.write('600000', metrics())
  const before = db.getSetting('stock-data.metrics.600000')
  expect(() => local.write('600000', { quote: null, metrics: null, sources: { quote: null, metrics: null } })).toThrow('保留已有数据')
  expect(db.getSetting('stock-data.metrics.600000')).toBe(before)
  vi.setSystemTime(new Date('2026-11-02T20:00:00+08:00'))
  const stale = await local.query({ ...DEFAULT_SCAN_QUERY, search: '600000', ranges: { roe: { min: 10 } } })
  expect(stale.data?.coverage?.unverified).toBe(1)
  expect(stale.data?.snapshotDate).toBe('2026-10-30')
})
it('prepares missing financial inputs once through the background coordinator, then filters locally', async () => {
  const { db } = fixture(1)
  const prepare = vi.fn(async () => {
    db.setSetting('stock-data.calendar', JSON.stringify({ through: '2026-10-30', dates: ['2026-10-30'] }))
    local.write('600000', metrics())
  })
  const local = new LocalScreening(db, prepare)
  const query = { ...DEFAULT_SCAN_QUERY, ranges: { roe: { min: 10 } } }
  await Promise.all([local.query(query), local.query(query)])
  expect(prepare).toHaveBeenCalledTimes(1)
  expect((await local.query(query)).data?.total).toBe(1)
  expect(prepare).toHaveBeenCalledTimes(1)
  await expect(local.query({ ...query, ranges: { netInflow5d: { min: 1 } } })).rejects.toThrow('5日主力净流')
})
it('computes and reopens a frozen technical run with all network providers disabled', async () => {
  const { db, local, paths } = fixture(1)
  const dates = ['2026-10-28', '2026-10-29', '2026-10-30']
  const bars = dates.map((date, i) => ({ date, open: 10 + i, high: 10 + i, low: 10 + i, close: 10 + i, volume: 100 }))
  new TechnicalHistoryStore(db.sqlite).write('600000', 'qfq', '2026-10-30', bars, 'tencent', new Date().toISOString())
  db.setSetting('stock-data.calendar', JSON.stringify({ through: '2026-10-30', dates }))
  const unavailable = vi.fn(async () => { throw new Error('network must not be called') })
  const data = new TechnicalData(db, { calendar: unavailable, bars: unavailable, pool: unavailable }); services.push(data)
  const workspace = new ResearchWorkspace(paths), cwd = workspace.prepare('local-run', null, {})
  const question = '只验证本地数据'
  writeFileSync(join(cwd, 'screening-plan.json'), JSON.stringify({ question, interpretation: question, query: { ...DEFAULT_SCAN_QUERY, sort: 'code' },
    assumptions: [], unsupported: [], technical: { match: 'all', adjust: 'qfq', rules: [{ kind: 'price-ma', period: 2, relation: 'above' }] } }))
  const engine = new AiScreener(db, workspace, local, data); engines.push(engine)
  engine.start('local-run', question); expect((await engine.complete('local-run')).status).toBe('needs-confirmation')
  await engine.execute('local-run')
  await vi.waitFor(() => expect(engine.get('local-run')?.status).toBe('ready'))
  const result = engine.get('local-run')
  expect(result?.progress).toMatchObject({ checked: 1, matched: 1, unverified: 0 })
  expect(unavailable).not.toHaveBeenCalled()
  const reopened = new AiScreener(db, workspace, local); engines.push(reopened)
  expect(reopened.get('local-run')).toEqual(result)
})

it('acknowledges confirmed financial screening before background preparation completes', async () => {
  const { db, paths } = fixture(1)
  let release!: () => void
  const prepare = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve }); local.write('600000', metrics()) })
  const local = new LocalScreening(db, prepare)
  const workspace = new ResearchWorkspace(paths), cwd = workspace.prepare('financial', null, {})
  const question = 'ROE大于10%，确认报告累计口径'
  writeFileSync(join(cwd, 'screening-plan.json'), JSON.stringify({ question, interpretation: question,
    query: { ...DEFAULT_SCAN_QUERY, ranges: { roe: { min: 10 } } }, assumptions: ['报告累计口径'], unsupported: [] }))
  const engine = new AiScreener(db, workspace, local); engines.push(engine)
  engine.start('financial', question); await engine.complete('financial')
  expect((await engine.execute('financial')).status).toBe('scanning')
  expect(prepare).toHaveBeenCalledOnce(); release()
  await vi.waitFor(() => expect(engine.get('financial')?.status).toBe('ready'))
  expect(engine.get('financial')?.result?.data?.total).toBe(1)
})

it('refreshes a prior-session calendar before treating financial facts as current after another close', async () => {
  const { db } = fixture(1)
  db.setSetting('stock-data.calendar', JSON.stringify({ through: '2026-10-30', dates: ['2026-10-30'] }))
  const prepare = vi.fn(async () => {
    db.setSetting('stock-data.calendar', JSON.stringify({ through: '2026-11-02', dates: ['2026-10-30', '2026-11-02'] }))
    local.write('600000', metrics())
  })
  const local = new LocalScreening(db, prepare); local.write('600000', metrics())
  const query = { ...DEFAULT_SCAN_QUERY, ranges: { roe: { min: 10 } } }
  expect((await local.query(query)).data?.total).toBe(1); expect(prepare).not.toHaveBeenCalled()
  vi.setSystemTime(new Date('2026-11-02T20:00:00+08:00'))
  expect((await local.query(query)).data?.total).toBe(1)
  expect(prepare).toHaveBeenCalledOnce()
})

it('does not let the same-baseline retry interval hide a newly completed trading session', async () => {
  const { db } = fixture(1)
  vi.setSystemTime(new Date('2026-11-02T14:00:00+08:00'))
  let count = 0
  const prepare = vi.fn(async () => {
    count++
    db.setSetting('stock-data.calendar', JSON.stringify({ through: count === 1 ? '2026-10-30' : '2026-11-02', dates: count === 1 ? ['2026-10-30'] : ['2026-10-30', '2026-11-02'] }))
    local.write('600000', metrics())
  })
  const local = new LocalScreening(db, prepare), query = { ...DEFAULT_SCAN_QUERY, ranges: { roe: { min: 10 } } }
  await local.query(query); expect(prepare).toHaveBeenCalledTimes(1)
  vi.setSystemTime(new Date('2026-11-02T16:00:00+08:00'))
  await local.query(query); expect(prepare).toHaveBeenCalledTimes(2)
})
