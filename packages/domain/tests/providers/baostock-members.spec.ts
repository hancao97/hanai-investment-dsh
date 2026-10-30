import { EventEmitter } from 'node:events'
import { createConnection, type Socket } from 'node:net'
import { crc32 } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryBaoStockMembers } from '../../src/providers/baostock-members.ts'

vi.mock('node:net', () => ({ createConnection: vi.fn() }))
beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function connect(rows = Array.from({ length: 300 }, (_, i) => ['2026-10-26', `sh.${600000 + i}`, '中文名称']), corrupt = false) {
  const socket = new EventEmitter() as Socket
  socket.destroy = vi.fn(() => socket)
  socket.write = vi.fn((message: string) => {
    const type = message.split('\x01')[1]!
    const body = type === '00' ? '0\x01success\x01login\x01anonymous' : `0\x01success\x01query_hs300_stocks\x01anonymous\x011\x012000\x01${JSON.stringify({ record: rows })}\x012026-10-28\x01updateDate, code, code_name`
    const frame = `00.9.10\x01${type === '00' ? '01' : '62'}\x01${String(body.length).padStart(10, '0')}${body}`
    const response = Buffer.from(`${frame}\x01${crc32(frame) + (corrupt ? 1 : 0)}<![CDATA[]]>\n`)
    socket.emit('data', response.subarray(0, 30))
    socket.emit('data', response.subarray(30))
    return true
  }) as Socket['write']
  vi.mocked(createConnection).mockReturnValueOnce(socket)
  return socket
}

describe('BaoStock public anonymous constituent transport', () => {
  it('assembles fragmented UTF-8 responses, checks CRC and validates all 300 members', async () => {
    const socket = connect()
    const result = await queryBaoStockMembers('2026-10-28')
    expect(result.updatedOn).toBe('2026-10-26')
    expect(result.codes).toHaveLength(300)
    expect(socket.destroy).toHaveBeenCalledOnce()
  })
  it('rejects truncated membership, duplicates, future snapshots and corrupted responses', async () => {
    for (const variant of ['missing', 'duplicate', 'future', 'crc']) {
      const rows = Array.from({ length: variant === 'missing' ? 299 : 300 }, (_, i) => [variant === 'future' ? '2026-10-29' : '2026-10-26', `sh.${600000 + (variant === 'duplicate' ? 0 : i)}`, '中文名称'])
      const socket = connect(rows, variant === 'crc')
      await expect(queryBaoStockMembers('2026-10-28')).rejects.toThrow()
      expect(socket.destroy).toHaveBeenCalledOnce()
    }
  })
  it('bounds a stalled connection and closes it', async () => {
    const socket = new EventEmitter() as Socket
    socket.write = vi.fn() as Socket['write']
    socket.destroy = vi.fn(() => socket)
    vi.mocked(createConnection).mockReturnValueOnce(socket)
    const promise = expect(queryBaoStockMembers('2026-10-28')).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(10_001)
    await promise
    expect(socket.destroy).toHaveBeenCalledOnce()
  })
})
