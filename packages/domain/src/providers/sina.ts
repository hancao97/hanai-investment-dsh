import type { ProviderMeta, RankEntry, SectorBoard, SectorItem, StockQuote } from '../../../contracts/src/index.ts'
import { fetchJson, isoNow, systemClock, type Clock, type HttpClient } from '../http.ts'
import { ProviderCache } from './cache.ts'
import { finiteNumber } from './metrics.ts'

const HEADERS = { Referer: 'https://finance.sina.com.cn/' }
const API = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.'
type RankKind = 'gainers' | 'losers' | 'amount' | 'turnover'
type Row = Record<string, unknown>
type Quotes = { stocks: StockQuote[]; meta: ProviderMeta }
type Ranking = { entries: RankEntry[]; meta: ProviderMeta }

export class SinaProvider {
  private readonly boards: ProviderCache<SectorBoard>
  private readonly ranks: ProviderCache<Ranking>
  private readonly constituents: ProviderCache<Quotes>

  constructor(private readonly http: HttpClient, private readonly clock: Clock = systemClock, private readonly timeoutMs = 10_000) {
    this.boards = new ProviderCache(clock, 30_000)
    this.ranks = new ProviderCache(clock, 30_000)
    this.constituents = new ProviderCache(clock, 30_000)
  }

  private meta(): ProviderMeta {
    // These endpoints expose no trade date. fetchedAt must never be presented as the quote timestamp.
    return { providerId: 'sina-fallback', sourceName: '新浪行情（备源）', sourceTimestamp: null, fetchedAt: isoNow(this.clock), cacheState: 'fresh' }
  }

  getSectorBoard(type: 'industry' | 'concept'): Promise<SectorBoard | null> {
    return this.boards.get(type, async () => {
      const name = type === 'industry' ? 'sinaindustry' : 'class'
      const url = type === 'industry' ? 'https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php'
        : 'https://vip.stock.finance.sina.com.cn/q/view/newFLJK.php?param=class'
      const response = await this.http.request(url, { timeoutMs: this.timeoutMs, headers: HEADERS, responseEncoding: 'gb18030' })
      if (response.status < 200 || response.status >= 300) throw new Error('板块请求失败')
      // Parse only the JSON assignment; never evaluate remote JavaScript.
      const match = response.body.match(new RegExp(`^\\s*var S_Finance_bankuai_${name}\\s*=\\s*(\\{[\\s\\S]*\\})\\s*;?\\s*$`))
      if (match?.[1] === undefined) throw new Error('板块响应格式错误')
      const rows: unknown = JSON.parse(match[1])
      if (rows === null || typeof rows !== 'object' || Array.isArray(rows)) throw new Error('板块响应格式错误')
      const sectors: SectorItem[] = []
      for (const [node, value] of Object.entries(rows)) {
        if (!/^(?:new_|gn_)[A-Za-z0-9_]{1,60}$/.test(node) || typeof value !== 'string') continue
        const fields = value.split(',')
        if (fields[0] !== node || !fields[1]) continue
        sectors.push({
          code: `SINA:${node}`, name: fields[1], changePct: finiteNumber(fields[5]), amount: finiteNumber(fields[7]),
          upCount: null, downCount: null, leaderName: fields[12] || null,
          leaderCode: /^(?:sh|sz|bj)\d{6}$/.test(fields[8] ?? '') ? fields[8]!.slice(2) : null,
          leaderChangePct: finiteNumber(fields[9]),
        })
      }
      if (sectors.length === 0) throw new Error('板块数据为空')
      return { type, sectors, meta: this.meta() }
    })
  }

  private async rows(node: string, page: number, sort: string, ascending: boolean): Promise<Row[]> {
    const params = new URLSearchParams({ node, page: String(page), num: '100', sort, asc: ascending ? '1' : '0' })
    const response = await fetchJson<unknown>(this.http, `${API}getHQNodeData?${params}`, { timeoutMs: this.timeoutMs, headers: HEADERS })
    if (!response.ok || !Array.isArray(response.data)) throw new Error('股票列表请求失败')
    return response.data.filter((row): row is Row => row !== null && typeof row === 'object' && !Array.isArray(row))
  }

  private quote(row: Row): StockQuote | null {
    const symbol = typeof row.symbol === 'string' ? row.symbol : ''
    if (!/^(?:sh6\d{5}|sz[03]\d{5}|bj\d{6})$/.test(symbol) || typeof row.name !== 'string' || row.code !== symbol.slice(2)) return null
    const scaled = (field: string, scale: number) => {
      const value = finiteNumber(row[field])
      return value === null ? null : value * scale
    }
    return {
      secId: `${symbol.startsWith('sh') ? '1' : '0'}.${symbol.slice(2)}`, code: symbol.slice(2), name: row.name,
      price: finiteNumber(row.trade), change: finiteNumber(row.pricechange), changePct: finiteNumber(row.changepercent),
      amount: finiteNumber(row.amount), volume: scaled('volume', 0.01), turnoverRate: finiteNumber(row.turnoverratio),
      marketCap: scaled('mktcap', 10_000), floatCap: scaled('nmc', 10_000),
      pe: finiteNumber(row.per), pb: finiteNumber(row.pb), high: finiteNumber(row.high), low: finiteNumber(row.low),
      open: finiteNumber(row.open), prevClose: finiteNumber(row.settlement), meta: this.meta(),
    }
  }

  getRankList(kind: RankKind): Promise<Ranking | null> {
    return this.ranks.get(kind, async () => {
      const sort = kind === 'amount' ? 'amount' : kind === 'turnover' ? 'turnoverratio' : 'changepercent'
      const byId = new Map<string, StockQuote>()
      for (let page = 1; page <= 3 && byId.size < 20; page += 1) {
        const rows = await this.rows('hs_a', page, sort, kind === 'losers')
        for (const row of rows) {
          const quote = this.quote(row)
          if (quote !== null && quote.price !== null && quote.price > 0 && !/^(?:\*?ST|S\*?ST)/i.test(quote.name.trim())
            && (sort === 'amount' ? quote.amount : sort === 'turnoverratio' ? quote.turnoverRate : quote.changePct) !== null) byId.set(quote.secId, quote)
        }
        if (rows.length < 100) break
      }
      if (byId.size === 0) throw new Error('榜单数据为空')
      const quotes = [...byId.values()]
      const value = (quote: StockQuote) => kind === 'amount' ? quote.amount! : kind === 'turnover' ? quote.turnoverRate! : quote.changePct!
      quotes.sort((a, b) => (kind === 'losers' ? 1 : -1) * (value(a) - value(b)))
      return { entries: quotes.slice(0, 20).map(({ secId, code, name, price, changePct, amount, turnoverRate }) =>
        ({ secId, code, name, price, changePct, amount, turnoverRate })), meta: this.meta() }
    })
  }

  getSectorStocks(code: string): Promise<Quotes | null> {
    if (!/^SINA:(?:new_|gn_)[A-Za-z0-9_]{1,60}$/.test(code)) return Promise.resolve(null)
    const node = code.slice(5)
    return this.constituents.get(node, async () => {
      const count = await fetchJson<unknown>(this.http, `${API}getHQNodeStockCount?${new URLSearchParams({ node })}`, { timeoutMs: this.timeoutMs, headers: HEADERS })
      const total = count.ok ? finiteNumber(count.data) : null
      const quotes = new Map<string, StockQuote>()
      let rawCount = 0
      for (let page = 1; page <= 60; page += 1) {
        const rows = await this.rows(node, page, 'changepercent', false)
        rawCount += rows.length
        for (const row of rows) {
          const quote = this.quote(row)
          if (quote !== null) quotes.set(quote.secId, quote)
        }
        if (rows.length < 100 || (total !== null && rawCount >= total)) break
      }
      if (quotes.size === 0 || (total !== null && rawCount < total)) throw new Error('板块成分数据不完整')
      return { stocks: [...quotes.values()], meta: this.meta() }
    })
  }

  clearCache(): number { return this.boards.clear() + this.ranks.clear() + this.constituents.clear() }
}
