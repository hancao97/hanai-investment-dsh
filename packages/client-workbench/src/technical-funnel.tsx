import type { TechnicalProgress } from '../../contracts/src/technical-screen.ts'
import styles from './ai-screener.module.css'

export function TechnicalFunnel({ progress }: { progress: TechnicalProgress }) {
  if (!progress.funnel) return null
  return <details className={styles.funnel}>
    <summary>数据覆盖与逐条件统计</summary>
    <p>已检查 {progress.checked} 只 → 全部规则可核实 {progress.dataReady ?? 0} 只 → 按确认公式命中 {progress.matched} 只。未核实 {progress.unverified} 只。</p>
    <p>各行独立统计同一已检查范围，并非依次扣减；“任一满足”允许其它条件未核实。数据缺失不等于条件不满足。</p>
    {progress.limitPools && <p>历史涨停池：已取得 {progress.limitPools.available} / {progress.limitPools.requested} 个交易日。仅核实来源池内正向事实；不代表覆盖ST、新股、北交所及完整上市/交易状态历史。{progress.limitPools.missingDates.length > 0 && `缺少日期：${progress.limitPools.missingDates.join('、')}`}</p>}
    <table><caption>各项技术条件核验情况</caption><thead><tr><th scope="col">条件</th><th scope="col">满足</th><th scope="col">不满足</th><th scope="col">未核实</th></tr></thead>
      <tbody>{progress.funnel.map((step, index) => <tr key={index}><th scope="row">{step.formula}</th><td>{step.passed}</td><td>{step.rejected}</td><td>{step.unverified}</td></tr>)}</tbody>
    </table>
  </details>
}
