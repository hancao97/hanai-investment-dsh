import { useEffect, useState } from 'react'
import type { Diagnostics, ProviderMeta } from '../../contracts/src/index.ts'
import { dateTime } from './format.ts'
import styles from './styles.module.css'

const CACHE_LABELS = { fresh: '最近返回数据', cached: '本地缓存', stale: '旧快照 / 延迟数据', unavailable: '本次不可用' }
const SCOPE_LABELS = { market: '行情', security: '主数据', valuation: '估值', breadth: '市场宽度', indices: '海外指数' }

function SnapshotSource({ label, sources }: { label: string; sources: ProviderMeta[] }) {
  const names = [...new Set(sources.filter(meta => meta.cacheState !== 'unavailable').map(meta => meta.sourceName))]
  const name = names.length > 1 || sources.some(meta => meta.providerId.includes('mixed')) ? '多源'
    : names[0] ?? (sources.length > 0 ? '本次不可用' : '来源待确认')
  return <div className={styles['sourceRow']}>
    <span className={`${styles['statusDot']} ${styles['statusUnknown']}`} />
    <div><b>{label} · {name}</b>{sources.length === 0 ? <small>尚无来源记录，等待实际取数</small>
      : sources.map(meta => <small key={meta.providerId}>{meta.sourceName} · {CACHE_LABELS[meta.cacheState]} · 获取于 {dateTime(meta.fetchedAt)}</small>)}</div>
  </div>
}

export function DataSources({ diagnostics }: { diagnostics: Diagnostics }) {
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!expanded) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [expanded])
  return <>
    <div className={styles['sourceList']}>
      <SnapshotSource label="行情快照" sources={diagnostics.marketSources ?? []} />
      <SnapshotSource label="估值" sources={diagnostics.valuationSources ?? []} />
      <div className={styles['sourceRow']}><span className={`${styles['statusDot']} ${styles['statusUnknown']}`} /><div>
        <b>证券主数据 · {diagnostics.securitySource ?? '来源待确认'}</b>
        <small>最近同步 {dateTime(diagnostics.latestSecuritySuccess ?? null)} · {diagnostics.securityCount.toLocaleString()} 只</small>
      </div></div>
    </div>
    <details className={styles['sourceDetails']} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>来源详情</summary>
      <p>自动切换；以下是本次运行的调用记录，不代表实时连通性探测。缓存状态以快照标记为准。</p>
      {(diagnostics.sourceAttempts ?? []).length === 0 && <p>尚无调用记录</p>}
      {(diagnostics.sourceAttempts ?? []).map(attempt => {
        const remaining = attempt.openUntil === null ? 0 : Math.max(0, Math.ceil((Date.parse(attempt.openUntil) - now) / 1000))
        const status = remaining > 0 ? `已熔断，${remaining} 秒后可重试`
          : attempt.lastAttemptAt === null ? '尚未调用'
            : attempt.lastError !== null ? '最近调用失败' : '最近调用返回数据'
        return <div className={styles['sourceAttempt']} key={`${attempt.scope}:${attempt.source}`}>
          <b>{SCOPE_LABELS[attempt.scope]} · {attempt.sourceName}</b>
          <span>{status}</span>
          <small>最近调用 {dateTime(attempt.lastAttemptAt)} · 最近返回数据 {dateTime(attempt.lastSuccessAt)}</small>
          {attempt.lastError !== null && <small>失败原因：{attempt.lastError}{attempt.failures > 0 ? ` · 连续失败 ${attempt.failures} 次` : ''}</small>}
        </div>
      })}
    </details>
  </>
}
