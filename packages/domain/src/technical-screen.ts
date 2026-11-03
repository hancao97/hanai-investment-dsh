import { describeTechnicalRule, type TechnicalBar, type TechnicalDecision, type TechnicalFormula } from '../../contracts/src/technical-screen.ts'

export interface TechnicalInputs {
  dates: string[]
  bars: TechnicalBar[]
  raw: TechnicalBar[]
  /** Only positive membership is authoritative: public pools can exclude ST/new listings. */
  limitDates: string[]
}

/** Three-valued evaluation: absent history never becomes a zero or a verified rejection. */
export function evaluateTechnical(formula: TechnicalFormula, input: TechnicalInputs): TechnicalDecision {
  const evidence = formula.rules.map(rule => {
    const dates = input.dates.slice(0, Math.max(0, input.dates.length - (rule.offset ?? 0)))
    const target = dates.at(-1)
    const bars = target ? input.bars.filter(bar => bar.date <= target) : []
    const aligned = (days: number) => dates.length >= days && bars.length >= days
      && dates.slice(-days).every((date, index) => bars[bars.length - days + index]?.date === date)
    const average = (period: number, offset = 0): number | null => {
      const end = bars.length - offset
      if (end < period || !aligned(period + offset)) return null
      const window = bars.slice(end - period, end)
      if (window.some(bar => bar.volume <= 0)) return null
      return window.reduce((sum, bar) => sum + bar.close, 0) / period
    }
    let matched: boolean | null = null
    let detail = !target ? '基准日前交易日历长度不足，未核实'
      : bars.at(-1)?.date !== target ? `日线日期未对齐：期望${target}，实际${bars.at(-1)?.date ?? '无数据'}（可能停牌或来源滞后），未核实`
        : bars.some(bar => bar.volume <= 0) ? '计算窗口包含停牌数据或历史缺口，未核实' : '所需均线历史长度不足或计算窗口有缺口，未核实'
    switch (rule.kind) {
      case 'price-ma': {
        const ma = average(rule.period), close = bars.at(-1)?.close
        if (ma !== null && close !== undefined && aligned(1)) {
          matched = rule.relation === 'above' ? close > ma : close < ma
          detail = `收盘${close.toFixed(4)}；MA${rule.period}=${ma.toFixed(4)}`
        }
        break
      }
      case 'ma-spread': {
        const spreads = Array.from({ length: rule.days }, (_, day) => {
          const values = rule.periods.map(period => average(period, day))
          return values.some(value => value === null) ? null : (Math.max(...values as number[]) / Math.min(...values as number[]) - 1) * 100
        })
        if (aligned(rule.days) && spreads.every(value => value !== null)) {
          const maximum = Math.max(...spreads as number[])
          matched = maximum <= rule.maxPercent + 1e-10
          detail = `窗口最大极差比例${maximum.toFixed(4)}%`
        }
        break
      }
      case 'ma-cross': {
        if (!aligned(rule.within + 1)) break
        const values = Array.from({ length: rule.within + 1 }, (_, day) => {
          const short = average(rule.short, day), long = average(rule.long, day)
          return short === null || long === null ? null : short - long
        })
        if (values.some(value => value === null)) break
        const crossed = values.slice(0, -1).findIndex((current, index) => rule.direction === 'up'
          ? current! > 0 && values[index + 1]! <= 0 : current! < 0 && values[index + 1]! >= 0)
        matched = crossed >= 0
        detail = crossed >= 0 ? `交叉日期${bars[bars.length - 1 - crossed]!.date}` : `窗口内无交叉；最新均线差${values[0]!.toFixed(4)}`
        break
      }
      case 'ma-turn': {
        const a = average(rule.period), b = average(rule.period, 1), c = average(rule.period, 2)
        if (a === null || b === null || c === null || !aligned(3)) break
        matched = rule.direction === 'up' ? a > b && b <= c : a < b && b >= c
        detail = `前日斜率${(b - c).toFixed(4)}；最新斜率${(a - b).toFixed(4)}`
        break
      }
      case 'ma-slope': {
        const values = Array.from({ length: rule.days + 1 }, (_, day) => average(rule.period, day))
        if (values.some(value => value === null)) break
        const slopes = values.slice(0, -1).map((value, i) => value! - values[i + 1]!)
        matched = slopes.every(value => rule.direction === 'up' ? value > 0 : value < 0)
        detail = `截至${target}；窗口均线斜率（由近到远）：${slopes.map(value => value.toFixed(4)).join('、')}`
        break
      }
      case 'limit-up': {
        const window = dates.slice(-rule.days)
        const raw = new Map(input.raw.map(bar => [bar.date, bar]))
        const verified = window.filter(date => {
          const bar = raw.get(date)
          return input.limitDates.includes(date) && bar && bar.volume > 0 && Math.abs(bar.close - bar.high) < 0.005
        })
        const notSealed = window.filter(date => {
          const bar = raw.get(date)
          return bar && bar.volume > 0 && bar.high - bar.close >= 0.005
        })
        const possible = window.length - notSealed.length
        matched = dates.length < rule.days ? null : verified.length >= rule.minimum ? true : possible < rule.minimum ? false : null
        detail = `历史收盘涨停池与不复权日线核实${verified.length}次${verified.length ? `：${verified.join('、')}` : ''}；${notSealed.length}日收盘低于最高价、确认未收盘封板；其余${possible - verified.length}日未核实，未入池不推断未涨停（池可能排除ST/新股或历史缺失）`
        break
      }
    }
    return { formula: describeTechnicalRule(rule), matched, detail }
  })
  const values = evidence.map(item => item.matched)
  return { evidence, matched: formula.match === 'all'
    ? values.includes(false) ? false : values.includes(null) ? null : true
    : values.includes(true) ? true : values.includes(null) ? null : false }
}
