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
  'sina',
  'eastmoney-push2his',
  'eastmoney-push2',
  'gurufocus',
] as const

export type SourceId = (typeof SOURCE_PRIORITY)[number]

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

export class SourceCircuit {
  private readonly failureThreshold: number
  private readonly cooldownMs: number
  private readonly clock: Clock
  private readonly states = new Map<SourceId, { failures: number; openUntil: number }>()

  constructor(options: SourceCircuitOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3
    this.cooldownMs = options.cooldownMs ?? 5 * 60_000
    this.clock = options.clock ?? systemClock
  }

  isOpen(source: SourceId): boolean {
    const state = this.states.get(source)
    return state !== undefined && state.openUntil > this.clock.now()
  }

  /** 调用单个数据源；熔断期间直接抛错，由调用方的兜底链切到下一个源。 */
  async run<T>(source: SourceId, task: () => Promise<T>): Promise<T> {
    const state = this.states.get(source)
    if (state !== undefined && state.openUntil > this.clock.now()) {
      throw new SourceCircuitOpenError(source, state.openUntil)
    }
    try {
      const value = await task()
      this.states.delete(source)
      return value
    } catch (error) {
      this.recordFailure(source)
      throw error
    }
  }

  /** 按顺序尝试多个源，返回第一个非空结果；null 也计入该源的一次失败。 */
  async first<T>(attempts: readonly SourceAttempt<T>[]): Promise<T | null> {
    for (const attempt of attempts) {
      if (this.isOpen(attempt.source)) continue
      try {
        const value = await attempt.run()
        if (value !== null) {
          this.states.delete(attempt.source)
          return value
        }
        this.recordFailure(attempt.source)
      } catch {
        this.recordFailure(attempt.source)
      }
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

  private recordFailure(source: SourceId): void {
    const state = this.states.get(source) ?? { failures: 0, openUntil: 0 }
    state.failures += 1
    if (state.failures >= this.failureThreshold) {
      state.openUntil = this.clock.now() + this.cooldownMs
      state.failures = 0
    }
    this.states.set(source, state)
  }
}
