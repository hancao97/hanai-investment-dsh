import { useEffect, useState } from 'react'
import type { StockDataStatus } from '../../contracts/src/stock-data.ts'
import type { HanaiClient } from './api.ts'
import { PanelHead } from './panel-head.tsx'
import { dateTime } from './format.ts'
import styles from './styles.module.css'

const labels: Record<StockDataStatus['phase'], string> = { idle: '尚未同步', queued: '等待执行', running: '后台同步中', paused: '已暂停', finished: '本轮检查结束', failed: '同步中断' }
function useStockDataStatus(client: HanaiClient) {
  const [status, setStatus] = useState<StockDataStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    let pending = false
    const load = async () => {
      if (pending) return
      pending = true
      try {
        const result = await client.call('stock-data.status', {}, controller.signal)
        if (!controller.signal.aborted) { setStatus(result); setError(null) }
      } catch (cause) { if (!controller.signal.aborted) setError(message(cause)) }
      finally { pending = false }
    }
    void load()
    const timer = window.setInterval(() => void load(), 3000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [client])
  return { status, setStatus, error, setError }
}
export function StockDataReadiness({ client, onSettings }: { client: HanaiClient; onSettings: () => void }) {
  const { status, error } = useStockDataStatus(client)
  return <div className={styles['stockDataReadiness']}>
    <span>技术选股日线 · 最近全量成功 {status?.latestCompleteDate ?? '尚未完成'} · {error ? '状态读取失败' : status ? `${status.task?.origin === 'legacy' ? '升级前任务 · ' : ''}${labels[status.phase]}` : '正在读取…'}；缺失日线按需后台补齐。</span>
    <button className={styles['button']} onClick={onSettings}>选股数据管理</button>
  </div>
}
export function StockDataPanel({ client }: { client: HanaiClient }) {
  const { status, setStatus, error, setError } = useStockDataStatus(client)
  const [busy, setBusy] = useState(false)
  const control = async (endpoint: 'stock-data.sync' | 'stock-data.pause') => {
    if (busy) return
    setBusy(true)
    try { setStatus(await client.call(endpoint, {})); setError(null) }
    catch (cause) { setError(message(cause)) }
    finally { setBusy(false) }
  }
  const legacy = status?.task?.origin === 'legacy'
  const previousError = legacy && status?.error ? { message: status.error, recordedAt: status.updatedAt, origin: 'legacy' as const } : status?.previousError
  return <article className={`${styles['card']} ${styles['settingsCard']} ${styles['settingsStockData']}`}>
    <PanelHead title="选股数据管理" hint="日线同步由宿主后台执行，离开页面不取消" />
    <div className={styles['stockDataBody']}>
      <p>状态：{status ? `${legacy ? '升级前任务 · ' : ''}${labels[status.phase]}` : '正在读取…'} · 最近日线全量成功基准日：{status?.latestCompleteDate ?? '尚未完成'}</p>
      <p>任务来源：{status?.task ? legacy ? '升级前任务记录（原始来源未完整记录）' : '本地选股数据准备' : '暂无任务来源记录'} · 本次执行开始：{status?.task?.startedAt ? dateTime(status.task.startedAt) : '未记录'}</p>
      <p>本轮基准日：{status?.asOf ?? '待确认交易日'} · 最近记录更新：{dateTime(status?.updatedAt ?? null)}</p>
      {status ? <p>日线：已检查 {status.checked} / {status.total} 只 · 窗口就绪 {status.completed} 只 · 检查失败 {status.failed} 只 · 未检查 {Math.max(0, status.total - status.checked)} 只</p> : <p>正在读取日线进度…</p>}
      {status?.reused && <p>本轮本地复用：日线 {status.reused.daily} 只 · 报价/财报 {status.reused.financial} 只；缺失或过期项单独补取。</p>}
      {status?.financial ? <p>报价/财报：{status.financial.checked === 0 ? '尚未检查' : `已检查 ${status.financial.checked} / ${status.total} 只 · 有效响应 ${status.financial.completed} 只 · 检查失败 ${status.financial.failed} 只`} · 未检查 {Math.max(0, status.total - status.financial.checked)} 只</p> : <p>报价/财报：暂无独立进度记录</p>}
      {status?.limitPools && <p>近端历史涨停池：{status.limitPools.available} / {status.limitPools.requested} 个交易日可用，仅核实来源池内正向事实；未覆盖完整ST、上市初期及停牌状态。{status.limitPools.missingDates.length > 0 && `待补日期：${status.limitPools.missingDates.join('、')}`}</p>}
      <details><summary>数据口径与自动更新说明</summary><p className={styles['settingsNote']}>BaoStock优先同步不复权、前复权日线及同口径盘后估值；缺失或滞后时用腾讯、东方财富补缺。实时行情、总市值及累计财报指标使用现有公开来源。BaoStock历史ST、停牌和昨收随日线保存，仍不等于完整涨停规则核实。日线、报价、财报及涨停池同源联网请求至少间隔0.5秒，本地复用不等待；限速不保证来源不会限制访问。每日北京时间20:00后台补跑；失败至少间隔6小时自动重试。报价/财报字段齐全且未超过6小时才直接复用，缺字段不当作已齐全。日线窗口就绪不代表历史交易状态、涨停规则或所有技术条件已核实。报价/财报有效响应不代表所有财务字段齐全，筛选结果另列缺失覆盖。</p></details>
      {error && <p role="alert">操作或状态读取失败：{error}</p>}
      {!legacy && status?.error && <p role="alert">{status.task?.origin === 'local' ? '本轮任务提示' : '任务提示（来源未记录）'}（记录更新于 {dateTime(status.updatedAt)}）：{status.error}</p>}
      {previousError && <details><summary>{previousError.origin === 'legacy' ? '升级前任务最后错误' : '上次任务错误'} · 记录时间 {previousError.recordedAt ? dateTime(previousError.recordedAt) : '未记录'}</summary><p>{previousError.message}</p><p>这是已保存的任务错误，不表示当前正在访问对应接口。重新同步会复用已有日线，并记录本次任务的独立进度。</p></details>}
      {!!status?.samples.length && <details><summary>日线检查失败原因（最多20只）</summary><ul>{status.samples.map(row => <li key={row.code}>{row.code}：{row.reason}</li>)}</ul></details>}
      {!!status?.sources?.length && <details><summary>日线来源与日期覆盖</summary><p>按当前保存窗口分组，日期范围不是连续完整性证明；不复权历史逐日保留各自来源。</p><ul>{status.sources.map(row => <li key={`${row.source}:${row.adjustment}`}>{row.source === 'baostock' ? 'BaoStock' : row.source === 'tencent' ? '腾讯' : row.source === 'eastmoney-push2his' ? '东方财富' : row.source === '88ai-technical' ? '88AI（已有历史输入）' : row.source} · {row.adjustment === 'qfq' ? '前复权' : '不复权'} · {row.count}只 · 窗口基准日 {row.oldestDate} 至 {row.newestDate} · 最近获取 {dateTime(row.fetchedAt)}</li>)}</ul></details>}
      {!!status?.financial?.samples.length && <details><summary>报价/财报检查失败原因（最多20只）</summary><ul>{status.financial.samples.map(row => <li key={row.code}>{row.code}：{row.reason}</li>)}</ul></details>}
    </div>
    <div className={styles['settingsActions']}>
      <button className={styles['button']} disabled={busy || status?.phase === 'running' || status?.phase === 'queued'} onClick={() => void control('stock-data.sync')}>{status?.phase === 'paused' ? '继续同步选股数据' : '同步 / 重试选股数据'}</button>
      <button className={styles['button']} disabled={busy || (status?.phase !== 'running' && status?.phase !== 'queued')} onClick={() => void control('stock-data.pause')}>暂停同步</button>
    </div>
  </article>
}
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
