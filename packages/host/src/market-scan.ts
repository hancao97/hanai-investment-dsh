import { createHash } from 'node:crypto'
import { normalizeScanQuery, scanQueryError, type MarketScanData, type MarketScanQuery, type MarketScanResult } from '../../contracts/src/market-scan.ts'
import { marketHistoryPanel } from '../../contracts/src/market-history.ts'
import { isMarketOpen } from '../../contracts/src/market-hours.ts'
import type { MarketHistoryStore } from '../../domain/src/market-history.ts'
import type { HanaiDatabase } from '../../domain/src/database.ts'

export function scanHistoryKey(query: MarketScanQuery): `scan:${string}` {
  return `scan:${createHash('sha256').update(JSON.stringify(normalizeScanQuery(query))).digest('hex')}`
}
export class MarketScanService {
  constructor(private readonly load: (query: MarketScanQuery, refresh: boolean) => Promise<MarketScanData | null>, private readonly history: MarketHistoryStore, private readonly database: HanaiDatabase) {}
  dates(query: MarketScanQuery) { return this.history.list().filter(row => row.panels.includes(scanHistoryKey(query))) }
  async query(input: MarketScanQuery, date?: string, refresh = false): Promise<MarketScanResult> {
    const invalid = scanQueryError(input); if (invalid) throw new Error(invalid)
    const query = normalizeScanQuery(input), key = scanHistoryKey(query)
    const read = (day: string) => { const stored = marketHistoryPanel(this.history.get(day, key), key); return stored && JSON.stringify(stored.query) === JSON.stringify(query) ? stored : null }
    if (date) {
      if (refresh) throw new Error('历史扫描只读，不能请求实时刷新')
      const data = read(date)
      return { data, error: data === null ? '该日期未保存相同筛选、排序与页码的扫描结果' : null, historical: true }
    }
    const latest = this.dates(query)[0]
    const saved = latest ? read(latest.date) : null
    if (refresh) {
      const available = Number(this.database.getSetting('scan.manualRefreshAvailableAt') ?? 0)
      if (available > Date.now()) throw new Error(`扫描手动刷新冷却中，请在 ${Math.ceil((available - Date.now()) / 1000)} 秒后重试`)
      this.database.setSetting('scan.manualRefreshAvailableAt', String(Date.now() + 60_000))
    } else if (saved && Date.parse(saved.meta.fetchedAt) + (isMarketOpen() ? 25_000 : 6 * 3_600_000) > Date.now() && ['fresh', 'cached'].includes(saved.meta.cacheState)) {
      return { data: { ...saved, meta: { ...saved.meta, cacheState: 'cached' } }, error: null, historical: false }
    }
    let error: string | null = null
    let data: MarketScanData | null = null
    try { data = await this.load(query, refresh) } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
    if (data === null || data.meta.cacheState === 'stale' || data.meta.cacheState === 'unavailable') {
      const previous = data?.meta.cacheState === 'stale' ? data : saved
      return { data: previous ? { ...previous, meta: { ...previous.meta, cacheState: 'stale' } } : null, error: error ?? '88AI 扫描源不可用，保留同查询快照；无同口径备源', historical: false }
    }
    if (saved?.snapshotDate && data.snapshotDate && data.snapshotDate < saved.snapshotDate) return { data: { ...saved, meta: { ...saved.meta, cacheState: 'stale' } }, error: '来源快照日期倒退，保留较新同查询快照', historical: false }
    this.history.save(key, data, data.meta, data.snapshotDate ?? data.collectedOn)
    return { data, error: null, historical: false }
  }
}
