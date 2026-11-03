import { beijingMarketDate, isMarketDate } from './market-history.ts'

export interface MacroRange { from: string; to: string }

export function macroRangeThrough(to: string): MacroRange { return { from: macroFiveYearsBefore(to), to } }

export function macroFiveYearsBefore(date: string): string {
  const year = Number(date.slice(0, 4)) - 5
  const candidate = `${year}${date.slice(4)}`
  return isMarketDate(candidate) ? candidate : `${year}-02-28`
}

export function defaultMacroRange(now = Date.now()): MacroRange {
  const bj = new Date(now + 8 * 3_600_000)
  if (bj.getUTCHours() * 60 + bj.getUTCMinutes() < 905) bj.setUTCDate(bj.getUTCDate() - 1)
  while (bj.getUTCDay() === 0 || bj.getUTCDay() === 6) bj.setUTCDate(bj.getUTCDate() - 1)
  const to = bj.toISOString().slice(0, 10)
  return macroRangeThrough(to)
}

export function isMacroRange(value: unknown, now = Date.now()): value is MacroRange {
  if (value === null || typeof value !== 'object' || !('from' in value) || !('to' in value)) return false
  const { from, to } = value
  return typeof from === 'string' && typeof to === 'string' && isMarketDate(from) && isMarketDate(to)
    && from <= to && to <= beijingMarketDate(now) && from >= macroFiveYearsBefore(to)
}
