import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-client-connection/client'
import type {
  BootstrapData,
  DashboardData,
  Judgement,
  JudgementDetail,
  MasterPersona,
  ProviderMeta,
  ReportAudit,
  ReportAuditCheck,
  ReportEvidenceItem,
  ReportVersion,
  ResearchComparison,
  ResearchFollowUp,
  ResearchInboxItem,
  ResearchPrediction,
  ResearchPredictionInboxItem,
  ResearchQualityItem,
  SearchResult,
  SecurityMaster,
  StockDetail,
  StockQuote,
  ThemeId,
  WatchGroup,
  WatchQuote,
  WatchResearchCoverage,
  WatchValuation,
} from '../../contracts/src/index.ts'
import { ChatPanel } from '../../client-chat/src/index.tsx'
import { HanaiClient, type DefaultModelView } from './api.ts'
import {
  buildKlineOption,
  buildRadarOption,
  buildTreemapOption,
  buildTrendOption,
  buildValuationOption,
  getChartPalette,
  treemapLegendStops,
  treemapTargetFromEvent,
} from './chart-options.ts'
import { EChart } from './echarts.tsx'
import { MarkdownView } from './markdown.tsx'
import { describeDataStatus } from './data-status.ts'
import { classForChange, dateTime, money, number, percent, quantity, ratio } from './format.ts'
import styles from './styles.module.css'

type TopPage = 'dashboard' | 'watch' | 'judgements' | 'personas' | 'settings'
type AppRoute =
  | { page: TopPage }
  | { page: 'stock'; secId: string }
  | { page: 'judgement-detail'; judgementId: string }
type Notice = { id: number; kind: 'success' | 'error'; text: string }
type JudgementLaunchRequest = { key: number; stock: SearchResult | null; masterId: string | null }

const BRAND_NAME = 'Hanai Worth · 值见'

const NAV: ReadonlyArray<{ page: TopPage; path: string; icon: string; label: string }> = [
  { page: 'dashboard', path: '/dashboard', icon: '◈', label: '今日市场' },
  { page: 'watch', path: '/watch', icon: '☆', label: '自选与发现' },
  { page: 'judgements', path: '/judgements', icon: '研', label: '大师研判' },
  { page: 'personas', path: '/personas', icon: '◉', label: '专家中心' },
  { page: 'settings', path: '/settings', icon: '⚙', label: '设置与诊断' },
]

export interface HanaiWorkbenchProps {
  client: HanaiClient
}

export function HanaiWorkbench({ client }: HanaiWorkbenchProps) {
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null)
  const [route, setRoute] = useState<AppRoute>(() => routeFromHash(window.location.hash))
  const [searchOpen, setSearchOpen] = useState(false)
  const [launchRequest, setLaunchRequest] = useState<JudgementLaunchRequest | null>(null)
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

  const navigate = useCallback((path: string, replace = false) => {
    const hash = `#${path}`
    if (replace) window.history.replaceState(null, '', hash)
    else if (window.location.hash !== hash) window.history.pushState(null, '', hash)
    setRoute(routeFromHash(hash))
    setSearchOpen(false)
  }, [])

  useEffect(() => { void reload() }, [reload])
  useEffect(() => {
    const previousTitle = document.title
    return () => { document.title = previousTitle }
  }, [])
  useEffect(() => {
    document.title = `${routeTitle(route)} — ${BRAND_NAME}`
  }, [route])
  useEffect(() => {
    if (window.location.hash === '' || window.location.hash === '#') navigate('/dashboard', true)
    const syncRoute = () => setRoute(routeFromHash(window.location.hash))
    window.addEventListener('hashchange', syncRoute)
    window.addEventListener('popstate', syncRoute)
    return () => {
      window.removeEventListener('hashchange', syncRoute)
      window.removeEventListener('popstate', syncRoute)
    }
  }, [navigate])
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

  const setGroups = useCallback((groups: WatchGroup[]) => {
    setBootstrap(current => current === null ? current : { ...current, groups })
  }, [])
  const setJudgements = useCallback((judgements: Judgement[]) => {
    setBootstrap(current => current === null ? current : { ...current, judgements })
  }, [])
  const clearLaunchRequest = useCallback(() => setLaunchRequest(null), [])

  if (loading) return <Splash title="正在启动 Hanai Worth" detail="连接本地价值研究工作台…" />
  if (fatal !== null || bootstrap === null) {
    return <Splash title="Hanai Worth 暂时无法启动" detail={fatal ?? '未知错误'} action={<button onClick={() => void reload()}>重新连接</button>} />
  }

  const openStock = (stock: Pick<SecurityMaster, 'secId'>) => navigate(`/stock/${encodeURIComponent(stock.secId)}`)
  const openJudgement = (id: string) => navigate(`/judgements/${encodeURIComponent(id)}`)
  const activePage = route.page === 'judgement-detail' ? 'judgements' : route.page === 'stock' ? null : route.page

  return (
    <div className={styles['app']} data-theme={bootstrap.theme} data-hanai-root>
      <aside className={styles['sidebar']}>
        <button className={styles['brand']} onDoubleClick={() => navigate('/dashboard')} aria-label={BRAND_NAME}>
          <BrandMark />
          <span className={styles['brandCopy']}><strong>Hanai</strong><small>WORTH · 值见</small></span>
        </button>
        <nav className={styles['nav']} aria-label="主导航">
          {NAV.map(item => (
            <button
              key={item.page}
              className={activePage === item.page ? styles['navActive'] : ''}
              onClick={() => navigate(item.path)}
              aria-current={activePage === item.page ? 'page' : undefined}
            >
              <span className={styles['navIcon']}>{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div className={styles['body']}>
        <header className={styles['topbar']}>
          <button className={styles['searchTrigger']} onClick={() => setSearchOpen(true)}>
            <span className={styles['searchIcon']}>⌕</span>
            <span>搜索股票 · 代码 / 名称 / 拼音</span>
            <kbd>⌘K</kbd>
          </button>
          <div className={styles['topbarActions']}>
            <FullscreenToggle />
            <ThemeToggle
              theme={bootstrap.theme}
              onToggle={() => {
                const theme: ThemeId = bootstrap.theme === 'dark' ? 'light' : 'dark'
                void client.call('theme.set', { theme })
                  .then(() => setBootstrap({ ...bootstrap, theme }))
                  .catch(error => notify(messageOf(error), 'error'))
              }}
            />
          </div>
        </header>

        <main className={styles['content']}>
          {route.page === 'dashboard' && <DashboardPage client={client} theme={bootstrap.theme} onStock={openStock} notify={notify} />}
          {route.page === 'watch' && <WatchPage
            client={client}
            groups={bootstrap.groups}
            onGroups={setGroups}
            onStock={openStock}
            onJudgement={openJudgement}
            onCreateJudgement={(stock, masterId) => {
              setLaunchRequest({ key: Date.now(), stock, masterId })
              navigate('/judgements')
            }}
            notify={notify}
          />}
          {route.page === 'stock' && (
            <StockPage
              client={client}
              secId={route.secId}
              theme={bootstrap.theme}
              groups={bootstrap.groups}
              onGroups={setGroups}
              onCreateJudgement={(stock) => {
                setLaunchRequest({ key: Date.now(), stock, masterId: null })
                navigate('/judgements')
              }}
              notify={notify}
            />
          )}
          {route.page === 'judgements' && (
            <JudgementsPage
              client={client}
              masters={bootstrap.masters}
              judgements={bootstrap.judgements}
              launchRequest={launchRequest}
              onLaunchHandled={clearLaunchRequest}
              onJudgements={setJudgements}
              onOpen={openJudgement}
              onStock={openStock}
              notify={notify}
            />
          )}
          {route.page === 'judgement-detail' && (
            <JudgementDetailPage client={client} id={route.judgementId} onBack={() => navigate('/judgements')} onRetry={(stock, masterId) => { setLaunchRequest({ key: Date.now(), stock, masterId }); navigate('/judgements') }} notify={notify} />
          )}
          {route.page === 'personas' && <PersonasPage masters={bootstrap.masters} />}
          {route.page === 'settings' && (
            <SettingsPage
              client={client}
              bootstrap={bootstrap}
              onTheme={(theme) => setBootstrap({ ...bootstrap, theme })}
              onReload={reload}
              notify={notify}
            />
          )}
        </main>
      </div>

      {searchOpen && (
        <GlobalSearch
          client={client}
          groups={bootstrap.groups}
          onGroups={setGroups}
          onClose={() => setSearchOpen(false)}
          onSelect={openStock}
          notify={notify}
        />
      )}
      <div className={styles['toastStack']} aria-live="polite">
        {notices.map(notice => (
          <div key={notice.id} className={notice.kind === 'error' ? styles['toastError'] : styles['toast']}>
            <span>{notice.kind === 'error' ? '!' : '✓'}</span>{notice.text}
          </div>
        ))}
      </div>
    </div>
  )
}

function DashboardPage({ client, theme, onStock, notify }: { client: HanaiClient; theme: ThemeId; onStock: (stock: SearchResult) => void; notify: Notify }) {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [rank, setRank] = useState<keyof DashboardData['ranks']>('gainers')
  const [sectorType, setSectorType] = useState<'industry' | 'concept'>('industry')
  const [sectorLoading, setSectorLoading] = useState(false)
  const [drill, setDrill] = useState<{ code: string; name: string; stocks: StockQuote[] | null; meta: ProviderMeta | null } | null>(null)
  const drillGeneration = useRef(0)
  const drillController = useRef<AbortController | null>(null)
  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true)
    try {
      setData(await client.call('dashboard.get', { refresh }))
      setRefreshError(null)
    } catch (error) {
      const message = messageOf(error)
      setRefreshError(message)
      if (refresh) notify(message, 'error')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [client, notify])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 30_000)
    return () => window.clearInterval(timer)
  }, [load])
  useEffect(() => () => {
    drillGeneration.current += 1
    drillController.current?.abort()
  }, [])

  const palette = useMemo(() => getChartPalette(theme), [theme])
  const sector = data === null ? null : sectorType === 'industry' ? data.industry : data.concept
  const treemapOption = useMemo(() => buildTreemapOption(sector, palette), [palette, sector])
  const legendStops = useMemo(() => treemapLegendStops(palette), [palette])

  if (loading && data === null) return <Page><PageSkeleton cards={6} /></Page>
  if (data === null) {
    return <Page><PageHeader title="今日市场" /><Empty title="市场数据暂不可用" detail={refreshError ?? '行情源尚未返回可用数据。'} action={<button className={styles['button']} onClick={() => void load(true)}>重新加载</button>} /></Page>
  }

  const breadth = data.overview.breadth
  const limitUp = Math.max(0, breadth.limitUp ?? 0)
  const limitDown = Math.max(0, breadth.limitDown ?? 0)
  const breadthSegments = {
    limitUp,
    up: Math.max(0, (breadth.up ?? 0) - limitUp),
    flat: Math.max(0, breadth.flat ?? 0),
    down: Math.max(0, (breadth.down ?? 0) - limitDown),
    limitDown,
  }
  const breadthTotal = Object.values(breadthSegments).reduce((sum, value) => sum + value, 0)

  const openSector = (params: unknown) => {
    const target = treemapTargetFromEvent(params)
    if (target === null) return
    const generation = ++drillGeneration.current
    drillController.current?.abort()
    const controller = new AbortController()
    drillController.current = controller
    setDrill({ code: target.sectorCode, name: target.name, stocks: null, meta: null })
    void client.call('sector.stocks', { sectorCode: target.sectorCode }, controller.signal)
      .then(result => {
        if (controller.signal.aborted || generation !== drillGeneration.current) return
        setDrill({ code: target.sectorCode, name: target.name, stocks: result.stocks, meta: result.meta })
      })
      .catch(error => {
        if (controller.signal.aborted || generation !== drillGeneration.current) return
        setDrill(null)
        notify(messageOf(error), 'error')
      })
  }
  const closeDrill = () => {
    drillGeneration.current += 1
    drillController.current?.abort()
    drillController.current = null
    setDrill(null)
  }
  const selectSectorType = (type: 'industry' | 'concept') => {
    if (sectorType === type) return
    closeDrill()
    setSectorLoading(true)
    setSectorType(type)
    window.setTimeout(() => setSectorLoading(false), 0)
  }

  return <Page>
    <PageHeader
      title="今日市场"
      meta={<><DataStateBadge meta={data.overview.meta} marketStatus={data.overview.marketStatus} refreshFailed={refreshError !== null} /><span>数据来源 {data.overview.meta.sourceName} · 近实时快照 · 更新于 {shortTime(data.overview.meta.fetchedAt)}</span></>}
      action={<button className={`${styles['button']} ${styles['buttonGhost']}`} disabled={refreshing} onClick={() => void load(true)}>{refreshing ? '刷新中' : '刷新'}</button>}
    />
    {refreshError !== null && <div className={styles['errorCard']}><b>行情获取失败：</b>{refreshError}<span>请检查网络后点击刷新；其他面板保留最近成功的数据。</span></div>}

    <div className={styles['indexGrid']}>
      {data.overview.indices.map(index => (
        <article className={`${styles['card']} ${styles['indexCard']} ${styles[classForChange(index.changePct)]}`} key={index.code}>
          <div className={styles['indexName']}>{index.name}</div>
          <div className={styles['indexPrice']}>{number(index.price)}</div>
          <div className={styles['indexChange']}><span>{signedNumber(index.change)}</span><span>{percent(index.changePct)}</span></div>
          <div className={styles['indexAmount']}>成交 {money(index.amount)}</div>
        </article>
      ))}
    </div>

    <article className={`${styles['card']} ${styles['breadthCard']}`}>
      <PanelHead title="市场宽度" hint="东方财富口径 · 沪深北非 ST" extra={<span className={styles['metaText']}>两市成交 {money(breadth.totalAmount)}</span>} />
      {breadthTotal > 0 ? <>
        <div className={styles['breadthBar']} aria-label="涨停、上涨、平盘、下跌、跌停分布">
          {([
            ['limitUp', breadthSegments.limitUp, 'breadthLimitUp'],
            ['up', breadthSegments.up, 'breadthUp'],
            ['flat', breadthSegments.flat, 'breadthFlat'],
            ['down', breadthSegments.down, 'breadthDown'],
            ['limitDown', breadthSegments.limitDown, 'breadthLimitDown'],
          ] as const).map(([id, value, className]) => value > 0 ? <i key={id} className={styles[className]} style={{ width: `${value / breadthTotal * 100}%` }} /> : null)}
        </div>
        <div className={styles['breadthStats']}>
          <span className={styles['limitUp']}>涨停 <b>{breadthSegments.limitUp}</b></span>
          <span className={styles['up']}>上涨 <b>{breadthSegments.up}</b></span>
          <span className={styles['flat']}>平盘 <b>{breadthSegments.flat}</b></span>
          <span className={styles['down']}>下跌 <b>{breadthSegments.down}</b></span>
          <span className={styles['limitDown']}>跌停 <b>{breadthSegments.limitDown}</b></span>
        </div>
      </> : <Empty compact title="暂无涨跌分布数据" detail="行情源尚未返回市场宽度。" />}
    </article>

    <div className={styles['dashboardMainGrid']}>
      <article className={`${styles['card']} ${styles['treemapCard']}`}>
        <PanelHead
          title={drill === null ? '板块热力' : `板块热力 · ${drill.name}`}
          extra={drill === null ? <div className={styles['buttonGroup']}>
            <button className={sectorType === 'industry' ? styles['buttonSelected'] : styles['button']} disabled={sectorLoading} onClick={() => selectSectorType('industry')}>行业</button>
            <button className={sectorType === 'concept' ? styles['buttonSelected'] : styles['button']} disabled={sectorLoading} onClick={() => selectSectorType('concept')}>概念</button>
          </div> : <button className={styles['button']} onClick={closeDrill}>← 返回板块</button>}
        />
        {drill === null ? <div className={styles['treemapBody']}>
          {treemapOption === null ? <Empty compact title="暂无板块热力数据" detail="等待板块成交额与涨跌幅。" /> : <EChart option={treemapOption} {...(styles['treemapChart'] === undefined ? {} : { className: styles['treemapChart'] })} ariaLabel="板块成交额热力图" onChartClick={openSector} />}
          <div className={styles['treemapLegend']}>
            <span>涨</span>
            {legendStops.map(stop => <i key={stop.value} style={{ background: stop.color }} title={stop.title} />)}
            <span>跌</span>
            <small>面积 = 板块成交额（个股可重叠）· 其他固定</small>
          </div>
        </div> : <SectorDrill drill={drill} onStock={onStock} />}
      </article>

      <article className={`${styles['card']} ${styles['rankCard']}`}>
        <PanelHead title="榜单" extra={<div className={styles['buttonGroup']}>
          {([['gainers', '涨幅榜'], ['losers', '跌幅榜'], ['amount', '成交额'], ['turnover', '换手率']] as const).map(([id, label]) => <button key={id} className={rank === id ? styles['buttonSelected'] : styles['button']} onClick={() => setRank(id)}>{label}</button>)}
        </div>} />
        <div className={styles['rankBody']}>
          <table className={styles['dataTable']}>
            <thead><tr><th>名称</th><th>最新价</th><th>涨跌幅</th><th>{rank === 'turnover' ? '换手率' : '成交额'}</th></tr></thead>
            <tbody>{data.ranks[rank].map(item => <tr key={item.secId} onClick={() => onStock(toSearchResult(item))}><td><b>{item.name}</b><small>{item.code}</small></td><td>{number(item.price)}</td><td className={styles[classForChange(item.changePct)]}>{percent(item.changePct)}</td><td>{rank === 'turnover' ? ratio(item.turnoverRate) : money(item.amount)}</td></tr>)}</tbody>
          </table>
          {data.ranks[rank].length === 0 && <Empty compact title="暂无榜单数据" detail="当前数据源未返回该榜单。" />}
        </div>
      </article>
    </div>
  </Page>
}

function SectorDrill({ drill, onStock }: { drill: { name: string; stocks: StockQuote[] | null; meta: ProviderMeta | null }; onStock: (stock: SearchResult) => void }) {
  if (drill.stocks === null) return <PageSkeleton cards={3} />
  return <div className={styles['drillBody']}>
    <div className={styles['dataStrip']}><DataStateBadge meta={drill.meta} /><DataSourceText meta={drill.meta} /></div>
    <table className={styles['dataTable']}>
      <thead><tr><th>名称</th><th>最新价</th><th>涨跌幅</th><th>成交额</th><th>换手率</th><th>市值</th></tr></thead>
      <tbody>{drill.stocks.map(stock => <tr key={stock.secId} onClick={() => onStock(toSearchResult(stock))}><td><b>{stock.name}</b><small>{stock.code}</small></td><td>{number(stock.price)}</td><td className={styles[classForChange(stock.changePct)]}>{percent(stock.changePct)}</td><td>{money(stock.amount)}</td><td>{ratio(stock.turnoverRate)}</td><td>{money(stock.marketCap)}</td></tr>)}</tbody>
    </table>
  </div>
}

type WatchSortKey = 'addedAt' | 'changePct' | 'amount' | 'marketCap' | 'pe'
type WatchCoverageFilter = 'all' | 'current' | 'active' | 'stale' | 'missing' | 'followups' | 'predictions'

function WatchPage({ client, groups, onGroups, onStock, onJudgement, onCreateJudgement, notify }: {
  client: HanaiClient
  groups: WatchGroup[]
  onGroups: (groups: WatchGroup[]) => void
  onStock: (stock: SearchResult) => void
  onJudgement: (id: string) => void
  onCreateJudgement: (stock: SearchResult, masterId: string | null) => void
  notify: Notify
}) {
  const [groupId, setGroupId] = useState(() => groups.find(group => group.isDefault)?.id ?? groups[0]?.id ?? '')
  const [quotes, setQuotes] = useState<WatchQuote[]>([])
  const [loadedGroupId, setLoadedGroupId] = useState<string | null>(null)
  const [quoteMeta, setQuoteMeta] = useState<ProviderMeta | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(true)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [valuations, setValuations] = useState<WatchValuation[]>([])
  const [loadedValuationGroupId, setLoadedValuationGroupId] = useState<string | null>(null)
  const [valuationMeta, setValuationMeta] = useState<ProviderMeta | null>(null)
  const [valuationLoading, setValuationLoading] = useState(true)
  const [valuationFailed, setValuationFailed] = useState(false)
  const [researchCoverage, setResearchCoverage] = useState<WatchResearchCoverage[]>([])
  const [loadedCoverageGroupId, setLoadedCoverageGroupId] = useState<string | null>(null)
  const [coverageLoading, setCoverageLoading] = useState(true)
  const [coverageFailed, setCoverageFailed] = useState(false)
  const [staleAfterDays, setStaleAfterDays] = useState(90)
  const [refreshing, setRefreshing] = useState(false)
  const [sort, setSort] = useState<{ key: WatchSortKey; desc: boolean }>({ key: 'addedAt', desc: true })
  const [coverageFilter, setCoverageFilter] = useState<WatchCoverageFilter>('all')
  const [managerOpen, setManagerOpen] = useState(false)
  const [addQuery, setAddQuery] = useState('')
  const [addResults, setAddResults] = useState<SearchResult[]>([])
  const [addTarget, setAddTarget] = useState<SearchResult | null>(null)
  const [moveTarget, setMoveTarget] = useState<{ quote: WatchQuote; sourceGroupId: string } | null>(null)
  const activeGroupId = useRef(groupId)
  const quoteGeneration = useRef(0)
  const quoteController = useRef<AbortController | null>(null)
  const quoteRequestGroupId = useRef<string | null>(null)
  const valuationGeneration = useRef(0)
  const valuationController = useRef<AbortController | null>(null)
  const valuationRequestGroupId = useRef<string | null>(null)
  const coverageGeneration = useRef(0)
  const coverageController = useRef<AbortController | null>(null)
  const coverageRequestGroupId = useRef<string | null>(null)

  const loadQuotes = useCallback(async (
    requestedGroupId: string,
    mode: 'initial' | 'poll' | 'refresh' = 'poll',
    force = false,
  ) => {
    if (!force && quoteRequestGroupId.current === requestedGroupId
      && quoteController.current !== null
      && !quoteController.current.signal.aborted) return
    const generation = ++quoteGeneration.current
    quoteController.current?.abort()
    const controller = new AbortController()
    quoteController.current = controller
    quoteRequestGroupId.current = requestedGroupId
    if (mode === 'initial') setQuoteLoading(true)
    if (requestedGroupId === '') {
      setQuotes([])
      setLoadedGroupId(null)
      setQuoteMeta(null)
      setQuoteLoading(false)
      setRefreshFailed(false)
      quoteController.current = null
      quoteRequestGroupId.current = null
      return
    }
    try {
      const result = await client.call('watch.quotes', { groupId: requestedGroupId }, controller.signal)
      if (controller.signal.aborted
        || generation !== quoteGeneration.current
        || requestedGroupId !== activeGroupId.current) return
      setQuotes(result.quotes)
      setLoadedGroupId(requestedGroupId)
      setQuoteMeta(result.meta)
      setRefreshFailed(false)
    } catch (error) {
      if (controller.signal.aborted
        || generation !== quoteGeneration.current
        || requestedGroupId !== activeGroupId.current) return
      setRefreshFailed(true)
      if (mode !== 'poll') notify(messageOf(error), 'error')
    } finally {
      if (generation === quoteGeneration.current && requestedGroupId === activeGroupId.current) {
        setQuoteLoading(false)
      }
      if (quoteController.current === controller) {
        quoteController.current = null
        quoteRequestGroupId.current = null
      }
    }
  }, [client, notify])

  const loadValuations = useCallback(async (
    requestedGroupId: string,
    mode: 'initial' | 'refresh' = 'initial',
    force = false,
  ) => {
    if (!force && valuationRequestGroupId.current === requestedGroupId
      && valuationController.current !== null
      && !valuationController.current.signal.aborted) return
    const generation = ++valuationGeneration.current
    valuationController.current?.abort()
    const controller = new AbortController()
    valuationController.current = controller
    valuationRequestGroupId.current = requestedGroupId
    setValuationLoading(true)
    if (requestedGroupId === '') {
      setValuations([])
      setLoadedValuationGroupId(null)
      setValuationMeta(null)
      setValuationLoading(false)
      setValuationFailed(false)
      valuationController.current = null
      valuationRequestGroupId.current = null
      return
    }
    try {
      const result = await client.call('watch.valuations', { groupId: requestedGroupId }, controller.signal)
      if (controller.signal.aborted
        || generation !== valuationGeneration.current
        || requestedGroupId !== activeGroupId.current) return
      setValuations(result.valuations)
      setLoadedValuationGroupId(requestedGroupId)
      setValuationMeta(result.meta)
      setValuationFailed(false)
    } catch (error) {
      if (controller.signal.aborted
        || generation !== valuationGeneration.current
        || requestedGroupId !== activeGroupId.current) return
      setLoadedValuationGroupId(requestedGroupId)
      setValuationFailed(true)
      if (mode === 'refresh') notify(`合理估值加载失败：${messageOf(error)}`, 'error')
    } finally {
      if (generation === valuationGeneration.current && requestedGroupId === activeGroupId.current) {
        setValuationLoading(false)
      }
      if (valuationController.current === controller) {
        valuationController.current = null
        valuationRequestGroupId.current = null
      }
    }
  }, [client, notify])

  const loadResearchCoverage = useCallback(async (
    requestedGroupId: string,
    mode: 'initial' | 'refresh' = 'initial',
    force = false,
  ) => {
    if (!force && coverageRequestGroupId.current === requestedGroupId
      && coverageController.current !== null
      && !coverageController.current.signal.aborted) return
    const generation = ++coverageGeneration.current
    coverageController.current?.abort()
    const controller = new AbortController()
    coverageController.current = controller
    coverageRequestGroupId.current = requestedGroupId
    setCoverageLoading(true)
    if (requestedGroupId === '') {
      setResearchCoverage([])
      setLoadedCoverageGroupId(null)
      setCoverageLoading(false)
      setCoverageFailed(false)
      coverageController.current = null
      coverageRequestGroupId.current = null
      return
    }
    try {
      const result = await client.call('watch.researchCoverage', { groupId: requestedGroupId }, controller.signal)
      if (controller.signal.aborted
        || generation !== coverageGeneration.current
        || requestedGroupId !== activeGroupId.current) return
      setResearchCoverage(result.items)
      setLoadedCoverageGroupId(requestedGroupId)
      setStaleAfterDays(result.staleAfterDays)
      setCoverageFailed(false)
    } catch (error) {
      if (controller.signal.aborted
        || generation !== coverageGeneration.current
        || requestedGroupId !== activeGroupId.current) return
      setLoadedCoverageGroupId(requestedGroupId)
      setCoverageFailed(true)
      if (mode === 'refresh') notify(`研究覆盖加载失败：${messageOf(error)}`, 'error')
    } finally {
      if (generation === coverageGeneration.current && requestedGroupId === activeGroupId.current) {
        setCoverageLoading(false)
      }
      if (coverageController.current === controller) {
        coverageController.current = null
        coverageRequestGroupId.current = null
      }
    }
  }, [client, notify])

  useEffect(() => {
    if (groups.some(group => group.id === groupId)) return
    const fallback = groups.find(group => group.isDefault)?.id ?? groups[0]?.id ?? ''
    activeGroupId.current = fallback
    setGroupId(fallback)
  }, [groupId, groups])
  useEffect(() => {
    activeGroupId.current = groupId
    quoteGeneration.current += 1
    quoteController.current?.abort()
    quoteController.current = null
    quoteRequestGroupId.current = null
    setQuotes([])
    setLoadedGroupId(null)
    setQuoteMeta(null)
    setQuoteLoading(true)
    setRefreshFailed(false)
    valuationGeneration.current += 1
    valuationController.current?.abort()
    valuationController.current = null
    valuationRequestGroupId.current = null
    setValuations([])
    setLoadedValuationGroupId(null)
    setValuationMeta(null)
    setValuationLoading(true)
    setValuationFailed(false)
    coverageGeneration.current += 1
    coverageController.current?.abort()
    coverageController.current = null
    coverageRequestGroupId.current = null
    setResearchCoverage([])
    setLoadedCoverageGroupId(null)
    setCoverageLoading(true)
    setCoverageFailed(false)
    setRefreshing(false)
    setCoverageFilter('all')
    setMoveTarget(null)
    void loadQuotes(groupId, 'initial')
    void loadValuations(groupId)
    void loadResearchCoverage(groupId)
    const timer = window.setInterval(() => void loadQuotes(groupId), 15_000)
    return () => {
      window.clearInterval(timer)
      quoteGeneration.current += 1
      quoteController.current?.abort()
      valuationGeneration.current += 1
      valuationController.current?.abort()
      coverageGeneration.current += 1
      coverageController.current?.abort()
    }
  }, [groupId, loadQuotes, loadResearchCoverage, loadValuations])
  useEffect(() => {
    if (addQuery.trim() === '') { setAddResults([]); return }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void client.call('security.search', { query: addQuery.trim() }, controller.signal)
        .then(results => setAddResults(results.slice(0, 8)))
        .catch(error => { if (!controller.signal.aborted) notify(messageOf(error), 'error') })
    }, 180)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [addQuery, client, notify])

  const displayedGroupId = loadedGroupId === groupId ? loadedGroupId : null
  const visibleQuotes = displayedGroupId === null ? [] : quotes
  const visibleValuations = loadedValuationGroupId === groupId ? valuations : []
  const visibleCoverage = loadedCoverageGroupId === groupId ? researchCoverage : []
  const valuationMap = useMemo(() => new Map(visibleValuations.map(item => [item.secId, item])), [visibleValuations])
  const coverageMap = useMemo(() => new Map(visibleCoverage.map(item => [item.secId, item])), [visibleCoverage])
  const coverageSummary = useMemo(() => summarizeResearchCoverage(visibleCoverage), [visibleCoverage])
  const sorted = useMemo(() => visibleQuotes
    .filter(quote => matchesResearchCoverageFilter(coverageMap.get(quote.secId), coverageFilter))
    .sort((left, right) => compareNullable(left[sort.key], right[sort.key], sort.desc)), [coverageFilter, coverageMap, sort, visibleQuotes])
  const toggleSort = (key: WatchSortKey) => setSort(current => {
    if (current.key !== key) return { key, desc: true }
    if (current.desc) return { key, desc: false }
    return { key: 'addedAt', desc: true }
  })
  const selectGroup = (nextGroupId: string) => {
    if (nextGroupId === activeGroupId.current) return
    activeGroupId.current = nextGroupId
    quoteGeneration.current += 1
    quoteController.current?.abort()
    valuationGeneration.current += 1
    valuationController.current?.abort()
    coverageGeneration.current += 1
    coverageController.current?.abort()
    setQuotes([])
    setLoadedGroupId(null)
    setQuoteMeta(null)
    setQuoteLoading(true)
    setRefreshFailed(false)
    setValuations([])
    setLoadedValuationGroupId(null)
    setValuationMeta(null)
    setValuationLoading(true)
    setValuationFailed(false)
    setResearchCoverage([])
    setLoadedCoverageGroupId(null)
    setCoverageLoading(true)
    setCoverageFailed(false)
    setRefreshing(false)
    setCoverageFilter('all')
    setMoveTarget(null)
    setGroupId(nextGroupId)
  }
  const changed = (next: WatchGroup[]) => {
    onGroups(next)
    const current = activeGroupId.current
    const nextGroupId = next.some(group => group.id === current)
      ? current
      : next.find(group => group.isDefault)?.id ?? next[0]?.id ?? ''
    if (nextGroupId !== current) selectGroup(nextGroupId)
    else {
      void loadQuotes(nextGroupId, 'refresh', true)
      void loadValuations(nextGroupId, 'refresh', true)
      void loadResearchCoverage(nextGroupId, 'refresh', true)
    }
  }

  const refreshCurrentGroup = async () => {
    const requestedGroupId = activeGroupId.current
    if (requestedGroupId === '' || refreshing) return
    setRefreshing(true)
    await Promise.all([
      loadQuotes(requestedGroupId, 'refresh', true),
      loadValuations(requestedGroupId, 'refresh', true),
      loadResearchCoverage(requestedGroupId, 'refresh', true),
    ])
    if (activeGroupId.current === requestedGroupId) setRefreshing(false)
  }

  const initialLoading = quoteLoading && displayedGroupId === null
  const initialLoadFailed = refreshFailed && displayedGroupId === null && !quoteLoading
  const skeletonRows = Math.min(6, Math.max(3, groups.find(group => group.id === groupId)?.secIds.length ?? 0))

  return <Page>
    <PageHeader
      title="自选与发现"
      meta={<>{initialLoading ? <span className={`${styles['dataState']} ${styles['dataState_loading']}`}>加载中</span> : <DataStateBadge meta={quoteMeta} refreshFailed={refreshFailed} />}<span>当前分组 · 行情更新于 {shortTime(quoteMeta?.fetchedAt ?? null)} · 估值按日缓存</span></>}
      action={<button className={styles['button']} disabled={refreshing || groupId === ''} onClick={() => void refreshCurrentGroup()} aria-label="刷新当前自选分组"><span className={`${styles['refreshIcon']} ${refreshing ? styles['refreshIconSpinning'] : ''}`} aria-hidden="true">↻</span>{refreshing ? '刷新中…' : '刷新'}</button>}
    />
    <div className={styles['watchToolbar']}>
      <div className={styles['groupTabs']}>
        {groups.map(group => <button key={group.id} className={group.id === groupId ? styles['buttonSelected'] : styles['button']} onClick={() => selectGroup(group.id)}>{group.name}{group.isDefault && <small>默认</small>}<span>{group.secIds.length}</span></button>)}
        <button className={`${styles['button']} ${styles['buttonGhost']}`} onClick={() => setManagerOpen(true)}>管理分组</button>
      </div>
      <div className={styles['inlineStockSearch']}>
        <input value={addQuery} onChange={event => setAddQuery(event.target.value)} placeholder="添加自选：代码 / 名称 / 拼音" />
        {addResults.length > 0 && <div className={`${styles['card']} ${styles['inlineSearchResults']}`}>{addResults.map(result => <button key={result.secId} onClick={() => setAddTarget(result)}><span>{result.code}</span><b>{result.name}</b><small>{result.exchange}</small><em>＋ 加入自选</em></button>)}</div>}
      </div>
    </div>

    <ResearchCoverageStrip
      summary={coverageSummary}
      loading={coverageLoading && loadedCoverageGroupId !== groupId}
      failed={coverageFailed}
      staleAfterDays={staleAfterDays}
      filter={coverageFilter}
      onFilter={setCoverageFilter}
    />

    <article className={styles['card']}>
      {initialLoading ? <WatchTableSkeleton rows={skeletonRows} /> : initialLoadFailed ? <Empty title="自选行情暂不可用" detail="已有自选仍保存在本地，请检查网络后重试。" action={<button className={styles['button']} onClick={() => void refreshCurrentGroup()}>重新加载</button>} /> : sorted.length === 0 ? <Empty title={visibleQuotes.length === 0 ? '当前分组暂无自选股' : '当前筛选暂无自选股'} detail={visibleQuotes.length === 0 ? '使用上方搜索框或 ⌘K 全局搜索添加。' : '换一个研究状态，或查看全部自选。'} {...(visibleQuotes.length === 0 ? {} : { action: <button className={styles['button']} onClick={() => setCoverageFilter('all')}>查看全部</button> })} /> : <div className={styles['tableWrap']}><table className={`${styles['dataTable']} ${styles['watchTable']}`}>
        <thead><tr>
          <th>名称</th><th>研究覆盖</th><th>最新价</th>
          <SortableHead label="涨跌幅" column="changePct" sort={sort} onSort={toggleSort} />
          <SortableHead label="成交额" column="amount" sort={sort} onSort={toggleSort} />
          <th>换手率</th>
          <SortableHead label="总市值" column="marketCap" sort={sort} onSort={toggleSort} />
          <SortableHead label="PE(动)" column="pe" sort={sort} onSort={toggleSort} />
          <th>PB</th>
          <th>合理估值</th>
          <th>距现价</th>
          <SortableHead label="加入日期" column="addedAt" sort={sort} onSort={toggleSort} />
          <th>加入以来</th><th />
        </tr></thead>
        <tbody>{sorted.map(quote => <tr key={quote.secId} tabIndex={0} aria-label={`查看 ${quote.name} ${quote.code}`} onClick={() => onStock(toSearchResult(quote))} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onStock(toSearchResult(quote)) } }}>
          <td><b>{quote.name}</b><small>{quote.code}</small></td>
          <WatchResearchCoverageCell
            quote={quote}
            coverage={coverageMap.get(quote.secId)}
            loading={coverageLoading && !coverageMap.has(quote.secId)}
            onJudgement={onJudgement}
            onCreateJudgement={onCreateJudgement}
          />
          <td className={styles[classForChange(quote.changePct)]}>{number(quote.price)}</td>
          <td className={styles[classForChange(quote.changePct)]}>{percent(quote.changePct)}</td>
          <td>{money(quote.amount)}</td><td>{ratio(quote.turnoverRate)}</td><td>{money(quote.marketCap)}</td>
          <td>{quote.pe !== null && quote.pe > 0 ? number(quote.pe, 1) : '—'}</td><td>{quote.pb !== null && quote.pb > 0 ? number(quote.pb) : '—'}</td>
          <WatchValuationCells quote={quote} valuation={valuationMap.get(quote.secId)} loading={valuationLoading && !valuationMap.has(quote.secId)} />
          <td title={dateTime(quote.addedAt)}>{dateOnly(quote.addedAt)}</td><td className={styles[classForChange(quote.sinceAddedPct)]}>{percent(quote.sinceAddedPct)}</td>
          <td><div className={styles['rowActions']}>{groups.length > 1 && displayedGroupId !== null && <button className={`${styles['button']} ${styles['buttonGhost']}`} onClick={event => { event.stopPropagation(); setMoveTarget({ quote, sourceGroupId: displayedGroupId }) }}>移动</button>}{displayedGroupId !== null && <button className={`${styles['button']} ${styles['buttonGhost']}`} onClick={event => { event.stopPropagation(); void client.call('watch.item.remove', { groupId: displayedGroupId, secId: quote.secId }).then(next => { changed(next); notify('已移出自选') }).catch(error => notify(messageOf(error), 'error')) }}>移除</button>}</div></td>
        </tr>)}</tbody>
      </table></div>}
      <div className={styles['tableFoot']}>
        <span><b>行情</b><DataSourceText meta={quoteMeta} /></span>
        <span><b>合理估值</b>{valuationMeta !== null ? <DataSourceText meta={valuationMeta} /> : <small className={styles['dataSource']}>{valuationLoading ? '价值大师网 · 整组加载中…' : valuationFailed ? '价值大师网 · 本次加载失败' : '价值大师网 · 暂无可用数据'}</small>}</span>
        <span><b>研究覆盖</b><small className={styles['dataSource']}>{coverageLoading ? '正在核对本地研判…' : coverageFailed ? '本次加载失败' : `本地报告 · 超过 ${staleAfterDays} 天提示复核`}</small></span>
      </div>
    </article>

    <WatchGroupManager client={client} open={managerOpen} groups={groups} onClose={() => setManagerOpen(false)} onChanged={changed} notify={notify} />
    {addTarget !== null && <WatchGroupDialog client={client} open groups={groups} stock={addTarget} mode="add" onClose={() => setAddTarget(null)} onGroups={(next) => { changed(next); setAddQuery(''); setAddResults([]) }} notify={notify} />}
    {moveTarget !== null && <WatchGroupDialog client={client} open groups={groups} stock={toSearchResult(moveTarget.quote)} mode="move" sourceGroupId={moveTarget.sourceGroupId} onClose={() => setMoveTarget(null)} onGroups={changed} notify={notify} />}
  </Page>
}

function WatchValuationCells({ quote, valuation, loading }: { quote: WatchQuote; valuation: WatchValuation | undefined; loading: boolean }) {
  if (loading) return <><td><i className={styles['cellSkeleton']} /></td><td><i className={styles['cellSkeleton']} /></td></>
  const fairValue = valuation?.fairValue ?? null
  const valueGap = fairValue !== null && quote.price !== null ? fairValue - quote.price : null
  const valueGapPct = valueGap !== null && quote.price !== null && quote.price > 0
    ? valueGap / quote.price * 100
    : null
  const valueClass = valueGap === null || valueGap === 0
    ? styles['flat']
    : valueGap > 0 ? styles['valuePositive'] : styles['valueNegative']
  return <>
    <td className={styles['valuationCell']} title={valuation?.meta?.sourceName ?? '价值大师网'}>
      {fairValue === null ? '—' : <><b>{number(fairValue)}</b><small>{valuationRank(valuation?.valuationRank ?? null)}</small></>}
    </td>
    <td className={`${styles['valuationCell']} ${valueClass}`}>
      {valueGap === null ? '—' : <><b>{percent(valueGapPct)}</b><small>{signedPriceGap(valueGap)}</small></>}
    </td>
  </>
}

function ResearchCoverageStrip({ summary, loading, failed, staleAfterDays, filter, onFilter }: {
  summary: ReturnType<typeof summarizeResearchCoverage>
  loading: boolean
  failed: boolean
  staleAfterDays: number
  filter: WatchCoverageFilter
  onFilter: (filter: WatchCoverageFilter) => void
}) {
  const unavailable = loading || failed
  return <section className={`${styles['card']} ${styles['coverageStrip']}`} aria-label="自选研究覆盖概览">
    <button aria-pressed={filter === 'all'} onClick={() => onFilter('all')}><span>研究覆盖</span><b>{loading ? '核对中…' : failed ? '暂不可用' : `${summary.covered}/${summary.total}`}</b><small>查看全部自选</small></button>
    <button aria-pressed={filter === 'current'} disabled={unavailable} onClick={() => onFilter('current')}><span className={styles['coverageDotCurrent']} /> <b>{summary.current}</b><small>当前有效</small></button>
    <button aria-pressed={filter === 'active'} disabled={unavailable} onClick={() => onFilter('active')}><span className={styles['coverageDotActive']} /> <b>{summary.active}</b><small>研判进行中</small></button>
    <button aria-pressed={filter === 'stale'} disabled={unavailable} onClick={() => onFilter('stale')}><span className={styles['coverageDotStale']} /> <b>{summary.stale}</b><small>超过 {staleAfterDays} 天</small></button>
    <button aria-pressed={filter === 'missing'} disabled={unavailable} onClick={() => onFilter('missing')}><span className={styles['coverageDotMissing']} /> <b>{summary.missing}</b><small>待研判或失败</small></button>
    <p>
      {summary.openFollowUps > 0 && <>持续跟踪 <b>{summary.openFollowUps}</b> 项{summary.overdueFollowUps > 0 && <>，其中 <em>{summary.overdueFollowUps} 项已逾期</em></>}。<button aria-pressed={filter === 'followups'} onClick={() => onFilter(filter === 'followups' ? 'all' : 'followups')}>{filter === 'followups' ? '查看全部' : '查看涉及公司'}</button></>}
      {summary.openFollowUps > 0 && summary.pendingPredictions > 0 && <span aria-hidden="true"> · </span>}
      {summary.pendingPredictions > 0 && <>待判定命题 <b>{summary.pendingPredictions}</b> 项{summary.duePredictions > 0 && <>，其中 <em>{summary.duePredictions} 项已到期</em></>}。<button aria-pressed={filter === 'predictions'} onClick={() => onFilter(filter === 'predictions' ? 'all' : 'predictions')}>{filter === 'predictions' ? '查看全部' : '查看命题公司'}</button></>}
      {summary.openFollowUps === 0 && summary.pendingPredictions === 0 && <>用“研究覆盖”识别需要补做或复核的公司；行情刷新不会改变本地研究状态。</>}
    </p>
  </section>
}

function WatchResearchCoverageCell({ quote, coverage, loading, onJudgement, onCreateJudgement }: {
  quote: WatchQuote
  coverage: WatchResearchCoverage | undefined
  loading: boolean
  onJudgement: (id: string) => void
  onCreateJudgement: (stock: SearchResult, masterId: string | null) => void
}) {
  if (loading) return <td><i className={styles['cellSkeleton']} /></td>
  const value = coverage ?? {
    secId: quote.secId,
    state: 'uncovered' as const,
    judgementId: null,
    masterId: null,
    masterName: null,
    latestReportAt: null,
    latestReportVersion: null,
    ageDays: null,
    reportVersionCount: 0,
    openFollowUpCount: 0,
    overdueFollowUpCount: 0,
    nextFollowUpDueDate: null,
    pendingPredictionCount: 0,
    duePredictionCount: 0,
    nextPredictionDueDate: null,
  }
  const label = {
    active: '研判中',
    current: '已覆盖',
    stale: '待复核',
    failed: '上次失败',
    uncovered: '待研判',
  }[value.state]
  const detail = value.state === 'active'
    ? value.masterName ?? '正在形成报告'
    : value.latestReportAt !== null
      ? `${value.ageDays ?? 0} 天前 · v${value.latestReportVersion ?? 1}`
      : value.masterName ?? '暂无正式报告'
  const followUpDetail = value.openFollowUpCount === 0
    ? ''
    : value.overdueFollowUpCount > 0
      ? ` · ${value.overdueFollowUpCount} 项逾期`
      : ` · ${value.openFollowUpCount} 项待验`
  const predictionDetail = value.pendingPredictionCount === 0
    ? ''
    : value.duePredictionCount > 0
      ? ` · ${value.duePredictionCount} 项命题到期`
      : ` · ${value.pendingPredictionCount} 项命题`
  const canOpen = value.judgementId !== null
  const shouldCreate = value.state === 'stale' || value.state === 'failed' || value.state === 'uncovered'
  return <td className={styles['coverageCell']}>
    <button
      className={`${styles['coverageStatus']} ${styles[`coverageStatus_${value.state}`]}`}
      disabled={!canOpen}
      onClick={(event) => {
        event.stopPropagation()
        if (value.judgementId !== null) onJudgement(value.judgementId)
      }}
      title={canOpen ? '查看最近研判' : '尚无研判可查看'}
    >
      <b>{label}</b><small>{detail}{followUpDetail}{predictionDetail}</small>
    </button>
    {shouldCreate && <button className={styles['coverageAction']} onClick={(event) => {
      event.stopPropagation()
      onCreateJudgement(toSearchResult(quote), value.masterId)
    }}>{value.state === 'uncovered' ? '开始' : '更新'}</button>}
  </td>
}

function WatchTableSkeleton({ rows }: { rows: number }) {
  return <div className={styles['watchSkeleton']} role="status" aria-label="正在加载自选行情">
    <div className={styles['watchSkeletonHead']}>{Array.from({ length: 14 }, (_, index) => <i key={index} />)}</div>
    {Array.from({ length: rows }, (_, row) => <div className={styles['watchSkeletonRow']} key={row}>{Array.from({ length: 14 }, (__, column) => <i key={column} />)}</div>)}
  </div>
}

function SortableHead({ label, column, sort, onSort }: { label: string; column: WatchSortKey; sort: { key: WatchSortKey; desc: boolean }; onSort: (key: WatchSortKey) => void }) {
  return <th aria-sort={sort.key === column ? sort.desc ? 'descending' : 'ascending' : 'none'}><button className={styles['sortButton']} onClick={() => onSort(column)}>{label} {sort.key === column ? sort.desc ? '↓' : '↑' : ''}</button></th>
}

function WatchGroupManager({ client, open, groups, onClose, onChanged, notify }: { client: HanaiClient; open: boolean; groups: WatchGroup[]; onClose: () => void; onChanged: (groups: WatchGroup[]) => void; notify: Notify }) {
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState('')
  const [editingName, setEditingName] = useState('')
  const [confirmingDeleteId, setConfirmingDeleteId] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setNewName(''); setEditingId(''); setConfirmingDeleteId('') } }, [open])
  if (!open) return null

  const run = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true)
    try {
      await operation()
      onChanged(await client.call('watch.list', {}))
      notify(success)
    } catch (error) { notify(messageOf(error), 'error') } finally { setBusy(false) }
  }

  return <Modal title="管理自选分组" subtitle="新建、重命名或删除分组；默认分组始终保留" onClose={onClose} wide>
    <form className={styles['newGroup']} onSubmit={(event) => { event.preventDefault(); const name = newName.trim(); if (name === '') return; void run(() => client.call('watch.group.create', { name }), '分组已创建').then(() => setNewName('')) }}>
      <input value={newName} onChange={event => setNewName(event.target.value)} maxLength={20} placeholder="新分组名称" />
      <button className={styles['buttonPrimary']} disabled={busy || newName.trim() === ''}>新建分组</button>
    </form>
    <div className={styles['groupManagerList']}>{groups.map(group => <div key={group.id} className={styles['groupManagerRow']}>
      {editingId === group.id ? <>
        <input autoFocus value={editingName} onChange={event => setEditingName(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setEditingId('') }} />
        <button className={styles['buttonPrimary']} disabled={busy || editingName.trim() === ''} onClick={() => void run(() => client.call('watch.group.rename', { id: group.id, name: editingName.trim() }), '分组已重命名').then(() => setEditingId(''))}>保存</button>
        <button className={styles['button']} onClick={() => setEditingId('')}>取消</button>
      </> : <>
        <span><b>{group.name}</b><small>{group.secIds.length} 只股票</small></span>
        {group.isDefault && <em>默认 · 不可删除</em>}
        <button className={`${styles['button']} ${styles['buttonGhost']}`} onClick={() => { setEditingId(group.id); setEditingName(group.name); setConfirmingDeleteId('') }}>重命名</button>
        {!group.isDefault && <button className={`${styles['button']} ${confirmingDeleteId === group.id ? styles['buttonDanger'] : styles['buttonGhost']}`} disabled={busy} onClick={() => {
          if (confirmingDeleteId !== group.id) { setConfirmingDeleteId(group.id); setEditingId(''); return }
          void run(() => client.call('watch.group.remove', { id: group.id }), '分组已删除').then(() => setConfirmingDeleteId(''))
        }}>{confirmingDeleteId === group.id ? group.secIds.length > 0 ? '确认删除并移至默认分组' : '确认删除' : '删除'}</button>}
      </>}
    </div>)}</div>
    <footer className={styles['modalFoot']}><span>删除非默认分组时，其中的自选会自动转入默认分组。</span><button className={styles['buttonPrimary']} onClick={onClose}>完成</button></footer>
  </Modal>
}

type WatchDialogMode = 'add' | 'move' | 'manage'

function WatchGroupDialog({ client, open, groups, stock, mode, sourceGroupId = '', onClose, onGroups, notify }: { client: HanaiClient; open: boolean; groups: WatchGroup[]; stock: SearchResult; mode: WatchDialogMode; sourceGroupId?: string; onClose: () => void; onGroups: (groups: WatchGroup[]) => void; notify: Notify }) {
  const [busyGroupId, setBusyGroupId] = useState('')
  if (!open) return null
  const title = mode === 'move' ? '移动到其他分组' : mode === 'manage' ? '管理自选分组' : '加入自选'
  const description = mode === 'move' ? '选择目标分组，原加入日期和加入价格会保留' : mode === 'manage' ? '可以同时加入多个分组，点击分组即可加入或移出' : '选择要加入的自选分组'
  const choose = async (group: WatchGroup) => {
    const member = group.secIds.includes(stock.secId)
    if (busyGroupId !== '' || (mode === 'move' && group.id === sourceGroupId) || (mode === 'add' && member)) return
    setBusyGroupId(group.id)
    try {
      const next = mode === 'move'
        ? await client.call('watch.item.move', { fromGroupId: sourceGroupId, toGroupId: group.id, secId: stock.secId })
        : mode === 'manage' && member
          ? await client.call('watch.item.remove', { groupId: group.id, secId: stock.secId })
          : await client.call('watch.item.add', { groupId: group.id, secId: stock.secId })
      onGroups(next)
      notify(mode === 'move' ? '已移动自选' : member ? '已移出分组' : '已加入自选')
      if (mode !== 'manage') onClose()
    } catch (error) { notify(messageOf(error), 'error') } finally { setBusyGroupId('') }
  }
  return <Modal title={title} subtitle={description} onClose={onClose}>
    <div className={styles['stockSummary']}><b>{stock.name}</b><span>{stock.code}</span><small>{stock.exchange}</small></div>
    <div className={styles['groupChoiceList']}>{groups.map(group => {
      const member = group.secIds.includes(stock.secId)
      const current = mode === 'move' && group.id === sourceGroupId
      return <button key={group.id} className={member ? styles['groupMember'] : ''} disabled={busyGroupId !== '' || current || (mode === 'add' && member)} onClick={() => void choose(group)}><span>{member ? '✓' : ''}</span><span><b>{group.name}</b><small>{group.secIds.length} 只股票</small></span>{group.isDefault && <em>默认</em>}<strong>{current ? '当前分组' : busyGroupId === group.id ? '处理中…' : mode === 'manage' ? member ? '移出' : '加入' : member ? '已加入' : '选择'}</strong></button>
    })}</div>
    {mode === 'manage' && <footer className={styles['modalFoot']}><span /><button className={styles['buttonPrimary']} onClick={onClose}>完成</button></footer>}
  </Modal>
}

type StockChart = 'trend' | 'daily' | 'weekly' | 'monthly'

function StockPage({ client, secId, theme, groups: bootstrapGroups, onGroups, onCreateJudgement, notify }: { client: HanaiClient; secId: string; theme: ThemeId; groups: WatchGroup[]; onGroups: (groups: WatchGroup[]) => void; onCreateJudgement: (stock: SearchResult) => void; notify: Notify }) {
  const [detailState, setDetailState] = useState<{ secId: string; detail: StockDetail } | null>(null)
  const [chart, setChart] = useState<StockChart>('daily')
  const [groups, setGroups] = useState(bootstrapGroups)
  const [watchDialogOpen, setWatchDialogOpen] = useState(false)
  const [followUps, setFollowUps] = useState<ResearchFollowUp[]>([])
  const [followUpsLoading, setFollowUpsLoading] = useState(true)
  const [followUpsOpen, setFollowUpsOpen] = useState(true)
  const [predictions, setPredictions] = useState<ResearchPrediction[]>([])
  const [predictionsLoading, setPredictionsLoading] = useState(true)
  const requestGeneration = useRef(0)
  const routeController = useRef<AbortController | null>(null)
  const activeSecId = useRef(secId)
  const loadedSurfaces = useRef<Set<StockChart>>(new Set())
  const detail = detailState?.secId === secId ? detailState.detail : null

  useEffect(() => setGroups(bootstrapGroups), [bootstrapGroups])
  useEffect(() => {
    const generation = ++requestGeneration.current
    activeSecId.current = secId
    routeController.current?.abort()
    const controller = new AbortController()
    routeController.current = controller
    loadedSurfaces.current = new Set()
    setChart('daily')
    setWatchDialogOpen(false)
    setFollowUps([])
    setFollowUpsLoading(true)
    setFollowUpsOpen(true)
    setPredictions([])
    setPredictionsLoading(true)
    setDetailState({ secId, detail: emptyStockDetail() })

    const active = () => !controller.signal.aborted
      && generation === requestGeneration.current
      && activeSecId.current === secId
    const update = (change: (current: StockDetail) => StockDetail) => {
      if (!active()) return
      setDetailState(current => current?.secId === secId
        ? { secId, detail: change(current.detail) }
        : current)
    }
    const failed = (surface: string, error: unknown) => {
      if (active()) notify(`${surface}加载失败：${messageOf(error)}`, 'error')
    }

    void client.call('security.search', { query: secId.slice(2) }, controller.signal)
      .then(results => {
        const security = results.find(item => item.secId === secId)
        if (security === undefined) return
        update(current => ({ ...current, security: {
          secId: security.secId,
          code: security.code,
          name: security.name,
          exchange: security.exchange,
          pinyinFull: security.pinyinFull,
          pinyinInitial: security.pinyinInitial,
        } }))
      })
      .catch(error => failed('证券信息', error))
    void client.call('security.quote', { secId }, controller.signal)
      .then(result => update(current => ({
        ...current,
        quote: result.quote,
        metrics: result.metrics,
        sources: { ...current.sources, ...result.sources },
      })))
      .catch(error => failed('行情', error))
    void client.call('security.kline', { secId, period: 'daily' }, controller.signal)
      .then(result => {
        if (!active()) return
        loadedSurfaces.current.add('daily')
        update(current => ({
          ...current,
          daily: result.bars,
          sources: { ...current.sources, daily: result.meta },
        }))
      })
      .catch(error => failed('日 K', error))
    void client.call('security.valuation', { secId }, controller.signal)
      .then(result => update(current => ({
        ...current,
        valuation: result.valuation,
        sources: { ...current.sources, valuation: result.meta },
      })))
      .catch(error => failed('估值', error))
    void client.call('watch.list', {}, controller.signal)
      .then(nextGroups => {
        if (!active()) return
        setGroups(nextGroups)
        onGroups(nextGroups)
      })
      .catch(error => failed('自选状态', error))
    void client.call('research.followup.list', { secId }, controller.signal)
      .then(items => {
        if (!active()) return
        setFollowUps(items)
      })
      .catch(error => failed('持续跟踪', error))
      .finally(() => { if (active()) setFollowUpsLoading(false) })
    void client.call('research.prediction.list', { secId }, controller.signal)
      .then(items => {
        if (!active()) return
        setPredictions(items)
      })
      .catch(error => failed('研究命题', error))
      .finally(() => { if (active()) setPredictionsLoading(false) })

    return () => {
      requestGeneration.current += 1
      controller.abort()
    }
  }, [client, notify, onGroups, secId])
  const detailReady = detail !== null
  useEffect(() => {
    if (!detailReady) return
    let active = true
    let inFlight = false
    let requestController: AbortController | null = null
    const refreshQuote = async () => {
      if (inFlight) return
      inFlight = true
      const controller = new AbortController()
      requestController = controller
      try {
        const result = await client.call('security.quote', { secId }, controller.signal)
        if (!active || activeSecId.current !== secId) return
        setDetailState(current => current?.secId !== secId ? current : { secId, detail: { ...current.detail, quote: result.quote, metrics: result.metrics, sources: { ...current.detail.sources, ...result.sources } } })
      } catch (error) {
        if (active && !controller.signal.aborted && activeSecId.current === secId) notify(messageOf(error), 'error')
      } finally {
        if (requestController === controller) requestController = null
        inFlight = false
      }
    }
    const timer = window.setInterval(() => void refreshQuote(), 15_000)
    return () => { active = false; requestController?.abort(); window.clearInterval(timer) }
  }, [client, detailReady, notify, secId])
  useEffect(() => {
    if (!detailReady || chart === 'daily') return
    let active = true
    let inFlight = false
    const controller = new AbortController()
    const refreshSurface = async () => {
      if (inFlight || (chart !== 'trend' && loadedSurfaces.current.has(chart))) return
      inFlight = true
      try {
        if (chart === 'trend') {
          const trendResult = await client.call('security.trend', { secId }, controller.signal)
          if (!active || activeSecId.current !== secId) return
          loadedSurfaces.current.add('trend')
          setDetailState(current => current?.secId !== secId ? current : { secId, detail: {
            ...current.detail,
            trend: trendResult.trend,
            trendPrevClose: trendResult.trendPrevClose,
            sources: { ...current.detail.sources, trend: trendResult.meta },
          } })
        } else {
          const result = await client.call('security.kline', { secId, period: chart }, controller.signal)
          if (!active || activeSecId.current !== secId) return
          loadedSurfaces.current.add(chart)
          setDetailState(current => current?.secId !== secId ? current : { secId, detail: {
            ...current.detail,
            [chart]: result.bars,
            sources: { ...current.detail.sources, [chart]: result.meta },
          } })
        }
      } catch (error) {
        if (active && !controller.signal.aborted && activeSecId.current === secId) notify(messageOf(error), 'error')
      } finally { inFlight = false }
    }
    void refreshSurface()
    if (chart !== 'trend') return () => { active = false; controller.abort() }
    const timer = window.setInterval(() => void refreshSurface(), 15_000)
    return () => { active = false; controller.abort(); window.clearInterval(timer) }
  }, [chart, client, detailReady, notify, secId])

  if (detail === null) return <Page><PageSkeleton cards={5} /></Page>

  const quote = detail.quote
  const metrics = detail.metrics
  const security = detail.security
  const name = security?.name ?? quote?.name ?? metrics?.name ?? secId
  const code = security?.code ?? quote?.code ?? metrics?.code ?? secId.slice(2)
  const stock: SearchResult = { secId, code, name, exchange: security?.exchange ?? exchangeFor(secId, code), pinyinFull: security?.pinyinFull ?? '', pinyinInitial: security?.pinyinInitial ?? '', price: quote?.price ?? metrics?.price ?? null, changePct: quote?.changePct ?? metrics?.changePct ?? null }
  const watched = groups.some(group => group.secIds.includes(secId))
  const palette = getChartPalette(theme)
  const chartOption = chart === 'trend'
    ? buildTrendOption(detail.trend, detail.trendPrevClose ?? quote?.prevClose ?? metrics?.prevClose ?? null, palette)
    : buildKlineOption(detail[chart], palette)
  const chartMeta = detail.sources[chart]
  const valuation = detail.valuation
  const deviation = valuation?.medps !== null && valuation?.medps !== undefined && valuation.medps > 0 && stock.price !== null
    ? (stock.price - valuation.medps) / valuation.medps * 100
    : null

  return <Page>
    <header className={styles['stockHeader']}>
      <div>
        <div className={styles['stockNameRow']}><h1>{name}</h1><span>{code}</span><em>{security?.exchange === 'SH' || secId.startsWith('1.') ? '上交所' : security?.exchange === 'BJ' ? '北交所' : '深交所'}</em>{metrics?.industry && <em>{metrics.industry}</em>}</div>
        <div className={styles['metaLine']}><DataStateBadge meta={detail.sources.quote} /><DataSourceText meta={detail.sources.quote} /></div>
      </div>
      <div className={`${styles['stockLast']} ${styles[classForChange(stock.changePct)]}`}><b>{number(stock.price)}</b><span>{signedNumber(quote?.change ?? metrics?.change ?? null)} / {percent(stock.changePct)}</span></div>
      <div className={styles['stockActions']}><button className={watched ? styles['button'] : styles['buttonPrimary']} onClick={() => setWatchDialogOpen(true)}>{watched ? '✓ 管理自选' : '☆ 加入自选'}</button><button className={styles['buttonPrimary']} onClick={() => onCreateJudgement(stock)}>发起大师研判</button></div>
    </header>

    <div className={styles['stockDetailGrid']}>
      <div className={styles['stockMainColumn']}>
        <article className={styles['card']}>
          <PanelHead title="价格走势" hint={`${chart === 'trend' ? '分时均价' : '东方财富 · 前复权'} · ${chartMeta?.sourceName ?? '来源未知'}`} extra={<div className={styles['buttonGroup']}>{([['trend', '分时'], ['daily', '日K'], ['weekly', '周K'], ['monthly', '月K']] as const).map(([id, label]) => <button key={id} className={chart === id ? styles['buttonSelected'] : styles['button']} onClick={() => setChart(id)}>{label}</button>)}</div>} />
          <div className={styles['priceChart']}>{chartOption === null ? <Empty compact title="图表数据加载中" detail="当前周期暂无可用数据。" /> : <EChart option={chartOption} ariaLabel={chart === 'trend' ? '分时价格图' : `${chart === 'daily' ? '日' : chart === 'weekly' ? '周' : '月'}K线图`} />}</div>
        </article>

        <article className={styles['card']}><PanelHead title="实时行情快照" /><div className={styles['stockMetricGrid']}>
          <Metric label="今开" value={number(quote?.open ?? metrics?.open ?? null)} />
          <Metric label="最高" value={number(quote?.high ?? metrics?.high ?? null)} tone="up" />
          <Metric label="最低" value={number(quote?.low ?? metrics?.low ?? null)} tone="down" />
          <Metric label="昨收" value={number(quote?.prevClose ?? metrics?.prevClose ?? null)} />
          <Metric label="均价" value={number(metrics?.averagePrice ?? null)} />
          <Metric label="振幅" value={ratio(metrics?.amplitude ?? null)} />
          <Metric label="总手" value={quantity(quote?.volume ?? metrics?.volume ?? null)} />
          <Metric label="成交额" value={money(quote?.amount ?? metrics?.amount ?? null)} />
          <Metric label="换手率" value={ratio(quote?.turnoverRate ?? metrics?.turnoverRate ?? null)} />
          <Metric label="量比" value={number(metrics?.volumeRatio ?? null)} />
          <Metric label="主力净流入" value={money(metrics?.mainNetInflow ?? null)} tone={(metrics?.mainNetInflow ?? 0) >= 0 ? 'up' : 'down'} />
          <Metric label="总市值" value={money(quote?.marketCap ?? metrics?.marketCap ?? null)} />
          <Metric label="流通市值" value={money(quote?.floatCap ?? metrics?.floatCap ?? null)} />
        </div></article>

        <article className={styles['card']}><PanelHead title="基本面（财报期数据）" hint="低频数据 · 与盘中价格时效不同" /><div className={styles['stockMetricGrid']}>
          {fundamentalMetrics(metrics).map(item => <Metric key={item.label} label={item.label} value={item.value} {...(item.tone === undefined ? {} : { tone: item.tone })} />)}
        </div></article>
      </div>

      <div className={styles['stockSideColumn']}>
        <article className={styles['card']}>
          <PanelHead title="价值判断" extra={valuation !== null && <span className={styles['tag']}>{valuationRank(valuation.valuationRank)}</span>} />
          {valuation === null ? <Empty compact title="估值数据暂不可用" detail="估值为日级数据，不影响行情与研判功能。" /> : <>
            <div className={styles['valuationSummary']}>
              <Metric label="大师价值" value={number(valuation.medps)} />
              <Metric label="现价偏离" value={percent(deviation)} {...(deviation === null ? {} : { tone: deviation > 0 ? 'up' as const : 'down' as const })} />
              <Metric label="GF 评分" value={valuation.gfScore === null ? '—' : `${number(valuation.gfScore, 0)}/100`} />
            </div>
            <div className={styles['radarChart']}><EChart option={buildRadarOption(valuation.dimensions, palette)} ariaLabel="估值五维雷达图" /></div>
            <div className={styles['metaLine']}><DataStateBadge meta={valuation.meta} liveCapable={false} /><DataSourceText meta={valuation.meta} /></div>
          </>}
        </article>
        <ResearchFollowUpPanel
          client={client}
          secId={secId}
          items={followUps}
          loading={followUpsLoading}
          open={followUpsOpen}
          onToggle={() => setFollowUpsOpen(current => !current)}
          onItems={setFollowUps}
          notify={notify}
          standalone
        />
        <ResearchPredictionPanel
          client={client}
          secId={secId}
          items={predictions}
          loading={predictionsLoading}
          onItems={setPredictions}
          notify={notify}
        />
        <article className={styles['card']}>
          <PanelHead title="价值曲线" />
          <div className={styles['valuationChart']}>{valuation === null || buildValuationOption(valuation, palette) === null ? <Empty compact title="暂无估值曲线" detail="供应商尚未返回价格与价值序列。" /> : <EChart option={buildValuationOption(valuation, palette)} ariaLabel="价格与大师价值曲线" />}</div>
          <p className={styles['chartNote']}>金线为大师价值线，蓝线为股价；红带为高估区（+10% / +30%），绿带为低估区（−10% / −30%）。价值线末端为供应商预测，非历史真实点。</p>
        </article>
      </div>
    </div>
    {watchDialogOpen && <WatchGroupDialog client={client} open groups={groups} stock={stock} mode="manage" onClose={() => setWatchDialogOpen(false)} onGroups={(next) => { setGroups(next); onGroups(next) }} notify={notify} />}
  </Page>
}

function JudgementsPage({ client, masters, judgements, launchRequest, onLaunchHandled, onJudgements, onOpen, onStock, notify }: { client: HanaiClient; masters: MasterPersona[]; judgements: Judgement[]; launchRequest: JudgementLaunchRequest | null; onLaunchHandled: () => void; onJudgements: (judgements: Judgement[]) => void; onOpen: (id: string) => void; onStock: (stock: Pick<SecurityMaster, 'secId'>) => void; notify: Notify }) {
  const [runs, setRuns] = useState(judgements)
  const [stockFilter, setStockFilter] = useState('')
  const [masterFilter, setMasterFilter] = useState('')
  const [qualityFilter, setQualityFilter] = useState<'all' | 'attention' | 'strong'>('all')
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [prefill, setPrefill] = useState<SearchResult | null>(null)
  const [prefillMasterId, setPrefillMasterId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Judgement | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [inboxItems, setInboxItems] = useState<ResearchInboxItem[]>([])
  const [inboxLoading, setInboxLoading] = useState(true)
  const [inboxFailed, setInboxFailed] = useState(false)
  const [inboxOpen, setInboxOpen] = useState(false)
  const [predictionInboxItems, setPredictionInboxItems] = useState<ResearchPredictionInboxItem[]>([])
  const [predictionInboxLoading, setPredictionInboxLoading] = useState(true)
  const [predictionInboxFailed, setPredictionInboxFailed] = useState(false)
  const [predictionInboxOpen, setPredictionInboxOpen] = useState(false)
  const [qualityItems, setQualityItems] = useState<ResearchQualityItem[]>([])
  const [qualityLoading, setQualityLoading] = useState(true)
  const [comparisonOpen, setComparisonOpen] = useState(false)
  useEffect(() => setRuns(judgements), [judgements])
  useEffect(() => {
    if (launchRequest === null) return
    setPrefill(launchRequest.stock)
    setPrefillMasterId(launchRequest.masterId)
    setLauncherOpen(true)
    onLaunchHandled()
  }, [launchRequest, onLaunchHandled])
  const load = useCallback(async () => {
    try {
      const next = await client.call('judgement.list', {})
      setRuns(next)
      onJudgements(next)
    } catch (error) { notify(messageOf(error), 'error') }
  }, [client, notify, onJudgements])
  const loadInbox = useCallback(async () => {
    setInboxLoading(true)
    setInboxFailed(false)
    try {
      const result = await client.call('research.inbox', { status: 'all' })
      setInboxItems(result.items)
      const today = localDateKey(new Date())
      if (result.items.some(item => item.status === 'open' && item.dueDate !== null && item.dueDate < today)) {
        setInboxOpen(true)
      }
    } catch (error) {
      setInboxFailed(true)
      notify(messageOf(error), 'error')
    } finally {
      setInboxLoading(false)
    }
  }, [client, notify])
  useEffect(() => { void loadInbox() }, [loadInbox])
  const loadPredictionInbox = useCallback(async () => {
    setPredictionInboxLoading(true)
    setPredictionInboxFailed(false)
    try {
      const result = await client.call('research.prediction.inbox', { status: 'all' })
      setPredictionInboxItems(result.items)
      const today = localDateKey(new Date())
      if (result.items.some(item => item.outcome === 'pending' && item.dueDate <= today)) {
        setPredictionInboxOpen(true)
      }
    } catch (error) {
      setPredictionInboxFailed(true)
      notify(messageOf(error), 'error')
    } finally {
      setPredictionInboxLoading(false)
    }
  }, [client, notify])
  useEffect(() => { void loadPredictionInbox() }, [loadPredictionInbox])
  const loadQuality = useCallback(async () => {
    setQualityLoading(true)
    try {
      const result = await client.call('research.quality', {})
      setQualityItems(result.items)
    } catch (error) {
      notify(messageOf(error), 'error')
    } finally {
      setQualityLoading(false)
    }
  }, [client, notify])
  const qualityKey = runs.map(run => `${run.id}:${run.latestReportVersion ?? 0}`).join('|')
  useEffect(() => { void loadQuality() }, [loadQuality, qualityKey])
  useEffect(() => {
    if (!runs.some(run => isReportInFlight(run.reportStatus))) return
    const timer = window.setInterval(() => void load(), 4000)
    return () => window.clearInterval(timer)
  }, [load, runs])
  const qualityByJudgement = new Map(qualityItems.map(item => [item.judgementId, item]))
  const filtered = runs.filter(run => {
    const stock = stockFilter.trim().toLowerCase()
    const quality = qualityByJudgement.get(run.id)
    const matchesQuality = qualityFilter === 'all'
      || (qualityFilter === 'strong' && quality?.rating === 'strong' && quality.incompleteChecks.length === 0)
      || (qualityFilter === 'attention' && quality !== undefined
        && (quality.rating !== 'strong' || quality.incompleteChecks.length > 0))
    return (stock === '' || `${run.stockName} ${run.code}`.toLowerCase().includes(stock))
      && (masterFilter === '' || run.masterId === masterFilter)
      && matchesQuality
  })
  const attentionCount = qualityItems.filter(item => item.rating !== 'strong' || item.incompleteChecks.length > 0).length
  const comparisonGroups = useMemo(() => {
    const bySecurity = new Map<string, Judgement[]>()
    for (const run of runs) {
      if (run.latestReportVersion === null) continue
      const entries = bySecurity.get(run.secId) ?? []
      entries.push(run)
      bySecurity.set(run.secId, entries)
    }
    return [...bySecurity.entries()].flatMap(([secId, entries]) => entries.length < 2 ? [] : [{
      secId,
      code: entries[0]?.code ?? secId.replace(/^[01]\./, ''),
      stockName: entries[0]?.stockName ?? secId,
      count: entries.length,
    }])
  }, [runs])
  const remove = async () => {
    if (deleteTarget === null || deleting) return
    setDeleting(true)
    try {
      const next = await client.call('judgement.remove', { id: deleteTarget.id })
      setRuns(next)
      onJudgements(next)
      await loadInbox()
      await loadPredictionInbox()
      setDeleteTarget(null)
      notify('研判报告已删除')
    } catch (error) {
      notify(messageOf(error), 'error')
    } finally {
      setDeleting(false)
    }
  }
  return <Page>
    <PageHeader title="大师研判" description="由一位专家独立检索并核验公开资料，形成完整投资研判报告" action={<>{comparisonGroups.length > 0 && <button className={styles['button']} onClick={() => setComparisonOpen(true)}>⇄ 同股异见{comparisonGroups.length > 1 ? `（${comparisonGroups.length}）` : ''}</button>}<button className={styles['buttonPrimary']} onClick={() => { setPrefill(null); setPrefillMasterId(null); setLauncherOpen(true) }}>＋ 新建研判</button></>} />
    <ResearchInboxPanel
      client={client}
      items={inboxItems}
      loading={inboxLoading}
      failed={inboxFailed}
      open={inboxOpen}
      onOpenChange={setInboxOpen}
      onItems={setInboxItems}
      onRefresh={loadInbox}
      onStock={onStock}
      onReport={onOpen}
      notify={notify}
    />
    <ResearchPredictionInboxPanel
      client={client}
      items={predictionInboxItems}
      loading={predictionInboxLoading}
      failed={predictionInboxFailed}
      open={predictionInboxOpen}
      onOpenChange={setPredictionInboxOpen}
      onItems={setPredictionInboxItems}
      onRefresh={loadPredictionInbox}
      onStock={onStock}
      notify={notify}
    />
    <div className={`${styles['card']} ${styles['judgementToolbar']}`}><input value={stockFilter} onChange={event => setStockFilter(event.target.value)} placeholder="筛选股票名或代码" /><select value={masterFilter} onChange={event => setMasterFilter(event.target.value)}><option value="">全部分析人</option>{masters.map(master => <option key={master.id} value={master.id}>{master.name}</option>)}</select><select aria-label="筛选报告质量" value={qualityFilter} onChange={event => setQualityFilter(event.target.value as typeof qualityFilter)}><option value="all">全部质量</option><option value="attention">需要复核{attentionCount > 0 ? `（${attentionCount}）` : ''}</option><option value="strong">结构完整</option></select><span>{filtered.length} 份研判归档{qualityLoading ? ' · 质检中' : ''}</span></div>
    {filtered.length > 0 ? <div className={styles['judgementGrid']}>{filtered.map(run => <article key={run.id} className={`${styles['card']} ${styles['judgementCard']}`}>
      <button className={styles['judgementCardOpen']} onClick={() => onOpen(run.id)} aria-label={`打开 ${run.stockName} ${run.masterName} 的研判`}>
        <div className={styles['judgementTop']}><strong>{run.stockName}</strong><span>{run.code}</span><Status status={run.reportStatus} /></div>
        <div className={styles['judgementAnalyst']}><span>{masters.find(master => master.id === run.masterId)?.shortName ?? run.masterName.slice(0, 1)}</span><span><small>分析人</small><b>{run.masterName}</b></span></div>
        <div className={styles['judgementMeta']}><span><small>分析日期</small>{dateTime(run.createdAt)}</span><span><small>模型</small>{run.model ?? '默认模型'}</span></div>
        {run.reportStatus === 'ready' && <ReportQualityBadge item={qualityByJudgement.get(run.id) ?? null} loading={qualityLoading} />}
        {run.errorMessage !== null && <div className={styles['judgementError']}>{run.errorMessage}</div>}
        <div className={styles['openLabel']}>{run.reportStatus === 'ready' ? '查看报告' : '查看执行过程'} →</div>
      </button>
      <button className={styles['judgementDelete']} disabled={isReportInFlight(run.reportStatus)} title={isReportInFlight(run.reportStatus) ? '进行中的研判暂不能删除' : '删除该研判报告'} aria-label={`删除${run.reportStatus === 'ready' ? '已完成' : run.reportStatus === 'failed' ? '未完成' : '进行中'}研判：${run.stockName} · ${run.masterName}`} onClick={() => setDeleteTarget(run)}>删除</button>
    </article>)}</div> : <Empty title={runs.length > 0 ? '没有符合筛选条件的报告' : '还没有大师研判'} detail={runs.length > 0 ? '调整股票或分析人筛选条件。' : '选择一只股票和一位专家，创建第一份研判。'} action={runs.length === 0 ? <button className={styles['buttonPrimary']} onClick={() => setLauncherOpen(true)}>创建第一份研判</button> : undefined} />}
    {launcherOpen && <JudgementLauncher client={client} masters={masters} prefill={prefill} initialMasterId={prefillMasterId} onClose={() => setLauncherOpen(false)} onCreated={async judgement => { setLauncherOpen(false); await load(); notify('大师已接收研判任务'); onOpen(judgement.id) }} notify={notify} />}
    {comparisonOpen && <ResearchComparisonModal client={client} groups={comparisonGroups} onClose={() => setComparisonOpen(false)} onOpenReport={(id) => { setComparisonOpen(false); onOpen(id) }} notify={notify} />}
    {deleteTarget !== null && <Modal title="删除研判报告" subtitle="此操作不可撤销" onClose={() => { if (!deleting) setDeleteTarget(null) }}>
      <section className={styles['deleteConfirm']}><span aria-hidden="true">!</span><div><b>确认删除 {deleteTarget.stockName} 的这份研判？</b><p>将永久删除该研判的全部报告版本和本地工作文件，并归档与 {deleteTarget.masterName} 的对应会话。</p><dl><div><dt>股票</dt><dd>{deleteTarget.stockName} {deleteTarget.code}</dd></div><div><dt>分析人</dt><dd>{deleteTarget.masterName}</dd></div><div><dt>创建时间</dt><dd>{dateTime(deleteTarget.createdAt)}</dd></div></dl></div></section>
      <footer className={styles['modalFoot']}><span>删除后无法从 Hanai Worth 恢复</span><div className={styles['confirmActions']}><button className={styles['button']} disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</button><button className={styles['buttonDanger']} disabled={deleting} onClick={() => void remove()}>{deleting ? '正在删除…' : '确认删除'}</button></div></footer>
    </Modal>}
  </Page>
}

function ResearchComparisonModal({ client, groups, onClose, onOpenReport, notify }: {
  client: HanaiClient
  groups: Array<{ secId: string; code: string; stockName: string; count: number }>
  onClose: () => void
  onOpenReport: (id: string) => void
  notify: Notify
}) {
  const [secId, setSecId] = useState(groups[0]?.secId ?? '')
  const [comparison, setComparison] = useState<ResearchComparison | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (secId === '') return
    const controller = new AbortController()
    setLoading(true)
    setFailed(false)
    void client.call('research.compare', { secId }, controller.signal)
      .then(setComparison)
      .catch(error => {
        if (controller.signal.aborted) return
        setFailed(true)
        notify(messageOf(error), 'error')
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [client, notify, secId])
  const auditable = comparison?.reports.filter(report => report.audit !== null) ?? []
  const commonDomains = auditable.length < 2 ? [] : [...new Set(auditable[0]?.audit?.sources.map(source => source.domain) ?? [])]
    .filter(domain => auditable.every(report => report.audit?.sources.some(source => source.domain === domain)))
  return <Modal title="同股异见" subtitle="并排核对不同大师使用了什么证据、遗漏了什么；不把风格差异包装成虚假共识" onClose={onClose} extraWide>
    <section className={styles['comparisonBody']}>
      {groups.length > 1 && <div className={styles['comparisonTabs']}>{groups.map(group => <button key={group.secId} aria-pressed={group.secId === secId} onClick={() => setSecId(group.secId)}>{group.stockName}<small>{group.code} · {group.count} 份</small></button>)}</div>}
      {loading ? <div className={styles['comparisonLoading']}>正在读取最新报告与证据账本…</div> : failed || comparison === null ? <div className={styles['comparisonLoading']}>对比暂时不可用，请稍后重试。</div> : <>
        <header className={styles['comparisonHeader']}><div><b>{comparison.stockName}</b><span>{comparison.code} · {comparison.reports.length} 份独立研判</span></div><div><span>共同来源域名</span>{commonDomains.length === 0 ? <small>暂未识别到共同来源</small> : <p>{commonDomains.map(domain => <em key={domain}>{domain}</em>)}</p>}</div></header>
        {comparison.reports.length < 2 ? <div className={styles['comparisonLoading']}>当前不足两份可对比报告。</div> : <div className={styles['comparisonGrid']}>{comparison.reports.map(report => {
          const audit = report.audit
          const kinds = audit === null ? null : {
            fact: audit.evidence.filter(item => item.kind === 'fact').length,
            inference: audit.evidence.filter(item => item.kind === 'inference').length,
            assumption: audit.evidence.filter(item => item.kind === 'assumption').length,
            unknown: audit.evidence.filter(item => item.kind === 'unknown').length,
          }
          const incomplete = audit?.checks.filter(check => check.state !== 'met') ?? []
          return <article key={report.judgementId} className={styles['comparisonCard']}>
            <header><div><b>{report.masterName}</b><small>报告 v{report.reportVersion} · {report.sealedAt === null ? '时间未知' : dateTime(report.sealedAt)}</small></div>{audit === null ? <span data-rating="unavailable">不可检查</span> : <span data-rating={audit.rating}>{audit.score}<small>/100</small></span>}</header>
            {audit === null ? <div className={styles['comparisonUnavailable']}>{report.error ?? '报告内容不可读取'}</div> : <>
              <dl className={styles['comparisonMetrics']}><div><dt>来源</dt><dd>{audit.sources.length}</dd></div><div><dt>证据主张</dt><dd>{audit.evidence.length}</dd></div><div><dt>待补项</dt><dd>{incomplete.length}</dd></div></dl>
              <div className={styles['comparisonBoundaries']}><span>证据边界</span><p><em data-kind="fact">事实 {kinds?.fact ?? 0}</em><em data-kind="inference">推断 {kinds?.inference ?? 0}</em><em data-kind="assumption">假设 {kinds?.assumption ?? 0}</em><em data-kind="unknown">待核验 {kinds?.unknown ?? 0}</em></p></div>
              <div className={styles['comparisonSection']}><span>仍需复核</span>{incomplete.length === 0 ? <small>7 项结构检查均覆盖</small> : <p>{incomplete.map(check => <em key={check.id} data-state={check.state}>{check.label}</em>)}</p>}</div>
              <div className={styles['comparisonSection']}><span>来源覆盖</span>{audit.sources.length === 0 ? <small>未识别到公开链接</small> : <p>{[...new Set(audit.sources.map(source => source.domain))].slice(0, 6).map(domain => <em key={domain}>{domain}</em>)}</p>}</div>
              <div className={styles['comparisonClaims']}><span>关键主张</span>{audit.evidence.length === 0 ? <small>该版本尚无可解析的结构化证据账本</small> : <ul>{audit.evidence.slice(0, 3).map((item, index) => <li key={`${item.claim}:${index}`}><i data-kind={item.kind} />{item.claim}</li>)}</ul>}</div>
            </>}
            <button className={styles['button']} onClick={() => onOpenReport(report.judgementId)}>查看这份报告</button>
          </article>
        })}</div>}
      </>}
    </section>
  </Modal>
}

function ReportQualityBadge({ item, loading }: { item: ResearchQualityItem | null; loading: boolean }) {
  if (item === null) return <div className={styles['judgementQuality']} data-rating="unavailable">{loading ? '正在检查报告结构…' : '尚无质量检查结果'}</div>
  if (item.rating === 'unavailable') return <div className={styles['judgementQuality']} data-rating="unavailable" title={item.error ?? undefined}>报告暂不可检查</div>
  const incomplete = item.incompleteChecks.length
  const detail = incomplete === 0
    ? `${item.sourceCount} 个来源 · ${item.evidenceCount} 条证据主张`
    : `待补 ${incomplete} 项：${item.incompleteChecks.map(check => check.label).join('、')}`
  return <div className={styles['judgementQuality']} data-rating={item.rating} title={detail}><b>结构 {item.score}</b><span>{detail}</span></div>
}

function ResearchInboxPanel({ client, items, loading, failed, open, onOpenChange, onItems, onRefresh, onStock, onReport, notify }: {
  client: HanaiClient
  items: ResearchInboxItem[]
  loading: boolean
  failed: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onItems: (items: ResearchInboxItem[]) => void
  onRefresh: () => Promise<void>
  onStock: (stock: Pick<SecurityMaster, 'secId'>) => void
  onReport: (id: string) => void
  notify: Notify
}) {
  const [showDone, setShowDone] = useState(false)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const today = localDateKey(new Date())
  const openItems = items.filter(item => item.status === 'open')
  const overdue = openItems.filter(item => item.dueDate !== null && item.dueDate < today).length
  const dueToday = openItems.filter(item => item.dueDate === today).length
  const visible = showDone ? items : openItems
  const nextDue = openItems.find(item => item.dueDate !== null)?.dueDate ?? null
  const summary = loading
    ? '正在汇总跨报告任务…'
    : failed
      ? '待办暂时无法读取'
      : openItems.length === 0
        ? '暂无未完成任务'
        : `${openItems.length} 项未完成${overdue > 0 ? ` · ${overdue} 项逾期` : dueToday > 0 ? ` · ${dueToday} 项今日到期` : nextDue === null ? '' : ` · 最近 ${nextDue}`}`
  const toggle = async (item: ResearchInboxItem) => {
    if (updatingId !== null) return
    setUpdatingId(item.id)
    try {
      const updated = await client.call('research.followup.update', {
        id: item.id,
        completed: item.status === 'open',
      })
      onItems(sortResearchFollowUps(items.map(current => current.id === updated.id
        ? { ...current, ...updated }
        : current)))
      notify(updated.status === 'done' ? '跟踪事项已完成' : '跟踪事项已重新打开')
    } catch (error) {
      notify(messageOf(error), 'error')
    } finally {
      setUpdatingId(null)
    }
  }
  const saveEdit = async (item: ResearchInboxItem, title: string, dueDate: string) => {
    if (updatingId !== null) return
    setUpdatingId(item.id)
    try {
      const updated = await client.call('research.followup.update', {
        id: item.id,
        title,
        dueDate: dueDate === '' ? null : dueDate,
      })
      onItems(sortResearchFollowUps(items.map(current => current.id === updated.id
        ? { ...current, ...updated }
        : current)))
      setEditingId(null)
      notify('研究待办已更新')
    } catch (error) {
      notify(messageOf(error), 'error')
    } finally {
      setUpdatingId(null)
    }
  }
  return <section className={`${styles['card']} ${styles['researchInbox']}`} data-open={open}>
    <div className={styles['researchInboxHead']}>
      <button aria-expanded={open} onClick={() => onOpenChange(!open)}>
        <span aria-hidden="true">✓</span>
        <span><b>研究待办</b><small>{summary}</small></span>
        <span aria-hidden="true">{open ? '收起' : '展开'}⌄</span>
      </button>
      <button className={styles['button']} disabled={loading} onClick={() => void onRefresh()}>{loading ? '刷新中…' : '↻ 刷新'}</button>
    </div>
    {open && <div className={styles['researchInboxBody']}>
      <div className={styles['researchInboxToolbar']}>
        <p>把各份报告的“待持续验证”集中在这里；即使来源报告删除，任务仍会保留。</p>
        <div><button aria-pressed={!showDone} onClick={() => setShowDone(false)}>未完成 {openItems.length}</button><button aria-pressed={showDone} onClick={() => setShowDone(true)}>全部 {items.length}</button></div>
      </div>
      {visible.length === 0
        ? <div className={styles['researchInboxEmpty']}>{failed ? '读取失败，请刷新重试。' : showDone ? '还没有研究待办。可从报告或个股页添加。' : '当前没有未完成任务。'}</div>
        : <ul className={styles['researchInboxList']}>{visible.map(item => {
          const overdueItem = item.status === 'open' && item.dueDate !== null && item.dueDate < today
          const dueLabel = item.dueDate === null ? '未设期限' : item.dueDate === today ? '今日到期' : overdueItem ? `逾期 · ${item.dueDate}` : `截止 ${item.dueDate}`
          const editing = editingId === item.id
          return <li key={item.id} data-completed={item.status === 'done'} data-overdue={overdueItem} data-editing={editing}>
            <button className={styles['followUpCheck']} aria-pressed={item.status === 'done'} disabled={updatingId !== null} aria-label={item.status === 'open' ? `标记完成：${item.title}` : `重新打开：${item.title}`} onClick={() => void toggle(item)}>{item.status === 'done' ? '✓' : ''}</button>
            <button className={styles['researchInboxStock']} aria-label={`打开股票：${item.stockName} ${item.code}`} onClick={() => onStock(item)}><b>{item.stockName}</b><small>{item.code}</small></button>
            {editing
              ? <FollowUpInlineEditor item={item} saving={updatingId === item.id} onSave={(title, dueDate) => void saveEdit(item, title, dueDate)} onCancel={() => setEditingId(null)} />
              : <><span className={styles['researchInboxTask']}><b>{item.title}</b><small data-overdue={overdueItem}>{dueLabel}</small></span>
                <span className={styles['researchInboxSource']}><span>{item.reportAvailable && item.judgementId !== null
                  ? <button aria-label={`打开来源报告：${item.stockName} v${item.reportVersion ?? ''}`} onClick={() => onReport(item.judgementId as string)}>报告 v{item.reportVersion}</button>
                  : <small>{item.reportVersion === null ? '手动添加' : '来源报告已删除'}</small>}<button className={styles['researchInboxEdit']} disabled={updatingId !== null} aria-label={`编辑待办：${item.title}`} onClick={() => setEditingId(item.id)}>编辑</button></span>{item.masterName !== null && <em>{item.masterName}</em>}</span></>}
          </li>
        })}</ul>}
    </div>}
  </section>
}

function ResearchPredictionInboxPanel({ client, items, loading, failed, open, onOpenChange, onItems, onRefresh, onStock, notify }: {
  client: HanaiClient
  items: ResearchPredictionInboxItem[]
  loading: boolean
  failed: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onItems: (items: ResearchPredictionInboxItem[]) => void
  onRefresh: () => Promise<void>
  onStock: (stock: Pick<SecurityMaster, 'secId'>) => void
  notify: Notify
}) {
  const [showResolved, setShowResolved] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [confirming, setConfirming] = useState<{ id: string; outcome: 'occurred' | 'not-occurred' | 'invalid' } | null>(null)
  const today = localDateKey(new Date())
  const pending = items.filter(item => item.outcome === 'pending')
  const due = pending.filter(item => item.dueDate <= today)
  const scored = items.filter(item => item.brierScore !== null)
  const meanBrier = scored.length === 0
    ? null
    : scored.reduce((total, item) => total + (item.brierScore ?? 0), 0) / scored.length
  const visible = showResolved ? items : pending
  const summary = loading
    ? '正在汇总跨公司命题…'
    : failed
      ? '命题复盘暂时无法读取'
      : pending.length === 0
        ? scored.length === 0 ? '暂无待复盘命题' : `暂无待复盘命题 · 平均 Brier ${meanBrier?.toFixed(4)}`
        : `${pending.length} 项待判定${due.length > 0 ? ` · ${due.length} 项已到期` : ''}${meanBrier === null ? '' : ` · 平均 Brier ${meanBrier.toFixed(4)}`}`

  const resolve = async (item: ResearchPredictionInboxItem, outcome: 'occurred' | 'not-occurred' | 'invalid') => {
    if (confirming?.id !== item.id || confirming.outcome !== outcome) {
      setConfirming({ id: item.id, outcome })
      return
    }
    if (busyId !== '') return
    setBusyId(item.id)
    try {
      const updated = await client.call('research.prediction.resolve', { id: item.id, outcome })
      onItems(sortResearchPredictions(items.map(current => current.id === updated.id
        ? { ...current, ...updated }
        : current)))
      setConfirming(null)
      notify(outcome === 'invalid' ? '命题已标记为无法判定' : '结果已记录并完成校准')
    } catch (error) {
      notify(messageOf(error), 'error')
    } finally {
      setBusyId('')
    }
  }

  return <section className={`${styles['card']} ${styles['researchInbox']} ${styles['predictionInbox']}`} data-open={open}>
    <div className={styles['researchInboxHead']}>
      <button aria-expanded={open} onClick={() => onOpenChange(!open)}>
        <span aria-hidden="true">◷</span>
        <span><b>命题复盘</b><small>{summary}</small></span>
        <span aria-hidden="true">{open ? '收起' : '展开'}⌄</span>
      </button>
      <button className={styles['button']} disabled={loading} onClick={() => void onRefresh()}>{loading ? '刷新中…' : '↻ 刷新'}</button>
    </div>
    {open && <div className={styles['researchInboxBody']}>
      <div className={styles['researchInboxToolbar']}>
        <p>集中复核到期命题。结果一经确认不会被覆盖；“无法判定”不进入 Brier 均值。</p>
        <div><button aria-pressed={!showResolved} onClick={() => setShowResolved(false)}>待复盘 {pending.length}</button><button aria-pressed={showResolved} onClick={() => setShowResolved(true)}>全部 {items.length}</button></div>
      </div>
      {visible.length === 0
        ? <div className={styles['researchInboxEmpty']}>{failed ? '读取失败，请刷新重试。' : showResolved ? '还没有研究命题。可从个股页建立。' : '当前没有待复盘命题。'}</div>
        : <ul className={styles['predictionInboxList']}>{visible.map(item => {
          const pendingItem = item.outcome === 'pending'
          const overdue = pendingItem && item.dueDate <= today
          return <li key={item.id} data-outcome={item.outcome} data-overdue={overdue}>
            <button className={styles['researchInboxStock']} aria-label={`打开股票：${item.stockName} ${item.code}`} onClick={() => onStock(item)}><b>{item.stockName}</b><small>{item.code}</small></button>
            <span className={styles['predictionInboxProbability']}><b>{item.probabilityPct}%</b><small>{pendingItem ? overdue ? '已到期' : item.dueDate : predictionOutcomeLabel(item.outcome)}</small></span>
            <span className={styles['predictionInboxClaim']}><b>{item.statement}</b><small title={item.resolutionCriteria}>口径：{item.resolutionCriteria}</small></span>
            {pendingItem
              ? <span className={styles['predictionInboxActions']}><button disabled={busyId !== ''} aria-label={`${confirming?.id === item.id && confirming.outcome === 'occurred' ? '确认命题发生' : '命题发生'}：${item.statement}`} onClick={() => void resolve(item, 'occurred')}>{confirming?.id === item.id && confirming.outcome === 'occurred' ? '确认发生' : '发生'}</button><button disabled={busyId !== ''} aria-label={`${confirming?.id === item.id && confirming.outcome === 'not-occurred' ? '确认命题未发生' : '命题未发生'}：${item.statement}`} onClick={() => void resolve(item, 'not-occurred')}>{confirming?.id === item.id && confirming.outcome === 'not-occurred' ? '确认未发生' : '未发生'}</button><button disabled={busyId !== ''} aria-label={`${confirming?.id === item.id && confirming.outcome === 'invalid' ? '确认命题无法判定' : '命题无法判定'}：${item.statement}`} onClick={() => void resolve(item, 'invalid')}>{confirming?.id === item.id && confirming.outcome === 'invalid' ? '确认无效' : '无法判定'}</button></span>
              : <span className={styles['predictionInboxResult']}><b>{predictionOutcomeLabel(item.outcome)}</b>{item.brierScore !== null && <small>Brier {item.brierScore.toFixed(4)}</small>}</span>}
          </li>
        })}</ul>}
    </div>}
  </section>
}

function FollowUpInlineEditor({ item, saving, onSave, onCancel }: {
  item: ResearchFollowUp
  saving: boolean
  onSave: (title: string, dueDate: string) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState(item.title)
  const [dueDate, setDueDate] = useState(item.dueDate ?? '')
  const normalizedTitle = title.trim()
  return <form className={styles['followUpEditor']} aria-label={`编辑跟踪事项：${item.title}`} onSubmit={(event) => {
    event.preventDefault()
    if (normalizedTitle !== '' && !saving) onSave(normalizedTitle, dueDate)
  }}>
    <input value={title} onChange={event => setTitle(event.target.value)} maxLength={160} aria-label="事项内容" autoFocus />
    <input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} aria-label="事项到期日" />
    <button className={styles['buttonPrimary']} disabled={saving || normalizedTitle === ''}>{saving ? '保存中…' : '保存'}</button>
    <button type="button" className={styles['button']} disabled={saving} onClick={onCancel}>取消</button>
  </form>
}

function JudgementLauncher({ client, masters, prefill, initialMasterId, onClose, onCreated, notify }: { client: HanaiClient; masters: MasterPersona[]; prefill: SearchResult | null; initialMasterId: string | null; onClose: () => void; onCreated: (judgement: Judgement) => Promise<void>; notify: Notify }) {
  const [selectedStock, setSelectedStock] = useState<SearchResult | null>(prefill)
  const [query, setQuery] = useState(prefill === null ? '' : `${prefill.name} ${prefill.code}`)
  const [results, setResults] = useState<SearchResult[]>([])
  const [masterId, setMasterId] = useState(initialMasterId ?? masters[0]?.id ?? '')
  const [searching, setSearching] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  useEffect(() => {
    if (selectedStock !== null || query.trim() === '') { setResults([]); return }
    const controller = new AbortController()
    setSearching(true)
    const timer = window.setTimeout(() => {
      void client.call('security.search', { query: query.trim() }, controller.signal)
        .then(next => setResults(next.slice(0, 8)))
        .catch(error => { if (!controller.signal.aborted) notify(messageOf(error), 'error') })
        .finally(() => { if (!controller.signal.aborted) setSearching(false) })
    }, 180)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [client, notify, query, selectedStock])
  const submit = async () => {
    if (selectedStock === null) { notify('请先选择一只股票', 'error'); return }
    if (masterId === '') { notify('请选择一位分析专家', 'error'); return }
    setSubmitting(true)
    try { await onCreated(await client.call('judgement.create', { secId: selectedStock.secId, masterId })) }
    catch (error) { notify(messageOf(error), 'error') } finally { setSubmitting(false) }
  }
  return <Modal title="新建大师研判" subtitle="单专家独立执行；完成后形成报告，并可在同一会话中继续追问" onClose={onClose} wide>
    <section className={styles['launcherSection']}><label>研判标的</label><div className={styles['launcherSearch']}><input value={query} disabled={prefill !== null} onChange={event => { setQuery(event.target.value); setSelectedStock(null) }} placeholder="输入股票代码、名称或拼音" />{searching && <span>检索中…</span>}{results.length > 0 && <div>{results.map(stock => <button key={stock.secId} onClick={() => { setSelectedStock(stock); setQuery(`${stock.name} ${stock.code}`); setResults([]) }}><span><b>{stock.name}</b> {stock.code}</span><span>{stock.exchange}</span></button>)}</div>}</div>{selectedStock !== null && <div className={styles['selectedStock']}><span>✓</span><b>{selectedStock.name}</b><span>{selectedStock.code}</span><small>{selectedStock.exchange}</small></div>}</section>
    <section className={styles['launcherSection']}><label>分析专家（仅可选择一位）</label><div className={styles['launcherMasters']}>{masters.map(master => <button key={master.id} className={masterId === master.id ? styles['masterSelected'] : ''} aria-pressed={masterId === master.id} onClick={() => setMasterId(master.id)}><span style={{ color: master.color, borderColor: master.color }}>{master.shortName}</span><span><b>{master.name}</b><small>{master.roleTag || master.tags.slice(0, 2).join(' · ')}</small></span><em>{masterId === master.id ? '●' : '○'}</em></button>)}</div></section>
    <footer className={styles['launcherActions']}><button className={`${styles['button']} ${styles['buttonGhost']}`} onClick={onClose}>取消</button><button className={styles['buttonPrimary']} disabled={submitting || selectedStock === null} onClick={() => void submit()}>{submitting ? '正在创建研判…' : '开始研判'}</button></footer>
  </Modal>
}

function JudgementDetailPage({ client, id, onBack, onRetry, notify }: { client: HanaiClient; id: string; onBack: () => void; onRetry: (stock: SearchResult, masterId: string) => void; notify: Notify }) {
  const [detail, setDetail] = useState<JudgementDetail | null>(null)
  const [view, setView] = useState<'report' | 'process' | 'chat'>('report')
  const [selectedReportVersion, setSelectedReportVersion] = useState<number | null>(null)
  const [auditOpen, setAuditOpen] = useState(false)
  const [versionChangeOpen, setVersionChangeOpen] = useState(false)
  const [revisionOpen, setRevisionOpen] = useState(false)
  const [revisionInstruction, setRevisionInstruction] = useState('')
  const [revisionSubmitting, setRevisionSubmitting] = useState(false)
  const [followUps, setFollowUps] = useState<ResearchFollowUp[]>([])
  const [followUpsLoading, setFollowUpsLoading] = useState(true)
  const [followUpsOpen, setFollowUpsOpen] = useState(false)
  const routeId = useRef(id)
  const requestGeneration = useRef(0)
  const requestController = useRef<AbortController | null>(null)
  const requestedRouteId = useRef<string | null>(null)
  const load = useCallback(async (requestedId: string) => {
    if (requestedRouteId.current === requestedId
      && requestController.current !== null
      && !requestController.current.signal.aborted) return
    const generation = ++requestGeneration.current
    requestController.current?.abort()
    const controller = new AbortController()
    requestController.current = controller
    requestedRouteId.current = requestedId
    try {
      const next = await client.call('judgement.get', { id: requestedId }, controller.signal)
      if (controller.signal.aborted
        || generation !== requestGeneration.current
        || requestedId !== routeId.current) return
      setDetail(next)
    } catch (error) {
      if (!controller.signal.aborted
        && generation === requestGeneration.current
        && requestedId === routeId.current) notify(messageOf(error), 'error')
    } finally {
      if (requestController.current === controller) {
        requestController.current = null
        requestedRouteId.current = null
      }
    }
  }, [client, notify])
  useEffect(() => {
    routeId.current = id
    requestGeneration.current += 1
    requestController.current?.abort()
    requestController.current = null
    requestedRouteId.current = null
    setDetail(null)
    setView('report')
    setSelectedReportVersion(null)
    setAuditOpen(false)
    setVersionChangeOpen(false)
    setRevisionOpen(false)
    setFollowUps([])
    setFollowUpsLoading(true)
    setFollowUpsOpen(false)
    void load(id)
    return () => {
      requestGeneration.current += 1
      requestController.current?.abort()
    }
  }, [id, load])
  const currentDetail = detail?.judgement.id === id ? detail : null
  useEffect(() => {
    if (currentDetail === null || !isReportInFlight(currentDetail.judgement.reportStatus)) return
    const timer = window.setInterval(() => void load(id), 1800)
    return () => window.clearInterval(timer)
  }, [currentDetail, id, load])
  const detailSecId = currentDetail?.judgement.secId ?? null
  useEffect(() => {
    if (detailSecId === null) return
    const controller = new AbortController()
    setFollowUpsLoading(true)
    void client.call('research.followup.list', { secId: detailSecId }, controller.signal)
      .then(items => { if (!controller.signal.aborted) setFollowUps(items) })
      .catch(error => { if (!controller.signal.aborted) notify(`跟踪事项加载失败：${messageOf(error)}`, 'error') })
      .finally(() => { if (!controller.signal.aborted) setFollowUpsLoading(false) })
    return () => controller.abort()
  }, [client, detailSecId, notify])
  const newestReportVersion = currentDetail?.reports[0]?.version ?? null
  useEffect(() => {
    if (newestReportVersion === null) return
    setSelectedReportVersion(current => current === null || newestReportVersion > current
      ? newestReportVersion
      : current)
  }, [newestReportVersion])
  if (currentDetail === null) return <Page><PageSkeleton cards={4} /></Page>
  const judgement = currentDetail.judgement
  const report = currentDetail.reports.find(item => item.version === selectedReportVersion)
    ?? currentDetail.reports[0]
  const previousReport = report === undefined ? undefined : currentDetail.reports
    .filter(item => item.version < report.version)
    .sort((left, right) => right.version - left.version)[0]
  const ready = judgement.reportStatus === 'ready' && report !== undefined
  const sessionId = judgement.dshSessionId
  const openRevision = () => {
    if (report === undefined) return
    setRevisionInstruction(revisionSuggestion(report.audit))
    setRevisionOpen(true)
  }
  const copyReport = async () => {
    if (report === undefined) return
    try {
      await copyPlainText(report.content)
      notify('报告 Markdown 已复制')
    } catch (error) {
      notify(`复制失败：${messageOf(error)}`, 'error')
    }
  }
  const downloadReport = () => {
    if (report === undefined) return
    try {
      downloadMarkdown(report.content, `${judgement.code}-${judgement.masterName}-v${report.version}.md`)
      notify('报告 Markdown 已下载')
    } catch (error) {
      notify(`下载失败：${messageOf(error)}`, 'error')
    }
  }
  const submitRevision = async () => {
    const instruction = revisionInstruction.trim()
    if (instruction === '' || revisionSubmitting) return
    setRevisionSubmitting(true)
    try {
      const next = await client.call('judgement.revise', { id: judgement.id, instruction })
      setDetail(current => current === null ? current : { ...current, judgement: next })
      setRevisionOpen(false)
      setView('process')
      notify('已开始生成新的正式报告版本')
    } catch (error) {
      notify(messageOf(error), 'error')
    } finally {
      setRevisionSubmitting(false)
    }
  }

  return <Page>
    <PageHeader title={<>{judgement.stockName} <span className={styles['codeText']}>{judgement.code}</span></>} meta={<span>{judgement.masterName} · {dateTime(judgement.createdAt)} · {judgement.model ?? '默认模型'}</span>} action={<><Status status={judgement.reportStatus} />{judgement.reportStatus === 'failed' && <button className={styles['buttonPrimary']} onClick={() => onRetry({ secId: judgement.secId, code: judgement.code, name: judgement.stockName, exchange: exchangeFor(judgement.secId, judgement.code), pinyinFull: '', pinyinInitial: '', price: null, changePct: null }, judgement.masterId)}>重新研判</button>}<button className={`${styles['button']} ${styles['buttonGhost']}`} onClick={onBack}>← 返回</button></>} />
    {judgement.errorMessage !== null && <div className={styles['errorCard']}><b>本次研判未完成</b><span>{judgement.errorMessage}</span></div>}
    {!ready ? <article className={`${styles['card']} ${styles['liveProcess']}`}>
      <div className={styles['processHead']}><span>{judgement.masterName.slice(0, 1)}</span><div><h2>研判过程</h2><small>{judgement.masterName} 正在分析公开资料</small></div><Status status={judgement.reportStatus} /></div>
      {sessionId === null ? <Empty title="研判会话正在准备" detail="DSH Session 建立后将在这里显示实时执行过程。" /> : <ChatPanel key={`${id}:${sessionId}:live`} clientContext={client.ctx} sessionId={sessionId} title="实时研判过程" compact hideHeader readOnlyReason="报告生成期间仅查看执行过程；报告封存后才可继续对话。" />}
    </article> : <div className={styles['completedLayout']}>
      <aside className={`${styles['card']} ${styles['archiveInfo']}`}>
        <span className={styles['sectionEyebrow']}>本次研判</span>
        {currentDetail.reports.length > 1 && <label className={styles['reportVersionPicker']}>报告版本<select aria-label="报告版本" value={report.version} onChange={event => { setSelectedReportVersion(Number(event.target.value)); setAuditOpen(false); setVersionChangeOpen(false); setView('report') }}>{currentDetail.reports.map(item => <option key={item.version} value={item.version}>v{item.version} · {dateOnly(item.sealedAt)}</option>)}</select></label>}
        <dl>
          <div><dt>股票</dt><dd>{judgement.stockName} {judgement.code}</dd></div>
          <div><dt>分析专家</dt><dd>{judgement.masterName}</dd></div>
          <div><dt>开始时间</dt><dd>{dateTime(judgement.createdAt)}</dd></div>
          <div><dt>报告封存</dt><dd>{dateTime(report.sealedAt)}</dd></div>
          <div><dt>模型</dt><dd>{report.model ?? judgement.model ?? '默认模型'}</dd></div>
          <div><dt>报告版本</dt><dd>v{report.version} · {formatBytes(report.sizeBytes)}</dd></div>
          <div><dt>完整性哈希</dt><dd className={styles['hashValue']} title={report.sha256}>{report.sha256.slice(0, 12)}…</dd></div>
        </dl>
        <button className={styles['button']} onClick={() => void copyReport()}>复制 Markdown</button>
        <button className={styles['button']} onClick={downloadReport}>下载 .md</button>
        <button className={styles['button']} onClick={() => setView(current => current === 'process' ? 'report' : 'process')}>{view === 'process' ? '隐藏' : '查看'}研判过程</button>
        <button className={styles['button']} onClick={openRevision}>修订报告</button>
        {sessionId !== null && <button className={styles['buttonPrimary']} onClick={() => setView(current => current === 'chat' ? 'report' : 'chat')}>{view === 'chat' ? '返回报告' : '继续对话'}</button>}
      </aside>
      {view === 'report' && <article className={`${styles['card']} ${styles['reportCard']}`}>
        <div className={styles['reportHead']}><div><span className={styles['sectionEyebrow']}>分析结果 · v{report.version}</span><h2>研判报告</h2></div><span className={`${styles['tag']} ${styles['tagReady']}`}>已完成</span></div>
        <ReportAuditPanel audit={report.audit} open={auditOpen} onToggle={() => setAuditOpen(current => !current)} onRevise={openRevision} />
        {previousReport !== undefined && <ReportVersionChangePanel
          current={report}
          previous={previousReport}
          open={versionChangeOpen}
          onToggle={() => setVersionChangeOpen(current => !current)}
          onOpenPrevious={() => { setSelectedReportVersion(previousReport.version); setVersionChangeOpen(false) }}
        />}
        <ResearchFollowUpPanel
          client={client}
          secId={judgement.secId}
          judgementId={judgement.id}
          reportVersion={report.version}
          reportContent={report.content}
          items={followUps}
          loading={followUpsLoading}
          open={followUpsOpen}
          onToggle={() => setFollowUpsOpen(current => !current)}
          onItems={setFollowUps}
          notify={notify}
        />
        <MarkdownView content={report.content} />
      </article>}
      {view === 'process' && <article className={`${styles['card']} ${styles['archivedProcess']}`}>{sessionId === null ? <Empty title="研判过程不可用" detail="这份归档未关联 DSH Session。" /> : <ChatPanel key={`${id}:${sessionId}:process`} clientContext={client.ctx} sessionId={sessionId} title="研判过程" compact readOnlyReason="已归档的研判过程为只读记录。" />}</article>}
      {view === 'chat' && <article className={`${styles['card']} ${styles['continuedChat']}`}>{sessionId === null ? <Empty title="对话不可用" detail="这份报告未关联 DSH Session。" /> : <ChatPanel key={`${id}:${sessionId}:chat`} clientContext={client.ctx} sessionId={sessionId} title={`继续与${judgement.masterName}对话`} compact />}</article>}
    </div>}
    {revisionOpen && <Modal title="修订正式报告" subtitle={`将在同一大师会话中生成 v${(judgement.latestReportVersion ?? report?.version ?? 0) + 1}；现有版本保持不可变`} onClose={() => { if (!revisionSubmitting) setRevisionOpen(false) }} wide>
      <div className={styles['revisionBody']}>
        <label htmlFor="report-revision-instruction">修订要求</label>
        <textarea id="report-revision-instruction" value={revisionInstruction} onChange={event => setRevisionInstruction(event.target.value)} rows={7} placeholder="说明需要补充核验、纠正或重写的内容" />
        <p>修订会重新核验必要来源并形成新版本；普通追问仍请使用“继续对话”。</p>
      </div>
      <footer className={styles['launcherActions']}><button className={`${styles['button']} ${styles['buttonGhost']}`} disabled={revisionSubmitting} onClick={() => setRevisionOpen(false)}>取消</button><button className={styles['buttonPrimary']} disabled={revisionSubmitting || revisionInstruction.trim() === ''} onClick={() => void submitRevision()}>{revisionSubmitting ? '正在启动修订…' : '生成新版本'}</button></footer>
    </Modal>}
  </Page>
}

function ReportAuditPanel({ audit, open, onToggle, onRevise }: { audit: ReportAudit; open: boolean; onToggle: () => void; onRevise: () => void }) {
  const missing = audit.checks.filter(item => item.state !== 'met').length
  const labels: Record<ReportAudit['rating'], string> = {
    strong: missing === 0 ? '结构完整' : '结构较完整',
    review: '建议复核',
    thin: '要素偏少',
  }
  return <section className={`${styles['reportAudit']} ${styles[`reportAudit_${audit.rating}`]}`} aria-label="报告结构自检">
    <button className={styles['reportAuditSummary']} onClick={onToggle} aria-expanded={open}>
      <span className={styles['auditScore']}><b>{audit.score}</b><small>/100</small></span>
      <span><b>报告结构自检 · {labels[audit.rating]}</b><small>{audit.sources.length} 个可追溯链接 · {audit.evidence.length} 条证据主张 · {missing === 0 ? '7 项均已覆盖' : `${missing} 项需要复核`}</small></span>
      <em>{open ? '收起详情 ↑' : '查看详情 ↓'}</em>
    </button>
    {open && <div className={styles['reportAuditDetail']}>
      <p>这里只检查日期、来源、反证、情景等可观察结构，不代表来源权威，也不判断投资结论是否正确。</p>
      <div className={styles['auditChecks']}>{audit.checks.map(item => <AuditCheck key={item.id} check={item} />)}</div>
      {audit.evidence.length > 0 && <ReportEvidencePreview items={audit.evidence} />}
      <div className={styles['auditSources']}><span>来源链接</span>{audit.sources.length === 0 ? <small>报告中没有识别到公开链接</small> : <div>{audit.sources.slice(0, 8).map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer" title={source.url}>{source.label ?? source.domain}<small>{source.domain}</small></a>)}</div>}</div>
      {missing > 0 && <button className={styles['button']} onClick={onRevise}>按缺失项修订报告</button>}
    </div>}
  </section>
}

function AuditCheck({ check }: { check: ReportAuditCheck }) {
  const symbol = check.state === 'met' ? '✓' : check.state === 'partial' ? '△' : '—'
  const state = check.state === 'met' ? '已覆盖' : check.state === 'partial' ? '部分覆盖' : '缺失'
  return <div className={styles[`auditCheck_${check.state}`]} title={check.detail}><span>{symbol}</span><b>{check.label}</b><small>{state}</small></div>
}

function ReportEvidencePreview({ items }: { items: ReportEvidenceItem[] }) {
  const [kind, setKind] = useState<'all' | ReportEvidenceItem['kind']>('all')
  const [expanded, setExpanded] = useState(false)
  const kindLabel: Record<ReportEvidenceItem['kind'], string> = {
    fact: '事实', inference: '推断', assumption: '假设', unknown: '待核验',
  }
  const confidenceLabel: Record<ReportEvidenceItem['confidence'], string> = {
    high: '高', medium: '中', low: '低', unknown: '未标注',
  }
  const counts = {
    fact: items.filter(item => item.kind === 'fact').length,
    inference: items.filter(item => item.kind === 'inference').length,
    assumption: items.filter(item => item.kind === 'assumption').length,
    unknown: items.filter(item => item.kind === 'unknown').length,
  }
  const filtered = kind === 'all' ? items : items.filter(item => item.kind === kind)
  const visible = expanded ? filtered : filtered.slice(0, 6)
  const incomplete = items.filter(item => (
    item.kind === 'unknown'
    || item.sourceUrl === null
    || item.sourceDate === null
    || item.confidence === 'unknown'
  )).length
  return <section className={styles['auditEvidence']} aria-label="证据账本速览">
    <header><div><span>证据账本速览</span><small>解析到 {items.length} 条主张{incomplete > 0 ? ` · ${incomplete} 条字段待补` : ' · 字段完整'}；点击来源可回到公开页面</small></div><div className={styles['auditEvidenceFilters']}><button aria-pressed={kind === 'all'} onClick={() => { setKind('all'); setExpanded(false) }}>全部 {items.length}</button>{(['fact', 'inference', 'assumption', 'unknown'] as const).map(value => <button key={value} aria-pressed={kind === value} onClick={() => { setKind(value); setExpanded(false) }}>{kindLabel[value]} {counts[value]}</button>)}</div></header>
    <div>
      <table>
        <thead><tr><th>关键主张</th><th>边界</th><th>来源 / 日期</th><th>置信度</th></tr></thead>
        <tbody>{visible.map((item, index) => <tr key={`${item.claim}:${index}`}>
          <td><b>{item.claim}</b></td>
          <td><span data-kind={item.kind}>{kindLabel[item.kind]}</span></td>
          <td>{item.sourceUrl === null
            ? <>{item.sourceLabel ?? '—'}<small>{item.sourceDate ?? '未标日期'}</small></>
            : <a href={item.sourceUrl} target="_blank" rel="noreferrer">{item.sourceLabel ?? '打开来源'}<small>{item.sourceDate ?? '未标日期'}</small></a>}</td>
          <td>{confidenceLabel[item.confidence]}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {filtered.length === 0 && <p>当前筛选下没有证据主张。</p>}
    {filtered.length > 6 && <button className={styles['auditEvidenceExpand']} onClick={() => setExpanded(current => !current)}>{expanded ? '收起证据主张' : `展开全部 ${filtered.length} 条`}</button>}
  </section>
}

function ReportVersionChangePanel({ current, previous, open, onToggle, onOpenPrevious }: {
  current: ReportVersion
  previous: ReportVersion
  open: boolean
  onToggle: () => void
  onOpenPrevious: () => void
}) {
  const change = useMemo(() => summarizeReportVersionChange(previous, current), [current, previous])
  const sectionChanges = change.added.length + change.removed.length + change.changed.length
  return <section className={styles['reportChange']} aria-label="报告版本变化">
    <button className={styles['reportChangeSummary']} onClick={onToggle} aria-expanded={open}>
      <span>↗</span>
      <span><b>版本变化 · v{previous.version} → v{current.version}</b><small>{sectionChanges === 0 ? '未识别到二级章节变化' : `${change.changed.length} 节调整 · ${change.added.length} 节新增 · ${change.removed.length} 节移除`}</small></span>
      <em>{open ? '收起 ↑' : '查看变化 ↓'}</em>
    </button>
    {open && <div className={styles['reportChangeBody']}>
      <p>按报告结构做机械对比，只说明文本和可观察要素发生变化，不代表结论变得更正确。</p>
      <div className={styles['reportChangeMetrics']}>
        <span><small>结构质量</small><b>{current.audit.score}<em>{signedDelta(change.scoreDelta)}</em></b></span>
        <span><small>来源链接</small><b>{current.audit.sources.length}<em>{signedDelta(change.sourceDelta)}</em></b></span>
        <span><small>报告篇幅</small><b>{formatBytes(current.sizeBytes)}<em>{signedDelta(change.sizeDelta, ' B')}</em></b></span>
        <span><small>检查项改善</small><b>{change.improvedChecks.length}<em>{change.regressedChecks.length > 0 ? `${change.regressedChecks.length} 项回退` : '无回退'}</em></b></span>
      </div>
      {sectionChanges > 0 && <div className={styles['reportChangeSections']}>
        {change.added.map(name => <span key={`added:${name}`} data-kind="added">＋ {name}</span>)}
        {change.changed.map(name => <span key={`changed:${name}`} data-kind="changed">～ {name}</span>)}
        {change.removed.map(name => <span key={`removed:${name}`} data-kind="removed">－ {name}</span>)}
      </div>}
      <button className={styles['button']} onClick={onOpenPrevious}>查看 v{previous.version} 全文</button>
    </div>}
  </section>
}

function ResearchFollowUpPanel({ client, secId, judgementId, reportVersion, reportContent, items, loading, open, onToggle, onItems, notify, standalone = false }: {
  client: HanaiClient
  secId: string
  judgementId?: string
  reportVersion?: number
  reportContent?: string
  items: ResearchFollowUp[]
  loading: boolean
  open: boolean
  onToggle: () => void
  onItems: (items: ResearchFollowUp[]) => void
  notify: Notify
  standalone?: boolean
}) {
  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [editingId, setEditingId] = useState('')
  const [confirmingDeleteId, setConfirmingDeleteId] = useState('')
  const today = localDateKey(new Date())
  const openCount = items.filter(item => item.status === 'open').length
  const overdueCount = items.filter(item => item.status === 'open' && item.dueDate !== null && item.dueDate < today).length
  const suggestions = useMemo(() => {
    const existing = new Set(items.map(item => normalizeComparableText(item.title)))
    return extractMonitoringItems(reportContent ?? '')
      .filter(item => !existing.has(normalizeComparableText(item)))
      .slice(0, 6)
  }, [items, reportContent])

  const create = async () => {
    const nextTitle = title.trim()
    if (nextTitle === '' || submitting) return
    setSubmitting(true)
    try {
      const created = await client.call('research.followup.create', {
        secId,
        ...(judgementId === undefined ? {} : { judgementId }),
        ...(reportVersion === undefined ? {} : { reportVersion }),
        title: nextTitle,
        ...(dueDate === '' ? {} : { dueDate }),
      })
      onItems(sortResearchFollowUps([...items, created]))
      setTitle('')
      setDueDate('')
      notify('已加入持续跟踪')
    } catch (error) {
      notify(messageOf(error), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const toggle = async (item: ResearchFollowUp) => {
    if (busyId !== '') return
    setBusyId(item.id)
    try {
      const updated = await client.call('research.followup.update', {
        id: item.id,
        completed: item.status !== 'done',
      })
      onItems(sortResearchFollowUps(items.map(current => current.id === updated.id ? updated : current)))
    } catch (error) {
      notify(messageOf(error), 'error')
    } finally {
      setBusyId('')
    }
  }

  const remove = async (item: ResearchFollowUp) => {
    if (confirmingDeleteId !== item.id) {
      setConfirmingDeleteId(item.id)
      return
    }
    if (busyId !== '') return
    setBusyId(item.id)
    try {
      await client.call('research.followup.remove', { id: item.id })
      onItems(items.filter(current => current.id !== item.id))
      setConfirmingDeleteId('')
      notify('跟踪事项已删除')
    } catch (error) {
      notify(messageOf(error), 'error')
    } finally {
      setBusyId('')
    }
  }

  const saveEdit = async (item: ResearchFollowUp, nextTitle: string, nextDueDate: string) => {
    if (busyId !== '') return
    setBusyId(item.id)
    try {
      const updated = await client.call('research.followup.update', {
        id: item.id,
        title: nextTitle,
        dueDate: nextDueDate === '' ? null : nextDueDate,
      })
      onItems(sortResearchFollowUps(items.map(current => current.id === updated.id ? updated : current)))
      setEditingId('')
      notify('跟踪事项已更新')
    } catch (error) {
      notify(messageOf(error), 'error')
    } finally {
      setBusyId('')
    }
  }

  return <section className={standalone ? `${styles['card']} ${styles['followUpStandalone']}` : styles['followUpPanel']} aria-label={standalone ? '个股持续研究跟踪' : '持续研究跟踪'}>
    <button className={styles['followUpSummary']} onClick={onToggle} aria-expanded={open}>
      <span>◎</span>
      <span><b>持续研究跟踪</b><small>{loading ? '正在加载本地事项…' : openCount === 0 ? '暂无待验证事项' : `${openCount} 项待验证${overdueCount > 0 ? ` · ${overdueCount} 项逾期` : ''}`}</small></span>
      <em>{open ? '收起 ↑' : '展开 ↓'}</em>
    </button>
    {open && <div className={styles['followUpBody']}>
      <p>{standalone ? '这里集中管理该公司的本地检查点；删除关联研判报告时也会保留。' : '跟踪事项保存在本地并独立于报告版本；删除研判报告时也会保留。'}</p>
      {suggestions.length > 0 && <div className={styles['followUpSuggestions']}><span>报告中的待验证项</span><div>{suggestions.map(suggestion => <button key={suggestion} title={suggestion} onClick={() => setTitle(suggestion)}>{suggestion}</button>)}</div></div>}
      <form className={styles['followUpComposer']} onSubmit={(event) => { event.preventDefault(); void create() }}>
        <input value={title} onChange={event => setTitle(event.target.value)} maxLength={160} placeholder="添加要持续验证的事实、指标或事件" aria-label="跟踪事项" />
        <input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} aria-label="跟踪到期日" />
        <button className={styles['buttonPrimary']} disabled={submitting || title.trim() === ''}>{submitting ? '添加中…' : '添加'}</button>
      </form>
      {items.length === 0 ? <div className={styles['followUpEmpty']}>{reportContent === undefined ? '手动建立下一次研究检查点；后续也可从研判报告建议中一键加入。' : '从报告建议中选择一项，或手动建立下一次研究检查点。'}</div> : <ul className={styles['followUpList']}>{items.map((item) => {
        const overdue = item.status === 'open' && item.dueDate !== null && item.dueDate < today
        const editing = editingId === item.id
        return <li key={item.id} data-completed={item.status === 'done' ? 'true' : 'false'} data-editing={editing ? 'true' : 'false'}>
          <button className={styles['followUpCheck']} disabled={busyId !== ''} aria-label={item.status === 'done' ? `恢复跟踪：${item.title}` : `完成跟踪：${item.title}`} aria-pressed={item.status === 'done'} onClick={() => void toggle(item)}>{item.status === 'done' ? '✓' : ''}</button>
          {editing
            ? <FollowUpInlineEditor item={item} saving={busyId === item.id} onSave={(nextTitle, nextDueDate) => void saveEdit(item, nextTitle, nextDueDate)} onCancel={() => setEditingId('')} />
            : <><span><b>{item.title}</b><small>{item.dueDate === null ? '未设到期日' : overdue ? `已逾期 · ${item.dueDate}` : `到期 ${item.dueDate}`}{item.reportVersion === null ? '' : ` · 来自 v${item.reportVersion}`}</small></span>
              <span className={styles['followUpActions']}><button className={styles['followUpEdit']} disabled={busyId !== ''} aria-label={`编辑跟踪事项：${item.title}`} onClick={() => { setConfirmingDeleteId(''); setEditingId(item.id) }}>编辑</button><button className={`${styles['followUpRemove']} ${confirmingDeleteId === item.id ? styles['followUpRemoveConfirm'] : ''}`} disabled={busyId !== ''} onClick={() => void remove(item)}>{confirmingDeleteId === item.id ? '确认' : '删除'}</button></span></>}
        </li>
      })}</ul>}
    </div>}
  </section>
}

function ResearchPredictionPanel({ client, secId, items, loading, onItems, notify }: {
  client: HanaiClient
  secId: string
  items: ResearchPrediction[]
  loading: boolean
  onItems: (items: ResearchPrediction[]) => void
  notify: Notify
}) {
  const [composerOpen, setComposerOpen] = useState(false)
  const [statement, setStatement] = useState('')
  const [criteria, setCriteria] = useState('')
  const [probability, setProbability] = useState('60')
  const [dueDate, setDueDate] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [confirming, setConfirming] = useState<{ id: string; outcome: 'occurred' | 'not-occurred' | 'invalid' } | null>(null)
  const pending = items.filter(item => item.outcome === 'pending')
  const scored = items.filter(item => item.brierScore !== null)
  const meanBrier = scored.length === 0
    ? null
    : scored.reduce((total, item) => total + (item.brierScore ?? 0), 0) / scored.length
  const probabilityValue = Number(probability)
  const canSubmit = statement.trim() !== ''
    && criteria.trim() !== ''
    && dueDate !== ''
    && Number.isSafeInteger(probabilityValue)
    && probabilityValue >= 1
    && probabilityValue <= 99

  const create = async () => {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    try {
      const created = await client.call('research.prediction.create', {
        secId,
        statement: statement.trim(),
        resolutionCriteria: criteria.trim(),
        probabilityPct: probabilityValue,
        dueDate,
      })
      onItems(sortResearchPredictions([...items, created]))
      setStatement('')
      setCriteria('')
      setProbability('60')
      setDueDate('')
      setComposerOpen(false)
      notify('研究命题已记录，等待到期复核')
    } catch (error) {
      notify(messageOf(error), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const resolve = async (item: ResearchPrediction, outcome: 'occurred' | 'not-occurred' | 'invalid') => {
    if (confirming?.id !== item.id || confirming.outcome !== outcome) {
      setConfirming({ id: item.id, outcome })
      return
    }
    if (busyId !== '') return
    setBusyId(item.id)
    try {
      const updated = await client.call('research.prediction.resolve', { id: item.id, outcome })
      onItems(sortResearchPredictions(items.map(current => current.id === updated.id ? updated : current)))
      setConfirming(null)
      notify(outcome === 'invalid' ? '命题已标记为无法判定' : '结果已记录并完成校准')
    } catch (error) {
      notify(messageOf(error), 'error')
    } finally {
      setBusyId('')
    }
  }

  return <section className={`${styles['card']} ${styles['predictionPanel']}`} aria-label="研究命题与校准">
    <PanelHead
      title="研究命题与校准"
      hint="可验证命题 · Brier 越低越好"
      extra={<button className={composerOpen ? styles['buttonSelected'] : styles['button']} onClick={() => setComposerOpen(current => !current)}>{composerOpen ? '收起' : '＋ 记录命题'}</button>}
    />
    <div className={styles['predictionSummary']}>
      <span><small>待判定</small><b>{loading ? '…' : pending.length}</b></span>
      <span><small>已评分</small><b>{loading ? '…' : scored.length}</b></span>
      <span><small>平均 Brier</small><b>{meanBrier === null ? '—' : meanBrier.toFixed(4)}</b></span>
    </div>
    <p className={styles['predictionNote']}>只记录可被公开事实判定的二元命题；概率是当下信念快照，不是股价目标或交易信号。</p>
    {composerOpen && <form className={styles['predictionComposer']} aria-label="记录研究命题" onSubmit={(event) => { event.preventDefault(); void create() }}>
      <label><span>可验证命题</span><input value={statement} onChange={event => setStatement(event.target.value)} maxLength={200} placeholder="例：下一季度经营现金流同比改善" /></label>
      <label><span>判定口径</span><input value={criteria} onChange={event => setCriteria(event.target.value)} maxLength={300} placeholder="例：以公司法定季度报告披露值为准" /></label>
      <div><label><span>主观概率</span><span className={styles['predictionProbability']}><input type="number" min="1" max="99" step="1" value={probability} onChange={event => setProbability(event.target.value)} aria-label="主观概率" /><em>%</em></span></label><label><span>判定日期</span><input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} aria-label="命题判定日期" /></label><button className={styles['buttonPrimary']} disabled={!canSubmit || submitting}>{submitting ? '记录中…' : '记录快照'}</button></div>
    </form>}
    {items.length === 0
      ? <div className={styles['predictionEmpty']}>{loading ? '正在读取本地校准记录…' : '还没有命题。只在口径与期限明确时记录，避免事后改写判断。'}</div>
      : <ul className={styles['predictionList']}>{items.map(item => {
        const pendingItem = item.outcome === 'pending'
        const overdue = pendingItem && item.dueDate < localDateKey(new Date())
        return <li key={item.id} data-outcome={item.outcome} data-overdue={overdue}>
          <div className={styles['predictionClaim']}><span><b>{item.probabilityPct}%</b><small>{pendingItem ? overdue ? '已到期' : `待 ${item.dueDate}` : predictionOutcomeLabel(item.outcome)}</small></span><div><strong>{item.statement}</strong><small title={item.resolutionCriteria}>口径：{item.resolutionCriteria}</small></div></div>
          {pendingItem
            ? <div className={styles['predictionActions']}><button disabled={busyId !== ''} aria-label={`${confirming?.id === item.id && confirming.outcome === 'occurred' ? '确认标记发生' : '标记发生'}：${item.statement}`} onClick={() => void resolve(item, 'occurred')}>{confirming?.id === item.id && confirming.outcome === 'occurred' ? '确认发生' : '发生'}</button><button disabled={busyId !== ''} aria-label={`${confirming?.id === item.id && confirming.outcome === 'not-occurred' ? '确认标记未发生' : '标记未发生'}：${item.statement}`} onClick={() => void resolve(item, 'not-occurred')}>{confirming?.id === item.id && confirming.outcome === 'not-occurred' ? '确认未发生' : '未发生'}</button><button disabled={busyId !== ''} aria-label={`${confirming?.id === item.id && confirming.outcome === 'invalid' ? '确认无法判定' : '标记无法判定'}：${item.statement}`} onClick={() => void resolve(item, 'invalid')}>{confirming?.id === item.id && confirming.outcome === 'invalid' ? '确认无效' : '无法判定'}</button></div>
            : <div className={styles['predictionResult']}><span>{predictionOutcomeLabel(item.outcome)}</span>{item.brierScore !== null && <b>Brier {item.brierScore.toFixed(4)}</b>}<small>{item.resolvedAt === null ? '' : dateTime(item.resolvedAt)}</small></div>}
        </li>
      })}</ul>}
  </section>
}

function PersonasPage({ masters }: { masters: MasterPersona[] }) {
  return <Page>
    <PageHeader title="专家中心" description="了解每位专家的分析框架、适用场景与核心方法" />
    <div className={styles['personaGrid']}>{masters.map(master => <article key={master.id} className={`${styles['card']} ${styles['personaCard']}`} aria-label={`${master.name}专家信息`}>
      <header className={styles['personaHead']}>
        <span className={styles['personaAvatar']} style={{ color: master.color, borderColor: master.color }}>{master.shortName}</span>
        <div className={styles['personaIdentity']}><b>{master.name}</b>{master.roleTag && <em className={styles['personaRole']} style={{ color: master.color, borderColor: master.color }}>{master.roleTag}</em>}</div>
      </header>
      <section className={styles['personaBody']}><label>专家介绍</label><p className={styles['personaDescription']}>{master.description || '暂无介绍'}</p></section>
      {master.tags.length > 0 && <footer className={styles['personaMethods']}><label>核心方法</label><div>{master.tags.map(tag => <span key={tag}>{tag}</span>)}</div></footer>}
    </article>)}</div>
  </Page>
}

function SettingsPage({ client, bootstrap, onTheme, onReload, notify }: { client: HanaiClient; bootstrap: BootstrapData; onTheme: (theme: ThemeId) => void; onReload: () => Promise<void>; notify: Notify }) {
  const [credential, setCredential] = useState<{ configured: boolean; writable: boolean; source?: string } | null>(null)
  const [key, setKey] = useState('')
  const [models, setModels] = useState<ModelProviderGroup[]>([])
  const [defaultModel, setDefaultModel] = useState<DefaultModelView | null>(null)
  const [modelSelection, setModelSelection] = useState('')
  const [defaultModelError, setDefaultModelError] = useState<string | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    setChecking(true)
    const [credentialResult, modelResult, defaultModelResult] = await Promise.allSettled([
      client.isLoopback ? client.credential() : Promise.resolve({ configured: false, writable: false }),
      client.models(),
      client.isLoopback ? client.defaultModel() : Promise.resolve(null),
    ])
    if (credentialResult.status === 'fulfilled') setCredential(credentialResult.value)
    if (modelResult.status === 'fulfilled') { setModels(modelResult.value); setModelError(null) }
    else setModelError(messageOf(modelResult.reason))
    if (defaultModelResult.status === 'fulfilled') {
      setDefaultModel(defaultModelResult.value)
      setModelSelection(defaultModelResult.value === null ? '' : `${defaultModelResult.value.provider}\0${defaultModelResult.value.model}`)
      setDefaultModelError(defaultModelResult.value === null ? client.isLoopback ? 'DSH 未提供默认模型设置命名空间' : '请在运行 DSH 的本机页面设置' : null)
    } else {
      setDefaultModel(null)
      setDefaultModelError(messageOf(defaultModelResult.reason))
    }
    setChecking(false)
  }, [client])
  useEffect(() => { void load() }, [load])
  const setTheme = async (theme: ThemeId) => {
    try { await client.call('theme.set', { theme }); onTheme(theme); notify('主题已切换') }
    catch (error) { notify(messageOf(error), 'error') }
  }
  const clearCache = async (scope: 'market' | 'valuation') => {
    setBusy(true)
    try {
      const result = await client.call('cache.clear', { scope })
      notify(`已清理 ${result.removedFiles} 个文件，释放 ${formatBytes(result.freedBytes)}`)
      await onReload()
    } catch (error) { notify(messageOf(error), 'error') } finally { setBusy(false) }
  }
  const saveDefaultModel = async () => {
    const separator = modelSelection.indexOf('\0')
    if (separator <= 0 || separator === modelSelection.length - 1 || defaultModel === null) return
    setBusy(true)
    try {
      const next = await client.setDefaultModel({ provider: modelSelection.slice(0, separator), model: modelSelection.slice(separator + 1) }, defaultModel.revision)
      setDefaultModel(next)
      setModelSelection(`${next.provider}\0${next.model}`)
      notify('默认模型已更新')
    } catch (error) { notify(messageOf(error), 'error') } finally { setBusy(false) }
  }
  const connectionLabel = checking ? '检测中…' : modelError === null ? '连接可用' : '模型目录不可用'
  const connectionDetail = checking ? '正在读取 DSH 连接与模型目录' : modelError === null ? 'DSH Client Connection' : modelError
  return <Page>
    <PageHeader title="设置与诊断" description="管理 DSH 连接、模型、凭据与本地研究数据" />
    <div className={styles['settingsGrid']}>
      <article className={`${styles['card']} ${styles['settingsCard']} ${styles['settingsAgent']}`}><PanelHead title="DSH Agent" hint="连接诊断与默认模型" extra={<span className={styles['settingsStatus']}><i className={`${styles['statusDot']} ${checking ? styles['statusWarn'] : modelError === null ? styles['statusOk'] : styles['statusError']}`} />{connectionLabel}</span>} />
        <div className={styles['settingsFacts']}>
          <KeyValue label="状态" value={connectionLabel} />
          <KeyValue label="连接" value={connectionDetail ?? '—'} />
          <KeyValue label="Hanai Worth Host 版本" value={bootstrap.diagnostics.version} />
          <KeyValue label="本地数据目录" value={bootstrap.diagnostics.dataRoot} mono />
        </div>
        <div className={styles['modelControl']}><label htmlFor="hanai-default-model">默认模型</label><div><select id="hanai-default-model" value={modelSelection} disabled={defaultModel === null || !defaultModel.writable || models.length === 0 || busy} onChange={event => setModelSelection(event.target.value)}>{models.map(group => <optgroup key={group.id} label={group.id}>{group.models.map(model => <option key={`${group.id}/${model.id}`} value={`${group.id}\0${model.id}`}>{model.name}</option>)}</optgroup>)}</select><button className={styles['buttonPrimary']} disabled={defaultModel === null || !defaultModel.writable || modelSelection === '' || busy || modelSelection === `${defaultModel.provider}\0${defaultModel.model}`} onClick={() => void saveDefaultModel()}>保存默认模型</button><button className={styles['button']} onClick={() => void load()}>重新检测连接</button></div>{defaultModelError !== null && <small>{defaultModelError}</small>}</div>
      </article>

      <article className={`${styles['card']} ${styles['settingsCard']} ${styles['settingsCredential']}`}><PanelHead title="DeepSeek API Key" hint="由 DSH Credentials 安全托管" />
        <div className={styles['credentialState']}><span className={`${styles['statusDot']} ${credential?.configured ? styles['statusOk'] : styles['statusUnknown']}`} /><div><b>{credential?.configured ? '已配置' : client.isLoopback ? '尚未配置' : '远端页面不可查看'}</b><small>{credential?.source === 'env' ? '来自环境变量（只读优先）' : credential?.source === 'file' ? '保存在 DSH 本地凭据文件' : 'Key 不写入 Hanai Worth 数据库或浏览器存储'}</small></div></div>
        {client.isLoopback ? <><label className={styles['field']}><span>写入新的 API Key</span><input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder="sk-••••••••••••" disabled={credential?.writable === false} /></label><div className={styles['settingsActions']}><button className={styles['buttonPrimary']} disabled={busy || key.trim() === '' || credential?.writable === false} onClick={() => { setBusy(true); void client.setDeepSeekKey(key).then(async () => { setKey(''); notify('API Key 已安全保存'); await load() }).catch(error => notify(messageOf(error), 'error')).finally(() => setBusy(false)) }}>安全保存</button><button className={styles['button']} disabled={!credential?.configured || credential.writable === false} onClick={() => void client.unsetDeepSeekKey().then(async () => { notify('已移除托管凭据'); await load() }).catch(error => notify(messageOf(error), 'error'))}>移除</button></div></> : <p className={styles['hintBox']}>为保护主机凭据，请在运行 DSH 的本机地址设置 API Key。</p>}
      </article>

      <article className={`${styles['card']} ${styles['settingsCard']} ${styles['settingsData']}`}><PanelHead title="数据源" hint="本地缓存与最近一次可用状态" />
        <div className={styles['sourceList']}><SourceRow title="行情 · 东方财富" detail={`近实时快照 · 最近成功 ${dateTime(bootstrap.diagnostics.latestMarketSuccess)}`} available={bootstrap.diagnostics.latestMarketSuccess !== null} />
          <SourceRow title="估值 · 价值大师网" detail={`日级缓存 · 最近成功 ${dateTime(bootstrap.diagnostics.latestValuationSuccess)} · 仅限个人研究使用`} available={bootstrap.diagnostics.latestValuationSuccess !== null} /></div>
        <div className={styles['sourceSummary']}><span>证券主数据</span><b>{bootstrap.diagnostics.securityCount.toLocaleString()} 只</b></div>
        <div className={styles['settingsActions']}><button className={styles['button']} disabled={busy} onClick={() => { setBusy(true); void client.call('security.sync', { force: true }).then(async result => { notify(`已同步 ${result.count.toLocaleString()} 条证券`); await onReload() }).catch(error => notify(messageOf(error), 'error')).finally(() => setBusy(false)) }}>{busy ? '同步中…' : '立即同步主数据'}</button></div>
      </article>

      <article className={`${styles['card']} ${styles['settingsCard']} ${styles['settingsStorage']}`}><PanelHead title="本地存储" hint="数据与缓存均隔离在 Hanai Worth 专用目录" />
        <div className={styles['storagePaths']}><KeyValue label="数据目录" value={bootstrap.diagnostics.dataRoot} mono /><KeyValue label="SQLite" value={bootstrap.diagnostics.databasePath} mono /></div>
        <div className={styles['storageMetrics']}>
          <SettingsMetric label="总占用" value={formatBytes(bootstrap.diagnostics.storage.totalBytes)} />
          <SettingsMetric label="缓存合计" value={formatBytes(bootstrap.diagnostics.storage.cacheBytes)} />
          <SettingsMetric label="行情缓存" value={formatBytes(bootstrap.diagnostics.storage.marketCacheBytes)} />
          <SettingsMetric label="估值缓存" value={formatBytes(bootstrap.diagnostics.storage.valuationCacheBytes)} />
          <SettingsMetric label="研判归档" value={`${bootstrap.diagnostics.judgementCount} 份 · ${formatBytes(bootstrap.diagnostics.storage.judgementsBytes)}`} />
        </div>
        <div className={styles['storageFooter']}><p className={styles['settingsNote']}>清理缓存不会删除自选、专家与研判报告。</p><div className={styles['settingsActions']}><button className={styles['button']} disabled={busy} onClick={() => { setBusy(true); void client.call('storage.openDataRoot', {}).then(result => notify(`已打开 ${result.dataRoot}`)).catch(error => notify(messageOf(error), 'error')).finally(() => setBusy(false)) }}>打开数据目录</button><button className={styles['button']} disabled={busy} onClick={() => void clearCache('market')}>清理行情缓存</button><button className={styles['button']} disabled={busy} onClick={() => void clearCache('valuation')}>清理估值缓存</button></div></div>
      </article>

      <article className={`${styles['card']} ${styles['settingsCard']} ${styles['settingsTheme']}`}><PanelHead title="界面主题" hint="只改变颜色，不改变页面布局" /><div className={styles['themeChoices']}><button className={bootstrap.theme === 'light' ? styles['themeSelected'] : ''} onClick={() => void setTheme('light')}><i className={styles['lightSwatch']} /><span><b>亮色模式</b><small>浅色背景与深色文字</small></span><em>{bootstrap.theme === 'light' ? '✓' : ''}</em></button><button className={bootstrap.theme === 'dark' ? styles['themeSelected'] : ''} onClick={() => void setTheme('dark')}><i className={styles['darkSwatch']} /><span><b>黑夜模式</b><small>原客户端深色研究终端</small></span><em>{bootstrap.theme === 'dark' ? '✓' : ''}</em></button></div></article>

      <article className={`${styles['card']} ${styles['settingsCard']} ${styles['settingsAbout']}`}><PanelHead title="关于与声明" /><div className={styles['about']}><p><b>{BRAND_NAME}</b> v{bootstrap.diagnostics.version} · 本地优先 A 股价值研究工作台</p><p><b>价格有报价，价值靠研究。</b> 每一份研判，都应能回到证据、方法与上下文。</p><p>本产品是研究辅助工具，不是券商、投顾或资产管理服务：不执行交易、不承诺收益、不提供确定性买卖建议。</p><p>行情与估值数据可能延迟、不完整或有误，请以交易所与官方披露为准；数据接口仅限个人研究。</p><p>应用数据保存在用户本地目录 <code>{bootstrap.diagnostics.dataRoot}</code>，界面不展示或回显完整凭据。</p></div></article>
    </div>
  </Page>
}

function GlobalSearch({ client, groups, onGroups, onClose, onSelect, notify }: { client: HanaiClient; groups: WatchGroup[]; onGroups: (groups: WatchGroup[]) => void; onClose: () => void; onSelect: (stock: SearchResult) => void; notify: Notify }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [watchTarget, setWatchTarget] = useState<SearchResult | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const resultRefs = useRef<Array<HTMLButtonElement | null>>([])
  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => { setActiveIndex(0); resultRefs.current[0]?.scrollIntoView?.({ block: 'nearest' }) }, [results])
  useEffect(() => {
    if (query.trim() === '') { setResults([]); setError(null); return }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void client.call('security.search', { query: query.trim() }, controller.signal)
        .then(next => { setResults(next); setError(null) })
        .catch(reason => { if (!controller.signal.aborted) setError(messageOf(reason)) })
    }, 180)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [client, query])
  const move = (next: number) => {
    const normalized = Math.max(0, Math.min(results.length - 1, next))
    setActiveIndex(normalized)
    resultRefs.current[normalized]?.scrollIntoView?.({ block: 'nearest' })
  }
  return <div className={styles['modalBackdrop']} role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) onClose() }}><div className={styles['searchModal']} role="dialog" aria-modal="true" aria-label="全局股票搜索" onKeyDown={event => {
    if (event.key === 'ArrowDown' && results.length > 0) { event.preventDefault(); move(activeIndex + 1) }
    else if (event.key === 'ArrowUp' && results.length > 0) { event.preventDefault(); move(activeIndex - 1) }
    else if (event.key === 'Enter' && results[activeIndex] !== undefined) { event.preventDefault(); onSelect(results[activeIndex]) }
    else if (event.key === 'Escape') onClose()
  }}><header><span>⌕</span><input ref={input} value={query} onChange={event => setQuery(event.target.value)} placeholder="输入代码、名称、拼音全拼或首字母…" aria-activedescendant={results[activeIndex] === undefined ? undefined : `hanai-search-${results[activeIndex].secId}`} /><kbd>ESC</kbd></header><div className={styles['searchBody']}>{query.trim() === '' ? <div className={styles['searchHint']}>支持：600519 · 贵州茅台 · guizhoumaotai · gzmt</div> : error !== null ? <div className={styles['searchHint']}>{error}</div> : results.length === 0 ? <div className={styles['searchHint']}>未找到匹配的证券（本地主数据）</div> : results.map((result, index) => <div id={`hanai-search-${result.secId}`} key={result.secId} className={index === activeIndex ? styles['searchActive'] : ''} onMouseEnter={() => setActiveIndex(index)}><button ref={node => { resultRefs.current[index] = node }} onClick={() => onSelect(result)}><span>{result.code}</span><b>{highlight(result.name, query)}</b><small>{result.exchange}</small><span>{number(result.price)}</span><em className={styles[classForChange(result.changePct)]}>{percent(result.changePct)}</em></button><button className={styles['watchAdd']} onClick={() => setWatchTarget(result)}>＋ 加入自选</button></div>)}</div></div>{watchTarget !== null && <WatchGroupDialog client={client} open groups={groups} stock={watchTarget} mode="add" onClose={() => setWatchTarget(null)} onGroups={(next) => { onGroups(next); setWatchTarget(null); onClose() }} notify={notify} />}</div>
}

function Page({ children }: { children: ReactNode }) {
  return <div className={styles['page']}>{children}</div>
}

function PageHeader({ title, description, meta, action }: { title: ReactNode; description?: string; meta?: ReactNode; action?: ReactNode }) {
  return <header className={styles['pageHeader']}><div><h1>{title}</h1>{description !== undefined && <p>{description}</p>}</div>{meta !== undefined && <div className={styles['pageMeta']}>{meta}</div>}{action !== undefined && <div className={styles['pageActions']}>{action}</div>}</header>
}

function PanelHead({ title, hint, extra }: { title: string; hint?: string; extra?: ReactNode }) {
  return <header className={styles['panelHead']}><div><h2>{title}</h2>{hint !== undefined && <span>{hint}</span>}</div>{extra}</header>
}

function ThemeToggle({ theme, onToggle }: { theme: ThemeId; onToggle: () => void }) {
  const target = theme === 'dark' ? '亮色' : '黑夜'
  return <button className={styles['themeToggle']} title={`切换为${target}模式`} aria-label={`切换为${target}模式`} onClick={onToggle}>{theme === 'dark' ? '☀' : '☾'}</button>
}

function FullscreenToggle() {
  const [supported, setSupported] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    const syncFullscreen = () => {
      setSupported(
        document.fullscreenEnabled === true
        && typeof document.documentElement.requestFullscreen === 'function'
        && typeof document.exitFullscreen === 'function',
      )
      setFullscreen(document.fullscreenElement !== null)
    }
    syncFullscreen()
    document.addEventListener('fullscreenchange', syncFullscreen)
    return () => document.removeEventListener('fullscreenchange', syncFullscreen)
  }, [])

  if (!supported) return null
  const label = fullscreen ? '退出网页全屏' : '进入网页全屏'
  const toggle = async () => {
    try {
      if (document.fullscreenElement === null) await document.documentElement.requestFullscreen({ navigationUI: 'hide' })
      else await document.exitFullscreen()
    } catch {
      // The browser may reject fullscreen when user activation or permissions are unavailable.
    }
  }

  return (
    <button className={styles['fullscreenToggle']} title={label} aria-label={label} onClick={() => void toggle()}>
      {fullscreen ? <ExitFullscreenIcon /> : <EnterFullscreenIcon />}
    </button>
  )
}

function EnterFullscreenIcon() {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" /></svg>
}

function ExitFullscreenIcon() {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" /></svg>
}

function DataStateBadge({ meta, marketStatus, refreshFailed = false, liveCapable = true }: { meta: ProviderMeta | null | undefined; marketStatus?: DashboardData['overview']['marketStatus']; refreshFailed?: boolean; liveCapable?: boolean }) {
  const state = describeDataStatus(meta, { ...(marketStatus === undefined ? {} : { marketStatus }), ...(refreshFailed ? { refreshFailed: true } : {}), ...(!liveCapable ? { liveCapable: false } : {}) })
  return <span className={`${styles['dataState']} ${styles[`dataState_${state.kind}`]}`} data-data-status={state.kind} title={state.detail}>{state.label}</span>
}

function DataSourceText({ meta }: { meta: ProviderMeta | null | undefined }) {
  if (meta === null || meta === undefined) return <small className={styles['dataSource']}>来源元数据未提供</small>
  const timestamp = meta.sourceTimestamp === null ? `获取 ${dateTime(meta.fetchedAt)}` : `数据 ${dateTime(meta.sourceTimestamp)}`
  return <small className={styles['dataSource']}>{meta.sourceName} · {timestamp}</small>
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return <div className={styles['metric']}><span>{label}</span><b className={tone === undefined ? undefined : styles[tone]}>{value}</b></div>
}

function KeyValue({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className={styles['keyValue']}><span>{label}</span><b className={mono ? styles['mono'] : undefined}>{value}</b></div>
}

function SourceRow({ title, detail, available }: { title: string; detail: string; available: boolean }) {
  return <div className={styles['sourceRow']}><span className={`${styles['statusDot']} ${available ? styles['statusOk'] : styles['statusUnknown']}`} /><div><b>{title}</b><small>{detail}</small></div></div>
}

function SettingsMetric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><b>{value}</b></div>
}

function Status({ status }: { status: Judgement['reportStatus'] }) {
  const labels: Record<Judgement['reportStatus'], string> = { preparing: '正在准备', generating: '研判进行中', verifying: '正在整理报告', repairing: '正在修复报告', ready: '已完成', revising: '正在修订', failed: '未完成' }
  return <span className={`${styles['status']} ${styles[`status_${status}`]}`}>{isReportInFlight(status) && <i />}{labels[status]}</span>
}

function Empty({ title, detail, action, compact = false }: { title: string; detail: string; action?: ReactNode; compact?: boolean }) {
  return <div className={`${styles['empty']} ${compact ? styles['emptyCompact'] : ''}`}><span>◇</span><b>{title}</b><p>{detail}</p>{action}</div>
}

function Splash({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className={styles['splash']} data-hanai-root><BrandMark splash /><p>HANAI WORTH · 值见</p><h1>{title}</h1><span>{detail}</span>{action}</div>
}

function BrandMark({ splash = false }: { splash?: boolean }) {
  return (
    <span className={splash ? styles['splashMark'] : styles['brandMark']} aria-hidden="true">
      <svg viewBox="0 0 34 34" focusable="false">
        <g className={styles['brandCandles']}>
          <path d="M7 25V18M5.8 20H8.2V24H5.8Z" />
          <path d="M12 22V14M10.8 16H13.2V21H10.8Z" />
          <path d="M17 18V10M15.8 12H18.2V17H15.8Z" />
          <path d="M22 14V6M20.8 8H23.2V13H20.8Z" />
          <path d="M27 10V2.8M25.8 4.5H28.2V9H25.8Z" />
        </g>
        <path className={styles['brandPriceLine']} d="M 3 28 C 9 28 11 22 17 20 C 23 18 27 15 31 10" />
        <path className={styles['brandValueLine']} d="M 3 31 C 10 30 14 27 18 21 C 23 14 27 8 31 3" />
        <circle className={styles['brandEvidencePoint']} cx="18" cy="21" r="1.9" />
      </svg>
    </span>
  )
}

function PageSkeleton({ cards }: { cards: number }) {
  return <div className={styles['skeletonGrid']}>{Array.from({ length: cards }, (_, index) => <div key={index}><i /><i /><i /></div>)}</div>
}

function Modal({ title, subtitle, onClose, children, wide = false, extraWide = false }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; wide?: boolean; extraWide?: boolean }) {
  return <div className={styles['modalBackdrop']} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section className={`${styles['modal']} ${wide ? styles['modalWide'] : ''} ${extraWide ? styles['modalExtraWide'] : ''}`} role="dialog" aria-modal="true" aria-label={title}><header><div><h2>{title}</h2>{subtitle !== undefined && <p>{subtitle}</p>}</div><button onClick={onClose} aria-label="关闭">×</button></header>{children}</section></div>
}

function emptyStockDetail(): StockDetail {
  return {
    security: null,
    quote: null,
    metrics: null,
    trend: [],
    trendPrevClose: null,
    daily: [],
    weekly: [],
    monthly: [],
    valuation: null,
    sources: {
      quote: null,
      metrics: null,
      trend: null,
      daily: null,
      weekly: null,
      monthly: null,
      valuation: null,
    },
  }
}

function fundamentalMetrics(metrics: StockDetail['metrics']): Array<{ label: string; value: string; tone?: 'up' | 'down' }> {
  const result: Array<{ label: string; value: string; tone?: 'up' | 'down' }> = [
    { label: 'PE(动)', value: positiveNumber(metrics?.peDynamic) },
    { label: 'PE(静)', value: positiveNumber(metrics?.peStatic) },
    { label: 'PE(TTM)', value: positiveNumber(metrics?.peTtm) },
    { label: 'PB', value: number(metrics?.pb ?? null) },
    { label: 'PS(TTM)', value: positiveNumber(metrics?.psTtm) },
    { label: 'ROE', value: ratio(metrics?.roe ?? null) },
    { label: '每股收益', value: number(metrics?.eps ?? null) },
    { label: '每股净资产', value: number(metrics?.bvps ?? null) },
    { label: '股息率(TTM)', value: ratio(metrics?.dividendYield ?? null) },
    { label: '总股本', value: quantity(metrics?.totalShares ?? null) },
    { label: '流通股', value: quantity(metrics?.floatShares ?? null) },
    { label: '营收', value: money(metrics?.totalRevenue ?? null) },
    { label: '净利润', value: money(metrics?.netProfit ?? null) },
    { label: '毛利率', value: ratio(metrics?.grossMargin ?? null) },
    { label: '净利率', value: ratio(metrics?.netMargin ?? null) },
    { label: '负债率', value: ratio(metrics?.debtRatio ?? null) },
  ]
  result.splice(12, 0, optionalToneMetric('营收同比', metrics?.revenueYoy))
  result.splice(14, 0, optionalToneMetric('净利同比', metrics?.netProfitYoy))
  return result
}

function optionalToneMetric(label: string, value: number | null | undefined): { label: string; value: string; tone?: 'up' | 'down' } {
  const tone = changeTone(value)
  return { label, value: percent(value ?? null), ...(tone === undefined ? {} : { tone }) }
}

function routeTitle(route: AppRoute): string {
  switch (route.page) {
    case 'dashboard': return '今日市场'
    case 'watch': return '自选与发现'
    case 'judgements':
    case 'judgement-detail': return '大师研判'
    case 'personas': return '专家中心'
    case 'settings': return '设置与诊断'
    case 'stock': return '个股研究'
  }
}

function routeFromHash(hash: string): AppRoute {
  const raw = hash.replace(/^#/, '') || '/dashboard'
  const path = raw.split('?')[0] ?? '/dashboard'
  const stock = /^\/stock\/([^/]+)$/.exec(path)
  if (stock?.[1]) return { page: 'stock', secId: decodeURIComponent(stock[1]) }
  const judgement = /^\/judgements\/([^/]+)$/.exec(path)
  if (judgement?.[1]) return { page: 'judgement-detail', judgementId: decodeURIComponent(judgement[1]) }
  if (path === '/watch') return { page: 'watch' }
  if (path === '/judgements') return { page: 'judgements' }
  if (path === '/personas') return { page: 'personas' }
  if (path === '/settings') return { page: 'settings' }
  return { page: 'dashboard' }
}

function toSearchResult(stock: Pick<StockQuote, 'secId' | 'code' | 'name' | 'price' | 'changePct'>): SearchResult {
  return { ...stock, exchange: exchangeFor(stock.secId, stock.code), pinyinFull: '', pinyinInitial: '' }
}

function exchangeFor(secId: string, code: string): SecurityMaster['exchange'] {
  if (secId.startsWith('1.')) return 'SH'
  return /^[489]/.test(code) ? 'BJ' : 'SZ'
}

function compareNullable(left: string | number | null, right: string | number | null, descending: boolean): number {
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  const result = typeof left === 'string' && typeof right === 'string' ? left.localeCompare(right, 'zh-CN') : Number(left) - Number(right)
  return result * (descending ? -1 : 1)
}

function summarizeResearchCoverage(items: readonly WatchResearchCoverage[]) {
  return {
    total: items.length,
    covered: items.filter(item => item.reportVersionCount > 0).length,
    current: items.filter(item => item.state === 'current').length,
    active: items.filter(item => item.state === 'active').length,
    stale: items.filter(item => item.state === 'stale').length,
    missing: items.filter(item => item.state === 'failed' || item.state === 'uncovered').length,
    openFollowUps: items.reduce((total, item) => total + item.openFollowUpCount, 0),
    overdueFollowUps: items.reduce((total, item) => total + item.overdueFollowUpCount, 0),
    pendingPredictions: items.reduce((total, item) => total + item.pendingPredictionCount, 0),
    duePredictions: items.reduce((total, item) => total + item.duePredictionCount, 0),
  }
}

function matchesResearchCoverageFilter(coverage: WatchResearchCoverage | undefined, filter: WatchCoverageFilter) {
  if (filter === 'all') return true
  if (filter === 'followups') return (coverage?.openFollowUpCount ?? 0) > 0
  if (filter === 'predictions') return (coverage?.pendingPredictionCount ?? 0) > 0
  const state = coverage?.state ?? 'uncovered'
  if (filter === 'missing') return state === 'uncovered' || state === 'failed'
  return state === filter
}

function revisionSuggestion(audit: ReportAudit): string {
  const incomplete = audit.checks.filter(item => item.state !== 'met')
  const focus = incomplete.length === 0
    ? '- 重新核验关键事实、估值假设、反方证据与最新信息时点。'
    : incomplete.map(item => `- ${item.label}：${item.detail}`).join('\n')
  return `请基于最新公开信息完整修订本报告，并重点处理以下事项：\n${focus}\n\n`
    + `要求：保留清晰的事实/推断/假设边界；关键主张写入证据账本并附可点击来源与日期；`
    + `若来源冲突或信息不足，明确标记不确定性，不得用推测补齐。`
}

function summarizeReportVersionChange(previous: ReportVersion, current: ReportVersion) {
  const previousSections = extractReportSections(previous.content)
  const currentSections = extractReportSections(current.content)
  const added = [...currentSections.keys()].filter(key => !previousSections.has(key))
  const removed = [...previousSections.keys()].filter(key => !currentSections.has(key))
  const changed = [...currentSections.keys()].filter(key => {
    const before = previousSections.get(key)
    return before !== undefined && normalizeReportSection(before.content) !== normalizeReportSection(currentSections.get(key)?.content ?? '')
  })
  const checkRank: Record<ReportAuditCheck['state'], number> = { missing: 0, partial: 1, met: 2 }
  const previousChecks = new Map(previous.audit.checks.map(check => [check.id, check]))
  const improvedChecks = current.audit.checks.filter(check => checkRank[check.state] > checkRank[previousChecks.get(check.id)?.state ?? 'missing']).map(check => check.label)
  const regressedChecks = current.audit.checks.filter(check => checkRank[check.state] < checkRank[previousChecks.get(check.id)?.state ?? 'missing']).map(check => check.label)
  const labels = (keys: string[], map: Map<string, { label: string; content: string }>) => keys.slice(0, 8).map(key => map.get(key)?.label ?? key)
  return {
    added: labels(added, currentSections),
    removed: labels(removed, previousSections),
    changed: labels(changed, currentSections),
    scoreDelta: current.audit.score - previous.audit.score,
    sourceDelta: current.audit.sources.length - previous.audit.sources.length,
    sizeDelta: current.sizeBytes - previous.sizeBytes,
    improvedChecks,
    regressedChecks,
  }
}

function extractReportSections(content: string): Map<string, { label: string; content: string }> {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const sections = new Map<string, { label: string; content: string }>()
  let label = '报告开篇'
  let key = '报告开篇'
  let body: string[] = []
  const store = () => {
    const text = body.join('\n').trim()
    if (text === '' && sections.size > 0) return
    const existing = sections.get(key)
    sections.set(key, { label, content: existing === undefined ? text : `${existing.content}\n${text}` })
  }
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading === null) { body.push(line); continue }
    store()
    label = cleanReportHeading(heading[1] ?? '')
    key = normalizeComparableText(label)
    body = []
  }
  store()
  return sections
}

function cleanReportHeading(value: string): string {
  return value.replace(/[*_~`#]/g, '').replace(/^[\d一二三四五六七八九十百]+[.、．\s-]*/, '').trim() || '未命名章节'
}

function normalizeReportSection(value: string): string {
  return value
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/[*_~`>#|:\-]/g, '')
    .replace(/[\s，。；：、,.!！?？]/g, '')
    .toLowerCase()
}

function signedDelta(value: number, suffix = ''): string {
  if (value === 0) return '无变化'
  return `${value > 0 ? '+' : ''}${value}${suffix}`
}

function extractMonitoringItems(content: string): string[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex(line => /^#{1,6}\s+.*(待持续验证|持续跟踪|跟踪清单|观察清单|监测清单|下一步)/i.test(line))
  if (start < 0) return []
  const level = /^#+/.exec(lines[start] ?? '')?.[0].length ?? 6
  const items: string[] = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const heading = /^(#{1,6})\s+/.exec(line)
    if (heading !== null && heading[1]!.length <= level) break
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+)$/.exec(line)
    if (bullet === null) continue
    const raw = bullet[1]!.trim()
    const boldLead = /^\*\*([^*]+)\*\*/.exec(raw)?.[1]
    const title = (boldLead ?? raw)
      .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
      .replace(/[*_~`>#]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160)
    if (title !== '' && !items.some(item => normalizeComparableText(item) === normalizeComparableText(title))) {
      items.push(title)
    }
  }
  return items
}

function normalizeComparableText(value: string): string {
  return value.trim().replace(/[\s，。；：、,.!！?？]/g, '').toLowerCase()
}

function sortResearchFollowUps<T extends ResearchFollowUp>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => {
    if (left.status !== right.status) return left.status === 'open' ? -1 : 1
    if (left.dueDate !== right.dueDate) {
      if (left.dueDate === null) return 1
      if (right.dueDate === null) return -1
      return left.dueDate.localeCompare(right.dueDate)
    }
    return right.createdAt.localeCompare(left.createdAt)
  })
}

function sortResearchPredictions<T extends ResearchPrediction>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => {
    const leftPending = left.outcome === 'pending'
    const rightPending = right.outcome === 'pending'
    if (leftPending !== rightPending) return leftPending ? -1 : 1
    if (left.dueDate !== right.dueDate) return left.dueDate.localeCompare(right.dueDate)
    return right.createdAt.localeCompare(left.createdAt)
  })
}

function predictionOutcomeLabel(outcome: ResearchPrediction['outcome']): string {
  if (outcome === 'occurred') return '已发生'
  if (outcome === 'not-occurred') return '未发生'
  if (outcome === 'invalid') return '无法判定'
  return '待判定'
}

async function copyPlainText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText !== undefined) {
    await navigator.clipboard.writeText(value)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.readOnly = true
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  const copied = document.execCommand?.('copy') ?? false
  textarea.remove()
  if (!copied) throw new Error('浏览器未开放剪贴板权限')
}

function downloadMarkdown(content: string, fileName: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName.replace(/[^\p{L}\p{N}._-]+/gu, '-')
  anchor.style.display = 'none'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function localDateKey(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

function highlight(value: string, query: string): ReactNode {
  const index = value.toLowerCase().indexOf(query.toLowerCase())
  if (index < 0) return value
  return <>{value.slice(0, index)}<mark>{value.slice(index, index + query.length)}</mark>{value.slice(index + query.length)}</>
}

function positiveNumber(value: number | null | undefined): string {
  return value !== null && value !== undefined && value > 0 ? number(value) : '—'
}

function signedNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${value > 0 ? '+' : ''}${number(value)}`
}

function changeTone(value: number | null | undefined): 'up' | 'down' | undefined {
  if (value === null || value === undefined || value === 0) return undefined
  return value > 0 ? 'up' : 'down'
}

function dateOnly(value: string | null): string {
  return value === null ? '—' : value.slice(0, 10)
}

function shortTime(value: string | null): string {
  if (value === null) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB'] as const
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const scaled = value / 1024 ** index
  return `${scaled >= 100 || index === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[index]}`
}

function valuationRank(rank: number | null): string {
  if (rank === null) return '—'
  return ({ 0: '数据不足', 1: '数据陈旧', 2: '价值陷阱嫌疑', 3: '严重低估', 4: '低估', 5: '合理范围', 6: '高估', 7: '严重高估' } as Record<number, string>)[rank] ?? `等级 ${rank}`
}

function signedPriceGap(value: number): string {
  return `${value >= 0 ? '+' : ''}${number(value)} 元`
}

function isReportInFlight(status: Judgement['reportStatus']): boolean {
  return ['preparing', 'generating', 'verifying', 'repairing', 'revising'].includes(status)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type Notify = (text: string, kind?: Notice['kind']) => void
