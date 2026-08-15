import { readFileSync } from 'node:fs'
import type { Clock, HttpClient, HttpRequest, HttpResponse } from '../src/http.ts'

export interface ProviderFixtures {
  eastmoney: {
    indices: Record<string, Record<string, unknown>>
    breadth: unknown
    sector: unknown
    quote: unknown
    metrics: unknown
    kline: unknown
    trend: unknown
  }
  tencent: { kline: unknown; trend: unknown }
  gurufocus: { chart: unknown; screener: unknown }
}

export function loadProviderFixtures(): ProviderFixtures {
  const path = new URL('./fixtures/providers.json', import.meta.url)
  return JSON.parse(readFileSync(path, 'utf8')) as ProviderFixtures
}

export class FakeClock implements Clock {
  readonly sleeps: number[] = []

  constructor(private timestamp: number) {}

  now(): number {
    return this.timestamp
  }

  async sleep(milliseconds: number): Promise<void> {
    this.sleeps.push(milliseconds)
    this.timestamp += milliseconds
  }

  advance(milliseconds: number): void {
    this.timestamp += milliseconds
  }
}

export class HandlerHttpClient implements HttpClient {
  readonly requests: Array<{ url: string; request: HttpRequest }> = []

  constructor(
    private readonly handler: (url: string, request: HttpRequest) => HttpResponse | Promise<HttpResponse>,
  ) {}

  async request(url: string, request: HttpRequest = {}): Promise<HttpResponse> {
    this.requests.push({ url, request })
    return this.handler(url, request)
  }
}

export function jsonResponse(value: unknown, status = 200): HttpResponse {
  return { status, body: JSON.stringify(value) }
}
