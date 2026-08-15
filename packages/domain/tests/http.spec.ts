import { describe, expect, it } from 'vitest'
import {
  NodeFetchHttpClient,
  fetchJson,
  postJson,
  type FetchImplementation,
} from '../src/http.ts'

describe('NodeFetchHttpClient', () => {
  it('uses the browser-compatible default headers and parses GET JSON', async () => {
    let captured: RequestInit | undefined
    const fetchImplementation: FetchImplementation = async (_input, init) => {
      captured = init
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    const client = new NodeFetchHttpClient(fetchImplementation)

    const result = await fetchJson<{ ok: boolean }>(client, 'https://example.test/data', {
      headers: { Referer: 'https://example.test/' },
    })

    expect(result).toEqual({ ok: true, status: 200, data: { ok: true }, error: null })
    const headers = new Headers(captured?.headers)
    expect(headers.get('User-Agent')).toContain('Chrome/126')
    expect(headers.get('Referer')).toBe('https://example.test/')
  })

  it('serializes POST bodies and reports invalid JSON without throwing', async () => {
    let body: BodyInit | null | undefined
    const fetchImplementation: FetchImplementation = async (_input, init) => {
      body = init?.body
      return new Response('not-json', { status: 200 })
    }
    const client = new NodeFetchHttpClient(fetchImplementation)

    const result = await postJson(client, 'https://example.test/data', { symbol: '600519' })

    expect(body).toBe('{"symbol":"600519"}')
    expect(result.ok).toBe(false)
    expect(result.status).toBe(200)
    expect(result.error).toContain('有效 JSON')
  })
})
