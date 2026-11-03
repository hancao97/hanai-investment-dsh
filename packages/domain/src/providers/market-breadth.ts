import type { MarketBreadthData } from '../../../contracts/src/index.ts'
import { fetchJson, isoNow, type Clock, type HttpClient } from '../http.ts'

export type BreadthSnapshot = MarketBreadthData

export async function eastmoneyBreadth(http: HttpClient, clock: Clock, timeoutMs: number): Promise<BreadthSnapshot> {
  const response = await fetchJson<{ data?: { qdate?: unknown; fenbu?: unknown } | null }>(http,
    'https://push2ex.eastmoney.com/getTopicZDFenBu?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt',
    { timeoutMs, headers: { Referer: 'https://quote.eastmoney.com/' } })
  if (!response.ok) throw new Error('市场宽度请求失败：' + response.error)
  const buckets = response.data?.data?.fenbu
  const rawDate = String(response.data?.data?.qdate ?? '')
  if (!Array.isArray(buckets) || buckets.length === 0 || !/^\d{8}$/.test(rawDate)) throw new Error('市场宽度响应不完整')
  const values = new Map<number, number>()
  for (const bucket of buckets) {
    if (bucket === null || typeof bucket !== 'object' || Array.isArray(bucket)) throw new Error('市场宽度分布格式错误')
    for (const [rawKey, value] of Object.entries(bucket)) {
      const key = Number(rawKey)
      if (!Number.isInteger(key) || key < -11 || key > 11 || typeof value !== 'number'
        || !Number.isSafeInteger(value) || value < 0 || values.has(key)) throw new Error('市场宽度分布数值无效')
      values.set(key, value)
    }
  }
  if (!values.has(0) || !values.has(11) || !values.has(-11)) throw new Error('市场宽度缺少平盘或涨跌停数据')
  let up = 0
  let down = 0
  for (const [key, value] of values) {
    if (key > 0) up += value
    if (key < 0) down += value
  }
  const flat = values.get(0)!
  if (up + down + flat === 0) throw new Error('市场宽度样本为空')
  const qdate = rawDate.slice(0, 4) + '-' + rawDate.slice(4, 6) + '-' + rawDate.slice(6, 8)
  return { up, down, flat, limitUp: values.get(11)!, limitDown: values.get(-11)!, qdate,
    meta: { providerId: 'eastmoney-breadth', sourceName: '东方财富市场宽度（兜底）',
      sourceTimestamp: qdate, fetchedAt: isoNow(clock), cacheState: 'fresh' } }
}

/** Same single-page source and first-table layout as AKShare stock_market_activity_legu. */
export async function leguBreadth(http: HttpClient, clock: Clock, timeoutMs: number): Promise<BreadthSnapshot> {
  const response = await http.request('https://legulegu.com/stockdata/market-activity', {
    timeoutMs, headers: { Accept: 'text/html,application/xhtml+xml', Referer: 'https://legulegu.com/' },
  })
  if (response.status < 200 || response.status >= 300) throw new Error(`乐咕市场宽度请求失败：HTTP ${response.status}`)
  const table = response.body.match(/<table\b[^>]*>([\s\S]*?)<\/table>/i)?.[1]
  if (table === undefined) throw new Error('乐咕市场宽度统计表缺失')
  const text = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;|&#x0*a0;/gi, ' ').trim()
  const fields = new Set(['上涨', '下跌', '平盘', '涨停', '跌停'])
  const values = new Map<string, number>()
  for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => text(cell[1]!))
    for (let index = 0; index < cells.length; index += 2) {
      const label = cells[index]!
      if (!fields.has(label)) continue
      const raw = cells[index + 1] ?? ''
      const value = Number(raw.replaceAll(',', ''))
      if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(raw) || !Number.isSafeInteger(value) || values.has(label)) throw new Error(`乐咕市场宽度数值无效：${label}`)
      values.set(label, value)
    }
  }
  if (values.size !== fields.size) throw new Error('乐咕市场宽度字段不完整')
  const up = values.get('上涨')!, down = values.get('下跌')!, flat = values.get('平盘')!
  const limitUp = values.get('涨停')!, limitDown = values.get('跌停')!
  if (!Number.isSafeInteger(up + down + flat) || up + down + flat === 0 || limitUp > up || limitDown > down) throw new Error('乐咕市场宽度统计不一致')
  const meta = response.body.match(/class=["'][^"']*\bmarket-activity-meta\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]
  const date = text(meta ?? '').match(/\b(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\b/)
  const localTimestamp = `${date?.[1]}T${date?.[2]}`
  const timestamp = Date.parse(`${localTimestamp}+08:00`)
  if (!Number.isFinite(timestamp) || timestamp > clock.now() + 60_000
    || new Date(timestamp + 8 * 3_600_000).toISOString().slice(0, 19) !== localTimestamp) throw new Error('乐咕市场宽度统计时间无效')
  return { up, down, flat, limitUp, limitDown, qdate: date![1]!,
    meta: { providerId: 'legu-breadth', sourceName: '乐咕乐股（AKShare 同源）',
      sourceTimestamp: new Date(timestamp).toISOString(), fetchedAt: isoNow(clock), cacheState: 'fresh' } }
}
