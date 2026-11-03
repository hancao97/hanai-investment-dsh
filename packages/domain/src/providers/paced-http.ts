import type { Clock, HttpClient, HttpRequest, HttpResponse } from '../http.ts'

/** Share request-start spacing across bulk data capabilities of the same vendor. */
export class PacedHttpClient implements HttpClient {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly lastStarted = new Map<string, number>()
  constructor(private readonly http: HttpClient, private readonly clock: Clock, private readonly intervalMs = 500) {}

  async request(url: string, request: HttpRequest = {}): Promise<HttpResponse> {
    const hostname = new URL(url).hostname
    const source = hostname.endsWith('.eastmoney.com') ? 'eastmoney'
      : hostname.endsWith('.gtimg.cn') ? 'tencent' : hostname
    const turn = (this.queues.get(source) ?? Promise.resolve()).then(async () => {
      request.signal?.throwIfAborted()
      const last = this.lastStarted.get(source)
      const delay = last === undefined ? 0 : Math.max(0, last + this.intervalMs - this.clock.now())
      if (delay) await this.clock.sleep(delay)
      request.signal?.throwIfAborted()
      this.lastStarted.set(source, this.clock.now())
    })
    this.queues.set(source, turn.catch(() => {}))
    await turn
    return this.http.request(url, request)
  }
}
