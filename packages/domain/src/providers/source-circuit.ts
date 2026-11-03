/**
 * 数据源级熔断，顺序参考 a-stock-data（按实测稳定性降序）：
 *   腾讯 ifzq → 新浪 → 东财 push2his → 东财 push2。
 *
 * 规则与技能一致：同一数据源连续失败 3 次后跳过，冷却 5 分钟；任意一次成功即重置计数。
 */
import type { Clock } from '../http.ts'
import { systemClock } from '../http.ts'

export const SOURCE_PRIORITY = [
  'tencent',
  'tencent-daily',
  'tencent-calendar',
  'sina',
  'legu',
  'ths-news',
  'eastmoney-fund',
  'csi-products',
  'csi-index',
  'sse-statistics',
  'baostock',
  'baostock-transport',
  'baostock-daily',
  'baostock-calendar',
  'baostock-securities',
  'eastmoney-valuation',
  'sse-etf',
  'szse-etf',
  'eastmoney-push2his',
  'eastmoney-daily',
  'eastmoney-calendar',
  'eastmoney-financials',
  'eastmoney-dividends',
  'eastmoney-push2',
  'eastmoney-push2ex',
  'eastmoney-limit-up',
  'eastmoney-limit-previous',
  'eastmoney-limit-broken',
  'ths-limit-reason',
  'ths-limit-previous',
  'ths-hot-reason',
  'gurufocus',
  'eastmoney-macro',
  'mofcom-macro',
  '88ai-arms',
  '88ai-scan',
] as const

export type SourceId = (typeof SOURCE_PRIORITY)[number]

/** A valid response with a stock-specific coverage gap is not a provider outage. */
export class SourceDataUnavailableError extends Error {}

export interface SourceCircuitOptions {
  /** 连续失败多少次后跳过该源。 */
  failureThreshold?: number
  /** 跳过后的冷却时长。 */
  cooldownMs?: number
  clock?: Clock
}

export class SourceCircuitOpenError extends Error {
  constructor(
    readonly source: SourceId,
    readonly openUntil: number,
  ) {
    super(`数据源 ${source} 已熔断，${new Date(openUntil).toISOString()} 后重试`)
    this.name = 'SourceCircuitOpenError'
  }
}

export interface SourceAttempt<T> {
  source: SourceId
  run: () => Promise<T | null>
}

interface SourceState {
  failures: number
  openUntil: number
  lastAttemptAt: number
  lastSuccessAt: number | null
  lastError: string | null
}

export class SourceCircuit {
  private readonly failureThreshold: number
  private readonly cooldownMs: number
  private readonly clock: Clock
  private readonly states = new Map<SourceId, SourceState>()

  constructor(options: SourceCircuitOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3
    this.cooldownMs = options.cooldownMs ?? 5 * 60_000
    this.clock = options.clock ?? systemClock
  }

  isOpen(source: SourceId): boolean {
    const state = this.states.get(source)
    return state !== undefined && state.openUntil > this.clock.now()
  }

  snapshot(source: SourceId) {
    const state = this.states.get(source)
    return {
      lastAttemptAt: state === undefined ? null : new Date(state.lastAttemptAt).toISOString(),
      lastSuccessAt: state?.lastSuccessAt == null ? null : new Date(state.lastSuccessAt).toISOString(),
      lastError: state?.lastError ?? null,
      failures: state?.failures ?? 0,
      openUntil: state !== undefined && state.openUntil > this.clock.now() ? new Date(state.openUntil).toISOString() : null,
    }
  }

  /** 调用单个数据源；熔断期间直接抛错，由调用方的兜底链切到下一个源。 */
  async run<T>(source: SourceId, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    const state = this.states.get(source)
    if (state !== undefined && state.openUntil > this.clock.now()) {
      throw new SourceCircuitOpenError(source, state.openUntil)
    }
    try {
      const value = await task()
      signal?.throwIfAborted()
      if (value === null) this.recordFailure(source, new Error('未返回可用数据'))
      else this.states.set(source, {
        failures: 0, openUntil: 0, lastAttemptAt: this.clock.now(), lastSuccessAt: this.clock.now(), lastError: null,
      })
      return value
    } catch (error) {
      if (!signal?.aborted && !(error instanceof SourceDataUnavailableError)) this.recordFailure(source, error)
      throw error
    }
  }

  /** 按顺序尝试多个源，返回第一个非空结果；null 也计入该源的一次失败。 */
  async first<T>(attempts: readonly SourceAttempt<T>[]): Promise<T | null> {
    for (const attempt of attempts) {
      if (this.isOpen(attempt.source)) continue
      try {
        const value = await this.run(attempt.source, attempt.run)
        if (value !== null) {
          return value
        }
      } catch { /* run 已记录失败；继续备源。 */ }
    }
    return null
  }

  /** 某项能力当前可用的源，按优先级排序。 */
  available(sources: readonly SourceId[]): SourceId[] {
    const rank = (source: SourceId): number => {
      const index = SOURCE_PRIORITY.indexOf(source)
      return index === -1 ? SOURCE_PRIORITY.length : index
    }
    return sources.filter(source => !this.isOpen(source)).sort((left, right) => rank(left) - rank(right))
  }

  private recordFailure(source: SourceId, error: unknown): void {
    const state = this.states.get(source) ?? { failures: 0, openUntil: 0, lastAttemptAt: 0, lastSuccessAt: null, lastError: null }
    state.lastAttemptAt = this.clock.now()
    state.lastError = error instanceof Error ? error.message : String(error)
    state.failures += 1
    if (state.failures >= this.failureThreshold) {
      state.openUntil = this.clock.now() + this.cooldownMs
      state.failures = 0
    }
    this.states.set(source, state)
  }
}
