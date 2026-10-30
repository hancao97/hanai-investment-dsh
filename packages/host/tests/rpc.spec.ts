import { describe, expect, it } from 'vitest'
import { parseHanaiRequest } from '../src/rpc.ts'
import { DEFAULT_SCAN_QUERY } from '../../contracts/src/market-scan.ts'

describe('Hanai RPC request validation', () => {
  it('bounds financial scanning without accepting arbitrary source URLs or unsupported upper bounds', () => {
    expect(parseHanaiRequest('market.scan.query', { query: DEFAULT_SCAN_QUERY })).toEqual({ query: DEFAULT_SCAN_QUERY })
    for (const payload of [{ query: { ...DEFAULT_SCAN_QUERY, ranges: { grossMargin: { max: 20 } } } }, { query: { ...DEFAULT_SCAN_QUERY, page: 0 } }, { query: DEFAULT_SCAN_QUERY, url: 'https://example.com' }, { query: DEFAULT_SCAN_QUERY, date: '2026-02-30' }, { query: { ...DEFAULT_SCAN_QUERY, ranges: { pe: { min: 30, max: 10 } } } }]) expect(() => parseHanaiRequest('market.scan.query', payload)).toThrow()
  })
  it('accepts only bounded screening questions and scoped identifiers', () => {
    expect(parseHanaiRequest('screener.create', { openingMessage: ' 银行股 ' })).toEqual({ openingMessage: '银行股' })
    expect(() => parseHanaiRequest('screener.create', { masterId: 'some-master' })).toThrow()
    expect(() => parseHanaiRequest('screener.create', { openingMessage: 'a'.repeat(4001) })).toThrow()
    expect(() => parseHanaiRequest('screener.remove', { id: '../chat' })).toThrow()
    expect(() => parseHanaiRequest('screener.list', { url: 'https://example.com' })).toThrow()
    expect(() => parseHanaiRequest('screener.rename', { id: 'chat', title: '' })).toThrow()
  })
  it('bounds research requests and keeps their conversation scope separate', () => {
    expect(parseHanaiRequest('research-chat.create', { openingMessage: ' 研究现金流 ' })).toEqual({ openingMessage: '研究现金流' })
    expect(parseHanaiRequest('research-chat.upload', { id: 'chat-1', name: '报告.txt', data: 'YWJj' })).toEqual({ id: 'chat-1', name: '报告.txt', data: 'YWJj' })
    expect(() => parseHanaiRequest('research-chat.create', { masterId: 'some-master' })).toThrow()
    expect(() => parseHanaiRequest('research-chat.remove', { id: '../chat-1' })).toThrow()
    expect(() => parseHanaiRequest('research-chat.upload', { id: 'chat-1', name: '报告.txt', data: 'a'.repeat(6990509) })).toThrow()
    expect(() => parseHanaiRequest('research-chat.rename', { id: 'chat-1', title: ' ' })).toThrow()
  })
  it('accepts only registered economic topics and bounded calendar ranges', () => {
    const range = { from: '2020-01-01', to: '2025-01-01' }
    expect(parseHanaiRequest('market.macro.indicators', { topic: 'credit', range, refresh: true })).toEqual({ topic: 'credit', range, refresh: true })
    for (const payload of [{ topic: 'unknown', range }, { topic: 'prices', range, url: 'https://example.com' }, { topic: 'activity', range: { from: '2010-01-01', to: '2025-01-01' } }, { topic: 'credit', range: { from: '2025-02-30', to: '2025-03-01' } }]) expect(() => parseHanaiRequest('market.macro.indicators', payload)).toThrow()
  })
  it('limits market activity to fixed public index and news requests', () => {
    for (const endpoint of ['market.intraday', 'market.signals'] as const) {
      expect(parseHanaiRequest(endpoint, {})).toEqual({})
      expect(() => parseHanaiRequest(endpoint, { date: '2026-10-26' })).toThrow()
      expect(() => parseHanaiRequest(endpoint, { url: 'https://example.com' })).toThrow()
    }
  })
  it('accepts only a fixed global index batch, never arbitrary symbols or URLs', () => {
    expect(parseHanaiRequest('market.indices', {})).toEqual({})
    expect(() => parseHanaiRequest('market.indices', { url: 'https://example.com' })).toThrow()
    expect(() => parseHanaiRequest('market.indices', { symbols: ['hf_GC'] })).toThrow()
  })
  it('accepts local market history reads only with real calendar dates', () => {
    expect(parseHanaiRequest('market.history.list', {})).toEqual({})
    expect(parseHanaiRequest('market.history.get', { date: '2024-02-29' })).toEqual({ date: '2024-02-29' })
    for (const date of ['2026-02-29', '2026-02-30', '2026-13-01', '../2026-10-26', '20261026']) {
      expect(() => parseHanaiRequest('market.history.get', { date })).toThrow()
    }
    expect(() => parseHanaiRequest('market.history.list', { url: 'https://example.com' })).toThrow()
    expect(() => parseHanaiRequest('market.history.get', { date: '2026-10-26', refresh: true })).toThrow()
  })
  it('accepts an independent breadth request and rejects arbitrary parameters', () => {
    expect(parseHanaiRequest('market.breadth', {})).toEqual({})
    expect(() => parseHanaiRequest('market.breadth', { url: 'https://example.com' })).toThrow()
  })
  it('accepts namespaced backup sector nodes without accepting arbitrary query or URL input', () => {
    for (const sectorCode of ['BK0475', 'SINA:new_blhy', 'SINA:gn_BCdc']) {
      expect(parseHanaiRequest('sector.stocks', { sectorCode })).toEqual({ sectorCode })
    }
    for (const sectorCode of ['SINA:hs_a', 'SINA:gn_x&page=2', 'https://example.com', 'SINA:../new_blhy']) {
      expect(() => parseHanaiRequest('sector.stocks', { sectorCode })).toThrow()
    }
  })
  it('accepts only conventional persisted themes', () => {
    expect(parseHanaiRequest('theme.set', { theme: 'light' })).toEqual({ theme: 'light' })
    expect(parseHanaiRequest('theme.set', { theme: 'dark' })).toEqual({ theme: 'dark' })
    expect(() => parseHanaiRequest('theme.set', { theme: 'ocean' })).toThrow()
    expect(() => parseHanaiRequest('theme.set', { theme: 'jade' })).toThrow()
  })

  it('validates independently refreshable stock surfaces and cache scopes strictly', () => {
    expect(parseHanaiRequest('security.quote', { secId: '1.600519' })).toEqual({ secId: '1.600519' })
    expect(parseHanaiRequest('security.trend', { secId: '0.000001' })).toEqual({ secId: '0.000001' })
    expect(parseHanaiRequest('security.kline', {
      secId: '1.600519', period: 'monthly',
    })).toEqual({ secId: '1.600519', period: 'monthly' })
    expect(parseHanaiRequest('security.kline', {
      secId: '1.600519', period: 'daily', before: '2018-06-08',
    })).toEqual({ secId: '1.600519', period: 'daily', before: '2018-06-08' })
    expect(parseHanaiRequest('security.valuation', { secId: '1.600519' })).toEqual({ secId: '1.600519' })
    expect(parseHanaiRequest('watch.valuations', { groupId: 'default' })).toEqual({ groupId: 'default' })
    expect(parseHanaiRequest('watch.securities', {})).toEqual({})
    expect(parseHanaiRequest('judgement.remove', { id: 'judgement-1' })).toEqual({ id: 'judgement-1' })
    expect(parseHanaiRequest('expert-chat.create', {
      masterId: 'sun-yuchen-perspective',
      openingMessage: ' 存储为什么会短缺？ ',
    })).toEqual({ masterId: 'sun-yuchen-perspective', openingMessage: '存储为什么会短缺？' })
    expect(parseHanaiRequest('expert-chat.get', { id: 'chat-1' })).toEqual({ id: 'chat-1' })
    expect(parseHanaiRequest('cache.clear', { scope: 'valuation' })).toEqual({ scope: 'valuation' })
    expect(parseHanaiRequest('storage.openDataRoot', {})).toEqual({})

    expect(() => parseHanaiRequest('security.kline', {
      secId: '1.600519', period: '15m',
    })).toThrow()
    expect(() => parseHanaiRequest('security.kline', {
      secId: '1.600519', period: 'daily', before: '20180608',
    })).toThrow()
    expect(() => parseHanaiRequest('cache.clear', { scope: 'all' })).toThrow()
    expect(() => parseHanaiRequest('storage.openDataRoot', { path: '/tmp' })).toThrow()
    expect(() => parseHanaiRequest('security.trend', {
      secId: '1.600519', refreshAll: true,
    })).toThrow()
    expect(() => parseHanaiRequest('watch.valuations', { groupId: '../default' })).toThrow()
    expect(() => parseHanaiRequest('watch.securities', { groupId: 'default' })).toThrow()
    expect(() => parseHanaiRequest('judgement.remove', { id: '../judgement-1' })).toThrow()
    expect(() => parseHanaiRequest('expert-chat.create', {
      masterId: 'sun-yuchen-perspective', openingMessage: '   ',
    })).toThrow()
    expect(() => parseHanaiRequest('expert-chat.create', {
      masterId: 'sun-yuchen-perspective', openingMessage: '问题', stockId: '1.600519',
    })).toThrow()
    expect(() => parseHanaiRequest('expert-chat.remove', { id: '../chat-1' })).toThrow()
  })

  it('validates the DSH default-model bridge strictly and normalizes text', () => {
    expect(parseHanaiRequest('model.default.get', {})).toEqual({})
    expect(parseHanaiRequest('model.default.set', {
      provider: ' deepseek-official ',
      model: ' deepseek-v4-pro ',
      reasoningEffort: ' high ',
    })).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    })

    expect(() => parseHanaiRequest('model.default.get', { ns: 'agent-default-model' })).toThrow()
    expect(() => parseHanaiRequest('model.default.set', {
      provider: '', model: 'deepseek-v4-pro',
    })).toThrow()
    expect(() => parseHanaiRequest('model.default.set', {
      provider: 'deepseek-official', model: 'deepseek-v4-pro', revision: 1,
    })).toThrow()
  })
})
