import { afterEach, expect, it, vi } from 'vitest'
import { evaluateTechnical, type TechnicalInputs } from '../src/technical-screen.ts'
import { technicalFormulaSchema, type TechnicalFormula } from '../../contracts/src/technical-screen.ts'
import { parseTencentTechnicalBars, TechnicalScreenProvider } from '../src/providers/technical-screen.ts'
import { SourceCircuit } from '../src/providers/source-circuit.ts'
import { systemClock } from '../src/http.ts'

afterEach(() => vi.useRealTimers())

function input(closes: number[]): TechnicalInputs {
  const bars = closes.map((close, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, open: close, close, high: close, low: close, volume: 100 }))
  return { dates: bars.map(bar => bar.date), bars, raw: bars, limitDates: [] }
}
const formula = (rules: TechnicalFormula['rules'], match: 'all' | 'any' = 'all'): TechnicalFormula => ({ match, adjust: 'qfq', rules })

it('requires an actual crossover rather than merely remaining above a moving average', () => {
  const rule = { kind: 'ma-cross', short: 2, long: 3, direction: 'up', within: 1 } as const
  expect(evaluateTechnical(formula([rule]), input([10, 10, 10, 10, 12])).matched).toBe(true)
  expect(evaluateTechnical(formula([rule]), input([10, 10, 10, 12, 14])).matched).toBe(false)
  expect(evaluateTechnical(formula([{ ...rule, within: 2 }]), input([10, 10, 10, 12, 14])).matched).toBe(true)
  expect(evaluateTechnical(formula([{ ...rule, direction: 'down' }]), input([10, 10, 10, 10, 8])).matched).toBe(true)
})

it('checks all specified days of a configurable spread and a real slope reversal', () => {
  expect(evaluateTechnical(formula([{ kind: 'ma-spread', periods: [2, 3], maxPercent: 0, days: 2 }]), input([10, 10, 10, 10])).matched).toBe(true)
  expect(evaluateTechnical(formula([{ kind: 'ma-spread', periods: [2, 3], maxPercent: 0, days: 2 }]), input([12, 10, 10, 10])).matched).toBe(false)
  expect(evaluateTechnical(formula([{ kind: 'ma-turn', period: 2, direction: 'up' }]), input([12, 10, 10, 12])).matched).toBe(true)
  expect(evaluateTechnical(formula([{ kind: 'ma-turn', period: 2, direction: 'up' }]), input([8, 10, 12, 14])).matched).toBe(false)
})

it('keeps short history, suspension and missing latest market dates unknown', () => {
  const rules = [{ kind: 'price-ma', period: 3, relation: 'above' }] as const
  expect(evaluateTechnical(formula([...rules]), input([10, 12])).matched).toBeNull()
  const data = input([10, 10, 12]); data.dates.push('2026-10-04')
  expect(evaluateTechnical(formula([...rules]), data).matched).toBeNull()
  const halted = input([10, 10, 12]); halted.bars[1]!.volume = 0
  expect(evaluateTechnical(formula([...rules]), halted).matched).toBeNull()
})

it('only confirms historical limit-ups with same-day unadjusted closing evidence', () => {
  const f = formula([{ kind: 'limit-up', days: 2, minimum: 1 }])
  const data = input([10, 11, 12]); data.limitDates = ['2026-10-03']
  expect(evaluateTechnical(f, data).matched).toBe(true)
  data.raw = []
  expect(evaluateTechnical(f, data).matched).toBeNull()
  data.raw = input([10, 11, 12]).bars; data.raw[2]!.high = 13
  expect(evaluateTechnical(f, data).matched).toBeNull()
  data.limitDates = ['2026-10-01']
  expect(evaluateTechnical(f, data).matched).toBeNull()
})

it('can prove a non-sealed close from raw OHLC without guessing the historical limit percentage', () => {
  const data = input([10, 11, 12]); data.raw = data.raw.map(bar => ({ ...bar, high: bar.close + 1 }))
  const rules = [{ kind: 'limit-up', days: 2, minimum: 1 }] as const
  expect(evaluateTechnical(formula([...rules]), data).matched).toBe(false)
  data.raw.at(-1)!.high = 12
  expect(evaluateTechnical(formula([...rules]), data).matched).toBeNull()
  expect(evaluateTechnical(formula([{ ...rules[0], minimum: 2 }]), data).matched).toBe(false)
  data.limitDates = ['2026-10-03']
  expect(evaluateTechnical(formula([...rules]), data).matched).toBe(true)
  data.raw = []
  expect(evaluateTechnical(formula([...rules]), data).matched).toBeNull()
})

it('uses three-valued all/any logic without promoting unknown predicates to matches', () => {
  const rules = [{ kind: 'price-ma', period: 2, relation: 'above' }, { kind: 'limit-up', days: 2, minimum: 1 }] as TechnicalFormula['rules']
  expect(evaluateTechnical(formula(rules), input([10, 10, 12])).matched).toBeNull()
  expect(evaluateTechnical(formula(rules, 'any'), input([10, 10, 12])).matched).toBe(true)
  expect(evaluateTechnical(formula(rules), input([12, 12, 10])).matched).toBe(false)
})

it('separates prior consolidation from a later cross without peeking into future prices', () => {
  const data = input([10, 10, 10, 10, 12, 14])
  const rules: TechnicalFormula['rules'] = [
    { kind: 'ma-spread', periods: [2, 3], maxPercent: 0, days: 2, offset: 2 },
    { kind: 'ma-cross', short: 2, long: 3, direction: 'up', within: 2 },
  ]
  expect(evaluateTechnical(formula(rules), data).matched).toBe(true)
  expect(evaluateTechnical(formula([{ ...rules[0]!, offset: 0 }]), data).matched).toBe(false)
  const historical = formula([{ kind: 'price-ma', period: 2, relation: 'above', offset: 1 }])
  const before = evaluateTechnical(historical, data)
  data.bars.at(-1)!.close = 1
  expect(evaluateTechnical(historical, data)).toEqual(before)
})

it('distinguishes a continuing slope from a reversal and requires every MA trading date', () => {
  const rising = input([8, 10, 12, 14, 16])
  expect(evaluateTechnical(formula([{ kind: 'ma-slope', period: 2, direction: 'up', days: 3 }]), rising).matched).toBe(true)
  expect(evaluateTechnical(formula([{ kind: 'ma-turn', period: 2, direction: 'up' }]), rising).matched).toBe(false)
  expect(evaluateTechnical(formula([{ kind: 'ma-slope', period: 2, direction: 'up', days: 2 }]), input([10, 10, 10, 12])).matched).toBe(false)
  const missing = input([8, 10, 12, 14, 16]); missing.bars.splice(2, 1)
  expect(evaluateTechnical(formula([{ kind: 'price-ma', period: 3, relation: 'above' }]), missing).matched).toBeNull()
  const stale = input([8, 10, 12]); stale.dates.push('2026-10-04')
  expect(evaluateTechnical(formula([{ kind: 'price-ma', period: 2, relation: 'above' }]), stale).evidence[0]?.detail).toContain('实际2026-10-03')
  expect(() => technicalFormulaSchema.parse(formula([{ kind: 'ma-slope', period: 20, direction: 'up', days: 3, offset: 61 }]))).toThrow()
})

it('rejects executable payloads and unbounded or ambiguous formula parameters', () => {
  for (const raw of [
    { ...formula([{ kind: 'price-ma', period: 20, relation: 'above' }]), code: 'fetch()' },
    formula([{ kind: 'ma-cross', short: 20, long: 5, direction: 'up', within: 1 }]),
    formula([{ kind: 'ma-spread', periods: [5, 5], days: 1, maxPercent: 2 }]),
    formula([{ kind: 'limit-up', days: 2, minimum: 3 }]),
    { match: 'all', adjust: 'qfq', rules: [{ kind: 'eval', formula: '__proto__' }] },
  ]) expect(() => technicalFormulaSchema.parse(raw)).toThrow()
})

it('uses index market dates and trips only public-source circuits on malformed data', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T10:00:00+08:00'))
  const request = vi.fn(async () => ({ status: 200, body: JSON.stringify({ code: 0, data: { sh000001: { day: [['2026-10-29',10,10,10,10,100],['2026-10-30',11,11,11,11,100]] } } }) }))
  const circuit = new SourceCircuit(), provider = new TechnicalScreenProvider({ request }, systemClock, circuit)
  expect(await provider.calendar('2026-10-29', new AbortController().signal)).toEqual(['2026-10-29'])
  request.mockResolvedValue({ status: 200, body: '{}' })
  for (let i = 0; i < 3; i++) await expect(provider.bars('600519', 'none', '2026-10-29', new AbortController().signal)).rejects.toThrow()
  expect(circuit.isOpen('tencent-daily')).toBe(true); expect(circuit.isOpen('eastmoney-daily')).toBe(true)
  expect(circuit.isOpen('tencent')).toBe(false); expect(circuit.isOpen('eastmoney-push2his')).toBe(false)
  expect(circuit.isOpen('tencent-calendar')).toBe(false)
  expect(circuit.isOpen('88ai-scan')).toBe(false)
  await expect(provider.bars('600519', 'none', '2026-10-29', new AbortController().signal)).rejects.toThrow('熔断')
  expect(request).toHaveBeenCalledTimes(7)
})

it('keeps Tencent raw/qfq identity strict and rejects missing symbols or price defects', () => {
  const rows = [['2026-10-30', '10', '11', '12', '9', '100']]
  const raw = { code: 0, data: { sz002594: { day: rows } } }
  expect(parseTencentTechnicalBars(raw, 'sz002594', 'none', '2026-10-30')[0]).toMatchObject({ close: 11, high: 12, low: 9 })
  expect(() => parseTencentTechnicalBars(raw, 'sz002594', 'qfq', '2026-10-30')).toThrow()
  expect(() => parseTencentTechnicalBars(raw, 'sz002415', 'none', '2026-10-30')).toThrow()
  expect(() => parseTencentTechnicalBars({ code: 0, data: { sz002594: { day: [['2026-10-30', 10, 11, 10, 9, 100]] } } }, 'sz002594', 'none', '2026-10-30')).toThrow()
})

it('uses a verified Tencent window without calling 88AI and preserves its source', async () => {
  const request = vi.fn(async () => ({ status: 200, body: JSON.stringify({ code: 0, data: { sz002594: { qfqday: [['2026-10-30', '10', '11', '12', '9', '100']] } } }) }))
  const provider = new TechnicalScreenProvider({ request }, systemClock, new SourceCircuit())
  expect(await provider.history('002594', 'qfq', '2026-10-30', new AbortController().signal)).toMatchObject({ source: 'tencent', bars: [{ date: '2026-10-30', close: 11 }] })
  expect(request).toHaveBeenCalledTimes(1)
})

it('uses index trading dates without any 88AI endpoint', async () => {
  const request = vi.fn(async (url: string) => url.includes('88aitou.com') ? { status: 503, body: '' }
    : { status: 200, body: JSON.stringify({ code: 0, data: { sh000001: { day: [['2026-10-29', 10, 10, 10, 10, 100], ['2026-10-30', 10, 10, 10, 10, 100]] } } }) })
  const provider = new TechnicalScreenProvider({ request }, systemClock, new SourceCircuit())
  expect(await provider.calendar('2026-10-30', new AbortController().signal)).toEqual(['2026-10-29', '2026-10-30'])
})

it('falls back after a stale primary and refuses to mark two stale sources complete', async () => {
  const request = vi.fn(async (url: string) => ({ status: 200, body: JSON.stringify(url.includes('gtimg.cn')
    ? { code: 0, data: { sz002594: { day: [['2026-10-27', 10, 10, 10, 10, 100]] } } }
    : { data: { code: '002594', klines: ['2026-10-30,10,10,10,10,100,1000'] } }) }))
  const provider = new TechnicalScreenProvider({ request }, systemClock, new SourceCircuit())
  expect((await provider.history('002594', 'none', '2026-10-30', new AbortController().signal)).source).toBe('eastmoney-push2his')
  request.mockImplementation(async () => ({ status: 200, body: '{}' }))
  await expect(provider.history('002594', 'none', '2026-10-30', new AbortController().signal)).rejects.toThrow('备源均不可用')
})

it('keeps stale or empty stock windows unverified without tripping provider circuits', async () => {
  const circuit = new SourceCircuit()
  const request = vi.fn(async (url: string) => ({ status: 200, body: JSON.stringify(url.includes('gtimg.cn')
    ? { code: 0, data: { sz002594: { day: [['2026-10-29', 10, 10, 10, 10, 100]] } } }
    : { data: { code: '002594', klines: ['2026-10-29,10,10,10,10,100,1000'] } }) }))
  const provider = new TechnicalScreenProvider({ request }, systemClock, circuit)
  for (let i = 0; i < 4; i++) await expect(provider.bars('002594', 'none', '2026-10-30', new AbortController().signal)).rejects.toThrow('滞后')
  request.mockImplementation(async (url: string) => ({ status: 200, body: JSON.stringify(url.includes('gtimg.cn')
    ? { code: 0, data: { sz002594: { day: [] } } } : { data: null }) }))
  for (let i = 0; i < 4; i++) await expect(provider.bars('002594', 'none', '2026-10-30', new AbortController().signal)).rejects.toThrow('备源均不可用')
  expect(circuit.snapshot('tencent-daily').failures).toBe(0)
  expect(circuit.snapshot('eastmoney-daily').failures).toBe(0)
  expect(request).toHaveBeenCalledTimes(16)
})

it('prefers BaoStock and falls back by adjustment only when its requested window is unavailable', async () => {
  const primary = { calendar: vi.fn(async () => ['2026-10-30']), history: vi.fn(async () => ({ source: 'baostock', fetchedAt: '2026-10-30T12:00:00.000Z', bars: [{ date: '2026-10-30', open: 10, high: 10, low: 10, close: 10, volume: 100 }] })) }
  const request = vi.fn(async () => ({ status: 200, body: JSON.stringify({ code: 0, data: { sz002594: { qfqday: [['2026-10-30', 10, 11, 12, 9, 100]] } } }) }))
  const provider = new TechnicalScreenProvider({ request }, systemClock, new SourceCircuit(), primary)
  expect(await provider.calendar('2026-10-30', new AbortController().signal)).toEqual(['2026-10-30'])
  expect((await provider.history('002594', 'none', '2026-10-30', new AbortController().signal)).source).toBe('baostock')
  expect(request).not.toHaveBeenCalled()
  primary.history.mockRejectedValueOnce(new Error('qfq unavailable'))
  expect((await provider.history('002594', 'qfq', '2026-10-30', new AbortController().signal)).source).toBe('tencent')
  expect(request).toHaveBeenCalledTimes(1)
  expect(primary.history).toHaveBeenLastCalledWith('002594', 'qfq', '2026-10-30', expect.any(AbortSignal), 400)
})
