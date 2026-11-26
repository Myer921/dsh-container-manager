import test from 'node:test'
import assert from 'node:assert/strict'

import { originAllowed } from '../lib/terminal.js'

/**
 * 回归：面板挂在 nginx 反代后面时，终端 WebSocket 一律 403。
 * 根因是 originAllowed 只认 127.0.0.1/localhost —— 浏览器发来的 Host 是外部地址
 * （192.0.2.10:3086），硬编码白名单直接否掉，而 nginx 转发其实是好的。
 */

const make = (headers) => ({ headers })

test('本机直连、没有 Origin：放行', () => {
  assert.equal(originAllowed(make({ host: '127.0.0.1:3085' })), true)
})

test('本机直连、同源 Origin：放行', () => {
  assert.equal(originAllowed(make({ host: '127.0.0.1:3085', origin: 'http://127.0.0.1:3085' })), true)
})

test('本机直连、跨站 Origin：拒绝', () => {
  assert.equal(originAllowed(make({ host: '127.0.0.1:3085', origin: 'http://evil.example' })), false)
})

test('反代外部 Host + 同源 Origin：放行（之前 403 的正是这个）', () => {
  assert.equal(originAllowed(make({
    host: '192.0.2.10:3086',
    origin: 'http://192.0.2.10:3086',
  })), true)
})

test('反代内外端口不同也算同源', () => {
  assert.equal(originAllowed(make({
    host: '192.0.2.10:3086',
    origin: 'http://192.0.2.10:8080',
  })), true)
})

test('反代外部 Host、没有 Origin：拒绝', () => {
  assert.equal(originAllowed(make({ host: '192.0.2.10:3086' })), false)
})

test('反代外部 Host + 别的站 Origin：拒绝', () => {
  assert.equal(originAllowed(make({
    host: '192.0.2.10:3086',
    origin: 'http://evil.example',
  })), false)
})

test('Origin 解析不了：拒绝', () => {
  assert.equal(originAllowed(make({ host: '192.0.2.10:3086', origin: '不是网址' })), false)
})

test('缺 headers 也不炸', () => {
  assert.equal(originAllowed({}), false)
})
