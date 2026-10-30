import { createConnection } from 'node:net'
import { crc32 } from 'node:zlib'
import { isMarketDate } from '../../../contracts/src/market-history.ts'

export interface MacroMembers { updatedOn: string; codes: string[] }

/** Public anonymous protocol used by BaoStock 0.9.4; no account or Python runtime required. */
export async function queryBaoStockMembers(date: string): Promise<MacroMembers> {
  if (!isMarketDate(date)) throw new Error('成分查询日期无效')
  const socket = createConnection({ host: 'public-api.baostock.com', port: 10030 })
  const exchange = (type: string, body: string) => new Promise<string[]>((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => fail(new Error('BaoStock 查询超时')), 10_000)
    const cleanup = () => { clearTimeout(timer); socket.off('data', receive); socket.off('error', fail); socket.off('close', closed) }
    const fail = (error: Error) => { cleanup(); reject(error) }
    const closed = () => fail(new Error('BaoStock 连接提前关闭'))
    const receive = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > 1_000_000) { fail(new Error('BaoStock 响应超限')); return }
      if (!buffer.subarray(-13).equals(Buffer.from('<![CDATA[]]>\n'))) return
      try {
        const header = buffer.subarray(0, 21).toString().split('\x01')
        const length = Number(header[2])
        if (!/^00\.9\.\d{2}$/.test(header[0] ?? '') || header[1] !== String(Number(type) + 1).padStart(2, '0') || !Number.isSafeInteger(length) || length <= 0 || length > buffer.length - 21) throw new Error('BaoStock 报头无效')
        const frame = buffer.subarray(0, -13).toString()
        const checksumAt = frame.lastIndexOf('\x01')
        if (checksumAt < 21 || crc32(frame.slice(0, checksumAt)) !== Number(frame.slice(checksumAt + 1))) throw new Error('BaoStock 响应校验失败')
        const fields = frame.slice(21, checksumAt).split('\x01')
        if (fields[0] !== '0') throw new Error(`BaoStock 查询失败：${fields[1]?.slice(0, 150)}`)
        cleanup(); resolve(fields)
      } catch (error) { fail(error instanceof Error ? error : new Error('BaoStock 响应无效')) }
    }
    socket.on('data', receive).once('error', fail).once('close', closed)
    const message = `00.9.40\x01${type}\x01${String(Buffer.byteLength(body)).padStart(10, '0')}${body}`
    socket.write(`${message}\x01${crc32(message)}\n`)
  })
  try {
    await exchange('00', 'login\x01anonymous\x01123456\x010')
    const fields = await exchange('61', `query_hs300_stocks\x01anonymous\x011\x012000\x01${date}`)
    if (fields[2] !== 'query_hs300_stocks' || fields[4] !== '1' || fields[7] !== date || fields[8]?.split(',').map(field => field.trim()).join(',') !== 'updateDate,code,code_name') throw new Error('BaoStock 成分日期或字段不匹配')
    const raw: unknown = JSON.parse(fields[6] ?? '')
    if (raw === null || typeof raw !== 'object' || !('record' in raw) || !Array.isArray(raw.record) || raw.record.length !== 300) throw new Error('BaoStock 成分未完整返回300只')
    let updatedOn = ''
    const codes = new Set<string>()
    for (const row of raw.record) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || !isMarketDate(row[0]) || row[0] > date || Date.parse(date) - Date.parse(row[0]) > 7 * 86_400_000
        || (updatedOn !== '' && updatedOn !== row[0]) || typeof row[1] !== 'string' || !/^(sh\.6|sz\.[03])\d{5}$/.test(row[1])) throw new Error('BaoStock 成分记录或周快照日期无效')
      updatedOn = row[0]
      if (codes.has(row[1].slice(3))) throw new Error('BaoStock 成分代码重复')
      codes.add(row[1].slice(3))
    }
    return { updatedOn, codes: [...codes].sort() }
  } finally { socket.destroy() }
}
