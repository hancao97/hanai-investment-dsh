import { describe, expect, it } from 'vitest'
import { inject } from '../src/index.ts'

describe('Hanai Host composition requirements', () => {
  it('waits for the DSH-owned default model service before mounting RPC', () => {
    expect(inject).toEqual([
      'connection',
      'apiProxy',
      'sessions',
      'agentDefaultModel',
    ])
  })
})
