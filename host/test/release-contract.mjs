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
assert.equal(manifest.version, '1.1.0')
assert.equal(manifest.platform, 'win32')
assert.equal(manifest.dsh.minVersion, '0.1.1-rc.2')
assert.equal(manifest.dsh.maxTestedVersion, '0.1.1-rc.2')
assert.equal(manifest.release.repository, 'yxv1203-collab/dsh-conversation-archive')
assert.equal(manifest.release.apiUrl, 'https://api.github.com/repos/yxv1203-collab/dsh-conversation-archive/releases/latest')
assert.equal(manifest.release.pageUrl, 'https://github.com/yxv1203-collab/dsh-conversation-archive/releases')
const hostPackage = JSON.parse(fs.readFileSync(path.join(root, 'host', 'package.json'), 'utf8'))
const clientPackage = JSON.parse(fs.readFileSync(path.join(root, 'client', 'package.json'), 'utf8'))
const clientBundle = fs.readFileSync(path.join(root, 'client', 'lib', 'client.js'), 'utf8')
const registration = clientBundle.match(/__ModuleLoader__\.load\(\{\s*[\s\S]*?\bid:\s*['"]([^'"]+)['"]/)
assert.equal(hostPackage.version, manifest.version)
assert.equal(clientPackage.version, manifest.version)
assert.equal(hostPackage.name, manifest.name, 'installed wrapper package name matches release manifest')
assert.equal(clientPackage.name, manifest.name, 'client package name matches installed wrapper package name')
assert.ok(registration, 'client bundle registers a ModuleLoader id')
assert.equal(registration[1], manifest.name, 'client ModuleLoader id matches installed wrapper package name')
for (const required of ['LICENSE', 'host/lib/index.js', 'host/lib/core.js', 'host/lib/dsh-adapter.js', 'host/lib/update-check.js', 'client/lib/client.js', 'scripts/install.ps1', 'scripts/uninstall.ps1', 'README.md', 'docs/ACCEPTANCE.md']) {
  assert.ok(manifest.files[required], `manifest hashes ${required}`)
}
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
