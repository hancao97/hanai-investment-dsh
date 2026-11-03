import { EventEmitter } from 'node:events'
import { createConnection, type Socket } from 'node:net'
import { crc32, deflateSync } from 'node:zlib'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BaoStockSession } from '../../src/providers/baostock-session.ts'

vi.mock('node:net', () => ({ createConnection: vi.fn() }))
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-02T20:00:00+08:00')) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function fixture(compressed = false) {
  const socket = new EventEmitter() as Socket
  socket.destroy = vi.fn(() => socket)
  socket.write = vi.fn(() => {
    const body = '0\x01success\x01query_history_k_data_plus\x01anonymous\x011\x012000\x01{"record":[]}'
    const data = compressed ? deflateSync(Buffer.from(body)) : Buffer.from(body)
    const header = Buffer.from(`00.9.40\x0196\x01${String(data.length).padStart(10, '0')}`)
    const response = compressed ? Buffer.concat([header, data, Buffer.from('<![CDATA[]]>\n')])
      : Buffer.from(`${header.toString()}${body}\x01${crc32(Buffer.concat([header, data]))}<![CDATA[]]>\n`)
    socket.emit('data', response.subarray(0, 24)); socket.emit('data', response.subarray(24))
    return true
  }) as Socket['write']
  vi.mocked(createConnection).mockReturnValueOnce(socket)
  return socket
}

it('assembles fragmented compressed history and validates the response type', async () => {
  const socket = fixture(true), session = new BaoStockSession()
  expect((await session.exchange('95', 'query'))[2]).toBe('query_history_k_data_plus')
  await expect(session.exchange('33', 'wrong-type')).rejects.toThrow('报头')
  expect(socket.destroy).toHaveBeenCalled()
})

it('closes a blocked socket on cancellation without waiting for its timeout', async () => {
  const socket = fixture(true), session = new BaoStockSession(), controller = new AbortController()
  socket.write = vi.fn() as Socket['write']
  const promise = session.exchange('95', 'query', controller.signal)
  const checked = expect(promise).rejects.toThrow()
  controller.abort()
  await checked
  expect(socket.destroy).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('rejects damaged compressed streams', async () => {
  const socket = fixture(true), session = new BaoStockSession()
  socket.write = vi.fn(() => {
    socket.emit('data', Buffer.from('00.9.40\x0196\x010000000003bad<![CDATA[]]>\n'))
    return true
  }) as Socket['write']
  await expect(session.exchange('95', 'query')).rejects.toThrow()
  expect(socket.destroy).toHaveBeenCalledOnce()
})
