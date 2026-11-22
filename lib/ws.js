/**
 * 手写的最小 WebSocket 服务端（RFC 6455）。
 *
 * 为什么不用 ws 包：插件要保持零运行时依赖 —— 宿主不一定能解析到 ws。
 * 这里只做服务端需要的那部分：握手、掩码帧解析、文本帧发送、ping/pong、close。
 * 不支持扩展协商（permessage-deflate）；发送不分片，接收允许分片拼接。
 */

import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function acceptKey(key) {
  return createHash('sha1').update(String(key) + GUID).digest('base64')
}

/** 完成 101 握手；缺 key 时返回 false，调用方自己回 400。 */
export function handshake(req, socket) {
  const key = req.headers['sec-websocket-key']
  if (!key) return false
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Accept: ' + acceptKey(key),
    '',
    '',
  ].join('\r\n'))
  return true
}

export function encodeFrame(text) {
  const payload = Buffer.from(String(text), 'utf8')
  const length = payload.length
  if (length < 126) {
    return Buffer.concat([Buffer.from([0x81, length]), payload])
  }
  if (length < 65536) {
    const header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(length, 2)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(10)
  header[0] = 0x81
  header[1] = 127
  header.writeBigUInt64BE(BigInt(length), 2)
  return Buffer.concat([header, payload])
}

function controlFrame(socket, opcode, payload) {
  try {
    socket.write(Buffer.concat([Buffer.from([0x80 | opcode, payload.length & 0x7f]), payload]))
  } catch {
    // 对端已经断了
  }
}

/**
 * 把 socket 变成一个「发文本、收文本」的通道。
 * onMessage(text) 只在完整消息到齐时调用（分片会被拼起来）。
 */
export function createConnection(socket, { onMessage, onClose, maxMessage = 4 * 1024 * 1024 } = {}) {
  let buffer = Buffer.alloc(0)
  const fragments = []
  let fragmentBytes = 0
  let closed = false

  function send(text) {
    if (closed) return false
    try {
      socket.write(encodeFrame(text))
      return true
    } catch {
      closed = true
      return false
    }
  }

  function finish() {
    if (closed) return
    closed = true
    controlFrame(socket, 0x8, Buffer.alloc(0))
    try { socket.end() } catch { /* 已经关了 */ }
    if (typeof onClose === 'function') onClose()
  }

  function consume() {
    while (buffer.length >= 2) {
      const first = buffer[0]
      const second = buffer[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < offset + 2) return
        length = buffer.readUInt16BE(offset)
        offset += 2
      } else if (length === 127) {
        if (buffer.length < offset + 8) return
        const big = buffer.readBigUInt64BE(offset)
        if (big > BigInt(maxMessage)) { finish(); return }
        length = Number(big)
        offset += 8
      }
      if (length > maxMessage) { finish(); return }
      const maskOffset = masked ? 4 : 0
      if (buffer.length < offset + maskOffset + length) return
      let payload = buffer.subarray(offset + maskOffset, offset + maskOffset + length)
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4)
        const copy = Buffer.from(payload)
        for (let index = 0; index < copy.length; index += 1) copy[index] ^= mask[index % 4]
        payload = copy
      }
      buffer = buffer.subarray(offset + maskOffset + length)

      if (opcode === 0x8) { finish(); return }
      if (opcode === 0x9) { controlFrame(socket, 0xa, payload); continue }
      if (opcode === 0xa) continue
      if (opcode === 0x1 || opcode === 0x2) {
        fragments.length = 0
        fragmentBytes = 0
        fragments.push(payload)
        fragmentBytes += payload.length
      } else if (opcode === 0x0) {
        if (fragments.length === 0) continue
        fragments.push(payload)
        fragmentBytes += payload.length
      } else {
        continue
      }
      if (fragmentBytes > maxMessage) { finish(); return }
      if (!fin) continue
      const whole = Buffer.concat(fragments)
      fragments.length = 0
      fragmentBytes = 0
      if (typeof onMessage === 'function') {
        try { onMessage(whole.toString('utf8')) } catch { /* 上层自己记日志 */ }
      }
    }
  }

  socket.on('data', (chunk) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
    consume()
  })
  socket.on('close', () => {
    if (closed) return
    closed = true
    if (typeof onClose === 'function') onClose()
  })
  socket.on('error', () => {
    if (closed) return
    closed = true
    if (typeof onClose === 'function') onClose()
  })

  return { send, close: finish, get closed() { return closed } }
}
