/**
 * 极简 tar（ustar）读写
 *
 * 为什么自己写：这个插件零依赖，而 podman cp 读写容器内文件走的正是 tar 流 ——
 * 读一个文件 = `podman cp <ref>:<path> -` 拿到一段 tar，写一个文件 = 把 tar 喂给
 * `podman cp - <ref>:<path>`。用 tar 而不是 shell 引号，是因为文件名里可能有空格、
 * 引号、中文；走流就不会被 shell 解释。
 *
 * 只支持「单个普通文件 / 目录项」这一种形状：长文件名扩展、稀疏文件、硬链接一律明确报错，
 * 不装作支持。够用就好，别把它写成通用 tar 库。
 */

const BLOCK = 512

function readOctal(buffer, offset, length) {
  const text = buffer.subarray(offset, offset + length).toString('ascii').replace(/\0/g, '').trim()
  if (!text) return 0
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}

function writeOctal(buffer, offset, length, value) {
  const text = Number(value).toString(8).padStart(length - 1, '0')
  buffer.write(text + '\0', offset, length, 'ascii')
}

function headerChecksum(header) {
  let sum = 0
  for (let index = 0; index < BLOCK; index += 1) {
    // 校验和字段本身按空格算
    sum += (index >= 148 && index < 156) ? 0x20 : header[index]
  }
  return sum
}

/** 把一段内容打成只有一个条目的 tar 流。 */
export function packFile(name, content) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8')
  const entryName = String(name ?? '')
  if (!entryName) throw new Error('tar 条目名不能为空。')
  if (Buffer.byteLength(entryName) > 100) {
    throw new Error('文件名超过 100 字节，ustar 头放不下：' + entryName)
  }
  const header = Buffer.alloc(BLOCK)
  header.write(entryName, 0, 100, 'utf8')
  writeOctal(header, 100, 8, 0o644)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, data.length)
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000))
  header.write('        ', 148, 8, 'ascii') // 校验和先留空格
  header.write('0', 156, 1, 'ascii')
  header.write('ustar', 257, 5, 'ascii')
  header.write('00', 263, 2, 'ascii')
  const sum = headerChecksum(header)
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')

  const padding = Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)
  const trailer = Buffer.alloc(BLOCK * 2)
  return Buffer.concat([header, data, padding, trailer])
}

/**
 * 从一段 tar 流里取条目。遇到不支持的形状直接抛，别给一个「看起来能打开」的空文件。
 * @returns {Array<{name:string, size:number, type:string, data:Buffer|null}>}
 */
export function unpackEntries(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '')
  const entries = []
  let offset = 0
  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK)
    // 全零块 = 归档结束
    let empty = true
    for (let index = 0; index < BLOCK; index += 1) {
      if (header[index] !== 0) {
        empty = false
        break
      }
    }
    if (empty) break
    const magic = header.subarray(257, 263).toString('ascii')
    if (!magic.startsWith('ustar')) {
      throw new Error('这不是 ustar 归档（magic=' + JSON.stringify(magic) + '），可能是别的压缩格式。')
    }
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const fullName = prefix ? prefix + '/' + name : name
    const size = readOctal(header, 124, 12)
    const typeflag = String.fromCharCode(header[156] || 0x30)
    const type = typeflag === '5' ? 'dir' : typeflag === '2' ? 'symlink' : typeflag === '1' ? 'hardlink' : 'file'
    if (type === 'hardlink') throw new Error('不支持硬链接条目：' + fullName)
    const dataStart = offset + BLOCK
    const dataEnd = dataStart + size
    if (dataEnd > buf.length) throw new Error('归档被截断了：' + fullName)
    entries.push({
      name: fullName,
      size,
      type,
      data: type === 'file' ? buf.subarray(dataStart, dataEnd) : null,
    })
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
  }
  if (entries.length === 0) throw new Error('归档里没有条目。')
  return entries
}

/**
 * 只取一个普通文件。
 *
 * 条目数必须正好是 1：podman cp 一个**目录**时打的是整棵树，条目会有很多；
 * 如果只挑第一个文件返回，调用方会拿到一个「随便哪个文件」的内容还不自知
 * —— 这是那种能悄悄毁掉别人配置的错，所以宁可硬报错。
 */
export function unpackSingleFile(buffer) {
  const entries = unpackEntries(buffer)
  if (entries.length !== 1) {
    const kinds = entries.slice(0, 5).map(entry => entry.type + ':' + entry.name).join(', ')
    throw new Error('归档里有 ' + entries.length + ' 个条目（' + kinds + '），不是单个文件 —— 这个路径大概是目录。')
  }
  const file = entries[0]
  if (file.type !== 'file') {
    throw new Error('这个路径不是普通文件（' + file.type + ':' + file.name + '）。')
  }
  return { name: file.name, size: file.size, data: file.data }
}
