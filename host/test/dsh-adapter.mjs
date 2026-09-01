import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDshAdapter } from '../lib/dsh-adapter.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-dsh-adapter-'))
const dshRoot = path.join(tmp, 'dsh-sessions')

function context(services = {}) {
  return { get: (name) => services[name] }
}

function persistence(root = dshRoot) {
  return {
    root,
    compression: 'zstd',
    locate: ({ id, cwd = 'workspace' }) => ({ path: path.join(root, cwd === 'workspace' ? '--workspace--' : cwd, id, 'session.jsonl.zstd') }),
  }
}

function registry(ids, extra = {}) {
  let state = { archivedSessionIds: ids }
  let tail = Promise.resolve()
  return {
    get archivedSessionIds() { return state.archivedSessionIds },
    requireState: () => state,
    setState: async (next) => { state = next },
    enqueueOperation: (operation) => {
      const result = tail.then(operation)
      tail = result.catch(() => {})
      return result
    },
    ...extra,
  }
}

async function test(name, run) {
  try { await run(); console.log(`✓ ${name}`) }
  catch (error) { console.error(`✗ ${name}: ${error.stack || error}`); process.exitCode = 1 }
}

await test('public restore uses DSH public method and refreshes native archive ids', async () => {
  const native = registry(['one'], { unarchiveSession: async (id) => { native.requireState().archivedSessionIds = native.archivedSessionIds.filter((x) => x !== id) } })
  const adapter = createDshAdapter(context({ workspaceRegistry: native, sessionPersistence: persistence(), dshVersion: '0.1.1-rc.2' }))
  assert.deepEqual(adapter.listArchivedIds(), ['one'])
  const result = await adapter.restoreSession('one')
  assert.deepEqual(result, { ok: true, mode: 'public' })
  assert.deepEqual(adapter.listArchivedIds(), [])
  assert.equal(adapter.compatibility().restoreMode, 'public')
})

await test('restore capability is never advertised or invoked as native deletion', async () => {
  const native = registry(['one'], { unarchiveSession: async (id) => { native.requireState().archivedSessionIds = native.archivedSessionIds.filter((x) => x !== id) } })
  const adapter = createDshAdapter(context({ workspaceRegistry: native, sessionPersistence: persistence() }))
  assert.equal(adapter.compatibility().destructiveAvailable, false)
  assert.deepEqual(await adapter.removeArchivedSession('one'), { ok: false, reason: 'native-delete-unsupported' })
  assert.deepEqual(adapter.listArchivedIds(), ['one'], '删除能力探测不得触发取消归档')
  assert.deepEqual(await adapter.finalizeDeletedSession('one'), { ok: false, reason: 'native-delete-finalize-unsupported' }, '缺少工作区解绑能力时不得把清除标记伪装成删除')
  assert.deepEqual(adapter.listArchivedIds(), ['one'])
})

await test('native deletion is available only through an explicit destructive API', async () => {
  const native = registry(['one'], { deleteArchivedSession: async (id) => { native.requireState().archivedSessionIds = native.archivedSessionIds.filter((x) => x !== id) } })
  const adapter = createDshAdapter(context({ workspaceRegistry: native, sessionPersistence: persistence() }))
  assert.equal(adapter.compatibility().destructiveAvailable, true)
  assert.deepEqual(await adapter.removeArchivedSession('one'), { ok: true, mode: 'public' })
  assert.deepEqual(adapter.listArchivedIds(), [])
})

await test('fallback deleted-session finalization detaches workspace membership before clearing archive state', async () => {
  let sessionIds = ['keep', 'one', 'later']
  const workspace = {
    get sessionIds() { return sessionIds },
    detachSession: async (id) => { sessionIds = sessionIds.filter((item) => item !== id) },
  }
  const native = registry(['one'], { list: () => [workspace] })
  const adapter = createDshAdapter(context({ workspaceRegistry: native, sessionPersistence: persistence() }))

  assert.deepEqual(await adapter.finalizeDeletedSession('one'), { ok: true, mode: 'fallback' })
  assert.deepEqual(sessionIds, ['keep', 'later'])
  assert.deepEqual(adapter.listArchivedIds(), [])
})

await test('fallback restores through guarded state methods', async () => {
  const native = registry(['one'])
  const adapter = createDshAdapter(context({ workspaceRegistry: native, sessionPersistence: persistence() }))
  assert.deepEqual(await adapter.restoreSession('one'), { ok: true, mode: 'fallback' })
  assert.deepEqual(adapter.listArchivedIds(), [])
  assert.equal(adapter.compatibility().restoreMode, 'fallback')
})

await test('restore is disabled without a public method or complete fallback capabilities', async () => {
  const native = { archivedSessionIds: ['one'], requireState: () => ({ archivedSessionIds: ['one'] }), setState: async () => {} }
  const adapter = createDshAdapter(context({ workspaceRegistry: native }))
  assert.deepEqual(await adapter.restoreSession('one'), { ok: false, reason: 'restore-unsupported' })
  assert.equal(adapter.compatibility().restoreAvailable, false)
})

await test('restore fails when native state does not verify the removal', async () => {
  const native = registry(['one'], { unarchiveSession: async () => {} })
  const adapter = createDshAdapter(context({ workspaceRegistry: native }))
  assert.deepEqual(await adapter.restoreSession('one'), { ok: false, reason: 'restore-not-verified', mode: 'public' })
})

await test('native list normalizes duplicate and malformed ids on every read', () => {
  const native = registry(['one', 'one', '..', '', 'two', 3])
  const adapter = createDshAdapter(context({ workspaceRegistry: native }))
  assert.deepEqual(adapter.listArchivedIds(), ['one', 'two'])
  native.requireState().archivedSessionIds = ['later']
  assert.deepEqual(adapter.listArchivedIds(), ['later'])
})

await test('compatibility hides paths and identifies the detected runtime capabilities', () => {
  const adapter = createDshAdapter(context({ workspaceRegistry: registry(['one']), sessionPersistence: persistence('C:/private/sessions'), dshVersion: '0.1.1-rc.2' }))
  const value = JSON.stringify(adapter.compatibility())
  assert.match(value, /0\.1\.1-rc\.2/)
  assert.doesNotMatch(value, /private|sessions/i)
})

await test('session locator accepts only a direct DSH session artifact under the configured persistence root', () => {
  const adapter = createDshAdapter(context({ sessionPersistence: persistence() }))
  assert.deepEqual(adapter.locateSessionDir('one', { cwd: 'workspace' }), { ok: true, dir: path.join(dshRoot, '--workspace--', 'one') })
  const unsafe = createDshAdapter(context({ sessionPersistence: { root: dshRoot, locate: () => ({ path: path.join(tmp, 'outside', 'one', 'session.jsonl') }) } }))
  assert.deepEqual(unsafe.locateSessionDir('one', { cwd: 'workspace' }), { ok: false, reason: 'dsh-session-invalid-locator' })
})

await test('session locator rejects another session id even when its artifact is under the same root', () => {
  const adapter = createDshAdapter(context({ sessionPersistence: { root: dshRoot, compression: 'zstd', locate: () => ({ path: path.join(dshRoot, '--workspace--', 'other', 'session.jsonl.zstd') }) } }))
  assert.deepEqual(adapter.locateSessionDir('one', { cwd: 'workspace' }), { ok: false, reason: 'dsh-session-invalid-locator' })
})

await test('session metadata resolves an archived native-only session through persistence snapshots', async () => {
  const sessionPersistence = {
    ...persistence(),
    listSnapshots: async () => [{ header: { id: 'native-only', cwd: 'workspace', createdAt: 42 } }],
  }
  const adapter = createDshAdapter(context({ sessions: { get: () => undefined }, sessionPersistence }))
  assert.deepEqual(await adapter.sessionMetadata('native-only'), { ok: true, metadata: { cwd: 'workspace', createdAt: 42 } })
  assert.deepEqual(await adapter.sessionMetadata('missing'), { ok: false, reason: 'dsh-session-not-found' })
})

await test('fallback restore serializes with a native archive operation without losing either update', async () => {
  const native = registry(['one'], {
    archiveSession: async (id) => native.enqueueOperation(async () => {
      const state = native.requireState()
      await native.setState({ ...state, archivedSessionIds: [...state.archivedSessionIds, id] })
    }),
  })
  const adapter = createDshAdapter(context({ workspaceRegistry: native }))
  await Promise.all([adapter.restoreSession('one'), native.archiveSession('two')])
  assert.deepEqual(adapter.listArchivedIds(), ['two'])
})

await test('mapping disagreement never becomes archive truth', () => {
  const native = registry(['native'])
  const adapter = createDshAdapter(context({ workspaceRegistry: native }))
  const mapping = { stale: { status: 'archived' }, native: { status: 'active', tag: 'safe' } }
  const archived = adapter.listArchivedEntries(mapping)
  assert.deepEqual(archived.map((entry) => entry.id), ['native'])
  assert.equal(archived[0].metadata.tag, 'safe')
})

if (process.exitCode) process.exit(process.exitCode)
