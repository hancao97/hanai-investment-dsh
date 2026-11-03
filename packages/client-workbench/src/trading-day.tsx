import { useMemo, type ReactNode } from 'react'
import type { EChartsCoreOption } from 'echarts/core'
import type {
  TradingDayAnalysisData,
  TradingDayContextData,
  TradingDayDragonTigerData,
  TradingDayLimitPoolsData,
  TradingDayRole,
  TradingDayScenarioKind,
  TradingDaySectorSignal,
  TradingDayThemesData,
  TradingDayTrend,
} from '../../contracts/src/index.ts'
import type { ChartPalette } from './chart-options.ts'
import { EChart } from './echarts.tsx'
import { classForChange, money, number, percent, quantity, ratio } from './format.ts'
import styles from './trading-day.module.css'

export type TradingDayGroupKey = 'context' | 'limitPools' | 'themes' | 'dragonTiger'
export type TradingDayGroupErrors = Partial<Record<TradingDayGroupKey, string>>
export type TradingDayMode = 'live' | 'history'

export interface TradingDayPanelProps {
  mode: TradingDayMode
  limitPools: TradingDayLimitPoolsData | null
  themes: TradingDayThemesData | null
  dragonTiger: TradingDayDragonTigerData | null
  analysis: TradingDayAnalysisData | null
  errors: TradingDayGroupErrors
  analysisError: string | null
  loading: boolean
  analyzing: boolean
  sessionNotice: string | null
  refreshFailed: boolean
  onRetryGroup: (key: TradingDayGroupKey) => void
  onRetryAnalysis: () => void
}

const LADDER_STOCK_LIMIT = 10
const THEME_LIMIT = 8
const THEME_LEADER_LIMIT = 3
const DRAGON_TIGER_LIMIT = 20

const SCENARIO_LABEL: Record<TradingDayScenarioKind, string> = {
  above: '强于预期',
  match: '符合预期',
  below: '弱于预期',
}

const ROLE_LABEL: Record<string, string> = {
  leader: '龙头',
  center: '中军',
  follow: '跟随',
  unknown: '待确认',
}

/** "今日交易数据" section: intraday context, limit pools, themes, LHB and the review drawer. */
export function TradingDayPanel({
  mode,
  limitPools,
  themes,
  dragonTiger,
  analysis,
  errors,
  analysisError,
  loading,
  analyzing,
  sessionNotice,
  refreshFailed,
  onRetryGroup,
  onRetryAnalysis,
}: TradingDayPanelProps) {
  return (
    <section className={styles['panel']} aria-label="今日交易数据">
      <header className={styles['sectionHead']}>
        <div>
          <h2>今日交易数据</h2>
        </div>
        <div className={styles['sectionMeta']}>
          {refreshFailed && <span className={styles['refreshFailed']}>刷新失败 · 保留上次数据</span>}
          {sessionNotice !== null && <span className={styles['sessionNotice']}>{sessionNotice}</span>}
        </div>
      </header>

      {/* 结论与情绪指标左右布局，宽度与上方「板块热力 / 榜单」一致。 */}
      <div className={styles['verdictSplit']}>
        <VerdictBar analysis={analysis} error={analysisError} analyzing={analyzing} onRetry={onRetryAnalysis} />
        <SentimentBand
          limitPools={limitPools}
          error={errors.limitPools}
          loading={loading}
          mode={mode}
          onRetry={() => onRetryGroup('limitPools')}
        />
      </div>

      <div className={styles['grid']}>
        <LadderCard
          limitPools={limitPools}
          error={errors.limitPools}
          loading={loading}
          mode={mode}
          onRetry={() => onRetryGroup('limitPools')}
        />
        <ThemesCard
          themes={themes}
          error={errors.themes}
          loading={loading}
          mode={mode}
          onRetry={() => onRetryGroup('themes')}
        />
        <ReviewCard
          analysis={analysis}
          error={analysisError}
          analyzing={analyzing}
          dragonTiger={dragonTiger}
          dragonError={errors.dragonTiger}
          loading={loading}
          mode={mode}
          onRetryDragon={() => onRetryGroup('dragonTiger')}
          onRetry={onRetryAnalysis}
        />
      </div>
    </section>
  )
}

function VerdictBar({
  analysis,
  error,
  analyzing,
  onRetry,
}: {
  analysis: TradingDayAnalysisData | null
  error: string | null
  analyzing: boolean
  onRetry: () => void
}) {
  const verdict = analysis?.verdict ?? null
  const gaps = [...(verdict?.gaps ?? []), ...(analysis?.missingReasons ?? [])]
  return (
    <article className={`${styles['card']} ${styles['verdict']}`} aria-label="短线交易数据结论">
      <div className={styles['verdictHead']}>
        <span className={styles['eyebrow']}>短线交易数据结论</span>
        <p>{verdict?.summary ?? (analyzing ? '分析生成中…' : '分析尚未生成')}</p>
      </div>
      <div className={styles['verdictGrid']}>
        <VerdictItem label="情绪阶段" value={verdict?.stage ?? '—'} />
        <VerdictItem label="周期位置" value={verdict?.position ?? '—'} />
        <VerdictItem label="情绪温度" value={verdict?.temperature ?? '—'} />
        <VerdictItem label="置信度" value={confidenceText(verdict?.confidence ?? null)} />
        {gaps.length > 0 && <VerdictItem label="数据缺口" value={gaps.join('；')} wide />}
      </div>
      {error !== null && (
        <div className={styles['analysisError']} role="alert">
          <b>分析不可用：</b>
          <span>{error}</span>
          <button className={styles['retry']} onClick={onRetry}>重试分析</button>
        </div>
      )}
    </article>
  )
}

function VerdictItem({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={cx(styles['verdictItem'], wide && styles['verdictItemWide'])}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  )
}

/** 指数分时卡片：跟随指数选择切换，与「市场宽度」并排。 */
export function IndexIntradayCard({
  context,
  error,
  loading,
  mode,
  palette,
  selectedCode,
  sectorSignals,
  onRetry,
}: {
  context: TradingDayContextData | null
  error: string | undefined
  loading: boolean
  mode: TradingDayMode
  palette: ChartPalette
  selectedCode: string
  /** 仅在上证（sh000001）显示板块异动信号。 */
  sectorSignals?: TradingDaySectorSignal[]
  onRetry: () => void
}) {
  const trends = context?.trends ?? (context?.trend === null || context?.trend === undefined ? [] : [context.trend])
  const trend = trends.find(item => item.code === selectedCode) ?? trends.find(item => item.code === 'sh000001') ?? trends[0] ?? null
  // 只在上证时叠加板块异动信号
  const signals = selectedCode === 'sh000001' ? (sectorSignals ?? []) : []
  const option = useMemo(() => buildIntradayOption(trend, palette, signals), [trend, palette, signals])
  return (
    <Card title="指数分时" extra={<FailureBadge error={error} data={context} />}>
      {context === null
        ? missingState(error, loading, mode, onRetry)
        : <>
          <div className={styles['chartMeta']}>
            <span>{trend?.name ?? '上证指数'} · {trend?.date ?? context.tradeDate}</span>
            <span>昨收 {number(trend?.prevClose ?? null)}</span>
            {signals.length > 0 && <span style={{ color: palette.up, fontSize: 10 }}>板块异动 {signals.length} 条</span>}
            {selectedCode === 'sh000001' && signals.length === 0 && <span style={{ color: palette.axisLabel, fontSize: 10 }}>板块异动 0</span>}
          </div>
          {option === null
            ? <p className={styles['emptyNote']}>暂无分时数据</p>
            : <EChart option={option} {...(styles['intradayChart'] === undefined ? {} : { className: styles['intradayChart'] })} ariaLabel="指数分时走势图" />}
        </>}
    </Card>
  )
}

function SentimentBand({
  limitPools,
  error,
  loading,
  mode,
  onRetry,
}: {
  limitPools: TradingDayLimitPoolsData | null
  error: string | undefined
  loading: boolean
  mode: TradingDayMode
  onRetry: () => void
}) {
  const stats = limitPools?.stats ?? null
  return (
    <Card
      title="情绪指标"
      extra={<>
        {stats !== null && <span>涨停 {countText(stats.limitUp)} · 跌停 {countText(stats.limitDown)} · 炸板 {countText(stats.broken)}</span>}
        <FailureBadge error={error} data={limitPools} />
      </>}
    >
      {limitPools === null
        ? missingState(error, loading, mode, onRetry)
        : <div className={styles['statBand']}>
          <Stat label="封板率" value={ratio(stats?.sealRate ?? null)} />
          <Stat label="炸板率" value={ratio(stats?.breakRate ?? null)} />
          <Stat label="最高板" value={boardText(stats?.maxBoard ?? null)} />
          <Stat label="首板" value={`${countText(stats?.firstBoard ?? null)} 家`} />
          <Stat label="连板" value={`${countText(stats?.lianban ?? null)} 家`} />
        </div>}
    </Card>
  )
}

function LadderCard({
  limitPools,
  error,
  loading,
  mode,
  onRetry,
}: {
  limitPools: TradingDayLimitPoolsData | null
  error: string | undefined
  loading: boolean
  mode: TradingDayMode
  onRetry: () => void
}) {
  const ladder = limitPools?.ladder ?? []
  return (
    <Card title="涨停梯队" span={7} extra={limitPools === null ? <FailureBadge error={error} data={limitPools} /> : <span>每档最多 {LADDER_STOCK_LIMIT} 只</span>}>
      {limitPools === null
        ? missingState(error, loading, mode, onRetry)
        : ladder.length === 0
          ? <p className={styles['emptyNote']}>暂无涨停梯队数据</p>
          : <div className={styles['ladder']}>
            {ladder.map(group => (
              <section className={styles['ladderGroup']} key={`${group.board}-${group.label}`} aria-label={`${group.label}梯队`}>
                <h4>{group.label || `${group.board} 板`}<small>{group.count} 只</small></h4>
                {group.stocks.length === 0
                  ? <p className={styles['emptyNote']}>该档暂无个股</p>
                  : <table className={styles['table']}>
                    <thead><tr><th>名称</th><th>板型</th><th>原因</th></tr></thead>
                    <tbody>
                      {group.stocks.slice(0, LADDER_STOCK_LIMIT).map(stock => (
                        <tr key={stock.code}>
                          <td><b>{stock.name}</b><small>{stock.code}</small></td>
                          <td>{stock.boardType ?? '—'}</td>
                          <td className={styles['reason']}>{stock.reason ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>}
              </section>
            ))}
          </div>}
    </Card>
  )
}

function ThemesCard({
  themes,
  error,
  loading,
  mode,
  onRetry,
}: {
  themes: TradingDayThemesData | null
  error: string | undefined
  loading: boolean
  mode: TradingDayMode
  onRetry: () => void
}) {
  const items = themes?.themes ?? []
  const drives = themes?.drives ?? []
  return (
    <Card title="题材驱动" span={5} extra={themes === null ? <FailureBadge error={error} data={themes} /> : <span>前 {THEME_LIMIT} 个题材</span>}>
      {themes === null
        ? missingState(error, loading, mode, onRetry)
        : items.length === 0
          ? <p className={styles['emptyNote']}>暂无题材驱动数据</p>
          : <>
            <ul className={styles['themeList']}>
              {items.slice(0, THEME_LIMIT).map(theme => (
                <li key={theme.name}>
                  <div className={styles['themeHead']}>
                    <b>{theme.name}</b>
                    <span>{theme.count} 家 · 最高 {countText(theme.maxBoard)} 板</span>
                  </div>
                  <p>{theme.leaders.length === 0 ? '暂无龙头' : theme.leaders.slice(0, THEME_LEADER_LIMIT).join(' · ')}</p>
                </li>
              ))}
            </ul>
            {drives.length > 0 && <div className={styles['driveNote']}>驱动标签：{drives.slice(0, 6).map(drive => drive.tag).join(' / ')}</div>}
          </>}
    </Card>
  )
}

/** 晋级率与昨日涨停表现：嵌入「市场宽度」面板的空白区，不单独占卡片。 */
export function LimitPoolHighlights({
  limitPools,
  error,
  loading,
  mode,
  onRetry,
}: {
  limitPools: TradingDayLimitPoolsData | null
  error: string | undefined
  loading: boolean
  mode: TradingDayMode
  onRetry: () => void
}) {
  const stats = limitPools?.stats ?? null
  const performance = limitPools?.yesterdayPerformance ?? null
  const missing = limitPools === null ? missingState(error, loading, mode, onRetry) : null
  return (
    <div className={styles['breadthHighlights']}>
      <section className={styles['highlightBlock']} aria-label="晋级率">
        <header className={styles['highlightHead']}>
          <h4>晋级率</h4>
          <FailureBadge error={error} data={limitPools} />
        </header>
        {missing ?? <>
          <div className={styles['highlightValue']}>
            <b>{ratio(stats?.promotionRate ?? null)}</b>
            <span>昨日涨停今日晋级比例</span>
          </div>
          <small className={styles['highlightNote']}>首板 {countText(stats?.firstBoard ?? null)} 家 · 连板 {countText(stats?.lianban ?? null)} 家 · 最高 {boardText(stats?.maxBoard ?? null)}</small>
        </>}
      </section>
      <section className={styles['highlightBlock']} aria-label="昨日涨停表现">
        <header className={styles['highlightHead']}>
          <h4>昨日涨停表现</h4>
        </header>
        {missing ?? <div className={styles['highlightStats']}>
          <Stat label="样本" value={`${countText(performance?.sample ?? null)} 家`} />
          <Stat label="晋级" value={`${countText(performance?.promoted ?? null)} 家`} />
          <Stat label="平均涨跌" value={percent(performance?.avgChangePct ?? null)} tone={classForChange(performance?.avgChangePct ?? null)} />
          <Stat label="中位涨跌" value={percent(performance?.medianChangePct ?? null)} tone={classForChange(performance?.medianChangePct ?? null)} />
          <Stat label="上涨占比" value={ratio(performance?.upRate ?? null)} />
        </div>}
      </section>
    </div>
  )
}

function ReviewCard({
  analysis,
  error,
  analyzing,
  dragonTiger,
  dragonError,
  loading,
  mode,
  onRetryDragon,
  onRetry,
}: {
  analysis: TradingDayAnalysisData | null
  error: string | null
  analyzing: boolean
  dragonTiger: TradingDayDragonTigerData | null
  dragonError: string | undefined
  loading: boolean
  mode: TradingDayMode
  onRetryDragon: () => void
  onRetry: () => void
}) {
  const dragonEntries = dragonTiger?.entries ?? []
  return (
    <article className={cx(styles['card'], styles['span12'], styles['reviewCard'])} aria-label="复盘分析">
      <details className={styles['review']}>
        <summary className={styles['reviewSummary']}>
          <span>复盘分析</span>
          <small>四轴 · 主线分级 · 角色梯队 · 龙虎榜 · 次日剧本</small>
        </summary>
        <div className={styles['reviewBody']}>
          {error !== null && (
            <div className={styles['analysisError']} role="alert">
              <b>分析不可用：</b>
              <span>{error}</span>
              <button className={styles['retry']} onClick={onRetry}>重试分析</button>
            </div>
          )}
          {analysis === null
            ? <p className={styles['emptyNote']}>{analyzing ? '分析生成中…' : '暂无分析数据'}</p>
            : <>
              <section className={styles['reviewSection']} aria-label="分析四轴">
                <h4>四轴</h4>
                <div className={styles['axisGrid']}>
                  {analysis.axes.map(axis => (
                    <div className={styles['axis']} key={axis.key}>
                      <div className={styles['axisHead']}><b>{axis.label}</b><span>{axis.value}</span></div>
                      <p>{axis.detail}</p>
                      {axis.evidence.length > 0 && <small>依据：{axis.evidence.join('；')}</small>}
                      {axis.missing.length > 0 && <small className={styles['gap']}>缺口：{axis.missing.join('；')}</small>}
                    </div>
                  ))}
                </div>
              </section>

              <section className={styles['reviewSection']} aria-label="主线分级">
                <h4>主线分级</h4>
                {analysis.mainlines.length === 0
                  ? <p className={styles['emptyNote']}>暂无主线评级</p>
                  : <div className={styles['tableScroll']}><table className={styles['table']}>
                    <thead><tr><th>主线</th><th>评级</th><th>阶段</th><th>高度</th><th>宽度</th><th>深度</th><th>得分</th></tr></thead>
                    <tbody>
                      {analysis.mainlines.map(mainline => (
                        <tr key={mainline.name}>
                          <td><b>{mainline.name}</b><small>{mainline.missing.length > 0 ? `缺口：${mainline.missing.join('；')}` : mainline.evidence.join('；')}</small></td>
                          <td>{mainline.grade === 'unknown' ? '待确认' : mainline.grade}</td>
                          <td>{mainline.stage}</td>
                          <td>{countText(mainline.height)}</td>
                          <td>{countText(mainline.width)}</td>
                          <td>{countText(mainline.depth)}</td>
                          <td>{countText(mainline.score)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table></div>}
              </section>

              <div className={styles['reviewSplit']}>
                <section className={styles['reviewSection']} aria-label="角色梯队">
                  <h4>角色梯队</h4>
                  <div className={styles['rolePanel']}>
                    <RoleGroup title="龙头" roles={analysis.leaders} />
                    <RoleGroup title="中军" roles={analysis.centerCandidates} />
                  </div>
                </section>

                <section className={styles['reviewSection']} aria-label="龙虎榜">
                  <h4>龙虎榜<small className={styles['sectionNote']}>前 {DRAGON_TIGER_LIMIT} 只</small></h4>
                  <div className={styles['rolePanel']}>
                    {dragonTiger === null
                      ? missingState(dragonError, loading, mode, onRetryDragon)
                      : dragonEntries.length === 0
                        ? <p className={styles['emptyNote']}>暂无龙虎榜数据</p>
                        : <div className={styles['tableScroll']}><table className={styles['table']}>
                          <thead><tr><th>名称</th><th>上榜原因</th><th>净买入</th><th>涨跌幅</th><th>换手率</th></tr></thead>
                          <tbody>
                            {dragonEntries.slice(0, DRAGON_TIGER_LIMIT).map(entry => (
                              <tr key={entry.code}>
                                <td><b>{entry.name}</b><small>{entry.code}</small></td>
                                <td className={styles['reason']}>{entry.reason ?? '—'}</td>
                                <td>{money(entry.netBuy)}</td>
                                <td className={styles[classForChange(entry.changePct)]}>{percent(entry.changePct)}</td>
                                <td>{ratio(entry.turnoverRate)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table></div>}
                  </div>
                </section>
              </div>

              <section className={styles['reviewSection']} aria-label="次日剧本">
                <h4>次日三套剧本</h4>
                <div className={styles['scenarioGrid']}>
                  {analysis.scenarios.map(scenario => (
                    <article className={styles['scenario']} key={scenario.kind}>
                      <span className={styles['scenarioKind']}>{SCENARIO_LABEL[scenario.kind]}</span>
                      <b>{scenario.title}</b>
                      <small>触发：{scenario.trigger}</small>
                      <small>应对：{scenario.response}</small>
                    </article>
                  ))}
                </div>
              </section>

              <footer className={styles['reviewFoot']}>
                <span>分析覆盖 {analysis.coverage.analyzed}/{analysis.coverage.total} · 跳过 {analysis.coverage.skipped}</span>
                {analysis.missingReasons.length > 0 && <span>缺口：{analysis.missingReasons.join('；')}</span>}
              </footer>
            </>}
        </div>
      </details>
    </article>
  )
}

function RoleGroup({ title, roles }: { title: string; roles: TradingDayRole[] }) {
  return (
    <div className={styles['roleGroup']}>
      <h5>{title}</h5>
      {roles.length === 0
        ? <p className={styles['emptyNote']}>暂无{title}</p>
        : <ul>
          {roles.map(role => (
            <li key={`${title}-${role.code}`}>
              <div><b>{role.name}</b><span>{ROLE_LABEL[role.role] ?? role.role}</span></div>
              <small>{boardText(role.boardCount)} · RS5 {number(role.rs5)} · RS20 {number(role.rs20)} · 市值 {money(role.marketCap)}</small>
              {role.note !== '' && <small className={styles['roleNote']}>{role.note}</small>}
            </li>
          ))}
        </ul>}
    </div>
  )
}

function Card({
  title,
  span,
  extra,
  children,
}: {
  title: string
  span?: 4 | 5 | 6 | 7 | 8 | 12
  extra?: ReactNode
  children: ReactNode
}) {
  return (
    <article className={cx(styles['card'], span === undefined ? undefined : styles[`span${span}`])} aria-label={title}>
      <header className={styles['cardHead']}>
        <h3>{title}</h3>
        <div className={styles['headExtra']}>{extra}</div>
      </header>
      {children}
    </article>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' | 'flat' }) {
  return (
    <div className={styles['stat']}>
      <span>{label}</span>
      <b className={tone === undefined ? undefined : styles[tone]}>{value}</b>
    </div>
  )
}

function FailureBadge({ error, data }: { error: string | undefined; data: unknown }) {
  if (error === undefined || error === '' || data === null) return null
  return <span className={styles['refreshFailed']}>刷新失败</span>
}

function Unavailable({ message, mode, onRetry }: { message: string; mode: TradingDayMode; onRetry: () => void }) {
  return (
    <div className={styles['unavailable']}>
      <b>不可用</b>
      <span>{message}</span>
      {mode === 'live' && <button className={styles['retry']} onClick={onRetry}>重试</button>}
    </div>
  )
}

function missingState(error: string | undefined, loading: boolean, mode: TradingDayMode, onRetry: () => void): ReactNode {
  if (error !== undefined && error !== '') return <Unavailable message={error} mode={mode} onRetry={onRetry} />
  return <p className={styles['emptyNote']}>{loading ? '加载中…' : mode === 'history' ? '快照未包含此分组' : '暂无数据'}</p>
}

export function buildIntradayOption(
  trend: TradingDayTrend | null,
  palette: ChartPalette,
  signals: TradingDaySectorSignal[] = [],
): EChartsCoreOption | null {
  if (trend === null || trend.points.length === 0) return null
  const points = trend.points
  const times = points.map(point => point.time)
  const axis = {
    axisLine: { lineStyle: { color: palette.axisLine } },
    axisLabel: { color: palette.axisLabel, fontSize: 10, hideOverlap: true, formatter: intradayClock },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: palette.splitLine } },
  }

  // markPoint：板块异动信号映射到 X 轴 index
  const markPointData = signals.map(signal => {
    const index = points.findIndex(pt => pt.time === signal.time)
    if (index < 0) return null
    const price = points[index]?.price
    if (price === undefined) return null
    // 同花顺快讯只给出涨/跌方向，没有具体涨跌幅，此时标签只显示板块名。
    const up = signal.changePct === null ? signal.direction !== 'down' : signal.changePct >= 0
    const text = signal.changePct === null
      ? signal.name
      : (signal.changePct > 0 ? '+' : '') + signal.changePct.toFixed(1) + '% ' + signal.name
    return {
      coord: [index, price],
      itemStyle: { color: up ? palette.up : palette.down },
      label: {
        show: true,
        position: 'top',
        distance: 6,
        fontSize: 10,
        fontWeight: 600,
        color: up ? palette.up : palette.down,
        formatter: text,
      },
      symbolSize: 7,
    }
  }).filter((item): item is NonNullable<typeof item> => item !== null)
  return {
    animation: false,
    legend: {
      data: ['价格', '均价'],
      top: 0,
      left: 'center',
      itemWidth: 9,
      itemHeight: 6,
      itemGap: 16,
      textStyle: { color: palette.legendText, fontSize: 10 },
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: palette.tooltipBackground,
      borderColor: palette.tooltipBorder,
      textStyle: { color: palette.tooltipText, fontSize: 11 },
      formatter: (raw: unknown): string => {
        const list = Array.isArray(raw) ? raw as Array<{ dataIndex?: number }> : []
        const index = list[0]?.dataIndex
        const point = index === undefined ? undefined : points[index]
        if (point === undefined) return ''
        const lines = [`<b>${escapeText(point.time)}</b>`]
        lines.push(`<span style="color:${palette.gold}">●</span> 价格 <b>${number(point.price)}</b>`)
        if (point.avgPrice !== null) {
          lines.push(`<span style="color:${palette.averageBlue}">●</span> 均价 <b>${number(point.avgPrice)}</b>`)
        }
        lines.push(`<span style="color:${palette.flat}">●</span> 成交量 <b>${quantity(point.volume)}</b>`)
        return lines.join('<br/>')
      },
    },
    grid: [
      { left: 50, right: 12, top: 22, height: '58%' },
      { left: 50, right: 12, top: '78%', height: '16%' },
    ],
    xAxis: [
      { type: 'category', data: times, gridIndex: 0, boundaryGap: false, ...axis },
      { type: 'category', data: times, gridIndex: 1, boundaryGap: false, ...axis, axisLabel: { show: false } },
    ],
    yAxis: [
      { scale: true, gridIndex: 0, ...axis, axisLabel: { color: palette.axisLabel, fontSize: 10 } },
      { gridIndex: 1, axisLabel: { show: false }, splitLine: { show: false } },
    ],
    series: [
      {
        name: '价格',
        type: 'line',
        data: points.map(point => point.price),
        showSymbol: false,
        lineStyle: { color: palette.gold, width: 1.4 },
        areaStyle: { color: palette.goldArea },
        markLine: trend.prevClose === null
          ? undefined
          : {
            symbol: 'none',
            label: { show: false },
            lineStyle: { color: palette.axisLabel, type: 'dashed', width: 1 },
            data: [{ yAxis: trend.prevClose }],
          },
        ...(markPointData.length === 0 ? {} : {
          markPoint: {
            silent: true,
            z: 10,
            tooltip: { show: false },
            symbolSize: 7,
            data: markPointData,
          },
        }),
      },
      {
        name: '均价',
        type: 'line',
        data: points.map(point => point.avgPrice),
        showSymbol: false,
        lineStyle: { color: palette.averageBlue, width: 1 },
      },
      {
        name: '成交量',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: points.map((point, index) => {
          const previousPrice = index === 0 ? trend.prevClose : points[index - 1]?.price
          const color = previousPrice === null || previousPrice === undefined || point.price === previousPrice
            ? palette.flatBar
            : point.price > previousPrice ? palette.upBar : palette.downBar
          return { value: point.volume, itemStyle: { color } }
        }),
      },
    ],
  }
}

/** Category labels keep only the clock part so the axis follows the session. */
function intradayClock(value: string): string {
  const match = /(\d{1,2}:\d{2})/.exec(value)
  return match?.[1] ?? value
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function cx(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(' ')
}

function confidenceText(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  const percentValue = value <= 1 ? value * 100 : value
  return `${Math.round(percentValue)}%`
}

function countText(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : String(value)
}

function boardText(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${value} 板`
}
