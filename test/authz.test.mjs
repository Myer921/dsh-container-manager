import test from 'node:test'
import assert from 'node:assert/strict'

import { decideAuthz, normalizeRole, describeRole, roleMatrix, TOOL_ACCESS, AI_ROLES, DEFAULT_ROLE } from '../lib/authz.js'

test('readonly 只能读', () => {
  assert.equal(decideAuthz({ role: 'readonly', access: 'read', tool: 'container_list' }).allow, true)
  assert.equal(decideAuthz({ role: 'readonly', access: 'write', tool: 'container_create' }).allow, false)
  assert.equal(decideAuthz({ role: 'readonly', access: 'danger', tool: 'container_action' }).allow, false)
})

test('operator 能写不能发起危险操作（默认角色就是它）', () => {
  assert.equal(DEFAULT_ROLE, 'operator')
  assert.equal(decideAuthz({ role: 'operator', access: 'write', tool: 'container_create' }).allow, true)
  const verdict = decideAuthz({ role: 'operator', access: 'danger', tool: 'container_action' })
  assert.equal(verdict.allow, false)
  assert.match(verdict.reason, /admin/)
  assert.match(verdict.reason, /危险操作仍要人确认/)
})

test('admin 能发起危险操作 —— 但原因里必须写清楚照样要人确认', () => {
  const verdict = decideAuthz({ role: 'admin', access: 'danger', tool: 'container_action' })
  assert.equal(verdict.allow, true)
  assert.equal(verdict.reason, null)
  assert.match(describeRole('admin'), /照样要你/)
})

test('deny 名单单独点掉工具，admin 也挡', () => {
  const verdict = decideAuthz({ role: 'admin', access: 'read', tool: 'container_logs', deny: ['container_logs'] })
  assert.equal(verdict.allow, false)
  assert.match(verdict.reason, /deny/)
})

test('角色名不认识就回落到默认角色，不炸', () => {
  assert.equal(normalizeRole('root'), 'operator')
  assert.equal(normalizeRole(''), 'operator')
  assert.equal(normalizeRole(undefined), 'operator')
  assert.equal(normalizeRole('ADMIN'), 'admin')
})

test('性质不明的工具按最严的算（danger），不能因为写错一个字就放行', () => {
  assert.equal(decideAuthz({ role: 'operator', access: 'whatever', tool: 'x' }).access, 'danger')
  assert.equal(decideAuthz({ role: 'operator', access: undefined, tool: 'x' }).allow, false)
})

test('能力矩阵和 ACCESS 表自洽：三个角色、read 永远开', () => {
  const matrix = roleMatrix()
  assert.equal(matrix.length, AI_ROLES.length)
  for (const row of matrix) assert.equal(row.read, true)
  assert.equal(matrix.find(row => row.role === 'readonly').write, false)
  assert.equal(matrix.find(row => row.role === 'admin').danger, true)
  for (const [tool, access] of Object.entries(TOOL_ACCESS)) {
    assert.ok(['read', 'write', 'danger'].includes(access), tool + ' 的性质写错了：' + access)
  }
})
