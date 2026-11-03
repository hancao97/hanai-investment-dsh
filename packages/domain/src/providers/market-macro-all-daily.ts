import { macroRangeThrough, type MacroRange } from '../../../contracts/src/macro-range.ts'
import { MACRO_ETFS, type MacroAllDailyData, type MacroEtfInputs, type MacroIndexData } from '../../../contracts/src/market-macro.ts'
import { beijingMarketDate, isMarketDate } from '../../../contracts/src/market-history.ts'
import { isoNow, type Clock, type HttpClient } from '../http.ts'
import type { SourceCircuit } from './source-circuit.ts'
import type { MarketMacroAllProvider } from './market-macro-all.ts'
import type { MarketMacroInputs } from './market-macro-inputs.ts'

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const active = (fund: MacroAllDailyData['funds'][number], date: string) => fund.listedOn <= date && (fund.inactiveFrom === undefined || date < fund.inactiveFrom)

export class MarketMacroAllDailyProvider {
  constructor(private readonly http: HttpClient, private readonly clock: Clock, private readonly circuit: SourceCircuit,
    private readonly directory: MarketMacroAllProvider, readonly inputs: MarketMacroInputs, private readonly index: (range?: MacroRange) => Promise<MacroIndexData | null>) {}

  private async universe(previous: MacroAllDailyData | null) {
    if (previous?.universeAsOf === beijingMarketDate(this.clock.now())) return previous.funds
    const directory = await this.directory.getDirectory()
    const listing = new Map<string, string>()
    await this.circuit.run('sse-etf', async () => {
      const params = new URLSearchParams({ sqlId: 'FUND_LIST', isPagination: 'true', 'pageHelp.pageSize': '10000', 'pageHelp.pageNo': '1', fundType: '00', subClass: '01,02,03,04,06,08,09,31,32,33,34,35,36,37,38' })
      const response = await this.http.request(`https://query.sse.com.cn/commonSoaQuery.do?${params}`, { timeoutMs: 5000, headers: { Referer: 'https://www.sse.com.cn/' } })
      if (response.status !== 200) throw new Error(`上交所基金名录 HTTP ${response.status}`)
      const raw: unknown = JSON.parse(response.body)
      if (!object(raw) || !object(raw.pageHelp) || !Array.isArray(raw.result) || Number(raw.pageHelp.total) !== raw.result.length || Number(raw.pageHelp.pageCount) !== 1) throw new Error('上交所基金名录未完整返回')
      for (const row of raw.result) {
        if (!object(row) || typeof row.fundCode !== 'string' || !directory.some(fund => fund.code === row.fundCode)) continue
        if (row.INDEX_CODE !== '000300' || typeof row.listingDate !== 'string' || !/^\d{8}$/.test(row.listingDate)) throw new Error('上交所基金上市信息无效')
        const date = `${row.listingDate.slice(0, 4)}-${row.listingDate.slice(4, 6)}-${row.listingDate.slice(6)}`
        if (!isMarketDate(date) || listing.has(row.fundCode)) throw new Error('基金上市日期无效或代码重复')
        listing.set(row.fundCode, date)
      }
    })
    await this.circuit.run('szse-etf', async () => {
      let count = 0, expected: number | null = null
      for (let page = 1; page <= 10; page += 1) {
        const params = new URLSearchParams({ SHOWTYPE: 'JSON', CATALOGID: '1105', TABKEY: 'tab1', PAGENO: String(page), txtkey1: '沪深300' })
        const response = await this.http.request(`https://fund.szse.cn/api/report/ShowReport/data?${params}`, { timeoutMs: 5000 })
        if (response.status !== 200) throw new Error(`深交所基金名录 HTTP ${response.status}`)
        const raw: unknown = JSON.parse(response.body), table = Array.isArray(raw) ? raw[0] : null
        if (!object(table) || table.error != null || !object(table.metadata) || !Array.isArray(table.data)) throw new Error('深交所基金名录格式错误')
        const pages = Number(table.metadata.pagecount), total = Number(table.metadata.recordcount)
        expected ??= total
        if (!Number.isSafeInteger(pages) || pages < 1 || pages > 10 || Number(table.metadata.pageno) !== page || !Number.isSafeInteger(total) || total < 0 || expected !== total) throw new Error('深交所名录分页无效')
        count += table.data.length
        for (const row of table.data) {
          if (!object(row)) throw new Error('基金名录记录无效')
          const code = typeof row.sys_key === 'string' ? /<u>(\d{6})<\/u>/.exec(row.sys_key)?.[1] : undefined
          if (code === undefined || !directory.some(fund => fund.code === code)) continue
          if (row.jjlb !== 'ETF' || typeof row.ssrq !== 'string' || !isMarketDate(row.ssrq) || listing.has(code)) throw new Error('深交所基金上市信息无效')
          listing.set(code, row.ssrq)
        }
        if (page === pages) { if (count !== expected) throw new Error('深交所基金名录未完整返回'); break }
        await this.clock.sleep(300)
      }
    })
    const funds: MacroAllDailyData['funds'] = directory.map(fund => {
      const listedOn = listing.get(fund.code)
      if (listedOn === undefined || listedOn < fund.inceptionDate) throw new Error(`${fund.code} 未核实上市日期`)
      return { code: fund.code, name: fund.name, listedOn }
    })
    // Official listing and liquidation notices: 515930_20200508_1.pdf; AN202307261592654549.
    funds.push({ code: '515930', name: '永赢沪深300ETF（已清算）', listedOn: '2020-05-08', inactiveFrom: '2023-06-13', delistedOn: '2023-07-31' })
    for (const old of previous?.funds ?? []) {
      if (funds.some(fund => fund.code === old.code)) continue
      if (old.inactiveFrom === undefined) throw new Error(`${old.code} 已离开当前目录，需核实历史状态`)
      funds.push(old)
    }
    return funds.sort((a, b) => a.code.localeCompare(b.code))
  }

  async get(previous: MacroAllDailyData | null, seed: MacroEtfInputs | null = null, retryMissing = false, range?: MacroRange): Promise<MacroAllDailyData | null> {
    this.inputs.restore(seed)
    const stale = () => previous === null ? null : { ...previous, meta: { ...previous.meta, cacheState: 'stale' as const } }
    try {
      const { from, to } = range ?? macroRangeThrough(beijingMarketDate(this.clock.now()))
      const funds = await this.universe(previous)
      const navs = new Map<string, Map<string, number>>()
      for (const fund of MACRO_ETFS) navs.set(fund.code, await this.inputs.nav(fund.code, range))
      const calendar = await this.index(range)
      if (calendar === null || ['stale', 'unavailable'].includes(calendar.meta.cacheState)) return stale()
      const through = [...navs.get('510300')!.keys()].filter(date => MACRO_ETFS.every(fund => navs.get(fund.code)!.has(date))).sort().at(-1)
      const dates = calendar.points.map(point => point.date).filter(date => date >= from && date <= to && date <= (through ?? '')).sort()
      const latest = dates.at(-1)
      if (latest === undefined) return stale()
      const changed = previous !== null && JSON.stringify(previous.funds) !== JSON.stringify(funds)
      const points = new Map((changed ? [] : previous?.points ?? []).filter(point => dates.includes(point.date)).map(point => [point.date, point]))
      const gaps = new Map((changed || retryMissing ? [] : previous?.missingDates ?? []).filter(row => dates.includes(row.date)).map(row => [row.date, row.reason]))
      const refresh = previous !== null && this.clock.now() - Date.parse(previous.meta.fetchedAt) >= 6 * 3_600_000
      const pending = dates.filter(date => (!points.has(date) && !gaps.has(date)) || (refresh && date === latest)).reverse()
      const windowStart = Date.parse(`${pending[0] ?? latest}T00:00:00+08:00`) - 31 * 86_400_000
      const batch = pending.filter(date => Date.parse(`${date}T00:00:00+08:00`) >= windowStart).slice(0, 8).sort()
      const needed = funds.filter(fund => batch.some(date => active(fund, date)))
      for (const fund of needed) if (!navs.has(fund.code)) navs.set(fund.code, await this.inputs.nav(fund.code, range))
      if (batch.length > 0) await this.inputs.shares(needed.map(fund => fund.code), batch, latest)
      for (const date of batch) {
        let assets = 0, fourAssets = 0
        const missing: string[] = []
        for (const fund of funds.filter(fund => active(fund, date))) {
          const shares = this.inputs.share(fund.code, date, latest), nav = navs.get(fund.code)?.get(date)
          if (shares === undefined || nav === undefined) { missing.push(fund.code); continue }
          const value = shares * nav / 10_000
          assets += value
          if (MACRO_ETFS.some(item => item.code === fund.code)) fourAssets += value
        }
        if (missing.length > 0) { if (!points.has(date)) gaps.set(date, `缺同日份额或净值：${missing.join('、')}`); continue }
        const round = (value: number) => Math.round(value * 100) / 100
        points.set(date, { date, assets: round(assets), fourAssets: round(fourAssets), otherAssets: round(assets - fourAssets) }); gaps.delete(date)
      }
      if (points.size === 0 && gaps.size === 0) return stale()
      const rows = [...points.values()].sort((a, b) => a.date.localeCompare(b.date))
      const missingDates = [...gaps].sort(([a], [b]) => a.localeCompare(b)).map(([date, reason]) => ({ date, reason }))
      return { funds, universeAsOf: beijingMarketDate(this.clock.now()), points: rows, missingDates, expectedDays: dates.length, complete: rows.length === dates.length,
        meta: { providerId: 'exchange-etf-all-nav', sourceName: '中证目录+已确认退市产品 / 交易所日份额 × 东方财富单位净值', sourceTimestamp: [...rows.map(row => row.date), ...gaps.keys()].sort().at(-1)!, fetchedAt: batch.length === 0 && previous !== null ? previous.meta.fetchedAt : isoNow(this.clock), cacheState: 'fresh' } }
    } catch { return stale() }
  }
}
