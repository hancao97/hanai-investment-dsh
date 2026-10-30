import type { ReactNode } from 'react'
import type { MarketStatus, ProviderMeta } from '../../contracts/src/index.ts'
import { describeDataStatus } from './data-status.ts'
import { dateTime } from './format.ts'
import styles from './styles.module.css'

export function PanelHead({ title, hint, meta, extra }: { title: string; hint?: ReactNode; meta?: ReactNode; extra?: ReactNode }) {
  return <header className={styles['panelHead']} data-panel-head>
    <div className={styles['panelHeadLayout']}>
      <div className={styles['panelHeading']}><h2>{title}</h2>{hint !== undefined && <span>{hint}</span>}</div>
      {meta != null && meta !== false && <div className={styles['panelMetadata']}>{meta}</div>}
      {extra != null && extra !== false && <div className={styles['panelActions']}>{extra}</div>}
    </div>
  </header>
}

interface DataStateProps { meta: ProviderMeta | null | undefined; marketStatus?: MarketStatus; refreshFailed?: boolean; liveCapable?: boolean; history?: boolean; resting?: boolean }

export function DataStateBadge({ meta, marketStatus, refreshFailed = false, liveCapable = true, history = false, resting = false }: DataStateProps) {
  const state = history && meta != null && meta.cacheState !== 'unavailable'
    ? { kind: 'cached', label: '历史快照', detail: '所选日期已保存的本地数据，来源与获取时间保持原样' }
    : resting && !refreshFailed && meta != null && meta.cacheState !== 'unavailable'
      ? { kind: 'cached', label: '休市快照', detail: '自动读取的本地归档，来源与获取时间保持原样' }
      : describeDataStatus(meta, { ...(marketStatus === undefined ? {} : { marketStatus }), ...(refreshFailed ? { refreshFailed: true } : {}), ...(!liveCapable ? { liveCapable: false } : {}) })
  return <span className={`${styles['dataState']} ${styles[`dataState_${state.kind}`]}`} data-data-status={state.kind} title={state.detail}>{state.label}</span>
}

type DateLabel = '交易日' | '报告期' | '数据日期'

export function DataSourceText({ meta, dateLabel = '交易日' }: { meta: ProviderMeta | null | undefined; dateLabel?: DateLabel }) {
  if (meta === null || meta === undefined) return <small className={styles['dataSource']}>来源元数据未提供</small>
  const timestamp = meta.sourceTimestamp === null ? '' : /^\d{4}-\d{2}-\d{2}$/.test(meta.sourceTimestamp)
    ? `${dateLabel} ${meta.sourceTimestamp} · ` : `数据时间 ${dateTime(meta.sourceTimestamp)} · `
  return <small className={styles['dataSource']}>{meta.sourceName} · {timestamp}{meta.cacheState === 'unavailable' ? '尝试于' : '获取于'} {dateTime(meta.fetchedAt)}</small>
}

export function PanelDataMeta({ dateLabel, ...props }: DataStateProps & { dateLabel?: DateLabel }) {
  return <><DataStateBadge {...props} /><DataSourceText meta={props.meta} {...(dateLabel === undefined ? {} : { dateLabel })} /></>
}
