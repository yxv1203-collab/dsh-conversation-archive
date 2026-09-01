/**
 * dsh-conversation-archive · 单元测试 v3（node test/run-tests.mjs）
 * 覆盖：清洗/日期/区域/标签区分性/旧布局安全兼容/配置合并/映射/
 *      原生归档恢复/彻底删除(回收站注入)/批处理/孤儿GC/备份。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import {
  sanitizeName, dateStr, classifyWorkspace, uniqueTag, categoryOf, cacheLayoutFor,
  loadMapping, saveMapping, loadConfig, normalizeCategories, toJsonSafe,
  atomicWriteJson, loadVersionedJson, isPathInside, assertManagedPath, assertPhysicalPathInside, recycleScript, recyclePath,
  inspectVersionedJson, appendOperation, inspectOperationsLog, validateSessionEntry, validateCacheDeleteTarget, resolveProtectedChild,
  findRetentionCandidates,
  archiveSessionFlow, restoreSessionFlow, purgeSessionFlow, pruneEmptyParents, runMany, orphanGC,
  protectImportantFiles, remindDue, scanImportantInDir, CATEGORY_DIRS,
} from '../lib/core.js'
import { createStateStore } from '../lib/index.js'

const tests = []
function test(name, fn) { tests.push([name, fn]) }

const H = path.join(os.tmpdir(), 'dca-test-harness')
const DAILY = path.join(H, 'daily_conversation')
fs.rmSync(H, { recursive: true, force: true }) // 清理上次中断运行可能残留的状态
fs.mkdirSync(H, { recursive: true })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-'))

test('sanitizeName 与 dateStr', () => {
  assert.equal(sanitizeName('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j')
  assert.match(dateStr(new Date(2026, 7, 30)), /^2026-08-30$/)
})

test('原生 DSH 会话映射不要求插件缓存目录', () => {
  const entry = {
    id: 'native-layout-session',
    cwd: DAILY,
    createdAt: Date.now(),
    kind: 'daily',
    date: '2026-09-01',
    tag: '原生会话',
    layoutVersion: 3,
    status: 'active',
  }
  assert.equal(validateSessionEntry(entry.id, entry, { harnessRoot: H, mapping: { [entry.id]: entry } }).ok, true)
  assert.equal('cacheDir' in entry, false)
  assert.equal('recordFile' in entry, false)
})

test('重要文件候选只包含会话时间窗口内的原生工作区文件', () => {
  const root = path.join(tmp, 'native-retention-window')
  fs.mkdirSync(root, { recursive: true })
  const oldFile = path.join(root, '旧文件.md')
  const currentFile = path.join(root, '本次产出.md')
  fs.writeFileSync(oldFile, 'old')
  fs.writeFileSync(currentFile, 'current')
  const now = Date.now()
  fs.utimesSync(oldFile, new Date(now - 60_000), new Date(now - 60_000))
  fs.utimesSync(currentFile, new Date(now), new Date(now))
  const candidates = findRetentionCandidates(root, fs, { modifiedAfter: now - 5_000, modifiedBefore: now + 5_000 })
  assert.deepEqual(candidates.map((item) => item.name), ['本次产出.md'])
})

test('工作区根目录可直接用于日常对话，不要求用户预建文件夹', () => {
  assert.equal(classifyWorkspace(path.join(DAILY, '2026-08-30'), { harnessRoot: H }).kind, 'daily')
  const r = classifyWorkspace(path.join(H, '项目A', '子项目A1', 'src'), { harnessRoot: H })
  assert.equal(r.kind, 'project'); assert.equal(r.root, path.join(H, '项目A'))
  assert.equal(classifyWorkspace(H, { harnessRoot: H }).kind, 'daily')
  assert.equal(classifyWorkspace(os.tmpdir(), { harnessRoot: H }).kind, 'outside')
})

test('标签区分性 uniqueTag', () => {
  assert.equal(uniqueTag('测试', new Set(['测试'])), '测试-2')
  assert.equal(uniqueTag('测试', new Set(['测试', '测试-2'])), '测试-3')
  assert.equal(uniqueTag('测试', new Set(['测试', '其他']), '测试'), '测试')
})

test('分类 categoryOf（含自定义覆盖）', () => {
  assert.equal(categoryOf('报告.docx'), '文档')
  assert.equal(categoryOf('main.py'), '代码')
  assert.equal(categoryOf('a.zip'), '压缩包')
  assert.equal(categoryOf('weird.xyz'), '其他')
  assert.equal(categoryOf('weird.xyz', { '.xyz': '自定义' }), '自定义')
})

test('v2 缓存布局按会话隔离：项目用短 id，日常用标题-时间-短 id', () => {
  const createdAt = new Date(2026, 7, 30, 10, 5).getTime()
  const l = cacheLayoutFor({ id: 'daily-session-abcdef123456', kind: 'daily', date: '2026-08-30', createdAt, tag: '测试', layoutVersion: 2 }, { harnessRoot: H })
  assert.equal(l.base, path.join(DAILY, '2026-08-30', '测试-1005-abcdef123456'))
  const p = cacheLayoutFor({ id: 'project-session-abcdef123456', kind: 'project', root: path.join(H, '项目A'), tag: '测试', layoutVersion: 2 }, { harnessRoot: H })
  assert.equal(p.base, path.join(H, '项目A', '.cache', 'abcdef123456'))
  assert.equal(p.recordFile, path.join(H, '项目A', '.cache', 'abcdef123456', '会话记录', '对话记录.jsonl'))
  assert.ok(!p.base.includes('2026'))
})

test('同项目会话绝不共享任何缓存目录，旧共享项目映射不可删除', () => {
  const root = path.join(H, '隔离项目')
  const a = { id: 'project-one-abcdef123456', kind: 'project', root, tag: '同标题', layoutVersion: 2, status: 'active' }
  const b = { id: 'project-two-fedcba654321', kind: 'project', root, tag: '同标题', layoutVersion: 2, status: 'active' }
  const aLayout = cacheLayoutFor(a, { harnessRoot: H })
  const bLayout = cacheLayoutFor(b, { harnessRoot: H })
  assert.notEqual(aLayout.base, bLayout.base)
  assert.notEqual(aLayout.recordFile, bLayout.recordFile)
  const legacy = { ...a, layoutVersion: 1, cacheDir: path.join(root, '.cache'), recordFile: path.join(root, '.cache', '会话记录', '同标题.jsonl') }
  assert.equal(validateSessionEntry(legacy.id, legacy, { harnessRoot: H, config: loadConfig(fs, {}, ''), mapping: { [legacy.id]: legacy } }).reason, 'legacy-shared-project-cache')
})

function makeV2Entry(id, kind, tag, createdAt = new Date(2026, 7, 30, 10, 5).getTime()) {
  const entry = {
    id, kind, tag, layoutVersion: 2, status: 'active', createdAt,
    ...(kind === 'daily' ? { date: '2026-08-30' } : { root: path.join(H, '任务4项目') }),
  }
  const layout = cacheLayoutFor(entry, { harnessRoot: H })
  entry.cacheDir = layout.base
  entry.recordFile = layout.recordFile
  entry.manifestFile = path.join(layout.recordDir, `${tag}.清单.md`)
  fs.mkdirSync(layout.recordDir, { recursive: true })
  for (const category of CATEGORY_DIRS) fs.mkdirSync(layout.categoryDir(category), { recursive: true })
  fs.writeFileSync(entry.recordFile, '{}')
  return entry
}

test('v2 项目归档、恢复和删除仅处理自己的会话根', async () => {
  const a = makeV2Entry('project-alpha-abcdef123456', 'project', '甲')
  const b = makeV2Entry('project-beta-fedcba654321', 'project', '乙')
  fs.writeFileSync(path.join(a.root, 'keep.txt'), 'project source')
  const mapping = { [a.id]: a, [b.id]: b }
  const config = loadConfig(fs, {}, '')
  assert.equal(archiveSessionFlow(a.id, a, { fsApi: fs, harnessRoot: H, config, mapping }).ok, true)
  assert.equal(fs.existsSync(a.cacheDir), false)
  assert.equal(fs.existsSync(b.cacheDir), true)
  assert.equal(fs.existsSync(path.join(a.root, 'keep.txt')), true)
  assert.throws(() => validateCacheDeleteTarget(path.join(a.root, '.cache'), mapping, { harnessRoot: H, config }), { message: 'unregistered-cache-path' })
  assert.throws(() => validateCacheDeleteTarget(b.cacheDir, mapping, { harnessRoot: H, config }), { message: 'unregistered-cache-path' })
  assert.equal(restoreSessionFlow(a.id, a, { fsApi: fs, harnessRoot: H, config, mapping }).ok, true)
  assert.equal(fs.existsSync(a.recordFile), true)
  assert.equal(archiveSessionFlow(a.id, a, { fsApi: fs, harnessRoot: H, config, mapping }).ok, true)
  const purged = await purgeSessionFlow(a.id, a, {
    fsApi: fs, harnessRoot: H, config, mapping,
    recycle: async (target) => { fs.rmSync(target, { recursive: true, force: true }); return { ok: true } },
  })
  assert.equal(purged.ok, true)
  assert.equal(fs.existsSync(path.join(a.root, '.cache')), true)
  assert.equal(fs.existsSync(b.cacheDir), true)
  assert.equal(fs.existsSync(path.join(a.root, 'keep.txt')), true)
})

test('v2 日常会话删除后只在最后一个会话离开时清理日期目录', () => {
  const first = makeV2Entry('daily-first-abcdef123456', 'daily', '同名')
  const second = makeV2Entry('daily-second-fedcba654321', 'daily', '同名')
  const mapping = { [first.id]: first, [second.id]: second }
  const config = loadConfig(fs, {}, '')
  const dateDir = path.dirname(first.cacheDir)
  assert.notEqual(first.cacheDir, second.cacheDir)
  assert.equal(archiveSessionFlow(first.id, first, { fsApi: fs, harnessRoot: H, config, mapping }).ok, true)
  assert.equal(fs.existsSync(dateDir), true)
  assert.equal(archiveSessionFlow(second.id, second, { fsApi: fs, harnessRoot: H, config, mapping }).ok, true)
  assert.equal(fs.existsSync(dateDir), false)
})

test('v2 会话映射重启后仍以身份字段重建精确布局', () => {
  const entry = makeV2Entry('round-trip-abcdef123456', 'daily', '重启布局')
  const file = path.join(tmp, 'v2-round-trip.json')
  saveMapping(file, { [entry.id]: entry }, fs)
  const restored = loadMapping(file, fs)[entry.id]
  const valid = validateSessionEntry(entry.id, restored, { harnessRoot: H, config: loadConfig(fs, {}, ''), mapping: { [entry.id]: restored } })
  assert.equal(valid.ok, true)
  assert.equal(restored.cacheDir, entry.cacheDir)
  assert.equal(restored.recordFile, entry.recordFile)
})

test('归档恢复只清理空后代，绝不删除归档根或工作区根', () => {
  const root = path.join(tmp, 'bounded-prune-harness')
  const entry = {
    id: 'bounded-prune-abcdef123456', kind: 'daily', date: '2026-08-30',
    createdAt: new Date(2026, 7, 30, 10, 5).getTime(), tag: '边界', layoutVersion: 2, status: 'active',
  }
  const layout = cacheLayoutFor(entry, { harnessRoot: root })
  entry.cacheDir = layout.base
  entry.recordFile = layout.recordFile
  entry.manifestFile = path.join(layout.recordDir, '边界.清单.md')
  fs.mkdirSync(layout.recordDir, { recursive: true })
  for (const category of CATEGORY_DIRS) fs.mkdirSync(layout.categoryDir(category), { recursive: true })
  fs.writeFileSync(entry.recordFile, '{}')
  const mapping = { [entry.id]: entry }
  const config = loadConfig(fs, { harnessRoot: root }, '')
  const archiveRoot = path.join(root, '对话归档')
  assert.equal(archiveSessionFlow(entry.id, entry, { fsApi: fs, harnessRoot: root, config, mapping }).ok, true)
  assert.equal(restoreSessionFlow(entry.id, entry, { fsApi: fs, harnessRoot: root, config, mapping }).ok, true)
  assert.equal(fs.existsSync(archiveRoot), true)
  assert.equal(fs.existsSync(root), true)
  const child = path.join(archiveRoot, 'temporary', 'leaf')
  fs.mkdirSync(child, { recursive: true })
  pruneEmptyParents(child, archiveRoot, fs)
  assert.equal(fs.existsSync(archiveRoot), true)
})

test('配置合并 loadConfig（patch + config.json）', () => {
  const cfgPath = path.join(tmp, 'config.json')
  fs.writeFileSync(cfgPath, JSON.stringify({ archive: { deleteDshSession: true }, backup: { targetDir: 'D:\\云盘' }, categories: { '.xyz': '自定义', '.md': '..\\escaped' } }))
  const c = loadConfig(fs, { backup: { targetDir: '' }, categories: { '.json': 'C:\\outside' } }, cfgPath)
  assert.equal(c.archive.deleteDshSession, true)
  assert.equal(c.backup.targetDir, 'D:\\云盘')
  assert.equal(c.categories['.xyz'], '自定义')
  assert.equal(c.categories['.md'], undefined)
  assert.equal(c.categories['.json'], undefined)
  assert.equal(c.purge.deleteDshSession, true) // 默认
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).schemaVersion, 1)
})

test('分类覆盖拒绝保留键和无效扩展名', () => {
  const categories = normalizeCategories(JSON.parse('{"__proto__":"代码","prototype":"代码","constructor":"代码","md":"代码",".bad/path":"代码",".ok":"自定义"}'))
  assert.equal(categories.__proto__, Object.prototype)
  assert.equal(categories.prototype, undefined)
  assert.equal(categories.constructor, Object)
  assert.equal(categories.md, undefined)
  assert.equal(categories['.bad/path'], undefined)
  assert.equal(categories['.ok'], '自定义')
})

test('toJsonSafe：剔除 undefined（对象/数组/嵌套），保留 null', () => {
  const safe = toJsonSafe({ ok: true, reason: undefined, archivedTo: ['a'], nested: { x: undefined, y: null }, arr: [1, undefined, 2] })
  assert.deepEqual(safe, { ok: true, archivedTo: ['a'], nested: { y: null }, arr: [1, null, 2] })
  assert.equal(toJsonSafe(undefined), null)
})

test('managed path rejects traversal and sibling prefixes', () => {
  const root = path.join(tmp, 'managed-root')
  const inside = path.join(root, 'a')
  const sibling = `${root}-other${path.sep}a`
  const escaped = path.join(root, '..', 'secret')
  assert.equal(isPathInside(root, root), false)
  assert.equal(isPathInside(root, inside), true)
  assert.equal(isPathInside(root, sibling), false)
  assert.equal(isPathInside(root, escaped), false)
  assert.equal(assertManagedPath(inside, [root]), path.resolve(inside))
  assert.throws(() => assertManagedPath(root, [root]), { message: 'path-outside-managed-roots' })
  assert.throws(() => assertManagedPath(sibling, [root]), { message: 'path-outside-managed-roots' })
})

test('physical containment rejects a Windows junction escaping a managed root', () => {
  if (process.platform !== 'win32') return
  const root = path.join(tmp, 'physical-root')
  const outside = path.join(tmp, 'physical-outside')
  const junction = path.join(root, 'junction')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `New-Item -ItemType Junction -Path '${junction}' -Target '${outside}' | Out-Null`], { stdio: 'ignore' })
  assert.throws(() => assertPhysicalPathInside(path.join(junction, 'escape.txt'), [root], fs), { message: 'path-reparse-escape' })
})

test('versioned JSON migrates legacy data once and writes atomically', () => {
  const file = path.join(tmp, 'state', 'versioned.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ old: true }))
  let migrations = 0
  const migrate = (value) => {
    migrations += 1
    return { schemaVersion: 1, migrated: value.old }
  }
  assert.deepEqual(loadVersionedJson(file, { schemaVersion: 1 }, migrate, fs), { schemaVersion: 1, migrated: true })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schemaVersion: 1, migrated: true })
  assert.equal(fs.readFileSync(`${file}.v0.3.1.bak`, 'utf8'), JSON.stringify({ old: true }))
  assert.deepEqual(loadVersionedJson(file, { schemaVersion: 1 }, migrate, fs), { schemaVersion: 1, migrated: true })
  assert.equal(migrations, 1)
  assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.endsWith('.tmp')), false)
})

test('versioned JSON rejects malformed and unsupported state', () => {
  const malformed = path.join(tmp, 'malformed.json')
  const unsupported = path.join(tmp, 'unsupported.json')
  fs.writeFileSync(malformed, '{')
  fs.writeFileSync(unsupported, JSON.stringify({ schemaVersion: 2 }))
  assert.throws(() => loadVersionedJson(malformed, { schemaVersion: 1 }, () => ({}), fs), { code: 'invalid-state-json' })
  assert.throws(() => loadVersionedJson(unsupported, { schemaVersion: 1 }, () => ({}), fs), { code: 'unsupported-state-version' })
})

test('versioned JSON inspection never writes before migration is authorized', () => {
  const file = path.join(tmp, 'inspect-legacy.json')
  fs.writeFileSync(file, JSON.stringify({ legacy: true }))
  assert.deepEqual(inspectVersionedJson(file, fs), { exists: true, legacy: true, value: { legacy: true } })
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, undefined)
})

test('atomic JSON writes replace complete state', () => {
  const file = path.join(tmp, 'atomic', 'state.json')
  const tempWrites = []
  const fsApi = Object.create(fs)
  fsApi.writeFileSync = (target, ...args) => { tempWrites.push(target); return fs.writeFileSync(target, ...args) }
  atomicWriteJson(file, { schemaVersion: 1, value: 'first' }, fsApi)
  atomicWriteJson(file, { schemaVersion: 1, value: 'complete' }, fsApi)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schemaVersion: 1, value: 'complete' })
  assert.notEqual(tempWrites[0], tempWrites[1])
})

test('mapping reserves schema and prototype keys and keeps schemaVersion authoritative', () => {
  const file = path.join(tmp, 'reserved-state.json')
  assert.throws(() => saveMapping(file, { schemaVersion: { id: 'bad' } }, fs), { message: 'reserved-session-id' })
  assert.throws(() => saveMapping(file, { constructor: { id: 'bad' } }, fs), { message: 'reserved-session-id' })
  saveMapping(file, { safe: { id: 'safe' } }, fs)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, 1)
})

test('loaded mappings reject reserved ids and fail closed', () => {
  const file = path.join(tmp, 'unsafe-mapping.json')
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, constructor: { id: 'constructor' }, safe: { id: 'safe' } }))
  let error = null
  assert.deepEqual(loadMapping(file, fs, (e) => { error = e.code }), {})
  assert.equal(error, 'invalid-state-data')
})

test('Recycle Bin script selects the correct Windows operation for files and directories', async () => {
  assert.match(recycleScript('C:\\x.txt', false), /DeleteFile/)
  assert.match(recycleScript('C:\\folder', true), /DeleteDirectory/)
  const file = path.join(tmp, 'recycle-file.txt')
  fs.writeFileSync(file, 'x')
  let script = ''
  const result = await recyclePath(file, (_cmd, args, cb) => { script = args.at(-1); cb(null, '', '') }, fs)
  assert.equal(result.ok, true)
  assert.match(script, /DeleteFile/)
})

test('protected-file release names are strict direct children only', () => {
  const root = path.join(tmp, 'protected-root')
  fs.mkdirSync(path.join(root, 'keep'), { recursive: true })
  assert.equal(resolveProtectedChild('keep', root, fs), path.join(root, 'keep'))
  for (const bad of ['', '.', '..', ' a ', 'a/b', '***']) assert.throws(() => resolveProtectedChild(bad, root, fs), { message: 'invalid-protected-name' })
})

test('state commit failure disables writes and leaves the in-memory map unchanged', () => {
  const file = path.join(tmp, 'failing-state.json')
  const failingFs = Object.create(fs)
  failingFs.renameSync = () => { throw new Error('disk-full') }
  let reported = ''
  const store = createStateStore(file, failingFs, () => {}, (code) => { reported = code }, { initialMap: { a: { id: 'a' } } })
  assert.throws(() => store.commit({ a: { id: 'a' }, b: { id: 'b' } }), /disk-full/)
  assert.deepEqual(store.getMap(), { a: { id: 'a' } })
  assert.equal(store.isReadOnly(), true)
  assert.equal(reported, 'state-write-failed')
})

test('debounced state write failure rolls back the last persisted map', () => {
  const file = path.join(tmp, 'failing-debounced-state.json')
  const failingFs = Object.create(fs)
  failingFs.renameSync = () => { throw new Error('disk-full') }
  const store = createStateStore(file, failingFs, () => {}, () => {}, { initialMap: { a: { id: 'a' } } })
  store.upsert('b', { id: 'b' })
  assert.throws(() => store.flush(), /disk-full/)
  assert.deepEqual(store.getMap(), { a: { id: 'a' } })
  assert.equal(store.isReadOnly(), true)
})

test('malformed config and mapping remain readable-disabled instead of throwing', () => {
  const configFile = path.join(tmp, 'broken-config.json')
  const mappingFile = path.join(tmp, 'broken-mapping.json')
  fs.writeFileSync(configFile, '{')
  fs.writeFileSync(mappingFile, JSON.stringify({ schemaVersion: 2 }))
  const config = loadConfig(fs, {}, configFile)
  assert.equal(config.persistenceError, 'invalid-state-json')
  let mappingError = ''
  assert.deepEqual(loadMapping(mappingFile, fs, (error) => { mappingError = error.code }), {})
  assert.equal(mappingError, 'unsupported-state-version')
  assert.equal(fs.readFileSync(configFile, 'utf8'), '{')
  assert.equal(fs.readFileSync(mappingFile, 'utf8'), JSON.stringify({ schemaVersion: 2 }))
})

const statePath = path.join(tmp, 'state.json')
test('映射 round-trip', () => {
  saveMapping(statePath, { a: { id: 'a' } }, fs)
  assert.equal(loadMapping(statePath, fs).a.id, 'a')
})

function makeDailyEntry(tag, date = '2026-08-30') {
  const tagDir = path.join(DAILY, date, tag)
  fs.mkdirSync(path.join(tagDir, '会话记录'), { recursive: true })
  fs.writeFileSync(path.join(tagDir, '会话记录', '对话记录.jsonl'), '{}')
  return { id: 's-' + tag, kind: 'daily', date, tag, cacheDir: tagDir, recordFile: path.join(tagDir, '会话记录', '对话记录.jsonl'), status: 'active' }
}

test('poisoned mapping entries cannot select another cache or archive directory', async () => {
  const entry = makeDailyEntry('安全边界', '2026-08-29')
  const mapping = { [entry.id]: entry }
  const config = loadConfig(fs, {}, '')
  const outside = path.join(tmp, 'outside-session')
  fs.mkdirSync(outside, { recursive: true })
  const poisoned = { ...entry, cacheDir: outside }
  assert.equal(validateSessionEntry(entry.id, poisoned, { harnessRoot: H, config, mapping: { [entry.id]: poisoned } }).ok, false)
  assert.equal(archiveSessionFlow(entry.id, poisoned, { fsApi: fs, harnessRoot: H, config, mapping: { [entry.id]: poisoned } }).ok, false)
  entry.status = 'archived'
  entry.archivePath = path.join(H, '对话归档', '日常', '2026-08-29', '别的会话')
  assert.equal(restoreSessionFlow(entry.id, entry, { fsApi: fs, harnessRoot: H, config, mapping }).ok, false)
  const purge = await purgeSessionFlow(entry.id, entry, { fsApi: fs, harnessRoot: H, config, mapping, recycle: async () => ({ ok: true }) })
  assert.equal(purge.ok, false)
  assert.throws(() => validateCacheDeleteTarget(path.join(outside, 'x'), mapping, { harnessRoot: H, config }), { message: 'unregistered-cache-path' })
})

test('cache deletion accepts only the current session cache, never the cache root', () => {
  const entry = makeDailyEntry('删除边界', '2026-08-28')
  const config = loadConfig(fs, {}, '')
  const mapping = { [entry.id]: entry }
  const file = path.join(entry.cacheDir, '文档', 'result.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'x')
  assert.equal(validateCacheDeleteTarget(file, mapping, { harnessRoot: H, config }), path.resolve(file))
  assert.throws(() => validateCacheDeleteTarget(entry.cacheDir, mapping, { harnessRoot: H, config }), { message: 'unregistered-cache-path' })
})

test('软归档：整夹移入归档、映射保留 archived、默认不删 DSH 会话', () => {
  const entry = makeDailyEntry('周末', '2026-08-24')
  let dshDeleted = 0
  const res = archiveSessionFlow(entry.id, entry, {
    fsApi: fs, harnessRoot: H, config: loadConfig(fs, {}, ''),
    deleteDshSessionOnce: async () => { dshDeleted += 1; return { ok: true } },
  })
  assert.equal(res.ok, true)
  assert.equal(entry.status, 'archived')
  assert.ok(entry.archivePath.includes(path.join('对话归档', '日常', '2026-08-24', '周末')))
  assert.ok(fs.existsSync(entry.archivePath), '归档夹存在')
  assert.ok(!fs.existsSync(entry.cacheDir), '原夹移走')
  assert.ok(!fs.existsSync(path.join(DAILY, '2026-08-24')), '空日期夹已删')
  assert.equal(dshDeleted, 0, '默认保留 DSH 会话')
})

test('软归档：配置 deleteDshSession=true 时删除 DSH 会话', () => {
  const entry = makeDailyEntry('周末2')
  let dshDeleted = 0
  archiveSessionFlow(entry.id, entry, {
    fsApi: fs, harnessRoot: H,
    config: loadConfig(fs, { archive: { deleteDshSession: true } }, ''),
    deleteDshSessionOnce: async () => { dshDeleted += 1; return { ok: true } },
  })
  assert.equal(dshDeleted, 1)
})

test('取消归档：移回原位、状态 active、归档空目录链清理', () => {
  const entry = makeDailyEntry('周末3', '2026-08-31') // 独立日期，避免共享测试状态干扰
  const a = archiveSessionFlow(entry.id, entry, { fsApi: fs, harnessRoot: H, config: loadConfig(fs, {}, '') })
  assert.equal(a.ok, true)
  assert.ok(fs.existsSync(path.join(H, '对话归档', '日常', '2026-08-31', '周末3')))
  const r = restoreSessionFlow(entry.id, entry, { fsApi: fs, harnessRoot: H, config: loadConfig(fs, {}, '') })
  assert.equal(r.ok, true)
  assert.equal(entry.status, 'active')
  assert.ok(fs.existsSync(entry.cacheDir), '已移回')
  assert.ok(!entry.archivePath)
  assert.ok(fs.existsSync(path.join(entry.cacheDir, '会话记录', '对话记录.jsonl')))
  // 归档区空目录链应被清理（2026-08-31 下唯一归档 → 该日期夹被清理；日常 仍含其他日期故保留）
  assert.ok(!fs.existsSync(path.join(H, '对话归档', '日常', '2026-08-31')), '归档日期夹已清理')
  assert.ok(fs.existsSync(path.join(H, '对话归档', '日常')), '日常 仍保留（含其他测试日期）')
})

test('daily restore collision rebuilds every derived path', () => {
  const entry = makeDailyEntry('撞名', '2026-08-27')
  const mapping = { [entry.id]: entry }
  const config = loadConfig(fs, {}, '')
  assert.equal(archiveSessionFlow(entry.id, entry, { fsApi: fs, harnessRoot: H, config, mapping }).ok, true)
  fs.mkdirSync(entry.cacheDir, { recursive: true })
  const restored = restoreSessionFlow(entry.id, entry, { fsApi: fs, harnessRoot: H, config, mapping })
  assert.equal(restored.ok, true)
  assert.equal(entry.tag, '撞名-2')
  const layout = cacheLayoutFor(entry, { harnessRoot: H })
  assert.equal(entry.cacheDir, layout.base)
  assert.equal(entry.recordFile, layout.recordFile)
  assert.equal(entry.manifestFile, path.join(layout.recordDir, '撞名-2.清单.md'))
})

test('archive and restore reject missing required sources without state mutation', () => {
  const entry = { id: 'missing', kind: 'daily', date: '2026-08-26', tag: 'missing', cacheDir: path.join(DAILY, '2026-08-26', 'missing'), recordFile: path.join(DAILY, '2026-08-26', 'missing', '会话记录', '对话记录.jsonl'), status: 'active' }
  const mapping = { missing: entry }
  const config = loadConfig(fs, {}, '')
  assert.equal(archiveSessionFlow('missing', entry, { fsApi: fs, harnessRoot: H, config, mapping }).ok, false)
  assert.equal(entry.status, 'active')
  entry.status = 'archived'
  entry.archivePath = path.join(H, '对话归档', '日常', '2026-08-26', 'missing')
  assert.equal(restoreSessionFlow('missing', entry, { fsApi: fs, harnessRoot: H, config, mapping }).ok, false)
  assert.equal(entry.status, 'archived')

  const projectRoot = path.join(H, 'missing-project')
  fs.mkdirSync(projectRoot, { recursive: true })
  const project = { id: 'missing-project-session', kind: 'project', root: projectRoot, tag: 'missing-record', status: 'active', recordFile: path.join(projectRoot, '.cache', '会话记录', 'missing-record.jsonl'), manifestFile: path.join(projectRoot, '.cache', '会话记录', 'missing-record.清单.md') }
  const projectArchiveParent = path.join(H, '对话归档', '项目', path.basename(projectRoot))
  assert.equal(archiveSessionFlow(project.id, project, { fsApi: fs, harnessRoot: H, config, mapping: { [project.id]: project } }).ok, false)
  assert.equal(fs.existsSync(projectArchiveParent), false, '缺失项目记录时不得先创建归档目录')
})

test('彻底删除：注入回收 + 按配置删 DSH 会话', async () => {
  const entry = makeDailyEntry('周末4')
  archiveSessionFlow(entry.id, entry, { fsApi: fs, harnessRoot: H, config: loadConfig(fs, {}, '') })
  const recycled = []
  let dshDeleted = 0
  const res = await purgeSessionFlow(entry.id, entry, {
    fsApi: fs, harnessRoot: H, config: loadConfig(fs, {}, ''),
    recycle: async (p) => { recycled.push(p); fs.rmSync(p, { recursive: true, force: true }); return { ok: true } },
    deleteDshSessionOnce: async () => { dshDeleted += 1; return { ok: true } },
  })
  assert.equal(res.ok, true)
  assert.equal(recycled.length, 1)
  assert.ok(recycled[0].includes('周末4'))
  assert.equal(dshDeleted, 1, 'purge 默认删 DSH 会话')
  assert.ok(!fs.existsSync(entry.archivePath))
})

test('彻底删除在重要文件保护完成后才回收 DSH 会话', async () => {
  const entry = makeDailyEntry('保护先行')
  archiveSessionFlow(entry.id, entry, { fsApi: fs, harnessRoot: H, config: loadConfig(fs, {}, '') })
  fs.mkdirSync(path.join(entry.archivePath, '文档'), { recursive: true })
  fs.writeFileSync(path.join(entry.archivePath, '文档', '成果.md'), 'keep')
  let protectedBeforeDshRecycle = false
  const result = await purgeSessionFlow(entry.id, entry, {
    fsApi: fs, harnessRoot: H, config: loadConfig(fs, {}, ''),
    recycle: async (target) => { fs.rmSync(target, { recursive: true, force: true }); return { ok: true } },
    deleteDshSessionOnce: async () => {
      protectedBeforeDshRecycle = fs.existsSync(path.join(H, '重要文件保护', entry.tag, '文档', '成果.md'))
      return { ok: true }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(protectedBeforeDshRecycle, true)
})

test('彻底删除先确认缓存回收；DSH 回收失败报告可恢复部分阶段', async () => {
  const cacheFailure = makeDailyEntry('缓存回收失败')
  archiveSessionFlow(cacheFailure.id, cacheFailure, { fsApi: fs, harnessRoot: H, config: loadConfig(fs, {}, '') })
  let dshCalls = 0
  const blocked = await purgeSessionFlow(cacheFailure.id, cacheFailure, {
    fsApi: fs, harnessRoot: H, config: loadConfig(fs, {}, ''),
    recycle: async () => ({ ok: false, error: 'cache-recycle-failed' }),
    deleteDshSessionOnce: async () => { dshCalls += 1; return { ok: true } },
  })
  assert.equal(blocked.ok, false)
  assert.equal(dshCalls, 0, '缓存未回收时不得触及 DSH 日志')
  assert.ok(fs.existsSync(cacheFailure.archivePath), '缓存失败后归档缓存仍可恢复')

  const dshFailure = makeDailyEntry('日志回收失败')
  archiveSessionFlow(dshFailure.id, dshFailure, { fsApi: fs, harnessRoot: H, config: loadConfig(fs, {}, '') })
  const partial = await purgeSessionFlow(dshFailure.id, dshFailure, {
    fsApi: fs, harnessRoot: H, config: loadConfig(fs, {}, ''),
    recycle: async (target) => { fs.rmSync(target, { recursive: true, force: true }); return { ok: true } },
    deleteDshSessionOnce: async () => ({ ok: false, reason: 'dsh-log-recycle-failed' }),
  })
  assert.equal(partial.ok, false)
  assert.equal(partial.partialPhase, 'cache-recycled-dsh-pending')
  assert.equal(partial.reason, 'dsh-log-recycle-failed')
  assert.ok(!fs.existsSync(dshFailure.archivePath), '部分阶段只会在缓存已回收后出现')
})

test('批处理 runMany：一个失败不阻断', async () => {
  const r = await runMany(['a', 'b'], async (id) => {
    if (id === 'a') throw new Error('boom')
    return { ok: false, reason: 'expected-failure' }
  })
  assert.equal(r.length, 2)
  assert.equal(r[0].ok, false)
  assert.equal(r[1].ok, false)
  assert.equal(r[1].result.reason, 'expected-failure')
})

test('操作审计仅追加脱敏版本记录，畸形尾部失败关闭', () => {
  const stateRoot = path.join(tmp, 'audit-state')
  const file = path.join(stateRoot, 'operations.jsonl')
  const operationId = '12345678-1234-4234-8234-123456789abc'
  appendOperation(file, { operationId, type: 'delete', sessionId: 'audit-session', phase: 'prepared', outcome: 'started', details: { scope: 'cache', count: 2, path: 'C:\\secret', reason: 'ok' } }, { stateRoot, fsApi: fs })
  appendOperation(file, { operationId, type: 'delete', sessionId: 'audit-session', phase: 'complete', outcome: 'ok', details: { recycledCount: 2 } }, { stateRoot, fsApi: fs })
  const audit = inspectOperationsLog(file, { stateRoot, fsApi: fs })
  assert.equal(audit.records.length, 2)
  assert.equal(audit.records[0].details.path, undefined)
  fs.appendFileSync(file, '{broken\n')
  assert.equal(inspectOperationsLog(file, { stateRoot, fsApi: fs }).malformedCount, 1)
  assert.throws(() => appendOperation(file, { type: 'backup', phase: 'start', outcome: 'started' }, { stateRoot, fsApi: fs }), { message: 'invalid-operations-log' })
})

test('孤儿映射 GC', () => {
  const map = {
    a: { id: 'a', status: 'active', cacheDir: path.join(tmp, 'missing-a') },
    b: { id: 'b', status: 'active', cacheDir: path.join(tmp, 'missing-b') },
    c: { id: 'c', status: 'archived', archivePath: path.join(tmp, 'missing-c') },
    d: { id: 'd', status: 'archived', archivePath: path.join(tmp, 'exists-d') },
  }
  fs.mkdirSync(path.join(tmp, 'exists-d'), { recursive: true })
  const removed = orphanGC(map, { liveIds: new Set(['b']), persistedIds: new Set(), fsApi: fs })
  assert.deepEqual(removed.map((r) => r.id).sort(), ['a', 'c'])
  assert.ok(map.b, 'b 是 live → 保留')
  assert.ok(map.d, 'd 的归档路径存在 → 保留')
})

test('重要文件保护：扫描清单+白名单，复制到保护区', () => {
  const dir = path.join(tmp, 'protect-src')
  fs.mkdirSync(path.join(dir, '文档'), { recursive: true })
  fs.writeFileSync(path.join(dir, '文档', '报告.docx'), 'x')
  fs.writeFileSync(path.join(dir, 'main.py'), 'x')
  fs.writeFileSync(path.join(dir, '缓存.tmp'), 'x')
  const list = scanImportantInDir(dir, fs)
  assert.deepEqual(list.map((p) => p.replace(/\\/g, '/')).sort(), ['main.py', '文档/报告.docx'])
  const protectRoot = path.join(tmp, 'protect-out')
  const protectedList = protectImportantFiles(dir, protectRoot, fs)
  assert.equal(protectedList.length, 2)
  assert.ok(fs.existsSync(path.join(protectRoot, 'protect-src', '文档', '报告.docx')))
})

test('重要文件保护拒绝保护库子目录 junction 越界', () => {
  if (process.platform !== 'win32') return
  const dir = path.join(tmp, 'protect-junction-src')
  const protectRoot = path.join(tmp, 'protect-junction-out')
  const outside = path.join(tmp, 'protect-junction-target')
  fs.mkdirSync(path.join(dir, '文档'), { recursive: true })
  fs.writeFileSync(path.join(dir, '文档', '报告.docx'), 'x')
  fs.mkdirSync(path.join(protectRoot, path.basename(dir)), { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `New-Item -ItemType Junction -Path '${path.join(protectRoot, path.basename(dir), '文档')}' -Target '${outside}' | Out-Null`], { stdio: 'ignore' })
  assert.throws(() => protectImportantFiles(dir, protectRoot, fs), { message: 'path-reparse-escape' })
})

test('remindDue：按天频次判定', () => {
  assert.equal(remindDue(0, loadConfig(fs, {}, '')), true, '从未提醒 → 到期')
  const now = Date.now()
  assert.equal(remindDue(now, loadConfig(fs, {}, '')), false, '刚提醒 → 未到期')
  assert.equal(remindDue(now - 2 * 24 * 3600e3, loadConfig(fs, {}, '')), true, '超过 1 天 → 到期')
  assert.equal(remindDue(now, loadConfig(fs, { remind: { intervalDays: 2 } }, '')), false)
  assert.equal(remindDue(now - (2 * 24 * 3600e3 - 3600e3), loadConfig(fs, { remind: { intervalDays: 2 } }, '')), false, '2 天内不重复')
  assert.equal(remindDue(now - 2 * 24 * 3600e3, loadConfig(fs, { remind: { intervalDays: 2 } }, '')), true, '满 2 天即提醒')
  assert.equal(remindDue(now - 3 * 24 * 3600e3, loadConfig(fs, { remind: { intervalDays: 2 } }, '')), true)
})

let passed = 0
for (const [name, fn] of tests) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`) }
  catch (e) { console.error(`  ✗ ${name}`); throw e }
}
console.log(`\n全部通过：${passed} 项`)
fs.rmSync(tmp, { recursive: true, force: true })
fs.rmSync(H, { recursive: true, force: true })
