import type { ProviderMeta } from '../../../contracts/src/index.ts'
import type { Clock } from '../http.ts'

/** Coalesce refreshes, retain the last successful response, and back off failures. */
export class ProviderCache<T extends { meta: ProviderMeta }> {
  private readonly entries = new Map<string, { value: T | null; expiresAt: number }>()
  private readonly pending = new Map<string, Promise<T | null>>()

  constructor(private readonly clock: Clock, private readonly ttlMs: number) {}

  get(key: string, load: () => Promise<T>): Promise<T | null> {
    const pending = this.pending.get(key)
    if (pending !== undefined) return pending
    const cached = this.entries.get(key)
    if (cached !== undefined && cached.expiresAt > this.clock.now()) {
      return Promise.resolve(cached.value === null ? null : this.cached(cached.value))
    }
    const promise = load().then(value => {
      this.entries.set(key, { value, expiresAt: this.clock.now() + this.ttlMs })
      return value
    }).catch(() => {
      const value = cached?.value === null || cached?.value === undefined ? null
        : { ...cached.value, meta: { ...cached.value.meta, cacheState: 'stale' as const } }
      this.entries.set(key, { value, expiresAt: this.clock.now() + 60_000 })
      return value
    }).finally(() => {
      this.pending.delete(key)
      if (this.entries.size > 500) this.entries.delete(this.entries.keys().next().value!)
    })
    this.pending.set(key, promise)
    return promise
  }

  private cached(value: T): T {
    return { ...value, meta: { ...value.meta, cacheState: value.meta.cacheState === 'fresh' ? 'cached' : value.meta.cacheState } }
  }

  clear(): number {
    const count = this.entries.size
    this.entries.clear()
    return count
  }
}
