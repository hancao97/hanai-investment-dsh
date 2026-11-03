import { macroRangeThrough, type MacroRange } from '../../../contracts/src/macro-range.ts'
import type { MacroCapitalReference, MacroIndexData } from '../../../contracts/src/market-macro.ts'
import { beijingMarketDate, isMarketDate } from '../../../contracts/src/market-history.ts'
import { isoNow, type Clock, type HttpClient } from '../http.ts'
import type { SourceCircuit } from './source-circuit.ts'
import { queryBaoStockMembers, type MacroMembers } from './baostock-members.ts'

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export class MarketMacroCapitalReferenceProvider {
  constructor(private readonly http: HttpClient, private readonly clock: Clock, private readonly circuit: SourceCircuit,
    private readonly index: (range?: MacroRange) => Promise<MacroIndexData | null>, private readonly members: (date: string) => Promise<MacroMembers> = queryBaoStockMembers) {}

  async get(previous: MacroCapitalReference | undefined, after: string, retryMissing: boolean, range?: MacroRange): Promise<MacroCapitalReference> {
    const index = await this.index(range)
    if (index === null || ['stale', 'unavailable'].includes(index.meta.cacheState)) throw new Error('重建分母缺少可核实的交易日历')
    const today = beijingMarketDate(this.clock.now())
    const beijing = new Date(this.clock.now() + 8 * 3_600_000)
    const closed = beijing.getUTCHours() * 60 + beijing.getUTCMinutes() >= 905
    const dates = index.points.map(point => point.date).filter(date => date > after && (date < today || (date === today && closed)))
    const wanted = new Set(dates)
    const points = new Map((previous?.points ?? []).filter(point => wanted.has(point.date)).map(point => [point.date, point]))
    const missing = new Map((previous?.missingDates ?? []).filter(row => wanted.has(row.date)).map(row => [row.date, row.reason]))
    const checked = new Set((previous?.checkedDates ?? []).filter(date => wanted.has(date) && (!retryMissing || !missing.has(date))))
    if (retryMissing) for (const date of missing.keys()) missing.delete(date)
    const pending = dates.filter(date => !checked.has(date)).reverse().slice(0, 8)
    if (pending.length === 0 && previous !== undefined && previous.expectedDays === dates.length && previous.points.every(point => wanted.has(point.date))) return previous
    for (const date of pending) {
      try {
        const membership = await this.circuit.run('baostock', () => this.members(date))
        if (membership.codes.length !== 300 || new Set(membership.codes).size !== 300 || membership.codes.some(code => !/^\d{6}$/.test(code))
          || !isMarketDate(membership.updatedOn) || membership.updatedOn > date || Date.parse(date) - Date.parse(membership.updatedOn) > 7 * 86_400_000) throw new Error('成分周快照无效')
        const caps = await this.circuit.run('eastmoney-valuation', async () => {
          const values = new Map<string, number>()
          let total: number | null = null
          for (let page = 1; page <= 3; page += 1) {
            const params = new URLSearchParams({ reportName: 'RPT_VALUEANALYSIS_DET', columns: 'SECURITY_CODE,TRADE_DATE,NOTLIMITED_MARKETCAP_A',
              filter: `(SECURITY_CODE in ("${membership.codes.join('","')}"))(TRADE_DATE='${date}')`, pageSize: '300', pageNumber: String(page), sortColumns: 'SECURITY_CODE', sortTypes: '1' })
            const response = await this.http.request(`https://datacenter-web.eastmoney.com/api/data/v1/get?${params}`, { timeoutMs: 10_000 })
            if (response.status !== 200) throw new Error(`逐股流通市值 HTTP ${response.status}`)
            const raw: unknown = JSON.parse(response.body)
            if (!object(raw) || raw.success !== true || !object(raw.result) || !Array.isArray(raw.result.data) || raw.result.count !== 300
              || !Number.isSafeInteger(raw.result.pages) || Number(raw.result.pages) < 1 || Number(raw.result.pages) > 3) throw new Error('逐股流通市值未完整返回300只')
            total ??= Number(raw.result.pages)
            if (total !== raw.result.pages) throw new Error('逐股流通市值分页变化')
            for (const row of raw.result.data) {
              if (!object(row) || typeof row.SECURITY_CODE !== 'string' || !membership.codes.includes(row.SECURITY_CODE) || values.has(row.SECURITY_CODE)
                || row.TRADE_DATE !== `${date} 00:00:00` || typeof row.NOTLIMITED_MARKETCAP_A !== 'number' || !Number.isFinite(row.NOTLIMITED_MARKETCAP_A) || row.NOTLIMITED_MARKETCAP_A <= 0) throw new Error('逐股流通市值代码、日期或数值无效')
              values.set(row.SECURITY_CODE, row.NOTLIMITED_MARKETCAP_A)
            }
            if (page === total) break
            await this.clock.sleep(300)
          }
          if (values.size !== 300) throw new Error('缺少成分股同日流通市值')
          return [...values.values()].reduce((sum, value) => sum + value, 0) / 1e8
        })
        points.set(date, { date, floatCap: caps, membershipDate: membership.updatedOn })
        missing.delete(date)
      } catch (error) {
        missing.set(date, error instanceof Error ? error.message.slice(0, 200) : '重建取数失败')
      }
      checked.add(date)
      await this.clock.sleep(300)
    }
    const rows = [...points.values()].sort((a, b) => a.date.localeCompare(b.date))
    return { points: rows, checkedDates: [...checked].sort(), missingDates: [...missing].sort(([a], [b]) => a.localeCompare(b)).map(([date, reason]) => ({ date, reason })),
      expectedDays: dates.length, complete: dates.every(date => checked.has(date)),
      meta: { providerId: 'baostock-eastmoney', sourceName: 'BaoStock历史成分周快照 × 东方财富同日个股流通市值之和（重建参考，亿元）', sourceTimestamp: rows.at(-1)?.date ?? null, fetchedAt: isoNow(this.clock), cacheState: 'fresh' } }
  }
}
