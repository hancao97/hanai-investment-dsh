import { useEffect, useState } from 'react'
import type { SearchResult } from '../../contracts/src/index.ts'
import type { HanaiClient } from './api.ts'
import type { MarketLadderData } from '../../contracts/src/market-ladder.ts'
import { LADDER_BOARD_TYPE_METHOD, limitBoardType } from '../../contracts/src/market-ladder.ts'
import { marketHistoryPanel, type MarketHistorySnapshot } from '../../contracts/src/market-history.ts'
import { isClosingPanelCurrent } from './market-history.tsx'
import { isMarketOpen } from './market-hours.ts'
import { PanelHead } from './panel-head.tsx'
import { MarketPanelStatus } from './market-panel-status.tsx'
import styles from './styles.module.css'

export function useMarketLadder(client: HanaiClient, snapshot: MarketHistorySnapshot | null, historical: boolean, ready: boolean, refreshVersion: number, reloadIndex: () => Promise<void>) {
  const saved = marketHistoryPanel(snapshot, 'ladder')
  const [live, setLive] = useState<MarketLadderData | null>(null)
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
        const next = await client.call('market.ladder', {}, controller.signal)
        if (controller.signal.aborted) return
        if (next !== null) { setLive(next); void reloadIndex() }
        setFailed(next === null || next.meta.cacheState === 'stale')
      } catch { if (!controller.signal.aborted) setFailed(true) }
      finally { busy = false; if (!controller.signal.aborted) setPending(false) }
    }
    if (isMarketOpen() || saved === null || saved.method !== LADDER_BOARD_TYPE_METHOD || saved.yesterdayPerformance === undefined || !isClosingPanelCurrent(saved.meta) || refreshVersion > 0) void read()
    const timer = window.setInterval(() => { if (isMarketOpen()) void read() }, 30_000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [client, saved, historical, ready, refreshVersion, reloadIndex])
  return { data: historical ? saved : live ?? saved, failed: !historical && failed, pending: !historical && pending }
}

export function ladderThemes(data: MarketLadderData) {
  const groups = new Map<string, typeof data.stocks>()
  for (const stock of data.stocks) {
    for (const tag of new Set((stock.reason ?? '').split(/[+＋]/).map(tag => tag.trim()).filter(Boolean))) {
      groups.set(tag, [...(groups.get(tag) ?? []), stock])
    }
  }
  return [...groups].map(([name, stocks]) => ({ name, count: stocks.length, height: Math.max(...stocks.map(row => row.boards)), stocks }))
    .sort((a, b) => b.count - a.count || b.height - a.height || a.name.localeCompare(b.name, 'zh-CN'))
}

const percentage = (numerator: number | null | undefined, denominator: number | null | undefined) => numerator == null || denominator == null || denominator === 0 ? '—' : `${(numerator / denominator * 100).toFixed(1)}%`

export function MarketLadderPanels({ data, historical, failed, pending, onStock }: {
  data: MarketLadderData | null; historical: boolean; failed: boolean; pending: boolean; onStock: (stock: SearchResult) => void
}) {
  const [firstExpanded, setFirstExpanded] = useState(false)
  const [themesExpanded, setThemesExpanded] = useState(false)
  useEffect(() => { setFirstExpanded(false); setThemesExpanded(false) }, [data?.date, historical])
  const stocks = data?.stocks ?? []
  const highest = stocks.length === 0 ? 0 : Math.max(...stocks.map(row => row.boards))
  const first = stocks.filter(row => row.boards === 1)
  const themes = data === null ? [] : ladderThemes(data)
  const yesterday = data?.yesterdayPerformance
  const change = (value: number | null | undefined) => value == null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
  const changeStyle = (value: number | null | undefined) => value == null || value === 0 ? styles['flat'] : value > 0 ? styles['up'] : styles['down']
  const empty = historical ? '该日期未保存涨停梯队' : pending ? '涨停梯队加载中' : '涨停梯队暂不可用'
  const status = (topic: boolean) => {
    const issues = data?.issues.filter(issue => /题材/.test(issue) === topic) ?? []
    return <MarketPanelStatus historical={historical} items={[{ label: topic ? '题材归因' : '涨停池', meta: data?.meta, failed: failed || (!historical && issues.length > 0), ...(issues.length ? { message: issues.join('；') } : {}) }]} />
  }
  return <div className={`${styles['dashboardMainGrid']} ${styles['ladderGrid']}`}>
    <article className={`${styles['card']} ${styles['ladderCard']}`} aria-label="涨停梯队">
      <PanelHead title="涨停梯队" hint="连续涨停 · 池内统计" meta={status(false)} />
      <dl className={styles['ladderSummary']} aria-label="今日梯队摘要">
        <div className={styles['ladderSummaryTitle']}><dt>今日梯队</dt><dd hidden>情绪摘要</dd></div>
        <div><dt>涨停</dt><dd>{data === null ? '—' : stocks.length}<small> 只</small></dd></div>
        <div><dt>连板</dt><dd>{data === null ? '—' : stocks.length - first.length}<small> 只</small></dd></div>
        <div><dt>最高板</dt><dd>{data === null ? '—' : highest}<small> 板</small></dd></div>
        <div title="昨日涨停股中，今日仍涨停的比例；零样本时不计算"><dt>晋级率</dt><dd>{percentage(data?.promotion?.promoted, data?.promotion?.eligible)}{data?.promotion && <small> · {data.promotion.promoted}/{data.promotion.eligible}</small>}</dd></div>
        <div title="当前未封板的炸板股 ÷（当前涨停股＋当前未封板的炸板股），不按炸板次数累计"><dt>炸板率</dt><dd>{percentage(data?.broken, data?.broken == null ? null : data.broken + stocks.length)}</dd></div>
      </dl>
      <dl className={styles['ladderSummary']} aria-label="昨日涨停今日表现">
        <div className={styles['ladderSummaryTitle']}><dt title="昨日涨停 · 今日表现">昨日涨停</dt><dd hidden>昨日涨停股的今日涨幅</dd></div>
        <div><dt>样本</dt><dd>{yesterday?.sample ?? '—'}<small> 只</small></dd></div>
        <div><dt>平均</dt><dd className={changeStyle(yesterday?.average)}>{change(yesterday?.average)}</dd></div>
        <div><dt>中位</dt><dd className={changeStyle(yesterday?.median)}>{change(yesterday?.median)}</dd></div>
        <div title={yesterday ? `翻红 ${yesterday.up}只 · 翻绿 ${yesterday.down}只 · 平盘 ${yesterday.flat}只` : '昨日样本的今日涨幅暂不可用'}><dt>翻红率</dt><dd>{percentage(yesterday?.up, yesterday?.sample)}{yesterday && <small> · {yesterday.up}/{yesterday.sample}</small>}</dd></div>
      </dl>
      <div className={styles['ladderBody']} tabIndex={0} aria-label="涨停梯队明细">
        {data === null ? <p className={styles['ladderEmpty']}>{empty}</p> : stocks.length === 0 ? <p className={styles['ladderEmpty']}>当前涨停池为空</p> : Array.from({ length: highest }, (_, i) => highest - i).map(board => {
          const rows = stocks.filter(stock => stock.boards === board)
          return <section className={styles['ladderRow']} key={board} aria-label={board === 1 ? '首板梯队' : `${board}板梯队`}>
            <div className={styles['ladderLevel']}><b>{board === 1 ? '首板' : `${board}板`}</b><small>{rows.length}只</small></div>
            <div className={styles['ladderStocks']}>
              {rows.length === 0 ? <span className={styles['ladderGap']}>暂无个股 · 梯队断层</span> : <>
                {rows.slice(0, board === 1 && !firstExpanded ? 6 : rows.length).map(stock => <button key={stock.code} className={styles['ladderStock']} onClick={() => onStock({ secId: `${stock.code.startsWith('6') ? '1' : '0'}.${stock.code}`, code: stock.code, name: stock.name, exchange: stock.code.startsWith('6') ? 'SH' : 'SZ', pinyinFull: '', pinyinInitial: '', price: null, changePct: null })}
                  title={`${stock.name} ${stock.code}\n${stock.reason ?? `所属行业：${stock.industry}；涨停原因暂缺`}\n首次封板 ${stock.firstSeal} · 最后封板 ${stock.lastSeal}\n炸板 ${stock.breaks ?? '—'} 次 · 换手率 ${stock.turnover == null ? '—' : `${stock.turnover.toFixed(2)}%`}`}>
                  <strong>{stock.name}</strong><span title="采用来源明确标注的板型，不根据炸板次数推断">{limitBoardType(stock.boardType) ?? '板型待确认'}</span><small>{stock.reason?.split(/[+＋]/)[0] || `行业：${stock.industry}`}</small>
                </button>)}
                {board === 1 && rows.length > 6 && <button className={styles['ladderExpand']} aria-expanded={firstExpanded} onClick={() => setFirstExpanded(value => !value)}>{firstExpanded ? '收起首板' : `展开其余 ${rows.length - 6} 只`}</button>}
              </>}
            </div>
          </section>
        })}
      </div>
      <p className={styles['ladderFootnote']}>按来源涨停池筛选；与市场宽度口径不同，多题材家数不累加。</p>
    </article>
    <article className={`${styles['card']} ${styles['ladderCard']}`} aria-label="题材连板分布">
      <PanelHead title="题材连板分布" hint="按涨停原因聚合 · 可多题材" meta={status(true)} />
      <div className={styles['ladderThemes']} tabIndex={0} aria-label="题材连板明细">
        {themes.length === 0 ? <p className={styles['ladderEmpty']}>{data === null ? empty : stocks.length === 0 ? '当前无涨停题材' : '题材归因暂不可用，梯队仍可查看'}</p> : themes.slice(0, themesExpanded ? themes.length : 8).map((theme, i) => <div className={styles['ladderTheme']} key={theme.name}>
          <span>{String(i + 1).padStart(2, '0')}</span><div><b>{theme.name}</b><small>最高 {theme.height} 板 · {theme.stocks.slice(0, 3).map(stock => stock.name).join('、')}</small></div><strong>{theme.count}<small> 只</small></strong>
        </div>)}
        {themes.length > 8 && <button className={styles['ladderExpand']} aria-expanded={themesExpanded} onClick={() => setThemesExpanded(value => !value)}>{themesExpanded ? '收起题材' : `查看其余 ${themes.length - 8} 个题材`}</button>}
      </div>
    </article>
  </div>
}
