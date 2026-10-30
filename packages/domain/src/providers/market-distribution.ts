import type { MarketDistributionData } from '../../../contracts/src/market-distribution.ts'
import { isoNow, type Clock, type HttpClient } from '../http.ts'

/** Locate bucket boundaries in a descending list; request each boundary page only once. */
export async function summarizeDistribution(total: number, pageSize: number, fetchPage: (page: number) => Promise<number[]>): Promise<MarketDistributionData['counts']> {
  const atLeast = async (threshold: number) => {
    let low = 1, high = Math.ceil(total / pageSize), full = 0
    while (low <= high) {
      const page = Math.floor((low + high) / 2)
      const rows = await fetchPage(page)
      if (rows[0]! < threshold) high = page - 1
      else if (rows.at(-1)! >= threshold) { full = page; low = page + 1 }
      else return (page - 1) * pageSize + rows.filter(value => value >= threshold).length
    }
    return Math.min(total, full * pageSize)
  }
  const thresholds = [10, 5, 2, Number.EPSILON, 0, -2, -5, -10]
  const counts: number[] = []
  for (const threshold of thresholds) counts.push(await atLeast(threshold))
  if (counts.some((value, index) => value < 0 || value > total || (index > 0 && value < counts[index - 1]!))) throw new Error('涨跌分布分页统计不一致')
  const [a, b, c, positive, nonNegative, d, e, f] = counts as [number, number, number, number, number, number, number, number]
  return { up10: a, up5: b - a, up2: c - b, up0: positive - c, flat: nonNegative - positive, down0: d - nonNegative, down2: e - d, down5: f - e, down10: total - f }
}

export async function fetchDistribution(http: HttpClient, clock: Clock, source: 'tencent' | 'sina' | 'eastmoney', timeoutMs: number): Promise<MarketDistributionData> {
  const signal = AbortSignal.timeout(timeoutMs)
  const read = async (url: string): Promise<any> => {
    const response = await http.request(url, { signal, timeoutMs })
    if (response.status !== 200) throw new Error(`涨跌分布 HTTP ${response.status}`)
    return JSON.parse(response.body)
  }
  const size = 100
  const sina = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.'
  const url = (page: number) => source === 'sina'
    ? `${sina}getHQNodeData?page=${page}&num=${size}&sort=changepercent&asc=0&node=hs_a&symbol=&_s_r_a=page`
    : source === 'tencent' ? `https://proxy.finance.qq.com/cgi/cgi-bin/rank/hs/getBoardRankList?${new URLSearchParams({ _appver: '11.17.0', board_code: 'aStock', sort_type: 'priceRatio', direct: 'down', offset: String((page - 1) * size), count: String(size) })}`
    : `https://push2.eastmoney.com/api/qt/clist/get?${new URLSearchParams({ pn: String(page), pz: String(size), po: '1', np: '1', fltt: '2', invt: '2', fid: 'f3', fs: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23', fields: 'f3' })}`
  const first = source === 'sina' ? null : await read(url(1))
  const rawTotal = source === 'sina' ? await read(`${sina}getHQNodeStockCount?node=hs_a`) : first?.data?.total
  const total = Number(rawTotal)
  if (!Number.isSafeInteger(total) || total < 1000 || total > 20_000) throw new Error('涨跌分布样本数无效')
  const cache = new Map<number, number[]>()
  const suspended = new Map<number, number>()
  const page = async (number: number) => {
    if (cache.has(number)) return cache.get(number)!
    const raw = number === 1 && first !== null ? first : await read(url(number))
    if (source === 'eastmoney' && (raw?.rc !== 0 || raw?.data?.total !== total)) throw new Error('涨跌分布总数变化，请稍后重试')
    if (source === 'tencent' && (raw?.code !== 0 || raw?.data?.total !== total || raw?.data?.offset !== (number - 1) * size)) throw new Error('腾讯涨跌分布分页状态无效或总数变化')
    const rows: unknown = source === 'sina' ? raw : source === 'tencent' ? raw?.data?.rank_list : raw?.data?.diff
    if (!Array.isArray(rows) || rows.length !== Math.min(size, total - (number - 1) * size)) throw new Error('涨跌分布分页不完整')
    const values = rows.map(row => {
      if (source === 'tencent' && (typeof row?.code !== 'string' || !/^(sh|sz|bj)\d{6}$/.test(row.code))) throw new Error('腾讯涨跌分布证券代码无效')
      const value: unknown = row?.[source === 'sina' ? 'changepercent' : source === 'tencent' ? 'zdf' : 'f3']
      if ((typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value))) || !Number.isFinite(Number(value))) throw new Error('涨跌分布含无效涨幅')
      return Number(value)
    })
    let trailing = 0
    if (source === 'tencent') {
      const firstSuspended = rows.findIndex(row => row?.state === 'S')
      if (firstSuspended !== -1) {
        if (rows.slice(firstSuspended).some((row, index) => row?.state !== 'S' || values[firstSuspended + index] !== 0)) throw new Error('腾讯停牌尾部记录不一致')
        trailing = rows.length - firstSuspended
        values.splice(firstSuspended)
      }
      suspended.set(number, trailing)
    }
    if (values.some((value, index) => index > 0 && value > values[index - 1]!)) throw new Error('涨跌分布未按涨幅排序')
    // Live pages are observed at different times; adjacent pages may overlap as prices move.
    cache.set(number, values)
    return values
  }
  // Tencent appends suspended zero-change stocks after decliners, outside the sorted active list.
  let suspendedCount = 0
  if (source === 'tencent') {
    for (let tail = Math.ceil(total / size); tail >= 1; tail--) {
      const active = await page(tail)
      suspendedCount += suspended.get(tail) ?? 0
      if (active.length > 0) break
    }
  }
  if (suspendedCount >= total) throw new Error('腾讯涨跌分布无有效交易样本')
  const activeTotal = total - suspendedCount
  const counts = await summarizeDistribution(activeTotal, size, async number => {
    const values = await page(number)
    if (values.length !== Math.min(size, activeTotal - (number - 1) * size)) throw new Error('涨跌分布交易样本分页不完整')
    return values
  })
  counts.flat += suspendedCount
  return { total, counts, meta: { providerId: `${source}-distribution`, sourceName: `${source === 'tencent' ? '腾讯沪深京 A 股（含 ST）' : source === 'sina' ? '新浪 A 股（含 ST）' : '东方财富沪深 A 股（含 ST，兜底）'} · 涨跌分布（分页统计）`,
    sourceTimestamp: null, fetchedAt: isoNow(clock), cacheState: 'fresh' } }
}
