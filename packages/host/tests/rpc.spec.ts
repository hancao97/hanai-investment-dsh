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
    expect(parseHanaiRequest('watch.researchCoverage', { groupId: 'default' })).toEqual({ groupId: 'default' })
    expect(parseHanaiRequest('research.followup.create', {
      secId: '1.600519', judgementId: 'judgement-1', reportVersion: 1,
      title: ' 核验现金流 ', dueDate: '2026-09-30',
    })).toEqual({
      secId: '1.600519', judgementId: 'judgement-1', reportVersion: 1,
      title: '核验现金流', dueDate: '2026-09-30',
    })
    expect(parseHanaiRequest('research.followup.update', {
      id: 'followup-1', completed: true,
    })).toEqual({ id: 'followup-1', completed: true })
    expect(parseHanaiRequest('research.inbox', { status: 'open' })).toEqual({ status: 'open' })
    expect(parseHanaiRequest('research.prediction.create', {
      secId: '1.600519', statement: ' 下一季度现金流改善 ',
      resolutionCriteria: ' 以法定财报为准 ', probabilityPct: 70, dueDate: '2026-10-31',
    })).toEqual({
      secId: '1.600519', statement: '下一季度现金流改善',
      resolutionCriteria: '以法定财报为准', probabilityPct: 70, dueDate: '2026-10-31',
    })
    expect(parseHanaiRequest('research.prediction.resolve', {
      id: 'prediction-1', outcome: 'not-occurred',
    })).toEqual({ id: 'prediction-1', outcome: 'not-occurred' })
    expect(parseHanaiRequest('research.prediction.inbox', { status: 'pending' })).toEqual({ status: 'pending' })
    expect(parseHanaiRequest('research.quality', {})).toEqual({})
    expect(parseHanaiRequest('research.compare', { secId: '1.600519' })).toEqual({ secId: '1.600519' })
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
    expect(() => parseHanaiRequest('watch.researchCoverage', { groupId: '../default' })).toThrow()
    expect(() => parseHanaiRequest('research.followup.update', { id: 'followup-1' })).toThrow()
    expect(() => parseHanaiRequest('research.inbox', { status: 'overdue' })).toThrow()
    expect(() => parseHanaiRequest('research.prediction.create', {
      secId: '1.600519', statement: '现金流改善', resolutionCriteria: '以财报为准',
      probabilityPct: 100, dueDate: '2026-10-31',
    })).toThrow()
    expect(() => parseHanaiRequest('research.prediction.resolve', {
      id: 'prediction-1', outcome: 'pending',
    })).toThrow()
    expect(() => parseHanaiRequest('research.prediction.inbox', { status: 'overdue' })).toThrow()
    expect(() => parseHanaiRequest('research.quality', { refresh: true })).toThrow()
    expect(() => parseHanaiRequest('research.compare', { secId: '600519' })).toThrow()
    expect(() => parseHanaiRequest('research.followup.create', {
      secId: '1.600519', title: '', dueDate: '2026/09/30',
    })).toThrow()
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
