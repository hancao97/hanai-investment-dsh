import { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ExpertChat, WatchGroup } from '../../contracts/src/index.ts'
import { describeTechnicalRule } from '../../contracts/src/technical-screen.ts'
import { TechnicalFunnel } from './technical-funnel.tsx'
import { StockDataReadiness } from './stock-data.tsx'
import { SCREENER_STARTERS, type ScreeningRun } from '../../contracts/src/ai-screener.ts'
import { SCAN_FIELDS, type MarketScanStock, type ScanMetric } from '../../contracts/src/market-scan.ts'
import { ChatPanel } from '../../client-chat/src/index.tsx'
import type { HanaiClient } from './api.ts'
import { PanelHead, PanelDataMeta } from './panel-head.tsx'
import { classForChange, dateTime, number, percent } from './format.ts'
import styles from './ai-screener.module.css'
import ui from './styles.module.css'

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
const stateLabels = { parsing: '解析条件中', 'needs-confirmation': '等待确认', scanning: '扫描候选中', ready: '已出结果', failed: '未完成' }
export function AiScreenerPage({ client, selectedId, onOpen, onHome, onStock, groups, onGroups, onDataSettings }: { client: HanaiClient; selectedId: string | null; onOpen: (id: string) => void; onHome: () => void; onStock: (stock: { secId: string }) => void; groups: WatchGroup[]; onGroups: (groups: WatchGroup[]) => void; onDataSettings?: () => void }) {
  const [chats, setChats] = useState<ExpertChat[]>([])
  const [loaded, setLoaded] = useState(false)
  const [run, setRun] = useState<ScreeningRun | null>(null)
  const [runLoaded, setRunLoaded] = useState(false)
  const [draft, setDraft] = useState('')
  const [filter, setFilter] = useState('')
  const [model, setModel] = useState('')
  const [models, setModels] = useState<ModelProviderGroup[]>([])
  const [modelError, setModelError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const lock = useRef(false), mounted = useRef(true), selectedRef = useRef(selectedId)
  selectedRef.current = selectedId
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [showChat, setShowChat] = useState(false)
  const [revision, setRevision] = useState(0)
  const [groupId, setGroupId] = useState('')
  const historyRef = useRef<HTMLElement>(null)
  const selected = chats.find(chat => chat.id === selectedId)
  const activeGroup = groups.find(group => group.id === groupId) ?? groups.find(group => group.isDefault) ?? groups[0]
  const data = run?.result?.data ?? null
  const stocks = data?.stocks.slice(0, 20) ?? []
  const reload = useCallback(async () => {
    try { const next = await client.call('screener.list', {}); if (mounted.current) { setChats(next); setLoaded(true) } }
    catch (cause) { if (mounted.current) { setError(errorText(cause)); setLoaded(true) } }
  }, [client])
  useEffect(() => {
    mounted.current = true; void reload()
    void client.models().then(rows => { if (mounted.current) setModels(rows) }).catch(cause => { if (mounted.current) setModelError(errorText(cause)) })
    return () => { mounted.current = false }
  }, [client, reload])
  useEffect(() => {
    const request = new AbortController(); let timer: number | undefined
    setRun(null); setRunLoaded(false); setError(null); setNotice(null); setShowChat(false)
    if (selectedId === null) return () => request.abort()
    const load = async () => {
      try {
        const next = await client.call('screener.result', { id: selectedId }, request.signal)
        if (request.signal.aborted) return
        setRun(next); setRunLoaded(true)
        if (next && ['parsing', 'scanning'].includes(next.status)) timer = window.setTimeout(() => void load(), 1500)
        else void reload()
      } catch (cause) { if (!request.signal.aborted) { setError(errorText(cause)); setRunLoaded(true) } }
    }
    void load()
    return () => { request.abort(); window.clearTimeout(timer) }
  }, [client, selectedId, revision, reload])
  const start = async (retry = false) => {
    const question = retry ? run?.question : draft.trim()
    if (lock.current || !question || (retry && run?.status !== 'failed')) return
    lock.current = true; setBusy(true); setError(null)
    const [provider, id] = model.split('\0'), origin = selectedRef.current
    const chosenModel = retry
      ? selected?.modelProvider && selected.model ? { provider: selected.modelProvider, model: selected.model, ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}) } : undefined
      : provider && id ? { provider, model: id } : undefined
    try {
      const chat = await client.call('screener.create', { openingMessage: question, ...(chosenModel ? { model: chosenModel } : {}) })
      if (mounted.current) { setChats(rows => [chat, ...rows.filter(row => row.id !== chat.id)]); if (!retry) setDraft(''); if (selectedRef.current === origin) onOpen(chat.id) }
    } catch (cause) { if (mounted.current) { setError(errorText(cause)); void reload() } }
    finally { lock.current = false; if (mounted.current) setBusy(false) }
  }
  const execute = async () => {
    if (!selectedId || lock.current) return
    const id = selectedId; lock.current = true; setBusy(true); setError(null)
    try { const next = await client.call('screener.execute', { id }); if (mounted.current && selectedRef.current === id) { setRun(next); setRevision(value => value + 1) } }
    catch (cause) { if (mounted.current && selectedRef.current === id) setError(errorText(cause)) }
    finally { lock.current = false; if (mounted.current) setBusy(false) }
  }
  const remove = async (id: string) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(null)
    try { const next = await client.call('screener.remove', { id }); if (mounted.current) { setChats(next); setDeleteId(null); if (selectedRef.current === id) onHome() } }
    catch (cause) { if (mounted.current) setError(errorText(cause)) }
    finally { lock.current = false; if (mounted.current) setBusy(false) }
  }
  const addWatch = async (stock: MarketScanStock) => {
    if (!activeGroup || lock.current) return
    lock.current = true; setBusy(true); setError(null)
    try { const next = await client.call('watch.item.add', { groupId: activeGroup.id, secId: stock.secId }); if (mounted.current) { onGroups(next); setNotice(`${stock.name}已加入当前自选`) } }
    catch (cause) { if (mounted.current) setError(errorText(cause)) }
    finally { lock.current = false; if (mounted.current) setBusy(false) }
  }
  const meaningful = run?.plan && (Boolean(run.plan.technical) || Object.keys(run.plan.query.ranges).length > 0 || run.plan.query.search !== '' || Boolean(run.plan.query.industries?.length))
  const conditions = run?.plan ? [...Object.entries(run.plan.query.ranges).map(([key, value]) => `${SCAN_FIELDS[key as ScanMetric].label} ${value.min === undefined ? '' : `≥${value.min}`} ${value.max === undefined ? '' : `≤${value.max}`} ${SCAN_FIELDS[key as ScanMetric].unit}`), ...(run.plan.query.industries?.length ? [`行业：${run.plan.query.industries.join('、')}`] : []), ...(run.plan.query.search ? [`名称/代码：${run.plan.query.search}`] : [])] : []
  return <section className={styles.page} aria-label="AI选股">
    {onDataSettings && <StockDataReadiness client={client} onSettings={onDataSettings} />}
    <header className={styles.head}><div><h1>AI选股</h1><p>自然语言 → 可确认公式 → 后台扫描与命中依据</p></div><div><button className={ui.button} onClick={() => historyRef.current?.scrollIntoView({ block: 'nearest' })}>查看历史查询 · {chats.length}</button><button className={ui.buttonPrimary} disabled={busy} onClick={() => { setDraft(''); onHome() }}>新查询</button></div></header>
    {error && <p className={styles.error} role="alert">{error}<button className={ui.button} onClick={() => { void reload(); setRevision(value => value + 1) }}>重新读取</button></p>}{notice && <p className={styles.notice} role="status">{notice}</p>}
    <div className={styles.summary}><span>示例条件 {SCREENER_STARTERS.length}</span><span>历史查询 {loaded ? chats.length : '…'}</span><span>当前状态 {selectedId === null ? '待输入' : !runLoaded ? '读取中' : run ? stateLabels[run.status] : '原始对话'}</span></div>
    <form className={styles.composer} onSubmit={e => { e.preventDefault(); void start() }}><textarea aria-label="AI选股问题" maxLength={4000} value={draft} onChange={e => setDraft(e.target.value)} placeholder="例如：市值100亿元以上，ROE不低于15%的A股" disabled={busy} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) { e.preventDefault(); void start() } }} /><div><select aria-label="AI选股模型" value={model} onChange={e => setModel(e.target.value)} disabled={busy}><option value="">DSH 默认模型</option>{models.map(provider => <optgroup label={provider.name} key={provider.id}>{provider.models.map(item => <option key={item.id} value={`${provider.id}\0${item.id}`}>{item.name}</option>)}</optgroup>)}</select><small>Enter 开始 · Shift+Enter 换行</small><button className={ui.buttonPrimary} disabled={busy || !draft.trim()} type="submit">{busy ? '正在处理…' : '开始选股'}</button></div>{modelError && <small>模型目录读取失败，仍可用默认模型：{modelError}</small>}</form>
    <div className={styles.starters} aria-label="选股示例">{SCREENER_STARTERS.map(starter => <button key={starter.title} className={ui.button} disabled={busy} onClick={() => setDraft(starter.question)}>{starter.title}</button>)}</div>
    <div className={styles.layout}><aside ref={historyRef} className={styles.history}><h2>查询历史</h2><input aria-label="搜索AI选股历史" placeholder="搜索查询标题" value={filter} onChange={e => setFilter(e.target.value)} />{!loaded ? <p>正在读取…</p> : chats.length === 0 ? <p>还没有查询记录</p> : chats.filter(chat => chat.title.toLowerCase().includes(filter.toLowerCase())).map(chat => <div className={selectedId === chat.id ? styles.active : styles.historyItem} key={chat.id}><button disabled={busy} onClick={() => onOpen(chat.id)}><b>{chat.title}</b><small>{dateTime(chat.createdAt)}</small></button>{deleteId === chat.id ? <div><button className={ui.button} disabled={busy} onClick={() => void remove(chat.id)}>确认删除</button><button className={ui.button} onClick={() => setDeleteId(null)}>取消</button></div> : <button className={styles.remove} disabled={busy} aria-label={`删除查询：${chat.title}`} onClick={() => setDeleteId(chat.id)}>×</button>}</div>)}</aside>
    <div className={styles.main}>
      {selectedId === null ? <section className={styles.welcome}><h2>描述想找的公司，而不只是行业名字</h2><p>支持财务条件和受控技术公式。AI补充的均线周期、阈值、窗口等假设会先展示确认。</p><div><span>盈利质量</span><span>估值区间</span><span>行业与规模</span><span>数据缺口</span></div><p>股票范围与指标来自本地数据；缺口由宿主后台同步，技术条件按公开日线计算，历史涨停用日期明确的收盘池交叉核验。模型不凭记忆编造命中。</p></section> : !runLoaded ? <p>正在读取查询…</p> : run === null ? <section className={styles.panel}><PanelHead title={error || selected?.errorMessage ? "结构化结果不可用" : "旧版研究对话"} /><p className={styles.note}>{error ? "请重试读取；若刚更新代码，请重启宿主。" : selected?.errorMessage ?? "这条记录没有结构化候选，保留原 DSH 对话；可在上方重新提问。"}</p></section> : <>
        <section className={styles.panel}><PanelHead title={stateLabels[run.status]} hint={run.finishedAt ? `完成于 ${dateTime(run.finishedAt)}` : `创建于 ${dateTime(run.startedAt)}`} meta={data && <PanelDataMeta meta={data.meta} history={!run.result?.error} liveCapable={false} dateLabel="数据日期" refreshFailed={Boolean(run.result?.error)} />} /><div className={styles.plan}><b>原始问题</b><p>{run.question}</p>{run.plan && <><b>AI条件解读</b><p>{run.plan.interpretation}</p><b>实际可执行条件</b><p>排序：{run.plan.query.sort in SCAN_FIELDS ? SCAN_FIELDS[run.plan.query.sort as ScanMetric].label : run.plan.query.sort === 'price' ? '价格' : run.plan.query.sort === 'code' ? '代码' : '涨跌幅'} · {run.plan.query.order === 'desc' ? '降序' : '升序'}</p><div className={styles.chips}>{conditions.length ? conditions.map(condition => <span key={condition}>{condition}</span>) : <span>{run.plan.technical ? '未附加财务或行业条件' : '尚无可执行条件'}</span>}</div>{run.plan.technical && <><b>技术筛选公式 · {run.plan.technical.match === 'all' ? '全部满足' : '任一满足'}</b><p>{run.plan.technical.adjust === 'qfq' ? '前复权' : '不复权'}日线；只使用已收盘交易日。财务条件与技术公式整体为 AND。</p><ol>{run.plan.technical.rules.map((rule, index) => <li key={index}>{describeTechnicalRule(rule)}</li>)}</ol></>}{run.plan.assumptions.length > 0 && <div className={styles.warning}><b>需要确认的口径</b><ul>{run.plan.assumptions.map(item => <li key={item}>{item}</li>)}</ul></div>}{run.plan.unsupported.length > 0 && <div className={styles.warning}><b>本接口无法验证的条件</b><ul>{run.plan.unsupported.map(item => <li key={item}>{item}</li>)}</ul><p>下方候选仅符合已执行条件，不能视为符合原问题的全部条件。</p></div>}</>}{run.progress && <div className={styles.note} role="status"><p>后台技术扫描 · {run.progress.phase === 'universe' ? '正在枚举全部目录' : run.progress.phase === 'finished' ? '扫描结束' : run.progress.phase === 'history' ? '正在准备历史涨停证据' : '分批核验中'} · 已检查 {run.progress.checked}/{run.progress.total} · 命中 {run.progress.matched} · 未核实 {run.progress.unverified}</p><p>技术基准日 {run.progress.asOf ?? '确定中'} · 当前目录快照 {run.progress.catalogueDate ?? '读取中'}；当前存续目录不含完整退市历史。离开页面继续执行，宿主重启后续传。</p>{run.progress.unverified > 0 && <details><summary>未核实样例（最多20条）</summary><ul>{run.progress.samples.map(row => <li key={row.code}>{row.code}：{row.reason}</li>)}</ul><p>未核实不算命中，也不代表确定不符合；源缺失及历史池排除范围会限制覆盖。</p></details>}</div>}{run.error && <p className={styles.error} role="alert">{run.error}</p>}{run.status === 'needs-confirmation' && <button className={ui.buttonPrimary} disabled={busy || !meaningful} onClick={() => void execute()}>{run.plan?.technical ? '确认公式并后台扫描' : '确认上述口径，仅执行可用条件'}</button>}{run.status === 'failed' && run.plan && meaningful && <button className={ui.button} disabled={busy} onClick={() => void execute()}>重试候选查询</button>}{run.status === 'failed' && (!run.plan || !meaningful) && <><button className={ui.button} disabled={busy || !selected} onClick={() => void start(true)}>{busy ? '正在重试…' : '重试解析'}</button><p className={styles.note}>沿用原始问题和原模型新建查询，保留这条失败记录。</p></>}{run.status === 'parsing' && <p>DSH 正在解析条件；如需工具审批，请展开下方解析对话。</p>}{run.status === 'scanning' && <p>{run.plan?.technical ? '任务已交给宿主后台，关闭值见不会取消。队列按查询顺序执行。' : '已解析条件，正在读取同口径财务扫描结果…'}</p>}</div></section>
        {run.progress && <TechnicalFunnel progress={run.progress} />}
        {data && <>{data.coverage && <p className={styles.warning}>本地范围 {data.coverage.universe} 只；{data.coverage.unverified} 只缺少所需指标，未纳入已核实候选{data.coverage.missingFields.length ? `（${data.coverage.missingFields.join('、')}）` : ''}。排序字段缺失 {data.coverage.sortMissing} 只，缺失项置后、同值按代码排序。财务数据为当前核实序列，非历史无偏回测。</p>}<div className={styles.resultHead}><div><h2>候选清单 · {stocks.length} 只</h2><p>{run.plan?.technical ? '公式已核实命中' : '已核实条件命中'} {data.total} 只 · 本次已取 {data.stocks.length} 只 · 展示前 {stocks.length} 只；按解析计划排序，不代表收益排名</p></div>{groups.length > 0 && <select aria-label="加入自选目标分组" value={activeGroup?.id ?? ''} onChange={e => setGroupId(e.target.value)}>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select>}</div>
        <p className={styles.note}>{run.plan?.technical ? `技术日线基准日 ${run.progress?.asOf ?? '未提供'} · 财务字段目录快照 ${run.progress?.catalogueDate ?? '未提供'}` : `来源快照日 ${data.snapshotDate ?? '未提供'}`}，不是逐公司财报期或实时报价。非空字段覆盖（展示样本）：{(['pe', 'roe', 'grossMargin', 'dividendYield'] as const).map(key => `${SCAN_FIELDS[key].label} ${stocks.filter(stock => stock[key] !== null).length}/${stocks.length}`).join(' · ')}。— 为未提供，0 保留源值，仍需核实是否完整。</p>
        <div className={styles.cards}>{stocks.map(stock => <article className={styles.card} key={stock.secId}><header><div><h3>{stock.name}</h3><small>{stock.code} · {stock.industry ?? '行业未提供'}</small></div><div>{run.plan?.technical && <small>本地快照价 · {stock.facts?.price?.date ?? run.progress?.catalogueDate ?? '日期未核实'}</small>}<b>¥{number(stock.price)}</b><span className={ui[classForChange(stock.changePct)]}>{percent(stock.changePct)}</span></div></header><h4>条件依据 · 源数据</h4>{run.progress?.evidence[stock.code] && <ul>{run.progress.evidence[stock.code]!.map((row, index) => <li key={index}>{row.formula}：{row.matched === true ? '满足' : row.matched === false ? '不满足' : '未核实'}；{row.detail}</li>)}</ul>}<ul>{Object.keys(run.plan?.query.ranges ?? {}).map(key => <li key={key}>{SCAN_FIELDS[key as ScanMetric].label}：{number(stock[key as ScanMetric])}{SCAN_FIELDS[key as ScanMetric].unit}</li>)}{run.plan?.query.industries?.length ? <li>源行业分类：{stock.industry ?? '未提供'}</li> : null}</ul><div className={styles.metrics}>{(['pe', 'roe', 'grossMargin', 'marketCap'] as const).map(key => <span key={key}>{SCAN_FIELDS[key].label}<b>{number(stock[key])}{SCAN_FIELDS[key].unit}</b></span>)}</div>{stock.facts && <details><summary>指标来源与统计期</summary><ul>{Object.entries(stock.facts).filter(([key]) => !['price', 'changePct'].includes(key)).map(([key, fact]) => <li key={key}>{key in SCAN_FIELDS ? SCAN_FIELDS[key as ScanMetric].label : '行业'}：{fact.source.split('+').map(source => source === 'tencent' ? '腾讯' : source === 'eastmoney-financials' ? '东方财富财报' : source).join('＋')} · {key === 'industry' ? '分类观察日' : '数据日期'} {fact.date} · 报告期 {fact.reportDate ?? '不适用'} · 获取 {dateTime(fact.fetchedAt)}</li>)}</ul></details>}<footer><button className={ui.button} disabled={busy || !activeGroup} onClick={() => void addWatch(stock)}>加入当前自选</button><button className={ui.button} onClick={() => onStock(stock)}>查看当前K线与详情</button></footer></article>)}</div>{stocks.length === 0 && <p className={styles.note}>已核实数据中没有候选；若上方存在未核实范围，不能据此判断全市场没有符合条件的股票。</p>}</>}
      </>}
      {selected?.dshSessionId && <section className={styles.panel}><PanelHead title="解析对话与工具审批" extra={<button className={ui.button} disabled={run?.status === 'parsing'} onClick={() => setShowChat(value => !value)}>{run?.status === 'parsing' ? '解析中，审批在下方' : showChat ? '收起对话' : '展开对话'}</button>} />{(showChat || run?.status === 'parsing') && <div className={styles.chat}><p className={styles.note}>对话追问不修改已冻结的候选结果；调整筛选条件请在上方重新提问。</p><ChatPanel key={selected.dshSessionId} clientContext={client.ctx} sessionId={selected.dshSessionId} variant="screener" compact hideHeader /></div>}</section>}
    </div></div>
  </section>
}
