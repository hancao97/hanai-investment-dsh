import { macroRangeThrough, type MacroRange } from '../../../contracts/src/macro-range.ts'
import type { MacroEtfInputs } from '../../../contracts/src/market-macro.ts'
import { beijingMarketDate, isMarketDate } from '../../../contracts/src/market-history.ts'
import { isoNow, type Clock, type HttpClient } from '../http.ts'
import type { SourceCircuit } from './source-circuit.ts'

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
export function macroPositive(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error('份额或净值缺失')
  const raw = String(value).replace(/,/g, '')
  if (!/^\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(Number(raw)) || Number(raw) <= 0) throw new Error('份额或净值无效')
  return Number(raw)
}

export function parseNavPage(raw: unknown, from: string, to: string) {
  if (!object(raw) || !object(raw.Data) || !Array.isArray(raw.Data.LSJZList) || !Number.isSafeInteger(raw.TotalCount) || Number(raw.TotalCount) < 0) throw new Error('净值分页格式错误')
  const rows = raw.Data.LSJZList.map(row => {
    if (!object(row) || typeof row.FSRQ !== 'string' || !isMarketDate(row.FSRQ) || row.FSRQ < from || row.FSRQ > to) throw new Error('净值分页日期错误')
    return { date: row.FSRQ, value: macroPositive(row.DWJZ) }
  })
  return { rows, total: Number(raw.TotalCount) }
}

/** Extract JSON only: never execute JavaScript returned by a public fund page. */
export function parseUnitNav(body: string, from: string, to: string): Map<string, number> {
  const match = /\bvar\s+Data_netWorthTrend\s*=\s*(\[[^;]*\])\s*;/.exec(body)
  if (match === null) throw new Error('单位净值序列缺失')
  const rows: unknown = JSON.parse(match[1]!)
  if (!Array.isArray(rows)) throw new Error('单位净值格式错误')
  const result = new Map<string, number>()
  for (const row of rows) {
    if (!object(row) || typeof row.x !== 'number' || !Number.isFinite(row.x)) throw new Error('净值日期无效')
    const date = beijingMarketDate(row.x)
    if (date < from || date > to) continue
    const nav = macroPositive(row.y)
    if (result.has(date)) throw new Error('净值日期重复')
    result.set(date, nav)
  }
  if (result.size === 0) throw new Error('区间单位净值不可用')
  return result
}


/** Raw business records are shared by the four-fund and full-directory calculations. */
export class MarketMacroInputs {
  private funds = new Map<string, MacroEtfInputs['funds'][number]>()
  private navFrom = new Map<string, string>()
  private navPending = new Map<string, Promise<Map<string, number>>>()
  private shanghai = new Map<string, { at: number; result: Promise<Map<string, unknown>> }>()
  private updatedAt: string | null = null
  constructor(private readonly http: HttpClient, private readonly clock: Clock, private readonly circuit: SourceCircuit) {}

  restore(seed: MacroEtfInputs | null = null) {
    if (this.funds.size > 0 || seed === null) return
    for (const fund of seed.funds) this.funds.set(fund.code, { ...fund, navs: [...fund.navs], shares: [...fund.shares] })
    this.updatedAt = seed.meta.fetchedAt
  }

  private fund(code: string) {
    let fund = this.funds.get(code)
    if (fund === undefined) { fund = { code, navFetchedAt: '1970-01-01T00:00:00Z', navs: [], shares: [] }; this.funds.set(code, fund) }
    return fund
  }

  nav(code: string, range?: MacroRange): Promise<Map<string, number>> {
    const { from } = range ?? macroRangeThrough(beijingMarketDate(this.clock.now()))
    const key = `${code}:${from}`
    const existing = this.navPending.get(key)
    if (existing !== undefined) return existing
    const fund = this.fund(code)
    const today = beijingMarketDate(this.clock.now())
    const coversStart = range === undefined || (this.navFrom.get(code) ?? '9999') <= from || (fund.navs.length > 0 && Date.parse(fund.navs[0]!.date) - Date.parse(from) <= 7 * 86_400_000)
    if (coversStart && beijingMarketDate(Date.parse(fund.navFetchedAt)) === today && this.clock.now() - Date.parse(fund.navFetchedAt) < 6 * 3_600_000) return Promise.resolve(new Map(fund.navs.map(row => [row.date, row.value])))
    const run = this.circuit.run('eastmoney-fund', async () => {
      const last = fund.navs.at(-1)?.date
      let values: Map<string, number>
      if (!coversStart || last === undefined || this.clock.now() - Date.parse(last) > 120 * 86_400_000) {
        const response = await this.http.request(`https://fund.eastmoney.com/pingzhongdata/${code}.js`, { timeoutMs: 5000 })
        if (response.status !== 200) throw new Error(`单位净值 HTTP ${response.status}`)
        values = parseUnitNav(response.body, from, today)
      } else {
        values = new Map(fund.navs.map(row => [row.date, row.value]))
        const start = new Date(Date.parse(`${last}T12:00:00+08:00`) - 7 * 86_400_000).toISOString().slice(0, 10)
        let total: number | null = null
        const seen = new Set<string>()
        for (let page = 1; page <= 12; page += 1) {
          const params = new URLSearchParams({ fundCode: code, pageIndex: String(page), pageSize: '20', startDate: start, endDate: today })
          const response = await this.http.request(`https://api.fund.eastmoney.com/f10/lsjz?${params}`, { timeoutMs: 5000, headers: { Referer: `https://fundf10.eastmoney.com/jjjz_${code}.html` } })
          if (response.status !== 200) throw new Error(`净值增量 HTTP ${response.status}`)
          const result = parseNavPage(JSON.parse(response.body), start, today)
          total ??= result.total
          if (result.total !== total) throw new Error('净值分页期间记录数变化')
          for (const row of result.rows) {
            if (seen.has(row.date)) throw new Error('净值分页重复')
            seen.add(row.date); values.set(row.date, row.value)
          }
          if (seen.size === total) break
          if (result.rows.length === 0 || seen.size > total || page === 12) throw new Error('净值分页未完整返回')
          await this.clock.sleep(300)
        }
      }
      values = new Map([...fund.navs.map(row => [row.date, row.value] as const), ...values])
      fund.navs = [...values].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }))
      this.navFrom.set(code, [this.navFrom.get(code) ?? from, from].sort()[0]!)
      fund.navFetchedAt = isoNow(this.clock); this.updatedAt = fund.navFetchedAt
      await this.clock.sleep(300)
      return values
    }).finally(() => this.navPending.delete(key))
    this.navPending.set(key, run)
    return run
  }

  share(code: string, date: string, latest?: string): number | undefined {
    const row = this.fund(code).shares.find(row => row.date === date)
    return row !== undefined && !(date === latest && this.clock.now() - Date.parse(row.fetchedAt) >= 6 * 3_600_000) ? row.value : undefined
  }

  private needsShare(code: string, date: string, latest: string) {
    const row = this.fund(code).shares.find(row => row.date === date)
    return row === undefined || (date === latest && this.clock.now() - Date.parse(row.fetchedAt) >= 6 * 3_600_000)
  }

  private putShare(code: string, date: string, value: number) {
    const fund = this.fund(code)
    const rows = new Map(fund.shares.map(row => [row.date, row]))
    rows.set(date, { date, value, fetchedAt: isoNow(this.clock) })
    fund.shares = [...rows.values()].sort((a, b) => a.date.localeCompare(b.date))
    this.updatedAt = isoNow(this.clock)
  }

  async shares(codes: readonly string[], dates: readonly string[], latest: string) {
    for (const code of codes.filter(code => code.startsWith('159'))) {
      if (!dates.some(date => this.needsShare(code, date, latest))) continue
      const from = dates[0]!, to = dates.at(-1)!
      const rows = await this.circuit.run('szse-etf', async () => {
        const result = new Map<string, number>()
        let count: number | null = null
        for (let page = 1; page <= 30; page += 1) {
          const params = new URLSearchParams({ SHOWTYPE: 'JSON', CATALOGID: 'scsj_fund_jjgm', TABKEY: 'tab1', PAGENO: String(page), txtDm: code, txtStart: from, txtEnd: to, jjlb: 'ETF' })
          const response = await this.http.request(`https://fund.szse.cn/api/report/ShowReport/data?${params}`, { timeoutMs: 5000, headers: { Referer: 'https://fund.szse.cn/marketdata/fundslist/index.html' } })
          if (response.status !== 200) throw new Error(`深交所份额 HTTP ${response.status}`)
          const raw: unknown = JSON.parse(response.body)
          const table = Array.isArray(raw) ? raw[0] : null
          if (!object(table) || table.error != null || !object(table.metadata) || !Array.isArray(table.data)) throw new Error('深交所份额格式错误')
          const pages = Number(table.metadata.pagecount)
          const expected = Number(table.metadata.recordcount)
          count ??= expected
          if (!Number.isSafeInteger(pages) || pages < 1 || pages > 30 || Number(table.metadata.pageno) !== page || !Number.isSafeInteger(expected) || expected < 0 || count !== expected) throw new Error('深交所分页无效')
          for (const row of table.data) {
            if (!object(row) || row.fund_code !== code || typeof row.size_date !== 'string' || !isMarketDate(row.size_date) || row.size_date < from || row.size_date > to || result.has(row.size_date)) throw new Error('深交所份额日期/代码无效')
            result.set(row.size_date, macroPositive(row.current_size))
          }
          if (page === pages) {
            if (result.size !== count) throw new Error('深交所份额不完整')
            return result
          }
          await this.clock.sleep(300)
        }
        throw new Error('深交所份额分页超限')
      })
      for (const [date, value] of rows) this.putShare(code, date, value)
      await this.clock.sleep(300)
    }
    for (const date of dates) {
      const sh = codes.filter(code => code.startsWith('5') && this.needsShare(code, date, latest))
      if (sh.length === 0) continue
      let entry = this.shanghai.get(date)
      if (entry === undefined || this.clock.now() - entry.at >= 6 * 3_600_000) {
        const result = this.circuit.run('sse-etf', async () => {
          const params = new URLSearchParams({ isPagination: 'true', sqlId: 'COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L', 'pageHelp.pageSize': '10000', 'pageHelp.pageNo': '1', STAT_DATE: date })
          const response = await this.http.request(`https://query.sse.com.cn/commonQuery.do?${params}`, { timeoutMs: 5000, headers: { Referer: 'https://www.sse.com.cn/market/funddata/volumn/etfvolumn/' } })
          if (response.status !== 200) throw new Error(`上交所份额 HTTP ${response.status}`)
          const raw: unknown = JSON.parse(response.body)
          if (!object(raw) || !object(raw.pageHelp) || !Array.isArray(raw.result) || Number(raw.pageHelp.total) !== raw.result.length || Number(raw.pageHelp.pageCount) !== 1) throw new Error('上交所份额未完整返回')
          const rows = new Map<string, unknown>()
          for (const row of raw.result) {
            if (!object(row) || row.STAT_DATE !== date || typeof row.SEC_CODE !== 'string' || rows.has(row.SEC_CODE)) throw new Error('上交所份额日期/代码无效')
            rows.set(row.SEC_CODE, row.TOT_VOL)
          }
          return rows
        }).catch(error => { this.shanghai.delete(date); throw error })
        entry = { at: this.clock.now(), result }; this.shanghai.set(date, entry)
        if (this.shanghai.size > 32) this.shanghai.delete(this.shanghai.keys().next().value!)
      }
      const rows = await entry.result
      for (const code of sh) if (rows.has(code)) this.putShare(code, date, macroPositive(rows.get(code)))
      if (sh.some(code => !rows.has(code))) this.shanghai.delete(date)
      await this.clock.sleep(300)
    }
  }

  snapshot(): MacroEtfInputs | null {
    const funds = [...this.funds.values()].filter(fund => fund.navs.length > 0).sort((a, b) => a.code.localeCompare(b.code))
    const date = funds.flatMap(fund => [...fund.navs, ...fund.shares].map(row => row.date)).sort().at(-1)
    if (date === undefined || this.updatedAt === null) return null
    return { funds: funds.map(fund => ({ ...fund, navs: [...fund.navs], shares: [...fund.shares] })), meta: { providerId: 'macro-etf-inputs', sourceName: '交易所日份额 / 东方财富单位净值原始记录', sourceTimestamp: date, fetchedAt: this.updatedAt, cacheState: 'fresh' } }
  }

  // Raw records are business data; clearing them during a request would lose its completed writes.
  clear(): number { const count = this.shanghai.size; this.shanghai.clear(); return count }
}
