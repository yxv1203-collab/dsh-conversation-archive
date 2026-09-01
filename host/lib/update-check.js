import fs from 'node:fs'

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

function versionParts(value) {
  const match = VERSION.exec(String(value || '').trim())
  if (!match) return null
  return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] ? match[4].split('.') : [] }
}

export function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right)
  if (!a || !b) throw new Error('invalid-semantic-version')
  for (let i = 0; i < 3; i += 1) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] < b.numbers[i] ? -1 : 1
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : (a.prerelease.length ? -1 : 1)
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i += 1) {
    if (a.prerelease[i] === undefined) return -1
    if (b.prerelease[i] === undefined) return 1
    if (a.prerelease[i] === b.prerelease[i]) continue
    const an = /^\d+$/.test(a.prerelease[i]), bn = /^\d+$/.test(b.prerelease[i])
    if (an && bn) return Number(a.prerelease[i]) < Number(b.prerelease[i]) ? -1 : 1
    if (an !== bn) return an ? -1 : 1
    return a.prerelease[i] < b.prerelease[i] ? -1 : 1
  }
  return 0
}

export function readReleaseManifest(url) {
  const value = JSON.parse(fs.readFileSync(url, 'utf8'))
  if (value?.name !== 'dsh-conversation-archive' || !versionParts(value.version) || value.platform !== 'win32') throw new Error('invalid-release-manifest')
  return value
}

function safeGithubUrl(value, repository, suffix = '/releases') {
  try {
    const url = new URL(value)
    const prefix = `/${repository}${suffix}`.toLowerCase()
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.toLowerCase().startsWith(prefix) ? url.href : ''
  } catch { return '' }
}

function compatible(target, platform, dshVersion) {
  if (target?.name !== 'dsh-conversation-archive' || target?.platform !== platform || !versionParts(target?.version)) return false
  const range = target.dsh
  if (!versionParts(range?.minVersion) || !versionParts(range?.maxTestedVersion) || !versionParts(dshVersion)) return false
  return compareVersions(dshVersion, range.minVersion) >= 0 && compareVersions(dshVersion, range.maxTestedVersion) <= 0
}

export async function checkForUpdate({ enabled, manifest, fetchImpl = globalThis.fetch, platform = process.platform, dshVersion = '', timeoutMs = 4000 }) {
  const currentVersion = manifest?.version || ''
  if (!enabled) return { state: 'disabled', currentVersion }
  if (platform !== manifest?.platform || !compatible(manifest, platform, dshVersion)) return { state: platform !== manifest?.platform ? 'incompatible-platform' : 'incompatible-dsh', currentVersion }
  const repository = String(manifest.release?.repository || '')
  const apiUrl = String(manifest.release?.apiUrl || '')
  const fallbackPage = safeGithubUrl(manifest.release?.pageUrl, repository)
  if (!repository || !/^[-\w.]+\/[-\w.]+$/.test(repository) || !apiUrl || !fallbackPage) return { state: 'unconfigured', currentVersion }
  let api
  try { api = new URL(apiUrl) } catch { return { state: 'unconfigured', currentVersion } }
  if (api.protocol !== 'https:' || api.hostname !== 'api.github.com' || api.pathname !== `/repos/${repository}/releases/latest`) return { state: 'unconfigured', currentVersion }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const request = (url) => fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-conversation-archive-update-check' } })
  try {
    const response = await request(api.href)
    if (!response?.ok) return { state: response?.status === 403 && response.headers?.get?.('x-ratelimit-remaining') === '0' ? 'rate-limited' : 'http-error', currentVersion }
    const release = await response.json()
    const latestVersion = String(release?.tag_name || release?.name || '').replace(/^v/, '')
    if (!versionParts(latestVersion)) return { state: 'invalid-response', currentVersion }
    const pageUrl = safeGithubUrl(release?.html_url, repository) || fallbackPage
    const asset = Array.isArray(release?.assets) && release.assets.find((item) => item?.name === 'release-manifest.json' && safeGithubUrl(item?.browser_download_url, repository, '/releases/download/'))
    if (!asset) return { state: 'compatibility-unknown', currentVersion, latestVersion, pageUrl }
    const manifestResponse = await request(asset.browser_download_url)
    if (!manifestResponse?.ok) return { state: 'compatibility-unknown', currentVersion, latestVersion, pageUrl }
    const target = await manifestResponse.json()
    if (target.version !== latestVersion || !compatible(target, platform, dshVersion)) return { state: 'incompatible-release', currentVersion, latestVersion, pageUrl }
    return { state: compareVersions(latestVersion, currentVersion) > 0 ? 'available' : 'current', currentVersion, latestVersion, pageUrl }
  } catch (error) {
    return { state: error?.name === 'AbortError' ? 'timeout' : 'offline', currentVersion }
  } finally { clearTimeout(timer) }
}
