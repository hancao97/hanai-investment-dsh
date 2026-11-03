import { useEffect, useRef, useState } from 'react'
import type { ThemeId } from '../../contracts/src/index.ts'
import { MACRO_INDICATORS, type EconomicTopic, type MacroIndicatorQuery } from '../../contracts/src/macro-indicators.ts'
import { isMacroRange, type MacroRange } from '../../contracts/src/macro-range.ts'
import { beijingMarketDate } from '../../contracts/src/market-history.ts'
import type { HanaiClient } from './api.ts'
import { EChart } from './echarts.tsx'
import { PanelHead, DataSourceText } from './panel-head.tsx'
import { getChartPalette } from './chart-options.ts'
import { useRefreshCooldown } from './market-hours.ts'
import { buildMacroIndicatorOption } from './macro-indicator-chart.ts'
import styles from './styles.module.css'

export function MacroIndicatorPage({ client, theme, topic, range, setRange }: { client: HanaiClient; theme: ThemeId; topic: EconomicTopic; range: MacroRange; setRange: (range: MacroRange) => void }) {
  const [draft, setDraft] = useState(range)
  const [result, setResult] = useState<MacroIndicatorQuery | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const refresh = useRef(false)
  const { canRefresh, cooldown, startCooldown } = useRefreshCooldown()
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const observe = async () => {
      setLoading(true)
      try {
        const force = refresh.current; refresh.current = false
        const next = await client.call('market.macro.indicators', { topic, range, refresh: force }, controller.signal)
        if (controller.signal.aborted) return
        setResult(next); setError(null)
        if (next.running || next.queued) timer = setTimeout(() => { void observe() }, 2000)
      } catch { if (!controller.signal.aborted) setError('本地数据读取失败，保留已展示数据；后台任务不受页面关闭影响') }
      finally { if (!controller.signal.aborted) setLoading(false) }
    }
    void observe()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [client, topic, range, revision])
  const busy = Boolean(result?.running || result?.queued)
  const displayRatio = (value: number | null | undefined) => value == null ? '—' : value.toFixed(2)
  const displayAmount = (value: number | null | undefined) => value == null ? '—' : `${(value / 100_000_000).toFixed(2)} 亿`
  return <div>
    <div className={styles['macroToolbar']}>
      <form className={styles['marketHistoryBar']} aria-label="宏观图表日期范围" onSubmit={event => {
        event.preventDefault()
        if (!isMacroRange(draft)) { setError('请选择有效日期范围，最长五年，结束日期不能晚于今天'); return }
        setError(null); setResult(null); setRange({ ...draft })
      }}>
        <label>开始日期 <input aria-label="开始日期" type="date" value={draft.from} max={draft.to} onChange={event => setDraft(value => ({ ...value, from: event.target.value }))} /></label>
        <label>结束日期 <input aria-label="结束日期" type="date" value={draft.to} max={beijingMarketDate()} onChange={event => setDraft(value => ({ ...value, to: event.target.value }))} /></label>
        <button className={styles['button']} type="submit">查看图表</button>
        {topic === 'breadth' && ([['1个月', 1], ['3个月', 3], ['6个月', 6], ['1年', 12]] as const).map(([label, months]) => <button className={styles['button']} type="button" key={months} onClick={() => {
          const date = new Date(`${range.to}T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() - months)
          const next = { from: date.toISOString().slice(0, 10), to: range.to }
          setDraft(next); setResult(null); setError(null); setRange(next)
        }}>{label}</button>)}
      </form>
      <button className={styles['button']} disabled={loading || busy || !canRefresh} onClick={() => { startCooldown(); refresh.current = true; setRevision(value => value + 1) }}>{busy ? '后台补齐中…' : canRefresh ? '更新当前主题' : `更新 ${cooldown}s`}</button>
    </div>
    {busy && <p role="status">当前主题后台补齐中，可切换主题或离开页面。</p>}
    {error && <p role="alert">{error}</p>}
    <div className={styles['macroIndicatorGrid']}>
      {MACRO_INDICATORS.filter(row => row.topic === topic).map(definition => {
        const data = result?.data[definition.id]
        const task = result?.tasks.find(row => row.id === definition.id)
        const valid = data?.points.filter(point => Object.values(point.values).some(value => value !== null)) ?? []
        const latest = valid.at(-1)
        const latestPeriod = definition.frequency === 'monthly' ? latest?.date.slice(0, 7) : latest?.date
        const previousMonthEnd = new Date(Date.UTC(Number(range.to.slice(0, 4)), Number(range.to.slice(5, 7)) - 1, 0)).toISOString().slice(0, 10)
        const missingTail = definition.frequency === 'monthly' && latest !== undefined && latest.date < previousMonthEnd
        return <section className={styles['card']} aria-label={definition.title} key={definition.id}>
          <PanelHead title={definition.title} extra={<span>{definition.frequency === 'monthly' ? '月频' : '日频'} · {latestPeriod ? `数据至 ${latestPeriod}` : loading ? '读取中…' : '所选范围暂无数据'}</span>} />
          <details className={styles['macroDetails']}><summary aria-label={`${definition.title}数据详情`}>
            <span className={styles['macroBrief']}>{task?.state === 'failed' ? '更新失败，保留本地数据' : task?.state === 'partial' ? '部分数据待补齐' : task?.state === 'running' || task?.state === 'pending' ? '后台补齐中' : latest ? `${valid.length} 个观测期` : '数据不可用或尚未发布'}
              {data?.meta.sourceTimestamp && <span>来源最新统计期 {definition.frequency === 'monthly' ? data.meta.sourceTimestamp.slice(0, 7) : data.meta.sourceTimestamp}</span>}
              {definition.id === 'money' && <span>2025年起M1口径调整</span>}
              {definition.id === 'arms' && <span>含估算数据时悬浮图表查看标记 · 不含未收盘当日</span>}
              {(definition.id === 'industry' || definition.id === 'retail') && <span>1—2月合并公布 · 累计线按公布期连接，单月缺口保留</span>}
              {missingTail && <span className={styles['macroPending']}>来源未覆盖所选尾部</span>}
            </span><span className={styles['macroDetailsToggle']}>数据详情</span>
          </summary><div className={styles['macroDetailBody']}>
            {data ? <DataSourceText meta={data.meta} dateLabel="数据日期" /> : <p>尚无本地数据，后台按公开来源补取。</p>}
            {task?.error && <p role="alert">{task.error}</p>}
            <p>{definition.note}</p>
            <p>{definition.frequency === 'monthly' ? '横轴为统计月份（月末坐标），不是发布日期；公开接口未提供逐期发布日期。未发布、未收录和字段缺失均留空，不补零、不按日铺平。' : '横轴为来源报价日期，非完整节假日交易日历。缺失报价不补零。'} 展示当前来源核实序列，可能包含历史修订，不代表当时可获知的数据。</p>
            {valid.length > 0 && <p>实际覆盖：{valid[0]!.date} 至 {latest!.date} · 获取时间 {data?.meta.fetchedAt}</p>}
          </div></details>
          {definition.id === 'arms' && <div className={styles['armsFigures']} aria-label="阿姆氏指标摘要">
            <div><small>量能比</small><strong>{displayRatio(latest?.values.amountRatio)}</strong><small>涨 {displayAmount(latest?.armsDetails?.upAmount)} · 跌 {displayAmount(latest?.armsDetails?.downAmount)}</small></div>
            <div><small>涨跌家数</small><strong>{latest?.armsDetails ? `${latest.armsDetails.upCount} : ${latest.armsDetails.downCount}` : '—'}</strong><small>涨跌比 {displayRatio(latest?.values.adRatio)}</small></div>
            <div><small>TRIN</small><strong>{displayRatio(latest?.values.trin)}</strong><small>{latest?.estimated ? '估算' : latest ? '收盘数据' : '暂无数据'}</small></div>
          </div>}
          {valid.length > 0 ? <EChart option={buildMacroIndicatorOption(definition, data, range, getChartPalette(theme), result?.tradingDates)} ariaLabel={`${definition.title} ${range.from} 至 ${range.to}`} style={{ height: 320 }} />
            : <p className={styles['macroEmpty']}>{task?.state === 'failed' ? '公开来源未返回所选范围数据，可展开详情查看原因。' : busy || loading ? '等待后台取得公开数据…' : '所选区间暂无有效观测，后续后台更新会重试。'}</p>}
        </section>
      })}
    </div>
  </div>
}
