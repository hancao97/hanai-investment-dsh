import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { HanaiClient, normalizeApiKey } from '../src/api.ts'

describe('HanaiClient DSH credentials', () => {
  it('describes only the write-only DeepSeek credential reference', async () => {
    const describe = vi.fn().mockResolvedValue(apiOk({
      credentials: {
        DEEPSEEK_API_KEY: {
          configured: true,
          writable: true,
          source: 'file',
        },
      },
    }))
    const client = makeClient({ describe })

    await expect(client.credential()).resolves.toEqual({
      configured: true,
      writable: true,
      source: 'file',
    })
    expect(describe).toHaveBeenCalledWith({ refs: ['DEEPSEEK_API_KEY'] })
  })

  it('normalizes and writes the key without sending it through Hanai RPC', async () => {
    const rpcCall = vi.fn()
    const set = vi.fn().mockResolvedValue(apiOk({}))
    const client = makeClient({ rpcCall, set })

    await expect(client.setDeepSeekKey('  test-key_123  ')).resolves.toBeUndefined()
    expect(set).toHaveBeenCalledWith({
      ref: 'DEEPSEEK_API_KEY',
      value: 'test-key_123',
    })
    expect(rpcCall).not.toHaveBeenCalled()
  })

  it('unsets only the DeepSeek credential reference', async () => {
    const unset = vi.fn().mockResolvedValue(apiOk({}))
    const client = makeClient({ unset })

    await expect(client.unsetDeepSeekKey()).resolves.toBeUndefined()
    expect(unset).toHaveBeenCalledWith({ ref: 'DEEPSEEK_API_KEY' })
  })

  it('rejects credential reads and writes outside a loopback page', async () => {
    const describe = vi.fn()
    const set = vi.fn()
    const unset = vi.fn()
    const client = makeClient({ describe, set, unset }, false)

    await expect(client.credential()).rejects.toThrow('只能在运行 DSH 的本机页面设置')
    await expect(client.setDeepSeekKey('test-key_123')).rejects.toThrow('只能在运行 DSH 的本机页面设置')
    await expect(client.unsetDeepSeekKey()).rejects.toThrow('只能在运行 DSH 的本机页面设置')
    expect(describe).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(unset).not.toHaveBeenCalled()
  })

  it.each([
    ['', 'API Key 不能为空'],
    ['DEEPSEEK_API_KEY=test-key_123', '不要包含变量名或等号'],
    ['"test-key_123"', '包含不支持的字符'],
    ['test-key\n123', '包含不支持的字符'],
  ])('rejects an unsafe key representation without forwarding it: %j', async (raw, message) => {
    const set = vi.fn()
    const client = makeClient({ set })

    expect(() => normalizeApiKey(raw)).toThrow(message)
    await expect(client.setDeepSeekKey(raw)).rejects.toThrow(message)
    expect(set).not.toHaveBeenCalled()
  })
})

describe('HanaiClient DSH default model settings', () => {
  it('reads the process-wide selection through the Hanai Host bridge', async () => {
    const rpcCall = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'high',
      },
    })
    const client = makeClient({ rpcCall })

    await expect(client.defaultModel()).resolves.toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
      writable: true,
      revision: 0,
    })
    expect(rpcCall).toHaveBeenCalledWith('/hanai', 'model.default.get', {}, undefined)
  })

  it('saves provider/model through the bridge and clears incompatible effort by omission', async () => {
    const rpcCall = vi.fn().mockResolvedValue({
      ok: true,
      value: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    const client = makeClient({ rpcCall })

    await expect(client.setDefaultModel({
      provider: ' deepseek-official ',
      model: ' deepseek-v4-flash ',
    }, 11)).resolves.toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      writable: true,
      revision: 0,
    })
    expect(rpcCall).toHaveBeenCalledWith('/hanai', 'model.default.set', {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    }, undefined)
  })

  it('keeps the provider/model catalog on the native DSH llm API', async () => {
    const models = vi.fn().mockResolvedValue(apiOk({ groups: [{
      id: 'deepseek-official', name: 'DeepSeek', models: [],
    }], failures: [] }))
    const client = makeClient({ models })

    await expect(client.models()).resolves.toEqual([{
      id: 'deepseek-official', name: 'DeepSeek', models: [],
    }])
    expect(models).toHaveBeenCalledWith({})
  })

  it('does not expose settings through a non-loopback page', async () => {
    const rpcCall = vi.fn()
    const client = makeClient({ rpcCall }, false)
    await expect(client.defaultModel()).rejects.toThrow('只能在运行 DSH 的本机页面设置')
    expect(rpcCall).not.toHaveBeenCalled()
  })
})

function makeClient(
  doubles: {
    describe?: ReturnType<typeof vi.fn>
    models?: ReturnType<typeof vi.fn>
    rpcCall?: ReturnType<typeof vi.fn>
    set?: ReturnType<typeof vi.fn>
    unset?: ReturnType<typeof vi.fn>
  },
  isLoopback = true,
): HanaiClient {
  const connection = {
    isLoopback,
    rpc: { call: doubles.rpcCall ?? vi.fn() },
    api: {
      credentials: {
        describe: doubles.describe ?? vi.fn(),
        set: doubles.set ?? vi.fn(),
        unset: doubles.unset ?? vi.fn(),
      },
      llm: { models: doubles.models ?? vi.fn() },
    },
  }
  const context = { get: () => connection } as unknown as ClientContext
  return new HanaiClient(context)
}

function apiOk(value: unknown) {
  return Promise.resolve({ rpcId: 'test', result: { ok: true as const, value } })
}
