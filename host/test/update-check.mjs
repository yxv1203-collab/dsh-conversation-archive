import assert from 'node:assert/strict'
import { checkForUpdate, compareVersions } from '../lib/update-check.js'

const manifest = {
  name: 'dsh-conversation-archive',
  version: '1.0.0-rc.1',
  platform: 'win32',
  dsh: { minVersion: '0.1.1-rc.2', maxTestedVersion: '0.1.1-rc.2' },
  release: { repository: 'owner/repo', apiUrl: 'https://api.github.com/repos/owner/repo/releases/latest', pageUrl: 'https://github.com/owner/repo/releases' },
}

assert.equal(compareVersions('1.0.0', '1.0.0-rc.1') > 0, true)
assert.equal(compareVersions('1.2.0', '1.10.0') < 0, true)
assert.equal(compareVersions('v1.0.0-rc.2', '1.0.0-rc.1') > 0, true)

const disabled = await checkForUpdate({ enabled: false, manifest, platform: 'win32', dshVersion: '0.1.1-rc.2' })
assert.deepEqual(disabled, { state: 'disabled', currentVersion: '1.0.0-rc.1' })

const unconfigured = await checkForUpdate({ enabled: true, manifest: { ...manifest, release: { repository: '', apiUrl: '', pageUrl: '' } }, platform: 'win32', dshVersion: '0.1.1-rc.2' })
assert.equal(unconfigured.state, 'unconfigured')

let called = 0
const available = await checkForUpdate({
  enabled: true, manifest, platform: 'win32', dshVersion: '0.1.1-rc.2',
  fetchImpl: async (url, options) => {
    called += 1
    assert.equal(options.headers.Accept, 'application/vnd.github+json')
    assert.ok(options.signal)
    return { ok: true, status: 200, headers: new Headers(), json: async () => url.includes('api.github.com')
      ? ({ tag_name: 'v1.0.0', html_url: 'https://github.com/owner/repo/releases/tag/v1.0.0', assets: [{ name: 'release-manifest.json', browser_download_url: 'https://github.com/owner/repo/releases/download/v1.0.0/release-manifest.json' }] })
      : ({ ...manifest, version: '1.0.0' }) }
  },
})
assert.equal(called, 2)
assert.deepEqual(available, { state: 'available', currentVersion: '1.0.0-rc.1', latestVersion: '1.0.0', pageUrl: 'https://github.com/owner/repo/releases/tag/v1.0.0' })

const current = await checkForUpdate({ enabled: true, manifest, platform: 'win32', dshVersion: '0.1.1-rc.2', fetchImpl: async (url) => ({ ok: true, status: 200, headers: new Headers(), json: async () => url.includes('api.github.com') ? ({ tag_name: '1.0.0-rc.1', html_url: 'https://github.com/owner/repo/releases/tag/v1.0.0-rc.1', assets: [{ name: 'release-manifest.json', browser_download_url: 'https://github.com/owner/repo/releases/download/v1.0.0-rc.1/release-manifest.json' }] }) : manifest }) })
assert.equal(current.state, 'current')

const rateLimited = await checkForUpdate({ enabled: true, manifest, platform: 'win32', dshVersion: '0.1.1-rc.2', fetchImpl: async () => ({ ok: false, status: 403, headers: new Headers({ 'x-ratelimit-remaining': '0' }) }) })
assert.equal(rateLimited.state, 'rate-limited')

const offline = await checkForUpdate({ enabled: true, manifest, platform: 'win32', dshVersion: '0.1.1-rc.2', fetchImpl: async () => { throw new Error('offline') } })
assert.equal(offline.state, 'offline')

const incompatible = await checkForUpdate({ enabled: true, manifest, platform: 'linux', dshVersion: '0.1.1-rc.2', fetchImpl: async () => { throw new Error('must not fetch') } })
assert.equal(incompatible.state, 'incompatible-platform')

const badPage = await checkForUpdate({ enabled: true, manifest, platform: 'win32', dshVersion: '0.1.1-rc.2', fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ tag_name: '1.0.0', html_url: 'https://example.invalid/phish' }) }) })
assert.equal(badPage.pageUrl, 'https://github.com/owner/repo/releases')

console.log('update check tests passed')
