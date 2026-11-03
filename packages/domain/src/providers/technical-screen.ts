import { z } from 'zod'
import type { TechnicalBar, TechnicalHistoryInput } from '../../../contracts/src/technical-screen.ts'
import { isMarketDate } from '../../../contracts/src/market-history.ts'
import type { HttpClient, Clock } from '../http.ts'
import { SourceCircuitOpenError, SourceDataUnavailableError, type SourceCircuit } from './source-circuit.ts'
import { tencentSymbol } from './tencent.ts'
import type { BaoStockProvider } from './baostock.ts'

const price = z.number().finite().positive()
export function parseTencentTechnicalBars(raw: unknown, symbol: string, adjust: 'qfq' | 'none', asOf: string): TechnicalBar[] {
  const data = z.object({ code: z.literal(0), data: z.record(z.string(), z.unknown()) }).parse(raw)
  const stock = z.record(z.string(), z.unknown()).parse(data.data[symbol])
  // A raw day array is not proof of qfq even if the prices happen to be equal.
  const input = stock[adjust === 'qfq' ? 'qfqday' : 'day']
  if (input == null || (Array.isArray(input) && !input.length)) throw new SourceDataUnavailableError('腾讯未返回该股所需复权口径的日线')
  const rows = z.array(z.array(z.unknown()).min(6)).min(1).max(800).parse(input)
  const numeric = z.union([z.number(), z.string().trim().min(1)]).transform(Number).pipe(z.number().finite())
  const numericPrice = numeric.pipe(price), numericVolume = numeric.pipe(z.number().nonnegative())
  const date = z.string().refine(isMarketDate)
  const parsed = rows.map(row => ({
    date: date.parse(row[0]), open: numericPrice.parse(row[1]), close: numericPrice.parse(row[2]),
    high: numericPrice.parse(row[3]), low: numericPrice.parse(row[4]), volume: numericVolume.parse(row[5]), amount: null,
  }))
  if (parsed.some((bar, i) => (i > 0 && bar.date <= parsed[i - 1]!.date) || bar.low > Math.min(bar.open, bar.close)
    || bar.high < Math.max(bar.open, bar.close) || bar.low > bar.high)) throw new Error('腾讯技术日线日期、顺序或价格无效')
  return parsed.filter(bar => bar.date <= asOf).slice(-400)
}

export class TechnicalScreenProvider {
  constructor(private readonly http: HttpClient, private readonly clock: Clock, private readonly circuit: SourceCircuit,
    private readonly primary?: Pick<BaoStockProvider, 'history' | 'calendar'>) {}
  async calendar(through: string, signal: AbortSignal): Promise<string[]> {
    if (this.primary) {
      try { return await this.primary.calendar(through, signal) }
      catch { signal.throwIfAborted() }
    }
    const input = await this.history('000001', 'none', through, signal, 400, 'sh000001')
    const dates = input.bars.map(row => row.date)
    if (!dates.length || Date.parse(through) - Date.parse(dates.at(-1)!) > 15 * 86400000) throw new Error('指数交易日来源滞后，无法确定扫描基准日')
    return dates
  }
  async bars(code: string, adjust: 'qfq' | 'none', asOf: string, signal: AbortSignal): Promise<TechnicalBar[]> {
    return (await this.history(code, adjust, asOf, signal)).bars
  }
  async history(code: string, adjust: 'qfq' | 'none', asOf: string, signal: AbortSignal, limit = 400, indexSymbol?: string): Promise<TechnicalHistoryInput> {
    if (!/^\d{6}$/.test(code) || !isMarketDate(asOf)) throw new Error('技术行情请求无效')
    if (!Number.isInteger(limit) || limit < 2 || limit > 400 || (adjust === 'qfq' && limit !== 400)) throw new Error('技术日线窗口无效，前复权必须刷新完整窗口')
    if (this.primary && !indexSymbol) {
      try { return await this.primary.history(code, adjust, asOf, signal, limit) }
      catch { signal.throwIfAborted() }
    }
    const symbol = indexSymbol ?? tencentSymbol(`${code.startsWith('6') ? 1 : 0}.${code}`)
    const failures: string[] = []
    const tencentSource = indexSymbol ? 'tencent-calendar' : 'tencent-daily'
    const eastmoneySource = indexSymbol ? 'eastmoney-calendar' : 'eastmoney-daily'
    try {
      const bars = await this.circuit.run(tencentSource, async () => {
        const params = new URLSearchParams({ param: `${symbol},day,,${asOf},${limit},${adjust === 'qfq' ? 'qfq' : ''}` })
        const response = await this.http.request(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?${params}`, { signal, timeoutMs: 12000, headers: { Referer: 'https://gu.qq.com/' } })
        if (response.status !== 200) throw new Error(`腾讯技术日线 HTTP ${response.status}`)
        const result = parseTencentTechnicalBars(JSON.parse(response.body) as unknown, symbol, adjust, asOf)
        if (!result.length || (!indexSymbol && result.at(-1)?.date !== asOf)) throw new SourceDataUnavailableError(`腾讯日线滞后：${result.at(-1)?.date ?? '无数据'}，期望${asOf}`)
        return result
      }, signal)
      return { bars, source: 'tencent', fetchedAt: new Date(this.clock.now()).toISOString() }
    } catch (cause) {
      signal.throwIfAborted()
      failures.push(cause instanceof Error ? cause.message : String(cause))
    }
    try {
      const bars = await this.circuit.run(eastmoneySource, async () => {
        const params = new URLSearchParams({ secid: indexSymbol ? '1.000001' : `${code.startsWith('6') ? 1 : 0}.${code}`,
          klt: '101', fqt: adjust === 'qfq' ? '1' : '0', beg: new Date(Date.parse(asOf) - 800 * 86400000).toISOString().slice(0, 10).replaceAll('-', ''), end: asOf.replaceAll('-', ''), lmt: String(limit),
          fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56,f57' })
        const r = await this.http.request(`https://push2his.eastmoney.com/api/qt/stock/kline/get?${params}`, { signal, timeoutMs: 12000, headers: { Referer: 'https://quote.eastmoney.com/' } })
        if (r.status !== 200) throw new Error(`东方财富日线 HTTP ${r.status}`)
        const data = z.object({ data: z.object({ code: z.literal(code), klines: z.array(z.string()).max(800).nullable() }).nullable() }).parse(JSON.parse(r.body)).data
        if (!data?.klines?.length) throw new SourceDataUnavailableError('东方财富未返回该股日线')
        const numeric = z.coerce.number().finite()
        const result = data.klines.map(line => {
          const v = line.split(','); if (v.length < 7 || v.slice(1, 7).some(x => !x?.trim())) throw new Error('东方财富日线字段缺失')
          return { date: z.string().refine(isMarketDate).parse(v[0]), open: numeric.pipe(price).parse(v[1]), close: numeric.pipe(price).parse(v[2]),
            high: numeric.pipe(price).parse(v[3]), low: numeric.pipe(price).parse(v[4]), volume: numeric.nonnegative().parse(v[5]), amount: numeric.nonnegative().parse(v[6]) }
        })
        if (result.some((bar, i) => bar.date > asOf || (i > 0 && bar.date <= result[i - 1]!.date) || bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close) || bar.low > bar.high)) throw new Error('东方财富日线日期、顺序或价格无效')
        if (!indexSymbol && result.at(-1)?.date !== asOf) throw new SourceDataUnavailableError(`东方财富日线滞后：${result.at(-1)?.date ?? '无数据'}，期望${asOf}`)
        return result.slice(-limit)
      }, signal)
      return { bars, source: 'eastmoney-push2his', fetchedAt: new Date(this.clock.now()).toISOString() }
    } catch (cause) {
      signal.throwIfAborted()
      failures.push(cause instanceof Error ? cause.message : String(cause))
      if (cause instanceof SourceCircuitOpenError && this.circuit.isOpen(tencentSource)) throw cause
      throw new Error(`技术日线备源均不可用：${failures.join('；')}`)
    }
  }
}
