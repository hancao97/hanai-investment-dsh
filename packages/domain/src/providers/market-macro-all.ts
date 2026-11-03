import { macroRangeThrough, type MacroRange } from '../../../contracts/src/macro-range.ts'
import { MACRO_ETFS, macroAllTotals, type MacroAllEtfData } from '../../../contracts/src/market-macro.ts'
import { beijingMarketDate, isMarketDate } from '../../../contracts/src/market-history.ts'
import { isoNow, type Clock, type HttpClient } from '../http.ts'
import { ProviderCache } from './cache.ts'
import { parseEtfAssets } from './market-macro.ts'
import type { SourceCircuit } from './source-circuit.ts'

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export function parseMacroEtfDirectory(raw: unknown): Omit<MacroAllEtfData['funds'][number], 'points'>[] {
  if (!object(raw) || String(raw.code) !== '200' || !Array.isArray(raw.data)) throw new Error('中证沪深300产品目录不可用')
  const funds: Omit<MacroAllEtfData['funds'][number], 'points'>[] = []
  for (const row of raw.data) {
    if (!object(row)) throw new Error('中证产品格式错误')
    if (row.indexCode !== '000300' || row.fundType !== 'ETF' || !['上海证券交易所', '深圳证券交易所'].includes(String(row.exchange))) continue
    if (typeof row.productCode !== 'string' || !/^\d{6}$/.test(row.productCode) || typeof row.fundName !== 'string' || row.fundName.trim() === ''
      || typeof row.inceptionDate !== 'string' || !isMarketDate(row.inceptionDate) || funds.some(fund => fund.code === row.productCode)) throw new Error('中证ETF代码或成立日期无效')
    funds.push({ code: row.productCode, name: row.fundName, inceptionDate: row.inceptionDate })
  }
  if (funds.length > 60 || !MACRO_ETFS.every(fund => funds.some(item => item.code === fund.code))) throw new Error('中证ETF目录缺失或数量异常')
  return funds.sort((a, b) => a.code.localeCompare(b.code))
}

export class MarketMacroAllProvider {
  private readonly cache: ProviderCache<MacroAllEtfData>
  private readonly directories: ProviderCache<{ funds: Omit<MacroAllEtfData['funds'][number], 'points'>[]; meta: MacroAllEtfData['meta'] }>
  constructor(private readonly http: HttpClient, private readonly clock: Clock, private readonly circuit: SourceCircuit) {
    this.cache = new ProviderCache(clock, 6 * 3_600_000)
    this.directories = new ProviderCache(clock, 6 * 3_600_000)
  }

  get(range?: MacroRange): Promise<MacroAllEtfData | null> {
    const { from, to } = range ?? macroRangeThrough(beijingMarketDate(this.clock.now()))
    return this.cache.get(`${from}:${to}`, async () => {
      const directory = await this.getDirectory()
      const year = Number(to.slice(0, 4))
      const quarterEnd = [`${year - 1}-12-31`, `${year}-03-31`, `${year}-06-30`, `${year}-09-30`, `${year}-12-31`].filter(date => date <= to).at(-1)!
      const funds: MacroAllEtfData['funds'] = []
      for (const fund of directory.filter(fund => fund.inceptionDate <= to)) {
        if (fund.inceptionDate > quarterEnd) { funds.push({ ...fund, points: [] }); continue }
        const points = await this.circuit.run('eastmoney-fund', async () => {
          const response = await this.http.request(`https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=gmbd&mode=0&code=${fund.code}`, {
            timeoutMs: 5000, headers: { Referer: `https://fundf10.eastmoney.com/gmbd_${fund.code}.html` },
          })
          if (response.status !== 200) throw new Error(`ETF季度规模 HTTP ${response.status}`)
          return parseEtfAssets(response.body, from, to).filter(point => point.date >= fund.inceptionDate && /-(03-31|06-30|09-30|12-31)$/.test(point.date))
        })
        funds.push({ ...fund, points })
        await this.clock.sleep(300)
      }
      const result: MacroAllEtfData = { funds, universeAsOf: to, meta: { providerId: 'csi-etf-quarter', sourceName: '中证当前在列沪深300ETF目录 × 东方财富季末净资产', sourceTimestamp: null, fetchedAt: isoNow(this.clock), cacheState: 'fresh' } }
      const last = macroAllTotals(result).at(-1)
      if (last === undefined) throw new Error('在列ETF没有完整同日季末规模')
      result.meta.sourceTimestamp = last.date
      return result
    })
  }

  async getDirectory() {
    const result = await this.directories.get(beijingMarketDate(this.clock.now()), () => this.circuit.run('csi-products', async () => {
      const response = await this.http.request('https://www.csindex.com.cn/csindex-home/index-list/queryByIndexCode/000300', { timeoutMs: 5000 })
      if (response.status !== 200) throw new Error(`中证产品目录 HTTP ${response.status}`)
      return { funds: parseMacroEtfDirectory(JSON.parse(response.body)), meta: { providerId: 'csi-products', sourceName: '中证产品目录', sourceTimestamp: null, fetchedAt: isoNow(this.clock), cacheState: 'fresh' } }
    }))
    if (result === null || result.meta.cacheState === 'stale') throw new Error('中证产品目录不可用')
    return result.funds
  }

  clear(): number { return this.cache.clear() + this.directories.clear() }
}
