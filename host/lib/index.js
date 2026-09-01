/**
 * dsh-conversation-archive · Cordis Host 插件入口 v3
 * - 根作用域：DSH 原生归档管理、重要文件保护、本地备份与设置页服务
 * - agent 预设实例复用根服务，不重复注册模型工具或 slash 命令
 * 插件不创建项目、镜像缓存、日期目录或文件分类目录。
 */
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import crypto from 'node:crypto'
import {
  DEFAULTS, atomicWriteJson, appendOperation, inspectOperationsLog, inspectVersionedJson, loadVersionedJson, loadConfig, toJsonSafe, isPathInside, assertPhysicalPathInside, assertSessionPhysicalPaths, isSafeSessionId, classifyWorkspace, sanitizeName, dateStr, placeholderTag,
  cacheLayoutFor,
  loadMapping, saveMapping, validateSessionEntry, archiveSessionFlow, restoreSessionFlow, purgeSessionFlow,
  runMany, createBackup, listBackups, restoreBackup, runOverdueBackup, backupScheduleView, resetBackupSchedule, orphanGC, recyclePath,
  findRetentionCandidates, reviewRetentionCandidates, retainReviewedFiles, listRetainedFiles, restoreRetainedFile, removeRetainedProvenance, recycleRetainedFile, recoverRetainedRecycle, retentionReminder,
} from './core.js'
import { createDshAdapter } from './dsh-adapter.js'
import { checkForUpdate, readReleaseManifest } from './update-check.js'

const RELEASE_MANIFEST = readReleaseManifest(new URL('../../release-manifest.json', import.meta.url))
const PLUGIN_VERSION = RELEASE_MANIFEST.version

function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}
function defaultStateDir() {
  return path.join(resolveDshHome(), 'storages', DEFAULTS.stateSubDir)
}
function defaultStatePath() {
  return path.join(defaultStateDir(), 'state.json')
}
function defaultConfigPath() {
  return path.join(defaultStateDir(), 'config.json')
}

const API_MAX_BODY_BYTES = 64 * 1024
const API_MAX_BATCH_IDS = 50

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

function apiError(status, code, message, details) { return new ApiError(status, code, message, details) }
function plainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype }
function apiObject(value, allowed, label = 'body') {
  if (!plainObject(value)) throw apiError(400, 'invalid-request', `${label} must be an object`)
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor' || !allowed.includes(key)) throw apiError(400, 'invalid-request', `unsupported field: ${key}`)
  }
  return value
}

function hasDuplicateJsonKeys(text) {
  const stack = []
  let index = 0
  const stringEnd = (start) => {
    let escaped = false
    for (let i = start + 1; i < text.length; i += 1) {
      if (escaped) { escaped = false; continue }
      if (text[i] === '\\') { escaped = true; continue }
      if (text[i] === '"') return i
    }
    return -1
  }
  while (index < text.length) {
    const ch = text[index]
    if (/\s/.test(ch)) { index += 1; continue }
    if (ch === '{') { stack.push(new Set()); index += 1; continue }
    if (ch === '}') { stack.pop(); index += 1; continue }
    if (ch !== '"') { index += 1; continue }
    const end = stringEnd(index)
    if (end < 0) return true
    const literal = text.slice(index, end + 1)
    let next = end + 1
    while (/\s/.test(text[next] || '')) next += 1
    if (text[next] === ':' && stack.length) {
      let key
      try { key = JSON.parse(literal) } catch { return true }
      const keys = stack.at(-1)
      if (keys.has(key)) return true
      keys.add(key)
    }
    index = end + 1
  }
  return false
}

async function apiJsonBody(req) {
  const headers = req?.headers || {}
  const contentType = String(headers['content-type'] || headers['Content-Type'] || '')
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw apiError(400, 'invalid-request', 'Content-Type must be application/json')
  const declared = headers['content-length'] || headers['Content-Length']
  if (declared !== undefined && (!/^\d+$/.test(String(declared)) || Number(declared) > API_MAX_BODY_BYTES)) throw apiError(413, 'body-too-large', 'JSON body exceeds 64 KiB')
  let text = ''
  const append = (chunk) => {
    text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    if (Buffer.byteLength(text, 'utf8') > API_MAX_BODY_BYTES) throw apiError(413, 'body-too-large', 'JSON body exceeds 64 KiB')
  }
  if (req?.body !== undefined) append(req.body)
  else if (typeof req?.[Symbol.asyncIterator] === 'function') {
    let timer
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(apiError(408, 'request-timeout', 'request body timed out')), 10_000) })
    try { await Promise.race([timeout, (async () => { for await (const chunk of req) { if (req.aborted) throw apiError(408, 'request-aborted', 'request aborted'); append(chunk) } })()]) }
    finally { clearTimeout(timer) }
  } else throw apiError(400, 'invalid-request', 'missing JSON body')
  if (!text) throw apiError(400, 'invalid-request', 'missing JSON body')
  if (hasDuplicateJsonKeys(text)) throw apiError(400, 'invalid-request', 'duplicate JSON field')
  let value
  try { value = JSON.parse(text) } catch { throw apiError(400, 'invalid-request', 'malformed JSON') }
  return apiObject(value, Object.keys(value))
}

function effectiveConfigSections(config) {
  const value = config || {}
  const section = (name) => plainObject(value[name]) ? value[name] : {}
  const bool = (candidate, fallback) => typeof candidate === 'boolean' ? candidate : fallback
  const bounded = (candidate, fallback, min, max) => Number.isInteger(candidate) && candidate >= min && candidate <= max ? candidate : fallback
  const backup = section('backup')
  const remind = section('remind')
  const retention = section('retention')
  const updateCheck = section('updateCheck')
  const backupTarget = typeof backup.targetDir === 'string' && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(backup.targetDir) && (path.isAbsolute(backup.targetDir) || path.win32.isAbsolute(backup.targetDir)) ? backup.targetDir : DEFAULTS.backup.targetDir
  return {
    harnessRoot: typeof value.harnessRoot === 'string' && (path.isAbsolute(value.harnessRoot) || path.win32.isAbsolute(value.harnessRoot)) ? value.harnessRoot : DEFAULTS.harnessRoot,
    backup: {
      targetDir: backupTarget,
      enabled: bool(backup.enabled, DEFAULTS.backup.enabled),
      mode: ['off', 'periodic', 'shutdown'].includes(backup.mode) ? backup.mode : DEFAULTS.backup.mode,
      autoIntervalDays: bounded(backup.autoIntervalDays, DEFAULTS.backup.autoIntervalDays, 0, 365),
      keepCount: bounded(backup.keepCount, DEFAULTS.backup.keepCount, 1, 100),
    },
    remind: { intervalDays: bounded(remind.intervalDays, DEFAULTS.remind.intervalDays, 1, 365) },
    retention: {
      enabled: bool(retention.enabled, DEFAULTS.retention.enabled),
      maxCandidates: bounded(retention.maxCandidates, DEFAULTS.retention.maxCandidates, 1, 100),
      maxCandidateBytes: bounded(retention.maxCandidateBytes, DEFAULTS.retention.maxCandidateBytes, 1, 64 * 1024 * 1024),
      maxExcerptChars: bounded(retention.maxExcerptChars, DEFAULTS.retention.maxExcerptChars, 100, 10_000),
      timeoutMs: bounded(retention.timeoutMs, DEFAULTS.retention.timeoutMs, 1_000, 120_000),
    },
    updateCheck: { enabled: bool(updateCheck.enabled, DEFAULTS.updateCheck.enabled) },
  }
}

function safeConfigView(config) { return effectiveConfigSections(config) }

/** 内存映射缓存 + 防抖落盘（消除逐事件读盘） */
export function createStateStore(statePath, fsApi, log = () => {}, onError = () => {}, { initialMap = null, readOnly: initialReadOnly = false } = {}) {
  let cache = initialMap
  let persisted = initialMap === null ? null : structuredClone(initialMap)
  let timer = null
  let readOnly = initialReadOnly
  const load = () => {
    if (cache === null) {
      cache = loadMapping(statePath, fsApi, (e) => { readOnly = true; onError(e.code) })
      persisted = structuredClone(cache)
    }
    return cache
  }
  const save = (next = cache) => {
    if (readOnly) throw new Error('persistence-read-only')
    const candidate = structuredClone(next)
    try { saveMapping(statePath, candidate, fsApi); cache = candidate }
    catch (e) {
      cache = persisted === null ? null : structuredClone(persisted)
      readOnly = true
      onError('state-write-failed')
      log(`[state] 落盘失败: ${e.message}`)
      throw e
    }
    persisted = structuredClone(cache)
  }
  const scheduleSave = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; try { save() } catch { /* 已进入只读模式 */ } }, 800)
  }
  return {
    getMap: load,
    upsert(id, entry) {
      if (readOnly) throw new Error('persistence-read-only')
      if (!isSafeSessionId(id)) throw new Error('reserved-session-id')
      cache = { ...load(), [id]: entry }; scheduleSave()
    },
    remove(id) { if (readOnly) throw new Error('persistence-read-only'); const next = { ...load() }; delete next[id]; cache = next; scheduleSave() },
    commit(next) { save(next) },
    flush: save,
    isReadOnly: () => readOnly,
    dispose() { if (timer) { clearTimeout(timer); timer = null } if (!readOnly) { try { save() } catch { /* 已进入只读模式 */ } } },
  }
}

/** 单文件运行状态（替代多个诊断标记文件） */
function createStatusFile(stateDir, fsApi, { disabled: initiallyDisabled = false, initialValue = null, onError = () => {} } = {}) {
  const file = path.join(stateDir, 'status.json')
  let error = ''
  let disabled = initiallyDisabled
  const read = () => {
    if (disabled) return initialValue || {}
    try { const { schemaVersion: _schemaVersion, ...value } = loadVersionedJson(file, { schemaVersion: 1 }, (v) => ({ schemaVersion: 1, ...v }), fsApi); return value } catch (e) { error = e.code || 'status-read-failed'; disabled = true; onError(error); throw e }
  }
  const write = (partial) => {
    if (error || disabled) return
    try {
      atomicWriteJson(file, { schemaVersion: 1, ...read(), ...partial, updatedAt: new Date().toISOString() }, fsApi)
    } catch (e) { error = e.code || 'status-write-failed'; disabled = true; onError(error); throw e }
  }
  if (!disabled) try { read() } catch { /* onError already disabled global writes */ }
  return { read, write, error: () => error, disable: () => { disabled = true } }
}

export default {
  name: 'conversation-archive',
  inject: ['sessions', 'webServer'],
  apply(ctx, patchConfig) {
    const cfg = patchConfig || {}
    const stateDir = defaultStateDir()
    const statePath = path.resolve(cfg.statePath || defaultStatePath())
    const configPath = path.resolve(cfg.configPath || defaultConfigPath())
    // Test hosts may inject a filesystem facade; production defaults to Node fs.
    const fsApi = ctx.get('conversationArchiveFs') || fs
    const recycle = ctx.get('conversationArchiveRecycle') || recyclePath
    const dshRecycle = ctx.get('conversationArchiveDshRecycle') || recyclePath
    const stateRoot = path.dirname(statePath)
    const statusPath = path.join(stateRoot, 'status.json')
    const retainedIndexPath = path.join(stateRoot, 'retained.json')
    const retentionOperationPath = path.join(stateRoot, 'retention-operation.json')
    const retainedDeleteOperationPath = path.join(stateRoot, 'retained-delete.json')
    const backupStatePath = path.join(stateRoot, 'backups.json')
    const operationsPath = path.join(stateRoot, 'operations.jsonl')
    const preflight = (store, file) => {
      try { return { store, ...inspectVersionedJson(file, fsApi) } }
      catch (e) { return { store, error: e.code || 'state-read-failed', value: null } }
    }
    // Validate every persisted store before a migration or status write. A corrupt
    // sibling store must never cause a "repair" write to a different store.
    const preflightStores = [preflight('config', configPath), preflight('mapping', statePath), preflight('status', statusPath), preflight('retained', retainedIndexPath), preflight('retention-operation', retentionOperationPath), preflight('retained-delete', retainedDeleteOperationPath), preflight('backups', backupStatePath)]
    try {
      const audit = inspectOperationsLog(operationsPath, { stateRoot, fsApi })
      if (audit.malformedCount) preflightStores.push({ store: 'operations', error: 'invalid-operations-log', value: null })
    } catch (e) { preflightStores.push({ store: 'operations', error: e.message || 'invalid-operations-log', value: null }) }
    const preflightErrors = preflightStores.filter((item) => item.error).map(({ store, error }) => ({ store, code: error }))
    const preflightByStore = Object.fromEntries(preflightStores.map((item) => [item.store, item]))
    let config = loadConfig(fsApi, cfg, preflightErrors.length ? '' : configPath)
    const configPreflight = preflightByStore.config
    if (configPreflight.error) config.persistenceError = configPreflight.error
    const harnessRoot = path.resolve(config.harnessRoot)
    const log = (...args) => ctx.logger?.info('[conversation-archive]', ...args)
    const persistenceErrors = [...preflightErrors]
    let writesDisabled = persistenceErrors.length > 0
    let pluginDisposed = false
    let status = null
    const disableWrites = (store, code) => {
      writesDisabled = true
      status?.disable()
      if (!persistenceErrors.some((e) => e.store === store && e.code === code)) persistenceErrors.push({ store, code })
    }
    const statusPreflight = preflightByStore.status
    const statusValue = statusPreflight.value && typeof statusPreflight.value === 'object'
      ? Object.fromEntries(Object.entries(statusPreflight.value).filter(([key]) => key !== 'schemaVersion')) : {}
    status = createStatusFile(path.dirname(statePath), fsApi, {
      disabled: writesDisabled,
      initialValue: statusValue,
      onError: (code) => disableWrites('status', code),
    })
    if (config.persistenceError) disableWrites('config', config.persistenceError)
    if (writesDisabled) status.disable()
    const mappingPreflight = preflightByStore.mapping
    const initialMap = writesDisabled && mappingPreflight.value && typeof mappingPreflight.value === 'object'
      ? Object.fromEntries(Object.entries(mappingPreflight.value).filter(([key]) => key !== 'schemaVersion')) : null
    const store = createStateStore(statePath, fsApi, log, (code) => disableWrites('mapping', code), { initialMap, readOnly: writesDisabled })
    const audit = (record) => {
      try { return appendOperation(operationsPath, record, { stateRoot, fsApi }) }
      catch (e) { disableWrites('operations', e.message || 'operations-write-failed'); throw e }
    }
    // Loading here is safe only after all three stores passed side-effect-free preflight.
    const sessionPersistence = ctx.get('sessionPersistence')
    // DSH owns archive truth. The local mapping only records plugin cache work.
    const dsh = createDshAdapter(ctx, log)
    const updateFetch = ctx.get('conversationArchiveFetch') || globalThis.fetch
    let updateSnapshot = { state: config.updateCheck?.enabled === false ? 'disabled' : 'checking', currentVersion: PLUGIN_VERSION }
    const runUpdateCheck = async () => {
      updateSnapshot = await checkForUpdate({ enabled: config.updateCheck?.enabled !== false, manifest: RELEASE_MANIFEST, fetchImpl: updateFetch, platform: process.platform, dshVersion: dsh.compatibility().dshVersion })
      return updateSnapshot
    }
    const clearNativeArchivedId = async (id) => dsh.listArchivedIds().includes(id)
      ? dsh.forgetArchivedMarker(id) : { ok: true, alreadyAbsent: true }
    const deletionQueue = () => {
      const raw = status.read().purgeQueue
      if (!Array.isArray(raw)) return []
      const seen = new Set()
      return raw.filter((item) => item && isSafeSessionId(item.sessionId) && !seen.has(item.sessionId) && (seen.add(item.sessionId), true))
    }
    const saveDeletionQueue = (queue) => status.write({ purgeQueue: queue })
    const removeFromDeletionQueue = (id) => saveDeletionQueue(deletionQueue().filter((item) => item.sessionId !== id))
    const recoverPurgeIntent = async () => {
      const pending = status.read().purgePending
      if (!pending || typeof pending !== 'object' || !isSafeSessionId(pending.sessionId) || typeof pending.target !== 'string' || !['registered', 'none'].includes(pending.cacheScope || 'registered')) return
      const map = store.getMap()
      const entry = map[pending.sessionId]
      if ((pending.cacheScope || 'registered') === 'registered') {
        const valid = validateSessionEntry(pending.sessionId, entry, { harnessRoot, config, mapping: map })
        if (!valid.ok || path.resolve(entry.archivePath || '') !== path.resolve(pending.target) || fsApi.existsSync(pending.target)) return
      } else if (!['dsh-recycled-native-pending', 'native-cleared'].includes(pending.phase)) return
      if (pending.phase === 'cache-recycled-dsh-pending') {
        const dshRecycleResult = await deleteDshSessionOnce(pending.sessionId, entry || null, map)
        if (!dshRecycleResult?.ok) {
          log(`[purge 恢复] DSH 日志尚未回收: ${dshRecycleResult?.reason || 'dsh-recycle-failed'}`)
          return
        }
      }
      const native = await clearNativeArchivedId(pending.sessionId)
      if (!native.ok) {
        log(`[purge 恢复] 原生归档状态尚未收敛: ${native.reason}`)
        return
      }
      // Recovery awaits native filesystem work above. Re-read the in-memory
      // authoritative mapping before committing its one-session convergence:
      // an archive reconciliation for another session may have committed while
      // this purge intent was in flight. Removing an entry needs no trust in
      // its current contents, so an invalid replacement is removed rather than
      // being re-used as authority for any filesystem action.
      const nextMap = { ...store.getMap() }
      delete nextMap[pending.sessionId]
      try {
        store.commit(nextMap)
        status.write({ purgePending: null })
        removeFromDeletionQueue(pending.sessionId)
      } catch (e) {
        log(`[purge 恢复] 暂不能完成映射收敛: ${e.message}`)
      }
    }
    const validateCacheWrite = (id, entry) => {
      const valid = validateSessionEntry(id, entry, { harnessRoot, config, mapping: { [id]: entry } })
      if (!valid.ok) throw new Error(valid.reason)
      assertSessionPhysicalPaths(id, entry, valid, { harnessRoot, config, fsApi })
      return valid
    }
    // ── DSH 会话定位/删除：locator 输出也不是权限，只接受当前 id 的直接目录。──
    const getValidatedEntry = (sessionId) => {
      const id = String(sessionId || '')
      const map = store.getMap()
      const entry = map[id]
      if (!entry) return { ok: false, id, reason: 'no-entry' }
      const valid = validateSessionEntry(id, entry, { harnessRoot, config, mapping: map })
      return valid.ok ? { ok: true, id, entry, map, valid } : { ok: false, id, reason: valid.reason }
    }
    const locateDshSession = (sessionId, entry, mapping = store.getMap()) => {
      const id = String(sessionId || '')
      const valid = validateSessionEntry(id, entry, { harnessRoot, config, mapping })
      if (!valid.ok) return valid
      return dsh.locateSessionDir(id, { cwd: entry.cwd, createdAt: entry.createdAt })
    }
    const locateDshSessionAny = async (sessionId, entry = null, mapping = store.getMap()) => {
      const id = String(sessionId || '')
      if (entry) return locateDshSession(id, entry, mapping)
      const found = await dsh.sessionMetadata(id)
      if (!found.ok) return found
      return dsh.locateSessionDir(id, found.metadata)
    }
    const deleteDshSessionOnce = async (sessionId, entry = null, mapping = store.getMap()) => {
      const located = await locateDshSessionAny(sessionId, entry, mapping)
      if (!located.ok) return located
      if (!fsApi.existsSync(located.dir)) return { ok: true, alreadyAbsent: true }
      return dshRecycle(located.dir, undefined, fsApi)
    }
    const nativeRetentionTarget = (entry, fallback = '') => entry?.layoutVersion === 3
      ? (entry.kind === 'project' ? entry.root : entry.cwd)
      : fallback
    const nativeRetentionWindow = (entry) => entry?.layoutVersion === 3
      ? {
          modifiedAfter: Number(entry.createdAt) - Math.max(0, Number(config.capture?.margin) || 0),
          modifiedBefore: Date.now() + Math.max(0, Number(config.capture?.margin) || 0),
        }
      : {}
    const retainBeforePurge = async ({ sessionId, entry, target, sourceRoots = [harnessRoot], operationId, candidateWindow = {} }) => {
      if (pluginDisposed) return { ok: false, reason: 'plugin-disposed' }
      if (config.retention?.enabled === false) return { ok: true, retained: [] }
      let candidates
      try { candidates = findRetentionCandidates(target, fsApi, { ...config.retention, ...candidateWindow }) }
      catch { return { ok: false, reason: 'retention-scan-failed' } }
      if (candidates.truncated) return { ok: false, reason: 'retention-candidate-limit-exceeded' }
      if (candidates.length === 0) return { ok: true, retained: [] }
      if (operationId) audit({ operationId, type: 'retention', sessionId, phase: 'ai-review', outcome: 'started', details: { candidateCount: candidates.length } })
      const selected = []
      const batchSize = Math.max(1, Number(candidates.batchSize) || Number(config.retention?.maxCandidates) || 40)
      let reviewed = { ok: true, selected }
      for (let offset = 0; offset < candidates.length; offset += batchSize) {
        const part = await reviewRetentionCandidates(ctx, candidates.slice(offset, offset + batchSize), { ...config.retention, fsApi })
        if (!part.ok) { reviewed = part; break }
        selected.push(...part.selected)
      }
      if (pluginDisposed) return { ok: false, reason: 'plugin-disposed' }
      if (!reviewed.ok) {
        if (operationId) audit({ operationId, type: 'retention', sessionId, phase: 'ai-review', outcome: 'failed', details: { reason: reviewed.reason || 'ai-review-failed' } })
        return reviewed
      }
      if (selected.length === 0) return { ok: true, retained: [] }
      const retained = retainReviewedFiles(reviewed.selected, {
        sessionId,
        projectRoot: entry.kind === 'project' ? entry.root : '',
        cacheRoot: target,
        retainedRoot: path.join(harnessRoot, config.protectDirName || DEFAULTS.protectDirName),
        indexPath: retainedIndexPath,
        operationPath: retentionOperationPath,
        harnessRoot,
        stateRoot,
        sourceRoots,
        fsApi,
      })
      if (retained.ok) refreshRetainedSnapshot()
      if (operationId) audit({ operationId, type: 'retention', sessionId, phase: 'copy', outcome: retained.ok ? 'ok' : 'failed', details: { protectedCount: retained.retained?.length || 0, reason: retained.reason || '' } })
      return retained
    }
    if (!writesDisabled) {
      store.getMap()
      void recoverPurgeIntent().catch((e) => log(`[purge 恢复] ${e.message}`))
      status.write({ bootStart: new Date().toISOString(), version: PLUGIN_VERSION })
    }

    // ── 业务动作（供服务/工具/命令共用）──
    // DSH 工具输出要求 lossless JSON：剔除值为 undefined 的字段（否则整值判定失败）
    const compact = (obj) => {
      const out = {}
      for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v
      return out
    }
    /** 定位 DSH 会话目录（仅返回经过 session id/root 校验的 locator 结果） */
    const locateSessionDir = (id) => {
      const checked = getValidatedEntry(id)
      if (!checked.ok) return null
      const located = locateDshSession(checked.id, checked.entry)
      return located.ok ? located.dir : null
    }
    // Reconcile only plugin bookkeeping phases. DSH's archive set remains the
    // source of truth, and no reconciliation step ever moves a DSH log.
    const reconcileNativeArchives = () => {
      const map = store.getMap()
      const archivedIds = new Set(dsh.listArchivedIds())
      if (writesDisabled || store.isReadOnly()) return map
      let next = map
      for (const [id, entry] of Object.entries(map)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !isSafeSessionId(id)) continue
        const prior = entry.cachePhase || (entry.status === 'archived' ? 'cache-archived' : 'active')
        const phase = archivedIds.has(id)
          ? (prior === 'cache-archived' ? prior : 'native-archived')
          : (prior === 'native-archived' || prior === 'cache-archived' ? 'native-restored-pending-cache' : prior)
        if (phase !== entry.cachePhase) {
          if (next === map) next = { ...map }
          next[id] = { ...entry, cachePhase: phase }
        }
      }
      if (next !== map) {
        try { store.commit(next) }
        catch (e) { log(`[native archive reconciliation] ${e.message}`) }
      }
      return store.getMap()
    }
    // A write-side preflight prepares the registered cache after DSH has
    // already archived the session. DSH 0.1.1-rc.2 exposes no archive event.
    const prepareArchivedCache = async (sessionId) => {
      if (writesDisabled || store.isReadOnly()) return { ok: false, reason: 'persistence-read-only' }
      reconcileNativeArchives()
      const checked = getValidatedEntry(sessionId)
      if (!checked.ok) {
        if (checked.reason === 'no-entry') return compact({ ok: true, id: checked.id, cacheScope: 'none', map: store.getMap() })
        return compact({ ok: false, reason: checked.reason })
      }
      const { id, entry, map } = checked
      if (!dsh.listArchivedIds().includes(id)) return compact({ ok: false, reason: 'not-natively-archived' })
      if (entry.layoutVersion === 3) return { ok: true, id, entry, map, cacheScope: 'none' }
      if (entry.status === 'archived' && entry.archivePath && fsApi.existsSync(entry.archivePath)) return { ok: true, id, entry, map, cacheScope: 'registered', target: entry.archivePath }
      const activeTarget = cacheLayoutFor(entry, { harnessRoot }).base
      if (!fsApi.existsSync(activeTarget)) {
        // The periodic native reconciliation can move this cache after the
        // snapshot above. Re-read the registered entry before treating it as
        // a native-only conversation, otherwise a purge could leave its cache
        // behind in the archive directory.
        const current = getValidatedEntry(id)
        if (current.ok && dsh.listArchivedIds().includes(id) && current.entry.status === 'archived' && current.entry.archivePath && fsApi.existsSync(current.entry.archivePath)) {
          try {
            validateCacheWrite(id, current.entry)
            assertPhysicalPathInside(current.entry.archivePath, [path.join(harnessRoot, config.archiveDirName || DEFAULTS.archiveDirName)], fsApi)
          }
          catch (e) { return compact({ ok: false, reason: e.message || 'invalid-archive-path' }) }
          return { ok: true, id, entry: current.entry, map: current.map, cacheScope: 'registered', target: current.entry.archivePath }
        }
        return { ok: true, id, entry, map, cacheScope: 'none' }
      }
      const candidate = structuredClone(entry)
      delete candidate.dshSessionPending
      const nextMap = { ...map, [id]: candidate }
      const cacheOnlyConfig = { ...config, archive: { ...config.archive, deleteDshSession: false, moveDshSession: false } }
      const res = archiveSessionFlow(id, candidate, { fsApi, harnessRoot, config: cacheOnlyConfig, log, mapping: nextMap })
      if (res.entry) {
        if (res.ok) candidate.cachePhase = 'cache-archived'
        try { store.commit(nextMap) }
        catch (e) {
          restoreSessionFlow(id, candidate, { fsApi, harnessRoot, config, log, mapping: nextMap })
          return compact({ ok: false, reason: 'state-write-failed' })
        }
      }
      if (!res.ok) return compact({ ok: false, reason: res.reason })
      const committed = store.getMap()
      return { ok: true, id, entry: committed[id], map: committed, cacheScope: 'registered', target: committed[id].archivePath }
    }
    const restore = async (sessionId) => {
      if (pluginDisposed) return { ok: false, reason: 'plugin-disposed' }
      const id = String(sessionId || '')
      if (deletionQueue().some((item) => item.sessionId === id)) return { ok: false, reason: 'delete-pending-restart' }
      const operationId = crypto.randomUUID()
      const auditEnabled = !(writesDisabled || store.isReadOnly())
      const pendingPurge = status.read().purgePending
      if (pendingPurge?.sessionId === id && pendingPurge.phase === 'cache-recycled-dsh-pending') {
        return compact({ ok: false, reason: 'purge-partial-recovery-pending' })
      }
      if (auditEnabled) {
        try { audit({ operationId, type: 'restore', sessionId: id, phase: 'native-restore', outcome: 'started' }) }
        catch { return compact({ ok: false, reason: 'operations-write-failed' }) }
      }
      // Native DSH restoration is always first. A missing/bad plugin mapping
      // cannot turn a real archived conversation into an un-restorable one.
      const native = await dsh.restoreSession(id)
      if (!native.ok) {
        if (auditEnabled) audit({ operationId, type: 'restore', sessionId: id, phase: 'native-restore', outcome: 'failed', details: { reason: native.reason || 'native-restore-failed' } })
        return compact(native)
      }
      if (writesDisabled || store.isReadOnly()) return compact({ ok: true, nativeRestored: true, nativeMode: native.mode, cacheBookkeeping: { ok: false, reason: 'persistence-read-only' } })
      reconcileNativeArchives()
      const checked = getValidatedEntry(id)
      if (!checked.ok) { if (auditEnabled) audit({ operationId, type: 'restore', sessionId: id, phase: 'complete', outcome: 'ok', details: { mode: native.mode || '', cacheScope: 'none' } }); return compact({ ok: true, nativeRestored: true, nativeMode: native.mode, cacheBookkeeping: { ok: false, reason: checked.reason } }) }
      const { entry, map } = checked
      if (entry.layoutVersion === 3) {
        if (auditEnabled) audit({ operationId, type: 'restore', sessionId: id, phase: 'complete', outcome: 'ok', details: { mode: native.mode || '', cacheScope: 'none' } })
        return compact({ ok: true, nativeRestored: true, nativeMode: native.mode, cacheBookkeeping: { ok: true, nativeLayout: true } })
      }
      const candidate = structuredClone(entry)
      const nextMap = { ...map, [id]: candidate }
      // `status` remains a legacy cache-operation phase only; it is never
      // consulted to decide whether DSH has archived the conversation.
      if (candidate.status !== 'archived' && candidate.cachePhase !== 'archived') { if (auditEnabled) audit({ operationId, type: 'restore', sessionId: id, phase: 'complete', outcome: 'ok', details: { mode: native.mode || '', cacheScope: 'none' } }); return compact({ ok: true, nativeRestored: true, nativeMode: native.mode, cacheBookkeeping: { ok: false, reason: 'cache-not-archived' } }) }
      candidate.status = 'archived'
      const res = restoreSessionFlow(id, candidate, { fsApi, harnessRoot, config, log, mapping: nextMap })
      if (res.entry) {
        if (res.ok) candidate.cachePhase = 'active'
        try { store.commit(nextMap) }
        catch (e) {
          return compact({ ok: true, nativeRestored: true, nativeMode: native.mode, cacheBookkeeping: { ok: false, reason: 'state-write-failed' } })
        }
      }
      if (auditEnabled) audit({ operationId, type: 'restore', sessionId: id, phase: 'complete', outcome: res.ok ? 'ok' : 'partial', details: { mode: native.mode || '', cacheScope: 'registered', reason: res.reason || '' } })
      return compact({ ok: true, nativeRestored: true, nativeMode: native.mode, cacheBookkeeping: { ok: res.ok, reason: res.reason, restoredTo: res.restoredTo } })
    }
    const finalizePurge = async (sessionId, { retentionAlreadyDone = false } = {}) => {
      if (pluginDisposed) return { ok: false, reason: 'plugin-disposed' }
      if (writesDisabled || store.isReadOnly()) return { ok: false, reason: 'persistence-read-only' }
      const nativeCompatibility = dsh.compatibility()
      if (!nativeCompatibility.stagedDeletionAvailable) return { ok: false, reason: 'native-archive-compatibility-unsupported' }
      const id = String(sessionId || '')
      if (!dsh.listArchivedIds().includes(id)) return { ok: false, reason: 'not-natively-archived' }
      const operationId = crypto.randomUUID()
      try { audit({ operationId, type: 'delete', sessionId: id, phase: 'preflight', outcome: 'started' }) }
      catch { return compact({ ok: false, reason: 'operations-write-failed' }) }
      const prepared = await prepareArchivedCache(id)
      if (!prepared.ok) {
        try { audit({ operationId, type: 'delete', sessionId: id, phase: 'cache-preflight', outcome: 'failed', details: { reason: prepared.reason || 'cache-preflight-failed' } }) } catch { /* already read-only */ }
        return compact({ ok: false, reason: prepared.reason })
      }
      const entry = prepared.entry || null
      const map = prepared.map || store.getMap()
      // Validate the exact independently-owned DSH log before cache mutation.
      const located = await locateDshSessionAny(id, entry, map)
      if (!located.ok) {
        audit({ operationId, type: 'delete', sessionId: id, phase: 'locator', outcome: 'failed', details: { reason: located.reason || 'dsh-session-locator-unavailable' } })
        return compact({ ok: false, reason: located.reason || 'dsh-session-locator-unavailable' })
      }
      const purgeIntent = { sessionId: id, target: prepared.target ? path.resolve(prepared.target) : '', cacheScope: prepared.cacheScope, phase: 'prepared', startedAt: Date.now(), operationId }
      try { status.write({ purgePending: purgeIntent }) }
      catch { return compact({ ok: false, reason: 'state-write-failed' }) }
      audit({ operationId, type: 'delete', sessionId: id, phase: 'prepared', outcome: 'ok', details: { cacheScope: prepared.cacheScope } })
      let res
      if (prepared.cacheScope === 'registered') {
        res = await purgeSessionFlow(id, entry, {
          fsApi, harnessRoot, config: { ...config, purge: { ...config.purge, deleteDshSession: true } }, log, recycle,
          deleteDshSessionOnce: () => deleteDshSessionOnce(id, entry, map),
          retain: retentionAlreadyDone ? async () => ({ ok: true, retained: [] }) : (input) => retainBeforePurge({ ...input, operationId }), mapping: map,
        })
      } else {
        const reviewTarget = nativeRetentionTarget(entry, located.dir)
        const retention = retentionAlreadyDone ? { ok: true, retained: [] } : await retainBeforePurge({
          sessionId: id,
          entry: entry || { kind: 'daily' },
          target: reviewTarget,
          sourceRoots: entry?.layoutVersion === 3 ? [harnessRoot] : [sessionPersistence.root],
          candidateWindow: nativeRetentionWindow(entry),
          operationId,
        })
        if (!retention.ok) res = { ok: false, reason: retention.reason, recycled: [], protectedFiles: [] }
        else {
          const recycled = await deleteDshSessionOnce(id, entry, map)
          res = recycled.ok
            ? { ok: true, recycled: [located.dir], protectedFiles: (retention.retained || []).map((item) => item.path || item) }
            : { ok: false, reason: recycled.reason || recycled.error || 'dsh-recycle-failed', recycled: [], protectedFiles: [] }
        }
      }
      if (!res.ok) {
        audit({ operationId, type: 'delete', sessionId: id, phase: res.partialPhase || 'recycle', outcome: res.partialPhase ? 'partial' : 'failed', details: { reason: res.reason || 'operation-failed', recycledCount: res.recycled?.length || 0, protectedCount: res.protectedFiles?.length || 0 } })
        if (res.partialPhase) {
          try { status.write({ purgePending: { ...purgeIntent, phase: res.partialPhase, recycledAt: Date.now(), reason: res.reason } }) }
          catch { /* the prepared intent remains available for conservative recovery */ }
        } else {
          try { status.write({ purgePending: null }) } catch { /* 保留意图供下次启动检查 */ }
        }
        return compact({ ok: false, recycled: res.recycled, protectedFiles: res.protectedFiles, reason: res.reason, partialPhase: res.partialPhase })
      }
      // The cache/session recycle completed. Only now may the native archive
      // id be cleared; a recycle failure above deliberately leaves it intact.
      try { status.write({ purgePending: { ...purgeIntent, phase: 'dsh-recycled-native-pending', recycledAt: Date.now() } }) }
      catch { return compact({ ok: false, reason: 'state-write-failed', recycled: res.recycled, protectedFiles: res.protectedFiles }) }
      const native = await clearNativeArchivedId(id)
      if (!native.ok) {
        audit({ operationId, type: 'delete', sessionId: id, phase: 'native-clear', outcome: 'partial', details: { reason: native.reason || 'native-delete-failed' } })
        return compact({ ok: false, reason: native.reason || 'native-delete-failed', recycled: res.recycled, protectedFiles: res.protectedFiles })
      }
      try { status.write({ purgePending: { ...purgeIntent, phase: 'native-cleared', recycledAt: Date.now() } }) }
      catch { return compact({ ok: false, reason: 'state-write-failed', recycled: res.recycled, protectedFiles: res.protectedFiles }) }
      if (res.ok) {
        // `purgeSessionFlow` awaits AI retention and recycle operations. A
        // periodic native-archive reconciliation can therefore commit a newer
        // map for a different session before we reach this point. Merge this
        // terminal one-session deletion into that fresh map instead of cloning
        // the preflight snapshot, which would otherwise lose that update. Do
        // not validate or re-use the current id here: the recorded intent has
        // already completed its independently validated recycle, and removal
        // of a poisoned replacement is the safe fail-closed outcome.
        const nextMap = { ...store.getMap() }
        delete nextMap[id]
        try { store.commit(nextMap) } catch { return compact({ ok: false, reason: 'state-write-failed', recycled: res.recycled, protectedFiles: res.protectedFiles }) }
        try { status.write({ purgePending: null }) } catch { /* mapping is already removed; startup will clear stale intent */ }
      }
      audit({ operationId, type: 'delete', sessionId: id, phase: 'complete', outcome: 'ok', details: { cacheScope: prepared.cacheScope, recycledCount: res.recycled?.length || 0, protectedCount: res.protectedFiles?.length || 0 } })
      try { removeFromDeletionQueue(id) } catch { /* completed deletion stays absent; stale queue is harmless */ }
      return compact({ ok: res.ok, recycled: res.recycled, protectedFiles: res.protectedFiles, reason: res.reason })
    }
    const purge = async (sessionId) => {
      if (pluginDisposed) return { ok: false, reason: 'plugin-disposed' }
      if (writesDisabled || store.isReadOnly()) return { ok: false, reason: 'persistence-read-only' }
      if (!dsh.compatibility().stagedDeletionAvailable) return { ok: false, reason: 'native-archive-compatibility-unsupported' }
      const id = String(sessionId || '')
      if (!isSafeSessionId(id) || !dsh.listArchivedIds().includes(id)) return { ok: false, reason: 'not-natively-archived' }
      // Future DSH versions may expose a real destructive operation. Use the
      // existing immediate verified transaction only in that explicit case.
      if (dsh.compatibility().destructiveAvailable) return finalizePurge(id)
      const existing = deletionQueue().find((item) => item.sessionId === id)
      if (existing) return { ok: true, pendingRestart: true, protectedFiles: [], alreadyQueued: true }
      const operationId = crypto.randomUUID()
      let prepared
      try { prepared = await prepareArchivedCache(id) }
      catch { return { ok: false, reason: 'cache-preflight-failed' } }
      if (!prepared.ok) return compact({ ok: false, reason: prepared.reason })
      const located = await locateDshSessionAny(id, prepared.entry || null, prepared.map || store.getMap())
      if (!located.ok) return compact({ ok: false, reason: located.reason })
      const reviewTarget = prepared.cacheScope === 'registered' ? prepared.target : nativeRetentionTarget(prepared.entry, located.dir)
      const retention = await retainBeforePurge({
        sessionId: id,
        entry: prepared.entry || { kind: 'daily' },
        target: reviewTarget,
        sourceRoots: prepared.cacheScope === 'registered' || prepared.entry?.layoutVersion === 3 ? [harnessRoot] : [sessionPersistence.root],
        candidateWindow: nativeRetentionWindow(prepared.entry),
        operationId,
      })
      if (!retention.ok) return compact({ ok: false, reason: retention.reason })
      const item = { sessionId: id, queuedAt: Date.now(), operationId, retentionComplete: true }
      try { saveDeletionQueue([...deletionQueue(), item]) }
      catch { return { ok: false, reason: 'state-write-failed' } }
      audit({ operationId, type: 'delete', sessionId: id, phase: 'queued-for-restart', outcome: 'ok', details: { protectedCount: retention.retained?.length || 0 } })
      return { ok: true, pendingRestart: true, protectedFiles: (retention.retained || []).map((entry) => entry.path || entry), recycled: [] }
    }
    const restoreMany = (ids) => runMany(ids, restore)
    const purgeMany = (ids) => runMany(ids, purge)
    const previewDelete = async (sessionIds) => {
      const items = []
      for (const id of sessionIds) {
        const checked = getValidatedEntry(id)
        let target = ''
        let cacheScope = 'none'
        if (checked.ok) {
          if (checked.entry.layoutVersion === 3) target = nativeRetentionTarget(checked.entry)
          else {
            const active = cacheLayoutFor(checked.entry, { harnessRoot }).base
            target = checked.entry.archivePath && fsApi.existsSync(checked.entry.archivePath) ? checked.entry.archivePath : fsApi.existsSync(active) ? active : ''
            if (target) cacheScope = 'registered'
          }
        }
        if (!target) {
          const located = await locateDshSessionAny(id, checked.ok ? checked.entry : null, checked.ok ? checked.map : store.getMap())
          if (located.ok) target = located.dir
        }
        let candidates = []
        if (target) try { candidates = findRetentionCandidates(target, fsApi, { ...config.retention, ...nativeRetentionWindow(checked.ok ? checked.entry : null) }) } catch { candidates = [] }
        items.push({ id, cacheScope, candidateCount: candidates.length, candidateTypes: [...new Set(candidates.map((item) => item.category))].slice(0, 20) })
      }
      return {
        ok: true,
        selectedCount: items.length,
        registeredCount: items.filter((item) => item.cacheScope === 'registered').length,
        noCacheCount: items.filter((item) => item.cacheScope === 'none').length,
        candidateCount: items.reduce((sum, item) => sum + item.candidateCount, 0),
        candidateTypes: [...new Set(items.flatMap((item) => item.candidateTypes))],
        items,
      }
    }
    const retainedLibraryDeps = () => ({
      retainedRoot: path.join(harnessRoot, config.protectDirName || DEFAULTS.protectDirName),
      indexPath: retainedIndexPath, deleteOperationPath: retainedDeleteOperationPath, harnessRoot, stateRoot, fsApi,
    })
    let retainedSnapshot = []
    const refreshRetainedSnapshot = () => {
      retainedSnapshot = listRetainedFiles(retainedLibraryDeps())
      return retainedSnapshot
    }
    const listRetained = () => retainedSnapshot
    const restoreRetained = (id, targetDir = '', provenanceId = '') => {
      if (writesDisabled || store.isReadOnly()) return { ok: false, reason: 'persistence-read-only' }
      if (!/^[a-f0-9]{64}$/i.test(String(id || ''))) return { ok: false, reason: 'invalid-retained-id' }
      const operationId = crypto.randomUUID()
      try { audit({ operationId, type: 'restore', recordId: id, phase: 'retained-restore', outcome: 'started' }) } catch { return { ok: false, reason: 'operations-write-failed' } }
      const result = restoreRetainedFile(id, { ...retainedLibraryDeps(), targetDir, provenanceId })
      audit({ operationId, type: 'restore', recordId: id, phase: 'retained-restore', outcome: result.ok ? 'ok' : 'failed', details: { reason: result.reason || '', mode: targetDir ? 'alternate' : 'original' } })
      return result
    }
    const removeRetainedSource = (id, provenanceId) => {
      if (writesDisabled || store.isReadOnly()) return { ok: false, reason: 'persistence-read-only' }
      const result = removeRetainedProvenance(id, provenanceId, retainedLibraryDeps())
      if (result.ok) refreshRetainedSnapshot()
      return result
    }
    let retainedRecycleTail = Promise.resolve()
    const recycleRetainedNow = async (id, wholeFile = false) => {
      if (writesDisabled || store.isReadOnly()) return { ok: false, reason: 'persistence-read-only' }
      if (!/^[a-f0-9]{64}$/i.test(String(id || ''))) return { ok: false, reason: 'invalid-retained-id' }
      const operationId = crypto.randomUUID()
      try { audit({ operationId, type: 'retained-recycle', recordId: id, phase: 'recycle', outcome: 'started' }) } catch { return { ok: false, reason: 'operations-write-failed' } }
      const result = await recycleRetainedFile(id, { ...retainedLibraryDeps(), wholeFile, recycle })
      if (result.ok) refreshRetainedSnapshot()
      audit({ operationId, type: 'retained-recycle', recordId: id, phase: 'recycle', outcome: result.ok ? 'ok' : result.partialPhase ? 'partial' : 'failed', details: { reason: result.reason || '', phase: result.partialPhase || '' } })
      return result
    }
    const recycleRetained = (id, wholeFile = false) => {
      const result = retainedRecycleTail.then(() => recycleRetainedNow(id, wholeFile), () => recycleRetainedNow(id, wholeFile))
      retainedRecycleTail = result.catch(() => {})
      return result
    }
    const recoverRetainedDeletion = () => {
      const result = recoverRetainedRecycle(retainedLibraryDeps())
      refreshRetainedSnapshot()
      return result
    }
    const retentionReminderView = () => retentionReminder(listRetained(), {
      lastRetentionReminderAt: status.read().lastRetentionReminderAt || 0,
      config,
    })
    const acknowledgeRetentionReminder = () => {
      if (writesDisabled || store.isReadOnly()) return { ok: false, reason: 'persistence-read-only' }
      try {
        const lastRetentionReminderAt = Date.now()
        status.write({ lastRetentionReminderAt })
        return { ok: true, lastRetentionReminderAt }
      } catch (e) { return { ok: false, reason: e.message || 'retention-reminder-write-failed' } }
    }
    const statusView = ({ reconcile = false } = {}) => {
      const map = reconcile ? reconcileNativeArchives() : store.getMap()
      const validEntries = []
      const invalidEntries = []
      for (const [id, entry] of Object.entries(map)) {
        const valid = validateSessionEntry(id, entry, { harnessRoot, config, mapping: map })
        if (valid.ok) validEntries.push([id, entry])
        else invalidEntries.push({ id: isSafeSessionId(id) ? id : '(invalid)', reason: valid.reason })
      }
      const active = []
      const archivedIdSet = new Set(dsh.listArchivedIds())
      for (const [id, entry] of validEntries) {
        if (archivedIdSet.has(id)) continue
        active.push({
          id,
          kind: entry.kind,
          tag: entry.tag,
          date: entry.date || null,
          projectLabel: entry.kind === 'project' ? (sanitizeName(path.basename(entry.root || '')) || '项目') : '日常对话',
        })
      }
      const queued = new Set(deletionQueue().map((item) => item.sessionId))
      const archived = dsh.listArchivedEntries(map).filter((native) => !queued.has(native.id)).map((native) => {
        const entry = map[native.id]
        const valid = entry && validateSessionEntry(native.id, entry, { harnessRoot, config, mapping: map })
        if (!valid?.ok) return { id: native.id, mappingError: native.mappingError || valid?.reason || (entry ? 'invalid-mapping' : 'mapping-not-found') }
        return {
          id: native.id,
          kind: entry.kind,
          tag: entry.tag,
          date: entry.date || null,
          projectLabel: entry.kind === 'project' ? (sanitizeName(path.basename(entry.root || '')) || '项目') : '日常对话',
          cachePhase: entry.cachePhase || entry.status || 'tracked',
        }
      })
      const st = status.read()
      const retained = listRetained()
      const retentionNotice = retentionReminder(retained, { lastRetentionReminderAt: st.lastRetentionReminderAt || 0, config })
      return {
        remind: retentionNotice.due,
        remindIntervalDays: retentionNotice.intervalDays,
        newProtectedCount: retentionNotice.count,
        retentionReminder: retentionNotice,
        active,
         archived,
        compatibility: dsh.compatibility(),
         invalidEntries,
        retained,
        backupConfigured: !!config.backup?.targetDir,
        backupTargetConfigured: !!config.backup?.targetDir,
        backupEnabled: config.backup?.enabled !== false,
        backupAutoIntervalDays: config.backup?.autoIntervalDays || 0,
        backupKeepCount: config.backup?.keepCount || 5,
        backupSchedule: { ...backupScheduleView(backupDeps()), lastResult: st.lastBackupResult || null },
        backups: backupSnapshot,
        pendingDeletionCount: queued.size,
        updateCheck: updateSnapshot,
        writesDisabled: writesDisabled || store.isReadOnly(),
         persistenceErrors,
      }
    }
    let backupBusy = false
    let backupSnapshot = []
    const backupDeps = () => ({
      fsApi, harnessRoot, stateRoot, retainedRoot: path.join(harnessRoot, config.protectDirName || DEFAULTS.protectDirName),
      retainedIndexPath, backupStatePath, mapping: store.getMap(), config, recycle, log,
      sessionPersistenceRoot: sessionPersistence?.root,
      locateSessionDir: (id, entry) => locateDshSession(id, entry),
    })
    const backup = async (selection = { type: 'all' }) => {
      if (pluginDisposed) return { ok: false, reason: 'plugin-disposed' }
      if (writesDisabled || store.isReadOnly()) return { ok: false, reason: 'persistence-read-only' }
      if (backupBusy) return { ok: false, reason: 'backup-in-progress' }
      backupBusy = true
      const operationId = crypto.randomUUID()
      try {
        audit({ operationId, type: 'backup', phase: 'create', outcome: 'started', details: { scope: selection.type || 'all' } })
        const result = await createBackup(selection, backupDeps())
        if (result.ok) backupSnapshot = listBackups(backupDeps())
        try { status.write({ lastBackupResult: { ok: result.ok === true, at: new Date().toISOString(), reason: result.reason || '' } }) } catch { /* backup result remains in audit log */ }
        audit({ operationId, type: 'backup', phase: 'create', outcome: result.ok ? 'ok' : 'failed', details: { scope: selection.type || 'all', fileCount: result.fileCount || 0, reason: result.reason || '' } })
        return result
      }
      finally { backupBusy = false }
    }
    const backupRestore = (id, targetDir) => {
      if (pluginDisposed) return { ok: false, reason: 'plugin-disposed' }
      if (writesDisabled || store.isReadOnly()) return { ok: false, reason: 'persistence-read-only' }
      const operationId = crypto.randomUUID()
      try { audit({ operationId, type: 'restore', phase: 'backup-restore', outcome: 'started' }) } catch { return { ok: false, reason: 'operations-write-failed' } }
      const result = restoreBackup(id, targetDir, backupDeps())
      audit({ operationId, type: 'restore', phase: 'backup-restore', outcome: result.ok ? 'ok' : 'failed', details: { reason: result.reason || '', fileCount: result.fileCount || 0 } })
      return result
    }

    // ── agent 作用域实例：复用根服务，不重复注册管理入口 ──
    if (cfg.role === 'agent') {
      status.write({ agentBootOk: true })
      return
    }

    // ══════════ 根引擎 ══════════

    // ── 1) 会话创建 → 只登记 DSH 原生元数据，不创建镜像缓存 ──
    ctx.on('session/created', (session) => {
      try {
        if (writesDisabled || store.isReadOnly()) return
        store.getMap()
        if (writesDisabled || store.isReadOnly()) return
        const header = session.header || {}
        const cls = classifyWorkspace(header.cwd, { harnessRoot })
        if (cls.kind === 'outside') return
        if (path.resolve(header.cwd) !== harnessRoot) assertPhysicalPathInside(header.cwd, [harnessRoot], fsApi)
        if (cls.kind === 'project') assertPhysicalPathInside(cls.root, [harnessRoot], fsApi)
        const id = String(header.id)
        if (!isSafeSessionId(id)) return
        const created = new Date(header.createdAt ?? Date.now())
        const entry = {
          id,
          cwd: header.cwd,
          createdAt: header.createdAt ?? created.getTime(),
          kind: cls.kind,
          root: cls.root || undefined,
          date: cls.kind === 'daily' ? dateStr(created) : undefined,
          tag: placeholderTag(id),
          layoutVersion: 3,
          status: 'active',
        }
        const valid = validateSessionEntry(id, entry, { harnessRoot, config, mapping: { [id]: entry } })
        if (!valid.ok) throw new Error(valid.reason)
        store.upsert(id, entry)
        log(`会话 ${id} 已登记 DSH 原生工作区 (${cls.kind})`)
      } catch (e) {
        ctx.logger?.warn('[conversation-archive] session/created 处理失败:', e?.message)
      }
    })

    // ── 2) 会话事件 → 仅更新展示标签；DSH 自己持久化对话记录 ──
    ctx.on('session/event', (session, event) => {
      try {
        if (writesDisabled || store.isReadOnly()) return
        const id = String(session?.header?.id ?? session?.id ?? '')
        if (!isSafeSessionId(id)) return
        // A native UI restore does not invoke this plugin. Reconcile against
        // DSH immediately so stale cache bookkeeping can never suppress a
        // newly active conversation's recording.
        const entry = reconcileNativeArchives()[id]
        if (!entry || dsh.listArchivedIds().includes(id)) return
        if (event?.type === 'session/title' && event.data?.title) {
          const candidate = sanitizeName(event.data.title) || placeholderTag(id)
          const newTag = candidate
          if (newTag && newTag !== entry.tag) {
            entry.tag = newTag
            store.upsert(id, entry)
            log(`会话 ${id} 标签 → ${newTag}`)
          }
        }
      } catch (e) {
        ctx.logger?.warn('[conversation-archive] session/event 处理失败:', e?.message)
      }
    })

    // DSH 原生持久化负责会话内容；插件不监听 disposed 复制或重排文件。

    // ── 4) 服务面 ──
    ctx.provide('conversationArchive', {
      restoreSession: restore,
      purgeSession: purge,
      restoreMany,
      purgeMany,
      retainedFiles: listRetained,
      restoreRetainedFile: restoreRetained,
      removeRetainedProvenance: removeRetainedSource,
      recycleRetainedFile: recycleRetained,
      recoverRetainedDeletion,
      retentionReminder: retentionReminderView,
      acknowledgeRetentionReminder,
      backup,
      backupRestore,
      backups: () => backupSnapshot,
      status: () => statusView({ reconcile: true }),
      // Host-side lifecycle callers may request the same safe reconciliation
      // as the periodic timer. It is intentionally not an HTTP action.
      syncArchivedCaches: () => reconcileArchivedCaches(),
      flush: () => store.flush(),
      getConfig: () => safeConfigView(config),
    })

    // Complete all authorized legacy migrations and reconcile plugin cache
    // phases before routes are visible. GET handlers below are snapshots only.
    if (!writesDisabled && !store.isReadOnly()) {
      try {
        store.getMap()
        reconcileNativeArchives()
        refreshRetainedSnapshot()
        backupSnapshot = listBackups(backupDeps())
      } catch (e) {
        disableWrites('bootstrap', e?.code || 'bootstrap-state-failed')
      }
    }

    // ── 5.5) HTTP API（客户端 UI 同源调用；webServer 为 host-plane 服务）──
    try {
      const webServer = ctx.get('webServer')
      if (webServer?.register) {
        const csrfToken = crypto.randomBytes(32).toString('base64url')
        let apiDisposed = false
        const send = (res, code, body) => {
          if (apiDisposed || pluginDisposed) return
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify(toJsonSafe(body)))
        }
        const fail = (res, error) => send(res, error.status || 500, {
          ok: false, error: compact({ code: error.code || 'internal-error', message: error.message || 'internal server error', details: error.details }),
        })
        const csrfValid = (req) => {
          const supplied = String(req?.headers?.['x-conversation-archive-csrf'] || req?.headers?.['X-Conversation-Archive-Csrf'] || '')
          const expected = Buffer.from(csrfToken)
          const actual = Buffer.from(supplied)
          return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
        }
        const id = (value, field = 'id') => {
          if (!isSafeSessionId(value)) throw apiError(400, 'invalid-request', `${field} is invalid`)
          return String(value)
        }
        const retainedId = (value, field = 'id') => {
          if (!/^[a-f0-9]{64}$/i.test(String(value || ''))) throw apiError(400, 'invalid-request', `${field} is invalid`)
          return String(value).toLowerCase()
        }
        const ids = (value) => {
          if (!Array.isArray(value) || value.length === 0 || value.length > API_MAX_BATCH_IDS) throw apiError(400, 'invalid-request', `ids must contain 1-${API_MAX_BATCH_IDS} ids`)
          const out = []
          for (const item of value) { const valid = id(item, 'ids'); if (!out.includes(valid)) out.push(valid) }
          return out
        }
        const archivedId = (value) => {
          const sessionId = id(value)
          if (!dsh.listArchivedIds().includes(sessionId)) throw apiError(409, 'not-natively-archived', 'session is not currently archived')
          return sessionId
        }
        const safeStatus = () => {
          const view = statusView()
          const settings = safeConfigView(config)
          const target = String(settings.backup.targetDir || '').replace(/[\\/]+$/, '')
          const targetLabel = target ? (sanitizeName(path.win32.basename(target) || path.basename(target)) || '已配置') : ''
          return {
            csrfToken,
            archivedCount: view.archived.length,
            retainedCount: view.retained.length,
            backupCount: view.backups.length,
            managed: view.active,
            pendingDeletionCount: view.pendingDeletionCount,
            backupConfigured: !!settings.backup.targetDir,
            backupEnabled: settings.backup.enabled,
            reminder: { due: view.retentionReminder.due, count: view.retentionReminder.count, intervalDays: view.retentionReminder.intervalDays },
            settings: {
              harnessRoot: settings.harnessRoot,
              remindIntervalDays: settings.remind.intervalDays,
              backup: { configured: !!settings.backup.targetDir, targetLabel, enabled: settings.backup.enabled, mode: settings.backup.mode, autoIntervalDays: settings.backup.autoIntervalDays, keepCount: settings.backup.keepCount, nextBackupAt: view.backupSchedule.nextBackupAt, lastResult: view.backupSchedule.lastResult },
              retention: { enabled: settings.retention.enabled, maxCandidates: settings.retention.maxCandidates, maxCandidateBytes: settings.retention.maxCandidateBytes, maxExcerptChars: settings.retention.maxExcerptChars, timeoutMs: settings.retention.timeoutMs },
              updateCheck: { enabled: settings.updateCheck.enabled },
            },
            updateCheck: updateSnapshot,
            writesDisabled: view.writesDisabled,
            compatibility: view.compatibility,
          }
        }
        const diagnostics = () => {
          const view = statusView()
          const pending = status.read().purgePending
          let operations = { records: [], malformedCount: 0 }
          try { operations = inspectOperationsLog(operationsPath, { stateRoot, fsApi, limit: 50 }) } catch { operations = { records: [], malformedCount: 1 } }
          return {
            pluginVersion: PLUGIN_VERSION, dshVersion: view.compatibility.dshVersion, windowsSupported: process.platform === 'win32', updateCheck: updateSnapshot,
            adapter: view.compatibility, writesDisabled: view.writesDisabled,
            state: { archivedCount: view.archived.length, retainedCount: view.retained.length, backupCount: view.backups.length, invalidEntryCount: view.invalidEntries.length, purgePhase: typeof pending?.phase === 'string' ? pending.phase : '' },
            persistenceErrors: view.persistenceErrors.map((item) => ({ store: item.store, code: item.code })),
            operations,
          }
        }
        const safeReason = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value) ? value : 'operation-failed'
        const safeOptionalReason = (value) => value === undefined || value === '' ? undefined : safeReason(value)
        const safeMutationResult = (action, result) => {
          const value = result && typeof result === 'object' ? result : { ok: false, reason: 'operation-failed' }
          if (action === 'restore') return compact({ ok: value.ok, reason: safeOptionalReason(value.reason), nativeRestored: value.nativeRestored, nativeMode: value.nativeMode, cacheBookkeeping: value.cacheBookkeeping ? compact({ ok: value.cacheBookkeeping.ok, reason: safeOptionalReason(value.cacheBookkeeping.reason) }) : undefined })
          if (action === 'delete') return compact({ ok: value.ok, reason: safeOptionalReason(value.reason), partialPhase: safeOptionalReason(value.partialPhase), pendingRestart: value.pendingRestart === true, protectedCount: Array.isArray(value.protectedFiles) ? value.protectedFiles.length : 0, recycledCount: Array.isArray(value.recycled) ? value.recycled.length : 0 })
          if (action === 'deletePreview') return compact({ ok: value.ok, selectedCount: value.selectedCount, registeredCount: value.registeredCount, noCacheCount: value.noCacheCount, candidateCount: value.candidateCount, candidateTypes: Array.isArray(value.candidateTypes) ? value.candidateTypes.filter((item) => typeof item === 'string' && item.length <= 20).slice(0, 20) : [], items: value.items })
          if (action === 'retainedRestore') return compact({ ok: value.ok, id: value.id, reason: safeOptionalReason(value.reason) })
          if (action === 'retainedDelete') return compact({ ok: value.ok, id: value.id, reason: safeOptionalReason(value.reason), remainingSources: value.remainingSources, partialPhase: safeOptionalReason(value.partialPhase) })
          if (action === 'retentionReminderSeen') return compact({ ok: value.ok, lastRetentionReminderAt: value.lastRetentionReminderAt, reason: safeOptionalReason(value.reason) })
          if (action === 'backup') return compact({ ok: value.ok, id: value.id, createdAt: value.createdAt, completedAt: value.completedAt, reason: safeOptionalReason(value.reason), retentionErrors: Array.isArray(value.retentionErrors) ? value.retentionErrors.filter((item) => /^backup-[A-Za-z0-9-]{8,80}$/i.test(item)) : undefined })
          if (action === 'backupRestore') return compact({ ok: value.ok, id: value.id, reason: safeOptionalReason(value.reason), fileCount: value.fileCount })
          if (action === 'saveConfig') return compact({ ok: value.ok, config: value.config, reason: safeOptionalReason(value.reason) })
          return compact({ ok: value.ok, reason: safeOptionalReason(value.reason) })
        }
        const batch = async (action, one, values) => (await runMany(values, one)).map((item) => ({
          id: item.id,
          ok: item.ok,
          result: item.result ? safeMutationResult(action, item.result) : { ok: false, reason: 'operation-failed' },
        }))
        const dispatcher = async (req, res) => {
          if (apiDisposed || pluginDisposed || req?.aborted) return
          try {
            const url = new URL(req.url || '/', 'http://localhost')
            const action = url.searchParams.get('action') || 'status'
            const read = {
              status: safeStatus,
              archived: () => statusView().archived,
              retained: listRetained,
              backups: () => backupSnapshot,
              diagnostics,
            }
            const mutations = new Set(['restore', 'delete', 'restoreMany', 'deleteMany', 'deletePreview', 'retainedRestore', 'retainedDelete', 'retentionReminderSeen', 'backup', 'backupRestore', 'saveConfig'])
            if (req.method === 'GET') {
              if (mutations.has(action)) throw apiError(405, 'method-not-allowed', 'mutation requires POST')
              if (!read[action]) throw apiError(404, 'unknown-action', 'unknown action')
              return send(res, 200, { ok: true, result: read[action]() })
            }
            if (req.method !== 'POST') throw apiError(405, 'method-not-allowed', 'use GET or POST')
            if (!mutations.has(action)) throw apiError(404, 'unknown-action', 'unknown action')
            if (!csrfValid(req)) throw apiError(403, 'csrf-invalid', 'CSRF token is missing or invalid')
            const body = await apiJsonBody(req)
            if (apiDisposed || pluginDisposed || req?.aborted) return
            let result
            switch (action) {
              case 'restore': { const value = apiObject(body, ['id']); result = await restore(archivedId(value.id)); break }
              case 'delete': { const value = apiObject(body, ['id']); result = await purge(archivedId(value.id)); break }
              case 'restoreMany': { const value = apiObject(body, ['ids']); result = await batch('restore', restore, ids(value.ids)); break }
              case 'deleteMany': { const value = apiObject(body, ['ids']); result = await batch('delete', purge, ids(value.ids)); break }
              case 'deletePreview': { const value = apiObject(body, ['ids']); result = await previewDelete(ids(value.ids)); break }
              case 'retainedRestore': {
                const value = apiObject(body, ['id', 'targetDir', 'provenanceId'])
                if (value.targetDir !== undefined && (typeof value.targetDir !== 'string' || !value.targetDir)) throw apiError(400, 'invalid-request', 'targetDir is invalid')
                if (value.provenanceId !== undefined && !/^[a-f0-9]{64}$/i.test(String(value.provenanceId))) throw apiError(400, 'invalid-request', 'provenanceId is invalid')
                result = restoreRetained(retainedId(value.id), value.targetDir || '', String(value.provenanceId || '').toLowerCase())
                break
              }
              case 'retainedDelete': {
                const value = apiObject(body, ['id', 'provenanceId', 'wholeFile'])
                const recordId = retainedId(value.id)
                if (value.wholeFile === true) result = await recycleRetained(recordId, true)
                else {
                  if (!/^[a-f0-9]{64}$/i.test(String(value.provenanceId || ''))) throw apiError(400, 'invalid-request', 'provenanceId is invalid')
                  result = removeRetainedSource(recordId, String(value.provenanceId).toLowerCase())
                }
                break
              }
              case 'retentionReminderSeen': apiObject(body, []); result = acknowledgeRetentionReminder(); break
              case 'backup': {
                const value = apiObject(body, ['selection'])
                const selection = value.selection === undefined ? { type: 'all' } : apiObject(value.selection, ['type', 'ids'], 'selection')
                if (!['all', 'session', 'project', 'retained'].includes(selection.type || 'all')) throw apiError(400, 'invalid-request', 'backup selection type is invalid')
                if (selection.ids !== undefined) selection.ids = selection.type === 'retained' ? (() => {
                  if (!Array.isArray(selection.ids) || !selection.ids.length || selection.ids.length > API_MAX_BATCH_IDS) throw apiError(400, 'invalid-request', 'backup ids are invalid')
                  return [...new Set(selection.ids.map((item) => retainedId(item, 'selection.ids')))]
                })() : ids(selection.ids)
                result = await backup(selection)
                break
              }
              case 'backupRestore': {
                const value = apiObject(body, ['id', 'targetDir'])
                if (!/^backup-[A-Za-z0-9-]{8,80}$/i.test(String(value.id || '')) || typeof value.targetDir !== 'string' || !value.targetDir) throw apiError(400, 'invalid-request', 'backup restore fields are invalid')
                result = await backupRestore(value.id, value.targetDir)
                break
              }
              case 'saveConfig': result = saveConfigFile(apiObject(body, ['backup', 'remind', 'retention', 'updateCheck'])); break
            }
            return send(res, 200, { ok: true, result: Array.isArray(result) ? result : safeMutationResult(action, result) })
          } catch (error) {
            return fail(res, error instanceof ApiError ? error : apiError(500, 'internal-error', 'internal server error'))
          }
        }
        ctx.effect(() => {
          const dispose = webServer.register({ kind: 'exact', path: '/conversation-archive-api', handler: dispatcher })
          return () => { apiDisposed = true; dispose?.() }
        })
        status.write({ apiRoute: true })
        log('[conversation-archive] HTTP API 已注册: /conversation-archive-api')
      } else {
        status.write({ apiRouteSkip: true })
      }
    } catch (e) {
      status.write({ apiRouteError: String(e?.message || e) })
      ctx.logger?.warn('[conversation-archive] HTTP API 注册失败:', e?.message)
    }

    // ── 5.6) 配置保存（HTTP API 共用）──
    // Persisted due time is authoritative. The short timer only checks it and
    // therefore survives restart without inventing a second schedule.
    let backupTimer = null
    let archiveTimer = null
    const runBackupDue = async () => {
      if (pluginDisposed || backupBusy || writesDisabled || store.isReadOnly()) return
      backupBusy = true
      try {
        const due = await runOverdueBackup(new Date(), backupDeps())
        if (due.ran && due.ok) backupSnapshot = listBackups(backupDeps())
        if (due.ran && !due.ok) log(`[自动备份失败] ${due.result?.reason || 'backup-failed'}`)
        if (due.ran) try { status.write({ lastBackupResult: { ok: due.ok === true, at: new Date().toISOString(), reason: due.result?.reason || due.reason || '' } }) } catch { /* diagnostics only */ }
      } finally { backupBusy = false }
    }
    const armBackupTimer = () => {
      if (backupTimer) { clearInterval(backupTimer); backupTimer = null }
      const days = Number(config.backup?.autoIntervalDays) || 0
      if (config.backup?.enabled !== false && (config.backup?.mode || 'periodic') === 'periodic' && days > 0 && config.backup?.targetDir) {
        void runBackupDue()
        backupTimer = setInterval(() => { void runBackupDue() }, 60 * 1000)
        log(`[自动备份] 已启用，每 ${days} 天到期；每分钟检查一次持久化截止时间`)
      }
    }
    const saveConfigFile = (body) => {
      if (pluginDisposed) return { ok: false, reason: 'plugin-disposed' }
      const whole = apiObject(body, ['backup', 'remind', 'retention', 'updateCheck'])
      const next = {}
      const integer = (value, field, min, max) => {
        if (!Number.isInteger(value) || value < min || value > max) throw apiError(400, 'invalid-request', `${field} is invalid`)
        return value
      }
      if (whole.backup !== undefined) {
        const value = apiObject(whole.backup, ['targetDir', 'enabled', 'mode', 'autoIntervalDays', 'keepCount'], 'backup')
        const item = {}
        if (value.targetDir !== undefined) {
          if (typeof value.targetDir !== 'string' || (value.targetDir && (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value.targetDir) || !(path.isAbsolute(value.targetDir) || path.win32.isAbsolute(value.targetDir))))) throw apiError(400, 'invalid-request', 'backup.targetDir is invalid')
          item.targetDir = value.targetDir
        }
        if (value.enabled !== undefined) { if (typeof value.enabled !== 'boolean') throw apiError(400, 'invalid-request', 'backup.enabled is invalid'); item.enabled = value.enabled }
        if (value.mode !== undefined) { if (!['off', 'periodic', 'shutdown'].includes(value.mode)) throw apiError(400, 'invalid-request', 'backup.mode is invalid'); item.mode = value.mode }
        if (value.autoIntervalDays !== undefined) item.autoIntervalDays = integer(value.autoIntervalDays, 'backup.autoIntervalDays', 0, 365)
        if (value.keepCount !== undefined) item.keepCount = integer(value.keepCount, 'backup.keepCount', 1, 100)
        next.backup = item
      }
      if (whole.remind !== undefined) {
        const value = apiObject(whole.remind, ['intervalDays'], 'remind')
        next.remind = { intervalDays: integer(value.intervalDays, 'remind.intervalDays', 1, 365) }
      }
      if (whole.retention !== undefined) {
        const value = apiObject(whole.retention, ['enabled', 'maxCandidates', 'maxCandidateBytes', 'maxExcerptChars', 'timeoutMs'], 'retention')
        const item = {}
        if (value.enabled !== undefined) { if (typeof value.enabled !== 'boolean') throw apiError(400, 'invalid-request', 'retention.enabled is invalid'); item.enabled = value.enabled }
        if (value.maxCandidates !== undefined) item.maxCandidates = integer(value.maxCandidates, 'retention.maxCandidates', 1, 100)
        if (value.maxCandidateBytes !== undefined) item.maxCandidateBytes = integer(value.maxCandidateBytes, 'retention.maxCandidateBytes', 1, 64 * 1024 * 1024)
        if (value.maxExcerptChars !== undefined) item.maxExcerptChars = integer(value.maxExcerptChars, 'retention.maxExcerptChars', 100, 10_000)
        if (value.timeoutMs !== undefined) item.timeoutMs = integer(value.timeoutMs, 'retention.timeoutMs', 1_000, 120_000)
        next.retention = item
      }
      if (whole.updateCheck !== undefined) {
        const value = apiObject(whole.updateCheck, ['enabled'], 'updateCheck')
        if (typeof value.enabled !== 'boolean') throw apiError(400, 'invalid-request', 'updateCheck.enabled is invalid')
        next.updateCheck = { enabled: value.enabled }
      }
      if (Object.keys(next).length === 0) throw apiError(400, 'invalid-request', 'no fields to save')
      if (writesDisabled || store.isReadOnly()) return { ok: false, reason: 'persistence-read-only' }
      try {
        loadVersionedJson(configPath, { schemaVersion: 1 }, (value) => ({ schemaVersion: 1, ...value }), fsApi)
        const merged = effectiveConfigSections(config)
        for (const key of Object.keys(next)) merged[key] = { ...merged[key], ...next[key] }
        atomicWriteJson(configPath, { schemaVersion: 1, ...merged }, fsApi)
        config = loadConfig(fsApi, cfg, configPath) // 重载生效
        if (next.backup) resetBackupSchedule(new Date(), backupDeps())
        void runUpdateCheck()
        armBackupTimer() // 备份配置变化后重设定时器
        backupSnapshot = listBackups(backupDeps())
        log('[配置] 已保存 config.json')
        return { ok: true, config: safeConfigView(config) }
      } catch (e) {
        if (e instanceof ApiError) throw e
        return { ok: false, reason: e.message }
      }
    }
    const reconcileArchivedCaches = async () => {
      if (pluginDisposed || writesDisabled || store.isReadOnly()) return
      for (const id of dsh.listArchivedIds()) {
        const result = await prepareArchivedCache(id)
        if (!result.ok && !['no-entry', 'archive-source-not-found'].includes(result.reason)) log(`[原生归档缓存同步] ${id}: ${result.reason}`)
      }
    }

    // ── 6) 启动：孤儿映射 GC + 每日提醒记账 + 成功标记 ──
    ;(async () => {
      try {
        await runUpdateCheck()
        const liveIds = new Set(ctx.sessions.list().map((s) => String(s.id)))
        let persistedIds = new Set()
        try {
          if (sessionPersistence?.listSnapshots) {
            const snaps = await sessionPersistence.listSnapshots()
            persistedIds = new Set(snaps.map((s) => String(s.header.id)))
          }
        } catch { /* 忽略 */ }
        const map = store.getMap()
        const removed = orphanGC(map, { liveIds, persistedIds, fsApi, log })
        if (removed.length > 0) store.flush()

        if (!writesDisabled && !store.isReadOnly()) {
          const retainedRecovery = recoverRetainedDeletion()
          if (!retainedRecovery.ok) log(`[保留文件恢复] ${retainedRecovery.reason}`)
          for (const pending of deletionQueue()) {
            if (!dsh.listArchivedIds().includes(pending.sessionId)) {
              removeFromDeletionQueue(pending.sessionId)
              try { audit({ operationId: pending.operationId || crypto.randomUUID(), type: 'delete', sessionId: pending.sessionId, phase: 'queue-cancelled-native-restore', outcome: 'skipped' }) } catch { /* queue cancellation is already durable */ }
              continue
            }
            if (liveIds.has(pending.sessionId)) {
              log(`[删除队列] ${pending.sessionId} 仍为活动会话，保留到下次启动`)
              continue
            }
            const finalized = await finalizePurge(pending.sessionId, { retentionAlreadyDone: pending.retentionComplete === true })
            if (!finalized.ok) log(`[删除队列] ${pending.sessionId}: ${finalized.reason || 'finalize-failed'}`)
          }
        }
        const notice = retentionReminderView()
        if (notice.due) {
          log(notice.text)
        }
        armBackupTimer()
        await reconcileArchivedCaches()
        archiveTimer = setInterval(() => { void reconcileArchivedCaches() }, 1_000)
      } catch (e) {
        ctx.logger?.warn('[conversation-archive] 启动任务失败:', e?.message)
      } finally {
        if (!pluginDisposed) status.write({ bootOk: true })
      }
    })()

    ctx.effect(() => async () => {
      if (backupTimer) clearInterval(backupTimer)
      if (archiveTimer) clearInterval(archiveTimer)
      if (!writesDisabled && !store.isReadOnly() && config.backup?.targetDir && config.backup?.mode === 'shutdown') {
        try { await backup({ type: 'all' }) } catch (error) { log(`[退出前备份失败] ${error?.message || error}`) }
      }
      pluginDisposed = true
      store.dispose()
    })
    log(`已启动（role=root, v${PLUGIN_VERSION}, state=${statePath}, config=${configPath}）`)
  },
}
