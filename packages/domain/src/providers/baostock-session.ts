import { createConnection, type Socket } from 'node:net'
import { crc32, inflateSync } from 'node:zlib'
import { SourceDataUnavailableError } from './source-circuit.ts'

/** Anonymous BaoStock wire transport shared by constituents and daily preparation. */
export class BaoStockSession {
  private socket: Socket | undefined
  close(): void { this.socket?.destroy(); this.socket = undefined }

  exchange(type: string, body: string, signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted()
    if (!this.socket || this.socket.destroyed) {
      this.socket = createConnection({ host: 'public-api.baostock.com', port: 10030 })
      this.socket.on('error', () => {}) // An idle peer can close after the request listeners are removed.
      this.socket.unref?.()
    }
    const socket = this.socket
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0)
      const timer = setTimeout(() => fail(new Error('BaoStock 查询超时')), 10_000)
      const cleanup = () => { clearTimeout(timer); socket.off('data', receive); socket.off('error', fail); socket.off('close', closed); signal?.removeEventListener('abort', aborted) }
      const fail = (error: unknown) => { cleanup(); this.close(); reject(error) }
      const closed = () => fail(new Error('BaoStock 连接提前关闭'))
      const aborted = () => fail(signal?.reason)
      const receive = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length > 4_000_000) { fail(new Error('BaoStock 响应超限')); return }
        if (!buffer.subarray(-13).equals(Buffer.from('<![CDATA[]]>\n'))) return
        try {
          const header = buffer.subarray(0, 21).toString().split('\x01')
          const length = Number(header[2])
          if (!/^00\.9\.\d{2}$/.test(header[0] ?? '') || header[1] !== (Number.parseInt(type, 16) + 1).toString(16).toUpperCase().padStart(2, '0')
            || !Number.isSafeInteger(length) || length <= 0 || length > buffer.length - 21) throw new Error('BaoStock 报头无效')
          let payload: string
          if (type === '95') {
            // BaoStock compresses history response bodies; zlib checks stream integrity.
            payload = inflateSync(buffer.subarray(21, 21 + length), { maxOutputLength: 4_000_000 }).toString('utf8')
          } else {
            const frame = buffer.subarray(0, -13).toString('utf8')
            const checksumAt = frame.lastIndexOf('\x01')
            if (checksumAt < 21 || crc32(frame.slice(0, checksumAt)) !== Number(frame.slice(checksumAt + 1))) throw new Error('BaoStock 响应校验失败')
            payload = frame.slice(21, checksumAt)
          }
          const fields = payload.split('\x01')
          if (fields[0] !== '0') {
            const message = `BaoStock 查询失败 ${fields[0]}：${fields[1]?.slice(0, 150)}`
            if (fields[0] === '10004006') throw new SourceDataUnavailableError(message)
            throw new Error(message)
          }
          cleanup(); resolve(fields)
        } catch (error) { fail(error) }
      }
      socket.on('data', receive).once('error', fail).once('close', closed)
      signal?.addEventListener('abort', aborted, { once: true })
      const message = `00.9.40\x01${type}\x01${String(Buffer.byteLength(body)).padStart(10, '0')}${body}`
      socket.write(`${message}\x01${crc32(message)}\n`)
    })
  }
}
