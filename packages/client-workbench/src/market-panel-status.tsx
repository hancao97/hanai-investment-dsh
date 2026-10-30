import type { ProviderMeta } from '../../contracts/src/index.ts'
import { isMarketResting } from './market-hours.ts'
import { DataStateBadge } from './panel-head.tsx'
import styles from './styles.module.css'

interface MarketPanelItem { label: string; meta?: ProviderMeta | null | undefined; failed?: boolean; message?: string }

/** Today-market headers show only cache/history hints and failures; provenance remains in stored data. */
export function MarketPanelStatus({ items, historical = false }: { items: MarketPanelItem[]; historical?: boolean }) {
  // An explicit success can carry an aged closing quote or an archived stale marker.
  const errors = items.filter(item => item.failed || (!historical && (item.meta?.cacheState === 'unavailable' || (item.failed === undefined && item.meta?.cacheState === 'stale'))))
  if (errors.length > 0) return <>
    <DataStateBadge meta={errors[0]?.meta} refreshFailed />
    <small role="status">{errors.map(item => `${item.label}：${item.message ?? (item.meta && item.meta.cacheState !== 'unavailable' ? '更新失败，沿用缓存' : '数据暂不可用')}`).join('；')}</small>
  </>
  const meta = items.find(item => item.meta && item.meta.cacheState !== 'unavailable')?.meta
  if (historical && meta) return <DataStateBadge meta={meta} history />
  if (isMarketResting() && meta) return <span className={`${styles['dataState']} ${styles['dataState_cached']}`} data-data-status="cached" title="国内休市，展示最近成功的缓存数据">休市缓存</span>
  return null
}
