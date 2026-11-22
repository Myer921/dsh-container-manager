/**
 * Docker Hub 镜像搜索。
 *
 * 只在用户主动点「搜」时打一次，5 秒超时；不通就把原因带回去，
 * 让人直接填镜像名 —— 搜不到不该挡住拉取。
 */

const SEARCH_URL = 'https://hub.docker.com/v2/search/repositories/'

export async function searchImages(query, options = {}) {
  const keyword = String(query ?? '').trim()
  if (!keyword) return { ok: true, results: [] }
  const timeoutMs = Number(options.timeoutMs) || 5000
  // 'fetch' in options 才能区分「没传」和「明确传 null（测没有 fetch 的环境）」
  const fetchImpl = 'fetch' in options ? options.fetch : globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return { ok: false, reason: '这个 Node 没有 fetch，搜不了；直接填镜像名。', results: [] }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const url = SEARCH_URL + '?query=' + encodeURIComponent(keyword) + '&page_size=15'
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) {
      return { ok: false, reason: 'Docker Hub 回了 HTTP ' + response.status + '；直接填镜像名。', results: [] }
    }
    const body = await response.json()
    const rows = Array.isArray(body?.results) ? body.results : []
    const results = rows.map(row => ({
      name: String(row.repo_name ?? ''),
      description: String(row.short_description ?? ''),
      stars: Number(row.star_count) || 0,
      pulls: Number(row.pull_count) || 0,
      official: Boolean(row.is_official),
    })).filter(row => row.name)
    return { ok: true, results }
  } catch (error) {
    const reason = error && error.name === 'AbortError'
      ? 'Docker Hub 超时（' + timeoutMs + 'ms）；直接填镜像名。'
      : (error && error.message ? error.message : String(error))
    return { ok: false, reason, results: [] }
  } finally {
    clearTimeout(timer)
  }
}
