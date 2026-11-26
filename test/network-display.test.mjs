import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(new URL('../src/client.template.js', import.meta.url), 'utf8')

test('容器网络卡片兼容 ps 的字符串数组', () => {
  assert.match(source, /typeof network === 'string' \? \{ name: network \} : network/)
  assert.match(source, /networkRows\.length > 0/)
  assert.match(source, /networkRows\.flatMap/)
  assert.doesNotMatch(source, /container\.networks\.flatMap/)
})
