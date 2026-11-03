import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { systemClock } from '../../src/http.ts'
import { PacedHttpClient } from '../../src/providers/paced-http.ts'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-02T20:00:00+08:00')) })
afterEach(() => vi.useRealTimers())

it('spaces concurrent requests across Eastmoney hosts while keeping Tencent independent', async () => {
  const started: number[] = []
  const request = vi.fn(async () => { started.push(Date.now()); return { status: 200, body: '{}' } })
  const client = new PacedHttpClient({ request }, systemClock)
  const jobs = [client.request('https://push2his.eastmoney.com/a'), client.request('https://datacenter.eastmoney.com/b'),
    client.request('https://datacenter-web.eastmoney.com/c')]
  await client.request('https://web.ifzq.gtimg.cn/d')
  expect(request).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(499)
  expect(request).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(request).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(500)
  await Promise.all(jobs)
  expect(started.map(time => time - started[0]!)).toEqual([0, 0, 500, 1000])
})

it('does not send aborted queued work or poison the next request after a failure', async () => {
  const request = vi.fn(async () => ({ status: 200, body: '{}' }))
  request.mockRejectedValueOnce(new Error('offline'))
  const client = new PacedHttpClient({ request }, systemClock)
  await expect(client.request('https://push2his.eastmoney.com/a')).rejects.toThrow('offline')
  const controller = new AbortController()
  const cancelled = client.request('https://datacenter.eastmoney.com/b', { signal: controller.signal })
  const checked = expect(cancelled).rejects.toThrow()
  controller.abort()
  await checked
  const next = client.request('https://datacenter-web.eastmoney.com/c')
  await vi.advanceTimersByTimeAsync(500)
  await next
  expect(request).toHaveBeenCalledTimes(2)
})
