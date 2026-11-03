import type { IndexQuote, ProviderMeta } from './index.ts'

export const DOMESTIC_INDICES = [
  { code: '000001', secId: '1.000001', name: '上证指数' },
  { code: '399001', secId: '0.399001', name: '深证成指' },
  { code: '399006', secId: '0.399006', name: '创业板指' },
  { code: '000016', secId: '1.000016', name: '上证50' },
  { code: '000300', secId: '1.000300', name: '沪深300' },
  { code: '000688', secId: '1.000688', name: '科创50' },
  { code: '000852', secId: '1.000852', name: '中证1000' },
  { code: '899050', secId: '0.899050', name: '北证50' },
] as const

export const GLOBAL_INDICES = [
  { code: 'IXIC', name: '纳斯达克综合', zone: 'America/New_York', close: 16 * 60, sessions: [[570, 960]] },
  { code: 'HSI', name: '恒生指数', zone: 'Asia/Hong_Kong', close: 16 * 60 + 10, sessions: [[570, 720], [780, 970]] },
  { code: 'XIN9', name: '富时中国A50', zone: 'Asia/Shanghai', close: 15 * 60 + 5, sessions: [[565, 690], [780, 905]] },
  { code: 'KS11', name: '韩国KOSPI', zone: 'Asia/Seoul', close: 15 * 60 + 30, sessions: [[540, 930]] },
  { code: 'N225', name: '日经225', zone: 'Asia/Tokyo', close: 15 * 60 + 30, sessions: [[540, 690], [750, 930]] },
] as const

export interface GlobalIndexQuote extends IndexQuote {
  meta: ProviderMeta
  marketDate: string | null
}
export interface GlobalIndicesData { indices: GlobalIndexQuote[]; meta: ProviderMeta }

export function marketLocalTime(timestamp: number, zone: string): { date: string; minutes: number; weekday: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(timestamp).map(part => [part.type, part.value]))
  const date = `${parts.year}-${parts.month}-${parts.day}`
  return { date, minutes: Number(parts.hour) * 60 + Number(parts.minute), weekday: new Date(`${date}T00:00:00Z`).getUTCDay() }
}

export function isGlobalMarketOpen(now = Date.now()): boolean {
  return GLOBAL_INDICES.some(index => {
    const local = marketLocalTime(now, index.zone)
    return local.weekday > 0 && local.weekday < 6 && index.sessions.some(([start, end]) => local.minutes >= start && local.minutes <= end)
  })
}

/** Each market has its own date and close; an A-share close cannot freeze overseas quotes. */
export function isGlobalSnapshotCurrent(data: GlobalIndicesData | null, now = Date.now()): boolean {
  if (data === null) return false
  return GLOBAL_INDICES.every(definition => {
    const row = data.indices.find(item => item.code === definition.code)
    if (row === undefined || row.price === null || row.meta.cacheState === 'unavailable' || row.meta.cacheState === 'stale') return false
    const local = marketLocalTime(now, definition.zone)
    const open = local.weekday > 0 && local.weekday < 6 && definition.sessions.some(([start, end]) => local.minutes >= start && local.minutes <= end)
    const age = now - Date.parse(row.meta.fetchedAt)
    if (age < 0 || age > (open ? 25_000 : 6 * 3_600_000)) return false
    const expected = new Date(`${local.date}T00:00:00Z`)
    if (local.minutes < definition.sessions[0][0]) expected.setUTCDate(expected.getUTCDate() - 1)
    while ([0, 6].includes(expected.getUTCDay())) expected.setUTCDate(expected.getUTCDate() - 1)
    if (row.marketDate !== expected.toISOString().slice(0, 10) || row.meta.sourceTimestamp === null) return false
    const source = marketLocalTime(Date.parse(row.meta.sourceTimestamp), definition.zone)
    if (!open && (local.weekday === 0 || local.weekday === 6 || local.minutes < definition.sessions[0][0] || local.minutes >= definition.close)) return source.minutes >= definition.close - 10
    return true
  })
}
