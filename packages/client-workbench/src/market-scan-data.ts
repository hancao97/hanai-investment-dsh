import { SCAN_FIELDS, type MarketScanData } from '../../contracts/src/market-scan.ts'

/** Escape untrusted source text for CSV and for spreadsheet formula interpretation. */
export function scanCsv(data: MarketScanData): string {
  const cell = (value: string | number | null) => {
    let text = value === null ? '' : String(value)
    if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = "'" + text
    return `"${text.replaceAll('"', '""')}"`
  }
  const metrics = Object.keys(SCAN_FIELDS) as Array<keyof typeof SCAN_FIELDS>
  const header = ['代码', '名称', '价格', '涨跌幅%', ...metrics.map(key => `${SCAN_FIELDS[key].label}(${SCAN_FIELDS[key].unit})`), '行业', '来源快照日', '获取时间', '匹配总数', '页码', '实际查询', '来源']
  return [header, ...data.stocks.map(row => ["'" + row.code, row.name, row.price, row.changePct, ...metrics.map(key => row[key]), row.industry, data.snapshotDate, data.meta.fetchedAt, data.total, data.query.page, JSON.stringify(data.query), data.meta.sourceName])].map(row => row.map(cell).join(',')).join('\r\n')
}
