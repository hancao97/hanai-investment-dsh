import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../helpers.ts'
import {
  SOURCE_PRIORITY,
  SourceCircuit,
  SourceCircuitOpenError,
  SourceDataUnavailableError,
  type SourceId,
} from '../../src/providers/source-circuit.ts'

const NOW = Date.parse('2026-10-23T10:00:00+08:00')
const fail = (): Promise<never> => Promise.reject(new Error('upstream down'))

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(() => vi.useRealTimers())

describe('SourceCircuit', () => {
  it('does not count gaps or cancellation as outages, or reset a real failure with a gap', async () => {
    const circuit = new SourceCircuit({ clock: new FakeClock(NOW) })
    await expect(circuit.run('tencent-daily', fail)).rejects.toThrow()
    await expect(circuit.run('tencent-daily', async () => { throw new SourceDataUnavailableError('停牌/未覆盖') })).rejects.toThrow()
    const controller = new AbortController()
    await expect(circuit.run('tencent-daily', async () => { controller.abort(); throw controller.signal.reason }, controller.signal)).rejects.toThrow()
    expect(circuit.snapshot('tencent-daily').failures).toBe(1)
    await circuit.run('tencent', async () => 'quote ok')
    expect(circuit.snapshot('tencent-daily').failures).toBe(1)
    await expect(circuit.run('tencent-daily', async () => { throw new DOMException('request timeout', 'AbortError') })).rejects.toThrow()
    expect(circuit.snapshot('tencent-daily').failures).toBe(2)
  })
  it('exposes actual attempt history without probing and retains failures until a successful retry', async () => {
    const clock = new FakeClock(NOW)
    const circuit = new SourceCircuit({ clock, failureThreshold: 1 })
    expect(circuit.snapshot('sina')).toMatchObject({ lastAttemptAt: null, lastError: null, openUntil: null })
    await expect(circuit.run('sina', fail)).rejects.toThrow('upstream down')
    const failed = circuit.snapshot('sina')
    expect(failed).toMatchObject({ lastAttemptAt: new Date(NOW).toISOString(), lastSuccessAt: null,
      lastError: 'upstream down', openUntil: new Date(NOW + 300_000).toISOString() })
    const probe = vi.fn(async () => 'ok')
    await expect(circuit.run('sina', probe)).rejects.toThrow('已熔断')
    expect(probe).not.toHaveBeenCalled()
    expect(circuit.snapshot('sina')).toEqual(failed)
    clock.advance(300_000)
    expect(circuit.snapshot('sina')).toMatchObject({ lastError: 'upstream down', openUntil: null })
    await circuit.run('sina', probe)
    expect(circuit.snapshot('sina')).toMatchObject({ lastError: null, failures: 0, openUntil: null,
      lastSuccessAt: new Date(NOW + 300_000).toISOString() })
  })

  it('records a null result as failure rather than a successful response', async () => {
    const circuit = new SourceCircuit({ clock: new FakeClock(NOW) })
    await circuit.run('gurufocus', async () => null)
    expect(circuit.snapshot('gurufocus')).toMatchObject({ lastSuccessAt: null, failures: 1, lastError: '未返回可用数据' })
  })

  it('skips a source after three consecutive failures and retries after cooldown', async () => {
    const clock = new FakeClock(NOW)
    const circuit = new SourceCircuit({ clock, failureThreshold: 3, cooldownMs: 60_000 })

    for (let index = 0; index < 3; index += 1) {
      await expect(circuit.run('eastmoney-push2his', fail)).rejects.toThrow('upstream down')
    }
    expect(circuit.isOpen('eastmoney-push2his')).toBe(true)

    // 熔断期间直接短路，不再触达该源。
    let touched = false
    await expect(circuit.run('eastmoney-push2his', async () => {
      touched = true
      return 'unreachable'
    })).rejects.toBeInstanceOf(SourceCircuitOpenError)
    expect(touched).toBe(false)

    clock.advance(60_001)
    expect(circuit.isOpen('eastmoney-push2his')).toBe(false)
    await expect(circuit.run('eastmoney-push2his', async () => 'ok')).resolves.toBe('ok')
  })

  it('resets the failure count on success', async () => {
    const clock = new FakeClock(NOW)
    const circuit = new SourceCircuit({ clock, failureThreshold: 2, cooldownMs: 60_000 })

    await expect(circuit.run('tencent', fail)).rejects.toThrow()
    await circuit.run('tencent', async () => 'ok')
    await expect(circuit.run('tencent', fail)).rejects.toThrow()
    expect(circuit.isOpen('tencent')).toBe(false)
  })

  it('falls through to the next source in the configured order', async () => {
    const clock = new FakeClock(NOW)
    const circuit = new SourceCircuit({ clock, failureThreshold: 1, cooldownMs: 60_000 })
    await expect(circuit.run('eastmoney-push2his', fail)).rejects.toThrow()

    const value = await circuit.first([
      { source: 'eastmoney-push2his', run: async () => 'eastmoney' },
      { source: 'sina', run: async () => 'sina' },
      { source: 'tencent', run: async () => 'tencent' },
    ])
    expect(value).toBe('sina')
  })

  it('returns null when every source is unavailable', async () => {
    const clock = new FakeClock(NOW)
    const circuit = new SourceCircuit({ clock, failureThreshold: 1, cooldownMs: 60_000 })
    expect(await circuit.first([
      { source: 'tencent', run: fail },
      { source: 'sina', run: fail },
    ])).toBeNull()
    expect(circuit.isOpen('tencent')).toBe(true)
    expect(circuit.isOpen('sina')).toBe(true)
  })

  it('orders availability by the a-stock-data source priority', () => {
    const clock = new FakeClock(NOW)
    const circuit = new SourceCircuit({ clock })
    const sources: SourceId[] = ['eastmoney-push2', 'sina', 'gurufocus', 'tencent', 'eastmoney-push2his']
    expect(circuit.available(sources)).toEqual([
      'tencent', 'sina', 'eastmoney-push2his', 'eastmoney-push2', 'gurufocus',
    ])
    expect(SOURCE_PRIORITY[0]).toBe('tencent')
    expect(circuit.available(['eastmoney-push2ex', 'legu'])).toEqual(['legu', 'eastmoney-push2ex'])
  })
})
