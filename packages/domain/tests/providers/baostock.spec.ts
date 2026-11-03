import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BaoStockProvider, parseBaoStockBars, type BaoStockExchange } from '../../src/providers/baostock.ts'
import { SourceCircuit } from '../../src/providers/source-circuit.ts'
import { FakeClock } from '../helpers.ts'

const NOW = Date.parse('2026-11-02T20:00:00+08:00')
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(() => vi.useRealTimers())
const row = (date = '2026-11-02', flag = '3') => [date, 'sh.600000', '10', '11', '9', '10.5', '10', '100', '1050', '1', '1', '0', '8', '1.2', flag]
function historyReply(body: string, rows?: string[][]): string[] {
  const args = body.split('\x01')
  return ['0', 'success', args[0]!, 'anonymous', args[2]!, '2000', JSON.stringify({ record: rows ?? [row(args[7], args[9])] }), args[4]!, args[5]!, args[6]!, args[7]!, args[8]!, args[9]!]
}
function fixture(change?: BaoStockExchange) {
  const clock = new FakeClock(NOW), circuit = new SourceCircuit({ clock })
  const exchange = vi.fn<BaoStockExchange>(change ?? (async (type, body) => type === '00' ? ['0', 'success', 'login', 'anonymous'] : historyReply(body)))
  return { clock, circuit, exchange, provider: new BaoStockProvider(clock, circuit, exchange), signal: new AbortController().signal }
}

it('uses a paced anonymous session and keeps raw/qfq identities, state and valuation facts', async () => {
  const { provider, exchange, clock, signal } = fixture()
  const raw = await provider.history('600000', 'none', '2026-11-02', signal)
  expect(raw).toMatchObject({ source: 'baostock', bars: [{ prevClose: 10, tradeStatus: 1, isST: false, amount: 1050, peTtm: 8, pb: 1.2 }] })
  await provider.history('600000', 'qfq', '2026-11-02', signal)
  const facts = await provider.facts('600000', '2026-11-02', signal)
  expect(facts.pe).toMatchObject({ source: 'baostock', value: 8, date: '2026-11-02', reportDate: null })
  expect(facts.changePct?.value).toBeCloseTo(5)
  expect(exchange).toHaveBeenCalledTimes(3)
  expect(clock.sleeps).toEqual([500, 500])
  expect(exchange.mock.calls.filter(([type]) => type === '95').map(([, body]) => body.split('\x01').at(-1))).toEqual(['3', '2'])
  provider.close()
})

it('does not trip transport or daily breakers for empty or stale stock coverage', async () => {
  const { provider, circuit, signal } = fixture(async (type, body) => type === '00' ? ['0', '', 'login', 'anonymous'] : historyReply(body, [row('2026-10-30')]))
  for (let i = 0; i < 4; i++) await expect(provider.history('600000', 'none', '2026-11-02', signal)).rejects.toThrow('未覆盖')
  expect(circuit.snapshot('baostock-daily').failures).toBe(0)
  expect(circuit.isOpen('baostock-transport')).toBe(false)
  provider.close()
})

it('opens one shared transport breaker after failures and does not keep reconnecting per stock', async () => {
  const { provider, exchange, circuit, signal } = fixture(async () => { throw new Error('network offline') })
  for (let i = 0; i < 4; i++) await expect(provider.history('600000', 'none', '2026-11-02', signal)).rejects.toThrow()
  expect(exchange).toHaveBeenCalledTimes(3)
  expect(circuit.isOpen('baostock-transport')).toBe(true)
  provider.close()
})

it('rejects wrong adjustment, wrong code and invalid prices and retains genuine suspended status', () => {
  expect(() => parseBaoStockBars([row('2026-11-02', '3')], '600000', 'qfq', '2026-11-02', 400)).toThrow('复权')
  const wrong = row(); wrong[1] = 'sh.600519'
  expect(() => parseBaoStockBars([wrong], '600000', 'none', '2026-11-02', 400)).toThrow('代码')
  const invalid = row(); invalid[3] = 'NaN'
  expect(() => parseBaoStockBars([invalid], '600000', 'none', '2026-11-02', 400)).toThrow()
  const suspended = row(); suspended[10] = '0'; suspended[7] = ''; suspended[11] = '1'
  expect(parseBaoStockBars([suspended], '600000', 'none', '2026-11-02', 400)[0]).toMatchObject({ volume: 0, tradeStatus: 0, isST: true })
})

it('checks calendar ranges and retains only explicitly declared market days', async () => {
  const { provider, signal } = fixture(async (type, body) => {
    if (type === '00') return ['0', '', 'login', 'anonymous']
    const args = body.split('\x01'), start = args[4]!, end = args[5]!
    const rows = Array.from({ length: 801 }, (_, i) => {
      const date = new Date(Date.parse(start) + i * 86400000)
      return [date.toISOString().slice(0, 10), date.getUTCDay() % 6 === 0 ? '0' : '1']
    })
    return ['0', '', 'query_trade_dates', 'anonymous', '1', '2000', JSON.stringify({ record: rows }), start, end, 'calendar_date,is_trading_day']
  })
  const dates = await provider.calendar('2026-11-02', signal)
  expect(dates).toHaveLength(400)
  expect(dates.at(-1)).toBe('2026-11-02')
  expect(dates).not.toContain('2026-11-01')
  provider.close()
})

it('rejects a response that echoes a different date range even if its last bar is current', async () => {
  const { provider, signal } = fixture(async (type, body) => {
    if (type === '00') return ['0', '', 'login', 'anonymous']
    const fields = historyReply(body); fields[10] = '2026-10-30'; return fields
  })
  await expect(provider.history('600000', 'none', '2026-11-02', signal)).rejects.toThrow('查询范围')
  provider.close()
})

it('paginates the current catalogue and excludes non-stock or delisted entries', async () => {
  const { provider, signal, exchange } = fixture(async (type, body) => {
    if (type === '00') return ['0', '', 'login', 'anonymous']
    const page = body.split('\x01')[2]!
    const rows = page === '1' ? Array.from({ length: 2000 }, (_, i) => [`sh.${600000 + i}`, `股票${i}`, '2000-01-01', '', '1', '1'])
      : [['sh.688999', '新股', '2026-10-30', '', '1', '1'], ['sh.603999', '已退市', '2000-01-01', '2026-01-01', '1', '0'], ['sh.000001', '指数', '1990-01-01', '', '2', '1']]
    return ['0', '', 'query_stock_basic', 'anonymous', page, '2000', JSON.stringify({ record: rows }), '', '', 'code,code_name,ipoDate,outDate,type,status']
  })
  const stocks = await provider.securities(signal)
  expect(stocks).toHaveLength(2001)
  expect(stocks.at(-1)).toMatchObject({ code: '688999', name: '新股', market: 1 })
  expect(stocks.some(row => row.name === '指数' || row.name === '已退市')).toBe(false)
  expect(exchange.mock.calls.filter(([type]) => type === '45')).toHaveLength(2)
  provider.close()
})
