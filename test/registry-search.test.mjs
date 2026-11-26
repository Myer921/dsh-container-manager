import test from 'node:test'
import assert from 'node:assert/strict'

import { searchImages } from '../lib/registry-search.js'

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() { return body },
  }
}

test('空关键词不发请求', async () => {
  let called = false
  const result = await searchImages('  ', {
    fetch: async () => { called = true; return jsonResponse({ results: [] }) },
  })
  assert.equal(called, false)
  assert.deepEqual(result, { ok: true, results: [] })
})

test('把 Docker Hub 的结果摊平成 name / stars / pulls', async () => {
  const result = await searchImages('nginx', {
    fetch: async (url) => {
      assert.match(url, /query=nginx/)
      return jsonResponse({
        results: [
          { repo_name: 'library/nginx', short_description: 'web server', star_count: 10, pull_count: 1000, is_official: true },
          { repo_name: 'someone/nginx-custom', short_description: '', star_count: 2, pull_count: 30, is_official: false },
          { short_description: '没名字的行要被丢掉' },
        ],
      })
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.results.length, 2)
  assert.equal(result.results[0].name, 'library/nginx')
  assert.equal(result.results[0].official, true)
  assert.equal(result.results[0].pulls, 1000)
})

test('HTTP 不通时把原因带回来，不当成功', async () => {
  const result = await searchImages('nginx', {
    fetch: async () => jsonResponse({}, false, 503),
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /503/)
  assert.deepEqual(result.results, [])
})

test('超时归成一条能读的 reason', async () => {
  const result = await searchImages('nginx', {
    timeoutMs: 20,
    fetch: async (url, options) => {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /超时/)
})

test('没有 fetch 时直接说搜不了', async () => {
  const result = await searchImages('nginx', { fetch: null })
  assert.equal(result.ok, false)
  assert.match(result.reason, /没有 fetch/)
})
