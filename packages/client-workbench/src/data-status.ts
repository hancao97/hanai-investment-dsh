import type { MarketStatus, ProviderMeta } from '../../contracts/src/index.ts'

export type DataStatusKind =
  | 'live'
  | 'session'
  | 'delayed'
  | 'fallback'
  | 'cached'
  | 'unavailable'
  | 'refresh-failed'
  | 'unknown'

export interface DataStatus {
  kind: DataStatusKind
  label: string
  detail: string
}

export interface DataStatusOptions {
  marketStatus?: MarketStatus
  refreshFailed?: boolean
  /** False for snapshots such as fundamentals, valuation, and historical K-lines. */
  liveCapable?: boolean
}

/**
 * Turn provider provenance into user-facing freshness copy. Poll cadence is
 * intentionally ignored: a 15-second timer does not prove that a quote is live.
 */
export function describeDataStatus(
  meta: ProviderMeta | null | undefined,
  options: DataStatusOptions = {},
): DataStatus {
  if (options.refreshFailed === true) {
    return { kind: 'refresh-failed', label: '刷新失败', detail: '正在展示上一次成功取得的数据' }
  }
  if (meta === null || meta === undefined) {
    return { kind: 'unknown', label: '来源未知', detail: '接口未返回行情来源与新鲜度元数据' }
  }

  const provider = meta.providerId.toLowerCase()
  const source = meta.sourceName.toLowerCase()
  const fallback = provider.includes('fallback') || source.includes('备源') || source.includes('备用') || source.includes('降级')
  const delayed = provider.includes('delay') || source.includes('延迟')
  const snapshot = provider.includes('cache') || source.includes('快照')

  if (meta.cacheState === 'unavailable') {
    return { kind: 'unavailable', label: '不可用', detail: '数据源本次没有返回可用数据' }
  }
  if (fallback) {
    return { kind: 'fallback', label: '备源降级', detail: `主数据源不可用，当前使用 ${meta.sourceName}` }
  }
  if (delayed) {
    return { kind: 'delayed', label: '延迟行情', detail: `${meta.sourceName} 返回延迟行情` }
  }
  if (meta.cacheState === 'stale') {
    return snapshot
      ? { kind: 'cached', label: '历史快照', detail: '实时请求失败，当前展示最近成功快照' }
      : { kind: 'cached', label: '缓存数据', detail: '数据已超过实时新鲜度窗口' }
  }
  if (meta.cacheState === 'cached') {
    return { kind: 'cached', label: '缓存数据', detail: '当前结果来自本地缓存' }
  }

  switch (options.marketStatus) {
    case 'trading': return { kind: 'live', label: '实时', detail: '交易时段的最新行情' }
    case 'pre': return { kind: 'session', label: '盘前', detail: '市场尚未开盘，展示盘前最新数据' }
    case 'break': return { kind: 'session', label: '午间休市', detail: '市场处于午间休市，展示休市前数据' }
    case 'closed': return { kind: 'session', label: '已收盘', detail: '市场已收盘，展示最近收盘数据' }
    case 'unknown': return { kind: 'session', label: '状态待确认', detail: '数据源未能确认当前交易时段' }
    case undefined: return options.liveCapable === false
      ? { kind: 'session', label: '最新数据', detail: '数据源标记为 fresh；该数据面不代表实时价格' }
      : { kind: 'live', label: '实时', detail: '数据源标记为 fresh' }
  }
  return { kind: 'unknown', label: '状态待确认', detail: '无法识别数据新鲜度状态' }
}
