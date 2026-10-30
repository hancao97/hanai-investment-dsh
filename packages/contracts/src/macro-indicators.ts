import type { ProviderMeta } from './index.ts'
import type { MacroRange } from './macro-range.ts'

export const MACRO_TOPICS = [
  { id: 'funds', title: '市场资金' },
  { id: 'credit', title: '货币与信用' },
  { id: 'activity', title: '经济景气' },
  { id: 'prices', title: '通胀与利率' },
  { id: 'breadth', title: '市场广度' },
] as const
export type MacroTopic = typeof MACRO_TOPICS[number]['id']
export type EconomicTopic = Exclude<MacroTopic, 'funds'>

/** Business definitions live here; transport field names stay in the provider. */
export const MACRO_INDICATORS = [
  { id: 'arms', topic: 'breadth', title: '成交额版阿姆氏指标', frequency: 'daily', unit: '比值', columns: [{ key: 'trin', name: 'TRIN' }, { key: 'adRatio', name: '涨跌家数比' }, { key: 'amountRatio', name: '涨跌成交额比' }], kind: 'line', note: '沪深京 A 股含 ST；TRIN 使用成交额而非成交量。历史估算值由来源标记，缺失留空。' },
  { id: 'social', topic: 'credit', title: '社会融资规模增量', frequency: 'monthly', unit: '亿元', columns: [{ key: 'increment', name: '当月社融增量' }], kind: 'bar', note: '当月新增融资，非存量；负值保留。来源可能晚于央行发布，末端未发布或未收录不补零。' },
  { id: 'loans', topic: 'credit', title: '新增人民币贷款', frequency: 'monthly', unit: '亿元', columns: [{ key: 'increment', name: '当月新增人民币贷款' }], kind: 'bar', note: '金融机构新增人民币贷款，不等同于社融中的对实体经济人民币贷款。' },
  { id: 'money', topic: 'credit', title: 'M1 / M2同比', frequency: 'monthly', unit: '%', columns: [{ key: 'm1', name: 'M1同比' }, { key: 'm2', name: 'M2同比' }], kind: 'line', note: '保留来源公布同比；2025年起M1统计口径调整，跨口径比较须谨慎，不自行拼接或重算历史同比。' },
  { id: 'pmi', topic: 'activity', title: '采购经理指数（PMI）', frequency: 'monthly', unit: '指数', columns: [{ key: 'manufacturing', name: '制造业PMI' }, { key: 'nonManufacturing', name: '非制造业商务活动指数' }], kind: 'line', note: '50为扩张与收缩分界；非制造业为商务活动指数，并非同比增速。' },
  { id: 'industry', topic: 'activity', title: '规模以上工业增加值', frequency: 'monthly', unit: '%', columns: [{ key: 'yoy', name: '当月同比' }, { key: 'ytd', name: '累计同比' }], kind: 'line', note: '当月与累计同比独立展示；1—2月合并发布时按来源保留累计值，当月值缺失不拆分、不插值。' },
  { id: 'retail', topic: 'activity', title: '社会消费品零售总额', frequency: 'monthly', unit: '%', columns: [{ key: 'yoy', name: '当月同比' }, { key: 'ytd', name: '累计同比' }], kind: 'line', note: '展示名义同比；1—2月合并发布时按来源保留累计值，不以累计增速代替当月增速。' },
  { id: 'cpi', topic: 'prices', title: '居民消费价格（CPI）', frequency: 'monthly', unit: '%', columns: [{ key: 'yoy', name: '全国CPI同比' }, { key: 'mom', name: '全国CPI环比' }], kind: 'line', note: '同比与环比使用来源直接公布的增长率，不将价格指数基数当作增长率。' },
  { id: 'ppi', topic: 'prices', title: '工业生产者出厂价格（PPI）', frequency: 'monthly', unit: '%', columns: [{ key: 'yoy', name: 'PPI同比' }], kind: 'line', note: '全国工业生产者出厂价格同比，非工业增加值增速。' },
  { id: 'yields', topic: 'prices', title: '中国国债收益率', frequency: 'daily', unit: '%', columns: [{ key: 'y2', name: '2年' }, { key: 'y5', name: '5年' }, { key: 'y10', name: '10年' }, { key: 'y30', name: '30年' }], kind: 'line', note: '按来源实际交易日展示各期限收益率；无报价日不补值，不代表可直接成交价格。' },
] as const
export type MacroIndicatorId = typeof MACRO_INDICATORS[number]['id']
export type MacroIndicatorDefinition = typeof MACRO_INDICATORS[number]
export interface MacroIndicatorPoint { date: string; values: Record<string, number | null>; estimated?: boolean; armsDetails?: { upCount: number; downCount: number; upAmount: number | null; downAmount: number | null } }
export interface MacroIndicatorData {
  id: MacroIndicatorId
  points: MacroIndicatorPoint[]
  /** Requested coverage was checked, not a claim that every period has a published value. */
  checkedRange: MacroRange
  meta: ProviderMeta
}
export type MacroIndicatorMap = Partial<Record<MacroIndicatorId, MacroIndicatorData>>
export interface MacroIndicatorTask {
  id: MacroIndicatorId
  state: 'pending' | 'running' | 'completed' | 'partial' | 'failed'
  error: string | null
}
export interface MacroIndicatorQuery {
  range: MacroRange
  data: MacroIndicatorMap
  tradingDates?: string[]
  tasks: MacroIndicatorTask[]
  running: boolean
  queued: boolean
}

/** A checked range can still have gaps; Jan-Feb combined reports are not missing single months. */
export function firstMacroIndicatorGap(id: MacroIndicatorId, data: MacroIndicatorData, range: MacroRange): string | null {
  const definition = MACRO_INDICATORS.find(row => row.id === id)!
  const combined = id === 'industry' || id === 'retail'
  const missing = (point: MacroIndicatorPoint) => definition.columns.some(column => point.values[column.key] == null
    && !(combined && point.date.slice(5, 7) === '02' && column.key === 'yoy' && point.values.ytd != null))
  if (definition.frequency === 'daily') return data.points.find(missing)?.date ?? null
  const observations = new Map(data.points.map(point => [point.date, point]))
  const cursor = new Date(`${range.from.slice(0, 7)}-01T00:00:00Z`)
  const today = new Date(Date.now() + 8 * 3_600_000)
  const lastCompleteMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0)).toISOString().slice(0, 10)
  const through = range.to < lastCompleteMonth ? range.to : lastCompleteMonth
  while (cursor.toISOString().slice(0, 7) <= through.slice(0, 7)) {
    const date = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)
    if (date >= range.from && date <= through && !(combined && date.slice(5, 7) === '01')) {
      const point = observations.get(date)
      if (!point || missing(point)) return date
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return null
}

export function selectMacroIndicators(records: MacroIndicatorMap[], range: MacroRange): MacroIndicatorMap {
  const result: MacroIndicatorMap = {}
  for (const definition of MACRO_INDICATORS) {
    const values = records.flatMap(record => record[definition.id] ?? []).sort((a, b) => a.meta.fetchedAt.localeCompare(b.meta.fetchedAt))
    const last = values.at(-1)
    if (!last) continue
    const merged = new Map<string, MacroIndicatorPoint>()
    for (const point of values.flatMap(value => value.points).filter(point => point.date >= range.from && point.date <= range.to)) {
      const previous = merged.get(point.date)
      if (definition.id === 'arms' && previous && (point.values.trin == null || (point.estimated && previous.estimated === false))) continue
      merged.set(point.date, { date: point.date, values: Object.fromEntries(definition.columns.map(column => [column.key, point.values[column.key] ?? previous?.values[column.key] ?? null])), ...(point.estimated !== undefined ? { estimated: point.estimated } : previous?.estimated !== undefined ? { estimated: previous.estimated } : {}), ...(point.armsDetails ? { armsDetails: point.armsDetails } : previous?.armsDetails ? { armsDetails: previous.armsDetails } : {}) })
    }
    const points = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date))
    const covered = values.findLast(value => value.checkedRange.from <= range.from && value.checkedRange.to >= range.to)
    // An empty view still retains the actual source metadata and checked range.
    const sourceTimestamp = values.flatMap(value => value.meta.sourceTimestamp ?? []).sort().at(-1) ?? null
    result[definition.id] = { ...last, checkedRange: covered?.checkedRange ?? last.checkedRange, points, meta: { ...last.meta, sourceTimestamp } }
  }
  return result
}
