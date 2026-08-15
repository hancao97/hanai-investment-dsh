import { pinyin } from 'pinyin-pro'
import type { SearchResult, SecurityMaster, StockQuote } from '../../contracts/src/index.ts'
import type { HanaiDatabase, SecuritySnapshotRow } from './database.ts'
import { systemClock, type Clock } from './http.ts'
import type { EastmoneySecurityRow } from './providers/eastmoney.ts'

export const SECURITY_SYNCED_AT_SETTING = 'security.master.syncedAt'
const DEFAULT_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface SecurityDataProvider {
  getAllSecurities(): Promise<EastmoneySecurityRow[]>
  getQuotes(secIds: readonly string[]): Promise<{ quotes: StockQuote[] }>
}

export interface SecuritiesServiceOptions {
  clock?: Clock
  syncIntervalMs?: number
  minimumSnapshotSize?: number
}

function exchangeOf(market: number, code: string): SecurityMaster['exchange'] {
  if (market === 1) return 'SH'
  if (code.startsWith('4') || code.startsWith('8') || code.startsWith('9')) return 'BJ'
  return 'SZ'
}

function pinyinFields(name: string): Pick<SecurityMaster, 'pinyinFull' | 'pinyinInitial'> {
  const pinyinFull = pinyin(name, { toneType: 'none', type: 'array' }).join('').toLowerCase()
  const pinyinInitial = pinyin(name, { pattern: 'first', toneType: 'none', type: 'array' }).join('').toLowerCase()
  return { pinyinFull, pinyinInitial }
}

export class SecuritiesService {
  private readonly clock: Clock
  private readonly syncIntervalMs: number
  private readonly minimumSnapshotSize: number

  constructor(
    private readonly database: HanaiDatabase,
    private readonly provider: SecurityDataProvider,
    options: SecuritiesServiceOptions = {},
  ) {
    this.clock = options.clock ?? systemClock
    this.syncIntervalMs = options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS
    this.minimumSnapshotSize = Math.max(1000, options.minimumSnapshotSize ?? 1000)
  }

  get(secId: string): SecurityMaster | null {
    return this.database.getSecurity(secId)
  }

  syncedAt(): string | null {
    return this.database.getSetting(SECURITY_SYNCED_AT_SETTING)
  }

  async sync(force = false): Promise<{ count: number; updatedAt: string | null }> {
    const previousCount = this.database.securityCount()
    const previousUpdatedAt = this.syncedAt()
    const previousTimestamp = previousUpdatedAt === null ? NaN : Date.parse(previousUpdatedAt)
    if (
      !force
      && previousCount > 0
      && Number.isFinite(previousTimestamp)
      && this.clock.now() - previousTimestamp < this.syncIntervalMs
    ) {
      return { count: previousCount, updatedAt: previousUpdatedAt }
    }

    const fetched = await this.provider.getAllSecurities()
    const updatedAt = new Date(this.clock.now()).toISOString()
    const unique = new Map<string, SecuritySnapshotRow>()
    for (const item of fetched) {
      const code = item.code.trim()
      const name = item.name.trim()
      if (code === '' || name === '' || !Number.isInteger(item.market)) continue
      const secId = `${item.market}.${code}`
      unique.set(secId, {
        secId,
        code,
        name,
        exchange: exchangeOf(item.market, code),
        ...pinyinFields(name),
        updatedAt,
      })
    }
    if (unique.size < this.minimumSnapshotSize) {
      if (previousCount > 0) return { count: previousCount, updatedAt: previousUpdatedAt }
      throw new Error(`主数据拉取不完整（${unique.size} 条），保留现状待重试`)
    }

    this.database.replaceSecuritySnapshot([...unique.values()])
    this.database.setSetting(SECURITY_SYNCED_AT_SETTING, updatedAt)
    return { count: this.database.securityCount(), updatedAt }
  }

  async search(query: string, limit = 20): Promise<SearchResult[]> {
    const securities = this.database.searchSecurities(query, limit)
    if (securities.length === 0) return []
    const results: SearchResult[] = securities.map(security => ({
      ...security,
      price: null,
      changePct: null,
    }))
    try {
      const response = await this.provider.getQuotes(securities.map(security => security.secId))
      const quotes = new Map(response.quotes.map(quote => [quote.secId, quote]))
      for (const result of results) {
        const quote = quotes.get(result.secId)
        if (quote === undefined) continue
        result.price = quote.price
        result.changePct = quote.changePct
      }
    } catch {
      // Local search stays useful while the market provider is unavailable.
    }
    return results
  }
}
