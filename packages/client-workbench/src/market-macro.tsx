import { useEffect, useMemo, useRef, useState } from 'react'
import type { ThemeId } from '../../contracts/src/index.ts'
import { MACRO_ETFS, macroAllTotals } from '../../contracts/src/market-macro.ts'
import { beijingMarketDate } from '../../contracts/src/market-history.ts'
import { defaultMacroRange, isMacroRange, type MacroRange } from '../../contracts/src/macro-range.ts'
import { MACRO_TOPICS, type MacroTopic } from '../../contracts/src/macro-indicators.ts'
import { MacroIndicatorPage } from './macro-indicators.tsx'
import type { HanaiResponse } from '../../contracts/src/index.ts'
import type { HanaiClient } from './api.ts'
import { getChartPalette } from './chart-options.ts'
import { EChart } from './echarts.tsx'
import { PanelHead, DataStateBadge, DataSourceText } from './panel-head.tsx'
import { describeDataStatus } from './data-status.ts'
import { buildMacroOption, macroFourTotals, macroRatios, macroTotals } from './macro-chart.ts'
import { useRefreshCooldown } from './market-hours.ts'
import styles from './styles.module.css'

export function MacroPage({ client, theme }: { client: HanaiClient; theme: ThemeId }) {
  const [topic, setTopic] = useState<MacroTopic>('funds')
  const [ranges, setRanges] = useState<Record<MacroTopic, MacroRange>>(() => Object.fromEntries(MACRO_TOPICS.map(row => {
    const range = defaultMacroRange()
    if (row.id === 'breadth') { const from = new Date(`${range.to}T00:00:00Z`); from.setUTCMonth(from.getUTCMonth() - 3); range.from = from.toISOString().slice(0, 10) }
    return [row.id, range]
  })) as Record<MacroTopic, MacroRange>)
  const onRangeChange = (range: MacroRange) => setRanges(value => ({ ...value, [topic]: range }))
  return <div className={styles['page']}>
    <div className={styles['pageHeader']}><div><h1>宏观数据</h1><p>按主题观察资金与经济周期 · 每天后台更新 · 单次最长五年</p></div></div>
    <div className={styles['macroTabs']} role="tablist" aria-label="宏观主题">
      {MACRO_TOPICS.map((row, index) => <button key={row.id} id={`macro-tab-${row.id}`} role="tab" aria-selected={topic === row.id} aria-controls="macro-topic-panel" tabIndex={topic === row.id ? 0 : -1}
        className={`${styles['button']} ${topic === row.id ? styles['buttonSelected'] : ''}`} onClick={() => setTopic(row.id)} onKeyDown={event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % MACRO_TOPICS.length : event.key === 'ArrowLeft' ? (index + MACRO_TOPICS.length - 1) % MACRO_TOPICS.length : event.key === 'Home' ? 0 : event.key === 'End' ? MACRO_TOPICS.length - 1 : null
          if (next === null) return
          event.preventDefault(); setTopic(MACRO_TOPICS[next]!.id); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
        }}>{row.title}</button>)}
    </div>
    <div id="macro-topic-panel" role="tabpanel" aria-labelledby={`macro-tab-${topic}`}>
      {topic === 'funds' ? <MacroFundsPage client={client} theme={theme} range={ranges.funds} setRange={onRangeChange} />
        : <MacroIndicatorPage key={topic} client={client} theme={theme} topic={topic} range={ranges[topic]} setRange={onRangeChange} />}
    </div>
  </div>
}

function MacroFundsPage({ client, theme, range, setRange }: { client: HanaiClient; theme: ThemeId; range: MacroRange; setRange: (range: MacroRange) => void }) {
  const [draft, setDraft] = useState(range)
  const [result, setResult] = useState<HanaiResponse<'market.macro.query'> | null>(null)
  const [errors, setErrors] = useState<string[]>([])
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
        const force = refresh.current
        refresh.current = false
        const next = await client.call('market.macro.query', { range, refresh: force }, controller.signal)
        if (controller.signal.aborted) return
        setResult(next)
        if (next.task.state === 'running' || next.queued.length > 0) timer = setTimeout(() => { void observe() }, 2000)
      } catch {
        if (!controller.signal.aborted) setErrors(['宏观数据读取失败，已展示的数据保留；后台任务不受页面关闭影响'])
      } finally { if (!controller.signal.aborted) setLoading(false) }
    }
    void observe()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [client, range, revision])
  const generate = async () => {
    if (!canRefresh) return
    startCooldown(); setErrors([]); refresh.current = true; setRevision(value => value + 1)
  }
  const taskApplies = result?.taskRange != null && result.taskRange.from <= range.to && result.taskRange.to >= range.from
  const shownTask = taskApplies ? result?.task : null
  const generating = result?.task.state === 'running' || (result?.queued.length ?? 0) > 0
  const backfilling = generating
  const jobError = (endpoint: string) => shownTask?.panels.find(panel => panel.endpoint === endpoint)?.error ?? null
  const dailyError = jobError('market.macro.daily'), allDailyError = jobError('market.macro.allDaily'), allError = jobError('market.macro.all'), capitalError = jobError('market.macro.capital')
  const etfData = result?.data.etfs ?? null, indexData = result?.data.index ?? null, dailyData = result?.data.daily ?? null
  const allDailyData = result?.data.allDaily ?? null, allData = result?.data.allEtfs ?? null, capitalData = result?.data.capital ?? null
  const reference = capitalData?.reference
  const latestCapitalDate = [capitalData?.points.at(-1)?.date, reference?.points.at(-1)?.date].filter((date): date is string => date !== undefined).sort().at(-1)
  const ratios = macroRatios(dailyData, capitalData, allDailyData)
  const endDate = range.to
  const option = useMemo(() => buildMacroOption(etfData, indexData, getChartPalette(theme), endDate, dailyData, capitalData, allData, allDailyData, range.from), [etfData, indexData, theme, endDate, dailyData, capitalData, allData, allDailyData, range.from])
  const fourTotals = macroFourTotals(dailyData, allDailyData)
  const hasDaily = dailyData !== null || fourTotals.length > 0
  const latest = (hasDaily ? fourTotals : macroTotals(etfData)).at(-1)
  const referenceMissing = reference ? Math.max(0, reference.expectedDays - reference.points.length) : 0
  const incomplete = !hasDaily || indexData === null || ratios.length === 0 || ratios.length < fourTotals.length || dailyData?.complete === false || allDailyData?.complete === false || referenceMissing > 0
  const updateFailed = shownTask?.state === 'failed' || shownTask?.state === 'partial' || Boolean(shownTask?.archiveError) || Boolean(capitalData?.referenceError)

  const hasDailyRatio = allDailyData?.points.some(point => capitalData?.points.some(cap => cap.date === point.date) || reference?.points.some(cap => cap.date === point.date)) ?? false
  const sources = [
    dailyData ? { label: '四只ETF日规模', meta: dailyData.meta, dateLabel: '数据日期' as const, failed: dailyError !== null }
      : etfData ? { label: '四只ETF季度规模', meta: etfData.meta, dateLabel: '报告期' as const, failed: false } : null,
    indexData && { label: '沪深300指数', meta: indexData.meta, dateLabel: '交易日' as const, failed: false },
    allDailyData && { label: 'ETF日频总规模', meta: allDailyData.meta, dateLabel: '数据日期' as const, failed: allDailyError !== null },
    !hasDailyRatio && allData && { label: '在列ETF季末规模', meta: allData.meta, dateLabel: '报告期' as const, failed: allError !== null },
    capitalData && { label: '沪深300流通市值', meta: capitalData.officialMeta ?? capitalData.meta, dateLabel: '数据日期' as const, failed: capitalError !== null },
    reference && { label: '分母重建参考', meta: reference.meta, dateLabel: '数据日期' as const, failed: reference.missingDates.length > 0 || Boolean(capitalData?.referenceError) },
  ].filter(source => source !== null && source !== false && source !== undefined).map(source => ({ ...source, meta: { ...source.meta, cacheState: source.meta.cacheState === 'fresh' ? 'cached' as const : source.meta.cacheState } }))
  const sourceGroups = new Map<string, typeof sources>()
  for (const source of sources) {
    const key = JSON.stringify(describeDataStatus(source.meta, { liveCapable: false, refreshFailed: source.failed }))
    const group = sourceGroups.get(key)
    if (group === undefined) sourceGroups.set(key, [source])
    else group.push(source)
  }
  return <div>
    <div className={styles['macroToolbar']}>
      <form className={styles['marketHistoryBar']} aria-label="宏观图表日期范围" onSubmit={event => { event.preventDefault(); if (!isMacroRange(draft)) { setErrors(['请选择有效日期范围，最长五年，结束日期不能晚于今天']); return } setErrors([]); setResult(null); setRange({ ...draft }) }}>
        <label>开始日期 <input aria-label="开始日期" type="date" value={draft.from} max={draft.to} onChange={event => setDraft(value => ({ ...value, from: event.target.value }))} /></label>{' '}
        <label>结束日期 <input aria-label="结束日期" type="date" value={draft.to} max={beijingMarketDate()} onChange={event => setDraft(value => ({ ...value, to: event.target.value }))} /></label>{' '}
        <button className={styles['button']} type="submit">查看图表</button>
      </form>
      {<button className={styles['button']} disabled={loading || generating || !canRefresh} onClick={() => { void generate() }}>{generating ? '后台补齐中…' : loading ? '读取数据中' : canRefresh ? '更新数据' : `更新 ${cooldown}s`}</button>}
    </div>
    {errors.map((error, i) => <p key={i} role="alert">{error}</p>)}
    <section className={styles['card']} aria-label="沪深300 ETF宏观图表">
      <PanelHead title="沪深300 ETF规模与流通市值占比" extra={<span>{latest ? `${latest.date} · 四只合计 ${latest.assets.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 亿元` : loading ? '正在读取…' : '日规模不可用'}</span>} />
      <details className={styles['macroDetails']}>
        <summary aria-label="数据详情">
          <span className={styles['macroBrief']} aria-label="宏观数据摘要">
            {loading && result === null ? <span>正在读取本地数据…</span> : <>
              <span>{latest ? `ETF至 ${latest.date}` : 'ETF日规模不可用'}</span>
              <span>{indexData?.points.at(-1) ? `指数至 ${indexData.points.at(-1)!.date}` : '指数不可用'}</span>
              <span>{capitalData?.points.at(-1) ? `月报至 ${capitalData.points.at(-1)!.date}` : '月报暂无数据'}</span>
              {reference && <span>{referenceMissing > 0 ? `分母参考待补 ${referenceMissing} 日` : `重建参考至 ${reference.points.at(-1)?.date ?? '暂无数据'}`}</span>}
              {(incomplete || updateFailed) && <span className={styles['macroPending']}>{updateFailed ? '更新未完成，沿用已有数据' : '部分数据待补齐'}</span>}
            </>}
            {generating && <span role="status">后台补齐中，可离开页面</span>}
          </span>
          <span className={styles['macroDetailsToggle']}>数据详情</span>
        </summary>
        <div className={styles['macroDetailBody']}>
        <h3>数据来源与更新状态</h3>
        <div className={styles['macroMetadata']}>
          {shownTask?.archiveError && <small role="alert">数据保存失败：{shownTask.archiveError}</small>}
          {shownTask && shownTask.state !== 'idle' && <div role="status">
            <details><summary>{shownTask.state === 'running' ? '后台补齐中，可离开页面；保持DSH宿主运行即可继续补齐' : shownTask.state === 'completed' ? '后台更新完成，数据已保存' : '后台任务已结束，部分数据未补齐；将于后续后台更新重试，也可点击更新数据'}</summary>
            {shownTask.panels.map(panel => <small key={panel.endpoint}>{panel.label}：{panel.state === 'pending' ? '等待中' : panel.state === 'running' ? '补齐中' : panel.state === 'completed' ? '完成' : panel.state === 'partial' ? '有缺口' : '失败'}{panel.total > 1 ? ' · 已检查 ' + panel.checked + (panel.endpoint === 'market.macro.capital' ? ' 项（月报月份＋参考交易日）' : ' / ' + panel.total + ' 日') : ''}{panel.missing > 0 ? ' · 缺口 ' + panel.missing + ' 日' : ''}{panel.error ? ' · ' + panel.error : ''}<br /></small>)}
            </details>
          </div>}
          {[...sourceGroups].map(([key, rows]) => <div className={styles['macroMetadataGroup']} key={key}>
            <DataStateBadge meta={rows[0]!.meta} history={false} liveCapable={false} refreshFailed={rows[0]!.failed} />
            <div className={styles['macroSources']}>{rows.map(source => <div className={styles['macroSourceRow']} key={source.label}>
              <span>{source.label}：</span><DataSourceText meta={source.meta} dateLabel={source.dateLabel} />
            </div>)}</div>
          </div>)}
          {allDailyError && <small role="alert">{allDailyError}</small>}
          {allError && <small role="alert">{allError}</small>}
          {capitalError && <small role="alert">{capitalError}</small>}
          {dailyError && <small role="alert">{dailyError}</small>}
        </div>
        <h3>图表口径与数据完整性</h3>
        <div className={styles['macroNotice']}>
        <p>{ratios.length > 0 ? `上图红线：四只ETF同日规模 ÷ 沪深300流通市值 × 100（月报优先，重建参考段单独标注）；已匹配 ${ratios.length} 个交易日（${ratios[0]!.date} 至 ${ratios.at(-1)!.date}），缺少同日分子或分母处断线，不沿用其它日期数值。` : capitalData ? '占比不可用：已保存流通市值与四只ETF日频规模尚无同日交集，请后台继续补齐。' : '占比不可用：尚未保存上交所月报沪深300流通市值，后台将补齐数据；不以总市值或指数点位替代。'}</p>
        {capitalData && latest && latestCapitalDate && latestCapitalDate < latest.date && <p>{`近期占比缺口：流通市值（含重建参考）仅覆盖至 ${latestCapitalDate}，ETF规模已至 ${latest.date}；后续区间暂缺同日分母，待来源发布后由后台更新，不表示ETF规模停止变化。`}</p>}
        {reference && <p>{`分母重建参考：已取得 ${reference.points.length} / ${reference.expectedDays} 个交易日${reference.points.length > 0 ? `（${reference.points[0]!.date} 至 ${reference.points.at(-1)!.date}）` : ''}，按历史成分周快照汇总300只股票的同日流通市值；周快照不保证精确调样日，与月报存在口径差异。上图红色虚线和蓝色点线为参考段，官方月报可用时优先使用月报，不作比例校准。`}</p>}
        {capitalData?.referenceError && <p role="alert">重建参考失败：{capitalData.referenceError}；保留已保存数据。</p>}
        {reference && reference.missingDates.length > 0 && <details><summary>查看分母重建缺口（后续后台更新重试）</summary>{reference.missingDates.map(row => <p key={row.date}>{row.date} · {row.reason}</p>)}</details>}
        <p>{allDailyData && allDailyData.points.length > 0 ? `蓝色虚线为已核实目录ETF日频占比；下图蓝色面积为其它ETF规模，与同一批计算的四只ETF规模堆叠，上边界为日频总规模。按实际上市日纳入，清算后不再纳入；已核实 ${allDailyData.funds.length} 个当前或历史代码，目录仍可能漏掉其它历史产品。` : allData ? `蓝色虚线为季末占比参考：按 ${allData.universeAsOf} 中证目录在列的 ${allData.funds.length} 只沪深上市被动沪深300ETF统计，排除联接、增强和海外上市产品；每个季末须当时已成立的在列产品数据全部齐全，并有同日流通市值。仅有真实季末观测点，连线仅作阅读参考，不是日频；当前目录可能漏掉已退市产品，不代表完整历史全集。` : '季末占比参考不可用：尚未保存中证在列ETF目录与季末规模，后台补齐后读取。'}</p>
        {!hasDailyRatio && allData && <p>{`日频总规模尚未匹配流通市值，蓝色虚线暂保留季末参考。已取得 ${macroAllTotals(allData).length} 个完整季末；匹配流通市值 ${macroAllTotals(allData).filter(point => capitalData?.points.some(cap => cap.date === point.date)).length} 个，未匹配处不画占比。`}</p>}
        <p>日频规模按交易所同日份额 × 未复权单位净值计算，不是资金净流入；缺任一应纳入产品则该日总规模留空，不将季度规模插值为日频。</p>
        {allDailyData && <p>{`总规模日频覆盖 ${allDailyData.points.length} / ${allDailyData.expectedDays} 个交易日 · 已检查 ${allDailyData.points.length + allDailyData.missingDates.length} 日 · 缺口 ${allDailyData.missingDates.length} 日`}</p>}
        {allDailyData && allDailyData.missingDates.length > 0 && <details><summary>查看总规模缺口（后续后台更新重试）</summary>{allDailyData.missingDates.map(row => <p key={row.date}>{row.date} · {row.reason}</p>)}</details>}
        {dailyData && <p>{`日频覆盖 ${dailyData.points.length} / ${dailyData.expectedDays} 个交易日${dailyData.complete ? '' : ' · 历史尚未补齐'}`}{backfilling ? ' · 后台正在分批补齐；离开页面仍会继续，重新打开可查看进度' : ''}</p>}
        {!hasDaily && <p>{generating ? '后台任务正在读取日份额；红色虚线仅为季度参考。' : '尚未生成日频记录，后台将补齐数据并保存；来源未提供时保留缺口。'}</p>}
        {indexData === null && <p>沪深300点位不可用</p>}
        {etfData === null && !hasDaily && <p>四只ETF规模不可用</p>}
        </div>
        <p>{MACRO_ETFS.map(fund => `${fund.name} ${fund.code}`).join(' / ')}</p>
        </div>
      </details>
      <EChart option={option} ariaLabel={`${range.from} 至 ${range.to} 沪深300指数与ETF规模交互图`} className={styles['macroChart'] ?? ''} />

    </section>
  </div>
}
