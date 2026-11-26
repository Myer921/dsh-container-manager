import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

test('client.js 与 src/ 模板、样式、文案一致', () => {
  const result = spawnSync(process.execPath, ['scripts/build-client.mjs', '--check'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /一致/)
})

test('details 箭头在源 CSS 与运行时 CSS 中都使用单反斜杠', () => {
  const source = readFileSync(join(root, 'src/client.css'), 'utf8')
  assert.ok(source.includes('content:"\\25B8 "'), '源 CSS 的折叠箭头转义不对')
  assert.ok(source.includes('content:"\\25BE "'), '源 CSS 的展开箭头转义不对')
  assert.ok(!source.includes('content:"\\\\25B8 "'), '源 CSS 多转义了一层')
  assert.ok(!source.includes('content:"\\\\25BE "'), '源 CSS 多转义了一层')

  const client = readFileSync(join(root, 'client.js'), 'utf8')
  const match = client.match(/const CSS = ("(?:\\.|[^"\\])*");/)
  assert.ok(match, '找不到构建后的 CSS 字符串')
  const runtimeCss = JSON.parse(match[1])
  assert.ok(runtimeCss.includes('content:"\\25B8 "'), '运行时 CSS 的折叠箭头转义不对')
  assert.ok(runtimeCss.includes('content:"\\25BE "'), '运行时 CSS 的展开箭头转义不对')
  assert.ok(!runtimeCss.includes('content:"\\\\25B8 "'), '运行时 CSS 多转义了一层')
  assert.ok(!runtimeCss.includes('content:"\\\\25BE "'), '运行时 CSS 多转义了一层')
})
