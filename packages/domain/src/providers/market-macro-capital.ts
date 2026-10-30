import { macroRangeThrough, type MacroRange } from '../../../contracts/src/macro-range.ts'
import type { MacroCapitalData } from '../../../contracts/src/market-macro.ts'
import { beijingMarketDate, isMarketDate } from '../../../contracts/src/market-history.ts'
import { isoNow, type Clock, type HttpClient } from '../http.ts'
import { ProviderCache } from './cache.ts'
import type { SourceCircuit } from './source-circuit.ts'
import { SSE_LEGACY_CAPITAL_REPORTS } from './market-macro-capital-legacy.ts'
import type { MarketMacroCapitalReferenceProvider } from './market-macro-capital-reference.ts'

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export function parseMacroCapital(raw: unknown, month: string): MacroCapitalData['points'] {
  if (!object(raw) || raw.error != null || raw.success === false || !Array.isArray(raw.result)) throw new Error('上交所沪深300月报格式错误')
  const points = new Map<string, number>()
  for (const row of raw.result) {
    if (!object(row) || typeof row.MDATE !== 'string' || !/^\d{8}$/.test(row.MDATE) || !row.MDATE.startsWith(month)) throw new Error('沪深300月报日期不匹配')
    const date = `${row.MDATE.slice(0, 4)}-${row.MDATE.slice(4, 6)}-${row.MDATE.slice(6)}`
    const value = row.CPT_NGT
    const floatCap = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value
    if (!isMarketDate(date) || points.has(date) || typeof floatCap !== 'number' || !Number.isFinite(floatCap) || floatCap <= 0) throw new Error('沪深300流通市值无效')
    points.set(date, floatCap)
  }
  return [...points].sort(([a], [b]) => a.localeCompare(b)).map(([date, floatCap]) => ({ date, floatCap }))
}

export class MarketMacroCapitalProvider {
  private readonly cache: ProviderCache<MacroCapitalData>
  constructor(private readonly http: HttpClient, private readonly clock: Clock, private readonly circuit: SourceCircuit, private readonly reference?: MarketMacroCapitalReferenceProvider) {
    this.cache = new ProviderCache(clock, 60_000)
  }

  async get(previous: MacroCapitalData | null, retryMissing = false, range?: MacroRange): Promise<MacroCapitalData | null> {
    const seed = previous === null ? null : { ...previous, meta: previous.officialMeta ?? previous.meta }
    let monthly = await this.monthly(seed, range)
    if (monthly === null && range !== undefined) {
      const before = new Date(`${range.from.slice(0, 7)}-01T00:00:00Z`)
      before.setUTCMonth(before.getUTCMonth() - 1)
      monthly = await this.monthly(seed, { ...range, from: before.toISOString().slice(0, 10) })
    }
    if (monthly === null) return null
    let result = monthly
    if (monthly.complete && monthly.meta.cacheState !== 'stale' && this.reference !== undefined) {
      try {
        const reference = await this.reference.get(previous?.reference, monthly.points.at(-1)!.date, retryMissing, range)
        result = { ...monthly, reference: reference.expectedDays === 0 ? undefined : reference, referenceError: undefined, complete: reference.complete }
      } catch (error) {
        result = { ...monthly, reference: previous?.reference, referenceError: error instanceof Error ? error.message : '重建参考不可用', complete: false }
      }
    }
    if (result.reference === undefined) return result
    const sourceTimestamp = [result.points.at(-1)!.date, result.reference.points.at(-1)?.date ?? ''].sort().at(-1)!
    const fetchedAt = Date.parse(result.meta.fetchedAt) >= Date.parse(result.reference.meta.fetchedAt) ? result.meta.fetchedAt : result.reference.meta.fetchedAt
    return { ...result, officialMeta: result.meta, meta: { ...result.meta, providerId: 'macro-capital', sourceName: '上交所月报＋分母重建参考（分项来源另列）', sourceTimestamp, fetchedAt } }
  }

  private async monthly(previous: MacroCapitalData | null, range?: MacroRange): Promise<MacroCapitalData | null> {
    const { from, to } = range ?? macroRangeThrough(beijingMarketDate(this.clock.now()))
    const months: string[] = []
    for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const key = `${year}${String(month).padStart(2, '0')}`
        if (key >= from.slice(0, 7).replace('-', '') && key <= to.slice(0, 7).replace('-', '')) months.push(key)
      }
    }
    const checked = new Set((previous?.checkedMonths ?? []).filter(month => months.includes(month)))
    const refresh = new Set((previous?.refreshMonths ?? []).filter(month => months.includes(month)))
    const points = new Map((previous?.points ?? []).filter(point => point.date >= from && point.date <= to).map(point => [point.date, point.floatCap]))
    const anchor = previous?.points.filter(point => point.date < from).at(-1)
    if (anchor !== undefined) { points.set(anchor.date, anchor.floatCap); checked.add(anchor.date.slice(0, 7).replace('-', '')) }
    let supplemented = false
    for (const report of SSE_LEGACY_CAPITAL_REPORTS) {
      if (!checked.has(report.month)) continue
      for (const point of report.points) {
        if (point.date >= from && point.date <= to && !points.has(point.date)) {
          points.set(point.date, point.floatCap)
          supplemented = true
        }
      }
    }
    const snapshot = (): MacroCapitalData => {
      const rows = [...points].sort(([a], [b]) => a.localeCompare(b)).map(([date, floatCap]) => ({ date, floatCap }))
      if (rows.length === 0) throw new Error('沪深300月报尚无可用流通市值')
      return { points: rows, checkedMonths: [...checked].sort(), refreshMonths: [...refresh].sort(), reference: previous?.reference, complete: months.every(month => checked.has(month)) && refresh.size === 0,
        meta: { providerId: 'sse-statistics', sourceName: rows.some(point => point.date < '2021-12-01') ? '上交所统计月报·沪深300流通市值（含2021年10—11月官方PDF，亿元）' : '上交所统计月报·沪深300流通市值（亿元）', sourceTimestamp: rows.at(-1)!.date, fetchedAt: isoNow(this.clock), cacheState: 'fresh' } }
    }
    // Recheck unpublished/revised recent months on a later manual generation, never on a timer.
    if (previous !== null && this.clock.now() - Date.parse(previous.meta.fetchedAt) >= 6 * 3_600_000) {
      for (const month of months.slice(-2)) refresh.add(month)
    }
    const pending = months.filter(month => !checked.has(month) || refresh.has(month)).reverse().slice(0, 6)
    if (supplemented) return snapshot()
    if (pending.length === 0) return previous === null ? null : { ...previous, complete: true }
    const result = await this.cache.get(`${from}:${to}:${[...checked].sort().join(',')}`, () => this.circuit.run('sse-statistics', async () => {
      for (const month of pending) {
        const report = SSE_LEGACY_CAPITAL_REPORTS.find(report => report.month === month)
        if (report !== undefined) {
          for (const point of report.points) if (point.date >= from && point.date <= to && !points.has(point.date)) points.set(point.date, point.floatCap)
          checked.add(month)
          refresh.delete(month)
          continue
        }
        const params = new URLSearchParams({ sqlId: 'COMMON_SSE_ZQZS_M_CSI300_INDEX_C', isPagination: 'false', MDATE: month })
        const response = await this.http.request(`https://query.sse.com.cn/commonQuery.do?${params}`, {
          timeoutMs: 5000, headers: { Referer: 'https://www.sse.com.cn/aboutus/publication/monthly/index/' },
        })
        if (response.status !== 200) throw new Error(`沪深300月报 HTTP ${response.status}`)
        for (const point of parseMacroCapital(JSON.parse(response.body), month)) if (point.date >= from && point.date <= to) points.set(point.date, point.floatCap)
        checked.add(month)
        refresh.delete(month)
        await this.clock.sleep(300)
      }
      return snapshot()
    }))
    return result ?? (previous === null ? null : { ...previous, meta: { ...previous.meta, cacheState: 'stale' } })
  }

  clear(): number { return this.cache.clear() }
}
