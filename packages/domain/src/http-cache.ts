/**
 * 开发期 HTTP 夹具：record 模式把真实响应落盘，replay 模式只读本地文件。
 *
 * 调试页面时不需要反复请求上游，避免因高频调用被限流或封 IP。
 * 开关通过环境变量控制：
 *   HANAI_DSH_HTTP=record  录制
 *   HANAI_DSH_HTTP=replay  回放（不发任何网络请求）
 *   HANAI_DSH_HTTP_FIXTURES 指定目录，默认在数据根目录的 tmp/http-fixtures
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HttpClient, HttpRequest, HttpResponse } from './http.ts'

export type HttpFixtureMode = 'off' | 'record' | 'replay'

export interface HttpFixtureOptions {
  mode: HttpFixtureMode
  directory: string
}

interface FixtureFile {
  url: string
  method: string
  status: number
  body: string
  recordedAt: string
}

/** 夹具文件按「方法 + URL + 请求体」哈希命名，同一请求重复录制会覆盖。 */
function fixturePath(directory: string, url: string, request: HttpRequest): string {
  const key = `${request.method ?? 'GET'} ${url}\n${request.body ?? ''}`
  const hash = createHash('sha1').update(key).digest('hex')
  return join(directory, `${hash}.json`)
}

/** 回放：命中本地夹具就返回，未命中直接报错，绝不回落到真实网络。 */
export class ReplayHttpClient implements HttpClient {
  constructor(private readonly directory: string) {}

  async request(url: string, request: HttpRequest = {}): Promise<HttpResponse> {
    const path = fixturePath(this.directory, url, request)
    if (!existsSync(path)) {
      throw new Error(`未找到 HTTP 夹具：${url}（先用 HANAI_DSH_HTTP=record 录制）`)
    }
    const saved = JSON.parse(readFileSync(path, 'utf8')) as FixtureFile
    return { status: saved.status, body: saved.body }
  }
}

/** 录制：请求真实上游，并把响应写入夹具目录；写盘失败不影响主流程。 */
export class RecordingHttpClient implements HttpClient {
  constructor(
    private readonly base: HttpClient,
    private readonly directory: string,
  ) {}

  async request(url: string, request: HttpRequest = {}): Promise<HttpResponse> {
    const response = await this.base.request(url, request)
    try {
      mkdirSync(this.directory, { recursive: true })
      const record: FixtureFile = {
        url,
        method: request.method ?? 'GET',
        status: response.status,
        body: response.body,
        recordedAt: new Date().toISOString(),
      }
      writeFileSync(fixturePath(this.directory, url, request), JSON.stringify(record), 'utf8')
    } catch {
      // 录制是开发辅助能力，失败时保持正常返回。
    }
    return response
  }
}

export function withHttpFixtures(base: HttpClient, options: HttpFixtureOptions): HttpClient {
  if (options.mode === 'record') return new RecordingHttpClient(base, options.directory)
  if (options.mode === 'replay') return new ReplayHttpClient(options.directory)
  return base
}

export function readHttpFixtureMode(value: string | undefined): HttpFixtureMode {
  return value === 'record' || value === 'replay' ? value : 'off'
}
