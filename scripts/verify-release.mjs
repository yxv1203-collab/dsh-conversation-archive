import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release-manifest.json'), 'utf8'))
for (const [relative, hash] of Object.entries(manifest.files)) {
  const file = path.join(root, relative)
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), hash, relative)
}
const zip = path.join(root, 'dist', `dsh-conversation-archive-${manifest.version}-windows.zip`)
const expected = fs.readFileSync(`${zip}.sha256`, 'ascii').trim().split(/\s+/)[0]
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex'), expected)
console.log(`release verified: ${path.basename(zip)} ${expected}`)
