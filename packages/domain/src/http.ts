export interface Clock {
  now(): number
  sleep(milliseconds: number): Promise<void>
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
}

export interface HttpRequest {
  method?: 'GET' | 'POST'
  timeoutMs?: number
  headers?: Readonly<Record<string, string>>
  body?: string
  signal?: AbortSignal
}

export interface HttpResponse {
  status: number
  body: string
}

export interface HttpClient {
  request(url: string, request?: HttpRequest): Promise<HttpResponse>
}

export interface JsonResult<T> {
  ok: boolean
  status: number | null
  data: T | null
  error: string | null
}

export type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** Node-hosted HTTP transport. Provider code depends only on HttpClient so a Chromium-compatible transport can be substituted. */
export class NodeFetchHttpClient implements HttpClient {
  constructor(
    private readonly fetchImplementation: FetchImplementation = globalThis.fetch,
    private readonly userAgent = DEFAULT_USER_AGENT,
  ) {}

  async request(url: string, request: HttpRequest = {}): Promise<HttpResponse> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? 10_000)
    const signal = request.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, request.signal])
    const headers = new Headers({
      'User-Agent': this.userAgent,
      Accept: 'application/json, text/plain, */*',
    })
    for (const [name, value] of Object.entries(request.headers ?? {})) headers.set(name, value)

    const init: RequestInit = {
      method: request.method ?? 'GET',
      headers,
      signal,
    }
    if (request.body !== undefined) init.body = request.body

    try {
      const response = await this.fetchImplementation(url, init)
      return { status: response.status, body: await response.text() }
    } finally {
      clearTimeout(timeout)
    }
  }
}

export async function fetchJson<T>(
  client: HttpClient,
  url: string,
  request: Omit<HttpRequest, 'method' | 'body'> = {},
): Promise<JsonResult<T>> {
  try {
    const response = await client.request(url, { ...request, method: 'GET' })
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, status: response.status, data: null, error: `HTTP ${response.status}` }
    }
    try {
      return { ok: true, status: response.status, data: JSON.parse(response.body) as T, error: null }
    } catch (error) {
      return {
        ok: false,
        status: response.status,
        data: null,
        error: `响应不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  } catch (error) {
    return {
      ok: false,
      status: null,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function postJson<T>(
  client: HttpClient,
  url: string,
  body: unknown,
  request: Omit<HttpRequest, 'method' | 'body'> = {},
): Promise<JsonResult<T>> {
  try {
    const response = await client.request(url, {
      ...request,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(request.headers ?? {}) },
      body: JSON.stringify(body),
    })
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, status: response.status, data: null, error: `HTTP ${response.status}` }
    }
    try {
      return { ok: true, status: response.status, data: JSON.parse(response.body) as T, error: null }
    } catch (error) {
      return {
        ok: false,
        status: response.status,
        data: null,
        error: `响应不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  } catch (error) {
    return {
      ok: false,
      status: null,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function isoNow(clock: Clock): string {
  return new Date(clock.now()).toISOString()
}
