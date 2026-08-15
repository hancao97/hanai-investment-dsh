import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-client-connection/client'
import type {
  BootstrapData,
  DashboardData,
  Judgement,
  JudgementDetail,
  MasterPersona,
  ModelSelectionInput,
  ProviderMeta,
  SearchResult,
  SecurityMaster,
  StockDetail,
  StockQuote,
  ThemeId,
  WatchGroup,
  WatchQuote,
} from '../../contracts/src/index.ts'
import { ChatPanel } from '../../client-chat/src/index.tsx'
import { HanaiClient } from './api.ts'
import { KlineChart, TrendChart, ValuationHistoryChart } from './charts.tsx'
import { MarkdownView } from './markdown.tsx'
import { classForChange, dateTime, money, number, percent, quantity, ratio } from './format.ts'
import { describeDataStatus } from './data-status.ts'
import styles from './styles.module.css'

type PageId = 'dashboard' | 'watch' | 'stock' | 'judgements' | 'masters' | 'settings'
type Notice = { id: number; kind: 'success' | 'error'; text: string }

const NAV: ReadonlyArray<{ id: PageId; icon: string; label: string; hint: string }> = [
  { id: 'dashboard', icon: '⌁', label: '市场全景', hint: 'Market' },
  { id: 'watch', icon: '☆', label: '自选观察', hint: 'Watch' },
  { id: 'stock', icon: '⌇', label: '个股研究', hint: 'Research' },
  { id: 'judgements', icon: '◇', label: '大师研判', hint: 'Agent' },
  { id: 'masters', icon: '◈', label: '大师图鉴', hint: 'Personas' },
  { id: 'settings', icon: '⚙', label: '系统设置', hint: 'Settings' },
]

export interface HanaiWorkbenchProps {
  client: HanaiClient
}

export function HanaiWorkbench({ client }: HanaiWorkbenchProps) {
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null)
  const [page, setPage] = useState<PageId>('dashboard')
  const [selectedSecId, setSelectedSecId] = useState<string | null>(null)
  const [selectedJudgementId, setSelectedJudgementId] = useState<string | null>(null)
  const [suggestedMasterId, setSuggestedMasterId] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [fatal, setFatal] = useState<string | null>(null)
  const [notices, setNotices] = useState<Notice[]>([])

  const notify = useCallback((text: string, kind: Notice['kind'] = 'success') => {
    const id = Date.now() + Math.random()
    setNotices(current => [...current.slice(-2), { id, kind, text }])
    window.setTimeout(() => setNotices(current => current.filter(item => item.id !== id)), 3600)
  }, [])

  const reload = useCallback(async () => {
    try {
      const data = await client.call('bootstrap', {})
      setBootstrap(data)
      setFatal(null)
    } catch (error) {
      setFatal(messageOf(error))
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => { void reload() }, [reload])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen(true)
      }
      if (event.key === 'Escape') setSearchOpen(false)
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [])

  const openStock = (security: Pick<SecurityMaster, 'secId'>) => {
    setSelectedSecId(security.secId)
    setPage('stock')
    setSearchOpen(false)
  }
  const openJudgement = (id: string) => {
    setSelectedJudgementId(id)
    setPage('judgements')
  }

  if (loading) return <Splash title="正在唤醒 Hanai" detail="连接 DSH Agent 与本地投资工作台…" />
  if (fatal !== null || bootstrap === null) {
    return <Splash title="Hanai 暂时无法启动" detail={fatal ?? '未知错误'} action={<button onClick={() => void reload()}>重新连接</button>} />
  }

  return (
    <div className={styles['app']} data-theme={bootstrap.theme} data-hanai-root>
      <aside className={styles['sidebar']}>
        <button className={styles['brand']} onClick={() => setPage('dashboard')} aria-label="返回市场全景">
          <span className={styles['brandMark']}>花</span>
          <span><strong>HANAI</strong><small>INVESTMENT</small></span>
        </button>
        <nav className={styles['nav']} aria-label="主导航">
          {NAV.map(item => (
            <button key={item.id} className={page === item.id ? styles['navActive'] : ''} onClick={() => setPage(item.id)}>
              <span className={styles['navIcon']}>{item.icon}</span>
              <span><strong>{item.label}</strong><small>{item.hint}</small></span>
            </button>
          ))}
        </nav>
        <div className={styles['sidebarFoot']}>
          <span className={styles['statusDot']} />
          <div><strong>DSH Agent 在线</strong><small>本地会话 · 安全凭据</small></div>
        </div>
      </aside>

      <main className={styles['main']}>
        <header className={styles['topbar']}>
          <div>
            <p className={styles['eyebrow']}>HANAI / {NAV.find(item => item.id === page)?.hint.toUpperCase()}</p>
            <h1>{NAV.find(item => item.id === page)?.label}</h1>
          </div>
          <div className={styles['topActions']}>
            <button className={styles['searchTrigger']} onClick={() => setSearchOpen(true)}>
              <span>搜索股票、代码或拼音</span><kbd>⌘ K</kbd>
            </button>
            <button className={styles['themeQuick']} title="切换主题" onClick={() => {
              const theme: ThemeId = bootstrap.theme === 'ocean' ? 'jade' : 'ocean'
              void client.call('theme.set', { theme }).then(() => setBootstrap({ ...bootstrap, theme }))
            }}>{bootstrap.theme === 'ocean' ? '澄' : '青'}</button>
          </div>
        </header>

        <div className={styles['content']}>
          {page === 'dashboard' && <DashboardPage client={client} onStock={openStock} notify={notify} />}
          {page === 'watch' && <WatchPage client={client} groups={bootstrap.groups} onGroups={(groups) => setBootstrap({ ...bootstrap, groups })} onStock={openStock} notify={notify} />}
          {page === 'stock' && <StockPage client={client} secId={selectedSecId} onChoose={() => setSearchOpen(true)} onCreateJudgement={(secId) => { setSelectedSecId(secId); setSelectedJudgementId(null); setSuggestedMasterId(null); setPage('judgements') }} notify={notify} />}
          {page === 'judgements' && <JudgementsPage client={client} masters={bootstrap.masters} judgements={bootstrap.judgements} selectedId={selectedJudgementId} suggestedSecId={selectedSecId} suggestedMasterId={suggestedMasterId} onSelect={openJudgement} onChanged={reload} notify={notify} />}
          {page === 'masters' && <MastersPage masters={bootstrap.masters} onStart={(master) => { setSelectedJudgementId(null); setSuggestedMasterId(master.id); setPage('judgements'); notify(`已选择${master.name}，请继续选择股票`) }} />}
          {page === 'settings' && <SettingsPage client={client} bootstrap={bootstrap} onTheme={(theme) => setBootstrap({ ...bootstrap, theme })} onReload={reload} notify={notify} />}
        </div>
      </main>

      {searchOpen && <GlobalSearch client={client} onClose={() => setSearchOpen(false)} onSelect={openStock} />}
      <div className={styles['toastStack']} aria-live="polite">
        {notices.map(notice => <div key={notice.id} className={notice.kind === 'error' ? styles['toastError'] : styles['toast']}><span>{notice.kind === 'error' ? '!' : '✓'}</span>{notice.text}</div>)}
      </div>
    </div>
  )
}

function DashboardPage({ client, onStock, notify }: { client: HanaiClient; onStock: (stock: SearchResult) => void; notify: Notify }) {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [rank, setRank] = useState<keyof DashboardData['ranks']>('gainers')
  const [sectorType, setSectorType] = useState<'industry' | 'concept'>('industry')
  const [sectorDetail, setSectorDetail] = useState<{ name: string; stocks: StockQuote[] | null; meta: ProviderMeta | null } | null>(null)
  const load = useCallback(async (refresh = false) => {
    try {
      setData(await client.call('dashboard.get', { refresh }))
      setRefreshError(null)
    } catch (error) {
      const message = messageOf(error)
      setRefreshError(message)
      notify(message, 'error')
    } finally { setLoading(false) }
  }, [client, notify])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 30_000)
    return () => window.clearInterval(timer)
  }, [load])
  if (loading) return <PageSkeleton cards={6} />
  if (data === null) return <Empty title="市场数据暂不可用" detail={refreshError ?? '行情源尚未返回可用数据。'} action={<button onClick={() => void load(true)}>重新加载</button>} />
  const sector = sectorType === 'industry' ? data.industry : data.concept
  const breadth = data.overview.breadth
  const breadthTotal = (breadth.up ?? 0) + (breadth.down ?? 0) + (breadth.flat ?? 0)
  const breadthParts = [
    { id: 'limitUp', value: breadth.limitUp ?? 0, className: styles['breadthLimitUp'] },
    { id: 'up', value: Math.max(0, (breadth.up ?? 0) - (breadth.limitUp ?? 0)), className: styles['breadthUp'] },
    { id: 'flat', value: breadth.flat ?? 0, className: styles['breadthFlat'] },
    { id: 'down', value: Math.max(0, (breadth.down ?? 0) - (breadth.limitDown ?? 0)), className: styles['breadthDown'] },
    { id: 'limitDown', value: breadth.limitDown ?? 0, className: styles['breadthLimitDown'] },
  ]
  const sectorAmounts = sector.sectors.map(item => item.amount ?? 0).filter(value => value > 0).sort((a, b) => a - b)
  const heavySectorAmount = sectorAmounts[Math.floor(sectorAmounts.length * .75)] ?? Number.POSITIVE_INFINITY
  return <div className={styles['pageStack']}>
    <section className={styles['heroStrip']}>
      <div className={styles['marketState']}>
        <DataStateBadge meta={data.overview.meta} marketStatus={data.overview.marketStatus} refreshFailed={refreshError !== null} />
        <p>市场状态</p><h2>{marketStatus(data.overview.marketStatus)}</h2>
        <DataSourceText meta={data.overview.meta} />
        {refreshError !== null && <small className={styles['dataWarning']}>刷新失败，保留上次数据 · {refreshError}</small>}
      </div>
      <div className={styles['heroMessage']}><p>今日 A 股观察</p><h3>{breadthTotal > 0 && (breadth.up ?? 0) > (breadth.down ?? 0) ? '多头广度占优，仍需关注成交确认' : '市场分化加剧，保持证据与价格纪律'}</h3><small>数据不等于结论，研判不构成投资建议</small></div>
      <button className={styles['ghostButton']} onClick={() => void load(true)}>刷新数据 ↻</button>
    </section>
    <section className={styles['indexGrid']}>
      {data.overview.indices.map(index => <article className={styles['indexCard']} key={index.code}>
        <header><span>{index.name}</span><small>{index.code}</small></header>
        <strong>{number(index.price)}</strong>
        <span className={styles[classForChange(index.changePct)]}>{percent(index.changePct)} · {number(index.change)}</span>
        <div className={styles['indexMeta']}><span>成交额</span><strong>{money(index.amount)}</strong></div>
      </article>)}
    </section>
    <section className={styles['twoColumns']}>
      <article className={styles['panel']}>
        <PanelHead title="市场温度" hint="Market breadth" />
        <div className={styles['breadthMain']}>
          <div><strong className={styles['up']}>{breadth.up ?? '—'}</strong><span>上涨</span></div>
          <div className={styles['breadthDial']}><span>{breadthTotal === 0 ? '—' : Math.round((breadth.up ?? 0) / breadthTotal * 100)}%</span><small>红盘占比</small></div>
          <div><strong className={styles['down']}>{breadth.down ?? '—'}</strong><span>下跌</span></div>
        </div>
        <div className={styles['breadthBar']} aria-label="涨停、上涨、平盘、下跌、跌停分布">{breadthParts.map(part => <i key={part.id} className={part.className} style={{ width: `${breadthTotal === 0 ? 0 : part.value / breadthTotal * 100}%` }} title={`${part.id}: ${part.value}`} />)}</div>
        <div className={styles['metricGrid']}>
          <Metric label="涨停" value={String(breadth.limitUp ?? '—')} tone="up" />
          <Metric label="跌停" value={String(breadth.limitDown ?? '—')} tone="down" />
          <Metric label="平盘" value={String(breadth.flat ?? '—')} />
          <Metric label="成交额" value={money(breadth.totalAmount)} />
        </div>
      </article>
      <article className={styles['panel']}>
        <PanelHead title="资金与涨跌榜" hint="Top movers" />
        <div className={styles['segmented']}>
          {([['gainers', '涨幅'], ['losers', '跌幅'], ['amount', '成交额'], ['turnover', '换手率']] as const).map(([id, label]) => <button key={id} className={rank === id ? styles['segmentActive'] : ''} onClick={() => setRank(id)}>{label}</button>)}
        </div>
        <div className={styles['rankList']}>
          {data.ranks[rank].slice(0, 20).map((item, index) => <button key={item.secId} onClick={() => onStock({ ...item, exchange: exchangeFor(item.secId, item.code), pinyinFull: '', pinyinInitial: '' })}>
            <span className={styles['rankNo']}>{String(index + 1).padStart(2, '0')}</span><span><strong>{item.name}</strong><small>{item.code}</small></span><span>{number(item.price)}</span><em className={rank === 'amount' ? undefined : styles[classForChange(item.changePct)]}>{rank === 'amount' ? money(item.amount) : rank === 'turnover' ? ratio(item.turnoverRate) : percent(item.changePct)}</em>
          </button>)}
        </div>
      </article>
    </section>
    <article className={styles['panel']}>
      <PanelHead title="板块热力" hint="Sector map" extra={<div className={styles['panelHeadExtras']}><DataStateBadge meta={sector.meta} marketStatus={data.overview.marketStatus} /><div className={styles['segmented']}><button className={sectorType === 'industry' ? styles['segmentActive'] : ''} onClick={() => setSectorType('industry')}>行业</button><button className={sectorType === 'concept' ? styles['segmentActive'] : ''} onClick={() => setSectorType('concept')}>概念</button></div></div>} />
      <div className={styles['sectorGrid']}>
        {sector.sectors.slice(0, 50).map(item => <button key={item.code} className={styles[classForChange(item.changePct)]} style={{ '--weight': String((item.amount ?? 0) >= heavySectorAmount ? 2 : 1) } as React.CSSProperties} onClick={() => { setSectorDetail({ name: item.name, stocks: null, meta: null }); void client.call('sector.stocks', { sectorCode: item.code }).then(result => setSectorDetail({ name: item.name, stocks: result.stocks.slice(0, 300), meta: result.meta })).catch(error => { setSectorDetail(null); notify(messageOf(error), 'error') }) }}><strong>{item.name}</strong><span>{percent(item.changePct)}</span><small>{item.leaderName ?? '—'} {percent(item.leaderChangePct)}</small><small>成交 {money(item.amount)}</small></button>)}
      </div>
    </article>
    {sectorDetail !== null && <Modal title={`${sectorDetail.name} · 板块成分`} onClose={() => setSectorDetail(null)}>{sectorDetail.stocks === null ? <PageSkeleton cards={3} /> : <><div className={styles['dataStrip']}><DataStateBadge meta={sectorDetail.meta} marketStatus={data.overview.marketStatus} /><DataSourceText meta={sectorDetail.meta} /></div><div className={styles['sectorStocks']}><div className={styles['sectorStockHead']}><span>证券</span><span>现价</span><span>涨跌</span><span>成交额</span><span>换手率</span><span>总市值</span></div>{sectorDetail.stocks.map(stock => <button key={stock.secId} onClick={() => { setSectorDetail(null); onStock({ secId: stock.secId, code: stock.code, name: stock.name, exchange: exchangeFor(stock.secId, stock.code), pinyinFull: '', pinyinInitial: '', price: stock.price, changePct: stock.changePct }) }}><span><strong>{stock.name}</strong><small>{stock.code}</small></span><span>{number(stock.price)}</span><em className={styles[classForChange(stock.changePct)]}>{percent(stock.changePct)}</em><span>{money(stock.amount)}</span><span>{ratio(stock.turnoverRate)}</span><span>{money(stock.marketCap)}</span></button>)}</div></>}</Modal>}
  </div>
}

function WatchPage({ client, groups, onGroups, onStock, notify }: { client: HanaiClient; groups: WatchGroup[]; onGroups: (groups: WatchGroup[]) => void; onStock: (stock: SearchResult) => void; notify: Notify }) {
  const [groupId, setGroupId] = useState(groups[0]?.id ?? '')
  const [quotes, setQuotes] = useState<WatchQuote[]>([])
  const [quoteMeta, setQuoteMeta] = useState<ProviderMeta | null>(null)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [addingStock, setAddingStock] = useState(false)
  const [sort, setSort] = useState<{ key: 'name' | 'price' | 'changePct' | 'sinceAddedPct' | 'amount' | 'turnoverRate' | 'marketCap' | 'pe' | 'pb' | 'addedAt'; direction: 1 | -1 }>({ key: 'changePct', direction: -1 })
  const load = useCallback(async () => {
    if (groupId === '') return
    try {
      const result = await client.call('watch.quotes', { groupId })
      setQuotes(result.quotes)
      setQuoteMeta(result.meta)
      setRefreshFailed(false)
    } catch (error) {
      setRefreshFailed(true)
      notify(messageOf(error), 'error')
    }
  }, [client, groupId, notify])
  useEffect(() => {
    void load(); const timer = window.setInterval(() => void load(), 15_000); return () => window.clearInterval(timer)
  }, [load])
  useEffect(() => { setQuotes([]); setQuoteMeta(null); setRefreshFailed(false) }, [groupId])
  useEffect(() => { if (!groups.some(group => group.id === groupId)) setGroupId(groups[0]?.id ?? '') }, [groups, groupId])
  const mutate = async (run: () => Promise<WatchGroup[]>, success: string) => {
    try { onGroups(await run()); notify(success) } catch (error) { notify(messageOf(error), 'error') }
  }
  const sorted = useMemo(() => [...quotes].sort((a, b) => compareNullable(a[sort.key], b[sort.key]) * sort.direction), [quotes, sort])
  return <div className={styles['pageStack']}>
    <section className={styles['watchHeader']}>
      <div className={styles['groupTabs']}>{groups.map(group => <button key={group.id} className={group.id === groupId ? styles['groupActive'] : ''} onClick={() => setGroupId(group.id)}>{group.name}<span>{group.items.length}</span></button>)}</div>
      <form onSubmit={(event) => { event.preventDefault(); if (groupName.trim() === '') return; void mutate(async () => { await client.call('watch.group.create', { name: groupName }); return client.call('watch.list', {}) }, '分组已创建').then(() => setGroupName('')) }}><input value={groupName} onChange={event => setGroupName(event.target.value)} maxLength={20} placeholder="新建分组" /><button className={styles['primaryButton']}>＋ 添加</button></form>
    </section>
    <article className={styles['panel']}>
      <PanelHead title={groups.find(group => group.id === groupId)?.name ?? '自选'} hint="15 秒轮询 · 新鲜度以来源元数据为准" extra={<div className={styles['panelHeadExtras']}><DataStateBadge meta={quoteMeta} refreshFailed={refreshFailed} /><div className={styles['inlineActions']}><button className={styles['secondaryButton']} onClick={() => setAddingStock(true)}>＋ 添加股票</button><button onClick={() => void load()}>刷新 ↻</button><button onClick={() => { const current = groups.find(group => group.id === groupId); if (current === undefined) return; const name = window.prompt('输入新的分组名称', current.name)?.trim(); if (name !== undefined && name !== '' && name !== current.name) void mutate(() => client.call('watch.group.rename', { id: groupId, name }), '分组已重命名') }}>重命名</button>{groups.find(group => group.id === groupId)?.isDefault === false && <button className={styles['dangerLink']} onClick={() => { if (window.confirm('删除分组后，其中股票会移入默认分组。继续吗？')) void mutate(() => client.call('watch.group.remove', { id: groupId }), '分组已删除') }}>删除分组</button>}</div></div>} />
      {sorted.length === 0 ? <Empty title="自选列表还是空的" detail="搜索代码、名称或拼音，把第一只股票加入当前分组。" action={<button className={styles['primaryButton']} onClick={() => setAddingStock(true)}>添加股票</button>} /> : <div className={styles['tableWrap']}><table className={styles['dataTable']}><thead><tr>{([['name', '股票'], ['price', '现价'], ['changePct', '涨跌幅'], ['sinceAddedPct', '加入以来'], ['amount', '成交额'], ['turnoverRate', '换手率'], ['marketCap', '总市值'], ['pe', '动态 PE'], ['pb', 'PB'], ['addedAt', '加入日期']] as const).map(([key, label]) => <th key={key}><button onClick={() => setSort(current => ({ key, direction: current.key === key ? current.direction === 1 ? -1 : 1 : -1 }))}>{label} {sort.key === key ? sort.direction === 1 ? '↑' : '↓' : ''}</button></th>)}<th>行情状态</th><th>移动 / 操作</th></tr></thead><tbody>{sorted.map(quote => <tr key={quote.secId}><td><button className={styles['stockCell']} onClick={() => onStock({ secId: quote.secId, code: quote.code, name: quote.name, exchange: exchangeFor(quote.secId, quote.code), pinyinFull: '', pinyinInitial: '', price: quote.price, changePct: quote.changePct })}><strong>{quote.name}</strong><small>{quote.code}</small></button></td><td>{number(quote.price)}</td><td className={styles[classForChange(quote.changePct)]}>{percent(quote.changePct)}</td><td className={styles[classForChange(quote.sinceAddedPct)]}>{percent(quote.sinceAddedPct)}</td><td>{money(quote.amount)}</td><td>{ratio(quote.turnoverRate)}</td><td>{money(quote.marketCap)}</td><td>{quote.pe !== null && quote.pe > 0 ? number(quote.pe) : '—'}</td><td>{quote.pb !== null && quote.pb > 0 ? number(quote.pb) : '—'}</td><td>{dateTime(quote.addedAt)}</td><td><div className={styles['tableDataState']}><DataStateBadge meta={quote.meta ?? quoteMeta} refreshFailed={refreshFailed} /><DataSourceText meta={quote.meta ?? quoteMeta} /></div></td><td><div className={styles['rowActions']}><select aria-label="移动到分组" value="" onChange={event => { const toGroupId = event.target.value; if (toGroupId !== '') void mutate(() => client.call('watch.item.move', { fromGroupId: groupId, toGroupId, secId: quote.secId }), '已移动自选') }}><option value="">移动到…</option>{groups.filter(group => group.id !== groupId).map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select><button className={styles['iconButton']} title="移出分组" onClick={() => void mutate(() => client.call('watch.item.remove', { groupId, secId: quote.secId }), '已移出自选')}>×</button></div></td></tr>)}</tbody></table></div>}
    </article>
    {addingStock && <GlobalSearch client={client} onClose={() => setAddingStock(false)} onSelect={(stock) => { void client.call('watch.item.add', { groupId, secId: stock.secId }).then((next) => { onGroups(next); setAddingStock(false); notify(`${stock.name} 已加入当前分组`); return load() }).catch(error => notify(messageOf(error), 'error')) }} />}
  </div>
}

function StockPage({ client, secId, onChoose, onCreateJudgement, notify }: { client: HanaiClient; secId: string | null; onChoose: () => void; onCreateJudgement: (secId: string) => void; notify: Notify }) {
  const [detail, setDetail] = useState<StockDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [chart, setChart] = useState<'trend' | 'daily' | 'weekly' | 'monthly'>('trend')
  const [groups, setGroups] = useState<WatchGroup[]>([])
  const [groupId, setGroupId] = useState('')
  const load = useCallback(async () => {
    if (secId === null) return
    setLoading(true)
    try {
      const [next, nextGroups] = await Promise.all([
        client.call('security.detail', { secId }),
        client.call('watch.list', {}),
      ])
      setDetail(next)
      setGroups(nextGroups)
      setGroupId(current => current || nextGroups[0]?.id || '')
    } catch (error) { notify(messageOf(error), 'error') } finally { setLoading(false) }
  }, [client, notify, secId])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 15_000)
    return () => window.clearInterval(timer)
  }, [load])
  if (secId === null) return <Empty title="选择一只股票开始研究" detail="按 ⌘ K 搜索代码、名称或拼音，查看行情、财务指标与估值数据。" action={<button className={styles['primaryButton']} onClick={onChoose}>搜索股票</button>} />
  if (loading && detail === null) return <PageSkeleton cards={5} />
  if (detail === null) return <Empty title="个股数据暂不可用" detail="行情源可能正在降级，请稍后刷新。" action={<button onClick={() => void load()}>重试</button>} />
  const quote = detail.quote
  const metrics = detail.metrics
  const title = detail.security?.name ?? quote?.name ?? secId
  const code = detail.security?.code ?? quote?.code ?? secId.slice(2)
  const inGroup = groups.some(group => group.id === groupId && group.secIds.includes(secId))
  const chartNode = chart === 'trend'
    ? <TrendChart points={detail.trend} prevClose={detail.quote?.prevClose ?? metrics?.prevClose ?? null} />
    : <KlineChart bars={detail[chart]} />
  const chartMeta = detail.sources[chart]
  return <div className={styles['pageStack']}>
    <section className={styles['stockHero']}>
      <div className={styles['stockIdentity']}><span>{detail.security?.exchange ?? exchangeFor(secId, code)}</span><div><h2>{title}</h2><p>{code} · {metrics?.industry ?? '行业待补充'}</p></div></div>
      <div className={styles['stockPrice']}><strong>{number(quote?.price ?? null)}</strong><span className={styles[classForChange(quote?.changePct ?? null)]}>{percent(quote?.changePct ?? null)} <small>{number(quote?.change ?? null)}</small></span></div>
      <div className={styles['stockDataState']}><DataStateBadge meta={detail.sources.quote} /><DataSourceText meta={detail.sources.quote} /></div>
      <div className={styles['stockActions']}>
        <select value={groupId} onChange={event => setGroupId(event.target.value)}>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select>
        <button className={inGroup ? styles['ghostButton'] : styles['secondaryButton']} disabled={groupId === '' || inGroup} onClick={() => void client.call('watch.item.add', { groupId, secId }).then((next) => { setGroups(next); notify('已加入自选') }).catch(error => notify(messageOf(error), 'error'))}>{inGroup ? '✓ 已在自选' : '☆ 加入自选'}</button>
        <button className={styles['primaryButton']} onClick={() => onCreateJudgement(secId)}>发起大师研判</button>
      </div>
    </section>
    <section className={styles['metricRibbon']}>
      <Metric label="昨收" value={number(quote?.prevClose ?? metrics?.prevClose ?? null)} />
      <Metric label="今开" value={number(quote?.open ?? null)} />
      <Metric label="最高" value={number(quote?.high ?? null)} tone="up" />
      <Metric label="最低" value={number(quote?.low ?? null)} tone="down" />
      <Metric label="均价" value={number(metrics?.averagePrice ?? null)} />
      <Metric label="振幅" value={ratio(metrics?.amplitude ?? null)} />
      <Metric label="成交量" value={quantity(quote?.volume ?? metrics?.volume ?? null)} />
      <Metric label="成交额" value={money(quote?.amount ?? null)} />
      <Metric label="换手率" value={ratio(quote?.turnoverRate ?? null)} />
      <Metric label="总市值" value={money(quote?.marketCap ?? null)} />
      <Metric label="流通市值" value={money(quote?.floatCap ?? metrics?.floatCap ?? null)} />
    </section>
    <section className={styles['twoColumnsWide']}>
      <article className={styles['panel']}>
        <PanelHead title="价格走势" hint={`${chart === 'trend' ? '分时均价' : '前复权 K 线'} · ${chartMeta?.sourceName ?? '来源未知'}`} extra={<div className={styles['panelHeadExtras']}><DataStateBadge meta={chartMeta} liveCapable={chart === 'trend'} /><div className={styles['segmented']}>{([['trend', '分时'], ['daily', '日K'], ['weekly', '周K'], ['monthly', '月K']] as const).map(([id, label]) => <button key={id} className={chart === id ? styles['segmentActive'] : ''} onClick={() => setChart(id)}>{label}</button>)}</div></div>} />
        {chartNode}
      </article>
      <article className={styles['panel']}>
        <PanelHead title="估值罗盘" hint={detail.sources.valuation?.sourceName ?? '来源未知'} extra={<DataStateBadge meta={detail.sources.valuation} liveCapable={false} />} />
        {detail.valuation === null ? <Empty title="估值数据暂不可用" detail="不使用缺失值推断结论。" /> : <>
          <div className={styles['valuationScore']}><div><strong>{number(detail.valuation.gfScore, 0)}</strong><small>GF SCORE</small></div><div><span>估值判断</span><strong>{valuationRank(detail.valuation.valuationRank)}</strong></div></div>
          <div className={styles['dimensionList']}>{Object.entries({ '财务实力': detail.valuation.dimensions.financialStrength, '盈利能力': detail.valuation.dimensions.profitability, '成长性': detail.valuation.dimensions.growth, '价值': detail.valuation.dimensions.gfValue, '动量': detail.valuation.dimensions.momentum }).map(([label, value]) => <div key={label}><span>{label}</span><i><b style={{ width: `${Math.max(0, Math.min(100, (value ?? 0) * 10))}%` }} /></i><strong>{number(value, 0)}/10</strong></div>)}</div>
          <div className={styles['metricGrid']}><Metric label="DCF 价值" value={number(detail.valuation.ivDcf)} /><Metric label="中位 PS" value={number(detail.valuation.medps)} /></div>
          <ValuationHistoryChart price={detail.valuation.series.price} medps={detail.valuation.series.medps} />
        </>}
      </article>
    </section>
    <article className={styles['panel']}>
      <PanelHead title="基本面与交易指标" hint={`${detail.sources.metrics?.sourceName ?? '来源未知'} · 采集于 ${dateTime(detail.sources.metrics?.fetchedAt ?? null)}`} extra={<DataStateBadge meta={detail.sources.metrics} liveCapable={false} />} />
      <div className={styles['fundamentalGrid']}>
        {[
          ['动态 PE', metrics?.peDynamic], ['TTM PE', metrics?.peTtm], ['静态 PE', metrics?.peStatic], ['PB', metrics?.pb], ['PS TTM', metrics?.psTtm],
          ['ROE', metrics?.roe, 'ratio'], ['营收', metrics?.totalRevenue, 'money'], ['营收同比', metrics?.revenueYoy, '%'], ['净利润', metrics?.netProfit, 'money'],
          ['利润同比', metrics?.netProfitYoy, '%'], ['毛利率', metrics?.grossMargin, 'ratio'], ['净利率', metrics?.netMargin, 'ratio'], ['资产负债率', metrics?.debtRatio, 'ratio'],
          ['主力净流入', metrics?.mainNetInflow, 'money'], ['量比', metrics?.volumeRatio], ['股息率', metrics?.dividendYield, 'ratio'], ['每股收益', metrics?.eps],
          ['每股净资产', metrics?.bvps], ['总股本', metrics?.totalShares, 'quantity'], ['流通股本', metrics?.floatShares, 'quantity'], ['上市日期', metrics?.listingDate, 'text'],
        ].map(([label, value, mode]) => <div key={String(label)}><span>{label}</span><strong>{mode === 'money' ? money(value as number | null ?? null) : mode === 'quantity' ? quantity(value as number | null ?? null) : mode === '%' ? percent(value as number | null ?? null) : mode === 'ratio' ? ratio(value as number | null ?? null) : mode === 'text' ? value ?? '—' : number(value as number | null ?? null)}</strong></div>)}
      </div>
    </article>
  </div>
}

function JudgementsPage({ client, masters, judgements, selectedId, suggestedSecId, suggestedMasterId, onSelect, onChanged, notify }: { client: HanaiClient; masters: MasterPersona[]; judgements: Judgement[]; selectedId: string | null; suggestedSecId: string | null; suggestedMasterId: string | null; onSelect: (id: string) => void; onChanged: () => Promise<void>; notify: Notify }) {
  const [creating, setCreating] = useState(selectedId === null)
  const [detail, setDetail] = useState<JudgementDetail | null>(null)
  const [tab, setTab] = useState<'report' | 'chat'>('report')
  const [version, setVersion] = useState<number | null>(null)
  const load = useCallback(async () => {
    if (selectedId === null) { setDetail(null); return }
    try {
      const next = await client.call('judgement.get', { id: selectedId })
      setDetail(next)
      setVersion(current => current ?? next.reports[0]?.version ?? null)
    } catch (error) { notify(messageOf(error), 'error') }
  }, [client, notify, selectedId])
  useEffect(() => { setCreating(selectedId === null); setVersion(null); void load() }, [load, selectedId])
  useEffect(() => {
    if (detail === null || !['preparing', 'generating', 'verifying', 'repairing', 'revising'].includes(detail.judgement.reportStatus)) return
    const timer = window.setInterval(() => { void load(); void onChanged() }, 1800)
    return () => window.clearInterval(timer)
  }, [detail, load, onChanged])
  return <div className={styles['judgementLayout']}>
    <aside className={styles['judgementList']}>
      <button className={styles['newJudgement']} onClick={() => { setCreating(true); setDetail(null) }}>＋ 新建研判</button>
      <p className={styles['listLabel']}>研判档案 · {judgements.length}</p>
      {judgements.map(item => <button key={item.id} className={selectedId === item.id && !creating ? styles['judgementActive'] : ''} onClick={() => { setCreating(false); onSelect(item.id) }}><span className={styles['masterMini']}>{item.masterName.slice(0, 1)}</span><span><strong>{item.stockName}</strong><small>{item.masterName} · {dateTime(item.updatedAt)}</small></span><Status status={item.reportStatus} /></button>)}
    </aside>
    <section className={styles['judgementMain']}>
      {creating ? <CreateJudgement client={client} masters={masters} suggestedSecId={suggestedSecId} suggestedMasterId={suggestedMasterId} onCreated={async (judgement) => { await onChanged(); setCreating(false); onSelect(judgement.id); notify('大师已接收研判任务') }} notify={notify} /> : detail === null ? <PageSkeleton cards={4} /> : <>
        <header className={styles['judgementHero']}>
          <div className={styles['masterAvatar']}>{detail.judgement.masterName.slice(0, 1)}</div>
          <div><p>{detail.judgement.masterName} · {detail.judgement.masterVersion}</p><h2>{detail.judgement.stockName} <span>{detail.judgement.code}</span></h2><small>同一 DSH Session 持续研判 · 报告版本 {detail.judgement.latestReportVersion ?? 0}</small></div>
          <Status status={detail.judgement.reportStatus} large />
        </header>
        <div className={styles['viewTabs']}><button className={tab === 'report' ? styles['viewActive'] : ''} onClick={() => setTab('report')}>研判报告</button><button className={tab === 'chat' ? styles['viewActive'] : ''} onClick={() => setTab('chat')}>继续对话 <span>DSH</span></button></div>
        {tab === 'report' ? <ReportPane client={client} detail={detail} version={version} onVersion={setVersion} onReload={load} notify={notify} /> : detail.judgement.dshSessionId === null ? <Empty title="大师会话正在准备" detail="DSH Session 建立后即可看到完整生成过程并继续对话。" /> : <ChatPanel clientContext={client.ctx} sessionId={detail.judgement.dshSessionId} {...detail.judgement.reportStatus === 'ready' ? {} : { readOnlyReason: '报告封存完成后即可继续对话；生成期间仍可查看实时过程并处理大师请求。' }} />}
      </>}
    </section>
  </div>
}

function CreateJudgement({ client, masters, suggestedSecId, suggestedMasterId, onCreated, notify }: { client: HanaiClient; masters: MasterPersona[]; suggestedSecId: string | null; suggestedMasterId: string | null; onCreated: (judgement: Judgement) => Promise<void>; notify: Notify }) {
  const [secId, setSecId] = useState(suggestedSecId ?? '')
  const [masterId, setMasterId] = useState(
    suggestedMasterId !== null && masters.some(master => master.id === suggestedMasterId)
      ? suggestedMasterId
      : masters[0]?.id ?? '',
  )
  const [prompt, setPrompt] = useState('')
  const [models, setModels] = useState<ModelProviderGroup[]>([])
  const [modelKey, setModelKey] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { void client.models().then(setModels).catch(() => undefined) }, [client])
  useEffect(() => {
    setMasterId(current => masters.some(master => master.id === current) ? current : masters[0]?.id ?? '')
  }, [masters])
  const selectedModel = modelFromKey(models, modelKey)
  const submit = async () => {
    if (!/^[01]\.\d{6}$/.test(secId.trim())) { notify('请输入形如 1.600519 或 0.000001 的 secId', 'error'); return }
    if (masterId === '') return
    setBusy(true)
    try {
      const input: { secId: string; masterId: string; prompt?: string; model?: ModelSelectionInput } = { secId: secId.trim(), masterId }
      if (prompt.trim() !== '') input.prompt = prompt.trim()
      if (selectedModel !== undefined) input.model = selectedModel
      await onCreated(await client.call('judgement.create', input))
    } catch (error) { notify(messageOf(error), 'error') } finally { setBusy(false) }
  }
  return <div className={styles['createFlow']}>
    <div className={styles['createIntro']}><span>HANAI MASTER SESSION</span><h2>邀请一位大师，开启持续研判</h2><p>首次生成完整报告，之后仍在同一 DSH Session 中继续追问。大师的方法论与上下文不会在报告完成时消失。</p></div>
    <section><Step number="01" title="选择研究标的" detail="A 股 secId；也可以先用顶部搜索打开股票。" /><input className={styles['largeInput']} value={secId} onChange={event => setSecId(event.target.value)} placeholder="例如 1.600519" /></section>
    <section><Step number="02" title="选择大师" detail="四套独立能力包，不是同一提示词换名字。" /><div className={styles['masterChoice']}>{masters.map(master => <button key={master.id} className={masterId === master.id ? styles['masterSelected'] : ''} aria-pressed={masterId === master.id} onClick={() => setMasterId(master.id)} style={{ '--master-color': master.color } as React.CSSProperties}><span>{master.shortName}</span><strong>{master.name}</strong><small>{master.roleTag}</small><p>{master.description}</p></button>)}</div></section>
    <section className={styles['createOptions']}><div><Step number="03" title="模型与补充要求" detail="不选择时沿用 DSH 默认模型。" /><select value={modelKey} onChange={event => setModelKey(event.target.value)}><option value="">DSH 默认模型</option>{models.map(group => <optgroup key={group.id} label={group.name}>{group.models.map(model => <option key={`${group.id}/${model.id}`} value={`${group.id}/${model.id}`}>{model.name}</option>)}</optgroup>)}</select><textarea value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={4000} placeholder="可选：你特别关心的业务、估值、事件或交易约束…" /></div><div className={styles['launchCard']}><span>准备就绪</span><strong>{masters.find(master => master.id === masterId)?.name ?? '请选择大师'}</strong><p>将创建独立研究工作区、快照大师能力包，并绑定一条可持续对话的 DSH Session。</p><button className={styles['primaryButton']} disabled={busy || secId.trim() === ''} onClick={() => void submit()}>{busy ? '正在建立会话…' : '开始大师研判 →'}</button></div></section>
  </div>
}

function ReportPane({ client, detail, version, onVersion, onReload, notify }: { client: HanaiClient; detail: JudgementDetail; version: number | null; onVersion: (version: number) => void; onReload: () => Promise<void>; notify: Notify }) {
  const [revising, setRevising] = useState(false)
  const [instruction, setInstruction] = useState('')
  const report = detail.reports.find(candidate => candidate.version === version) ?? detail.reports[0]
  const inFlight = ['preparing', 'generating', 'verifying', 'repairing', 'revising'].includes(detail.judgement.reportStatus)
  if (report === undefined) return <div className={styles['reportWaiting']}><div className={styles['orbit']}><i /><i /><i /></div><h3>{detail.judgement.reportStatus === 'failed' ? '报告生成失败' : '大师正在形成判断'}</h3><p>{detail.judgement.errorMessage ?? '正在核验资料、调用工具并写入 REPORT.md。你可以切换到“继续对话”查看实时过程。'}</p><Status status={detail.judgement.reportStatus} large /></div>
  return <div className={styles['reportPane']}>
    <div className={styles['reportToolbar']}><div><span>封存版本</span><select value={report.version} onChange={event => onVersion(Number(event.target.value))}>{detail.reports.map(item => <option key={item.version} value={item.version}>v{item.version} · {dateTime(item.sealedAt)}</option>)}</select><small>SHA {report.sha256.slice(0, 12)} · {money(report.sizeBytes, 0)}B</small></div><button className={styles['secondaryButton']} disabled={inFlight} onClick={() => setRevising(true)}>创建修订版</button></div>
    <MarkdownView content={report.content} />
    {revising && <Modal title="创建新的报告版本" onClose={() => setRevising(false)}><p>普通追问不会改写报告；只有这里的显式修订会覆盖工作区 REPORT.md，并在完成后封存为新版本。</p><textarea autoFocus value={instruction} onChange={event => setInstruction(event.target.value)} maxLength={4000} placeholder="例如：补充最新财报，重做悲观情景估值，并明确证伪条件。" /><div className={styles['modalActions']}><button onClick={() => setRevising(false)}>取消</button><button className={styles['primaryButton']} disabled={instruction.trim() === ''} onClick={() => void client.call('judgement.revise', { id: detail.judgement.id, instruction: instruction.trim() }).then(async () => { setRevising(false); setInstruction(''); notify('修订任务已发送给大师'); await onReload() }).catch(error => notify(messageOf(error), 'error'))}>开始修订</button></div></Modal>}
  </div>
}

function MastersPage({ masters, onStart }: { masters: MasterPersona[]; onStart: (master: MasterPersona) => void }) {
  return <div className={styles['pageStack']}><section className={styles['mastersIntro']}><p className={styles['eyebrow']}>FOUR WAYS OF SEEING</p><h2>不是四个头像，而是四套可追溯的方法论</h2><p>每次研判把对应能力包快照进独立工作区；后续对话继续沿用同一位大师的框架、事实边界与上下文。</p></section><div className={styles['mastersGrid']}>{masters.map((master, index) => <article key={master.id} className={styles['masterCard']} style={{ '--master-color': master.color } as React.CSSProperties}><span className={styles['masterIndex']}>0{index + 1}</span><div className={styles['masterPortrait']}>{master.shortName}</div><p>{master.roleTag}</p><h3>{master.name}</h3><div className={styles['tagRow']}>{master.tags.map(tag => <span key={tag}>{tag}</span>)}</div><blockquote>{master.description}</blockquote><small>能力包版本 {master.version}</small><button onClick={() => onStart(master)}>与{master.name}开始研判 →</button></article>)}</div></div>
}

function SettingsPage({ client, bootstrap, onTheme, onReload, notify }: { client: HanaiClient; bootstrap: BootstrapData; onTheme: (theme: ThemeId) => void; onReload: () => Promise<void>; notify: Notify }) {
  const [credential, setCredential] = useState<{ configured: boolean; writable: boolean; source?: string } | null>(null)
  const [key, setKey] = useState('')
  const [models, setModels] = useState<ModelProviderGroup[]>([])
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const [credentialResult, modelResult] = await Promise.allSettled([client.credential(), client.models()])
    if (credentialResult.status === 'fulfilled') setCredential(credentialResult.value)
    if (modelResult.status === 'fulfilled') setModels(modelResult.value)
  }, [client])
  useEffect(() => { void load() }, [load])
  const setTheme = async (theme: ThemeId) => {
    try { await client.call('theme.set', { theme }); onTheme(theme); notify('主题已切换') } catch (error) { notify(messageOf(error), 'error') }
  }
  return <div className={styles['settingsGrid']}>
    <section className={styles['settingsSection']}><PanelHead title="DeepSeek API Key" hint="由 DSH Credentials 安全托管" /><div className={styles['credentialState']}><span className={credential?.configured ? styles['credentialOn'] : styles['credentialOff']} /><div><strong>{credential?.configured ? '已配置，可调用模型' : '尚未配置'}</strong><small>{credential?.source === 'env' ? '来自环境变量（只读优先）' : credential?.source === 'file' ? '保存在 DSH 本地凭据文件' : 'Key 不会写入 Hanai 数据库或浏览器存储'}</small></div></div>{client.isLoopback ? <><label className={styles['field']}><span>写入新的 API Key</span><input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder="sk-••••••••••••" disabled={credential?.writable === false} /></label><div className={styles['inlineActions']}><button className={styles['primaryButton']} disabled={busy || key.trim() === '' || credential?.writable === false} onClick={() => { setBusy(true); void client.setDeepSeekKey(key).then(async () => { setKey(''); notify('API Key 已安全保存'); await load() }).catch(error => notify(messageOf(error), 'error')).finally(() => setBusy(false)) }}>安全保存</button><button disabled={!credential?.configured || credential.writable === false} onClick={() => void client.unsetDeepSeekKey().then(async () => { notify('已移除托管凭据'); await load() }).catch(error => notify(messageOf(error), 'error'))}>移除</button></div></> : <div className={styles['warning']}>为保护主机凭据，请在运行 DSH 的本机地址打开本页设置 API Key。</div>}</section>
    <section className={styles['settingsSection']}><PanelHead title="界面主题" hint="两套完整产品色" /><div className={styles['themeCards']}><button className={bootstrap.theme === 'ocean' ? styles['themeSelected'] : ''} onClick={() => void setTheme('ocean')}><i className={styles['oceanSwatch']} /><span><strong>澄海蓝</strong><small>冷静、精确、适合数据密集场景</small></span><em>{bootstrap.theme === 'ocean' ? '✓' : ''}</em></button><button className={bootstrap.theme === 'jade' ? styles['themeSelected'] : ''} onClick={() => void setTheme('jade')}><i className={styles['jadeSwatch']} /><span><strong>青玉绿</strong><small>克制、沉静、适合长期研究</small></span><em>{bootstrap.theme === 'jade' ? '✓' : ''}</em></button></div></section>
    <section className={styles['settingsSection']}><PanelHead title="可用模型" hint={`${models.reduce((sum, group) => sum + group.models.length, 0)} 个模型`} /><div className={styles['modelGroups']}>{models.length === 0 ? <p>模型目录暂不可用，请先配置 Provider。</p> : models.map(group => <div key={group.id}><strong>{group.name}</strong><span>{group.models.slice(0, 6).map(model => model.name).join(' · ')}</span></div>)}</div></section>
    <section className={styles['settingsSection']}><PanelHead title="证券主数据" hint={`${bootstrap.diagnostics.securityCount.toLocaleString()} 条`} /><p>用于代码、名称与拼音搜索。同步采用完整性门槛，不会用残缺快照覆盖现有数据。</p><button className={styles['secondaryButton']} disabled={busy} onClick={() => { setBusy(true); void client.call('security.sync', { force: true }).then(async result => { notify(`已同步 ${result.count.toLocaleString()} 条证券`); await onReload() }).catch(error => notify(messageOf(error), 'error')).finally(() => setBusy(false)) }}>立即同步证券列表</button></section>
    <section className={`${styles['settingsSection']} ${styles['settingsWide']}`}><PanelHead title="本地数据与诊断" hint={`v${bootstrap.diagnostics.version}`} /><div className={styles['diagnostics']}><div><span>Hanai 数据根目录</span><code>{bootstrap.diagnostics.dataRoot}</code></div><div><span>SQLite</span><code>{bootstrap.diagnostics.databasePath}</code></div><div><span>研判档案</span><strong>{bootstrap.diagnostics.judgementCount}</strong></div><div><span>大师能力包</span><strong>{bootstrap.diagnostics.masterCount}</strong></div></div><div className={styles['disclaimer']}>市场数据与 Agent 研判仅供研究参考，不构成投资建议。缺失值永远不会被解释为 0。</div></section>
  </div>
}

function GlobalSearch({ client, onClose, onSelect }: { client: HanaiClient; onClose: () => void; onSelect: (stock: SearchResult) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const resultRefs = useRef<Array<HTMLButtonElement | null>>([])
  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => {
    setActiveIndex(0)
    resultRefs.current[0]?.scrollIntoView?.({ block: 'nearest' })
  }, [results])
  useEffect(() => {
    if (query.trim() === '') { setResults([]); setError(null); return }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void client.call('security.search', { query: query.trim() }, controller.signal)
        .then((next) => { setResults(next); setError(null) })
        .catch((reason) => { if (!controller.signal.aborted) setError(messageOf(reason)) })
    }, 180)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [client, query])
  const move = (next: number) => {
    const normalized = Math.max(0, Math.min(results.length - 1, next))
    setActiveIndex(normalized)
    resultRefs.current[normalized]?.scrollIntoView?.({ block: 'nearest' })
  }
  return <div className={styles['modalBackdrop']} role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) onClose() }}><div className={styles['searchModal']} role="dialog" aria-modal="true" aria-label="全局股票搜索" onKeyDown={(event) => {
    if (event.key === 'ArrowDown' && results.length > 0) { event.preventDefault(); move(activeIndex + 1) }
    else if (event.key === 'ArrowUp' && results.length > 0) { event.preventDefault(); move(activeIndex - 1) }
    else if (event.key === 'Enter' && results[activeIndex] !== undefined) { event.preventDefault(); onSelect(results[activeIndex]) }
  }}><header><span>⌕</span><input ref={input} value={query} onChange={event => setQuery(event.target.value)} placeholder="输入代码、名称或拼音首字母…" aria-activedescendant={results[activeIndex] === undefined ? undefined : `hanai-search-${results[activeIndex].secId}`} /><kbd>ESC</kbd></header><div className={styles['searchBody']}>{query.trim() === '' ? <div className={styles['searchHint']}><strong>快速抵达任何标的</strong><p>例如：贵州茅台、600519、gzmt</p></div> : error !== null ? <div className={styles['searchHint']}><strong>搜索暂不可用</strong><p>{error}</p></div> : results.length === 0 ? <div className={styles['searchHint']}><strong>没有匹配结果</strong><p>首次使用请先在设置中同步证券主数据。</p></div> : results.map((result, index) => <button id={`hanai-search-${result.secId}`} ref={(node) => { resultRefs.current[index] = node }} key={result.secId} className={index === activeIndex ? styles['searchActive'] : ''} aria-current={index === activeIndex} onMouseEnter={() => setActiveIndex(index)} onClick={() => onSelect(result)}><span className={styles['searchIndex']}>{String(index + 1).padStart(2, '0')}</span><span><strong>{highlight(result.name, query)}</strong><small>{result.exchange} · {result.code}</small></span><span>{number(result.price)}</span><em className={styles[classForChange(result.changePct)]}>{percent(result.changePct)}</em><b>↗</b></button>)}</div><footer><span>↑↓ 浏览</span><span>↵ 打开</span><small>证券主数据保存在 Hanai 独立目录</small></footer></div></div>
}

function PanelHead({ title, hint, extra }: { title: string; hint?: string; extra?: React.ReactNode }) {
  return <header className={styles['panelHead']}><div><h3>{title}</h3>{hint !== undefined && <span>{hint}</span>}</div>{extra}</header>
}

function DataStateBadge({
  meta,
  marketStatus: status,
  refreshFailed = false,
  liveCapable = true,
}: {
  meta: ProviderMeta | null | undefined
  marketStatus?: DashboardData['overview']['marketStatus']
  refreshFailed?: boolean
  liveCapable?: boolean
}) {
  const state = describeDataStatus(meta, {
    ...(status === undefined ? {} : { marketStatus: status }),
    ...(refreshFailed ? { refreshFailed: true } : {}),
    ...(!liveCapable ? { liveCapable: false } : {}),
  })
  return <span className={`${styles['dataState']} ${styles[`dataState_${state.kind}`]}`} data-data-status={state.kind} title={state.detail}>{state.label}</span>
}

function DataSourceText({ meta }: { meta: ProviderMeta | null | undefined }) {
  if (meta === null || meta === undefined) {
    return <small className={styles['dataSource']}>行情来源元数据未提供</small>
  }
  const timestamp = meta.sourceTimestamp === null
    ? `获取 ${dateTime(meta.fetchedAt)}`
    : `行情 ${dateTime(meta.sourceTimestamp)}`
  return <small className={styles['dataSource']}>{meta.sourceName} · {timestamp}</small>
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return <div className={styles['metric']}><span>{label}</span><strong className={tone === undefined ? undefined : styles[tone]}>{value}</strong></div>
}

function Step({ number: stepNumber, title, detail }: { number: string; title: string; detail: string }) {
  return <div className={styles['step']}><span>{stepNumber}</span><div><h3>{title}</h3><p>{detail}</p></div></div>
}

function Status({ status, large = false }: { status: Judgement['reportStatus']; large?: boolean }) {
  const map: Record<Judgement['reportStatus'], string> = { preparing: '准备中', generating: '生成中', verifying: '校验中', repairing: '修复中', ready: '已完成', revising: '修订中', failed: '失败' }
  return <span className={`${styles['status']} ${styles[`status_${status}`]} ${large ? styles['statusLarge'] : ''}`}>{['preparing', 'generating', 'verifying', 'repairing', 'revising'].includes(status) && <i />}{map[status]}</span>
}

function Empty({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) {
  return <div className={styles['empty']}><span>◇</span><h3>{title}</h3><p>{detail}</p>{action}</div>
}

function Splash({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) {
  return <div className={styles['splash']} data-hanai-root><div className={styles['splashMark']}>花</div><p>HANAI INVESTMENT / DSH</p><h1>{title}</h1><span>{detail}</span>{action}</div>
}

function PageSkeleton({ cards }: { cards: number }) {
  return <div className={styles['skeletonGrid']}>{Array.from({ length: cards }, (_, index) => <div key={index}><i /><i /><i /></div>)}</div>
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className={styles['modalBackdrop']} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><div className={styles['modal']} role="dialog" aria-modal="true"><header><h3>{title}</h3><button onClick={onClose}>×</button></header>{children}</div></div>
}

function modelFromKey(groups: ModelProviderGroup[], key: string): ModelSelectionInput | undefined {
  if (key === '') return undefined
  const split = key.indexOf('/')
  if (split < 1) return undefined
  const provider = key.slice(0, split)
  const model = key.slice(split + 1)
  if (!groups.some(group => group.id === provider && group.models.some(item => item.id === model))) return undefined
  return { provider, model }
}

function marketStatus(status: DashboardData['overview']['marketStatus']): string {
  return { pre: '盘前准备', trading: '交易进行中', break: '午间休市', closed: '已收盘', unknown: '状态待确认' }[status]
}

function valuationRank(rank: number | null): string {
  if (rank === null) return '—'
  return rankLabels[rank as keyof typeof rankLabels] ?? `等级 ${number(rank, 0)}`
}

const rankLabels = {
  0: '数据不足',
  1: '数据陈旧',
  2: '价值陷阱嫌疑',
  3: '严重低估',
  4: '低估',
  5: '合理范围',
  6: '高估',
  7: '严重高估',
} as const

function compareNullable(a: string | number | null, b: string | number | null): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b, 'zh-CN') : Number(a) - Number(b)
}

function exchangeFor(secId: string, code: string): SecurityMaster['exchange'] {
  if (secId.startsWith('1.')) return 'SH'
  return /^[489]/.test(code) ? 'BJ' : 'SZ'
}

function highlight(value: string, query: string): React.ReactNode {
  const index = value.toLowerCase().indexOf(query.toLowerCase())
  if (index < 0) return value
  return <>{value.slice(0, index)}<mark>{value.slice(index, index + query.length)}</mark>{value.slice(index + query.length)}</>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type Notify = (text: string, kind?: Notice['kind']) => void
