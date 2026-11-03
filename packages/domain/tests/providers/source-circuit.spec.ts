import { describe, expect, it } from 'vitest'
import { FakeClock } from '../helpers.ts'
import {
  SOURCE_PRIORITY,
  SourceCircuit,
  SourceCircuitOpenError,
  type SourceId,
} from '../../src/providers/source-circuit.ts'

const NOW = Date.parse('2026-10-23T10:00:00+08:00')
const fail = (): Promise<never> => Promise.reject(new Error('upstream down'))

describe('SourceCircuit', () => {
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
  })
})
