import { describe, expect, it } from 'vitest'
import type { ProviderMeta } from '../../contracts/src/index.ts'
import { describeDataStatus } from '../src/data-status.ts'

const base: ProviderMeta = {
  providerId: 'eastmoney',
  sourceName: '东方财富',
  sourceTimestamp: '2026-08-15T10:00:00+08:00',
  fetchedAt: '2026-08-15T10:00:01+08:00',
  cacheState: 'fresh',
}

describe('describeDataStatus', () => {
  it('only calls a fresh dashboard feed live during trading', () => {
    expect(describeDataStatus(base, { marketStatus: 'trading' }).label).toBe('实时')
    expect(describeDataStatus(base, { marketStatus: 'pre' }).label).toBe('盘前')
    expect(describeDataStatus(base, { marketStatus: 'break' }).label).toBe('午间休市')
    expect(describeDataStatus(base, { marketStatus: 'closed' }).label).toBe('已收盘')
    expect(describeDataStatus(base, { liveCapable: false }).label).toBe('最新数据')
  })

  it('distinguishes delayed, fallback, cached, unavailable, and missing provenance', () => {
    expect(describeDataStatus({ ...base, providerId: 'eastmoney-delay', sourceName: '东方财富（延迟行情）', cacheState: 'stale' }).label).toBe('延迟行情')
    expect(describeDataStatus({ ...base, providerId: 'tencent-fallback', sourceName: '腾讯行情（备源）' }).label).toBe('备源降级')
    expect(describeDataStatus({ ...base, providerId: 'eastmoney-memory-cache', sourceName: '东方财富（最近成功快照）', cacheState: 'stale' }).label).toBe('历史快照')
    expect(describeDataStatus({ ...base, cacheState: 'cached' }).label).toBe('缓存数据')
    expect(describeDataStatus({ ...base, cacheState: 'unavailable' }).label).toBe('不可用')
    expect(describeDataStatus(undefined).label).toBe('来源未知')
  })

  it('never keeps a live claim after a refresh failure', () => {
    expect(describeDataStatus(base, { marketStatus: 'trading', refreshFailed: true })).toMatchObject({
      kind: 'refresh-failed',
      label: '刷新失败',
    })
  })
})
