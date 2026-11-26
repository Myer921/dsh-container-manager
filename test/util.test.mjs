import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CmError,
  ERR,
  asCmError,
  assertCidr,
  assertContainerName,
  assertImage,
  assertInterfaceName,
  assertIpv4,
  assertNetworkName,
  clampInt,
  digest,
  newToken,
  parseJson,
  pick,
  safeJson,
} from '../lib/util.js'

test('容器名：合法与非法', () => {
  assert.equal(assertContainerName('catstar-next'), 'catstar-next')
  assert.equal(assertContainerName('a_b.c-d'), 'a_b.c-d')
  assert.throws(() => assertContainerName(''), /不能为空/)
  assert.throws(() => assertContainerName('-bad'), /不合法/)
  assert.throws(() => assertContainerName('a b'), /不合法/)
  assert.throws(() => assertContainerName('x'.repeat(64)), /太长/)
})

test('网络名与镜像引用', () => {
  assert.equal(assertNetworkName('cm-net'), 'cm-net')
  assert.equal(assertImage('docker.io/library/alpine:3.20'), 'docker.io/library/alpine:3.20')
  assert.throws(() => assertImage('bad image'), /不合法/)
})

test('CIDR 校验', () => {
  assert.equal(assertCidr('10.0.3.0/24'), '10.0.3.0/24')
  assert.equal(assertCidr('fd00::/64'), 'fd00::/64')
  assert.throws(() => assertCidr('10.0.3.0'), /必须是/)
  assert.throws(() => assertCidr('10.0.3.0/33'), /前缀/)
  assert.throws(() => assertCidr('nope/24'), /地址部分/)
})

test('IPv4 与接口名', () => {
  assert.equal(assertIpv4('127.0.0.1'), '127.0.0.1')
  assert.throws(() => assertIpv4('::1'), /不是合法 IPv4/)
  assert.equal(assertInterfaceName('lxcbr0'), 'lxcbr0')
  assert.throws(() => assertInterfaceName('bad name'), /不合法/)
})

test('clampInt / pick / safeJson', () => {
  assert.equal(clampInt('50', 1, 100, 10), 50)
  assert.equal(clampInt('500', 1, 100, 10), 100)
  assert.equal(clampInt('nope', 1, 100, 10), 10)
  assert.deepEqual(pick({ a: 1, b: 2, c: 3 }, ['a', 'c', 'd']), { a: 1, c: 3 })
  assert.deepEqual(safeJson('{"a":1}', {}), { a: 1 })
  assert.deepEqual(safeJson('not json', { fallback: true }), { fallback: true })
})

test('parseJson 与错误归一', () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 })
  assert.equal(parseJson(''), null)
  assert.throws(() => parseJson('nope'), /不是合法 JSON/)
  assert.equal(asCmError(new Error('boom')).code, ERR.INTERNAL)
  assert.equal(asCmError(new CmError(ERR.BAD_ARGS, 'x')).code, ERR.BAD_ARGS)
})

test('token 与摘要稳定', () => {
  const a = newToken('cm')
  const b = newToken('cm')
  assert.match(a, /^cm-[0-9a-f]{32}$/)
  assert.notEqual(a, b)
  assert.equal(digest({ a: 1 }), digest({ a: 1 }))
  assert.notEqual(digest({ a: 1 }), digest({ a: 2 }))
})
