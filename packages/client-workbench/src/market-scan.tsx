import { useCallback, useEffect, useRef, useState } from 'react'
import type { HanaiClient } from './api.ts'
import { DEFAULT_SCAN_QUERY, normalizeScanQuery, SCAN_FIELDS, SCAN_PRESETS, scanQueryError, type MarketScanQuery, type MarketScanResult, type MarketScanStock, type ScanMetric, type ScanSort } from '../../contracts/src/market-scan.ts'
import type { MarketHistorySummary } from '../../contracts/src/market-history.ts'
import { beijingMarketDate } from '../../contracts/src/market-history.ts'
import { isMarketOpen, useRefreshCooldown } from './market-hours.ts'
import { PanelHead, PanelDataMeta } from './panel-head.tsx'
import { classForChange, number, percent } from './format.ts'
import { scanCsv } from './market-scan-data.ts'
import styles from './market-scan.module.css'
import ui from './styles.module.css'

const text = (error: unknown) => error instanceof Error ? error.message : String(error)
const identity = (query: MarketScanQuery) => JSON.stringify(normalizeScanQuery(query))
const columnLabels: Record<ScanSort, string> = { code: '代码', price: '价格', changePct: '涨跌幅', ...Object.fromEntries(Object.entries(SCAN_FIELDS).map(([key, item]) => [key, `${item.label}${item.unit === '倍' ? '' : `（${item.unit}）`}`])) } as Record<ScanSort, string>
const columns: ScanSort[] = ['price', 'changePct', 'pe', 'pb', 'roe', 'netMargin', 'revenueGrowth', 'profitGrowth', 'netInflow5d', 'marketCap', 'dividendYield', 'grossMargin']
export function MarketScanPage({ client, onStock }: { client: HanaiClient; onStock: (row: Pick<MarketScanStock, 'secId'>) => void }) {
  const [draft, setDraft] = useState(DEFAULT_SCAN_QUERY)
  const [query, setQuery] = useState(DEFAULT_SCAN_QUERY)
  const [expert, setExpert] = useState(false)
  const [date, setDate] = useState<string | null>(null)
  const [dates, setDates] = useState<MarketHistorySummary[]>([])
  const [result, setResult] = useState<MarketScanResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const { cooldown, canRefresh, startCooldown } = useRefreshCooldown()
  const invalid = scanQueryError(draft)
  const data = result?.data ?? null
  const dirty = identity(draft) !== identity(query)
  const load = useCallback(async (refresh = false) => {
    if (controller.current && !controller.current.signal.aborted) return
    const request = new AbortController(); controller.current = request; setLoading(true)
    try {
      const next = await client.call('market.scan.query', { query, ...(date ? { date } : {}), ...(refresh ? { refresh: true } : {}) }, request.signal)
      if (!request.signal.aborted) setResult(next)
    } catch (cause) {
      if (!request.signal.aborted) setResult(previous => ({ historical: date !== null, error: text(cause), data: previous?.data && identity(previous.data.query) === identity(query) && previous.historical === (date !== null) ? { ...previous.data, meta: { ...previous.data.meta, cacheState: 'stale' } } : null }))
    } finally { if (!request.signal.aborted) setLoading(false); if (controller.current === request) controller.current = null }
  }, [client, query, date])
  useEffect(() => {
    setResult(null); void load()
    const timer = window.setInterval(() => { if (date === null && isMarketOpen()) void load() }, 30_000)
    return () => { controller.current?.abort(); controller.current = null; window.clearInterval(timer) }
  }, [load, date])
  useEffect(() => {
    const request = new AbortController(); setDates([]); setHistoryError(null)
    void client.call('market.scan.history', { query }, request.signal).then(rows => { if (!request.signal.aborted) setDates(rows) }).catch(cause => { if (!request.signal.aborted) setHistoryError(`历史索引读取失败：${text(cause)}`) })
    return () => request.abort()
  }, [client, query, data?.meta.fetchedAt])
  const apply = (next = draft) => { if (scanQueryError(next)) return; const applied = normalizeScanQuery({ ...next, page: 1 }); setDraft(applied); if (identity(applied) === identity(query)) void load(); else setQuery(applied) }
  const range = (field: ScanMetric, side: 'min' | 'max', value: string) => setDraft(current => {
    const next = { ...current.ranges[field] }; if (value === '') delete next[side]; else next[side] = Number(value)
    const ranges = { ...current.ranges }; if (Object.keys(next).length) ranges[field] = next; else delete ranges[field]
    return { ...current, ranges, page: 1 }
  })
  const sort = (field: ScanSort) => {
    const next = { ...query, page: 1, sort: field, order: query.sort === field && query.order === 'desc' ? 'asc' as const : 'desc' as const }
    setDraft(next); setQuery(next)
  }
  const chips = data ? Object.entries(data.query.ranges).map(([key, value]) => `${SCAN_FIELDS[key as ScanMetric].label} ${value.min === undefined ? '' : `≥${value.min}`} ${value.max === undefined ? '' : `≤${value.max}`} ${SCAN_FIELDS[key as ScanMetric].unit}`) : []
  const exportRows = () => {
    if (!data) return
    const url = URL.createObjectURL(new Blob(['\uFEFF', scanCsv(data)], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = `market-scan-${data.snapshotDate ?? data.collectedOn}-page-${data.query.page}.csv`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <section className={styles.page} aria-label="市场扫描">
    <div className={styles.heading}><div><h1>市场扫描器</h1><p>A 股财务条件扫描 · 服务端筛选与排序，非榜单样本过滤</p></div><div className={styles.actions}><label>快照日期<select aria-label="扫描历史日期" value={date ?? ''} onChange={e => setDate(e.target.value || null)}><option value="">最新查询</option>{date && !dates.some(row => row.date === date) && <option value={date}>{date} · 未保存</option>}{dates.map(row => <option key={row.date} value={row.date}>{row.date}</option>)}</select></label><input aria-label="扫描历史日历" type="date" max={beijingMarketDate()} value={date ?? ''} onChange={e => setDate(e.target.value || null)} /><button className={ui.button} disabled={!data || loading} onClick={exportRows}>导出当前页</button><button className={ui.button} disabled={date !== null || loading || !canRefresh} onClick={() => { if (!canRefresh) return; startCooldown(); void load(true) }}>{loading ? '查询中…' : cooldown ? `${cooldown}秒后刷新` : '刷新数据'}</button></div></div>
    <div className={styles.layout}>
      <aside className={styles.panel}><PanelHead title="筛选器" extra={<button className={ui.button} aria-pressed={expert} onClick={() => setExpert(value => !value)}>Expert {expert ? 'ON' : 'OFF'}</button>} />
        <div className={styles.presets}><span>快速策略</span>{SCAN_PRESETS.map(preset => <button className={ui.button} key={preset.name} disabled={loading} onClick={() => apply({ ...DEFAULT_SCAN_QUERY, ranges: preset.ranges })}>{preset.name}</button>)}<button className={ui.button} disabled={loading} onClick={() => apply(DEFAULT_SCAN_QUERY)}>重置全部</button></div>
        <form className={styles.filters} onSubmit={e => { e.preventDefault(); apply() }}><label>名称／代码<input aria-label="扫描名称代码" value={draft.search} maxLength={80} placeholder="服务端全市场查询" onChange={e => setDraft(current => ({ ...current, search: e.target.value, page: 1 }))} /></label>
          {Object.entries(SCAN_FIELDS).filter(([key, field]) => !field.advanced || expert || draft.ranges[key as ScanMetric]).map(([key, field]) => <fieldset key={key}><legend>{field.label}（{field.unit}）{field.advanced && !expert ? ' · 保留的高级条件' : ''}</legend><input aria-label={`${field.label}下限`} type="number" step="any" placeholder="下限" value={draft.ranges[key as ScanMetric]?.min ?? ''} onChange={e => range(key as ScanMetric, 'min', e.target.value)} />{field.maximum && <><span>—</span><input aria-label={`${field.label}上限`} type="number" step="any" placeholder="上限" value={draft.ranges[key as ScanMetric]?.max ?? ''} onChange={e => range(key as ScanMetric, 'max', e.target.value)} /></>}</fieldset>)}
          {!expert && <p>展开 Expert 可设置市值、股息率、资金和利润率；收起不删除已生效条件。</p>}{invalid && <p role="alert" className={styles.error}>{invalid}</p>}<button className={ui.buttonPrimary} disabled={loading || invalid !== null} type="submit">应用筛选</button>{dirty && <small>条件已修改，应用后查询</small>}
        </form>
      </aside>
      <section className={styles.panel}><PanelHead title="扫描结果" hint={data ? `匹配 ${data.total.toLocaleString()} 只 · 当前页 ${data.stocks.length} 只` : '尚无可用结果'} meta={<PanelDataMeta liveCapable={false} dateLabel="数据日期" meta={data?.meta} history={date !== null} refreshFailed={Boolean(result?.error)} />} />
        {(result?.error || historyError) && <p role="alert" className={styles.error}>{result?.error}{historyError ? ` ${historyError}` : ''}</p>}
        {data && <div className={styles.scope}><b>实际展示条件：</b>{data.query.search ? `名称/代码含“${data.query.search}”；` : ''}{chips.length ? chips.join('；') : '无财务条件'} · {columnLabels[data.query.sort]}{data.query.order === 'desc' ? '降序' : '升序'} · 第 {data.query.page} 页{loading ? ' · 正在更新，暂保留本查询已有结果' : ''}</div>}
        <p className={styles.scope}>来源快照日：{data?.snapshotDate ?? '未提供'}；不代表各公司财报期或实时报价。财务/股息/资金字段可能缺失或滞后，— 为未提供，0 保留来源原值。</p>
        <div className={styles.table}><table><thead><tr><th><button onClick={() => sort('code')} disabled={loading}>代码{query.sort === 'code' ? query.order === 'desc' ? ' ↓' : ' ↑' : ''}</button></th><th>名称</th>{columns.map(key => <th key={key} aria-sort={data?.query.sort === key ? data.query.order === 'desc' ? 'descending' : 'ascending' : 'none'}><button disabled={loading || dirty || invalid !== null} onClick={() => sort(key)}>{columnLabels[key]}{query.sort === key ? query.order === 'desc' ? ' ↓' : ' ↑' : ''}</button></th>)}<th>行业</th></tr></thead><tbody>{data?.stocks.map(stock => <tr key={stock.secId}><td>{stock.code}</td><td><button disabled={date !== null} title={date ? '历史结果只读，不跳转实时行情' : '打开个股详情'} onClick={() => onStock(stock)}>{stock.name}</button></td>{columns.map(key => <td key={key} className={key === 'changePct' ? ui[classForChange(stock.changePct)] : undefined}>{key === 'changePct' ? percent(stock.changePct) : number(stock[key as keyof MarketScanStock] as number | null)}</td>)}<td>{stock.industry ?? '—'}</td></tr>)}</tbody></table>{!data?.stocks.length && <p className={styles.empty}>{loading ? '正在查询全市场财务汇总…' : data?.total === 0 ? '本次查询没有匹配股票' : data ? '当前页没有记录，请返回前一页' : '暂无可用扫描数据'}</p>}</div>
        <div className={styles.pagination}><button className={ui.button} disabled={loading || dirty || query.page <= 1} onClick={() => { const next = { ...query, page: query.page - 1 }; setDraft(next); setQuery(next) }}>上一页</button><span>第 {query.page} 页 · 每页最多 100 条</span><button className={ui.button} disabled={loading || dirty || !data || query.page * 100 >= data.total} onClick={() => { const next = { ...query, page: query.page + 1 }; setDraft(next); setQuery(next) }}>下一页</button></div>
      </section>
    </div>
  </section>
}
