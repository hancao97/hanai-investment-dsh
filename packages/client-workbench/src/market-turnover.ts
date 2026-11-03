import { useEffect, useState } from 'react'
import type { MarketOverview } from '../../contracts/src/index.ts'
import { isMarketDate, marketHistoryPanel, type MarketHistorySummary } from '../../contracts/src/market-history.ts'
import type { HanaiClient } from './api.ts'
import { isClosingPanelCurrent } from './market-history.tsx'

/** Reuse the page's weekday policy; missing holiday records stay unavailable rather than skipping dates. */
export function usePreviousTurnover(client: HanaiClient, date: string | null, snapshots: MarketHistorySummary[], refreshVersion: number) {
  let previousDate: string | null = null
  if (date !== null && isMarketDate(date)) {
    const day = new Date(`${date}T00:00:00Z`)
    do { day.setUTCDate(day.getUTCDate() - 1) } while (day.getUTCDay() === 0 || day.getUTCDay() === 6)
    previousDate = day.toISOString().slice(0, 10)
  }
  const savedAt = snapshots.find(row => row.date === previousDate && row.panels.includes('overview'))?.capturedAt ?? null
  const [result, setResult] = useState<{ date: string; data: MarketOverview | null; error: string | null } | null>(null)
  useEffect(() => {
    if (previousDate === null || savedAt === null) return
    const target = previousDate
    const controller = new AbortController()
    void client.call('market.history.get', { date: target }, controller.signal).then(snapshot => {
      if (controller.signal.aborted) return
      if (snapshot !== null && snapshot.date !== target) throw new Error('昨日成交归档日期不匹配')
      const overview = marketHistoryPanel(snapshot, 'overview')
      const complete = overview !== null && isClosingPanelCurrent(overview.meta, new Date(`${target}T23:59:59+08:00`))
      setResult({ date: target, data: complete ? overview : null, error: null })
    }).catch(() => {
      if (!controller.signal.aborted) setResult({ date: target, data: null, error: '昨日成交归档读取失败' })
    })
    return () => controller.abort()
  }, [client, previousDate, savedAt, refreshVersion])
  return { date: previousDate, data: savedAt !== null && result?.date === previousDate ? result.data : null,
    error: savedAt !== null && result?.date === previousDate ? result.error : null }
}
