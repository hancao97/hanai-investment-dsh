import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DashboardData, ProviderMeta } from '../../contracts/src/index.ts'
import { beijingMarketDate, isMarketDate, marketHistoryPanel, MARKET_HISTORY_PANELS, type MarketHistorySnapshot, type MarketHistorySummary } from '../../contracts/src/market-history.ts'
import type { HanaiClient } from './api.ts'
import { dateTime } from './format.ts'
import styles from './styles.module.css'
import { DOMESTIC_INDICES } from '../../contracts/src/market-indices.ts'

/** Uses the same weekday policy as polling; this is not an exchange holiday calendar. */
function latestClosingDate(now: Date): string {
  const bj = new Date(now.getTime() + 8 * 3_600_000)
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  if (minutes <= 15 * 60 + 5) bj.setUTCDate(bj.getUTCDate() - 1)
  while (bj.getUTCDay() === 0 || bj.getUTCDay() === 6) bj.setUTCDate(bj.getUTCDate() - 1)
  return bj.toISOString().slice(0, 10)
}

export function isClosingPanelCurrent(meta: ProviderMeta, now = new Date()): boolean {
  const date = latestClosingDate(now)
  const cutoff = Date.parse(`${date}T15:05:00+08:00`)
  const fetchedAt = Date.parse(meta.fetchedAt)
  if (!Number.isFinite(fetchedAt) || fetchedAt > now.getTime() || meta.cacheState === 'unavailable') return false
  if (meta.sourceTimestamp === null) return fetchedAt >= cutoff && meta.cacheState !== 'stale'
  if (isMarketDate(meta.sourceTimestamp)) return meta.sourceTimestamp === date && fetchedAt >= cutoff
  const sourceAt = Date.parse(meta.sourceTimestamp)
  return Number.isFinite(sourceAt) && beijingMarketDate(sourceAt) === date
    && sourceAt >= Date.parse(`${date}T15:00:00+08:00`) && sourceAt <= fetchedAt
}

export function isClosingSnapshotCurrent(snapshot: MarketHistorySnapshot, now = new Date()): boolean {
  if (snapshot.date !== latestClosingDate(now)) return false
  const current = (meta: ProviderMeta) => isClosingPanelCurrent(meta, now)
  for (const key of MARKET_HISTORY_PANELS) {
    if (key.startsWith('macro.') || ['global.indices', 'intraday', 'signals', 'arms', 'distribution', 'ladder'].includes(key)) continue
    const record = snapshot.records[key]
    if (record === undefined || marketHistoryPanel(snapshot, key) === null || !current(record.meta)) return false
  }
  const overview = marketHistoryPanel(snapshot, 'overview')!
  return DOMESTIC_INDICES.every(item => overview.indices.some(index => index.code === item.code))
    && overview.indices.every(index => current(index.meta ?? overview.meta))
}

export function snapshotDashboard(snapshot: MarketHistorySnapshot | null): DashboardData | null {
  if (snapshot === null) return null
  const missing: ProviderMeta = { providerId: 'history-missing', sourceName: '该日期未保存', sourceTimestamp: null, fetchedAt: snapshot.capturedAt, cacheState: 'unavailable' }
  const ranks = { gainers: marketHistoryPanel(snapshot, 'rank.gainers'), losers: marketHistoryPanel(snapshot, 'rank.losers'),
    amount: marketHistoryPanel(snapshot, 'rank.amount'), turnover: marketHistoryPanel(snapshot, 'rank.turnover') }
  return {
    overview: marketHistoryPanel(snapshot, 'overview') ?? { indices: [], breadth: { up: null, down: null, flat: null, limitUp: null, limitDown: null, totalAmount: null }, marketStatus: 'unknown', meta: missing },
    industry: marketHistoryPanel(snapshot, 'industry') ?? { type: 'industry', sectors: [], meta: missing },
    concept: marketHistoryPanel(snapshot, 'concept') ?? { type: 'concept', sectors: [], meta: missing },
    ranks: { gainers: ranks.gainers?.entries ?? [], losers: ranks.losers?.entries ?? [], amount: ranks.amount?.entries ?? [], turnover: ranks.turnover?.entries ?? [] },
    rankSources: { gainers: ranks.gainers?.meta ?? missing, losers: ranks.losers?.meta ?? missing, amount: ranks.amount?.meta ?? missing, turnover: ranks.turnover?.meta ?? missing },
  }
}

export function useMarketHistory(client: HanaiClient) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [snapshots, setSnapshots] = useState<MarketHistorySummary[]>([])
  const [snapshot, setSnapshot] = useState<MarketHistorySnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [indexError, setIndexError] = useState(false)
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const reloadIndex = useCallback(async () => {
    try {
      const result = await client.call('market.history.list', {})
      setSnapshots(result.snapshots)
      setIndexError(false)
    } catch { setIndexError(true) }
  }, [client])
  useEffect(() => { void reloadIndex() }, [reloadIndex])

  const selectDate = useCallback((date: string | null) => {
    if (date !== null && (!isMarketDate(date) || date > beijingMarketDate())) return
    generation.current += 1
    controller.current?.abort()
    setSelectedDate(date)
    setSnapshot(null)
    setError(null)
    setLoading(date !== null)
    setRevision(value => value + 1)
  }, [])

  useEffect(() => {
    if (selectedDate === null) return
    const run = generation.current
    const request = new AbortController()
    controller.current = request
    void client.call('market.history.get', { date: selectedDate }, request.signal).then(record => {
      if (request.signal.aborted || run !== generation.current) return
      if (record !== null && record.date !== selectedDate) throw new Error('历史记录日期不匹配')
      setSnapshot(record)
    }).catch(failure => {
      if (!request.signal.aborted && run === generation.current) setError(failure instanceof Error ? failure.message : String(failure))
    }).finally(() => {
      if (!request.signal.aborted && run === generation.current) setLoading(false)
    })
    return () => request.abort()
  }, [client, revision, selectedDate])

  const dashboard = useMemo(() => snapshotDashboard(snapshot), [snapshot])
  const missing = snapshot === null ? [] : MARKET_HISTORY_PANELS.filter(key => !snapshot.records[key])
  return { selectedDate, selectDate, snapshots, snapshot, dashboard, breadth: marketHistoryPanel(snapshot, 'breadth'), loading, error, indexError, missing, reloadIndex }
}

export function MarketHistoryBar({ history, onSelect }: { history: ReturnType<typeof useMarketHistory>; onSelect: (date: string | null) => void }) {
  const today = beijingMarketDate()
  return <div className={styles['marketHistoryBar']} aria-label="市场数据日期选择">
    <label>查看日期<input aria-label="市场数据日期" type="date" max={today} value={history.selectedDate ?? today}
      onChange={event => onSelect(event.target.value === today || event.target.value === '' ? null : event.target.value)} /></label>
    <select aria-label="已保存历史日期" value={history.selectedDate ?? ''} onChange={event => onSelect(event.target.value || null)}>
      <option value="">已保存 {history.snapshots.length} 天</option>
      {history.selectedDate !== null && !history.snapshots.some(item => item.date === history.selectedDate) && <option value={history.selectedDate}>{history.selectedDate} · 暂无记录</option>}
      {history.snapshots.map(item => <option key={item.date} value={item.date}>{item.date}</option>)}
    </select>
    <button className={styles['button']} disabled={history.selectedDate === null} onClick={() => onSelect(null)}>返回今日</button>
    {history.selectedDate !== null && <small>{`历史快照 · ${history.selectedDate}${history.snapshot === null ? '' : ` · 保存于 ${dateTime(history.snapshot.capturedAt)}`}`}</small>}
    {history.indexError && <small role="alert">历史日期列表读取失败，可重试或直接选择日期。</small>}
  </div>
}
