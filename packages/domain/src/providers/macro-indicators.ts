import { MACRO_INDICATORS, type MacroIndicatorId, type MacroIndicatorData } from '../../../contracts/src/macro-indicators.ts'
import { isMarketDate } from '../../../contracts/src/market-history.ts'
import type { MacroRange } from '../../../contracts/src/macro-range.ts'
import { isoNow, type Clock, type HttpClient } from '../http.ts'
import type { SourceCircuit } from './source-circuit.ts'
import { fetchArms } from './market-arms.ts'

const reports = {
  loans: { report: 'RPT_ECONOMY_RMB_LOAN', fields: { increment: 'RMB_LOAN' } },
  money: { report: 'RPT_ECONOMY_CURRENCY_SUPPLY', fields: { m1: 'CURRENCY_SAME', m2: 'BASIC_CURRENCY_SAME' } },
  pmi: { report: 'RPT_ECONOMY_PMI', fields: { manufacturing: 'MAKE_INDEX', nonManufacturing: 'NMAKE_INDEX' } },
  industry: { report: 'RPT_ECONOMY_INDUS_GROW', fields: { yoy: 'BASE_SAME', ytd: 'BASE_ACCUMULATE' } },
  retail: { report: 'RPT_ECONOMY_TOTAL_RETAIL', fields: { yoy: 'RETAIL_TOTAL_SAME', ytd: 'RETAIL_ACCUMULATE_SAME' } },
  cpi: { report: 'RPT_ECONOMY_CPI', fields: { yoy: 'NATIONAL_SAME', mom: 'NATIONAL_SEQUENTIAL' } },
  ppi: { report: 'RPT_ECONOMY_PPI', fields: { yoy: 'BASE_SAME' } },
  yields: { report: 'RPTA_WEB_TREASURYYIELD', fields: { y2: 'EMM00588704', y5: 'EMM00166462', y10: 'EMM00166466', y30: 'EMM00166469' } },
} as const

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const numeric = (value: unknown): number | null => {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !/^-?\d+(?:\.\d+)?$/.test(value.trim())) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}
export function macroPeriodEnd(month: string): string | null {
  if (!/^\d{4}-\d{2}$/.test(month) || Number(month.slice(5)) < 1 || Number(month.slice(5)) > 12) return null
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10)
}

export function parseMacroIndicator(id: MacroIndicatorId, raw: unknown, range: MacroRange, fetchedAt: string): MacroIndicatorData {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(object)) throw new Error('公开来源未返回有效观测记录')
  const definition = MACRO_INDICATORS.find(row => row.id === id)!
  if (id === 'arms') throw new Error('市场广度使用独立数据解析')
  const fields: Record<string, string> = id === 'social' ? { increment: 'tiosfs' } : reports[id].fields
  const points = raw.map(row => {
    const rawDate = id === 'social' ? String(row.date ?? '').replace(/^(\d{4})(\d{2})$/, '$1-$2') : String(row[id === 'yields' ? 'SOLAR_DATE' : 'REPORT_DATE'] ?? '').slice(0, 10)
    const date = definition.frequency === 'monthly' ? macroPeriodEnd(rawDate.slice(0, 7)) : isMarketDate(rawDate) ? rawDate : null
    if (date === null) throw new Error('公开来源统计期无效')
    const values = Object.fromEntries(Object.entries(fields).map(([key, field]) => {
      if (!(field in row)) throw new Error(`公开来源缺少字段 ${field}`)
      return [key, numeric(row[field])]
    }))
    return { date, values }
  }).sort((a, b) => a.date.localeCompare(b.date))
  if (!points.some(point => Object.values(point.values).some(value => value !== null))) throw new Error('来源全部为空值，保留原数据')
  const latest = points.filter(point => point.date <= new Date(Date.parse(fetchedAt) + 8 * 3_600_000).toISOString().slice(0, 10)).at(-1)?.date ?? null
  return { id, checkedRange: range, points: [...new Map(points.filter(point => point.date >= range.from && point.date <= range.to).map(point => [point.date, point])).values()],
    meta: { providerId: id === 'social' ? 'mofcom-macro' : 'eastmoney-macro', sourceName: id === 'social' ? '商务部商务数据中心（原始来源：中国人民银行）' : '东方财富经济数据（公开接口）', sourceTimestamp: latest, fetchedAt, cacheState: 'fresh' } }
}

/** Uses AKShare's public upstreams directly; no Python service, credentials or embedded token. */
export class MacroIndicatorProvider {
  constructor(private readonly http: HttpClient, private readonly clock: Clock, private readonly circuit: SourceCircuit) {}
  async get(id: MacroIndicatorId, range: MacroRange, signal?: AbortSignal): Promise<MacroIndicatorData> {
    if (id === 'arms') return this.circuit.run('88ai-arms', async () => {
      const result = await fetchArms(this.http, this.clock, 'daily', signal)
      const now = new Date(this.clock.now() + 8 * 3_600_000)
      const today = now.toISOString().slice(0, 10)
      const closed = now.getUTCHours() * 60 + now.getUTCMinutes() >= 905
      let todayClosed = false
      if (closed && result.points.some(point => point.date === today)) {
        try {
          const intraday = await fetchArms(this.http, this.clock, 'intraday', signal)
          const last = intraday.points.at(-1)!
          todayClosed = last.date === today && last.time !== null && last.time >= '15:00'
        } catch { /* An unconfirmed close stays out of the daily series. */ }
      }
      const points = result.points.filter(point => point.date >= range.from && point.date <= range.to && (point.date < today || (point.date === today && todayClosed)))
        .map(point => ({ date: point.date, values: { trin: point.trin, adRatio: point.adRatio, amountRatio: point.amountRatio }, estimated: point.estimated, armsDetails: { upCount: point.upCount, downCount: point.downCount, upAmount: point.upAmount, downAmount: point.downAmount } }))
      if (!points.some(point => point.values.trin !== null)) throw new Error('88AI 未返回所选范围的有效收盘历史')
      return { id, points, checkedRange: { from: points[0]!.date, to: points.at(-1)!.date }, meta: { ...result.meta, sourceTimestamp: points.at(-1)!.date } }
    })
    return this.circuit.run(id === 'social' ? 'mofcom-macro' : 'eastmoney-macro', async () => {
      if (id === 'social') {
        const response = await this.http.request('https://data.mofcom.gov.cn/datamofcom/front/gnmy/shrzgmQuery', { method: 'POST', timeoutMs: 20_000, ...(signal ? { signal } : {}) })
        if (response.status !== 200) throw new Error(`商务部接口 HTTP ${response.status}`)
        return parseMacroIndicator(id, JSON.parse(response.body), range, isoNow(this.clock))
      }
      const definition = reports[id]
      const dateField = id === 'yields' ? 'SOLAR_DATE' : 'REPORT_DATE'
      const rows: unknown[] = []
      let pages = 1
      for (let page = 1; page <= pages; page++) {
        const params = new URLSearchParams({ reportName: definition.report, columns: [dateField, ...Object.values(definition.fields)].join(','), pageSize: '500', pageNumber: String(page), sortColumns: dateField, sortTypes: '-1', source: 'WEB', client: 'WEB' })
        // Month reports use the first day as period ID, not their publication date.
        params.set('filter', `(${dateField}>='${id === 'yields' ? range.from : range.from.slice(0, 7) + '-01'}')(${dateField}<='${range.to}')`)
        const response = await this.http.request(`https://datacenter-web.eastmoney.com/api/data/v1/get?${params}`, { timeoutMs: 20_000, ...(signal ? { signal } : {}) })
        if (response.status !== 200) throw new Error(`东方财富接口 HTTP ${response.status}`)
        const json: unknown = JSON.parse(response.body)
        if (!object(json) || json.success !== true || !object(json.result) || !Array.isArray(json.result.data)
          || !Number.isSafeInteger(json.result.pages) || Number(json.result.pages) < 1 || Number(json.result.pages) > 50) throw new Error('公开接口报告无效或未收录所选历史区间')
        pages = Number(json.result.pages)
        rows.push(...json.result.data)
      }
      return parseMacroIndicator(id, rows, range, isoNow(this.clock))
    })
  }
}
