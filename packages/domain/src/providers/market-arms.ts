import type { MarketArmsData, MarketArmsPoint } from '../../../contracts/src/market-arms.ts'
import { beijingMarketDate, isMarketDate } from '../../../contracts/src/market-history.ts'
import { isoNow, type Clock, type HttpClient } from '../http.ts'

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const amount = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

export function parseArmsPoint(value: unknown, date: string, intraday: boolean): MarketArmsPoint {
  if (!object(value) || typeof value.t !== 'string' || typeof value.approx !== 'boolean') throw new Error('88AI 市场广度记录无效')
  const pointDate = intraday ? date : value.t
  if (!isMarketDate(pointDate) || (intraday && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.t))) throw new Error('88AI 市场广度时间无效')
  const counts = [value.up_count, value.down_count, value.flat_count]
  if (!counts.every(item => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0)) throw new Error('88AI 涨跌家数无效')
  const [upCount, downCount, flatCount] = counts as number[]
  if (upCount! + downCount! + flatCount! === 0) throw new Error('88AI 市场样本为空')
  const upAmount = amount(value.up_amount), downAmount = amount(value.down_amount)
  if ((value.up_amount !== null && upAmount === null) || (value.down_amount !== null && downAmount === null)) throw new Error('88AI 成交额无效')
  const adRatio = downCount! > 0 ? upCount! / downCount! : null
  const amountRatio = downAmount !== null && downAmount > 0 && upAmount !== null ? upAmount / downAmount : null
  const sourceTrin = value.trin == null ? null : amount(value.trin)
  if (value.trin != null && sourceTrin === null) throw new Error('88AI TRIN 数值无效')
  const trin = sourceTrin ?? (adRatio !== null && amountRatio !== null && amountRatio > 0 ? adRatio / amountRatio : null)
  return { date: pointDate, time: intraday ? value.t : null, upCount: upCount!, downCount: downCount!, flatCount: flatCount!, upAmount, downAmount,
    adRatio, amountRatio, trin, estimated: value.approx }
}

export async function fetchArms(http: HttpClient, clock: Clock, view: 'intraday' | 'daily', signal?: AbortSignal): Promise<{ points: MarketArmsPoint[]; meta: MarketArmsData['meta'] }> {
  const response = await http.request(`https://www.88aitou.com/api/market/arms-index?view=${view}${view === 'daily' ? '&days=250' : ''}`, { timeoutMs: 10_000, ...(signal ? { signal } : {}) })
  if (response.status !== 200) throw new Error(`88AI 市场广度请求失败：HTTP ${response.status}`)
  const raw: unknown = JSON.parse(response.body)
  if (!object(raw) || raw.view !== view || typeof raw.trade_date !== 'string' || !isMarketDate(raw.trade_date) || !Array.isArray(raw.points)) throw new Error('88AI 市场广度响应无效')
  const fetchedAt = isoNow(clock), today = beijingMarketDate(clock.now())
  const points = raw.points.map(point => parseArmsPoint(point, raw.trade_date as string, view === 'intraday'))
    .filter(point => point.date <= today && (point.time === null || Date.parse(`${point.date}T${point.time}:00+08:00`) <= clock.now() + 60_000))
    .sort((a, b) => `${a.date}${a.time ?? ''}`.localeCompare(`${b.date}${b.time ?? ''}`))
  if (points.length === 0) throw new Error('88AI 市场广度无有效记录')
  const last = points.at(-1)!
  if (view === 'intraday' && last.trin === null) throw new Error('88AI 当前市场广度数据不完整')
  const bj = new Date(clock.now() + 8 * 3_600_000)
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  const trading = bj.getUTCDay() > 0 && bj.getUTCDay() < 6 && ((minutes >= 565 && minutes <= 690) || (minutes >= 780 && minutes <= 905))
  if (view === 'intraday' && trading && (last.date !== today || last.time === null || clock.now() - Date.parse(`${last.date}T${last.time}:00+08:00`) > 15 * 60_000)) throw new Error('88AI 盘中市场广度数据已过期')
  return { points, meta: { providerId: '88ai-arms', sourceName: '88AI投 · 沪深京 A 股含 ST · 成交额口径',
    sourceTimestamp: last.time ? new Date(`${last.date}T${last.time}:00+08:00`).toISOString() : last.date, fetchedAt, cacheState: 'fresh' } }
}
