import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const manifestPath = path.join(root, 'release-manifest.json')
assert.ok(fs.existsSync(manifestPath), 'release-manifest.json exists')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
assert.equal(manifest.name, 'dsh-conversation-archive')
assert.equal(manifest.version, '1.2.0')
assert.equal(manifest.platform, 'win32')
assert.equal(manifest.dsh.minVersion, '0.1.1-rc.2')
assert.equal(manifest.dsh.maxTestedVersion, '0.1.1-rc.2')
assert.equal(manifest.release.repository, 'yxv1203-collab/dsh-conversation-archive')
assert.equal(manifest.release.apiUrl, 'https://api.github.com/repos/yxv1203-collab/dsh-conversation-archive/releases/latest')
assert.equal(manifest.release.pageUrl, 'https://github.com/yxv1203-collab/dsh-conversation-archive/releases')
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const hostPackage = JSON.parse(fs.readFileSync(path.join(root, 'host', 'package.json'), 'utf8'))
const clientPackage = JSON.parse(fs.readFileSync(path.join(root, 'client', 'package.json'), 'utf8'))
const clientBundle = fs.readFileSync(path.join(root, 'client', 'lib', 'client.js'), 'utf8')
const registration = clientBundle.match(/__ModuleLoader__\.load\(\{\s*[\s\S]*?\bid:\s*['"]([^'"]+)['"]/)
assert.equal(hostPackage.version, manifest.version)
assert.equal(clientPackage.version, manifest.version)
assert.equal(rootPackage.version, manifest.version)
assert.equal(rootPackage.name, manifest.name)
assert.equal(rootPackage.dsh?.bundle?.patch, './cordis.patch.yml', 'declares a native DSH bundle layer')
assert.equal(rootPackage.dsh?.client?.platform, 'web', 'declares the DSH web client half')
assert.equal(rootPackage.exports?.['./client'], './client/lib/client.js')
assert.equal(rootPackage.exports?.['./cordis.patch.yml'], './cordis.patch.yml')
assert.equal(rootPackage.os?.[0], 'win32')
assert.equal(fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8').trim(), '- insert:\n    - id: dsh-conversation-archive\n      name: dsh-conversation-archive')
assert.equal(hostPackage.name, manifest.name, 'installed wrapper package name matches release manifest')
assert.equal(clientPackage.name, manifest.name, 'client package name matches installed wrapper package name')
assert.ok(registration, 'client bundle registers a ModuleLoader id')
assert.equal(registration[1], manifest.name, 'client ModuleLoader id matches installed wrapper package name')
for (const required of ['LICENSE', 'package.json', 'cordis.patch.yml', 'host/lib/index.js', 'host/lib/core.js', 'host/lib/dsh-adapter.js', 'host/lib/update-check.js', 'client/lib/client.js', 'README.md', 'README.zh-CN.md']) {
  assert.ok(manifest.files[required], `manifest hashes ${required}`)
}
for (const obsolete of ['scripts/install.ps1', 'scripts/uninstall.ps1', 'scripts/build-release.ps1', 'scripts/test-installer.ps1']) assert.equal(fs.existsSync(path.join(root, obsolete)), false, `${obsolete} removed in favor of dsh plugin`)
for (const [relative, expected] of Object.entries(manifest.files)) {
  const file = path.join(root, relative)
  assert.ok(fs.statSync(file).isFile(), `${relative} exists`)
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), expected, `${relative} hash`)
}
for (const relative of [...Object.keys(manifest.files), 'release-manifest.json']) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8')
  assert.doesNotMatch(source, /[A-Za-z]:\\Users\\[^\\\r\n]+|file:\/\/[A-Za-z]:\/Users\/[^/\r\n]+|AppData\\Roaming\\npm/i, `${relative} is portable`)
}
assert.equal(fs.existsSync(path.join(root, '.codex-plugin')), false, 'must not contain Codex metadata')
console.log('release contract tests passed')
