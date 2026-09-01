/**
 * Narrow compatibility seam for DSH workspace archiving.
 *
 * `workspaceRegistry.archivedSessionIds` is deliberately the only archive
 * authority.  DSH 0.1.1-rc.2 has no public unarchive method, so the guarded
 * requireState/setState fallback lives here rather than leaking into the
 * plugin's orchestration code.
 */
import path from 'node:path'
import fs from 'node:fs'
import { assertPhysicalPathInside, isPathInside, isSafeSessionId } from './core.js'

const LOG_FILE = /^session\.jsonl(?:\.zstd)?$/i

function registryFor(ctx) {
  return ctx?.get?.('workspaceRegistry')
}

function idsFrom(registry) {
  const raw = registry?.archivedSessionIds
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  return raw.filter((id) => typeof id === 'string' && isSafeSessionId(id) && !seen.has(id) && (seen.add(id), true))
}

function publicRestore(registry, operation = 'restore') {
  const names = operation === 'delete'
    ? ['deleteArchivedSession', 'removeArchivedSession']
    : ['unarchiveSession', 'restoreSession']
  for (const name of names) {
    if (typeof registry?.[name] === 'function') return { name, run: registry[name].bind(registry) }
  }
  return null
}

function fallbackAvailable(registry) {
  // DSH's registry serializes all durable mutations through this method. A
  // direct requireState/setState pair can overwrite a concurrent archive.
  return typeof registry?.enqueueOperation === 'function' && typeof registry?.requireState === 'function' && typeof registry?.setState === 'function'
}

// Mirrors DSH 0.1.1-rc.2's JSONL persistence format helpers.  The backend
// deliberately escapes ids and groups them by cwd; containment alone cannot
// prove that a locator did not point at a different conversation.
function encodeSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const ch = String.fromCharCode(code)
    out += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch) ? ch : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('invalid-session-cwd')
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

function samePath(left, right) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function safeMetadata(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const value = {}
  for (const key of ['kind', 'tag', 'date', 'createdAt', 'cachePhase']) {
    if (typeof entry[key] === 'string' || typeof entry[key] === 'number') value[key] = entry[key]
  }
  return value
}

function dshVersion(ctx) {
  const provided = ctx?.get?.('dshVersion')
  if (typeof provided === 'string' && provided) return provided
  const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const entry of pathEntries) {
    try {
      const manifest = path.join(entry, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
      const version = JSON.parse(fs.readFileSync(manifest, 'utf8')).version
      if (typeof version === 'string' && version) return version
    } catch { /* DSH is not installed from this PATH entry. */ }
  }
  return 'unknown'
}

/** Create an adapter over the DSH services available in this Cordis context. */
export function createDshAdapter(ctx, log = () => {}) {
  const listArchivedIds = () => idsFrom(registryFor(ctx))

  const sessionMetadata = async (id) => {
    if (!isSafeSessionId(id)) return { ok: false, reason: 'invalid-session-id' }
    const live = ctx?.get?.('sessions')?.get?.(id)?.header
    if (live && String(live.id) === id) return { ok: true, metadata: { cwd: typeof live.cwd === 'string' ? live.cwd : undefined, createdAt: live.createdAt } }
    const persistence = ctx?.get?.('sessionPersistence')
    try {
      const rows = typeof persistence?.list === 'function' ? await persistence.list()
        : typeof persistence?.listSnapshots === 'function' ? (await persistence.listSnapshots()).map((item) => item?.header) : []
      const header = rows.find((item) => String(item?.id || '') === id)
      return header ? { ok: true, metadata: { cwd: typeof header.cwd === 'string' ? header.cwd : undefined, createdAt: header.createdAt } } : { ok: false, reason: 'dsh-session-not-found' }
    } catch (error) {
      log(`DSH session metadata lookup failed: ${error?.message || error}`)
      return { ok: false, reason: 'dsh-session-metadata-unavailable' }
    }
  }

  const clearArchivedSession = async (id, operation = 'restore') => {
    if (!isSafeSessionId(id)) return { ok: false, reason: 'invalid-session-id' }
    const registry = registryFor(ctx)
    if (!listArchivedIds().includes(id)) return { ok: false, reason: 'not-archived' }
    const publicApi = publicRestore(registry, operation)
    const mode = publicApi ? 'public' : operation === 'restore' && fallbackAvailable(registry) ? 'fallback' : ''
    if (!mode) return { ok: false, reason: operation === 'delete' ? 'native-delete-unsupported' : 'restore-unsupported' }
    try {
      if (publicApi) await publicApi.run(id)
      else await registry.enqueueOperation(async () => {
        const state = registry.requireState()
        if (!state || !Array.isArray(state.archivedSessionIds) || !state.archivedSessionIds.includes(id)) throw new Error('restore-not-archived')
        await registry.setState({ ...state, archivedSessionIds: state.archivedSessionIds.filter((item) => item !== id) })
      })
    } catch (error) {
      log(`DSH native archive-state change failed: ${error?.message || error}`)
      return { ok: false, reason: operation === 'delete' ? 'native-delete-failed' : 'native-restore-failed', mode }
    }
    if (listArchivedIds().includes(id)) return { ok: false, reason: operation === 'delete' ? 'delete-not-verified' : 'restore-not-verified', mode }
    return { ok: true, mode }
  }

  const restoreSession = (id) => clearArchivedSession(id, 'restore')
  const removeArchivedSession = (id) => clearArchivedSession(id, 'delete')
  // DSH 0.1.1 has no public conversation-delete API. Once the independently
  // validated session data has been recycled, remove its durable workspace
  // membership before clearing the archive marker. Clearing only the marker
  // is an unarchive operation and would make the deleted row visible again.
  const finalizeDeletedSession = async (id) => {
    if (!isSafeSessionId(id)) return { ok: false, reason: 'invalid-session-id' }
    const registry = registryFor(ctx)
    if (typeof registry?.list !== 'function' || !fallbackAvailable(registry)) return { ok: false, reason: 'native-delete-finalize-unsupported' }
    try {
      const workspaces = registry.list()
      if (!Array.isArray(workspaces) || workspaces.some((workspace) => typeof workspace?.detachSession !== 'function')) return { ok: false, reason: 'native-delete-finalize-unsupported' }
      for (const workspace of workspaces) await workspace.detachSession(id)
      if (listArchivedIds().includes(id)) {
        const cleared = await clearArchivedSession(id, 'restore')
        if (!cleared.ok) return cleared
      }
      if (registry.list().some((workspace) => Array.isArray(workspace?.sessionIds) && workspace.sessionIds.includes(id))) return { ok: false, reason: 'workspace-detach-not-verified' }
      return { ok: true, mode: 'fallback' }
    } catch (error) {
      log(`DSH deleted-session finalization failed: ${error?.message || error}`)
      return { ok: false, reason: 'native-delete-finalize-failed' }
    }
  }

  const locateSessionDir = (id, metadata = {}) => {
    if (!isSafeSessionId(id)) return { ok: false, reason: 'invalid-session-id' }
    const persistence = ctx?.get?.('sessionPersistence')
    // A configured local persistence root is the authorization boundary. A
    // backend without one can still list archives, but never authorizes a
    // destructive session-file operation through this plugin.
    if (typeof persistence?.locate !== 'function' || typeof persistence?.root !== 'string') return { ok: false, reason: 'dsh-session-locator-unavailable' }
    try {
      const location = persistence.locate({ ...metadata, id })
      const record = location?.path
      const root = path.resolve(persistence.root)
      if (typeof record !== 'string' || !path.isAbsolute(record)) return { ok: false, reason: 'dsh-session-invalid-locator' }
      const resolved = path.resolve(record)
      const dir = path.dirname(resolved)
      // JSONL persistence owns exactly <root>/<project>/<encoded-id>/session…
      // and does not authorize a parent directory, an arbitrary file, or a
      // path whose identity falls outside the backend's configured root.
      const compression = persistence.compression === 'none' ? 'none' : persistence.compression === 'zstd' ? 'zstd' : null
      const project = metadata.cwd === undefined ? '_no-cwd' : typeof metadata.cwd === 'string' ? projectKey(metadata.cwd) : null
      const expected = compression && project ? path.join(root, project, encodeSegment(id), compression === 'zstd' ? 'session.jsonl.zstd' : 'session.jsonl') : null
      if (!expected || !LOG_FILE.test(path.basename(resolved)) || !samePath(resolved, expected) || !isPathInside(root, dir) || !isPathInside(root, path.dirname(dir))) return { ok: false, reason: 'dsh-session-invalid-locator' }
      assertPhysicalPathInside(dir, [root], fs)
      return { ok: true, dir }
    } catch (error) {
      log(`DSH session locator rejected: ${error?.message || error}`)
      return { ok: false, reason: 'dsh-session-invalid-locator' }
    }
  }

  const compatibility = () => {
    const registry = registryFor(ctx)
    const publicApi = publicRestore(registry)
    const publicDeleteApi = publicRestore(registry, 'delete')
    const fallback = fallbackAvailable(registry)
    const persistence = ctx?.get?.('sessionPersistence')
    const workspaceDetachAvailable = typeof registry?.list === 'function' && registry.list().every((workspace) => typeof workspace?.detachSession === 'function')
    return {
      dshVersion: dshVersion(ctx),
      workspaceRegistry: !!registry,
      archiveListAvailable: Array.isArray(registry?.archivedSessionIds),
      restoreAvailable: !!publicApi || fallback,
      destructiveAvailable: !!publicDeleteApi,
      stagedDeletionAvailable: (!!publicDeleteApi || (fallback && workspaceDetachAvailable)) && typeof persistence?.locate === 'function' && typeof persistence?.root === 'string',
      restoreMode: publicApi ? 'public' : fallback ? 'fallback' : 'unsupported',
      sessionLocatorAvailable: typeof persistence?.locate === 'function' && typeof persistence?.root === 'string',
    }
  }

  const listArchivedEntries = (mapping = {}) => listArchivedIds().map((id) => {
    const entry = mapping?.[id]
    const metadata = safeMetadata(entry)
    return metadata === null && entry !== undefined
      ? { id, mappingError: 'invalid-mapping' }
      : { id, metadata: metadata || {} }
  })

  return { listArchivedIds, listArchivedEntries, sessionMetadata, restoreSession, removeArchivedSession, finalizeDeletedSession, locateSessionDir, compatibility }
}
