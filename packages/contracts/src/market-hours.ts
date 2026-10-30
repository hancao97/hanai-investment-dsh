/** Beijing polling window, including auction/closing buffers; not an exchange holiday calendar. */
export function isMarketOpen(now: Date = new Date()): boolean {
  const bj = new Date(now.getTime() + 8 * 3_600_000)
  const day = bj.getUTCDay()
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  return day > 0 && day < 6 && minutes >= 565 && minutes <= 905
}

/** The lunch break also uses cached overseas quotes and the resting header hint. */
export function isMarketResting(now: Date = new Date()): boolean {
  const bj = new Date(now.getTime() + 8 * 3_600_000)
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  return !isMarketOpen(now) || (minutes >= 690 && minutes < 780)
}
