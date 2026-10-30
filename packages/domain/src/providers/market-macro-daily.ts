import { macroRangeThrough, type MacroRange } from '../../../contracts/src/macro-range.ts'
import { MACRO_ETFS, type MacroDailyEtfData, type MacroIndexData, type MacroEtfInputs } from '../../../contracts/src/market-macro.ts'
import { beijingMarketDate, isMarketDate } from '../../../contracts/src/market-history.ts'
import { MarketMacroInputs, macroPositive as positive } from './market-macro-inputs.ts'
export { parseUnitNav } from './market-macro-inputs.ts'
import { isoNow, type Clock, type HttpClient } from '../http.ts'
import { ProviderCache } from './cache.ts'
import type { SourceCircuit } from './source-circuit.ts'

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export function parseShanghaiShares(raw: unknown, date: string): Map<string, number> {
  if (!object(raw) || !object(raw.pageHelp) || !Array.isArray(raw.result)
    || Number(raw.pageHelp.total) !== raw.result.length || Number(raw.pageHelp.pageCount) !== 1) throw new Error('上交所份额未完整返回')
  const result = new Map<string, number>()
  for (const row of raw.result) {
    if (!object(row) || row.STAT_DATE !== date) throw new Error('上交所份额日期不匹配')
    if (!MACRO_ETFS.slice(0, 3).some(fund => fund.code === row.SEC_CODE)) continue
    if (typeof row.SEC_CODE !== 'string' || result.has(row.SEC_CODE)) throw new Error('上交所基金代码重复')
    result.set(row.SEC_CODE, positive(row.TOT_VOL))
  }
  if (result.size !== 3) throw new Error('上交所三只ETF份额缺失')
  return result
}


/** Independent four-fund output, using the same persisted inputs as the directory total. */
export class MarketMacroDailyProvider {
  private readonly batches: ProviderCache<MacroDailyEtfData>
  readonly inputs: MarketMacroInputs
  constructor(private readonly http: HttpClient, private readonly clock: Clock, private readonly circuit: SourceCircuit,
    private readonly index: (range?: MacroRange) => Promise<MacroIndexData | null>, inputs?: MarketMacroInputs) {
    this.inputs = inputs ?? new MarketMacroInputs(http, clock, circuit)
    this.batches = new ProviderCache(clock, 60_000)
  }

  async get(previous: MacroDailyEtfData | null, seed: MacroEtfInputs | null = null, range?: MacroRange): Promise<MacroDailyEtfData | null> {
    this.inputs.restore(seed)
    const stale = () => previous === null ? null : { ...previous, meta: { ...previous.meta, cacheState: 'stale' as const } }
    try {
      const { from, to } = range ?? macroRangeThrough(beijingMarketDate(this.clock.now()))
      const navs = new Map<string, Map<string, number>>()
      for (const fund of MACRO_ETFS) navs.set(fund.code, await this.inputs.nav(fund.code, range))
      const calendar = await this.index(range)
      if (calendar === null || ['unavailable', 'stale'].includes(calendar.meta.cacheState)) return stale()
      const navThrough = [...navs.get('510300')!.keys()].filter(date => [...navs.values()].every(fund => fund.has(date))).sort().at(-1)
      const dates = calendar.points.map(point => point.date).filter(date => date >= from && date <= to && date <= (navThrough ?? '')).sort()
      const latest = dates.at(-1)
      if (latest === undefined) return stale()
      const points = new Map((previous?.points ?? []).filter(point => dates.includes(point.date)).map(point => [point.date, point.assets]))
      const refresh = previous !== null && this.clock.now() - Date.parse(previous.meta.fetchedAt) >= 6 * 3_600_000
      const pending = dates.filter(date => !points.has(date) || (refresh && date === latest)).reverse()
      const windowStart = Date.parse(`${pending[0] ?? latest}T00:00:00+08:00`) - 31 * 86_400_000
      const missing = pending.filter(date => Date.parse(`${date}T00:00:00+08:00`) >= windowStart).slice(0, 8).sort()
      if (missing.length === 0) return previous === null ? null : { ...previous, points: [...points].sort(([a], [b]) => a.localeCompare(b)).map(([date, assets]) => ({ date, assets })), expectedDays: dates.length, complete: points.size === dates.length }
      const result = await this.batches.get(`${from}:${to}:${points.size}:${missing.join(',')}`, async () => {
        await this.inputs.shares(MACRO_ETFS.map(fund => fund.code), missing, latest)
        for (const date of missing) {
          let assets = 0
          for (const fund of MACRO_ETFS) {
            const shares = this.inputs.share(fund.code, date, latest), nav = navs.get(fund.code)!.get(date)
            if (shares === undefined || nav === undefined) throw new Error(`${fund.code} ${date} 日份额或净值缺失`)
            assets += shares * nav / 10_000
          }
          points.set(date, Math.round(assets * 100) / 100)
        }
        const rows = [...points].sort(([a], [b]) => a.localeCompare(b)).map(([date, assets]) => ({ date, assets }))
        return { points: rows, expectedDays: dates.length, complete: rows.length === dates.length,
          meta: { providerId: 'exchange-etf-nav', sourceName: '上交所/深交所日份额 × 东方财富单位净值', sourceTimestamp: rows.at(-1)!.date, fetchedAt: isoNow(this.clock), cacheState: 'fresh' } }
      })
      return result ?? stale()
    } catch { return stale() }
  }

  clear(): number { return this.batches.clear() + this.inputs.clear() }
}
