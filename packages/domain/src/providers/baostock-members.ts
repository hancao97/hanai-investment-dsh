import { BaoStockSession } from './baostock-session.ts'
import { isMarketDate } from '../../../contracts/src/market-history.ts'

export interface MacroMembers { updatedOn: string; codes: string[] }

/** Public anonymous protocol used by BaoStock 0.9.4; no account or Python runtime required. */
export async function queryBaoStockMembers(date: string): Promise<MacroMembers> {
  if (!isMarketDate(date)) throw new Error('成分查询日期无效')
  const session = new BaoStockSession()
  const exchange = (type: string, body: string) => session.exchange(type, body)
  try {
    await exchange('00', 'login\x01anonymous\x01123456\x010')
    const fields = await exchange('61', `query_hs300_stocks\x01anonymous\x011\x012000\x01${date}`)
    if (fields[2] !== 'query_hs300_stocks' || fields[4] !== '1' || fields[7] !== date || fields[8]?.split(',').map(field => field.trim()).join(',') !== 'updateDate,code,code_name') throw new Error('BaoStock 成分日期或字段不匹配')
    const raw: unknown = JSON.parse(fields[6] ?? '')
    if (raw === null || typeof raw !== 'object' || !('record' in raw) || !Array.isArray(raw.record) || raw.record.length !== 300) throw new Error('BaoStock 成分未完整返回300只')
    let updatedOn = ''
    const codes = new Set<string>()
    for (const row of raw.record) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || !isMarketDate(row[0]) || row[0] > date || Date.parse(date) - Date.parse(row[0]) > 7 * 86_400_000
        || (updatedOn !== '' && updatedOn !== row[0]) || typeof row[1] !== 'string' || !/^(sh\.6|sz\.[03])\d{5}$/.test(row[1])) throw new Error('BaoStock 成分记录或周快照日期无效')
      updatedOn = row[0]
      if (codes.has(row[1].slice(3))) throw new Error('BaoStock 成分代码重复')
      codes.add(row[1].slice(3))
    }
    return { updatedOn, codes: [...codes].sort() }
  } finally { session.close() }
}
