/**
 * dsh-conversation-archive · 纯逻辑核心 v3（不依赖 Cordis，便于单元测试）
 * 需求 v3：归档=软归档（完整保留、可恢复、可彻底删除进回收站）；取消归档/彻底删除/批处理；
 * 备份/同步可选（开关+目标目录用户配置）；配置化分类/捕获/策略；修复已知 bug。
 */
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'

/** 默认根常量与配置（可用 patch config / config.json 覆盖） */
export const DEFAULTS = {
  // Keep the default portable; DSH installations may override this through
  // config or DCA_HARNESS_ROOT/DSH_HARNESS_ROOT when the workspace lives
  // elsewhere (for example on a network volume).
  harnessRoot: process.env.DCA_HARNESS_ROOT || process.env.DSH_HARNESS_ROOT || path.join(os.homedir(), 'Documents', 'DeepSeek Harness'),
  dailyDirName: 'daily_conversation',
  archiveDirName: '对话归档',
  cacheDirName: '.cache',
  stateSubDir: 'conversation-archive',
  protectDirName: '重要文件保护', // 彻底删除前的重要文件保护区（防误删）
  capture: { enabled: true, maxDepth: 4, maxSize: 10 * 1024 * 1024, margin: 5 * 60 * 1000, dedup: true },
  archive: { moveDshSession: true, deleteDshSession: false }, // 联动：归档默认移出 DSH 会话（左侧消失）；删会话默认关
  purge: { deleteDshSession: true },    // 彻底删除：默认连 DSH 会话一并删除
  backup: { enabled: false, mode: 'off', targetDir: '', autoIntervalDays: 0, keepCount: 5 }, // periodic / shutdown / off
  remind: { intervalDays: 1 },          // 提醒频率（天），可自由设置（如 1/2/3…）
  retention: { enabled: true, maxCandidates: 40, maxCandidateBytes: 8 * 1024 * 1024, maxExcerptChars: 3000, timeoutMs: 20000 },
  updateCheck: { enabled: true },       // Task 10 only checks/presents release updates; no silent update.
  debugMarkers: false,                  // 是否写诊断标记文件（默认关）
}

/** 分类目录（Codex 式多类别；顺序仅展示用） */
export const CATEGORY_DIRS = ['会话记录', '文档', '表格', '演示', '代码', '脚本', '配置', '数据', '图片', '音视频', '压缩包', '日志', '其他']

/** 配置中的分类目录只能是单级、无路径语义的目录名。 */
export function isSafeCategoryDir(value) {
  return typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' &&
    !path.isAbsolute(value) && !/[\\/\u0000]/.test(value) && sanitizeName(value) === value
}

export function isSafeCategoryExtension(value) {
  return typeof value === 'string' && !['__proto__', 'prototype', 'constructor'].includes(value.toLowerCase()) &&
    /^\.[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(value)
}

/** 丢弃会改变写入根目录的分类覆盖，保留合法的自定义单级目录名。 */
export function normalizeCategories(categories) {
  const safe = {}
  if (!categories || typeof categories !== 'object' || Array.isArray(categories)) return safe
  for (const [ext, dir] of Object.entries(categories)) {
    if (isSafeCategoryExtension(ext) && isSafeCategoryDir(dir)) safe[ext.toLowerCase()] = dir
  }
  return safe
}

/** 默认扩展名→分类表（config.categories 可覆盖/追加） */
const DEFAULT_EXT_CATEGORY = {
  // 文档
  '.docx': '文档', '.doc': '文档', '.pdf': '文档', '.md': '文档', '.txt': '文档', '.rtf': '文档', '.odt': '文档',
  // 表格
  '.xlsx': '表格', '.xls': '表格', '.csv': '表格', '.ods': '表格',
  // 演示
  '.pptx': '演示', '.ppt': '演示', '.odp': '演示',
  // 代码
  '.py': '代码', '.js': '代码', '.ts': '代码', '.tsx': '代码', '.jsx': '代码', '.java': '代码',
  '.c': '代码', '.cpp': '代码', '.h': '代码', '.hpp': '代码', '.go': '代码', '.rs': '代码',
  '.php': '代码', '.rb': '代码', '.sql': '代码', '.html': '代码', '.css': '代码', '.vue': '代码',
  // 脚本
  '.sh': '脚本', '.ps1': '脚本', '.bat': '脚本', '.cmd': '脚本', '.mjs': '脚本', '.cjs': '脚本',
  // 配置
  '.json': '配置', '.yaml': '配置', '.yml': '配置', '.toml': '配置', '.ini': '配置',
  '.env': '配置', '.xml': '配置', '.conf': '配置', '.cfg': '配置',
  // 数据
  '.db': '数据', '.sqlite': '数据', '.sqlite3': '数据', '.parquet': '数据', '.npz': '数据', '.h5': '数据',
  // 图片
  '.png': '图片', '.jpg': '图片', '.jpeg': '图片', '.webp': '图片', '.gif': '图片',
  '.svg': '图片', '.bmp': '图片', '.ico': '图片',
  // 音视频
  '.mp3': '音视频', '.wav': '音视频', '.flac': '音视频', '.ogg': '音视频',
  '.mp4': '音视频', '.mov': '音视频', '.mkv': '音视频', '.webm': '音视频',
  // 压缩包
  '.zip': '压缩包', '.7z': '压缩包', '.rar': '压缩包', '.tar': '压缩包', '.gz': '压缩包', '.bz2': '压缩包', '.xz': '压缩包',
  // 日志
  '.log': '日志', '.out': '日志', '.err': '日志',
}

/** 默认重要文件扩展名白名单（= 全部有分类的扩展名；config.importantExts 可覆盖） */
export function defaultImportantExts() {
  return Object.keys(DEFAULT_EXT_CATEGORY)
}

/**
 * DSH 工具输出要求 lossless JSON：递归剔除值为 undefined 的字段
 * （对象中任何属性为 undefined 即整值拒绝；数组元素 undefined 降级为 null）。
 */
export function toJsonSafe(v) {
  if (v === undefined) return null
  if (Array.isArray(v)) return v.map(toJsonSafe)
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) if (val !== undefined) out[k] = toJsonSafe(val)
    return out
  }
  return v
}

export class VersionedStateError extends Error {
  constructor(code) {
    super(code)
    this.name = 'VersionedStateError'
    this.code = code
  }
}

export function isPathInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)
}

export function assertManagedPath(target, roots) {
  if (!roots.find((root) => isPathInside(root, target))) throw new Error('path-outside-managed-roots')
  return path.resolve(target)
}

function physicalPath(candidate, fsApi) {
  const resolved = path.resolve(candidate)
  let existing = resolved
  while (!fsApi.existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) break
    existing = parent
  }
  const real = fsApi.existsSync(existing) ? fsApi.realpathSync(existing) : existing
  return path.resolve(real, path.relative(existing, resolved))
}

/** Reject symlink/junction/reparse escapes in addition to lexical traversal. */
export function assertPhysicalPathInside(target, roots, fsApi) {
  const resolved = assertManagedPath(target, roots)
  const physicalTarget = physicalPath(resolved, fsApi)
  for (const root of roots) {
    if (isPathInside(root, resolved) && isPathInside(physicalPath(root, fsApi), physicalTarget)) return resolved
  }
  throw new Error('path-reparse-escape')
}

export function atomicWriteJson(file, value, fsApi) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fsApi.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
    fsApi.renameSync(temp, file)
  } catch (e) {
    try { fsApi.unlinkSync?.(temp) } catch { /* best effort */ }
    throw e
  }
}

const OPERATION_TYPES = new Set(['restore', 'delete', 'retention', 'backup', 'retained-recycle'])
const OPERATION_OUTCOMES = new Set(['started', 'ok', 'failed', 'partial', 'skipped'])

function safeAuditDetails(details) {
  const out = {}
  if (!details || typeof details !== 'object' || Array.isArray(details)) return out
  for (const [key, raw] of Object.entries(details)) {
    if (!/^(?:reason|mode|scope|count|candidateCount|protectedCount|recycledCount|fileCount|phase|cacheScope)$/.test(key)) continue
    if (typeof raw === 'boolean' || Number.isFinite(raw)) out[key] = raw
    else if (typeof raw === 'string' && raw.length <= 120 && !path.isAbsolute(raw) && !path.win32.isAbsolute(raw) && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) out[key] = raw
  }
  return out
}

function validOperationRecord(value) {
  return value && value.schemaVersion === 1 && typeof value.timestamp === 'string' && Number.isFinite(Date.parse(value.timestamp)) &&
    /^[a-f0-9-]{36}$/i.test(String(value.operationId || '')) && OPERATION_TYPES.has(value.type) &&
    (value.sessionId === undefined || isSafeSessionId(value.sessionId)) &&
    (value.recordId === undefined || /^[a-f0-9]{64}$/i.test(value.recordId)) &&
    typeof value.phase === 'string' && /^[a-z0-9-]{1,80}$/.test(value.phase) && OPERATION_OUTCOMES.has(value.outcome)
}

/** Append-only, redacted operation audit. A malformed existing tail fails closed. */
export function appendOperation(file, record, { stateRoot = path.dirname(file), fsApi = fs, now = new Date() } = {}) {
  assertPhysicalPathInside(stateRoot, [path.dirname(stateRoot)], fsApi)
  assertPhysicalPathInside(file, [stateRoot], fsApi)
  const inspected = inspectOperationsLog(file, { stateRoot, fsApi })
  if (inspected.malformedCount) throw new Error('invalid-operations-log')
  const value = {
    schemaVersion: 1,
    timestamp: now.toISOString(),
    operationId: record.operationId || crypto.randomUUID(),
    type: record.type,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    ...(record.recordId ? { recordId: String(record.recordId).toLowerCase() } : {}),
    phase: record.phase,
    outcome: record.outcome,
    details: safeAuditDetails(record.details),
  }
  if (!validOperationRecord(value)) throw new Error('invalid-operation-record')
  fsApi.mkdirSync(stateRoot, { recursive: true })
  fsApi.appendFileSync(file, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'a' })
  return value
}

export function inspectOperationsLog(file, { stateRoot = path.dirname(file), fsApi = fs, limit = 100 } = {}) {
  assertPhysicalPathInside(stateRoot, [path.dirname(stateRoot)], fsApi)
  assertPhysicalPathInside(file, [stateRoot], fsApi)
  if (!fsApi.existsSync(file)) return { records: [], malformedCount: 0 }
  const text = fsApi.readFileSync(file, 'utf8')
  const records = []
  let malformedCount = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line)
      if (!validOperationRecord(value)) throw new Error('invalid')
      records.push({ ...value, details: safeAuditDetails(value.details) })
    } catch { malformedCount += 1 }
  }
  return { records: records.slice(-Math.max(1, Math.min(500, Number(limit) || 100))), malformedCount }
}

/** Read state without migrating it. Boot uses this to validate every store before any write. */
export function inspectVersionedJson(file, fsApi) {
  if (!fsApi.existsSync(file)) return { exists: false, legacy: false, value: null }
  let value
  try { value = JSON.parse(fsApi.readFileSync(file, 'utf8')) } catch { throw new VersionedStateError('invalid-state-json') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new VersionedStateError('invalid-state-data')
  if (value.schemaVersion === 1) return { exists: true, legacy: false, value }
  if (value.schemaVersion !== undefined) throw new VersionedStateError('unsupported-state-version')
  return { exists: true, legacy: true, value }
}

export function loadVersionedJson(file, defaults, migrate, fsApi) {
  const inspected = inspectVersionedJson(file, fsApi)
  if (!inspected.exists) return defaults
  const { value } = inspected
  if (!inspected.legacy) return value
  const backup = `${file}.v0.3.1.bak`
  try { fsApi.copyFileSync(file, backup) } catch { throw new VersionedStateError('state-migration-failed') }
  let migrated
  try { migrated = migrate(value) } catch { throw new VersionedStateError('state-migration-failed') }
  if (!migrated || typeof migrated !== 'object' || migrated.schemaVersion !== 1) throw new VersionedStateError('state-migration-failed')
  atomicWriteJson(file, migrated, fsApi)
  return migrated
}

const migrateLegacyV031 = (value) => ({ schemaVersion: 1, ...value })

const samePath = (a, b) => path.resolve(a || '') === path.resolve(b || '')
const safeTag = (tag) => typeof tag === 'string' && tag.length > 0 && sanitizeName(tag) === tag

/** Stable cache identity: titles are presentation only and never authorize a root. */
export function sessionShortId(id) {
  return String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(-12) || 'x'
}

function sessionCacheKey(entry) {
  return entry.cacheKey || sessionShortId(entry.id)
}

function dailyCacheName(entry) {
  if (entry.layoutVersion !== 2) return entry.tag
  const date = new Date(Number(entry.createdAt))
  const time = Number.isFinite(date.getTime())
    ? `${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`
    : '0000'
  return `${entry.tag}-${time}-${sessionCacheKey(entry)}`
}

/**
 * Mapping files are user-editable state, never an authority for filesystem paths.
 * Rebuild every owned path from the session identity and configured layout first.
 */
export function validateSessionEntry(sessionId, entry, { harnessRoot, config = DEFAULTS, mapping } = {}) {
  const id = String(sessionId || '')
  if (!isSafeSessionId(id)) return { ok: false, reason: 'invalid-session-id' }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.id !== id) return { ok: false, reason: 'invalid-session-entry' }
  if (mapping && mapping[id] !== entry) return { ok: false, reason: 'unregistered-entry' }
  if (!safeTag(entry.tag) || !['daily', 'project'].includes(entry.kind)) return { ok: false, reason: 'invalid-session-entry' }
  const root = path.resolve(harnessRoot || DEFAULTS.harnessRoot)
  if (entry.kind === 'daily') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date || '')) return { ok: false, reason: 'invalid-session-entry' }
  } else {
    if (typeof entry.root !== 'string' || !isPathInside(root, entry.root) || path.dirname(path.resolve(entry.root)) !== root) return { ok: false, reason: 'invalid-session-entry' }
    // v0.3.1 project caches shared <project>/.cache. They are deliberately
    // quarantined: their old mapping must never authorize deletion or moves.
    if (entry.layoutVersion !== 2) return { ok: false, reason: 'legacy-shared-project-cache' }
  }
  if (entry.layoutVersion === 2 && entry.kind === 'daily' && !Number.isFinite(Number(entry.createdAt))) return { ok: false, reason: 'invalid-session-entry' }
  if (entry.layoutVersion === 2 && entry.cacheKey !== undefined && (!safeTag(entry.cacheKey) || !new RegExp(`^${sessionShortId(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-\\d+)?$`).test(entry.cacheKey))) return { ok: false, reason: 'invalid-session-entry' }
  const layout = cacheLayoutFor(entry, { harnessRoot: root, dailyDirName: config.dailyDirName, cacheDirName: config.cacheDirName })
  const managedLayoutRoot = entry.kind === 'daily'
    ? path.join(root, config.dailyDirName || DEFAULTS.dailyDirName)
    : path.resolve(entry.root)
  if (!isPathInside(root, managedLayoutRoot) || !isPathInside(managedLayoutRoot, layout.base)) return { ok: false, reason: 'invalid-cache-path' }
  if (!samePath(entry.cacheDir, layout.base) || !samePath(entry.recordFile, layout.recordFile)) return { ok: false, reason: 'invalid-cache-path' }
  const manifest = path.join(layout.recordDir, `${entry.tag}.清单.md`)
  if (entry.manifestFile && !samePath(entry.manifestFile, manifest)) return { ok: false, reason: 'invalid-cache-path' }
  const archiveRoot = path.join(root, config.archiveDirName || DEFAULTS.archiveDirName)
  if (entry.archivePath) {
    const archiveParent = entry.kind === 'daily'
      ? path.join(archiveRoot, '日常', entry.date)
      : path.join(archiveRoot, '项目', path.basename(entry.root))
    const name = path.basename(path.resolve(entry.archivePath))
    const archiveName = layout.cacheName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!isPathInside(archiveParent, entry.archivePath) || path.dirname(path.resolve(entry.archivePath)) !== path.resolve(archiveParent) || !new RegExp(`^${archiveName}(?:-\\d+)?$`).test(name)) return { ok: false, reason: 'invalid-archive-path' }
  }
  if (!['active', 'archived'].includes(entry.status)) return { ok: false, reason: 'invalid-session-entry' }
  if (entry.status === 'archived' && !entry.archivePath) return { ok: false, reason: 'invalid-archive-path' }
  return { ok: true, layout, archiveRoot }
}

/** Resolve a cache-delete request from a verified mapping; request paths never grant authority. */
export function validateCacheDeleteTarget(target, mapping, { harnessRoot, config = DEFAULTS, fsApi } = {}) {
  const resolved = path.resolve(target || '')
  for (const [id, entry] of Object.entries(mapping || {})) {
    const valid = validateSessionEntry(id, entry, { harnessRoot, config, mapping })
    if (!valid.ok) continue
    if (entry.kind === 'daily' && isPathInside(valid.layout.base, resolved)) {
      if (fsApi) assertSessionPhysicalPaths(id, entry, valid, { harnessRoot, config, fsApi })
      return fsApi ? assertPhysicalPathInside(resolved, [valid.layout.base], fsApi) : resolved
    }
    if (entry.kind === 'project' && (samePath(resolved, valid.layout.recordFile) || (entry.manifestFile && samePath(resolved, entry.manifestFile)))) {
      if (fsApi) assertSessionPhysicalPaths(id, entry, valid, { harnessRoot, config, fsApi })
      return fsApi ? assertPhysicalPathInside(resolved, [valid.layout.recordDir], fsApi) : resolved
    }
  }
  throw new Error('unregistered-cache-path')
}

/** Check configured roots and the session cache before any filesystem mutation. */
export function assertSessionPhysicalPaths(_sessionId, entry, valid, { harnessRoot, config = DEFAULTS, fsApi }) {
  if (!fsApi) return
  const root = path.resolve(harnessRoot || DEFAULTS.harnessRoot)
  const dailyRoot = path.join(root, config.dailyDirName || DEFAULTS.dailyDirName)
  const archiveRoot = path.join(root, config.archiveDirName || DEFAULTS.archiveDirName)
  assertPhysicalPathInside(dailyRoot, [root], fsApi)
  assertPhysicalPathInside(archiveRoot, [root], fsApi)
  if (entry.kind === 'daily') assertPhysicalPathInside(valid.layout.base, [dailyRoot], fsApi)
  else {
    assertPhysicalPathInside(entry.root, [root], fsApi)
    assertPhysicalPathInside(valid.layout.base, [entry.root], fsApi)
  }
  for (const destination of [valid.layout.recordDir, ...CATEGORY_DIRS.map((name) => valid.layout.categoryDir(name))]) {
    assertPhysicalPathInside(destination, [valid.layout.base], fsApi)
  }
}

export function resolveProtectedChild(name, protectRoot, fsApi) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..') throw new Error('invalid-protected-name')
  const clean = sanitizeName(name)
  if (!clean || clean !== name || clean === '.' || clean === '..') throw new Error('invalid-protected-name')
  return assertPhysicalPathInside(path.join(protectRoot, clean), [protectRoot], fsApi)
}

/** 合并配置：DEFAULTS ← patchConfig ← config.json */
export function loadConfig(fsApi, patchConfig = {}, configPath = '') {  const base = JSON.parse(JSON.stringify(DEFAULTS))
  const merged = { ...base, ...(patchConfig || {}) }
  merged.capture = { ...base.capture, ...((patchConfig || {}).capture || {}) }
  merged.archive = { ...base.archive, ...((patchConfig || {}).archive || {}) }
  merged.purge = { ...base.purge, ...((patchConfig || {}).purge || {}) }
  merged.backup = { ...base.backup, ...((patchConfig || {}).backup || {}) }
  merged.remind = { ...base.remind, ...((patchConfig || {}).remind || {}) }
  merged.retention = { ...base.retention, ...((patchConfig || {}).retention || {}) }
  merged.updateCheck = { ...base.updateCheck, ...((patchConfig || {}).updateCheck || {}) }
  merged.categories = { ...((patchConfig || {}).categories || {}) }
  merged.importantExts = (patchConfig || {}).importantExts || null
  if (configPath && fsApi && fsApi.existsSync(configPath)) {
    try {
      const record = loadVersionedJson(configPath, { schemaVersion: 1 }, migrateLegacyV031, fsApi)
      const { schemaVersion: _schemaVersion, ...file } = record
      for (const k of Object.keys(file)) {
        if (k === 'capture' || k === 'archive' || k === 'purge' || k === 'backup' || k === 'remind' || k === 'retention' || k === 'updateCheck') {
          merged[k] = { ...merged[k], ...file[k] }
        } else if (k === 'categories') {
          merged.categories = { ...merged.categories, ...file.categories }
        } else {
          merged[k] = file[k]
        }
      }
    } catch (e) {
      if (!(e instanceof VersionedStateError)) throw e
      merged.persistenceError = e.code
    }
  }
  merged.categories = normalizeCategories(merged.categories)
  return merged
}

export function categoryOf(name, categories = {}) {
  const ext = path.extname(String(name)).toLowerCase()
  const safe = normalizeCategories(categories)
  return safe[ext] || DEFAULT_EXT_CATEGORY[ext] || '其他'
}

export function importantExts(config) {
  return config?.importantExts || defaultImportantExts()
}

/** 重要文件清单文件名（Agent/会话在对话中登记关键产物） */
export const MANIFEST_NAME = '重要文件清单.md'

/**
 * 扫描目录内的"重要文件"（相对路径列表）：
 * 1) 目录/子目录中的 重要文件清单.md（每行一个路径，相对该清单所在目录）；
 * 2) 扩展名白名单启发式（仅存在文件）。
 */
export function scanImportantInDir(dir, fsApi, opts = {}) {
  const found = []
  const exts = opts.importantExts || defaultImportantExts()
  const walk = (d, base) => {
    let names = []
    try { names = fsApi.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const ent of names) {
      const full = path.join(d, ent.name)
      const rel = path.join(base, ent.name)
      if (ent.isSymbolicLink?.()) continue
      if (ent.isDirectory()) { walk(full, rel); continue }
      if (ent.name === MANIFEST_NAME) continue
      if (exts.includes(path.extname(ent.name).toLowerCase())) found.push(rel)
    }
  }
  walk(dir, '')
  // 清单条目（相对路径以清单所在目录为准）
  const collectManifest = (d, base) => {
    let names = []
    try { names = fsApi.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const ent of names) {
      const full = path.join(d, ent.name)
      const rel = path.join(base, ent.name)
      if (ent.isSymbolicLink?.()) continue
      if (ent.isDirectory()) { collectManifest(full, rel); continue }
      if (ent.name !== MANIFEST_NAME) continue
      try {
        const text = fsApi.readFileSync(full, 'utf8')
        for (const raw of text.split(/\r?\n/)) {
          const line = raw.replace(/^[-*]\s*/, '').trim()
          if (!line || line.startsWith('#')) continue
          const target = path.join(d, line)
          try { if (fsApi.statSync(target).isFile()) found.push(path.join(base, line)) } catch { /* 不存在则跳过 */ }
        }
      } catch { /* 忽略 */ }
    }
  }
  collectManifest(dir, '')
  return [...new Set(found)]
}

/**
 * 彻底删除前的重要文件保护：把目标目录中的重要文件复制到保护区（防误删，回收站之外仍可找回）。
 * 返回受保护文件的目标路径列表。
 */
export function protectImportantFiles(targetDir, protectRoot, fsApi, config = DEFAULTS, managedRoot = '') {
  if (!fsApi.existsSync(targetDir)) return []
  if (managedRoot) assertPhysicalPathInside(protectRoot, [managedRoot], fsApi)
  const important = scanImportantInDir(targetDir, fsApi, { importantExts: importantExts(config) })
  if (important.length === 0) return []
  const sourceName = sanitizeName(path.basename(targetDir)) || 'unknown'
  const destBase = path.join(protectRoot, sourceName)
  const protectedList = []
  for (const rel of important) {
    const src = path.join(targetDir, rel)
    const dest = path.join(destBase, rel)
    assertPhysicalPathInside(src, [targetDir], fsApi)
    assertPhysicalPathInside(dest, [protectRoot], fsApi)
    try {
      fsApi.mkdirSync(path.dirname(dest), { recursive: true })
      fsApi.copyFileSync(src, dest)
      protectedList.push(dest)
    } catch { /* 单文件失败不阻断 */ }
  }
  return protectedList
}

/** 提醒到期判定：距上次提醒超过 intervalDays 天（精确到天） */
export function remindDue(lastRemindedAt, config = DEFAULTS) {
  const days = Math.max(1, Number(config.remind?.intervalDays) || 1)
  if (!lastRemindedAt) return true
  return Date.now() - lastRemindedAt >= days * 24 * 60 * 60 * 1000
}

/** 清洗文件夹名：替换非法字符与控制字符、压缩空白、限长 */
export function sanitizeName(input, maxLen = 80) {
  if (typeof input !== 'string') return ''
  let s = input
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
  s = Array.from(s).slice(0, maxLen).join('')
  return s
}

/** yyyy-MM-dd（本地时区） */
export function dateStr(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 判定 cwd 属于哪个区域：
 * - daily / project(root=最近深度1祖先) / harness-root / outside
 */
export function classifyWorkspace(cwd, opts = {}) {
  const harnessRoot = path.resolve(opts.harnessRoot || DEFAULTS.harnessRoot)
  const daily = path.resolve(path.join(harnessRoot, opts.dailyDirName || DEFAULTS.dailyDirName))
  if (!cwd) return { kind: 'outside' }
  const p = path.resolve(cwd)
  const sep = path.sep
  const under = (base) => p === base || p.startsWith(base + sep)
  if (under(daily)) return { kind: 'daily' }
  if (!under(harnessRoot)) return { kind: 'outside' }
  if (p === harnessRoot) return { kind: 'harness-root' }
  const rel = path.relative(harnessRoot, p).split(path.sep)[0]
  return { kind: 'project', root: path.resolve(harnessRoot, rel) }
}

export function placeholderTag(sessionId) {
  const short = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(-12)
  return `会话-${short || 'x'}`
}

/** 区分性：候选名若已被 taken 占用（不含自身 oldTag），依次加 -2/-3 */
export function uniqueTag(candidate, taken, oldTag = '') {
  if (!taken.has(candidate) || candidate === oldTag) return candidate
  let n = 2
  let next = `${candidate}-${n}`
  while (taken.has(next) && next !== oldTag) {
    n += 1
    next = `${candidate}-${n}`
  }
  return next
}

/**
 * v2 caches own a complete root per session. v1 daily entries remain readable
 * through their deterministic legacy layout; v1 project entries are rejected
 * by validateSessionEntry because their shared root is unsafe to manage.
 */
export function cacheLayoutFor(entry, opts = {}) {
  const harnessRoot = opts.harnessRoot || DEFAULTS.harnessRoot
  const cat = (base) => (catName) => path.join(base, catName)
  if (entry.kind === 'daily') {
    const cacheName = dailyCacheName(entry)
    const base = path.join(harnessRoot, opts.dailyDirName || DEFAULTS.dailyDirName, entry.date, cacheName)
    return {
      kind: 'daily',
      base,
      cacheName,
      recordDir: path.join(base, '会话记录'),
      recordFile: path.join(base, '会话记录', '对话记录.jsonl'),
      categoryDir: cat(base),
      scope: path.dirname(base),
    }
  }
  const cacheName = entry.layoutVersion === 2 ? sessionCacheKey(entry) : ''
  const base = cacheName
    ? path.join(entry.root, opts.cacheDirName || DEFAULTS.cacheDirName, cacheName)
    : path.join(entry.root, opts.cacheDirName || DEFAULTS.cacheDirName)
  return {
    kind: 'project',
    base,
    cacheName: cacheName || entry.tag,
    recordDir: path.join(base, '会话记录'),
    recordFile: path.join(base, '会话记录', entry.layoutVersion === 2 ? '对话记录.jsonl' : `${entry.tag}.jsonl`),
    categoryDir: cat(base),
    scope: path.join(base, '会话记录'),
  }
}

/** 确保缓存布局目录存在（base、会话记录、各分类夹；lazy 时仅建 base+会话记录） */
export function ensureCacheLayout(layout, fsApi, lazy = false) {
  fsApi.mkdirSync(layout.base, { recursive: true })
  fsApi.mkdirSync(layout.recordDir, { recursive: true })
  if (!lazy) {
    for (const c of CATEGORY_DIRS) fsApi.mkdirSync(layout.categoryDir(c), { recursive: true })
  }
}

export function appendRecord(recordFile, event, fsApi) {
  const line = JSON.stringify({ seq: event.seq, time: event.time, type: event.type, data: event.data })
  fsApi.appendFileSync(recordFile, line + '\n', 'utf8')
}

/** 跳过目录与日期目录（捕获扫描用） */
const SKIP_DIRS = new Set(['.git', '.dsh', 'node_modules', '.cache', 'dist', 'build', '.venv', 'venv', '__pycache__', '.idea', '.vscode', '.next', 'target'])
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/
const RETENTION_SKIP_DIRS = new Set([...SKIP_DIRS, '会话记录', '日志'])
const RETENTION_SKIP_EXTS = new Set(['.tmp', '.temp', '.log', '.out', '.err'])
const TEXT_RETENTION_EXTS = new Set(['.txt', '.md', '.csv', '.json', '.yaml', '.yml', '.toml', '.ini', '.xml', '.html', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.go', '.rs', '.php', '.rb', '.sql', '.sh', '.ps1', '.bat', '.cmd'])
const IMAGE_RETENTION_TYPES = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.gif', 'image/gif']])

function sha256File(file, fsApi) {
  const hash = crypto.createHash('sha256')
  const handle = fsApi.openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    for (;;) {
      const read = fsApi.readSync(handle, buffer, 0, buffer.length, null)
      if (!read) break
      hash.update(buffer.subarray(0, read))
    }
  } finally { fsApi.closeSync(handle) }
  return hash.digest('hex')
}

function representativeText(file, size, limit, fsApi) {
  if (!limit || !size) return ''
  const handle = fsApi.openSync(file, 'r')
  const piece = Math.max(1, Math.floor(limit / 3))
  const offsets = size <= limit ? [0] : [0, Math.max(0, Math.floor((size - piece) / 2)), Math.max(0, size - piece)]
  const parts = []
  try {
    for (const offset of offsets) {
      const buffer = Buffer.allocUnsafe(Math.min(piece, Math.max(0, size - offset)))
      const read = fsApi.readSync(handle, buffer, 0, buffer.length, offset)
      if (read) parts.push(buffer.subarray(0, read).toString('utf8'))
    }
  } finally { fsApi.closeSync(handle) }
  return parts.join(size <= limit ? '' : '\n…[中段/末段抽样]…\n').slice(0, limit)
}

/** Candidate discovery is deliberately confined to one already-validated cache root. */
export function findRetentionCandidates(cacheRoot, fsApi, { maxCandidates = 40, maxCandidateBytes = 8 * 1024 * 1024, maxExcerptChars = 3000 } = {}) {
  assertPhysicalPathInside(cacheRoot, [path.dirname(cacheRoot)], fsApi)
  const root = path.resolve(cacheRoot)
  const candidateLimit = Math.max(1, Math.min(200, Number(maxCandidates) || 40))
  // Hashing/content extraction is bounded by stat size before any file read.
  // This prevents an arbitrary cache candidate from becoming an unbounded
  // memory allocation. The configured value is itself capped defensively.
  const candidateByteLimit = Math.max(0, Math.min(64 * 1024 * 1024, Number.isFinite(Number(maxCandidateBytes)) ? Number(maxCandidateBytes) : 8 * 1024 * 1024))
  const excerptLimit = Math.max(0, Math.min(12_000, Number(maxExcerptChars) || 3000))
  const candidates = []
  const hardLimit = 2000
  let truncated = false
  const walk = (dir) => {
    if (candidates.length >= hardLimit) { truncated = true; return }
    let entries
    try { entries = fsApi.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (candidates.length >= hardLimit) { truncated = true; return }
      const file = path.join(dir, entry.name)
      if (entry.isSymbolicLink?.()) continue
      if (entry.isDirectory()) {
        if (!RETENTION_SKIP_DIRS.has(entry.name)) walk(file)
        continue
      }
      const ext = path.extname(entry.name).toLowerCase()
      if (RETENTION_SKIP_EXTS.has(ext) || entry.name.startsWith('~$') || /^session\.jsonl(?:\.zstd)?$/i.test(entry.name)) continue
      let stat
      try {
        assertPhysicalPathInside(file, [root], fsApi)
        stat = fsApi.statSync(file)
      } catch { continue }
      if (!stat.isFile()) continue
      let digest = ''
      try { digest = sha256File(file, fsApi) } catch { continue }
      let excerpt = ''
      if (TEXT_RETENTION_EXTS.has(ext)) {
        try { excerpt = representativeText(file, stat.size, excerptLimit, fsApi) } catch { /* binary/invalid text has no excerpt */ }
      }
      const relativePath = path.relative(root, file)
      candidates.push({
        id: crypto.createHash('sha256').update(`${relativePath}\0${stat.size}\0${digest}`).digest('hex'),
        path: file,
        relativePath,
        name: entry.name,
        category: categoryOf(entry.name),
        size: stat.size,
        sha256: digest,
        excerpt,
        sampleKind: TEXT_RETENTION_EXTS.has(ext) && stat.size > candidateByteLimit ? 'representative-start-middle-end' : 'bounded',
        imageMediaType: stat.size <= candidateByteLimit ? IMAGE_RETENTION_TYPES.get(ext) || '' : '',
      })
    }
  }
  walk(root)
  Object.defineProperties(candidates, {
    batchSize: { value: candidateLimit, enumerable: false },
    truncated: { value: truncated, enumerable: false },
  })
  return candidates
}

export function createRetentionPrompt(candidates, imageReview = 'metadata-only') {
  return [
    '你正在审核即将删除的 DeepSeek Harness 对话缓存。仅选择不可轻易重建的最终产出；不要选择临时文件、依赖或日志。',
    '只输出严格 JSON，且只允许此结构：{"retain":[{"id":"候选ID","reason":"简短原因"}]}。如果没有值得保留的内容，输出 {"retain":[]}；不得输出 Markdown 或额外文字。',
    `图片审核能力：${imageReview}。未附带图片块时仅依据文件元数据判断，不声称已查看图片内容。`,
    JSON.stringify(candidates.map(({ id, relativePath, category, size, excerpt, sampleKind, imageMediaType }) => ({ id, relativePath, category, size, excerpt, sampleKind, imageMediaType }))),
  ].join('\n')
}

export function parseRetentionDecision(output, candidates) {
  let value
  try { value = JSON.parse(String(output || '').trim()) } catch { throw new Error('ai-review-failed') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Array.isArray(value.retain)) throw new Error('ai-review-failed')
  const known = new Map(candidates.map((candidate) => [candidate.id, candidate]))
  const selected = []
  const seen = new Set()
  for (const item of value.retain) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'id,reason' || typeof item.id !== 'string' || typeof item.reason !== 'string' || !item.reason.trim() || seen.has(item.id) || !known.has(item.id)) throw new Error('ai-review-failed')
    seen.add(item.id)
    selected.push({ ...known.get(item.id), reason: item.reason.trim().slice(0, 300) })
  }
  return selected
}

/** Run the DSH-configured default model; all incomplete/model failures fail closed. */
export async function reviewRetentionCandidates(ctx, candidates, { timeoutMs = 20_000, fsApi = fs } = {}) {
  const defaults = ctx?.get?.('agentDefaultModel')
  const llm = ctx?.llm || ctx?.get?.('llm')
  if (!defaults?.currentSelection || typeof llm?.stream !== 'function' || candidates.length === 0) return { ok: false, reason: 'ai-review-failed' }
  const selection = defaults.currentSelection()
  if (!selection?.provider || !selection?.model) return { ok: false, reason: 'ai-review-failed' }
  const controller = new AbortController()
  const timeoutLimit = Math.max(1_000, Math.min(60_000, Number(timeoutMs) || 20_000))
  let timer
  try {
    let imageReview = 'metadata-only（模型或 DSH 附件服务不支持图片输入）'
    const content = []
    let attachments
    try { attachments = ctx?.attachments } catch { /* optional DSH service */ }
    if (!attachments && typeof ctx?.get === 'function') {
      try { attachments = ctx.get('attachments') } catch { /* optional DSH service */ }
    }
    let supportsImages = false
    if (typeof llm.resolveModelInfo === 'function') {
      const info = await llm.resolveModelInfo(selection.provider, selection.model, controller.signal)
      supportsImages = Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
    }
    if (supportsImages && typeof attachments?.saveImage === 'function') {
      for (const candidate of candidates.filter((item) => item.imageMediaType).slice(0, 4)) {
        const attachment = await attachments.saveImage({ data: fsApi.readFileSync(candidate.path), mediaType: candidate.imageMediaType, name: candidate.name })
        content.push({ type: 'image', attachment })
      }
      if (content.length) imageReview = `已附带 ${content.length} 个受限大小的真实图片块`
    }
    content.unshift({ type: 'text', text: createRetentionPrompt(candidates, imageReview) })
    const stream = llm.stream({
      ...selection,
      messages: [{ id: crypto.randomUUID(), role: 'user', source: { kind: 'user' }, content }],
      temperature: 0,
      maxTokens: 800,
      signal: controller.signal,
    })
    const iterator = stream?.[Symbol.asyncIterator]?.()
    if (!iterator) throw new Error('ai-review-failed')
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('ai-review-failed')) }, timeoutLimit) })
    let output = ''
    let finished = false
    while (!finished) {
      const step = await Promise.race([iterator.next(), timeout])
      if (step.done) break
      if (step.value?.type === 'text-delta') output += step.value.text || ''
      if (step.value?.type === 'finish') {
        if (step.value.reason?.kind !== 'stop') throw new Error('ai-review-failed')
        finished = true
      }
    }
    if (!finished) throw new Error('ai-review-failed')
    return { ok: true, selected: parseRetentionDecision(output, candidates), selection }
  } catch {
    return { ok: false, reason: 'ai-review-failed' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Copy AI-approved files before recycle, preserving all content-hash provenance. */
export function retainReviewedFiles(selected, { sessionId, projectRoot = '', cacheRoot, retainedRoot, indexPath, operationPath, harnessRoot, stateRoot, sourceRoots = [harnessRoot], fsApi }) {
  if (!isSafeSessionId(sessionId) || !Array.isArray(selected) || selected.length === 0) return { ok: false, reason: 'retention-copy-failed' }
  try {
    assertPhysicalPathInside(cacheRoot, sourceRoots, fsApi)
    assertPhysicalPathInside(retainedRoot, [harnessRoot], fsApi)
    // Retained bytes belong to the DSH workspace, but index/operation state is
    // trusted plugin state under .dsh. Keep these roots separate so a workspace
    // path can never authorize or replace plugin state (and vice versa).
    assertPhysicalPathInside(stateRoot, [path.dirname(stateRoot)], fsApi)
    assertPhysicalPathInside(indexPath, [stateRoot], fsApi)
    assertPhysicalPathInside(operationPath, [stateRoot], fsApi)
    const indexRecord = loadVersionedJson(indexPath, { schemaVersion: 1, files: {} }, migrateLegacyV031, fsApi)
    if (!indexRecord.files || typeof indexRecord.files !== 'object' || Array.isArray(indexRecord.files)) throw new Error('invalid-retained-index')
    const index = { schemaVersion: 1, files: { ...indexRecord.files } }
    let operation = { schemaVersion: 1, sessionId, phase: 'retaining', startedAt: Date.now(), retained: [] }
    atomicWriteJson(operationPath, operation, fsApi)
    const filesRoot = path.join(retainedRoot, 'files')
    fsApi.mkdirSync(filesRoot, { recursive: true })
    assertPhysicalPathInside(filesRoot, [retainedRoot], fsApi)
    const ownership = path.join(retainedRoot, '.dsh-conversation-archive-owned.json')
    assertPhysicalPathInside(ownership, [retainedRoot], fsApi)
    if (!fsApi.existsSync(ownership)) atomicWriteJson(ownership, { schemaVersion: 1, owner: 'dsh-conversation-archive', kind: 'retained-library' }, fsApi)
    const retained = []
    for (const candidate of selected) {
      if (!candidate || typeof candidate.relativePath !== 'string' || typeof candidate.sha256 !== 'string' || typeof candidate.reason !== 'string') throw new Error('invalid-retention-candidate')
      const source = path.join(cacheRoot, candidate.relativePath)
      assertPhysicalPathInside(source, [cacheRoot], fsApi)
      if (sha256File(source, fsApi) !== candidate.sha256) throw new Error('retention-hash-mismatch')
      const ext = path.extname(candidate.name || source)
      const fileName = `${candidate.sha256}${/^\.[A-Za-z0-9]{1,12}$/.test(ext) ? ext.toLowerCase() : ''}`
      const destination = path.join(filesRoot, fileName)
      assertPhysicalPathInside(destination, [retainedRoot], fsApi)
      if (fsApi.existsSync(destination)) {
        if (sha256File(destination, fsApi) !== candidate.sha256) throw new Error('retention-hash-mismatch')
      } else {
        const temp = `${destination}.${crypto.randomUUID()}.tmp`
        try {
          fsApi.copyFileSync(source, temp)
          if (sha256File(temp, fsApi) !== candidate.sha256) throw new Error('retention-hash-mismatch')
          fsApi.renameSync(temp, destination)
        } finally {
          try { if (fsApi.existsSync(temp)) fsApi.unlinkSync(temp) } catch { /* best effort */ }
        }
      }
      const prior = index.files[candidate.sha256] || { sha256: candidate.sha256, path: destination, size: candidate.size, savedAt: Date.now(), sources: [] }
      const provenance = {
        id: crypto.createHash('sha256').update(`${candidate.sha256}\0${sessionId}\0${candidate.relativePath}`).digest('hex'),
        sessionId, projectRoot, originalPath: source, originalRelativePath: candidate.relativePath, reason: candidate.reason, size: candidate.size, savedAt: Date.now(),
      }
      const exists = prior.sources.some((sourceInfo) => sourceInfo.sessionId === provenance.sessionId && sourceInfo.originalRelativePath === provenance.originalRelativePath)
      index.files[candidate.sha256] = exists ? prior : { ...prior, sources: [...prior.sources, provenance] }
      atomicWriteJson(indexPath, index, fsApi)
      retained.push({ sha256: candidate.sha256, path: destination })
      operation = { ...operation, retained, updatedAt: Date.now() }
      atomicWriteJson(operationPath, operation, fsApi)
    }
    atomicWriteJson(operationPath, { ...operation, phase: 'complete', completedAt: Date.now() }, fsApi)
    return { ok: true, retained, index }
  } catch {
    return { ok: false, reason: 'retention-copy-failed' }
  }
}

function retainedState(indexPath, retainedRoot, harnessRoot, stateRoot, fsApi) {
  assertPhysicalPathInside(retainedRoot, [harnessRoot], fsApi)
  assertPhysicalPathInside(stateRoot, [path.dirname(stateRoot)], fsApi)
  assertPhysicalPathInside(indexPath, [stateRoot], fsApi)
  const filesRoot = path.join(retainedRoot, 'files')
  assertPhysicalPathInside(filesRoot, [retainedRoot], fsApi)
  const index = loadVersionedJson(indexPath, { schemaVersion: 1, files: {} }, migrateLegacyV031, fsApi)
  if (!index.files || typeof index.files !== 'object' || Array.isArray(index.files)) throw new Error('invalid-retained-index')
  return { index: { schemaVersion: 1, files: { ...index.files } }, filesRoot }
}

function retainedDeleteOperationPath(deps) {
  if (typeof deps.deleteOperationPath !== 'string' || !deps.deleteOperationPath) throw new Error('retained-delete-state-required')
  assertPhysicalPathInside(deps.deleteOperationPath, [deps.stateRoot], deps.fsApi)
  return deps.deleteOperationPath
}

function retainedDeletePendingId(deps) {
  if (typeof deps.deleteOperationPath !== 'string' || !deps.deleteOperationPath) return ''
  const operationPath = retainedDeleteOperationPath(deps)
  const inspected = inspectVersionedJson(operationPath, deps.fsApi)
  const operation = inspected.value
  return operation?.phase === 'recycled-index-pending' && /^[a-f0-9]{64}$/i.test(String(operation.recordId || ''))
    ? String(operation.recordId).toLowerCase() : ''
}

function retainedProvenanceId(sha256, source, _ordinal) {
  return typeof source.id === 'string' && /^[a-f0-9]{64}$/i.test(source.id)
    ? source.id.toLowerCase()
    : crypto.createHash('sha256').update(`${sha256}\0${source.sessionId || ''}\0${source.originalRelativePath || ''}`).digest('hex')
}

function safeRetainedName(record) {
  const candidate = path.basename(String(record?.sources?.[0]?.originalRelativePath || '')) || path.basename(String(record?.path || ''))
  return sanitizeName(candidate) || '保留文件'
}

function safeRelativeLocation(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) return ''
  const normalized = path.normalize(value)
  return normalized === '..' || normalized.startsWith(`..${path.sep}`) ? '' : normalized
}

function retainedSourceView(sha256, source, ordinal) {
  const projectLabel = source.projectRoot ? path.basename(path.resolve(source.projectRoot)) : '日常对话'
  return {
    id: retainedProvenanceId(sha256, source, ordinal),
    conversationLabel: String(source.sessionId || ''),
    projectLabel: sanitizeName(projectLabel) || '日常对话',
    originalLocation: safeRelativeLocation(source.originalRelativePath),
    savedAt: Number(source.savedAt) || 0,
    aiReason: String(source.reason || ''),
  }
}

/** Safe client view: all file locations are relative metadata, never host paths. */
export function listRetainedFiles({ retainedRoot, indexPath, harnessRoot, stateRoot, fsApi, deleteOperationPath = '' }) {
  try {
    const { index } = retainedState(indexPath, retainedRoot, harnessRoot, stateRoot, fsApi)
    const pendingId = retainedDeletePendingId({ retainedRoot, indexPath, harnessRoot, stateRoot, fsApi, deleteOperationPath })
    return Object.entries(index.files).flatMap(([sha256, record]) => {
      if (!/^[a-f0-9]{64}$/i.test(sha256) || !record || typeof record !== 'object' || !Array.isArray(record.sources)) return []
      const sources = record.sources.map((source, ordinal) => retainedSourceView(sha256, source || {}, ordinal))
      return [{
        id: sha256.toLowerCase(), displayName: safeRetainedName(record), type: path.extname(safeRetainedName(record)).toLowerCase(),
        size: Number(record.size) || 0, sha256: sha256.toLowerCase(), savedAt: Number(record.savedAt) || 0,
        aiReason: sources[0]?.aiReason || '', sources,
        partialPhase: pendingId === sha256.toLowerCase() ? 'retained-recycled-index-pending' : '',
      }]
    }).sort((a, b) => b.savedAt - a.savedAt)
  } catch { return [] }
}

function retainedRecord(recordId, deps) {
  if (!/^[a-f0-9]{64}$/i.test(String(recordId || ''))) throw new Error('invalid-retained-id')
  const state = retainedState(deps.indexPath, deps.retainedRoot, deps.harnessRoot, deps.stateRoot, deps.fsApi)
  const id = String(recordId).toLowerCase()
  const record = state.index.files[id]
  if (!record || typeof record !== 'object' || !Array.isArray(record.sources)) throw new Error('retained-not-found')
  const extension = path.extname(String(record.path || ''))
  const sourceFile = path.join(state.filesRoot, `${id}${/^\.[A-Za-z0-9]{1,12}$/.test(extension) ? extension.toLowerCase() : ''}`)
  assertPhysicalPathInside(sourceFile, [state.filesRoot], deps.fsApi)
  return { ...state, id, record, sourceFile }
}

function copyVerifiedRetained(source, target, sha256, fsApi) {
  if (fsApi.existsSync(target)) throw new Error('target-exists')
  const temp = `${target}.${crypto.randomUUID()}.tmp`
  try {
    fsApi.copyFileSync(source, temp)
    if (sha256File(temp, fsApi) !== sha256) throw new Error('retention-hash-mismatch')
    if (fsApi.existsSync(target)) throw new Error('target-exists')
    fsApi.renameSync(temp, target)
  } finally {
    try { if (fsApi.existsSync(temp)) fsApi.unlinkSync(temp) } catch { /* best effort */ }
  }
}

/** Restore a retained item by its trusted record id; never accepts a file path. */
export function restoreRetainedFile(recordId, { targetDir = '', provenanceId = '', ...deps }) {
  try {
    const { record, sourceFile } = retainedRecord(recordId, deps)
    if (!deps.fsApi.existsSync(sourceFile)) return { ok: false, reason: 'retained-file-not-found' }
    if (sha256File(sourceFile, deps.fsApi) !== String(recordId).toLowerCase()) return { ok: false, reason: 'retention-hash-mismatch' }
    const source = provenanceId
      ? record.sources.find((item, ordinal) => retainedProvenanceId(String(recordId).toLowerCase(), item || {}, ordinal) === provenanceId)
      : record.sources.find((item) => {
        const parent = path.dirname(String(item?.originalPath || ''))
        try { return !!item?.originalPath && deps.fsApi.existsSync(parent) && deps.fsApi.lstatSync(parent).isDirectory() } catch { return false }
      }) || record.sources[0]
    if (!source) return { ok: false, reason: 'provenance-not-found' }
    const parent = targetDir ? path.resolve(targetDir) : path.dirname(String(source?.originalPath || ''))
    const sourceName = path.basename(String(source?.originalPath || ''))
    const name = targetDir ? (sanitizeName(sourceName) === sourceName && sourceName ? sourceName : safeRetainedName(record)) : sourceName
    if (!name || name === '.' || name === '..' || !sanitizeName(name) || name !== sanitizeName(name)) return { ok: false, reason: 'invalid-restore-target' }
    if (!deps.fsApi.existsSync(parent)) return { ok: false, reason: targetDir ? 'target-directory-not-found' : 'original-parent-missing' }
    const stat = deps.fsApi.lstatSync(parent)
    if (!stat.isDirectory() || stat.isSymbolicLink?.()) return { ok: false, reason: 'path-reparse-escape' }
    if (!targetDir) assertPhysicalPathInside(parent, [deps.harnessRoot], deps.fsApi)
    else assertPhysicalPathInside(parent, [path.dirname(parent)], deps.fsApi)
    const target = path.join(parent, name)
    assertPhysicalPathInside(target, [parent], deps.fsApi)
    copyVerifiedRetained(sourceFile, target, String(recordId).toLowerCase(), deps.fsApi)
    return { ok: true, id: String(recordId).toLowerCase(), restoredTo: target }
  } catch (e) { return { ok: false, reason: e.message || 'retained-restore-failed' } }
}

/** Drop one provenance record without touching bytes shared by other conversations. */
export function removeRetainedProvenance(recordId, provenanceId, deps) {
  try {
    const { index, id, record } = retainedRecord(recordId, deps)
    const sources = record.sources.filter((source, ordinal) => retainedProvenanceId(id, source || {}, ordinal) !== provenanceId)
    if (sources.length === record.sources.length) return { ok: false, reason: 'provenance-not-found' }
    // Bytes must always have a record. The final provenance can only be
    // removed by the explicit whole-file recycle transaction below.
    if (!sources.length) return { ok: false, reason: 'whole-file-confirmation-required' }
    index.files[id] = { ...record, sources }
    atomicWriteJson(deps.indexPath, index, deps.fsApi)
    return { ok: true, id, remainingSources: sources.length }
  } catch (e) { return { ok: false, reason: e.message || 'retained-index-write-failed' } }
}

/** Converge a previously recycled retained file without trusting operation paths. */
export function recoverRetainedRecycle(deps) {
  try {
    const operationPath = retainedDeleteOperationPath(deps)
    const inspected = inspectVersionedJson(operationPath, deps.fsApi)
    if (!inspected.exists) return { ok: true, recovered: false }
    const operation = loadVersionedJson(operationPath, { schemaVersion: 1, phase: 'complete' }, migrateLegacyV031, deps.fsApi)
    if (!operation || typeof operation !== 'object' || !['prepared', 'recycled-index-pending', 'complete'].includes(operation.phase)) throw new Error('invalid-retained-delete-state')
    if (operation.phase === 'complete') return { ok: true, recovered: false }
    if (!/^[a-f0-9]{64}$/i.test(String(operation.recordId || ''))) throw new Error('invalid-retained-delete-state')
    const state = retainedState(deps.indexPath, deps.retainedRoot, deps.harnessRoot, deps.stateRoot, deps.fsApi)
    if (!state.index.files[String(operation.recordId).toLowerCase()]) {
      atomicWriteJson(operationPath, { ...operation, schemaVersion: 1, phase: 'complete', resolvedAt: Date.now() }, deps.fsApi)
      return { ok: true, recovered: true, partialPhase: 'retained-recycle-already-converged' }
    }
    const { index, id, sourceFile } = retainedRecord(operation.recordId, deps)
    if (deps.fsApi.existsSync(sourceFile)) {
      // Recycle never completed (or the file was restored by the OS), so the
      // index remains authoritative and this intent can be safely converged.
      atomicWriteJson(operationPath, { ...operation, schemaVersion: 1, phase: 'complete', resolvedAt: Date.now() }, deps.fsApi)
      return { ok: true, recovered: true, retained: true }
    }
    delete index.files[id]
    atomicWriteJson(deps.indexPath, index, deps.fsApi)
    atomicWriteJson(operationPath, { ...operation, schemaVersion: 1, phase: 'complete', resolvedAt: Date.now() }, deps.fsApi)
    return { ok: true, recovered: true, partialPhase: 'retained-recycled-index-converged' }
  } catch (e) { return { ok: false, reason: e.message || 'retained-delete-recovery-failed' } }
}

/** Recycle an entire shared retained file only through an explicit whole-file action. */
export async function recycleRetainedFile(recordId, { recycle = recyclePath, wholeFile = false, ...deps }) {
  try {
    const recovery = recoverRetainedRecycle(deps)
    if (!recovery.ok) return { ok: false, reason: recovery.reason }
    const { index, id, record, sourceFile } = retainedRecord(recordId, deps)
    if (!wholeFile) return { ok: false, reason: 'whole-file-confirmation-required', sourceCount: record.sources.length }
    if (!deps.fsApi.existsSync(sourceFile)) return { ok: false, reason: 'retained-file-not-found' }
    const operationPath = retainedDeleteOperationPath(deps)
    const operation = { schemaVersion: 1, phase: 'prepared', recordId: id, startedAt: Date.now() }
    atomicWriteJson(operationPath, operation, deps.fsApi)
    const recycled = await recycle(sourceFile)
    if (!recycled?.ok) {
      atomicWriteJson(operationPath, { ...operation, phase: 'complete', recycleFailedAt: Date.now() }, deps.fsApi)
      return { ok: false, reason: recycled?.error || recycled?.reason || 'recycle-failed' }
    }
    try {
      delete index.files[id]
      atomicWriteJson(deps.indexPath, index, deps.fsApi)
      atomicWriteJson(operationPath, { ...operation, phase: 'complete', completedAt: Date.now() }, deps.fsApi)
    } catch {
      // The byte is already in the OS recycle bin. A persisted intent lets a
      // later boot remove only this stale trusted index record.
      try { atomicWriteJson(operationPath, { ...operation, phase: 'recycled-index-pending', recycledAt: Date.now() }, deps.fsApi) } catch { /* prepared state is also recoverable when bytes are absent */ }
      return { ok: false, reason: 'retained-index-write-failed', partialPhase: 'retained-recycled-index-pending' }
    }
    return { ok: true, id, sourceCount: record.sources.length }
  } catch (e) { return { ok: false, reason: e.message || 'retained-recycle-failed' } }
}

/** Polling never mutates reminder state; only an explicit acknowledgement does. */
export function retentionReminder(records, { lastRetentionReminderAt = 0, config = DEFAULTS, now = Date.now() } = {}) {
  const count = Array.isArray(records) ? records.length : 0
  const days = Math.max(1, Math.min(365, Number(config.remind?.intervalDays) || 1))
  const due = count > 0 && (!lastRetentionReminderAt || now - Number(lastRetentionReminderAt) >= days * 24 * 60 * 60 * 1000)
  return { due, count, intervalDays: days, text: due ? `有 ${count} 个防误删保留文件，查看保留文件。` : '' , action: due ? 'view-retained-files' : '' }
}

export function markRetentionReminderSeen(statusPath, { stateRoot, fsApi, now = Date.now() }) {
  try {
    assertPhysicalPathInside(stateRoot, [path.dirname(stateRoot)], fsApi)
    assertPhysicalPathInside(statusPath, [stateRoot], fsApi)
    const record = loadVersionedJson(statusPath, { schemaVersion: 1 }, migrateLegacyV031, fsApi)
    atomicWriteJson(statusPath, { ...record, schemaVersion: 1, lastRetentionReminderAt: now }, fsApi)
    return { ok: true, lastRetentionReminderAt: now }
  } catch (e) { return { ok: false, reason: e.message || 'retention-reminder-write-failed' } }
}

function fileMd5(fsApi, file) {
  try {
    return crypto.createHash('md5').update(fsApi.readFileSync(file)).digest('hex')
  } catch {
    return ''
  }
}

/**
 * 捕获会话期间产生的文件 → 按分类复制到 destRoot。
 * dedup=true 时：目标同名文件若大小+md5 相同则跳过（避免重复存储）。
 */
export function captureSessionFiles(cwd, start, end, destRoot, fsApi, opts = {}) {
  const copied = []
  const skipped = []
  const maxDepth = opts.maxDepth ?? 4
  const maxSize = opts.maxSize ?? 10 * 1024 * 1024
  const margin = opts.margin ?? 5 * 60 * 1000
  const dedup = opts.dedup ?? true
  const t0 = start - margin
  const t1 = (end ?? Date.now()) + margin
  const exts = opts.importantExts || defaultImportantExts()
  const destAbs = path.resolve(destRoot)
  const categories = normalizeCategories(opts.categories)

  // destRoot is the authority supplied by the registered session layout. If it
  // already exists as a reparse point, fail closed before any mkdir/copy.
  try {
    if (fsApi.existsSync(destAbs)) {
      const st = fsApi.lstatSync(destAbs)
      if (!st.isDirectory() || st.isSymbolicLink?.()) return { copied, skipped }
    }
  } catch { return { copied, skipped } }

  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let entries
    try { entries = fsApi.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (path.resolve(full) === destAbs || path.resolve(full).startsWith(destAbs + path.sep)) continue
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || DATE_DIR_RE.test(ent.name)) continue
        walk(full, depth + 1)
        continue
      }
      const ext = path.extname(ent.name).toLowerCase()
      if (!exts.includes(ext)) continue
      let st
      try { st = fsApi.statSync(full) } catch { continue }
      if (!st.isFile() || st.size > maxSize) continue
      if (st.mtimeMs < t0 || st.mtimeMs > t1) continue
      const cat = categoryOf(ent.name, categories)
      const targetDir = path.join(destRoot, cat)
      try {
        assertPhysicalPathInside(targetDir, [destAbs], fsApi)
      } catch { continue }
      try { fsApi.mkdirSync(targetDir, { recursive: true }) } catch { continue }
      let dest = path.join(targetDir, ent.name)
      let n = 1
      try { assertPhysicalPathInside(dest, [destAbs], fsApi) } catch { continue }
      let invalidDestination = false
      while (fsApi.existsSync(dest)) {
        // 去重：同名且内容一致 → 跳过
        if (dedup && fsApi.existsSync(dest)) {
          try {
            const a = fsApi.statSync(full), b = fsApi.statSync(dest)
            if (a.size === b.size && fileMd5(fsApi, full) === fileMd5(fsApi, dest)) { skipped.push(dest); break }
          } catch { /* 比较失败则按重名处理 */ }
        }
        n += 1
        dest = path.join(targetDir, `${path.parse(ent.name).name}-${n}${path.extname(ent.name)}`)
        try { assertPhysicalPathInside(dest, [destAbs], fsApi) } catch { invalidDestination = true; break }
      }
      if (invalidDestination || fsApi.existsSync(dest)) continue
      try {
        fsApi.copyFileSync(full, dest)
        copied.push(dest)
      } catch { /* 单文件失败不阻断 */ }
    }
  }
  if (cwd && fsApi.existsSync(cwd)) walk(cwd, 0)
  return { copied, skipped }
}

export function loadMapping(statePath, fsApi, onError = () => {}) {
  try {
    const { schemaVersion: _schemaVersion, ...mapping } = loadVersionedJson(statePath, { schemaVersion: 1 }, migrateLegacyV031, fsApi)
    if (Object.keys(mapping).some((id) => !isSafeSessionId(id))) throw new VersionedStateError('invalid-state-data')
    return mapping
  } catch (e) {
    if (!(e instanceof VersionedStateError)) throw e
    onError(e)
    return {}
  }
}
export function saveMapping(statePath, map, fsApi) {
  for (const id of Object.keys(map || {})) if (!isSafeSessionId(id)) throw new Error('reserved-session-id')
  atomicWriteJson(statePath, { ...(map || {}), schemaVersion: 1 }, fsApi)
}

export function isSafeSessionId(id) {
  return typeof id === 'string' && id.length > 0 && !['schemaVersion', '__proto__', 'prototype', 'constructor', '.', '..'].includes(id) && !/[\\/\u0000]/.test(id)
}

/** 创建项目/子项目环境（只预建 .cache；分类属于各会话的独立根）。 */
export function createProjectEnv(root, name, fsApi, opts = {}) {
  const rootAbs = path.resolve(root)
  let rootStat
  try { rootStat = fsApi.lstatSync(rootAbs) } catch { throw new Error(`工作区根目录不可用: ${rootAbs}`) }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink?.()) throw new Error(`工作区根目录不可用: ${rootAbs}`)
  const parent = opts.parentProject ? sanitizeName(opts.parentProject) : ''
  const clean = sanitizeName(name)
  if (!clean) throw new Error(`项目名不能为空或全为非法字符: ${name}`)
  const base = parent ? path.join(rootAbs, parent) : rootAbs
  if (!fsApi.existsSync(base)) throw new Error(`父目录不存在: ${base}`)
  if (parent) assertPhysicalPathInside(base, [rootAbs], fsApi)
  const dir = path.join(base, clean)
  assertPhysicalPathInside(dir, [base], fsApi)
  const cacheDir = path.join(dir, opts.cacheDirName || DEFAULTS.cacheDirName)
  assertPhysicalPathInside(cacheDir, [dir], fsApi)
  const readme = path.join(dir, 'README.md')
  assertPhysicalPathInside(readme, [dir], fsApi)
  fsApi.mkdirSync(dir, { recursive: true })
  fsApi.mkdirSync(cacheDir, { recursive: true })
  if (!fsApi.existsSync(readme)) {
    const kind = parent ? '子项目' : '项目'
    fsApi.writeFileSync(readme, [
      `# ${clean}`, '',
      `> ${kind}环境，创建于 ${new Date().toLocaleString('zh-CN')}`, `> 上级目录：${base}`, '',
      '## 缓存约定（Codex 式分类缓存）', '',
      `- \`.cache\\\`：项目缓存区（自动创建）`,
      `  - \`<会话短标识>\\\`：每条会话独立的完整缓存根`,
      `  - 每个会话根内含 \`会话记录\\ 文档\\ 代码\\ 配置\\ 图片\\ 压缩包\\ 其他\\\` 等分类`,
      '- 项目缓存不按日期分组；不同会话绝不共享缓存目录。', '',
      '## 归档', '',
      '对话归档为**软归档**（完整保留）；彻底删除进回收站。', '',
      '## 规则', '', '详见 `daily_conversation\\_rules.md`。', '',
    ].join('\n'), 'utf8')
  }
  return { dir, cacheDir, readme, kind: parent ? 'subproject' : 'project' }
}

/** PowerShell 回收站脚本（文件或目录，SendToRecycleBin） */
export function recycleScript(targetPath, isDirectory = true) {
  const escaped = String(targetPath).replace(/'/g, "''")
  const operation = isDirectory ? 'DeleteDirectory' : 'DeleteFile'
  return [
    '$ErrorActionPreference="Stop"',
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    `[Microsoft.VisualBasic.FileIO.FileSystem]::${operation}('${escaped}','OnlyErrorDialogs','SendToRecycleBin')`,
  ].join('; ')
}

/** 执行回收站（可注入 exec 便于测试） */
export function recyclePath(target, exec = execFile, fsApi = fs) {
  let isDirectory = true
  try { isDirectory = fsApi.statSync(target).isDirectory() } catch { return Promise.resolve({ ok: false, error: 'not-found' }) }
  return new Promise((resolvePromise) => {
    exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', recycleScript(target, isDirectory)], (err, _stdout, stderr) => {
      if (err) resolvePromise({ ok: false, error: String(err) + (stderr ? ' | ' + stderr : '') })
      else resolvePromise({ ok: true })
    })
  })
}

/** 归档目录去重：目标已存在则加 -2/-3 后缀 */
export function uniqueDir(base, fsApi) {
  let dest = base
  let n = 1
  while (fsApi.existsSync(dest)) {
    n += 1
    dest = `${base}-${n}`
  }
  return dest
}

/** Remove empty descendants only; never cross or remove the managed stop root. */
export function pruneEmptyParents(dir, stopRoot, fsApi, log = () => {}) {
  const stop = path.resolve(stopRoot)
  let current = path.resolve(dir)
  while (isPathInside(stop, current) && fsApi.existsSync(current)) {
    try {
      const stat = fsApi.lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink?.() || fsApi.readdirSync(current).length !== 0) break
      fsApi.rmdirSync(current)
      log(current)
      current = path.dirname(current)
    } catch { break }
  }
}

/**
 * 软归档：把会话缓存完整移入 对话归档\，映射保留并标记 archived。
 * 默认不删除 DSH 会话（config.archive.deleteDshSession）；归档后该会话不再自动镜像记录。
 */
export function archiveSessionFlow(sessionId, entry, deps) {
  const { fsApi, harnessRoot, config = DEFAULTS, log = () => {} } = deps
  if (!entry) return { ok: false, reason: 'no-entry', entry: null }
  const valid = validateSessionEntry(sessionId, entry, { harnessRoot, config, mapping: deps.mapping })
  if (!valid.ok) return { ok: false, reason: valid.reason, entry: null }
  try { assertSessionPhysicalPaths(sessionId, entry, valid, { harnessRoot, config, fsApi }) } catch (e) { return { ok: false, reason: e.message, entry: null } }
  if (entry.status === 'archived') return { ok: false, reason: 'already-archived', entry }

  const archiveRoot = path.join(harnessRoot, config.archiveDirName || DEFAULTS.archiveDirName)
  const archivedTo = []

  if (entry.kind === 'daily' && entry.cacheDir) {
    if (!fsApi.existsSync(entry.cacheDir)) return { ok: false, reason: 'cache-not-found', entry: null }
    const destBase = path.join(archiveRoot, '日常', entry.date || dateStr())
    const dest = uniqueDir(path.join(destBase, valid.layout.cacheName), fsApi)
    try {
      assertPhysicalPathInside(entry.cacheDir, [path.join(harnessRoot, config.dailyDirName || DEFAULTS.dailyDirName)], fsApi)
      assertPhysicalPathInside(dest, [archiveRoot], fsApi)
    } catch (e) { return { ok: false, reason: e.message, entry: null } }
    fsApi.mkdirSync(destBase, { recursive: true })
    fsApi.renameSync(entry.cacheDir, dest)
    entry.archivePath = dest
    archivedTo.push(dest)
    log(`[软归档-日常] ${entry.cacheDir} -> ${dest}`)
    // Empty daily date folders may be removed, but never daily_conversation.
    const dateDir = entry.date ? path.dirname(entry.cacheDir) : null
    if (dateDir) pruneEmptyParents(dateDir, path.join(harnessRoot, config.dailyDirName || DEFAULTS.dailyDirName), fsApi, (removed) => log(`[软归档-日常] 日期夹已空，删除: ${removed}`))
  } else if (entry.kind === 'project' && entry.cacheDir) {
    const projectName = entry.root ? path.basename(entry.root) : 'unknown'
    if (!fsApi.existsSync(entry.cacheDir)) return { ok: false, reason: 'cache-not-found', entry: null }
    const destBase = path.join(archiveRoot, '项目', projectName)
    const dest = uniqueDir(path.join(destBase, valid.layout.cacheName), fsApi)
    try {
      assertPhysicalPathInside(entry.cacheDir, [path.join(entry.root, config.cacheDirName || DEFAULTS.cacheDirName)], fsApi)
      assertPhysicalPathInside(dest, [archiveRoot], fsApi)
    } catch (e) { return { ok: false, reason: e.message, entry: null } }
    fsApi.mkdirSync(destBase, { recursive: true })
    fsApi.renameSync(entry.cacheDir, dest)
    entry.archivePath = dest
    archivedTo.push(dest)
    log(`[软归档-项目] ${projectName}/${valid.layout.cacheName} -> ${dest}`)
  } else {
    return { ok: false, reason: 'no-cache-target', entry }
  }

  entry.status = 'archived'
  entry.archivedAt = Date.now()

  // 按配置决定是否删除 DSH 会话（默认保留）
  if (config.archive?.deleteDshSession && deps.deleteDshSessionOnce) {
    try { deps.deleteDshSessionOnce(sessionId).catch((e) => log(`[DSH-删除失败] ${e.message}`)) } catch (e) { log(`[DSH-删除失败] ${e.message}`) }
  }

  return { ok: true, archivedTo, entry }
}

/** 取消归档：移回原位，状态恢复 active（并清理归档区空目录链） */
export function restoreSessionFlow(sessionId, entry, deps) {
  const { fsApi, harnessRoot, config = DEFAULTS, log = () => {} } = deps
  if (!entry) return { ok: false, reason: 'no-entry', entry: null }
  const valid = validateSessionEntry(sessionId, entry, { harnessRoot, config, mapping: deps.mapping })
  if (!valid.ok) return { ok: false, reason: valid.reason, entry: null }
  try { assertSessionPhysicalPaths(sessionId, entry, valid, { harnessRoot, config, fsApi }) } catch (e) { return { ok: false, reason: e.message, entry: null } }
  if (entry.status !== 'archived' || !entry.archivePath) return { ok: false, reason: 'not-archived', entry }

  const restoredTo = []

  if (entry.kind === 'daily' && entry.cacheDir) {
    if (!fsApi.existsSync(entry.archivePath)) return { ok: false, reason: 'archive-not-found', entry: null }
    const dateDir = path.dirname(entry.cacheDir)
    let target = entry.cacheDir
    if (entry.layoutVersion !== 2) {
      let n = 1
      while (fsApi.existsSync(target)) { n += 1; target = path.join(dateDir, `${entry.tag}-${n}`) }
    } else if (fsApi.existsSync(target)) return { ok: false, reason: 'cache-root-exists', entry }
    try {
      assertPhysicalPathInside(entry.archivePath, [path.join(harnessRoot, config.archiveDirName || DEFAULTS.archiveDirName)], fsApi)
      assertPhysicalPathInside(dateDir, [path.join(harnessRoot, config.dailyDirName || DEFAULTS.dailyDirName)], fsApi)
      assertPhysicalPathInside(target, [path.join(harnessRoot, config.dailyDirName || DEFAULTS.dailyDirName)], fsApi)
    } catch (e) { return { ok: false, reason: e.message, entry: null } }
    fsApi.mkdirSync(dateDir, { recursive: true })
    fsApi.renameSync(entry.archivePath, target)
    const restoredTag = entry.layoutVersion === 2 ? entry.tag : path.basename(target)
    const restoredLayout = cacheLayoutFor({ ...entry, tag: restoredTag }, { harnessRoot, dailyDirName: config.dailyDirName, cacheDirName: config.cacheDirName })
    entry.tag = restoredTag
    entry.cacheDir = restoredLayout.base
    entry.recordFile = restoredLayout.recordFile
    entry.manifestFile = path.join(restoredLayout.recordDir, `${restoredTag}.清单.md`)
    restoredTo.push(target)
    log(`[取消归档-日常] ${entry.archivePath} -> ${target}`)
    pruneEmptyParents(path.dirname(entry.archivePath), path.join(harnessRoot, config.archiveDirName || DEFAULTS.archiveDirName), fsApi, (removed) => log(`[取消归档-清理空目录] ${removed}`))
  } else if (entry.kind === 'project' && entry.cacheDir) {
    if (!fsApi.existsSync(entry.archivePath)) return { ok: false, reason: 'archive-not-found', entry: null }
    if (fsApi.existsSync(entry.cacheDir)) return { ok: false, reason: 'cache-root-exists', entry }
    try {
      assertPhysicalPathInside(entry.archivePath, [path.join(harnessRoot, config.archiveDirName || DEFAULTS.archiveDirName)], fsApi)
      assertPhysicalPathInside(entry.cacheDir, [path.join(entry.root, config.cacheDirName || DEFAULTS.cacheDirName)], fsApi)
    } catch (e) { return { ok: false, reason: e.message, entry: null } }
    fsApi.mkdirSync(path.dirname(entry.cacheDir), { recursive: true })
    fsApi.renameSync(entry.archivePath, entry.cacheDir)
    restoredTo.push(entry.cacheDir)
    pruneEmptyParents(path.dirname(entry.archivePath), path.join(harnessRoot, config.archiveDirName || DEFAULTS.archiveDirName), fsApi, (removed) => log(`[取消归档-清理空目录] ${removed}`))
    log(`[取消归档-项目] ${entry.archivePath} -> ${entry.cacheDir}`)
  } else {
    return { ok: false, reason: 'no-restore-target', entry }
  }

  delete entry.archivePath
  delete entry.archivedAt
  entry.status = 'active'
  const revalidated = validateSessionEntry(sessionId, entry, { harnessRoot, config, mapping: deps.mapping })
  if (!revalidated.ok) return { ok: false, reason: revalidated.reason, entry: null }
  return { ok: true, restoredTo, entry }
}

/**
 * 彻底删除：回收站清理归档（或缓存）文件，按配置删除 DSH 会话，移除映射。
 * config.purge.deleteDshSession 默认 true。
 */
export async function purgeSessionFlow(sessionId, entry, deps) {
  const { fsApi, harnessRoot, config = DEFAULTS, recycle = recyclePath, log = () => {} } = deps
  if (!entry) return { ok: false, reason: 'no-entry' }
  const valid = validateSessionEntry(sessionId, entry, { harnessRoot, config, mapping: deps.mapping })
  if (!valid.ok) return { ok: false, reason: valid.reason }
  try { assertSessionPhysicalPaths(sessionId, entry, valid, { harnessRoot, config, fsApi }) } catch (e) { return { ok: false, reason: e.message } }
  if (entry.status !== 'archived') return { ok: false, reason: 'not-archived' }
  const target = entry.archivePath
  if (!target || !fsApi.existsSync(target)) return { ok: false, reason: 'archive-not-found' }
  try { assertPhysicalPathInside(target, [path.join(harnessRoot, config.archiveDirName || DEFAULTS.archiveDirName)], fsApi) } catch (e) { return { ok: false, reason: e.message } }
  const targetContainsDshSession = fsApi.existsSync(path.join(target, '.dsh-session'))
  const recycled = []
  const protectedFiles = []

  // 重要文件防误删：Task 5 retention is a strict pre-recycle transaction.
  // The legacy copy fallback remains for callers that have not mounted DSH AI.
  if (target && fsApi.existsSync(target)) {
    if (deps.retain) {
      let retained
      try { retained = await deps.retain({ sessionId, entry, target }) } catch { retained = { ok: false, reason: 'ai-review-failed' } }
      if (!retained?.ok) return { ok: false, reason: retained?.reason || 'ai-review-failed', recycled, protectedFiles }
      for (const item of retained.retained || []) protectedFiles.push(item.path || item)
      if (protectedFiles.length > 0) log(`[重要文件保留] ${protectedFiles.length} 个文件已验证保存`)
    } else {
      const protectRoot = path.join(harnessRoot, config.protectDirName || DEFAULTS.protectDirName)
      try { assertPhysicalPathInside(protectRoot, [harnessRoot], fsApi) } catch (e) { return { ok: false, reason: e.message, recycled, protectedFiles } }
      const protectedPaths = protectImportantFiles(target, protectRoot, fsApi, config, harnessRoot)
      for (const p of protectedPaths) protectedFiles.push(p)
      if (protectedFiles.length > 0) log(`[重要文件保护] ${protectedFiles.length} 个文件已复制到 ${protectRoot}`)
    }

    const r = await recycle(target)
    if (r.ok) { recycled.push(target); log(`[彻底删除-回收站] ${target}`) }
    else { log(`[彻底删除-回收站失败] ${target}: ${r.error}`); return { ok: false, reason: r.error || 'recycle-failed', recycled, protectedFiles } }

    // DSH owns its log independently of the plugin cache. Recycle it only
    // after the plugin cache has entered the system recycle bin. A failure at
    // this point is an explicit recoverable partial transaction: the native
    // archived id remains until a later retry can finish this second recycle.
    if (config.purge?.deleteDshSession && deps.deleteDshSessionOnce && !targetContainsDshSession) {
      try {
        const dsh = await deps.deleteDshSessionOnce(sessionId)
        if (!dsh?.ok) return { ok: false, reason: dsh?.reason || 'dsh-recycle-failed', recycled, protectedFiles, partialPhase: 'cache-recycled-dsh-pending' }
      } catch (e) {
        log(`[DSH-删除失败] ${e.message}`)
        return { ok: false, reason: e.message || 'dsh-recycle-failed', recycled, protectedFiles, partialPhase: 'cache-recycled-dsh-pending' }
      }
    }
  }

  // 归档区日期夹空则清理
  if (entry.status === 'archived' && entry.kind === 'daily' && entry.archivePath) {
    const dateDir = path.dirname(entry.archivePath)
    try {
      if (fsApi.existsSync(dateDir) && fsApi.readdirSync(dateDir).length === 0) { fsApi.rmdirSync(dateDir); log(`[彻底删除-归档日期夹] 已空删除: ${dateDir}`) }
    } catch { /* 忽略 */ }
  }

  return { ok: true, recycled, protectedFiles }
}

/** 批处理：多会话依次执行（一个失败不阻断其余） */
export async function runMany(ids, fn) {
  const results = []
  for (const id of ids) {
    try {
      const result = await fn(id)
      results.push({ id, ok: result?.ok === true, result })
    }
    catch (e) { results.push({ id, ok: false, error: String(e?.message || e) }) }
  }
  return results
}

const BACKUP_SCHEMA_VERSION = 1
const BACKUP_DAY_MS = 24 * 60 * 60 * 1000

function backupSettings(config = DEFAULTS) {
  const raw = config.backup || {}
  const days = Math.max(0, Math.floor(Number(raw.autoIntervalDays) || 0))
  const mode = ['off', 'periodic', 'shutdown'].includes(raw.mode) ? raw.mode : 'periodic'
  return {
    enabled: raw.enabled !== false && mode !== 'off',
    mode,
    targetDir: typeof raw.targetDir === 'string' ? raw.targetDir : '',
    autoIntervalDays: days,
    keepCount: Math.max(1, Math.min(100, Math.floor(Number(raw.keepCount) || 5))),
  }
}

function psQuote(value) { return `'${String(value).replace(/'/g, "''")}'` }

function backupStatePathFor(deps) {
  return path.resolve(deps.backupStatePath || path.join(deps.stateRoot || path.dirname(deps.statePath || ''), 'backups.json'))
}

function isBackupFileName(value) {
  return typeof value === 'string' && /^conversation-archive-backup-[A-Za-z0-9-]+\.zip$/i.test(value) && path.basename(value) === value
}

function isBackupId(value) { return typeof value === 'string' && /^backup-[A-Za-z0-9-]{8,80}$/i.test(value) }

/** Local folders and mounted/UNC shares only; URLs are deliberately unsupported. */
export function isBackupTargetPath(value) {
  return typeof value === 'string' && value.trim() !== '' && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) &&
    (path.isAbsolute(value) || path.win32.isAbsolute(value))
}

function assertNoReparsePath(target, fsApi) {
  let current = path.resolve(target)
  while (true) {
    if (fsApi.existsSync(current)) {
      const st = fsApi.lstatSync(current)
      if (st.isSymbolicLink?.()) throw new Error('path-reparse-escape')
    }
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

function ensureBackupTarget(targetDir, fsApi, create = false) {
  if (!isBackupTargetPath(targetDir)) throw new Error('invalid-backup-target')
  assertNoReparsePath(targetDir, fsApi)
  if (create) fsApi.mkdirSync(targetDir, { recursive: true })
  if (!fsApi.existsSync(targetDir)) throw new Error('backup-target-missing')
  const st = fsApi.lstatSync(targetDir)
  if (!st.isDirectory() || st.isSymbolicLink?.()) throw new Error('invalid-backup-target')
  assertNoReparsePath(targetDir, fsApi)
  return path.resolve(targetDir)
}

function loadBackupState(deps) {
  const { fsApi, stateRoot } = deps
  const file = backupStatePathFor(deps)
  assertPhysicalPathInside(stateRoot, [path.dirname(stateRoot)], fsApi)
  assertPhysicalPathInside(file, [stateRoot], fsApi)
  const record = loadVersionedJson(file, { schemaVersion: BACKUP_SCHEMA_VERSION, backups: [], nextBackupAt: '' }, migrateLegacyV031, fsApi)
  if (!Array.isArray(record.backups) || (record.nextBackupAt && !Number.isFinite(Date.parse(record.nextBackupAt)))) throw new Error('invalid-backup-state')
  const backups = record.backups.filter((item) => item && isBackupId(item.id) && isBackupFileName(item.fileName) && Number.isFinite(Date.parse(item.createdAt || '')))
  if (backups.length !== record.backups.length) throw new Error('invalid-backup-state')
  return { schemaVersion: BACKUP_SCHEMA_VERSION, backups, nextBackupAt: record.nextBackupAt || '' }
}

function saveBackupState(state, deps) {
  atomicWriteJson(backupStatePathFor(deps), { schemaVersion: BACKUP_SCHEMA_VERSION, backups: state.backups, nextBackupAt: state.nextBackupAt || '' }, deps.fsApi)
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return ''
  const normalized = value.replaceAll('\\', '/')
  if (normalized.startsWith('/') || path.posix.isAbsolute(normalized) || normalized.split('/').some((part) => !part || part === '.' || part === '..')) return ''
  return normalized
}

function safeFilesInTree(root, trustedRoot, fsApi) {
  const base = path.resolve(root)
  if (!samePath(base, trustedRoot)) assertPhysicalPathInside(base, [trustedRoot], fsApi)
  const baseStat = fsApi.lstatSync(base)
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink?.()) throw new Error('backup-reparse-source')
  const files = []
  const walk = (dir) => {
    if (!samePath(dir, base)) assertPhysicalPathInside(dir, [base], fsApi)
    const st = fsApi.lstatSync(dir)
    if (!st.isDirectory() || st.isSymbolicLink?.()) throw new Error('backup-reparse-source')
    for (const ent of fsApi.readdirSync(dir, { withFileTypes: true })) {
      const item = path.join(dir, ent.name)
      assertPhysicalPathInside(item, [base], fsApi)
      const itemStat = fsApi.lstatSync(item)
      if (itemStat.isSymbolicLink?.()) throw new Error('backup-reparse-source')
      if (itemStat.isDirectory()) walk(item)
      else if (itemStat.isFile()) files.push({ path: item, relativePath: safeRelativePath(path.relative(base, item)) })
      else throw new Error('backup-unsupported-source')
    }
  }
  walk(base)
  if (files.some((file) => !file.relativePath)) throw new Error('backup-invalid-relative-path')
  return files
}

function safeSingleFile(file, trustedRoot, fsApi) {
  const source = assertPhysicalPathInside(file, [trustedRoot], fsApi)
  const st = fsApi.lstatSync(source)
  if (!st.isFile() || st.isSymbolicLink?.()) throw new Error('backup-reparse-source')
  return source
}

function retainedBackupSource(id, deps) {
  const { fsApi, retainedRoot, retainedIndexPath, stateRoot, harnessRoot } = deps
  assertPhysicalPathInside(retainedRoot, [harnessRoot], fsApi)
  assertPhysicalPathInside(retainedIndexPath, [stateRoot], fsApi)
  const index = loadVersionedJson(retainedIndexPath, { schemaVersion: 1, files: {} }, migrateLegacyV031, fsApi)
  const record = index.files?.[id]
  const filesRoot = path.join(retainedRoot, 'files')
  if (!record || record.sha256 !== id || !/^[a-f0-9]{64}$/i.test(id) || typeof record.path !== 'string') throw new Error('unknown-backup-selection')
  const source = safeSingleFile(record.path, filesRoot, fsApi)
  if (sha256File(source, fsApi) !== id) throw new Error('retention-hash-mismatch')
  return { kind: 'file', source, trustedRoot: filesRoot, stagePath: `retained/${path.basename(source)}` }
}

function sessionBackupSource(id, deps) {
  const { fsApi, harnessRoot, config = DEFAULTS, mapping = {} } = deps
  const entry = mapping[id]
  const valid = validateSessionEntry(id, entry, { harnessRoot, config, mapping })
  if (!valid.ok) throw new Error('unknown-backup-selection')
  assertSessionPhysicalPaths(id, entry, valid, { harnessRoot, config, fsApi })
  const source = entry.status === 'archived' ? entry.archivePath : valid.layout.base
  const trustedRoot = entry.status === 'archived' ? path.join(harnessRoot, config.archiveDirName || DEFAULTS.archiveDirName) : valid.layout.base
  if (!source || !fsApi.existsSync(source)) throw new Error('backup-source-missing')
  return { kind: 'tree', source, trustedRoot, stagePath: `sessions/${id}` }
}

function resolveBackupSelection(selection, deps) {
  const type = selection?.type || 'all'
  const ids = Array.isArray(selection?.ids) ? [...new Set(selection.ids.map(String))] : []
  if (!['all', 'retained', 'session', 'project'].includes(type) || (type !== 'all' && ids.length === 0)) throw new Error('invalid-backup-selection')
  if ((type === 'session' || type === 'project') && ids.length !== 1) throw new Error('invalid-backup-selection')
  const sources = []
  if (type === 'retained' || type === 'all') {
    const selected = type === 'all'
      ? Object.keys(loadVersionedJson(deps.retainedIndexPath, { schemaVersion: 1, files: {} }, migrateLegacyV031, deps.fsApi).files || {})
      : ids
    for (const id of selected) sources.push(retainedBackupSource(id, deps))
  }
  if (type === 'session' || type === 'all') {
    const selected = type === 'all' ? Object.keys(deps.mapping || {}) : ids
    for (const id of selected) {
      try { sources.push(sessionBackupSource(id, deps)) }
      catch (e) {
        // "All" skips stale/legacy registrations but never silently skips a
        // real managed tree that failed a physical safety check.
        if (type !== 'all' || !['unknown-backup-selection', 'backup-source-missing'].includes(e.message)) throw e
      }
    }
  }
  if (type === 'project') {
    const selected = sessionBackupSource(ids[0], deps)
    const first = deps.mapping[ids[0]]
    if (first.kind !== 'project') throw new Error('unknown-backup-selection')
    const projectKey = crypto.createHash('sha256').update(path.resolve(first.root)).digest('hex').slice(0, 12)
    for (const [id, entry] of Object.entries(deps.mapping || {})) {
      if (entry?.kind !== 'project' || path.resolve(entry.root || '') !== path.resolve(first.root)) continue
      const source = sessionBackupSource(id, deps)
      source.stagePath = `projects/${projectKey}/${id}`
      sources.push(source)
    }
    if (sources.length === 0) sources.push(selected)
  }
  const unique = new Map()
  for (const source of sources) unique.set(`${source.stagePath}\0${source.source}`, source)
  if (unique.size === 0) throw new Error('no-backup-sources')
  return [...unique.values()]
}

function copyBackupSources(sources, stageRoot, fsApi) {
  const files = []
  for (const source of sources) {
    const from = source.kind === 'tree' ? safeFilesInTree(source.source, source.trustedRoot, fsApi) : [{ path: safeSingleFile(source.source, source.trustedRoot, fsApi), relativePath: '' }]
    for (const item of from) {
      const relative = safeRelativePath(source.kind === 'tree' ? `${source.stagePath}/${item.relativePath}` : source.stagePath)
      if (!relative) throw new Error('backup-invalid-relative-path')
      const dest = path.join(stageRoot, ...relative.split('/'))
      assertPhysicalPathInside(dest, [stageRoot], fsApi)
      fsApi.mkdirSync(path.dirname(dest), { recursive: true })
      assertPhysicalPathInside(path.dirname(dest), [stageRoot], fsApi)
      fsApi.copyFileSync(item.path, dest)
      const stat = fsApi.statSync(dest)
      const sha256 = sha256File(item.path, fsApi)
      if (stat.size !== fsApi.statSync(item.path).size || sha256File(dest, fsApi) !== sha256) throw new Error('backup-copy-verification-failed')
      files.push({ path: relative, size: stat.size, sha256 })
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function runPowerShell(script, exec = execFile) {
  return new Promise((resolve, reject) => {
    exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr || '') }))
      else resolve(String(stdout || ''))
    })
  })
}

async function extractBackup(zipPath, destination, deps) {
  const script = [
    'Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$zip=[IO.Compression.ZipFile]::OpenRead(${psQuote(zipPath)})`,
    'try { foreach ($entry in $zip.Entries) { $name=$entry.FullName; if ([IO.Path]::IsPathRooted($name) -or $name -match \'^[A-Za-z]:\' -or $name -match \'(^|[\\\\/])\\.\\.([\\\\/]|$)\') { throw \'backup-zip-slip\' } } } finally { $zip.Dispose() }',
    `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destination)} -Force`,
  ].join('; ')
  try { await runPowerShell(script, deps.exec || execFile) }
  catch (e) { throw new Error(`${e?.message || ''} ${e?.stderr || ''}`.includes('backup-zip-slip') ? 'backup-zip-slip' : 'backup-verification-failed') }
}

function verifyExtractedManifest(extractRoot, fsApi) {
  const manifestPath = path.join(extractRoot, 'manifest.json')
  let manifest
  try { manifest = JSON.parse(fsApi.readFileSync(manifestPath, 'utf8')) } catch { throw new Error('backup-manifest-invalid') }
  if (!manifest || manifest.schemaVersion !== BACKUP_SCHEMA_VERSION || !Array.isArray(manifest.files)) throw new Error('backup-manifest-invalid')
  const expected = new Map()
  for (const item of manifest.files) {
    if (!item || !safeRelativePath(item.path) || !Number.isInteger(item.size) || item.size < 0 || !/^[a-f0-9]{64}$/i.test(item.sha256) || expected.has(item.path)) throw new Error('backup-manifest-invalid')
    expected.set(item.path, item)
  }
  const actual = safeFilesInTree(extractRoot, extractRoot, fsApi).filter((item) => item.relativePath !== 'manifest.json')
  if (actual.length !== expected.size) throw new Error('backup-manifest-mismatch')
  for (const item of actual) {
    const record = expected.get(item.relativePath)
    if (!record || fsApi.statSync(item.path).size !== record.size || sha256File(item.path, fsApi) !== record.sha256) throw new Error('backup-manifest-mismatch')
  }
  return manifest
}

function backupRecord(id, deps) {
  if (!isBackupId(id)) return null
  const state = loadBackupState(deps)
  return state.backups.find((item) => item.id === id) || null
}

function trustedBackupPath(record, deps) {
  const targetDir = ensureBackupTarget(backupSettings(deps.config).targetDir, deps.fsApi)
  if (!record || !isBackupFileName(record.fileName)) throw new Error('unknown-backup-id')
  const zipPath = assertPhysicalPathInside(path.join(targetDir, record.fileName), [targetDir], deps.fsApi)
  if (!deps.fsApi.existsSync(zipPath)) throw new Error('backup-archive-missing')
  const st = deps.fsApi.lstatSync(zipPath)
  if (!st.isFile() || st.isSymbolicLink?.()) throw new Error('backup-archive-missing')
  return zipPath
}

async function verifyArchivePath(zipPath, deps, root = deps.stateRoot) {
  const { fsApi } = deps
  const parent = path.resolve(root)
  assertPhysicalPathInside(parent, [path.dirname(parent)], fsApi)
  const temp = fsApi.mkdtempSync(path.join(parent, 'backup-verify-'))
  try {
    await extractBackup(zipPath, temp, deps)
    return { ok: true, manifest: verifyExtractedManifest(temp, fsApi) }
  } catch (e) {
    return { ok: false, reason: e.message === 'backup-zip-slip' ? 'backup-zip-slip' : 'backup-verification-failed' }
  } finally {
    try { fsApi.rmSync(temp, { recursive: true, force: true }) } catch { /* plugin-created temporary directory */ }
  }
}

/** Calculate the persisted due time; timer cadence is deliberately irrelevant. */
export function scheduleNextBackup(now, config = {}) {
  const raw = config.backup || config
  const days = Math.max(0, Math.floor(Number(raw.autoIntervalDays) || 0))
  const at = new Date(now)
  if (!Number.isFinite(at.getTime()) || days < 1) return ''
  return new Date(at.getTime() + days * BACKUP_DAY_MS).toISOString()
}

/** Return the oldest verified records/files that exceed the configured retention count. */
export function selectExpiredBackups(backups, keepCount = 5) {
  const keep = Math.max(1, Math.floor(Number(keepCount) || 5))
  return [...(Array.isArray(backups) ? backups : [])]
    .sort((a, b) => String(typeof a === 'string' ? a : a?.createdAt || a?.fileName).localeCompare(String(typeof b === 'string' ? b : b?.createdAt || b?.fileName)))
    .slice(0, Math.max(0, (backups?.length || 0) - keep))
}

/** Client-safe backup catalogue: IDs and metadata only, never target paths. */
export function listBackups(deps) {
  try {
    return loadBackupState(deps).backups
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(({ id, createdAt, fileCount, byteSize }) => ({ id, createdAt, fileCount, byteSize }))
  } catch { return [] }
}

/** Create a verified ZIP from typed registered selections only. */
export async function createBackup(selection, deps) {
  const { fsApi, stateRoot, config = DEFAULTS, log = () => {} } = deps
  const settings = backupSettings(config)
  if (!settings.targetDir) return { ok: false, reason: 'backup-target-not-configured' }
  let stage = ''
  let tempZip = ''
  let finalZip = ''
  let published = false
  try {
    const targetDir = ensureBackupTarget(settings.targetDir, fsApi, true)
    const sources = resolveBackupSelection(selection, deps)
    if (sources.some((source) => source.kind === 'tree' && (samePath(source.source, targetDir) || isPathInside(source.source, targetDir)))) throw new Error('backup-target-overlaps-source')
    assertPhysicalPathInside(stateRoot, [path.dirname(stateRoot)], fsApi)
    stage = fsApi.mkdtempSync(path.join(stateRoot, 'backup-stage-'))
    const files = copyBackupSources(sources, stage, fsApi)
    if (files.length === 0) throw new Error('no-backup-sources')
    const now = typeof deps.now === 'function' ? new Date(deps.now()) : new Date()
    if (!Number.isFinite(now.getTime())) throw new Error('invalid-backup-time')
    const id = `backup-${crypto.randomUUID()}`
    const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const fileName = `conversation-archive-backup-${stamp}-${id.slice(-8)}.zip`
    tempZip = path.join(targetDir, `.${id}.tmp.zip`)
    finalZip = path.join(targetDir, fileName)
    atomicWriteJson(path.join(stage, 'manifest.json'), { schemaVersion: BACKUP_SCHEMA_VERSION, createdAt: now.toISOString(), files }, fsApi)
    const compress = `$items=Get-ChildItem -Force -LiteralPath ${psQuote(stage)}; Compress-Archive -LiteralPath $items.FullName -DestinationPath ${psQuote(tempZip)} -Force`
    await runPowerShell(compress, deps.exec || execFile)
    const verified = await verifyArchivePath(tempZip, deps)
    if (!verified.ok) throw new Error(verified.reason)
    fsApi.renameSync(tempZip, finalZip)
    tempZip = ''
    const previous = loadBackupState(deps)
    const completedAt = new Date()
    const record = { id, fileName, createdAt: now.toISOString(), completedAt: completedAt.toISOString(), fileCount: files.length, byteSize: files.reduce((sum, item) => sum + item.size, 0) }
    let state = { ...previous, backups: [...previous.backups, record], nextBackupAt: scheduleNextBackup(completedAt, settings) }
    saveBackupState(state, deps)
    published = true
    const retentionErrors = []
    for (const old of selectExpiredBackups(state.backups, settings.keepCount)) {
      try {
        const oldPath = trustedBackupPath(old, deps)
        const verifiedOld = await verifyArchivePath(oldPath, deps)
        if (!verifiedOld.ok) { retentionErrors.push(old.id); continue }
        // Persist removal before recycle. A state-write failure therefore leaves
        // both the old archive and its catalogue entry retryable, while a
        // successfully published newest archive is never rolled back.
        const pruned = { ...state, backups: state.backups.filter((item) => item.id !== old.id) }
        try { saveBackupState(pruned, deps) }
        catch { retentionErrors.push(old.id); continue }
        const recycled = await (deps.recycle || ((item) => recyclePath(item, undefined, fsApi)))(oldPath)
        if (!recycled?.ok) {
          // The archive remains on disk. Restore its catalogue entry when
          // possible; if this second write fails it is still an unlisted,
          // recoverable physical archive rather than a dangling record.
          try { saveBackupState(state, deps) } catch { /* best effort */ }
          retentionErrors.push(old.id)
          continue
        }
        state = pruned
      } catch { retentionErrors.push(old.id) }
    }
    log(`[备份] ${id}（${files.length} 文件）`)
    return { ok: true, id, createdAt: record.createdAt, completedAt: record.completedAt, fileCount: record.fileCount, retentionErrors }
  } catch (e) {
    if (!published && finalZip && fsApi.existsSync(finalZip)) try { fsApi.unlinkSync(finalZip) } catch { /* newly-created unpublished archive */ }
    return { ok: false, reason: e.message === 'backup-zip-slip' ? 'backup-zip-slip' : (e.message || 'backup-failed') }
  } finally {
    try { if (tempZip && fsApi.existsSync(tempZip)) fsApi.unlinkSync(tempZip) } catch { /* temporary archive */ }
    try { if (stage) fsApi.rmSync(stage, { recursive: true, force: true }) } catch { /* temporary stage */ }
  }
}

/** Re-extract and hash-check a trusted catalogued archive. */
export async function verifyBackup(id, deps) {
  try { return await verifyArchivePath(trustedBackupPath(backupRecord(id, deps), deps), deps) }
  catch (e) { return { ok: false, reason: e.message || 'backup-verification-failed' } }
}

/** Restore a verified archive only into an existing empty, non-reparse directory. */
export async function restoreBackup(id, targetDir, deps) {
  const { fsApi } = deps
  let temp = ''
  try {
    if (typeof targetDir !== 'string' || !fsApi.existsSync(targetDir)) throw new Error('restore-target-missing')
    const target = path.resolve(targetDir)
    const st = fsApi.lstatSync(target)
    if (!st.isDirectory() || st.isSymbolicLink?.()) throw new Error('restore-target-unsafe')
    assertNoReparsePath(target, fsApi)
    if (fsApi.readdirSync(target).length !== 0) throw new Error('restore-target-not-empty')
    const zipPath = trustedBackupPath(backupRecord(id, deps), deps)
    const parent = path.dirname(target)
    assertNoReparsePath(parent, fsApi)
    temp = fsApi.mkdtempSync(path.join(parent, '.dca-restore-'))
    await extractBackup(zipPath, temp, deps)
    verifyExtractedManifest(temp, fsApi)
    if (fsApi.readdirSync(target).length !== 0) throw new Error('restore-target-not-empty')
    const moved = []
    try {
      for (const name of fsApi.readdirSync(temp)) {
        const source = path.join(temp, name)
        const dest = path.join(target, name)
        assertPhysicalPathInside(source, [temp], fsApi)
        assertPhysicalPathInside(dest, [target], fsApi)
        fsApi.renameSync(source, dest)
        moved.push({ source, dest })
      }
    } catch (e) {
      for (const item of moved.reverse()) {
        try { if (fsApi.existsSync(item.dest) && !fsApi.existsSync(item.source)) fsApi.renameSync(item.dest, item.source) } catch { /* leave target untouched where rollback succeeded */ }
      }
      throw e
    }
    return { ok: true, id }
  } catch (e) {
    return { ok: false, reason: e.message === 'backup-zip-slip' ? 'backup-zip-slip' : (e.message || 'backup-restore-failed') }
  } finally {
    try { if (temp) fsApi.rmSync(temp, { recursive: true, force: true }) } catch { /* temporary restore stage */ }
  }
}

/** Run at most one persisted overdue backup, then base the next deadline on completion. */
export async function runOverdueBackup(now, deps) {
  const settings = backupSettings(deps.config)
  if (!settings.enabled || settings.mode !== 'periodic' || settings.autoIntervalDays < 1 || !settings.targetDir) return { ran: false, reason: 'backup-schedule-disabled' }
  try {
    const state = loadBackupState(deps)
    const instant = new Date(now)
    if (!Number.isFinite(instant.getTime())) return { ran: false, reason: 'invalid-backup-time' }
    if (!state.nextBackupAt) {
      state.nextBackupAt = scheduleNextBackup(instant, settings)
      saveBackupState(state, deps)
      return { ran: false, scheduled: true, nextBackupAt: state.nextBackupAt }
    }
    if (Date.parse(state.nextBackupAt) > instant.getTime()) return { ran: false, nextBackupAt: state.nextBackupAt }
    const create = deps.create || createBackup
    const result = await create({ type: 'all' }, { ...deps, now: () => instant })
    if (!result?.ok) return { ran: true, ok: false, result }
    const current = loadBackupState(deps)
    const completed = result.completedAt && Number.isFinite(Date.parse(result.completedAt)) ? new Date(result.completedAt) : new Date()
    current.nextBackupAt = scheduleNextBackup(completed, settings)
    saveBackupState(current, deps)
    return { ran: true, ok: true, result, nextBackupAt: current.nextBackupAt }
  } catch (e) { return { ran: false, reason: e.message || 'backup-schedule-failed' } }
}

/** Safe schedule metadata for the settings UI. */
export function backupScheduleView(deps) {
  try {
    const state = loadBackupState(deps)
    return { nextBackupAt: state.nextBackupAt || '' }
  } catch { return { nextBackupAt: '' } }
}

/** Rebase a changed periodic schedule instead of retaining a stale deadline. */
export function resetBackupSchedule(now, deps) {
  try {
    const state = loadBackupState(deps)
    const settings = backupSettings(deps.config)
    state.nextBackupAt = settings.enabled && settings.mode === 'periodic' && settings.autoIntervalDays > 0 && settings.targetDir
      ? scheduleNextBackup(now, settings) : ''
    saveBackupState(state, deps)
    return { ok: true, nextBackupAt: state.nextBackupAt }
  } catch (e) { return { ok: false, reason: e.message || 'backup-schedule-write-failed' } }
}

/** Compatibility wrapper for the existing slash command; it now uses verified typed sources. */
export async function backupFlow(deps) { return createBackup({ type: 'all' }, deps) }

/**
 * 孤儿映射 GC：active 条目缓存夹缺失且会话既非 live 也非 persisted → 移除；
 * archived 条目归档路径缺失 → 移除。
 * liveIds / persistedIds 由调用方提供（ctx.sessions.list() 与 sessionPersistence.listSnapshots()）。
 */
export function orphanGC(mapping, { liveIds = new Set(), persistedIds = new Set(), fsApi, log = () => {} }) {
  const removed = []
  for (const [id, entry] of Object.entries(mapping)) {
    try {
      if (entry.status === 'archived') {
        if (entry.archivePath && !fsApi.existsSync(entry.archivePath)) { delete mapping[id]; removed.push({ id, reason: 'archived-path-missing' }) }
      } else {
        const known = liveIds.has(id) || persistedIds.has(id)
        if (entry.cacheDir && !fsApi.existsSync(entry.cacheDir) && !known) {
          delete mapping[id]
          removed.push({ id, reason: 'orphan-cache' })
        }
      }
    } catch { /* 单条失败跳过 */ }
  }
  if (removed.length > 0) log(`[GC] 清理孤儿映射 ${removed.length} 条: ${removed.map((r) => `${r.id}(${r.reason})`).join(', ')}`)
  return removed
}

/** 目录总大小（字节） */
export function dirSize(dir, fsApi) {
  let total = 0
  try {
    for (const ent of fsApi.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      try {
        if (ent.isDirectory()) total += dirSize(p, fsApi)
        else if (ent.isFile()) total += fsApi.statSync(p).size
      } catch { /* 忽略 */ }
    }
  } catch { /* 忽略 */ }
  return total
}

const DATE_DIR_RE_EXPORT = /^\d{4}-\d{2}-\d{2}$/

/**
 * 扫描"可清理缓存"候选（供 AI 审核后删除）：
 * - 项目 .cache 空分类目录 / 日常区空日期目录 / 归档区空目录（安全）
 * - DSH 孤儿会话目录（~/.dsh/sessions 下无映射、非 live、非 persisted）（安全）
 * - 旧备份（保留最近 5 个）（安全）
 * 每项附 path/kind/size/reason；是否删除仍需 AI 审核 + 用户确认。
 */
export function scanCacheCandidates(deps) {
  const { fsApi, harnessRoot, config = DEFAULTS, dshHome = '', liveIds = new Set(), persistedIds = new Set(), mapping = {}, log = () => {} } = deps
  const out = []
  const push = (p, kind, size, reason) => { try { if (fsApi.existsSync(p)) out.push({ path: p, kind, size, reason }) } catch { /* 忽略 */ } }

  // 1) 只扫描已登记会话根内的空分类目录；绝不把项目共享 .cache
  // 或旧版未知目录当成插件可删除内容。
  for (const [id, entry] of Object.entries(mapping || {})) {
    const valid = validateSessionEntry(id, entry, { harnessRoot, config, mapping })
    if (!valid.ok || !fsApi.existsSync(valid.layout.base)) continue
    for (const category of CATEGORY_DIRS) {
      const candidate = valid.layout.categoryDir(category)
      try {
        assertPhysicalPathInside(candidate, [valid.layout.base], fsApi)
        if (fsApi.existsSync(candidate) && fsApi.readdirSync(candidate).length === 0) push(candidate, 'empty-cache-dir', 0, '会话缓存内空分类目录')
      } catch { /* ignore untrusted/reparse candidates */ }
    }
  }
  // 2) 日常区空日期目录
  const dailyDir = path.join(harnessRoot, config.dailyDirName || DEFAULTS.dailyDirName)
  if (fsApi.existsSync(dailyDir)) {
    for (const d of fsApi.readdirSync(dailyDir)) {
      if (!DATE_DIR_RE_EXPORT.test(d)) continue
      const p = path.join(dailyDir, d)
      try { if (fsApi.readdirSync(p).length === 0) push(p, 'empty-date-dir', 0, '空日期目录') } catch { /* 忽略 */ }
    }
  }
  // 3) 归档区空目录（递归）
  const archiveRoot = path.join(harnessRoot, config.archiveDirName || DEFAULTS.archiveDirName)
  const walkEmpty = (dir) => {
    if (!fsApi.existsSync(dir)) return
    let entries = []
    try { entries = fsApi.readdirSync(dir) } catch { return }
    for (const n of entries) {
      const p = path.join(dir, n)
      let st
      try { st = fsApi.statSync(p) } catch { continue }
      if (st.isDirectory()) walkEmpty(p)
    }
    try { if (fsApi.readdirSync(dir).length === 0 && dir !== archiveRoot) push(dir, 'empty-archive-dir', 0, '归档区空目录') } catch { /* 忽略 */ }
  }
  if (fsApi.existsSync(archiveRoot)) walkEmpty(archiveRoot)
  // 4) DSH 孤儿会话目录
  if (dshHome) {
    const sessionsRoot = path.join(dshHome, 'sessions')
    if (fsApi.existsSync(sessionsRoot)) {
      for (const proj of fsApi.readdirSync(sessionsRoot)) {
        const projDir = path.join(sessionsRoot, proj)
        try { if (!fsApi.statSync(projDir).isDirectory()) continue } catch { continue }
        for (const id of fsApi.readdirSync(projDir)) {
          if (mapping[id]) continue
          if (liveIds.has(id) || persistedIds.has(id)) continue
          const p = path.join(projDir, id)
          try { if (!fsApi.statSync(p).isDirectory()) continue } catch { continue }
          push(p, 'orphan-dsh-session', dirSize(p, fsApi), '无引用的 DSH 会话缓存（孤儿）')
        }
      }
    }
  }
  // 5) 旧备份（按配置保留最近版本）
  const targetDir = config.backup?.targetDir
  if (targetDir && fsApi.existsSync(targetDir)) {
    const zips = fsApi.readdirSync(targetDir).filter((n) => /^conversation-archive-backup-.*\.zip$/i.test(n)).sort()
    const keep = Math.max(1, Math.min(100, Math.floor(Number(config.backup?.keepCount) || 5)))
    for (const z of zips.slice(0, Math.max(0, zips.length - keep))) {
      const p = path.join(targetDir, z)
      try { push(p, 'old-backup', fsApi.statSync(p).size, '旧备份（保留最近 5 个）') } catch { /* 忽略 */ }
    }
  }
  if (out.length > 0) log(`[缓存清理] 扫描到 ${out.length} 个候选`)
  return out
}

/** 删除缓存候选（进回收站）；调用方须先经 AI 审核与用户确认 */
export async function cacheDelete(target, deps) {
  const { fsApi, recycle = recyclePath, log = () => {} } = deps
  if (!target || !fsApi.existsSync(target)) return { ok: false, reason: 'not-found' }
  const r = await recycle(target)
  if (r.ok) { log(`[缓存清理-删除] ${target}`); return { ok: true, path: target } }
  return { ok: false, reason: r.error }
}
