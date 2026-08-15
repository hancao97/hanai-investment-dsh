import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderMeta, SecurityMaster, ValuationSummary } from '../../../contracts/src/index.ts'
import { fetchJson, isoNow, postJson, systemClock, type Clock, type HttpClient } from '../http.ts'

const PROVIDER_ID = 'gurufocus-cn-prototype'
const SOURCE_NAME = '价值大师网（个人研究接口，未获再分发授权）'
const BASE_URL = 'https://www.gurufocus.cn'
const HEADERS = {
  Referer: 'https://www.gurufocus.cn/',
  'Content-Type': 'application/json',
}
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000

export const VALUATION_RANK_LABELS: Readonly<Record<number, string>> = {
  0: '数据不足',
  1: '数据陈旧',
  2: '价值陷阱嫌疑',
  3: '严重低估',
  4: '低估',
  5: '合理范围',
  6: '高估',
  7: '严重高估',
}

export interface ValuationCacheEntry {
  fetchedAt: string
  summary: ValuationSummary
}

export interface ValuationCache {
  read(key: string): ValuationCacheEntry | null
  write(key: string, entry: ValuationCacheEntry): void
}

export class MemoryValuationCache implements ValuationCache {
  private readonly entries = new Map<string, ValuationCacheEntry>()

  read(key: string): ValuationCacheEntry | null {
    return this.entries.get(key) ?? null
  }

  write(key: string, entry: ValuationCacheEntry): void {
    this.entries.set(key, entry)
  }
}

export class FileValuationCache implements ValuationCache {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
  }

  private pathFor(key: string): string {
    if (!/^[A-Z]{2}-\d{6}$/.test(key)) throw new Error('非法估值缓存键')
    return join(this.directory, `${key}.json`)
  }

  read(key: string): ValuationCacheEntry | null {
    try {
      const path = this.pathFor(key)
      if (!existsSync(path)) return null
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ValuationCacheEntry>
      if (typeof parsed.fetchedAt !== 'string' || parsed.summary === undefined) return null
      return parsed as ValuationCacheEntry
    } catch {
      return null
    }
  }

  write(key: string, entry: ValuationCacheEntry): void {
    try {
      const path = this.pathFor(key)
      writeFileSync(path, JSON.stringify(entry), { encoding: 'utf8', mode: 0o600 })
      chmodSync(path, 0o600)
    } catch {
      // Cache persistence must never make valuation unavailable.
    }
  }
}

interface ScreenerRow {
  symbol?: unknown
  stockid?: unknown
  gf_score?: unknown
  gf_valuation?: unknown
  gf_value?: unknown
  rank_balancesheet?: unknown
  rank_profitability?: unknown
  rank_growth?: unknown
  rank_gf_value?: unknown
  rank_momentum?: unknown
}

interface ScreenerResponse {
  data?: unknown
}

interface ValuationChartResponse {
  iv?: unknown
  medps?: unknown
  price?: unknown
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Number(value.replace(/[,¥$]/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

function rankNumber(value: unknown): number | null {
  if (value !== null && typeof value === 'object' && 'value' in value) {
    return numberOrNull((value as { value?: unknown }).value)
  }
  return numberOrNull(value)
}

function guruFocusExchange(exchange: SecurityMaster['exchange']): 'SHSE' | 'SZSE' | 'BJSE' {
  return exchange === 'SH' ? 'SHSE' : exchange === 'SZ' ? 'SZSE' : 'BJSE'
}

function guruFocusSymbol(exchange: SecurityMaster['exchange'], code: string): string {
  return `${guruFocusExchange(exchange)}:${code}`
}

function series(value: unknown): [string, number][] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!Array.isArray(item) || typeof item[0] !== 'string') return []
    const point = numberOrNull(item[1])
    return point === null ? [] : [[item[0], point] as [string, number]]
  })
}

export interface GuruFocusProviderOptions {
  clock?: Clock
  cache?: ValuationCache
  cacheTtlMs?: number
  timeoutMs?: number
}

export class GuruFocusProvider {
  private readonly clock: Clock
  private readonly cache: ValuationCache
  private readonly cacheTtlMs: number
  private readonly timeoutMs: number

  constructor(
    private readonly http: HttpClient,
    options: GuruFocusProviderOptions = {},
  ) {
    this.clock = options.clock ?? systemClock
    this.cache = options.cache ?? new MemoryValuationCache()
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  private meta(sourceTimestamp: string | null, cacheState: ProviderMeta['cacheState']): ProviderMeta {
    return {
      providerId: PROVIDER_ID,
      sourceName: SOURCE_NAME,
      sourceTimestamp,
      fetchedAt: isoNow(this.clock),
      cacheState,
    }
  }

  private async getScreenerRow(exchange: SecurityMaster['exchange'], code: string): Promise<ScreenerRow | null> {
    const body = {
      exchanges: [guruFocusExchange(exchange)],
      fields: [
        'symbol',
        'company',
        'stockid',
        'gf_value',
        'rank_gf_value',
        'gf_score',
        'rank_balancesheet',
        'rank_profitability',
        'rank_growth',
        'rank_momentum',
        'gf_valuation',
        'yield',
        'total_free_cash_flow',
      ],
      filters: [{ left: 'symbol', operator: '=', right: code }],
      guru_filters: [],
      inst_holding_filters: [],
      insider_filters: [],
      insider_trading_filters: [],
      sorts: 'mktcap_norm|DESC',
      rank_by: '',
      use_in_screener: true,
      page: 1,
      per_page: 3,
    }
    const response = await postJson<ScreenerResponse>(
      this.http,
      `${BASE_URL}/_api/screener?locale=zh-hans`,
      body,
      { timeoutMs: this.timeoutMs, headers: HEADERS },
    )
    const rows = response.ok && Array.isArray(response.data?.data)
      ? response.data.data.filter((row): row is ScreenerRow => row !== null && typeof row === 'object')
      : []
    return rows.find(row => row.symbol === code) ?? rows[0] ?? null
  }

  async getValuation(
    exchange: SecurityMaster['exchange'],
    code: string,
  ): Promise<ValuationSummary | null> {
    const cacheKey = `${exchange}-${code}`
    const cached = this.cache.read(cacheKey)
    const cachedAt = cached === null ? NaN : Date.parse(cached.fetchedAt)
    if (cached !== null && Number.isFinite(cachedAt) && this.clock.now() - cachedAt < this.cacheTtlMs) {
      return { ...cached.summary, meta: { ...cached.summary.meta, cacheState: 'cached' } }
    }

    const symbol = guruFocusSymbol(exchange, code)
    const [chartResponse, row] = await Promise.all([
      fetchJson<ValuationChartResponse>(
        this.http,
        `${BASE_URL}/_api/chart/${encodeURIComponent(symbol)}/valuation?locale=zh-hans`,
        { timeoutMs: this.timeoutMs, headers: HEADERS },
      ),
      this.getScreenerRow(exchange, code),
    ])
    const chart = chartResponse.ok ? chartResponse.data : null
    if (chart === null && row === null) {
      return cached === null
        ? null
        : { ...cached.summary, meta: { ...cached.summary.meta, cacheState: 'stale' } }
    }

    const medpsSeries = series(chart?.medps)
    const priceSeries = series(chart?.price)
    const today = new Date(this.clock.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const currentValue = medpsSeries.filter(([date]) => date <= today).at(-1) ?? null
    const summary: ValuationSummary = {
      stockId: String(row?.stockid ?? symbol),
      ivDcf: numberOrNull(chart?.iv),
      medps: currentValue?.[1] ?? null,
      gfScore: rankNumber(row?.gf_score),
      valuationRank: rankNumber(row?.gf_valuation),
      dimensions: {
        financialStrength: rankNumber(row?.rank_balancesheet),
        profitability: rankNumber(row?.rank_profitability),
        growth: rankNumber(row?.rank_growth),
        gfValue: rankNumber(row?.rank_gf_value),
        momentum: rankNumber(row?.rank_momentum),
      },
      series: { price: priceSeries, medps: medpsSeries },
      meta: this.meta(currentValue?.[0] ?? null, 'fresh'),
    }
    this.cache.write(cacheKey, { fetchedAt: isoNow(this.clock), summary })
    return summary
  }
}
