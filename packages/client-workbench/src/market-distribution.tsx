import { useEffect, useState } from 'react'
import type { HanaiClient } from './api.ts'
import { DISTRIBUTION_BINS, type MarketDistributionData } from '../../contracts/src/market-distribution.ts'
import { marketHistoryPanel, type MarketHistorySnapshot } from '../../contracts/src/market-history.ts'
import { isClosingPanelCurrent } from './market-history.tsx'
import { isMarketOpen } from './market-hours.ts'
import { EChart } from './echarts.tsx'
import { getChartPalette } from './chart-options.ts'
import type { ThemeId } from '../../contracts/src/index.ts'

export function useMarketDistribution(client: HanaiClient, snapshot: MarketHistorySnapshot | null, historical: boolean, ready: boolean, refreshVersion: number, reloadIndex: () => Promise<void>) {
  const saved = marketHistoryPanel(snapshot, 'distribution')
  const [live, setLive] = useState<MarketDistributionData | null>(null)
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    if (historical || !ready) return
    const controller = new AbortController()
    let busy = false
    const read = async () => {
      if (busy) return
      busy = true; setPending(true)
      try {
        const next = await client.call('market.distribution', {}, controller.signal)
        if (controller.signal.aborted) return
        if (next !== null) { setLive(next); void reloadIndex() }
        setFailed(next === null || next.meta.cacheState === 'stale')
      } catch { if (!controller.signal.aborted) setFailed(true) }
      finally { busy = false; if (!controller.signal.aborted) setPending(false) }
    }
    if (isMarketOpen() || saved === null || !isClosingPanelCurrent(saved.meta) || refreshVersion > 0) void read()
    const timer = window.setInterval(() => { if (isMarketOpen()) void read() }, 30_000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [client, saved, historical, ready, refreshVersion, reloadIndex])
  return { data: historical ? saved : live ?? saved, resting: !historical && live === null && saved !== null, failed: !historical && failed, pending: !historical && pending }
}

export function DistributionChart({ data, theme }: { data: MarketDistributionData; theme: ThemeId }) {
  const palette = getChartPalette(theme)
  const bins = [...DISTRIBUTION_BINS].reverse()
  return <EChart ariaLabel="A 股涨跌幅九档分布（含 ST，按涨幅区间而非涨跌停）" style={{ height: 170 }} option={{
    animation: false,
    title: { text: '涨跌分布', left: 16, top: 4, textStyle: { color: palette.legendText, fontSize: 12, fontWeight: 'normal' } },
    grid: { left: 45, right: 16, top: 26, bottom: 34 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, renderMode: 'richText' },
    xAxis: { type: 'category', data: bins.map(([, label]) => label), axisLabel: { color: palette.axisLabel, fontSize: 10, interval: 0, rotate: 25 }, axisTick: { show: false } },
    yAxis: { type: 'value', minInterval: 1, splitNumber: 3, axisLabel: { color: palette.axisLabel, fontSize: 10 }, splitLine: { lineStyle: { color: palette.splitLine, type: 'dashed' } } },
    series: [{ type: 'bar', name: '家数', barMaxWidth: 32, label: { show: true, position: 'top', color: palette.axisLabel, fontSize: 10 },
      data: bins.map(([key]) => ({ value: data.counts[key], itemStyle: { color: key.startsWith('up') ? palette.up : key.startsWith('down') ? palette.down : palette.axisLabel, borderRadius: [3, 3, 0, 0] } })) }],
  }} />
}
