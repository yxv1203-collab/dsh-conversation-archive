import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import plugin from '../lib/index.js'
import { DEFAULTS } from '../lib/core.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-backfill-'))
const harnessRoot = path.join(tmp, 'relocated', 'DeepSeek Harness')
const daily = path.join(harnessRoot, 'daily_conversation')
const sessionId = 'persisted-before-plugin'
const header = { id: sessionId, cwd: daily, createdAt: new Date(2026, 8, 3).getTime() }
const persistedHeaders = [header]
fs.mkdirSync(daily, { recursive: true })
const externalWorkspace = path.join(tmp, 'Other Worktrees', 'Independent Project')
fs.mkdirSync(externalWorkspace, { recursive: true })
const externalId = 'external-project-before-plugin'
persistedHeaders.push({ ...header, id: externalId, cwd: externalWorkspace })
// Older settings saves persisted the default root even when the user never set it.
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ schemaVersion: 1, harnessRoot: DEFAULTS.harnessRoot }))

const sessions = { list: () => [], get: () => undefined }
const workspaceRegistry = {
  archivedSessionIds: [sessionId, externalId],
  // DSH may publish persisted headers before its workspace registry is ready.
  list: () => [],
  enqueueOperation: async (operation) => operation(),
  requireState: () => ({ archivedSessionIds: [sessionId] }),
  setState: async () => {},
}
const services = new Map([
  ['sessions', sessions],
  ['workspaceRegistry', workspaceRegistry],
  ['sessionPersistence', { root: path.join(tmp, 'sessions'), compression: 'zstd', listSnapshots: async () => persistedHeaders.map((item) => ({ header: item })) }],
  ['webServer', { register: () => () => {} }],
  ['conversationArchiveFetch', async () => ({ ok: false, status: 404, json: async () => ({}) })],
  ['conversationArchiveRecycle', async () => ({ ok: true })],
  ['conversationArchiveDshRecycle', async () => ({ ok: true })],
])
const listeners = new Map()
const disposers = []
const ctx = {
  sessions,
  logger: { info: () => {}, warn: () => {} },
  get: (name) => services.get(name),
  provide: (name, value) => services.set(name, value),
  on: (name, listener) => listeners.set(name, listener),
  effect: (setup) => { const dispose = setup(); if (dispose) disposers.push(dispose) },
}

plugin.apply(ctx, {
  statePath: path.join(tmp, 'state.json'),
  configPath: path.join(tmp, 'config.json'),
  backup: { enabled: false, mode: 'off' },
  updateCheck: { enabled: false },
})

const service = services.get('conversationArchive')
const deadline = Date.now() + 2_000
let archived
while (Date.now() < deadline) {
  archived = service.status().archived.find((item) => item.id === sessionId)
  if (archived && !archived.mappingError) break
  await new Promise((resolve) => setTimeout(resolve, 20))
}
assert.equal(service.status().writesDisabled, false, JSON.stringify(service.status()))
assert.equal(service.getConfig().harnessRoot, harnessRoot)
assert.ok(archived)
assert.equal(archived.mappingError, undefined)
service.flush()
const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'), 'utf8'))
assert.equal(saved[sessionId].cwd, daily)
assert.equal(saved[sessionId].layoutVersion, 3)
assert.equal(saved[externalId]?.cwd, externalWorkspace)
assert.equal(saved[externalId]?.root, externalWorkspace)
assert.equal(service.status().archived.find((item) => item.id === externalId)?.mappingError, undefined)
assert.deepEqual(fs.readdirSync(daily), [], 'backfill must not create workspace directories')

listeners.get('session/created')({ header: { ...header, id: 'created-after-startup' } })
service.flush()
assert.ok(JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'), 'utf8'))['created-after-startup'])

const lateId = 'archived-after-startup'
persistedHeaders.push({ ...header, id: lateId })
workspaceRegistry.archivedSessionIds.push(lateId)
await service.syncArchivedCaches()
assert.equal(service.status().archived.find((item) => item.id === lateId)?.mappingError, undefined)
service.flush()
assert.ok(JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'), 'utf8'))[lateId])

for (const dispose of disposers.reverse()) await dispose()
disposers.length = 0
// Existing mappings keep the shared library root stable even when another
// native workspace looks like a relocated daily directory.
workspaceRegistry.list = () => [{ path: path.join(tmp, 'Other Harness', 'daily_conversation') }]
plugin.apply(ctx, {
  statePath: path.join(tmp, 'state.json'), configPath: path.join(tmp, 'config.json'),
  backup: { enabled: false, mode: 'off' }, updateCheck: { enabled: false },
})
assert.equal(services.get('conversationArchive').getConfig().harnessRoot, harnessRoot)
for (const dispose of disposers.reverse()) await dispose()
fs.rmSync(tmp, { recursive: true, force: true })
console.log('✓ 跨盘根目录识别与历史会话映射回填')
