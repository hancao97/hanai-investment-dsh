import { describe, expect, it } from 'vitest'
import { parseHanaiRequest } from '../src/rpc.ts'

describe('Hanai RPC request validation', () => {
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
    expect(parseHanaiRequest('security.valuation', { secId: '1.600519' })).toEqual({ secId: '1.600519' })
    expect(parseHanaiRequest('watch.valuations', { groupId: 'default' })).toEqual({ groupId: 'default' })
    expect(parseHanaiRequest('judgement.remove', { id: 'judgement-1' })).toEqual({ id: 'judgement-1' })
    expect(parseHanaiRequest('cache.clear', { scope: 'valuation' })).toEqual({ scope: 'valuation' })
    expect(parseHanaiRequest('storage.openDataRoot', {})).toEqual({})

    expect(() => parseHanaiRequest('security.kline', {
      secId: '1.600519', period: '15m',
    })).toThrow()
    expect(() => parseHanaiRequest('cache.clear', { scope: 'all' })).toThrow()
    expect(() => parseHanaiRequest('storage.openDataRoot', { path: '/tmp' })).toThrow()
    expect(() => parseHanaiRequest('security.trend', {
      secId: '1.600519', refreshAll: true,
    })).toThrow()
    expect(() => parseHanaiRequest('watch.valuations', { groupId: '../default' })).toThrow()
    expect(() => parseHanaiRequest('judgement.remove', { id: '../judgement-1' })).toThrow()
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
