import { z } from 'zod'
import { isMarketDate } from '../../../contracts/src/market-history.ts'
import type { TechnicalBar, TechnicalHistoryInput } from '../../../contracts/src/technical-screen.ts'
import type { ScreeningFact } from '../../../contracts/src/market-scan.ts'
import type { Clock } from '../http.ts'
import { BaoStockSession } from './baostock-session.ts'
import { SourceCircuit, SourceDataUnavailableError } from './source-circuit.ts'
import type { EastmoneySecurityRow } from './eastmoney.ts'

export const BAOSTOCK_DAILY_FIELDS = 'date,code,open,high,low,close,preclose,volume,amount,turn,tradestatus,isST,peTTM,pbMRQ,adjustflag'
const number = z.string().trim().min(1).transform(Number).pipe(z.number().finite())
const positive = number.pipe(z.number().positive())
const optionalNumber = (value: string | undefined) => value == null || !value.trim() ? null : number.parse(value)
const stockCode = (code: string) => `${code.startsWith('6') ? 'sh' : /^[489]/.test(code) ? 'bj' : 'sz'}.${code}`
export type BaoStockExchange = (type: string, body: string, signal?: AbortSignal) => Promise<string[]>

export function parseBaoStockBars(rows: string[][], code: string, adjust: 'none' | 'qfq', asOf: string, limit: number): TechnicalBar[] {
  const flag = adjust === 'none' ? '3' : '2'
  const bars = rows.map(row => {
    if (row.length !== 15 || row[1] !== stockCode(code) || row[14] !== flag || !isMarketDate(row[0] ?? '') || row[0]! > asOf) throw new Error('BaoStock 日线日期、代码或复权口径不匹配')
    const tradeStatus = z.enum(['0', '1']).parse(row[10]) === '1' ? 1 as const : 0 as const
    return {
      date: row[0]!, open: positive.parse(row[2]), high: positive.parse(row[3]), low: positive.parse(row[4]), close: positive.parse(row[5]),
      volume: tradeStatus === 0 && row[7] === '' ? 0 : number.pipe(z.number().nonnegative()).parse(row[7]),
      amount: optionalNumber(row[8]), prevClose: row[6] === '' ? null : number.pipe(z.number().nonnegative()).parse(row[6]) || null, turnoverRate: optionalNumber(row[9]),
      tradeStatus, isST: z.enum(['0', '1']).parse(row[11]) === '1', peTtm: optionalNumber(row[12]), pb: optionalNumber(row[13]),
    }
  })
  if (bars.some((bar, i) => (i > 0 && bar.date <= bars[i - 1]!.date) || bar.low > Math.min(bar.open, bar.close)
    || bar.high < Math.max(bar.open, bar.close) || bar.low > bar.high || (bar.amount !== null && bar.amount < 0))) throw new Error('BaoStock 日线顺序或价格无效')
  if (bars.at(-1)?.date !== asOf) throw new SourceDataUnavailableError(`BaoStock 日线未覆盖${asOf}，实际${bars.at(-1)?.date ?? '无数据'}`)
  return bars.slice(-limit)
}

/** One anonymous session, serialized and paced across daily/calendar/catalogue requests. */
export class BaoStockProvider {
  private readonly session = new BaoStockSession()
  private queue: Promise<unknown> = Promise.resolve()
  private loggedIn = false
  private lastRequest: number | undefined
  private disposed = false
  private readonly raw = new Map<string, { asOf: string; input: TechnicalHistoryInput }>()
  constructor(private readonly clock: Clock, private readonly circuit: SourceCircuit,
    private readonly exchange: BaoStockExchange = (type, body, signal) => this.session.exchange(type, body, signal)) {}

  private request(type: string, body: string, signal?: AbortSignal): Promise<string[]> {
    const pending = this.queue.catch(() => {}).then(async () => {
      signal?.throwIfAborted()
      if (this.disposed) throw new Error('BaoStock 数据准备已停止')
      return this.circuit.run('baostock-transport', async () => {
        const send = async (kind: string, message: string) => {
          const delay = this.lastRequest === undefined ? 0 : Math.max(0, this.lastRequest + 500 - this.clock.now())
          if (delay) await this.clock.sleep(delay)
          signal?.throwIfAborted()
          if (this.disposed) throw new Error('BaoStock 数据准备已停止')
          this.lastRequest = this.clock.now()
          return this.exchange(kind, message, signal)
        }
        try {
          if (!this.loggedIn) {
            const login = await send('00', 'login\x01anonymous\x01123456\x010')
            if (login[2] !== 'login' || login[3] !== 'anonymous') throw new Error('BaoStock 匿名会话响应无效')
            this.loggedIn = true
          }
          return await send(type, body)
        } catch (cause) { this.loggedIn = false; this.session.close(); throw cause }
      }, signal)
    })
    this.queue = pending
    return pending
  }

  private async table(type: string, method: string, args: string[], columns: string, fieldsAt: number,
    check: (fields: string[]) => boolean, signal?: AbortSignal): Promise<string[][]> {
    const rows: string[][] = []
    for (let page = 1; page <= 20; page++) {
      const fields = await this.request(type, [method, 'anonymous', String(page), '2000', ...args].join('\x01'), signal)
      if (fields[0] !== '0' || fields[2] !== method || fields[3] !== 'anonymous' || fields[4] !== String(page) || fields[5] !== '2000'
        || fields[fieldsAt]?.split(',').map(value => value.trim()).join(',') !== columns || !check(fields)) throw new Error('BaoStock 查询范围、分页或字段不匹配')
      const data = z.object({ record: z.array(z.array(z.string()).length(columns.split(',').length)).max(2000) }).parse(JSON.parse(fields[6] ?? ''))
      rows.push(...data.record)
      if (data.record.length < 2000) return rows
    }
    throw new Error('BaoStock 分页超过安全上限')
  }

  async history(code: string, adjust: 'none' | 'qfq', asOf: string, signal: AbortSignal, limit = 400): Promise<TechnicalHistoryInput> {
    if (!/^\d{6}$/.test(code) || !isMarketDate(asOf) || !Number.isInteger(limit) || limit < 2 || limit > 400 || (adjust === 'qfq' && limit !== 400)) throw new Error('BaoStock 日线请求无效')
    return this.circuit.run('baostock-daily', async () => {
      const start = new Date(Date.parse(asOf) - 800 * 86400000).toISOString().slice(0, 10), flag = adjust === 'none' ? '3' : '2'
      const rows = await this.table('95', 'query_history_k_data_plus', [stockCode(code), BAOSTOCK_DAILY_FIELDS, start, asOf, 'd', flag], BAOSTOCK_DAILY_FIELDS, 8,
        fields => fields[7] === stockCode(code) && fields[9] === start && fields[10] === asOf && fields[11] === 'd' && fields[12] === flag, signal)
      const input = { bars: parseBaoStockBars(rows, code, adjust, asOf, limit), source: 'baostock', fetchedAt: new Date(this.clock.now()).toISOString() }
      if (adjust === 'none') {
        if (this.raw.size >= 6000) this.raw.delete(this.raw.keys().next().value!)
        this.raw.set(code, { asOf, input: { ...input, bars: [input.bars.at(-1)!] } })
      }
      return input
    }, signal)
  }

  async calendar(through: string, signal: AbortSignal): Promise<string[]> {
    if (!isMarketDate(through)) throw new Error('BaoStock 交易日请求无效')
    return this.circuit.run('baostock-calendar', async () => {
      const start = new Date(Date.parse(through) - 800 * 86400000).toISOString().slice(0, 10)
      const rows = await this.table('33', 'query_trade_dates', [start, through], 'calendar_date,is_trading_day', 9,
        fields => fields[7] === start && fields[8] === through, signal)
      if (rows.length !== 801 || rows[0]?.[0] !== start || rows.at(-1)?.[0] !== through
        || rows.some((row, i) => !isMarketDate(row[0]!) || row[0]! < start || row[0]! > through || (i > 0 && Date.parse(row[0]!) - Date.parse(rows[i - 1]![0]!) !== 86400000) || !['0', '1'].includes(row[1]!))) throw new Error('BaoStock 交易日序列无效或不完整')
      const dates = rows.filter(row => row[1] === '1').map(row => row[0]!).slice(-400)
      if (!dates.length || Date.parse(through) - Date.parse(dates.at(-1)!) > 15 * 86400000) throw new SourceDataUnavailableError('BaoStock 交易日历缺失或滞后')
      return dates
    }, signal)
  }

  async securities(signal?: AbortSignal): Promise<EastmoneySecurityRow[]> {
    return this.circuit.run('baostock-securities', async () => {
      const rows = await this.table('45', 'query_stock_basic', ['', ''], 'code,code_name,ipoDate,outDate,type,status', 9, fields => fields[7] === '' && fields[8] === '', signal)
      const active = rows.filter(row => row[4] === '1' && row[5] === '1')
      if (active.some(row => !/^(sh\.6|sz\.[03]|bj\.[489])\d{5}$/.test(row[0]!) || !row[1]?.trim()) || new Set(active.map(row => row[0])).size !== active.length || active.length < 1000) throw new Error('BaoStock 在市证券名录不完整或标识无效')
      return active.map(row => ({ code: row[0]!.slice(3), name: row[1]!, market: row[0]!.startsWith('sh.') ? 1 : 0 }))
    }, signal)
  }

  async facts(code: string, asOf: string, signal: AbortSignal): Promise<Record<string, ScreeningFact>> {
    const cached = this.raw.get(code)
    const input = cached?.asOf === asOf && this.clock.now() - Date.parse(cached.input.fetchedAt) < 6 * 3600000
      ? cached.input : await this.history(code, 'none', asOf, signal, 40)
    const bar = input.bars.at(-1)!
    const values = { price: bar.close, changePct: bar.prevClose ? (bar.close / bar.prevClose - 1) * 100 : null, pe: bar.peTtm, pb: bar.pb }
    return Object.fromEntries(Object.entries(values).filter(([, value]) => value != null).map(([field, value]) => [field,
      { value: value!, source: 'baostock', date: asOf, reportDate: null, fetchedAt: input.fetchedAt }]))
  }
  clearCache(): number { const count = this.raw.size; this.raw.clear(); return count }
  close(): void { this.disposed = true; this.loggedIn = false; this.session.close(); this.clearCache() }
}
