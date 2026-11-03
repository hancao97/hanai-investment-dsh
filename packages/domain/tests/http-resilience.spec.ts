import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CircuitBreakingHttpClient,
  CircuitOpenError,
  type Clock,
  type HttpClient,
  type HttpResponse,
} from '../src/http.ts'
import {
  RecordingHttpClient,
  ReplayHttpClient,
  readHttpFixtureMode,
} from '../src/http-cache.ts'

class FakeClock implements Clock {
  constructor(public time = 0) {}
  now(): number {
    return this.time
  }
  async sleep(): Promise<void> {}
}

function stubClient(handler: (url: string) => Promise<HttpResponse>): HttpClient {
  return { request: (url) => handler(url) }
}

describe('CircuitBreakingHttpClient', () => {
  it('opens the circuit per host after consecutive failures and recovers after cooldown', async () => {
    const clock = new FakeClock()
    const calls: string[] = []
    const client = new CircuitBreakingHttpClient(stubClient(async (url) => {
      calls.push(url)
      throw new Error('socket hang up')
    }), { failureThreshold: 3, cooldownMs: 60_000, clock })

    for (let index = 0; index < 3; index += 1) {
      await expect(client.request('https://down.example/quote')).rejects.toThrow('socket hang up')
    }
    expect(calls).toHaveLength(3)

    // 熔断期间不再发请求，也不会影响其他 host。
    await expect(client.request('https://down.example/quote')).rejects.toBeInstanceOf(CircuitOpenError)
    expect(calls).toHaveLength(3)

    clock.time += 60_001
    await expect(client.request('https://down.example/quote')).rejects.toThrow('socket hang up')
    expect(calls).toHaveLength(4)
  })

  it('resets the failure count on success and counts 429 as an upstream failure', async () => {
    const clock = new FakeClock()
    let mode: 'fail' | 'ok' | 'limited' = 'fail'
    const calls: string[] = []
    const client = new CircuitBreakingHttpClient(stubClient(async (url) => {
      calls.push(url)
      if (mode === 'fail') throw new Error('timeout')
      if (mode === 'limited') return { status: 429, body: '' }
      return { status: 200, body: '{}' }
    }), { failureThreshold: 2, cooldownMs: 10_000, clock })

    await expect(client.request('https://up.example/a')).rejects.toThrow('timeout')
    mode = 'ok'
    await expect(client.request('https://up.example/a')).resolves.toEqual({ status: 200, body: '{}' })

    mode = 'limited'
    await expect(client.request('https://up.example/a')).resolves.toEqual({ status: 429, body: '' })
    await expect(client.request('https://up.example/a')).resolves.toEqual({ status: 429, body: '' })
    // 成功过一次后计数被清零，两次 429 才触发熔断。
    await expect(client.request('https://up.example/a')).rejects.toBeInstanceOf(CircuitOpenError)
    expect(calls).toHaveLength(4)
  })
})

describe('HTTP fixtures', () => {
  it('records responses and replays them without touching the network', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hanai-http-fixtures-'))
    try {
      let networkCalls = 0
      const recorder = new RecordingHttpClient(stubClient(async () => {
        networkCalls += 1
        return { status: 200, body: '{"ok":true}' }
      }), directory)

      await recorder.request('https://quote.example/api?x=1')
      expect(networkCalls).toBe(1)

      const replay = new ReplayHttpClient(directory)
      await expect(replay.request('https://quote.example/api?x=1'))
        .resolves.toEqual({ status: 200, body: '{"ok":true}' })
      expect(networkCalls).toBe(1)

      await expect(replay.request('https://quote.example/api?x=2'))
        .rejects.toThrow('未找到 HTTP 夹具')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('separates fixtures by method and request body', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hanai-http-fixtures-'))
    try {
      const recorder = new RecordingHttpClient(stubClient(async (_url) => ({ status: 200, body: 'x' })), directory)
      await recorder.request('https://api.example/form', { method: 'POST', body: 'a=1' })
      await recorder.request('https://api.example/form', { method: 'POST', body: 'a=2' })

      const replay = new ReplayHttpClient(directory)
      await expect(replay.request('https://api.example/form', { method: 'POST', body: 'a=1' }))
        .resolves.toEqual({ status: 200, body: 'x' })
      await expect(replay.request('https://api.example/form', { method: 'POST', body: 'a=3' }))
        .rejects.toThrow('未找到 HTTP 夹具')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('parses only explicit record or replay modes', () => {
    expect(readHttpFixtureMode('record')).toBe('record')
    expect(readHttpFixtureMode('replay')).toBe('replay')
    expect(readHttpFixtureMode(undefined)).toBe('off')
    expect(readHttpFixtureMode('RECORD')).toBe('off')
  })
})
