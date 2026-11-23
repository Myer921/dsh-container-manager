/**
 * Quadlet 纳管：把 systemd 管的那批容器文件读出来。
 *
 * 为什么要这块：rootless Podman 的正经做法是 Quadlet —— 你写一个 `foo.container`，
 * systemd 生成 `foo.service`，开机自启、崩溃重启、日志进 journal，全都不用你操心。
 * 面板只读地看这些文件、看它们对应的 unit 活没活，再给你「重新生成 / 启停」两条手。
 *
 * 这里是纯函数：读写文件、跑 systemctl 都在驱动那边。这样解析规则可以单独测。
 */

/** Quadlet 认的六种扩展名 → 生成什么 unit。 */
const EXTENSIONS = new Map([
  ['.container', 'service'],
  ['.pod', 'service'],
  ['.kube', 'service'],
  ['.image', 'service'],
  ['.volume', 'volume'],
  ['.network', 'network'],
])

export const QUADLET_DIRS = [
  // 系统级（rootful）与用户级（rootless）两处，rootless 才是日常用到的那个
  '/etc/containers/systemd',
  '/usr/share/containers/systemd',
  '/etc/containers/systemd/users',
  '$XDG_CONFIG_HOME/containers/systemd',
]

/**
 * 解析一份 quadlet 文件。
 * @returns {{ groups: Array<{name: string, entries: Array<[string, string]>}>, problems: string[] }}
 */
export function parseQuadlet(text) {
  const groups = []
  const problems = []
  let current = null
  const lines = String(text ?? '').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index]
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    // 行尾反斜杠是续行
    while (line.trimEnd().endsWith('\\') && index + 1 < lines.length) {
      line = line.trimEnd().slice(0, -1) + lines[index + 1].trim()
      index += 1
    }
    const section = /^\[([^\]]+)\]$/.exec(line.trim())
    if (section) {
      current = { name: section[1], entries: [] }
      groups.push(current)
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0) {
      problems.push('第 ' + (index + 1) + ' 行不是 key=value：' + line.trim().slice(0, 60))
      continue
    }
    if (!current) {
      problems.push('第 ' + (index + 1) + ' 行出现在任何 [段] 之前。')
      continue
    }
    current.entries.push([line.slice(0, eq).trim(), line.slice(eq + 1).trim()])
  }
  return { groups, problems }
}

/** 取某个段里的第一个值（大小写不敏感，quadlet 的键其实区分大小写，这里宽容一点）。 */
export function pickEntry(groups, section, key) {
  for (const group of groups) {
    if (group.name.toLowerCase() !== section.toLowerCase()) continue
    for (const [name, value] of group.entries) {
      if (name.toLowerCase() === key.toLowerCase()) return value
    }
  }
  return null
}

/** 文件名 → 它会生成的 unit 名；不是 quadlet 就返回 null。 */
export function quadletUnit(fileName) {
  const name = String(fileName ?? '')
  for (const [extension, kind] of EXTENSIONS) {
    if (!name.endsWith(extension)) continue
    const base = name.slice(0, -extension.length)
    if (!base) return null
    return kind === 'service' ? base + '.service' : base + '.' + kind
  }
  return null
}

/** 是不是 quadlet 文件（含以点开头的临时文件要排掉）。 */
export function isQuadletFile(fileName) {
  const name = String(fileName ?? '')
  if (!name || name.startsWith('.')) return false
  return [...EXTENSIONS.keys()].some(extension => name.endsWith(extension))
}

/**
 * 把「读到的目录内容」整理成一份清单。文件内容由调用方给（便于测试）。
 * @param {{ dir: string, files: Array<{name: string, text: string}> }[]} sources
 */
export function buildQuadletList(sources) {
  const items = []
  const problems = []
  for (const source of sources || []) {
    for (const file of source.files || []) {
      const unit = quadletUnit(file.name)
      if (!unit) continue
      const parsed = parseQuadlet(file.text)
      const image = pickEntry(parsed.groups, 'Container', 'Image')
      const description = pickEntry(parsed.groups, 'Unit', 'Description')
      const wants = pickEntry(parsed.groups, 'Install', 'WantedBy')
      const podName = pickEntry(parsed.groups, 'Container', 'Pod')
      const publish = (parsed.groups.find(group => group.name === 'Container')?.entries ?? [])
        .filter(([name]) => name === 'PublishPort').map(([, value]) => value)
      items.push({
        dir: source.dir,
        file: file.name,
        path: source.dir + '/' + file.name,
        unit,
        kind: file.name.slice(file.name.lastIndexOf('.') + 1),
        description: description || '',
        image: image || null,
        pod: podName || null,
        publish,
        wantedBy: wants || null,
        groups: parsed.groups.map(group => group.name),
      })
      for (const problem of parsed.problems) problems.push(file.name + '：' + problem)
    }
  }
  items.sort((left, right) => left.file.localeCompare(right.file))
  return { items, problems }
}

/**
 * 解析 `systemctl show -p Id,LoadState,ActiveState,SubState a.service b.service` 的输出。
 * systemd 用空行分隔每个 unit。
 */
export function parseSystemctlShow(text) {
  const out = new Map()
  let current = null
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) {
      current = null
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if (key === 'Id') {
      current = { id: value, loadState: '', activeState: '', subState: '' }
      out.set(value, current)
      continue
    }
    if (!current) continue
    if (key === 'LoadState') current.loadState = value
    else if (key === 'ActiveState') current.activeState = value
    else if (key === 'SubState') current.subState = value
  }
  return out
}
