import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DashboardData,
  DefaultModelSelection,
  ProviderMeta,
  TradingDayAnalysisData,
  TradingDayContextData,
  TradingDayDragonTigerData,
  TradingDayLimitPoolsData,
  TradingDaySnapshotPayload,
  TradingDayStatus,
  TradingDayThemesData,
} from '../../contracts/src/index.ts'
import { HanaiDatabase } from '../../domain/src/database.ts'
import { ensureHanaiLayout, resolveHanaiPaths } from '../../domain/src/paths.ts'
import { ReportStore } from '../../domain/src/reports.ts'
import { ExpertChatStore } from '../../domain/src/expert-chats.ts'
import type { TradingDayFacade } from '../../domain/src/trading-day.ts'
import {
  HanaiService,
  type DefaultModelFacade,
  type MarketFacade,
  type SessionFacade,
} from '../src/service.ts'

const roots: string[] = []
const assets = resolve(dirname(fileURLToPath(import.meta.url)), '../../masters/assets')

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const meta: ProviderMeta = {
  providerId: 'fake',
  sourceName: 'fake',
  sourceTimestamp: null,
  fetchedAt: new Date(0).toISOString(),
  cacheState: 'fresh',
}

function dashboardData(): DashboardData {
  return {
    overview: {
      indices: [],
      breadth: { up: null, down: null, flat: null, limitUp: null, limitDown: null, totalAmount: null },
      marketStatus: 'closed',
      meta,
    },
    industry: { type: 'industry', sectors: [], meta },
    concept: { type: 'concept', sectors: [], meta },
    ranks: { gainers: [], losers: [], amount: [], turnover: [] },
  }
}

function contextData(tradeDate: string, status: TradingDayStatus = 'complete'): TradingDayContextData {
  return {
    tradeDate,
    generatedAt: new Date().toISOString(),
    status,
    indices: [],
    trend: null,
    turnover: null,
    margin: null,
    sources: [],
  }
}

function limitPoolsData(tradeDate: string, status: TradingDayStatus = 'complete'): TradingDayLimitPoolsData {
  return {
    tradeDate,
    generatedAt: new Date().toISOString(),
    status,
    stats: {
      limitUp: null,
      limitDown: null,
      broken: null,
      sealRate: null,
      breakRate: null,
      firstBoard: null,
      lianban: null,
      maxBoard: null,
      promotionRate: null,
    },
    ladder: [],
    yesterdayPerformance: {
      sample: null,
      promoted: null,
      avgChangePct: null,
      medianChangePct: null,
      upRate: null,
    },
    sources: [],
  }
}

function themesData(tradeDate: string, status: TradingDayStatus = 'complete'): TradingDayThemesData {
  return { tradeDate, generatedAt: new Date().toISOString(), status, themes: [], drives: [], sources: [] }
}

function dragonTigerData(tradeDate: string, status: TradingDayStatus = 'complete'): TradingDayDragonTigerData {
  return { tradeDate, generatedAt: new Date().toISOString(), status, entries: [], sources: [] }
}

function analysisData(tradeDate: string, status: TradingDayStatus = 'complete'): TradingDayAnalysisData {
  return {
    tradeDate,
    generatedAt: new Date().toISOString(),
    status,
    axes: [],
    mainlines: [],
    leaders: [],
    centerCandidates: [],
    roles: [],
    verdict: { stage: null, position: null, temperature: null, confidence: null, summary: '', gaps: [] },
    scenarios: [],
    coverage: { analyzed: 0, total: 0, skipped: 0 },
    missingReasons: [],
    sources: [],
  }
}

function emptyPayload(): TradingDaySnapshotPayload {
  return { context: null, limitPools: null, themes: null, dragonTiger: null, analysis: null, dashboard: null }
}

function shanghaiToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const part = (type: string): string => parts.find(entry => entry.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function databaseFixture(): { db: HanaiDatabase; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'hanai-dsh-trading-day-db-'))
  roots.push(root)
  const paths = resolveHanaiPaths(root)
  ensureHanaiLayout(paths)
  return { db: new HanaiDatabase(paths.databasePath), root }
}

describe('trading-day snapshot storage', () => {
  it('creates the migration table and upserts one idempotent row per trade date', () => {
    const { db } = databaseFixture()
    const table = db.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trading_day_snapshots'",
    ).get() as { name: string } | undefined
    expect(table?.name).toBe('trading_day_snapshots')

    const tradeDate = '2026-01-05'
    const first = db.upsertTradingDaySnapshot({
      tradeDate,
      capturedAt: '2026-01-05T01:00:00.000Z',
      status: 'partial',
      schemaVersion: 1,
      payload: { ...emptyPayload(), context: contextData(tradeDate) },
    })
    expect(first).toMatchObject({ tradeDate, schemaVersion: 1, status: 'partial' })

    const second = db.upsertTradingDaySnapshot({
      tradeDate,
      capturedAt: '2026-01-05T02:00:00.000Z',
      status: 'complete',
      schemaVersion: 1,
      payload: {
        ...emptyPayload(),
        context: contextData(tradeDate),
        limitPools: limitPoolsData(tradeDate),
      },
    })
    expect(second.tradeDate).toBe(tradeDate)
    expect(db.listTradingDaySnapshots()).toEqual([
      { tradeDate, capturedAt: '2026-01-05T02:00:00.000Z', status: 'complete' },
    ])
    expect(db.getTradingDaySnapshot(tradeDate)).toMatchObject({
      tradeDate,
      capturedAt: '2026-01-05T02:00:00.000Z',
      status: 'complete',
      schemaVersion: 1,
    })
    expect(db.getTradingDaySnapshot(tradeDate)?.payload.limitPools?.tradeDate).toBe(tradeDate)
    db.close()
  })

  it('supports the read-modify-write merge by preserving untouched groups and dashboard', () => {
    const { db } = databaseFixture()
    const tradeDate = '2026-01-06'
    db.upsertTradingDaySnapshot({
      tradeDate,
      capturedAt: '2026-01-06T01:00:00.000Z',
      status: 'partial',
      schemaVersion: 1,
      payload: {
        ...emptyPayload(),
        context: contextData(tradeDate),
        dashboard: dashboardData(),
      },
    })

    const existing = db.getTradingDaySnapshot(tradeDate)!
    const payload: TradingDaySnapshotPayload = {
      ...existing.payload,
      themes: themesData(tradeDate),
      dragonTiger: dragonTigerData(tradeDate),
    }
    db.upsertTradingDaySnapshot({
      tradeDate,
      capturedAt: '2026-01-06T02:00:00.000Z',
      status: 'partial',
      schemaVersion: 1,
      payload,
    })

    const merged = db.getTradingDaySnapshot(tradeDate)!
    expect(merged.payload.context).not.toBeNull()
    expect(merged.payload.dashboard).not.toBeNull()
    expect(merged.payload.themes).not.toBeNull()
    expect(merged.payload.dragonTiger).not.toBeNull()
    expect(merged.payload.limitPools).toBeNull()
    expect(merged.payload.analysis).toBeNull()
    db.close()
  })

  it('lists summaries in descending trade-date order', () => {
    const { db } = databaseFixture()
    for (const tradeDate of ['2026-01-05', '2026-01-07', '2026-01-06']) {
      db.upsertTradingDaySnapshot({
        tradeDate,
        capturedAt: `${tradeDate}T01:00:00.000Z`,
        status: 'partial',
        schemaVersion: 1,
        payload: emptyPayload(),
      })
    }
    expect(db.listTradingDaySnapshots().map(row => row.tradeDate)).toEqual([
      '2026-01-07',
      '2026-01-06',
      '2026-01-05',
    ])
    db.close()
  })

  it('retains only the newest 90 trade dates', () => {
    const { db } = databaseFixture()
    const dates: string[] = []
    for (let offset = 0; offset < 95; offset += 1) {
      const date = new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10)
      dates.push(date)
      db.upsertTradingDaySnapshot({
        tradeDate: date,
        capturedAt: `${date}T01:00:00.000Z`,
        status: 'partial',
        schemaVersion: 1,
        payload: emptyPayload(),
      })
    }
    const kept = db.listTradingDaySnapshots()
    expect(kept).toHaveLength(90)
    expect(kept[0]?.tradeDate).toBe(dates.at(-1))
    expect(kept.at(-1)?.tradeDate).toBe(dates.at(-90))
    for (const evicted of dates.slice(0, 5)) {
      expect(db.getTradingDaySnapshot(evicted)).toBeNull()
    }
    db.close()
  })

  it('treats corrupted payload JSON as a missing record while keeping the summary row', () => {
    const { db } = databaseFixture()
    const tradeDate = '2026-01-08'
    db.sqlite.prepare(`
      INSERT INTO trading_day_snapshots(trade_date, captured_at, status, schema_version, payload)
      VALUES(?, ?, 'partial', 1, ?)
    `).run(tradeDate, '2026-01-08T01:00:00.000Z', '{not-json')
    expect(db.getTradingDaySnapshot(tradeDate)).toBeNull()
    expect(db.listTradingDaySnapshots()).toEqual([
      { tradeDate, capturedAt: '2026-01-08T01:00:00.000Z', status: 'partial' },
    ])

    db.sqlite.prepare(`
      UPDATE trading_day_snapshots SET payload = '[]' WHERE trade_date = ?
    `).run(tradeDate)
    expect(db.getTradingDaySnapshot(tradeDate)).toBeNull()
    db.close()
  })
})

class FakeSessions implements SessionFacade {
  async create(judgementId: string): Promise<string> { return `hanai-${judgementId}` }
  async archive(): Promise<void> {}
  async prompt(): Promise<void> {}
  async isRunning(): Promise<boolean> { return false }
}

class FakeDefaultModel implements DefaultModelFacade {
  selection: DefaultModelSelection = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }

  currentSelection() { return { ...this.selection } }

  async saveSelection(next: DefaultModelSelection): Promise<void> {
    this.selection = { ...next }
  }
}

class FakeTradingDay implements TradingDayFacade {
  today = shanghaiToday()
  failures = new Set<keyof TradingDayFacade>()
  calls: Array<keyof TradingDayFacade> = []
  contextStatus: TradingDayStatus = 'complete'
  limitPoolsStatus: TradingDayStatus = 'complete'

  private maybeFail(method: keyof TradingDayFacade): void {
    this.calls.push(method)
    if (this.failures.has(method)) throw new Error(`${method} unavailable`)
  }

  async tradingDayContext(): Promise<TradingDayContextData> {
    this.maybeFail('tradingDayContext')
    return contextData(this.today, this.contextStatus)
  }

  async tradingDayLimitPools(): Promise<TradingDayLimitPoolsData> {
    this.maybeFail('tradingDayLimitPools')
    return limitPoolsData(this.today, this.limitPoolsStatus)
  }

  async tradingDayThemes(): Promise<TradingDayThemesData> {
    this.maybeFail('tradingDayThemes')
    return themesData(this.today)
  }

  async tradingDayDragonTiger(): Promise<TradingDayDragonTigerData> {
    this.maybeFail('tradingDayDragonTiger')
    return dragonTigerData(this.today)
  }

  async tradingDayAnalysis(): Promise<TradingDayAnalysisData> {
    this.maybeFail('tradingDayAnalysis')
    return analysisData(this.today)
  }
}

class FakeMarket implements MarketFacade {
  getDashboard = vi.fn(async (): Promise<DashboardData> => dashboardData())
  getSectorStocks = vi.fn(async () => ({ stocks: [], meta }))
  getStockDetail = vi.fn(async () => { throw new Error('unused') })
  getStockQuoteMetrics = vi.fn(async () => ({
    quote: null,
    metrics: null,
    sources: { quote: null, metrics: null },
  }))
  getTrend = vi.fn(async () => ({ trend: [], trendPrevClose: null, meta: null }))
  getKline = vi.fn(async (_secId: string, period: 'daily' | 'weekly' | 'monthly') => ({
    period,
    bars: [],
    meta: null,
    hasMore: period === 'daily',
  }))
  getValuation = vi.fn(async () => ({ valuation: null, meta: null }))
  getQuotes = vi.fn(async () => ({ quotes: [], meta }))
  clearMarketCache = vi.fn(() => 0)
  syncSecurities = vi.fn(async () => ({ count: 0, updatedAt: null }))
  searchSecurities = vi.fn(async () => [])
}

/** 2026-10-23（周五）10:00 北京时间：开市时段。 */
const OPEN_NOW = Date.parse('2026-10-23T02:00:00Z')
/** 2026-10-24（周六）10:00 北京时间：非开市时段。 */
const CLOSED_NOW = Date.parse('2026-10-24T02:00:00Z')
const OPEN_TRADE_DATE = '2026-10-23'

function fixture(nowMs = OPEN_NOW) {
  const root = mkdtempSync(join(tmpdir(), 'hanai-dsh-trading-day-service-'))
  roots.push(root)
  const paths = resolveHanaiPaths(root)
  ensureHanaiLayout(paths)
  const database = new HanaiDatabase(paths.databasePath)
  const reports = new ReportStore(paths, assets, 100)
  const expertChats = new ExpertChatStore(paths, assets)
  const market = new FakeMarket()
  const tradingDay = new FakeTradingDay()
  tradingDay.today = OPEN_TRADE_DATE
  const service = new HanaiService({
    paths,
    database,
    reports,
    expertChats,
    sessions: new FakeSessions(),
    defaultModel: new FakeDefaultModel(),
    market,
    tradingDay,
    now: () => nowMs,
    version: 'test',
    openDirectory: async () => {},
  })
  return { database, market, service, tradingDay }
}

const signal = new AbortController().signal

describe('trading-day RPC snapshots', () => {
  it('does not write when save is false', async () => {
    const { database, market, service } = fixture()
    await service.call('tradingDay.context', {}, signal)
    expect(database.listTradingDaySnapshots()).toEqual([])
    expect(market.getDashboard).not.toHaveBeenCalled()
    database.close()
  })

  it('merges saved groups into one row per trade date and keeps the dashboard', async () => {
    const { database, market, service, tradingDay } = fixture()
    await service.call('tradingDay.context', { save: true }, signal)
    let record = database.getTradingDaySnapshot(tradingDay.today)
    expect(record?.schemaVersion).toBe(1)
    expect(record?.status).toBe('partial')
    expect(record?.payload.context?.tradeDate).toBe(tradingDay.today)
    expect(record?.payload.dashboard).not.toBeNull()
    expect(market.getDashboard).toHaveBeenCalledOnce()

    const firstCapturedAt = record?.capturedAt
    await service.call('tradingDay.limitPools', { save: true }, signal)
    record = database.getTradingDaySnapshot(tradingDay.today)
    expect(database.listTradingDaySnapshots()).toHaveLength(1)
    expect(record?.payload.context?.tradeDate).toBe(tradingDay.today)
    expect(record?.payload.limitPools?.tradeDate).toBe(tradingDay.today)
    expect(record?.payload.dashboard).not.toBeNull()
    expect(record?.capturedAt).not.toBe(firstCapturedAt)
    database.close()
  })

  it('ignores saves for a trade date that is not today in Asia/Shanghai', async () => {
    const { database, service, tradingDay } = fixture()
    tradingDay.today = '2020-01-02'
    await service.call('tradingDay.themes', { save: true }, signal)
    expect(database.listTradingDaySnapshots()).toEqual([])
    database.close()
  })

  it('recomputes complete status only when every group is complete', async () => {
    const { database, service, tradingDay } = fixture()
    for (const endpoint of [
      'tradingDay.context',
      'tradingDay.limitPools',
      'tradingDay.themes',
      'tradingDay.dragonTiger',
      'tradingDay.analyze',
    ] as const) {
      await service.call(endpoint, { save: true }, signal)
    }
    expect(database.getTradingDaySnapshot(tradingDay.today)?.status).toBe('complete')

    tradingDay.limitPoolsStatus = 'partial'
    await service.call('tradingDay.limitPools', { save: true }, signal)
    expect(database.getTradingDaySnapshot(tradingDay.today)?.status).toBe('partial')
    database.close()
  })

  it('keeps saving the context group when the dashboard refresh fails', async () => {
    const { database, market, service, tradingDay } = fixture()
    market.getDashboard.mockRejectedValueOnce(new Error('dashboard unavailable'))
    await expect(service.call('tradingDay.context', { save: true }, signal)).resolves.toMatchObject({
      tradeDate: tradingDay.today,
    })
    const record = database.getTradingDaySnapshot(tradingDay.today)
    expect(record?.payload.context?.tradeDate).toBe(tradingDay.today)
    expect(record?.payload.dashboard).toBeNull()
    database.close()
  })

  it('keeps an existing group when a later group fetch fails', async () => {
    const { database, service, tradingDay } = fixture()
    await service.call('tradingDay.context', { save: true }, signal)
    tradingDay.failures.add('tradingDayThemes')
    await expect(service.call('tradingDay.themes', { save: true }, signal))
      .rejects.toThrow('tradingDayThemes unavailable')
    const record = database.getTradingDaySnapshot(tradingDay.today)
    expect(record?.payload.context?.tradeDate).toBe(tradingDay.today)
    expect(record?.payload.themes).toBeNull()
    database.close()
  })

  it('does not fail the RPC when snapshot persistence fails', async () => {
    const { database, service, tradingDay } = fixture()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(database, 'upsertTradingDaySnapshot').mockImplementation(() => {
      throw new Error('disk full')
    })
    await expect(service.call('tradingDay.context', { save: true }, signal)).resolves.toMatchObject({
      tradeDate: tradingDay.today,
    })
    expect(error).toHaveBeenCalled()
    database.close()
  })

  it('serves snapshot summaries newest-first and full records by date', async () => {
    const { database, service, tradingDay } = fixture()
    database.upsertTradingDaySnapshot({
      tradeDate: '2026-01-05',
      capturedAt: '2026-01-05T01:00:00.000Z',
      status: 'partial',
      schemaVersion: 1,
      payload: emptyPayload(),
    })
    database.upsertTradingDaySnapshot({
      tradeDate: tradingDay.today,
      capturedAt: '2026-01-06T01:00:00.000Z',
      status: 'complete',
      schemaVersion: 1,
      payload: { ...emptyPayload(), context: contextData(tradingDay.today) },
    })

    await expect(service.call('tradingDay.snapshots', {}, signal)).resolves.toEqual({
      snapshots: [
        { tradeDate: tradingDay.today, capturedAt: '2026-01-06T01:00:00.000Z', status: 'complete' },
        { tradeDate: '2026-01-05', capturedAt: '2026-01-05T01:00:00.000Z', status: 'partial' },
      ],
    })
    await expect(service.call('tradingDay.snapshot', { date: tradingDay.today }, signal))
      .resolves.toMatchObject({
        tradeDate: tradingDay.today,
        schemaVersion: 1,
        payload: { context: { tradeDate: tradingDay.today } },
      })
    await expect(service.call('tradingDay.snapshot', { date: '2026-01-09' }, signal)).resolves.toBeNull()
    database.close()
  })
})

describe('trading-day history outside market hours', () => {
  function seedComplete(tradeDate: string): TradingDaySnapshotPayload {
    return {
      ...emptyPayload(),
      context: contextData(tradeDate),
      limitPools: limitPoolsData(tradeDate),
      themes: themesData(tradeDate),
      dragonTiger: dragonTigerData(tradeDate),
      analysis: analysisData(tradeDate),
      dashboard: dashboardData(),
    }
  }

  it('serves every group from the latest snapshot without calling providers', async () => {
    const { database, market, service, tradingDay } = fixture(CLOSED_NOW)
    database.upsertTradingDaySnapshot({
      tradeDate: OPEN_TRADE_DATE,
      capturedAt: '2026-10-23T07:00:00.000Z',
      status: 'complete',
      schemaVersion: 1,
      payload: seedComplete(OPEN_TRADE_DATE),
    })

    await expect(service.call('tradingDay.context', { save: true }, signal))
      .resolves.toMatchObject({ tradeDate: OPEN_TRADE_DATE })
    await expect(service.call('tradingDay.limitPools', { save: true }, signal))
      .resolves.toMatchObject({ tradeDate: OPEN_TRADE_DATE })
    await expect(service.call('tradingDay.themes', { save: true }, signal))
      .resolves.toMatchObject({ tradeDate: OPEN_TRADE_DATE })
    await expect(service.call('tradingDay.dragonTiger', { save: true }, signal))
      .resolves.toMatchObject({ tradeDate: OPEN_TRADE_DATE })
    await expect(service.call('tradingDay.analyze', { save: true }, signal))
      .resolves.toMatchObject({ tradeDate: OPEN_TRADE_DATE })
    await expect(service.call('dashboard.get', { refresh: true }, signal))
      .resolves.toMatchObject({ overview: { marketStatus: 'closed' } })

    expect(tradingDay.calls).toEqual([])
    expect(market.getDashboard).not.toHaveBeenCalled()
    database.close()
  })

  it('falls back to providers when no snapshot exists yet', async () => {
    const { database, service, tradingDay } = fixture(CLOSED_NOW)
    await expect(service.call('tradingDay.context', { save: true }, signal))
      .resolves.toMatchObject({ tradeDate: OPEN_TRADE_DATE })
    expect(tradingDay.calls).toEqual(['tradingDayContext'])
    database.close()
  })

  it('keeps using live providers during market hours even when a snapshot exists', async () => {
    const { database, service, tradingDay } = fixture(OPEN_NOW)
    database.upsertTradingDaySnapshot({
      tradeDate: OPEN_TRADE_DATE,
      capturedAt: '2026-10-23T01:00:00.000Z',
      status: 'complete',
      schemaVersion: 1,
      payload: seedComplete(OPEN_TRADE_DATE),
    })
    await service.call('tradingDay.context', { save: true }, signal)
    expect(tradingDay.calls).toEqual(['tradingDayContext'])
    database.close()
  })
})
