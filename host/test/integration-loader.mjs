/**
 * dsh-conversation-archive · Loader 集成测试 v3（node test/integration-loader.mjs）
 * 桩化 sessions/tools/commands；临时 harnessRoot/statePath。
 * 覆盖：插件加载 → 日常/项目归档 → 标签区分性 → 记录镜像 → 产物捕获 →
 *      软归档/取消归档/彻底删除(真实回收站)/批处理/备份 → 工具/命令 → agent 预设实例。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cacheLayoutFor } from '../lib/core.js'
import { resolveDshPackage } from './helpers/dsh-paths.mjs'
import { assertPortableSources } from './helpers/portability-guard.mjs'

// PowerShell's standard modules are needed by the DSH integration runtime. Keep
// the test self-contained when the caller has not configured PSModulePath.
if (process.platform === 'win32') {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR
  if (systemRoot) {
    const standardModules = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
    // Use the trusted system location explicitly; inherited values may point to
    // PowerShell Core-only folders that confuse Windows PowerShell autoloading.
    process.env.PSModulePath = standardModules
  }
}

const cordisUrl = resolveDshPackage('@deepseek-ai/cordis')
if (!cordisUrl.startsWith('file:')) throw new Error('Cordis must resolve to a file URL')
const portabilitySources = [
  fs.readFileSync(new URL('./integration-loader.mjs', import.meta.url), 'utf8'),
  fs.readFileSync(new URL('./helpers/dsh-paths.mjs', import.meta.url), 'utf8'),
].join('\n')
const stalePluginPath = ['DeepSeek Harness', '_plugins', 'dsh-conversation-archive'].join('/')
// Inspect source literals for copied machine-specific URLs/paths. Runtime URLs
// are constructed below and therefore are intentionally not matched here.
const encodedHarness = 'DeepSeek' + '%20' + 'Harness'
const stalePathForms = [
  stalePluginPath,
  stalePluginPath.replaceAll('/', '\\\\'),
  stalePluginPath.replace('DeepSeek Harness', encodedHarness),
  stalePluginPath.replaceAll('/', '\\\\').replace('DeepSeek Harness', encodedHarness),
]
assertPortableSources(portabilitySources, stalePathForms)

const { Context } = await import(cordisUrl)
const Loader = (await import(resolveDshPackage('@deepseek-ai/cordis-plugin-loader'))).default

const PLUGIN_URL = new URL('../lib/index.js', import.meta.url).href
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-loader-'))
process.env.DSH_HOME = path.join(tmp, 'dsh-home')
const dailyDir = path.join(tmp, 'daily_conversation')
const projDir = path.join(tmp, '项目A')
const statePath = path.join(tmp, 'state.json')
const backupsDir = path.join(tmp, 'backups')
const testConfigPath = path.join(tmp, 'test-config.json') // 隔离真实 config.json

const ctx = new Context()
const toolsRegistered = []
const commandsRegistered = []
const webRoutes = []
const liveSessions = new Set()
const fakeSessionsDir = path.join(process.env.DSH_HOME, 'sessions')
const fakeSessionProjectKey = (cwd) => {
  if (cwd === undefined) return '_no-cwd'
  let readable = ''
  let separatorRun = false
  for (const ch of cwd) {
    if (ch === '/' || ch === '\\' || ch === ':') { if (!separatorRun) readable += '-'; separatorRun = true }
    else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) { readable += ch; separatorRun = false }
    else { readable += `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`; separatorRun = false }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}
const fakeSessionDir = (id, cwd = dailyDir) => path.join(fakeSessionsDir, fakeSessionProjectKey(cwd), id)
let retentionCalls = 0
let failRetention = false
let retainNone = false
const retentionLlm = {
  resolveModelInfo: async () => ({ inputModalities: ['text'] }),
  stream: async function * (request) {
    retentionCalls += 1
    if (failRetention) { yield { type: 'finish', reason: { kind: 'error', failure: {} } }; return }
    const text = request.messages?.[0]?.content?.[0]?.text || ''
    const candidates = JSON.parse(text.slice(text.lastIndexOf('\n') + 1))
    yield { type: 'text-delta', text: JSON.stringify({ retain: retainNone ? [] : candidates.map((candidate) => ({ id: candidate.id, reason: '测试最终产出' })) }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}
ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) })
ctx.provide('llm', retentionLlm)
ctx.provide('webServer', { register: (route) => { webRoutes.push(route); return () => {} } })
ctx.provide('tools', { register: (def) => { toolsRegistered.push(def); return () => {} } })
ctx.provide('commands', { register: (def) => { commandsRegistered.push(def); return () => {} } })
ctx.provide('sessions', {
  list: () => [], get: (id) => (liveSessions.has(String(id)) ? { id } : undefined), create: () => null,
})
const persistedHeaders = new Map()
ctx.provide('sessionPersistence', {
  root: fakeSessionsDir,
  compression: 'zstd',
  locate: (meta) => ({ path: path.join(fakeSessionDir(String(meta.id), meta.cwd), 'session.jsonl.zstd') }),
  listSnapshots: async () => [...persistedHeaders.values()].map((header) => ({ header })),
})
let workspaceState = { archivedSessionIds: [] }
let workspaceTail = Promise.resolve()
ctx.provide('workspaceRegistry', {
  get archivedSessionIds() { return workspaceState.archivedSessionIds },
  archiveSession: async (id) => {
    if (!workspaceState.archivedSessionIds.includes(id)) workspaceState = { ...workspaceState, archivedSessionIds: [...workspaceState.archivedSessionIds, id] }
  },
  deleteArchivedSession: async (id) => {
    workspaceState = { ...workspaceState, archivedSessionIds: workspaceState.archivedSessionIds.filter((item) => item !== id) }
  },
  requireState: () => workspaceState,
  setState: async (next) => { workspaceState = next },
  enqueueOperation: (operation) => {
    const result = workspaceTail.then(operation)
    workspaceTail = result.catch(() => {})
    return result
  },
})
await ctx.plugin(Loader, { baseUrl: new URL('../', resolveDshPackage('@deepseek-ai/cordis-plugin-loader')).href })
await ctx.loader.create({
  id: 'conversation-archive',
  name: PLUGIN_URL,
  config: { harnessRoot: tmp, statePath, configPath: testConfigPath, backup: { targetDir: backupsDir } },
})
await ctx.loader.await()
console.log('✓ 插件已激活（apply 运行成功）')

const t0 = Date.now()
const svc = ctx.get('conversationArchive')
if (!svc) throw new Error('conversationArchive 服务未提供')
const nativeArchive = (id) => ctx.get('workspaceRegistry').archiveSession(id)
const nativeUiRestore = (id) => ctx.get('workspaceRegistry').enqueueOperation(async () => {
  const registry = ctx.get('workspaceRegistry')
  const state = registry.requireState()
  await registry.setState({ ...state, archivedSessionIds: state.archivedSessionIds.filter((item) => item !== id) })
})
const waitForNativeCache = async (id, service = svc) => {
  const until = Date.now() + 2500
  while (Date.now() < until) {
    const entry = service.status().archived.find((item) => item.id === id)
    if (entry?.cachePhase === 'cache-archived') return { ok: true }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return { ok: false, reason: 'archive-cache-timeout' }
}
const map = () => { svc.flush(); return JSON.parse(fs.readFileSync(statePath, 'utf8')) }

// ── 场景1：日常会话 + 标题标签 + 区分性 + 记录 + 捕获 ──
ctx.emit('session/created', { header: { id: 'd1', cwd: dailyDir, createdAt: t0 } })
const base1 = map()['d1'].cacheDir
for (const sub of ['会话记录', '文档', '代码']) {
  if (!fs.existsSync(path.join(base1, sub))) throw new Error(`缺分类目录 ${sub}`)
}
const d1OldManifest = map()['d1'].manifestFile
fs.writeFileSync(d1OldManifest, '# old manifest\n')
ctx.emit('session/event', { header: { id: 'd1', cwd: dailyDir } }, { seq: 1, time: t0 + 1, type: 'session/title', data: { title: '周末闲聊  ' } })
const base1b = map()['d1'].cacheDir
const d1Renamed = map()['d1']
if (!base1b.includes('周末闲聊') || !base1b.endsWith('-d1') || d1Renamed.recordFile !== path.join(base1b, '会话记录', '对话记录.jsonl') || d1Renamed.manifestFile !== path.join(base1b, '会话记录', '周末闲聊.清单.md') || !fs.existsSync(d1Renamed.manifestFile) || fs.existsSync(path.join(base1b, '会话记录', path.basename(d1OldManifest)))) throw new Error('日常标题更名必须重建全部派生路径并迁移清单')
ctx.emit('session/created', { header: { id: 'd2', cwd: dailyDir, createdAt: t0 } })
ctx.emit('session/event', { header: { id: 'd2', cwd: dailyDir } }, { seq: 1, time: t0 + 2, type: 'session/title', data: { title: '周末闲聊' } })
const base2 = map()['d2'].cacheDir
if (!base2.includes('周末闲聊') || base1b === base2 || !base2.endsWith('-d2')) throw new Error('同标题日常会话必须以短会话 id 隔离')
const collisionA = 'collision-a-abcdef123456'
const collisionB = 'collision-b-abcdef123456'
ctx.emit('session/created', { header: { id: collisionA, cwd: dailyDir, createdAt: t0 } })
ctx.emit('session/created', { header: { id: collisionB, cwd: dailyDir, createdAt: t0 } })
ctx.emit('session/event', { header: { id: collisionA, cwd: dailyDir } }, { seq: 1, time: t0 + 2, type: 'session/title', data: { title: '短标识冲突' } })
ctx.emit('session/event', { header: { id: collisionB, cwd: dailyDir } }, { seq: 1, time: t0 + 2, type: 'session/title', data: { title: '短标识冲突' } })
const collisionMap = map()
if (collisionMap[collisionA].cacheDir === collisionMap[collisionB].cacheDir || collisionMap[collisionB].cacheKey !== 'abcdef123456-2' || collisionMap[collisionB].recordFile !== path.join(collisionMap[collisionB].cacheDir, '会话记录', '对话记录.jsonl')) throw new Error('日常短标识碰撞必须重建隔离布局')
ctx.emit('session/event', { header: { id: 'd1', cwd: dailyDir } }, { seq: 2, time: t0 + 3, type: 'user/message', data: { content: '你好' } })
if (!fs.existsSync(path.join(base1b, '会话记录', '对话记录.jsonl'))) throw new Error('对话记录未写入')
fs.writeFileSync(path.join(dailyDir, '产出.md'), 'x')
ctx.emit('session/disposed', { header: { id: 'd1', cwd: dailyDir } })
if (!fs.existsSync(path.join(base1b, '文档', '产出.md'))) throw new Error('产物未捕获')
console.log('✓ 日常归档（日期/标签/区分性/记录/捕获）')

// Session-created must reject a project root that is a junction outside DSH.
const junctionProject = path.join(tmp, 'junction-project')
const junctionProjectOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-junction-project-outside-'))
fs.mkdirSync(junctionProjectOutside, { recursive: true })
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `New-Item -ItemType Junction -Path '${junctionProject}' -Target '${junctionProjectOutside}' | Out-Null`], { stdio: 'ignore' })
ctx.emit('session/created', { header: { id: 'junction-project-session', cwd: path.join(junctionProject, 'src'), createdAt: t0 } })
if (map()['junction-project-session'] || fs.existsSync(path.join(junctionProjectOutside, '.cache'))) throw new Error('项目 junction 越界时不得创建缓存')
fs.rmSync(junctionProjectOutside, { recursive: true, force: true })
console.log('✓ session/created（项目 junction 越界拒绝）')

// newProject must reject both a direct-child parent junction and a direct-child
// target junction before mkdir/write can follow either reparse point.
const newProjectParent = path.join(tmp, 'junction-project-parent')
const newProjectParentOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-new-project-parent-outside-'))
fs.mkdirSync(newProjectParentOutside, { recursive: true })
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `New-Item -ItemType Junction -Path '${newProjectParent}' -Target '${newProjectParentOutside}' | Out-Null`], { stdio: 'ignore' })
const parentProjectResult = svc.newProject('child-project', 'junction-project-parent')
if (parentProjectResult.ok || fs.existsSync(path.join(newProjectParentOutside, 'child-project'))) throw new Error('newProject 不得跟随父目录 junction 写入')
const newProjectTarget = path.join(tmp, 'junction-project-target')
const newProjectTargetOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-new-project-target-outside-'))
fs.mkdirSync(newProjectTargetOutside, { recursive: true })
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `New-Item -ItemType Junction -Path '${newProjectTarget}' -Target '${newProjectTargetOutside}' | Out-Null`], { stdio: 'ignore' })
const targetProjectResult = svc.newProject('junction-project-target')
if (targetProjectResult.ok || fs.existsSync(path.join(newProjectTargetOutside, '.cache'))) throw new Error('newProject 不得跟随目标 junction 写入')
fs.rmSync(newProjectParentOutside, { recursive: true, force: true })
fs.rmSync(newProjectTargetOutside, { recursive: true, force: true })
console.log('✓ newProject（父目录/目标 junction 越界拒绝）')

// ── 场景2：项目会话（.cache\短会话 id，完整分类根）──
ctx.emit('session/created', { header: { id: 'p1', cwd: path.join(projDir, 'src'), createdAt: t0 } })
const pEntry = map()['p1']
if (pEntry.kind !== 'project' || pEntry.root !== projDir || pEntry.cacheDir !== path.join(projDir, '.cache', 'p1')) throw new Error('项目判定或会话根错误')
ctx.emit('session/created', { header: { id: 'p2', cwd: path.join(projDir, 'src'), createdAt: t0 } })
const p2Entry = map()['p2']
if (p2Entry.cacheDir === pEntry.cacheDir || p2Entry.recordFile === pEntry.recordFile || !fs.existsSync(path.join(p2Entry.cacheDir, '文档'))) throw new Error('项目会话不得共享缓存或分类目录')
const projectCollisionA = 'project-collision-a-abcdef123456'
const projectCollisionB = 'project-collision-b-abcdef123456'
ctx.emit('session/created', { header: { id: projectCollisionA, cwd: path.join(projDir, 'src'), createdAt: t0 } })
ctx.emit('session/created', { header: { id: projectCollisionB, cwd: path.join(projDir, 'src'), createdAt: t0 } })
const projectCollisionMap = map()
if (projectCollisionMap[projectCollisionA].cacheDir === projectCollisionMap[projectCollisionB].cacheDir || projectCollisionMap[projectCollisionB].cacheKey !== 'abcdef123456-2') throw new Error('项目短标识碰撞不得共享缓存根')
ctx.emit('session/event', { header: { id: 'p1', cwd: projDir } }, { seq: 1, time: t0 + 1, type: 'session/title', data: { title: '需求讨论' } })
const pRecord = map()['p1'].recordFile
if (map()['p1'].cacheDir !== pEntry.cacheDir) throw new Error('项目标题不得重命名会话缓存根')
ctx.emit('session/event', { header: { id: 'p1', cwd: projDir } }, { seq: 2, time: t0 + 2, type: 'user/message', data: { content: '需求' } })
if (!fs.existsSync(pRecord)) throw new Error('项目记录未创建')
console.log('✓ 项目缓存（.cache\\短会话 id\\分类）')

// ── 场景3：服务面（项目环境 + 软归档 + 取消归档 + 彻底删除 + 批处理 + 备份）──
const proj = svc.newProject('项目B')
if (!proj.ok || !fs.existsSync(path.join(proj.dir, '.cache'))) throw new Error('新建项目失败')
console.log('✓ conversationArchive.newProject')

// 软归档 d1：映射保留、状态 archived、归档夹存在
await nativeArchive('d1')
const a1 = await waitForNativeCache('d1')
if (!a1.ok) throw new Error('软归档失败: ' + JSON.stringify(a1))
const e1 = map()['d1']
if (!e1 || e1.status !== 'archived' || !e1.archivePath) throw new Error('软归档后映射未保留 archived')
if (!fs.existsSync(e1.archivePath)) throw new Error('归档夹缺失')
if (fs.existsSync(base1b)) throw new Error('原夹应已移走')
console.log('✓ 软归档（映射保留 + 完整移入归档区）')

// 取消归档 d1
const r1 = await svc.restoreSession('d1')
if (!r1.ok) throw new Error('取消归档失败: ' + JSON.stringify(r1))
if (map()['d1'].status !== 'active' || !fs.existsSync(base1b)) throw new Error('取消归档后未还原')
console.log('✓ 取消归档（移回原位）')

// 再次归档 + 批处理彻底删除（d1、d2）
await nativeArchive('d1')
await nativeArchive('d2')
const pm = await svc.purgeMany(['d1', 'd2'])
if (!pm.every((r) => r.ok)) throw new Error(`批处理彻底删除失败(retentionCalls=${retentionCalls}): ${JSON.stringify(pm)}`)
if (map()['d1'] || map()['d2']) throw new Error('彻底删除后映射未清理: ' + JSON.stringify(pm))
if (retentionCalls === 0 || !fs.existsSync(path.join(tmp, 'retained.json'))) throw new Error('彻底删除必须先调用 DSH 默认模型并建立全局保留索引')
console.log('✓ 批处理彻底删除（purgeMany，真实回收站）')

// 项目归档 + 取消归档 + 彻底删除
await nativeArchive('p1'); await waitForNativeCache('p1')
const ep = map()['p1']
if (!ep || ep.status !== 'archived' || !fs.existsSync(ep.archivePath)) throw new Error('项目软归档失败')
await svc.restoreSession('p1')
if (!fs.existsSync(map()['p1'].recordFile)) throw new Error('项目取消归档失败')
await nativeArchive('p1')
await svc.purgeSession('p1')
if (map()['p1']) throw new Error('项目彻底删除失败')
console.log('✓ 项目 归档/取消归档/彻底删除')

// 备份（真实 Compress-Archive → 配置的本地目录；服务只返回安全 ID）
const bk = await svc.backup()
if (!bk.ok) throw new Error('备份失败: ' + JSON.stringify(bk))
if (!bk.id || JSON.stringify(bk).includes(tmp) || !svc.backups().some((item) => item.id === bk.id) || fs.readdirSync(backupsDir).filter((name) => name.endsWith('.zip')).length !== 1) throw new Error('备份必须发布安全 ID、持久化目录索引且不泄露路径')
const backupRestoreDir = path.join(tmp, 'backup-service-restore')
fs.mkdirSync(backupRestoreDir, { recursive: true })
const backupRestore = await svc.backupRestore(bk.id, backupRestoreDir)
if (!backupRestore.ok || fs.readdirSync(backupRestoreDir).length === 0 || (await svc.backupRestore(bk.id, backupRestoreDir)).reason !== 'restore-target-not-empty') throw new Error('备份服务必须仅按可信 ID 恢复到空目录且不覆盖')
console.log('✓ 备份（校验 ZIP、持久化调度状态、ID 恢复）')

// 状态视图
const st = svc.status()
if (!Array.isArray(st.active) || !Array.isArray(st.archived) || st.backupConfigured !== true) throw new Error('status 视图异常')
if (st.archived.some((entry) => entry.kind === 'project' && !entry.projectLabel)) throw new Error('归档项目必须提供安全项目标签')
await nativeArchive('native-only')
const nativeOnly = svc.status().archived.find((entry) => entry.id === 'native-only')
if (!nativeOnly || nativeOnly.mappingError !== 'mapping-not-found' || 'archivePath' in nativeOnly) throw new Error('归档列表必须以 DSH 原生状态为准且不得泄露路径')
const nativeRestore = await svc.restoreSession('native-only')
if (!nativeRestore.ok || nativeRestore.nativeRestored !== true || ctx.get('workspaceRegistry').archivedSessionIds.includes('native-only')) throw new Error('无本地映射的原生归档必须仍可恢复')
// DSH 自己的 UI 恢复不经过本插件。事件处理必须当场读取原生归档集，
// 不能因为旧的 cache status 而停止记录或捕获。
ctx.emit('session/created', { header: { id: 'native-ui-restore', cwd: dailyDir, createdAt: t0 } })
await nativeArchive('native-ui-restore')
if (!(await waitForNativeCache('native-ui-restore')).ok) throw new Error('native UI restore fixture cache sync failed')
await nativeUiRestore('native-ui-restore')
ctx.emit('session/event', { header: { id: 'native-ui-restore', cwd: dailyDir } }, { seq: 1, time: t0 + 1, type: 'user/message', data: { content: '恢复后继续记录' } })
const uiRestoreEntry = map()['native-ui-restore']
if (!fs.existsSync(uiRestoreEntry.recordFile) || !fs.readFileSync(uiRestoreEntry.recordFile, 'utf8').includes('恢复后继续记录')) throw new Error('原生 UI 恢复后必须立即继续记录，不能依赖打开 status')
const uiRestoreOutput = path.join(dailyDir, 'native-ui-restore-output.md')
fs.writeFileSync(uiRestoreOutput, 'native UI restore capture')
ctx.emit('session/disposed', { header: { id: 'native-ui-restore', cwd: dailyDir } })
if (!fs.existsSync(path.join(uiRestoreEntry.cacheDir, '文档', 'native-ui-restore-output.md'))) throw new Error('原生 UI 恢复后必须立即继续捕获产物')
console.log('✓ 原生 UI 恢复后立即恢复事件记录')
console.log('✓ status 视图')

// ── 场景4：管理能力只暴露在原生设置页 ──
if (toolsRegistered.length || commandsRegistered.length) throw new Error('不得注册失效的模型工具或斜杠命令')

// ── 场景5：agent 预设实例（role=agent，经根服务）──
toolsRegistered.length = 0
commandsRegistered.length = 0
await ctx.loader.create({
  id: 'conversation-archive-agent',
  name: PLUGIN_URL,
  config: { harnessRoot: tmp, statePath, configPath: testConfigPath, role: 'agent', backup: { targetDir: backupsDir } },
})
await ctx.loader.await()
if (toolsRegistered.length || commandsRegistered.length) throw new Error('agent 实例也不得重复注册管理工具或命令')
console.log('✓ 管理能力仅由原生设置页提供')

// ── 场景6：HTTP API 路由（客户端 UI 同源通道）──
const apiRoute = webRoutes.find((r) => r.path === '/conversation-archive-api')
if (!apiRoute) throw new Error('HTTP API 路由未注册')
let apiRes = null
const fakeRes = { writeHead: (s, h) => { apiRes = { status: s, headers: h } }, end: (body) => { apiRes.body = body } }
const call = (method, action, body, headers = {}) => apiRoute.handler({
  url: `/conversation-archive-api?action=${encodeURIComponent(action)}`,
  method,
  headers,
  body: body === undefined ? undefined : JSON.stringify(body),
}, fakeRes)
const jsonOf = () => JSON.parse(apiRes.body)

// Task 8：同源只读状态在启动时下发随机 CSRF token；旧固定头不再是认证方式。
await call('GET', 'status')
if (apiRes.status !== 200) throw new Error('带头请求应 200')
const parsed = jsonOf()
if (!parsed.ok || !parsed.result?.csrfToken || parsed.result.archiveRoot) throw new Error('API status 必须返回安全启动令牌且不得泄露绝对路径: ' + apiRes.body)
if (parsed.result?.settings?.remindIntervalDays !== 1 || parsed.result?.settings?.backup?.keepCount !== 5 || parsed.result?.settings?.retention?.maxCandidates !== 40 || parsed.result?.settings?.updateCheck?.enabled !== true) throw new Error('API status 必须返回 UI 所需的安全配置快照: ' + apiRes.body)
const csrf = parsed.result.csrfToken
const apiPost = (action, body, extraHeaders = {}) => call('POST', action, body, {
  'content-type': 'application/json', 'x-conversation-archive-csrf': csrf, ...extraHeaders,
})
await call('POST', 'restore', { id: 'd5' }, { 'content-type': 'application/json' })
if (apiRes.status !== 403 || jsonOf().error?.code !== 'csrf-invalid') throw new Error('POST 缺 CSRF token 必须拒绝')
await call('GET', 'restore')
if (apiRes.status !== 405) throw new Error('GET mutation 必须 405')
await call('GET', 'status', undefined, { 'x-conversation-archive': 'dsh' })
if (apiRes.status !== 200) throw new Error('旧固定头不得改变只读请求')
await call('GET', 'diagnostics')
if (apiRes.status !== 200 || JSON.stringify(jsonOf()).includes(tmp) || jsonOf().result?.csrfToken) throw new Error('诊断信息必须脱敏且不得返回 token 或绝对路径')
console.log('✓ HTTP API（随机 CSRF + 只读状态）')

// Real production path: native-only archive -> public list -> public delete.
// No hidden cache-sync helper is available or used.
const nativeDeleteId = 'native-delete-production'
persistedHeaders.set(nativeDeleteId, { id: nativeDeleteId, cwd: dailyDir, createdAt: t0 })
const nativeDeleteDir = fakeSessionDir(nativeDeleteId, dailyDir)
fs.mkdirSync(nativeDeleteDir, { recursive: true })
fs.writeFileSync(path.join(nativeDeleteDir, 'session.jsonl.zstd'), 'native log')
fs.writeFileSync(path.join(nativeDeleteDir, '最终说明.md'), 'non-rebuildable result')
await nativeArchive(nativeDeleteId)
await call('GET', 'archived')
if (!jsonOf().result.some((item) => item.id === nativeDeleteId && item.mappingError === 'mapping-not-found')) throw new Error('public archived list must include native-only archives')
await apiPost('deletePreview', { ids: [nativeDeleteId] })
if (!jsonOf().result.ok || jsonOf().result.noCacheCount !== 1 || jsonOf().result.candidateCount !== 1) throw new Error('delete preview must report native-only candidate scope')
await apiPost('delete', { id: nativeDeleteId })
if (!jsonOf().result.ok || fs.existsSync(nativeDeleteDir) || ctx.get('workspaceRegistry').archivedSessionIds.includes(nativeDeleteId)) throw new Error(`public native-only delete did not retain/recycle/clear native truth: ${apiRes.body}`)
const nativeRetained = JSON.parse(fs.readFileSync(path.join(tmp, 'retained.json'), 'utf8'))
if (!Object.values(nativeRetained.files).some((item) => item.sources.some((source) => source.sessionId === nativeDeleteId))) throw new Error('native-only output was not hash-protected')

const aiFailureId = 'native-delete-ai-failure'
persistedHeaders.set(aiFailureId, { id: aiFailureId, cwd: dailyDir, createdAt: t0 })
const aiFailureDir = fakeSessionDir(aiFailureId, dailyDir)
fs.mkdirSync(aiFailureDir, { recursive: true })
fs.writeFileSync(path.join(aiFailureDir, 'session.jsonl.zstd'), 'native log')
fs.writeFileSync(path.join(aiFailureDir, '失败保护.md'), 'must remain')
await nativeArchive(aiFailureId)
failRetention = true
await apiPost('delete', { id: aiFailureId })
failRetention = false
if (jsonOf().result.ok || !fs.existsSync(aiFailureDir) || !ctx.get('workspaceRegistry').archivedSessionIds.includes(aiFailureId)) throw new Error('forced AI failure must produce zero deletion')
const emptyRetentionId = 'native-delete-empty-retention'
persistedHeaders.set(emptyRetentionId, { id: emptyRetentionId, cwd: dailyDir, createdAt: t0 })
const emptyRetentionDir = fakeSessionDir(emptyRetentionId, dailyDir)
fs.mkdirSync(emptyRetentionDir, { recursive: true })
fs.writeFileSync(path.join(emptyRetentionDir, 'session.jsonl.zstd'), 'native log')
fs.writeFileSync(path.join(emptyRetentionDir, '可重建.md'), 'model may decide to retain nothing')
await nativeArchive(emptyRetentionId)
retainNone = true
const emptyRetentionDelete = await svc.purgeSession(emptyRetentionId)
retainNone = false
if (!emptyRetentionDelete.ok || fs.existsSync(emptyRetentionDir) || ctx.get('workspaceRegistry').archivedSessionIds.includes(emptyRetentionId)) throw new Error(`AI 返回空保留清单时仍应安全完成删除: ${JSON.stringify(emptyRetentionDelete)}`)
console.log('✓ 真实生产链：原生归档 → 公共删除 → AI/哈希保留；AI 失败零删除')

// saveConfig：仅允许经过验证的配置对象，不再读取 URL 参数。
await apiPost('saveConfig', { backup: { targetDir: 'D:\\云盘', enabled: true, autoIntervalDays: 2, keepCount: 5 }, updateCheck: { enabled: false } })
if (apiRes.status !== 200) throw new Error('saveConfig 非 200')
const cfg = jsonOf()
if (!cfg.result.ok || cfg.result.config.backup.targetDir !== 'D:\\云盘' || cfg.result.config.updateCheck?.enabled !== false) throw new Error('saveConfig 未生效: ' + apiRes.body)
await call('GET', 'status')
if (jsonOf().result?.settings?.backup?.targetLabel !== '云盘' || jsonOf().result?.settings?.backup?.autoIntervalDays !== 2 || jsonOf().result?.settings?.updateCheck?.enabled !== false) throw new Error('安全 status 配置快照未随保存收敛: ' + apiRes.body)
if (JSON.parse(fs.readFileSync(testConfigPath, 'utf8')).schemaVersion !== 1) throw new Error('saveConfig 未持久化 schemaVersion')
await apiPost('saveConfig', { backup: { targetDir: 'https://example.test/backup' } })
if (apiRes.status !== 400 || jsonOf().error?.code !== 'invalid-request') throw new Error('saveConfig 必须拒绝云端 URL 和未知目标类型')
await apiPost('saveConfig', { unknown: true })
if (apiRes.status !== 400 || jsonOf().error?.code !== 'invalid-request') throw new Error('saveConfig 必须拒绝未知字段')
fs.writeFileSync(testConfigPath, JSON.stringify({ schemaVersion: 1, backup: { targetDir: 'D:\\云盘', credential: 'legacy-secret' }, retention: { apiKey: 'legacy-token' }, injected: { password: 'legacy-password' } }))
await apiPost('saveConfig', { remind: { intervalDays: 3 } })
if (apiRes.status !== 200 || JSON.stringify(jsonOf().result).includes('legacy-secret')) throw new Error('saveConfig 响应不得泄露遗留嵌套秘密')
const sanitizedConfig = fs.readFileSync(testConfigPath, 'utf8')
if (sanitizedConfig.includes('legacy-secret') || sanitizedConfig.includes('legacy-token') || sanitizedConfig.includes('legacy-password') || sanitizedConfig.includes('injected')) throw new Error('saveConfig 必须剥离遗留未知/秘密配置键')
console.log('✓ HTTP API saveConfig（配置写入并重载）')

// project records are files, so cache deletion must select DeleteFile rather
// than treating every cache item as a directory.
ctx.emit('session/created', { header: { id: 'project-file-cache', cwd: path.join(projDir, 'src'), createdAt: t0 } })
ctx.emit('session/event', { header: { id: 'project-file-cache', cwd: projDir } }, { seq: 1, time: t0 + 1, type: 'user/message', data: { content: 'file cache' } })
const projectRecordForDelete = map()['project-file-cache'].recordFile
await call('GET', 'cacheDelete')
if (apiRes.status !== 404 || !fs.existsSync(projectRecordForDelete)) throw new Error('遗留 cacheDelete 路由必须不存在，客户端不能按路径删除缓存')
await call('POST', 'backup', {}, { 'content-type': 'text/plain', 'x-conversation-archive-csrf': csrf })
if (apiRes.status !== 400 || jsonOf().error?.code !== 'invalid-request') throw new Error('API 必须拒绝错误 Content-Type')
await apiRoute.handler({ url: '/conversation-archive-api?action=backup', method: 'POST', headers: { 'content-type': 'application/json', 'x-conversation-archive-csrf': csrf }, body: '{"selection":{},"selection":{}}' }, fakeRes)
if (apiRes.status !== 400 || jsonOf().error?.code !== 'invalid-request') throw new Error('API 必须拒绝重复 JSON 字段')
await apiRoute.handler({ url: '/conversation-archive-api?action=backup', method: 'POST', headers: { 'content-type': 'application/json', 'x-conversation-archive-csrf': csrf, 'content-length': String(64 * 1024 + 1) }, body: '{}' }, fakeRes)
if (apiRes.status !== 413 || jsonOf().error?.code !== 'body-too-large') throw new Error('API 必须限制 JSON body 大小')
console.log('✓ HTTP API（路径删除已移除、JSON 边界受控）')

// DSH 原生归档后，插件只同步关联缓存；HTTP 不得提供主动归档入口。
ctx.emit('session/created', { header: { id: 'd5', cwd: dailyDir, createdAt: t0 } })
ctx.emit('session/created', { header: { id: 'd6', cwd: dailyDir, createdAt: t0 } })
await nativeArchive('d5'); await nativeArchive('d6')
await Promise.all([waitForNativeCache('d5'), waitForNativeCache('d6')])
await call('GET', 'archiveMany')
if (apiRes.status !== 404 || jsonOf().ok !== false) throw new Error('HTTP 不得提供主动归档入口')
if (map()['d5'].status !== 'archived' || map()['d6'].status !== 'archived') throw new Error('原生归档后的缓存同步未生效')
await apiPost('restoreMany', { ids: ['d5', 'd5', 'd6'] })
const restoredBatch = jsonOf().result
if (restoredBatch.length !== 2 || restoredBatch.some((item) => !item.ok) || ctx.get('workspaceRegistry').archivedSessionIds.includes('d5')) throw new Error('批量恢复必须去重并返回逐项结果')
await apiPost('restoreMany', { ids: Array.from({ length: 51 }, (_, index) => `too-many-${index}`) })
if (apiRes.status !== 400 || jsonOf().error?.code !== 'invalid-request') throw new Error('批量会话 ID 必须限额')
await apiPost('restore', { id: 'd5' })
if (apiRes.status !== 409 || jsonOf().error?.code !== 'not-natively-archived') throw new Error('恢复必须以 DSH 当前归档状态为准')

// The public batch-delete action must drive the same native/cache transaction
// for every distinct archived id; duplicate UI selections are ignored.
for (const id of ['d1', 'd2']) {
  ctx.emit('session/created', { header: { id, cwd: dailyDir, createdAt: t0 } })
  const nativeLog = path.join(fakeSessionDir(id, dailyDir), 'session.jsonl.zstd')
  fs.mkdirSync(path.dirname(nativeLog), { recursive: true })
  fs.writeFileSync(nativeLog, 'native batch log')
  await nativeArchive(id)
  const prepared = await waitForNativeCache(id)
  if (!prepared.ok) throw new Error(`公共批量删除前缓存未归档: ${id}`)
}
await apiPost('deleteMany', { ids: ['d1', 'd1', 'd2'] })
const deletedBatch = jsonOf().result
if (deletedBatch.length !== 2 || deletedBatch.some((item) => !item.ok) || map().d1 || map().d2 || ctx.get('workspaceRegistry').archivedSessionIds.some((id) => ['d1', 'd2'].includes(id))) throw new Error(`公共批量删除必须逐项完成并清除 DSH 归档状态: ${apiRes.body}`)
console.log('✓ 原生归档缓存同步与公共批量删除（HTTP 无主动归档）')

// ── 场景7：会话联动（DSH 会话目录移动/恢复/回收）+ 活动拦截 + 重要文件保护 ──
ctx.emit('session/created', { header: { id: 'd7', cwd: dailyDir, createdAt: t0 } })
ctx.emit('session/event', { header: { id: 'd7', cwd: dailyDir } }, { seq: 1, time: t0 + 1, type: 'session/title', data: { title: '报告7' } })
const d7Cache = map()['d7'].cacheDir
fs.mkdirSync(path.join(d7Cache, '文档'), { recursive: true })
fs.writeFileSync(path.join(d7Cache, '文档', '报告.docx'), 'x') // 重要文件
const d7SessionDir = fakeSessionDir('d7', dailyDir)
fs.mkdirSync(path.join(d7SessionDir, '子'), { recursive: true })
fs.writeFileSync(path.join(d7SessionDir, '子', 'session.jsonl.zstd'), 'x')
await nativeArchive('d7'); await waitForNativeCache('d7')
const d7 = map()['d7']
if (!fs.existsSync(d7SessionDir) || fs.existsSync(path.join(d7.archivePath, '.dsh-session'))) throw new Error('归档缓存不得移动 DSH 原生会话目录')
console.log('✓ 归档缓存同步（DSH 会话目录保持原位）')

// 活动会话归档只同步插件缓存，不触碰 DSH 会话目录。
liveSessions.add('d8')
ctx.emit('session/created', { header: { id: 'd8', cwd: dailyDir, createdAt: t0 } })
await nativeArchive('d8')
const a8 = await waitForNativeCache('d8')
if (!a8.ok) throw new Error('活动会话缓存同步失败: ' + JSON.stringify(a8))
if (map()['d8'].status !== 'archived') throw new Error('活动会话归档未进入已归档')
const d8Sess = fakeSessionDir('d8', dailyDir)
fs.mkdirSync(d8Sess, { recursive: true })
fs.writeFileSync(path.join(d8Sess, 'session.jsonl.zstd'), 'x')
liveSessions.delete('d8') // 会话关闭后
await waitForNativeCache('d8')
if (!fs.existsSync(d8Sess) || fs.existsSync(path.join(map()['d8'].archivePath, '.dsh-session'))) throw new Error('重复同步不得移动 DSH 会话')
console.log('✓ 活动会话归档（无 pending、无 DSH 文件移动）')

// 取消归档只恢复 DSH 原生状态与插件缓存，原生会话目录始终原位。
await svc.restoreSession('d7')
if (!fs.existsSync(d7SessionDir) || !fs.existsSync(path.join(d7SessionDir, '子', 'session.jsonl.zstd'))) throw new Error('取消归档未恢复 DSH 会话目录')
console.log('✓ 取消归档（DSH 会话目录始终原位）')

// 再次归档并彻底删除 → 重要文件保护
await nativeArchive('d7')
await svc.purgeSession('d7')
if (ctx.get('workspaceRegistry').archivedSessionIds.includes('d7')) throw new Error('最终删除成功后必须移除 DSH 原生归档 id')
const retainedIndex = JSON.parse(fs.readFileSync(path.join(tmp, 'retained.json'), 'utf8'))
const retainedRecord = Object.values(retainedIndex.files).find((item) => item.sources.some((source) => source.sessionId === 'd7' && source.originalRelativePath === path.join('文档', '报告.docx')))
if (!retainedRecord || !fs.existsSync(retainedRecord.path)) throw new Error('重要文件未保留到全局库')
console.log('✓ AI 重要文件保留（彻底删除后仍在全局保护库）')

// Retained listing now returns stable records, never a browsable absolute-path tree.
await call('GET', 'retained')
const prot = jsonOf()
if (!prot.result.some((p) => p.id === retainedRecord.sha256) || JSON.stringify(prot.result).includes(tmp)) throw new Error('protected 必须返回脱敏保留记录')
const outsideCacheTarget = path.join(tmp, 'outside-cache-delete.txt')
fs.writeFileSync(outsideCacheTarget, 'keep')
await call('GET', 'locate')
if (apiRes.status !== 404 || !fs.existsSync(outsideCacheTarget)) throw new Error('API 不得暴露 locator 或按路径缓存操作')
await call('GET', 'status')
const st2 = jsonOf().result
if (!('backupConfigured' in st2) || !('reminder' in st2) || JSON.stringify(st2).includes(tmp)) throw new Error('status 缺备份/提醒字段或泄露路径')
if (JSON.parse(fs.readFileSync(path.join(path.dirname(statePath), 'status.json'), 'utf8')).schemaVersion !== 1) throw new Error('status 未版本化')
console.log('✓ API protected / locate / cacheScan / status（备份+提醒字段）')

// ── 场景8：不可信状态与 locator 绝不能授予文件系统权限 ──
const makeIsolatedContext = async (root, isolatedState, isolatedConfig, locate, patch = {}) => {
  const isolated = new Context()
  const { fsApi: runtimeFs, recycle: runtimeRecycle, dshRecycle: runtimeDshRecycle, sessionPersistence: persistencePatch = {}, archivedIds: initialArchivedIds = [], nativeDelete = true, ...pluginPatch } = patch
  const routes = []
  isolated.provide('webServer', { register: (route) => { routes.push(route); return () => {} } })
  isolated.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) })
  isolated.provide('llm', retentionLlm)
  isolated.provide('tools', { register: () => () => {} })
  isolated.provide('commands', { register: () => () => {} })
  isolated.provide('sessions', { list: () => [], get: () => undefined, create: () => null })
  isolated.provide('sessionPersistence', { root: path.join(root, 'dsh-sessions'), compression: 'zstd', locate, listSnapshots: async () => [], ...persistencePatch })
  let isolatedWorkspaceState = { archivedSessionIds: [...initialArchivedIds] }
  let isolatedWorkspaceTail = Promise.resolve()
  const workspaceRegistry = {
    get archivedSessionIds() { return isolatedWorkspaceState.archivedSessionIds },
    archiveSession: async (id) => {
      if (!isolatedWorkspaceState.archivedSessionIds.includes(id)) isolatedWorkspaceState = { ...isolatedWorkspaceState, archivedSessionIds: [...isolatedWorkspaceState.archivedSessionIds, id] }
    },
    requireState: () => isolatedWorkspaceState,
    setState: async (next) => { isolatedWorkspaceState = next },
    enqueueOperation: (operation) => {
      const result = isolatedWorkspaceTail.then(operation)
      isolatedWorkspaceTail = result.catch(() => {})
      return result
    },
  }
  if (nativeDelete) workspaceRegistry.deleteArchivedSession = async (id) => {
    isolatedWorkspaceState = { ...isolatedWorkspaceState, archivedSessionIds: isolatedWorkspaceState.archivedSessionIds.filter((item) => item !== id) }
  }
  isolated.provide('workspaceRegistry', workspaceRegistry)
  if (runtimeFs) isolated.provide('conversationArchiveFs', runtimeFs)
  if (runtimeRecycle) isolated.provide('conversationArchiveRecycle', runtimeRecycle)
  if (runtimeDshRecycle) isolated.provide('conversationArchiveDshRecycle', runtimeDshRecycle)
  await isolated.plugin(Loader, { baseUrl: new URL('../', resolveDshPackage('@deepseek-ai/cordis-plugin-loader')).href })
  await isolated.loader.create({ id: `conversation-archive-safe-${path.basename(root)}`, name: PLUGIN_URL, config: { harnessRoot: root, statePath: isolatedState, configPath: isolatedConfig, ...pluginPatch } })
  await isolated.loader.await()
  return { context: isolated, workspaceRegistry, service: isolated.get('conversationArchive'), route: routes.find((item) => item.path === '/conversation-archive-api') }
}

// DSH 0.1.1-rc.2 exposes restore but no destructive API. In that runtime a
// delete must remain archived/hidden until the next clean start, then recycle
// the independently validated data before clearing the archive marker.
const stagedRoot = path.join(tmp, 'staged-native-delete')
const stagedState = path.join(stagedRoot, 'state.json')
const stagedConfig = path.join(stagedRoot, 'config.json')
const stagedLogs = path.join(stagedRoot, 'dsh-sessions')
const stagedId = 'staged-delete-session'
const stagedHeader = { id: stagedId, cwd: path.join(stagedRoot, 'daily_conversation'), createdAt: t0 }
const stagedLocate = (meta) => ({ path: path.join(stagedLogs, fakeSessionProjectKey(meta.cwd), String(meta.id), 'session.jsonl.zstd') })
const removeTree = async (target) => { fs.rmSync(target, { recursive: true, force: true }); return { ok: true } }
const staged = await makeIsolatedContext(stagedRoot, stagedState, stagedConfig, stagedLocate, {
  nativeDelete: false,
  recycle: removeTree,
  dshRecycle: removeTree,
  sessionPersistence: { root: stagedLogs, compression: 'zstd', listSnapshots: async () => [{ header: stagedHeader }] },
})
fs.mkdirSync(stagedHeader.cwd, { recursive: true })
staged.context.emit('session/created', { header: stagedHeader })
const stagedLog = stagedLocate(stagedHeader).path
fs.mkdirSync(path.dirname(stagedLog), { recursive: true })
fs.writeFileSync(stagedLog, 'native log')
await staged.workspaceRegistry.archiveSession(stagedId)
await staged.service.syncArchivedCaches()
const stagedResult = await staged.service.purgeSession(stagedId)
const stagedStatus = JSON.parse(fs.readFileSync(path.join(stagedRoot, 'status.json'), 'utf8'))
if (!stagedResult.ok || !stagedResult.pendingRestart || !fs.existsSync(stagedLog) || !staged.workspaceRegistry.archivedSessionIds.includes(stagedId) || staged.service.status().archived.some((item) => item.id === stagedId) || staged.service.status().pendingDeletionCount !== 1 || !stagedStatus.purgeQueue?.some((item) => item.sessionId === stagedId)) throw new Error(`无原生删除 API 时必须排队、隐藏且不取消归档: ${JSON.stringify({ stagedResult, stagedStatus })}`)
await staged.context.fiber.dispose()
const stagedRestart = await makeIsolatedContext(stagedRoot, stagedState, stagedConfig, stagedLocate, {
  nativeDelete: false,
  archivedIds: [stagedId],
  recycle: removeTree,
  dshRecycle: removeTree,
  sessionPersistence: { root: stagedLogs, compression: 'zstd', listSnapshots: async () => [{ header: stagedHeader }] },
})
const stagedDeadline = Date.now() + 3000
while (Date.now() < stagedDeadline && (fs.existsSync(stagedLog) || stagedRestart.workspaceRegistry.archivedSessionIds.includes(stagedId))) await new Promise((resolve) => setTimeout(resolve, 25))
const stagedRestartStatus = JSON.parse(fs.readFileSync(path.join(stagedRoot, 'status.json'), 'utf8'))
if (fs.existsSync(stagedLog) || stagedRestart.workspaceRegistry.archivedSessionIds.includes(stagedId) || stagedRestartStatus.purgeQueue?.some((item) => item.sessionId === stagedId)) throw new Error(`重启后删除队列必须回收数据再清除归档标记: ${JSON.stringify(stagedRestartStatus)}`)
await stagedRestart.context.fiber.dispose()
console.log('✓ DSH 无原生删除 API：删除排队隐藏，重启后安全收敛且不复活')

const cancelRoot = path.join(tmp, 'staged-delete-cancel')
const cancelState = path.join(cancelRoot, 'state.json')
const cancelConfig = path.join(cancelRoot, 'config.json')
const cancelLogs = path.join(cancelRoot, 'dsh-sessions')
const cancelId = 'staged-delete-cancel-session'
const cancelHeader = { id: cancelId, cwd: path.join(cancelRoot, 'daily_conversation'), createdAt: t0 }
const cancelLocate = (meta) => ({ path: path.join(cancelLogs, fakeSessionProjectKey(meta.cwd), String(meta.id), 'session.jsonl.zstd') })
const cancel = await makeIsolatedContext(cancelRoot, cancelState, cancelConfig, cancelLocate, { nativeDelete: false, recycle: removeTree, dshRecycle: removeTree, sessionPersistence: { root: cancelLogs, compression: 'zstd', listSnapshots: async () => [{ header: cancelHeader }] } })
fs.mkdirSync(cancelHeader.cwd, { recursive: true })
cancel.context.emit('session/created', { header: cancelHeader })
const cancelLog = cancelLocate(cancelHeader).path
fs.mkdirSync(path.dirname(cancelLog), { recursive: true })
fs.writeFileSync(cancelLog, 'must survive restored cancellation')
await cancel.workspaceRegistry.archiveSession(cancelId)
await cancel.service.syncArchivedCaches()
if (!(await cancel.service.purgeSession(cancelId)).pendingRestart) throw new Error('取消场景未进入删除队列')
await cancel.workspaceRegistry.enqueueOperation(async () => { const value = cancel.workspaceRegistry.requireState(); await cancel.workspaceRegistry.setState({ ...value, archivedSessionIds: [] }) })
await cancel.context.fiber.dispose()
const cancelRestart = await makeIsolatedContext(cancelRoot, cancelState, cancelConfig, cancelLocate, { nativeDelete: false, archivedIds: [], recycle: removeTree, dshRecycle: removeTree, sessionPersistence: { root: cancelLogs, compression: 'zstd', listSnapshots: async () => [{ header: cancelHeader }] } })
const cancelDeadline = Date.now() + 1000
while (Date.now() < cancelDeadline && JSON.parse(fs.readFileSync(path.join(cancelRoot, 'status.json'), 'utf8')).purgeQueue?.length) await new Promise((resolve) => setTimeout(resolve, 25))
if (!fs.existsSync(cancelLog) || JSON.parse(fs.readFileSync(path.join(cancelRoot, 'status.json'), 'utf8')).purgeQueue?.length || cancelRestart.service.status().writesDisabled) throw new Error('DSH 原生恢复必须取消旧删除意图、保留会话数据且保持插件可写')
await cancelRestart.context.fiber.dispose()
console.log('✓ 删除排队后在 DSH 原生恢复：旧意图自动取消，不会在再次归档后误删')

// Reconciliation may move a cache after purge has read its active mapping but
// before it checks the active directory. Trigger the real host-side sync from
// that exact check and prove purge re-reads the now-archived mapping instead
// of falling through to the native-only path and leaving the archive behind.
const reconcileRaceRoot = path.join(tmp, 'reconcile-race')
const reconcileRaceState = path.join(reconcileRaceRoot, 'state.json')
const reconcileRaceConfig = path.join(reconcileRaceRoot, 'config.json')
const reconcileRaceDaily = path.join(reconcileRaceRoot, 'daily_conversation')
const reconcileRaceId = 'reconcile-race-session'
let reconcileRaceTarget = ''
let reconcileRaceEnabled = false
let reconcileRaceInterleaved = false
let reconcileRaceSync = null
let reconcileRaceService = null
const reconcileRaceFs = Object.create(fs)
reconcileRaceFs.existsSync = (target) => {
  if (reconcileRaceEnabled && !reconcileRaceInterleaved && path.resolve(target) === path.resolve(reconcileRaceTarget)) {
    reconcileRaceInterleaved = true
    reconcileRaceSync = reconcileRaceService.syncArchivedCaches()
  }
  return fs.existsSync(target)
}
const reconcileRaceLogs = path.join(reconcileRaceRoot, 'dsh-sessions')
const reconcileRace = await makeIsolatedContext(reconcileRaceRoot, reconcileRaceState, reconcileRaceConfig,
  (meta) => ({ path: path.join(reconcileRaceLogs, fakeSessionProjectKey(meta.cwd), String(meta.id), 'session.jsonl.zstd') }), {
    fsApi: reconcileRaceFs,
    updateCheck: { enabled: false },
    recycle: async (target) => { fs.rmSync(target, { recursive: true, force: true }); return { ok: true } },
    dshRecycle: async (target) => { fs.rmSync(target, { recursive: true, force: true }); return { ok: true } },
  })
reconcileRaceService = reconcileRace.service
reconcileRace.context.emit('session/created', { header: { id: reconcileRaceId, cwd: reconcileRaceDaily, createdAt: t0 } })
reconcileRaceService.flush()
const reconcileRaceEntry = JSON.parse(fs.readFileSync(reconcileRaceState, 'utf8'))[reconcileRaceId]
reconcileRaceTarget = reconcileRaceEntry.cacheDir
fs.writeFileSync(path.join(reconcileRaceTarget, '文档', '最终成果.md'), 'must survive the review before cache recycle')
const reconcileRaceLog = path.join(reconcileRaceLogs, fakeSessionProjectKey(reconcileRaceDaily), reconcileRaceId, 'session.jsonl.zstd')
fs.mkdirSync(path.dirname(reconcileRaceLog), { recursive: true })
fs.writeFileSync(reconcileRaceLog, 'native session log')
reconcileRaceEnabled = true
await reconcileRace.workspaceRegistry.archiveSession(reconcileRaceId)
reconcileRaceFs.existsSync(reconcileRaceTarget)
const reconcileRaceResult = await reconcileRaceService.purgeSession(reconcileRaceId)
if (reconcileRaceSync) await reconcileRaceSync
const reconcileRaceArchive = path.join(reconcileRaceRoot, '对话归档', '日常', reconcileRaceEntry.date, path.basename(reconcileRaceTarget))
if (!reconcileRaceInterleaved || !reconcileRaceResult.ok || fs.existsSync(reconcileRaceArchive) || reconcileRace.workspaceRegistry.archivedSessionIds.includes(reconcileRaceId)) throw new Error(`缓存同步插入 purge 后必须重新读取已归档映射并完整回收: ${JSON.stringify(reconcileRaceResult)}`)
console.log('✓ 归档缓存同步与 purge 快照交错（重新读取注册归档根）')

// A purge keeps its preflight map while retention/recycle work awaits. Force
// the normal archive-cache synchronizer to archive a second native session in
// that window. The first purge must remove only its own entry from the latest
// map; committing the old snapshot would silently reset the second session to
// active and lose its archivePath.
const lostUpdateRoot = path.join(tmp, 'purge-lost-update')
const lostUpdateState = path.join(lostUpdateRoot, 'state.json')
const lostUpdateConfig = path.join(lostUpdateRoot, 'config.json')
const lostUpdateDaily = path.join(lostUpdateRoot, 'daily_conversation')
const lostUpdateLogs = path.join(lostUpdateRoot, 'dsh-sessions')
const purgeRaceId = 'purge-race-first'
const reconcileRaceId2 = 'purge-race-second'
let lostUpdateService = null
let lostUpdateInterleaved = false
const lostUpdate = await makeIsolatedContext(lostUpdateRoot, lostUpdateState, lostUpdateConfig,
  (meta) => ({ path: path.join(lostUpdateLogs, fakeSessionProjectKey(meta.cwd), String(meta.id), 'session.jsonl.zstd') }), {
    updateCheck: { enabled: false },
    recycle: async (target) => { fs.rmSync(target, { recursive: true, force: true }); return { ok: true } },
    dshRecycle: async (target) => {
      if (!lostUpdateInterleaved && path.resolve(target).includes(purgeRaceId)) {
        lostUpdateInterleaved = true
        await lostUpdateService.syncArchivedCaches()
      }
      fs.rmSync(target, { recursive: true, force: true })
      return { ok: true }
    },
  })
lostUpdateService = lostUpdate.service
for (const id of [purgeRaceId, reconcileRaceId2]) {
  lostUpdate.context.emit('session/created', { header: { id, cwd: lostUpdateDaily, createdAt: t0 } })
  const log = path.join(lostUpdateLogs, fakeSessionProjectKey(lostUpdateDaily), id, 'session.jsonl.zstd')
  fs.mkdirSync(path.dirname(log), { recursive: true })
  fs.writeFileSync(log, `native session ${id}`)
}
lostUpdateService.flush()
await lostUpdate.workspaceRegistry.archiveSession(purgeRaceId)
await lostUpdateService.syncArchivedCaches()
const firstArchived = JSON.parse(fs.readFileSync(lostUpdateState, 'utf8'))[purgeRaceId]
fs.writeFileSync(path.join(firstArchived.archivePath, '文档', '最终成果.md'), 'retention makes this purge asynchronous')
await lostUpdate.workspaceRegistry.archiveSession(reconcileRaceId2)
const lostUpdateResult = await lostUpdateService.purgeSession(purgeRaceId)
lostUpdateService.flush()
const lostUpdateMap = JSON.parse(fs.readFileSync(lostUpdateState, 'utf8'))
const secondAfterRace = lostUpdateMap[reconcileRaceId2]
if (!lostUpdateInterleaved || !lostUpdateResult.ok || lostUpdateMap[purgeRaceId] || !secondAfterRace || secondAfterRace.status !== 'archived' || !secondAfterRace.archivePath || !fs.existsSync(secondAfterRace.archivePath)) throw new Error(`purge 完成不得覆盖并发归档映射: ${JSON.stringify({ lostUpdateInterleaved, lostUpdateResult, secondAfterRace })}`)
console.log('✓ purge 终态合并保留并发归档映射')

// Every GET is a snapshot: legacy state must be normalized at boot, and native
// archive/cache disagreement must not cause polling to persist a reconciliation.
const readonlyRoot = path.join(tmp, 'api-readonly')
const readonlyState = path.join(readonlyRoot, 'state.json')
const readonlyConfig = path.join(readonlyRoot, 'config.json')
const readonlyStateRoot = path.dirname(readonlyState)
const readonlyId = 'readonly-native-archive'
const readonlyCache = path.join(readonlyRoot, 'daily_conversation', '2026-08-30', readonlyId)
const readonlyRecord = path.join(readonlyCache, '会话记录', '对话记录.jsonl')
fs.mkdirSync(path.dirname(readonlyRecord), { recursive: true })
fs.mkdirSync(path.join(readonlyRoot, '重要文件保护', 'files'), { recursive: true })
fs.writeFileSync(readonlyRecord, '{}')
fs.writeFileSync(readonlyState, JSON.stringify({ [readonlyId]: { id: readonlyId, kind: 'daily', date: '2026-08-30', tag: '只读', cacheDir: readonlyCache, recordFile: readonlyRecord, status: 'active' } }))
fs.writeFileSync(readonlyConfig, JSON.stringify({ backup: { targetDir: path.join(readonlyRoot, 'backups'), credential: 'legacy-secret' }, retention: { apiKey: 'legacy-token' } }))
fs.writeFileSync(path.join(readonlyStateRoot, 'status.json'), JSON.stringify({ token: 'status-secret' }))
fs.writeFileSync(path.join(readonlyStateRoot, 'retained.json'), JSON.stringify({ files: {} }))
fs.writeFileSync(path.join(readonlyStateRoot, 'backups.json'), JSON.stringify({ backups: [], nextBackupAt: '' }))
const readonlyApi = await makeIsolatedContext(readonlyRoot, readonlyState, readonlyConfig, () => null, {
  archivedIds: [readonlyId],
  backup: { targetDir: path.join(readonlyRoot, 'initial-backups'), credential: 'initial-config-secret' },
  retention: { apiKey: 'initial-config-token' },
  categories: JSON.parse('{".safe":"代码","__proto__":"代码","prototype":"代码"}'),
})
const readonlyServiceConfig = JSON.stringify(readonlyApi.service.getConfig())
if (/initial-config-(secret|token)|legacy-(secret|token)|credential|apiKey|__proto__|prototype/.test(readonlyServiceConfig)) throw new Error('服务 getConfig 不得绕过安全配置视图')
const readonlyFiles = [readonlyState, readonlyConfig, path.join(readonlyStateRoot, 'status.json'), path.join(readonlyStateRoot, 'retained.json'), path.join(readonlyStateRoot, 'backups.json')]
const readonlyBefore = Object.fromEntries(readonlyFiles.map((file) => [file, fs.readFileSync(file, 'utf8')]))
for (const action of ['status', 'archived', 'retained', 'backups', 'diagnostics']) {
  let response = null
  await readonlyApi.route.handler({ url: `/conversation-archive-api?action=${action}`, method: 'GET', headers: {} }, { writeHead: (status) => { response = { status } }, end: (body) => { response.body = body } })
  if (response.status !== 200) throw new Error(`GET ${action} 必须可读取`)
}
for (const file of readonlyFiles) if (fs.readFileSync(file, 'utf8') !== readonlyBefore[file]) throw new Error(`GET 轮询不得修改 ${path.basename(file)}`)
let readonlyConfigResponse = null
await readonlyApi.route.handler({ url: '/conversation-archive-api?action=status', method: 'GET', headers: {} }, { writeHead: (status) => { readonlyConfigResponse = { status } }, end: (body) => { readonlyConfigResponse.body = body } })
const readonlyCsrf = JSON.parse(readonlyConfigResponse.body).result.csrfToken
await readonlyApi.route.handler({ url: '/conversation-archive-api?action=saveConfig', method: 'POST', headers: { 'content-type': 'application/json', 'x-conversation-archive-csrf': readonlyCsrf }, body: JSON.stringify({ remind: { intervalDays: 2 } }) }, { writeHead: (status) => { readonlyConfigResponse = { status } }, end: (body) => { readonlyConfigResponse.body = body } })
const readonlySaved = JSON.stringify(readonlyConfigResponse)
const readonlyDisk = fs.readFileSync(readonlyConfig, 'utf8')
if (readonlyConfigResponse.status !== 200 || /initial-config-(secret|token)|legacy-(secret|token)|credential|apiKey|__proto__|prototype/.test(readonlySaved) || /initial-config-(secret|token)|legacy-(secret|token)|credential|apiKey|__proto__|prototype/.test(readonlyDisk)) throw new Error('saveConfig 必须清洗初始配置和磁盘遗留配置中的未知/敏感键')
console.log('✓ HTTP API GET 完全只读（遗留迁移与原生状态差异均在启动时收敛）')

const safeRoot = path.join(tmp, 'safety')
const safeState = path.join(safeRoot, 'state.json')
const safeConfig = path.join(safeRoot, 'config.json')
const safeDate = '2026-08-30'
const safeCache = (id) => path.join(safeRoot, 'daily_conversation', safeDate, id)
const safeRecord = (id) => path.join(safeCache(id), '会话记录', '对话记录.jsonl')
const safeEntry = (id, status = 'active') => ({ id, kind: 'daily', date: safeDate, tag: id, cacheDir: safeCache(id), recordFile: safeRecord(id), status })
const archiveParent = path.join(safeRoot, '对话归档', '日常', safeDate)
const outsidePoison = path.join(tmp, 'poison-outside')
fs.mkdirSync(outsidePoison, { recursive: true })
const poisonedArchive = { ...safeEntry('poison-archive'), cacheDir: outsidePoison }
const poisonedRestore = { ...safeEntry('poison-restore', 'archived'), archivePath: path.join(archiveParent, 'other-session') }
const poisonedPurge = { ...safeEntry('poison-purge', 'archived'), archivePath: path.join(archiveParent, 'other-session-2') }
const safeCacheEntry = safeEntry('safe-cache')
fs.mkdirSync(path.dirname(safeCacheEntry.recordFile), { recursive: true })
fs.writeFileSync(safeCacheEntry.recordFile, '{}')
fs.writeFileSync(safeState, JSON.stringify({ schemaVersion: 1, [poisonedArchive.id]: poisonedArchive, [poisonedRestore.id]: poisonedRestore, [poisonedPurge.id]: poisonedPurge, [safeCacheEntry.id]: safeCacheEntry }))
let poisonResponse = null
const poisoned = await makeIsolatedContext(safeRoot, safeState, safeConfig, (meta) => ({ path: path.join(process.env.DSH_HOME, 'sessions', String(meta.id), 'session.jsonl.zstd') }))
await poisoned.route.handler({ url: '/conversation-archive-api?action=status', method: 'GET', headers: {} }, { writeHead: (status) => { poisonResponse = { status } }, end: (body) => { poisonResponse.body = body } })
if (poisonResponse.status !== 200 || JSON.parse(poisonResponse.body).result.csrfToken === csrf) throw new Error('每次插件启动必须生成不同的 CSRF token')
await poisoned.workspaceRegistry.archiveSession(poisonedRestore.id)
const poisonRestoreResult = await poisoned.service.restoreSession(poisonedRestore.id)
if (!poisonRestoreResult.ok || poisonRestoreResult.cacheBookkeeping?.ok) throw new Error('篡改映射不得阻止原生恢复，但必须拒绝缓存写入')
await poisoned.workspaceRegistry.archiveSession(poisonedPurge.id)
if ((await poisoned.service.purgeSession(poisonedPurge.id)).ok) throw new Error('篡改映射不应允许 purgeSession')
const poisonRes = { writeHead: (status) => { poisonResponse = { status } }, end: (body) => { poisonResponse.body = body } }
await poisoned.route.handler({ url: '/conversation-archive-api?action=cacheDelete', method: 'GET', headers: {} }, poisonRes)
if (poisonResponse.status !== 404 || !fs.existsSync(outsidePoison)) throw new Error('篡改映射不得借遗留 cacheDelete 路由授权')

const locatorRoot = path.join(tmp, 'locator-safety')
const locatorState = path.join(locatorRoot, 'state.json')
const locatorConfig = path.join(locatorRoot, 'config.json')
const locatorIds = ['outside', 'other', 'ancestor']
const locatorMap = Object.fromEntries(locatorIds.map((id) => {
  const entry = safeEntry(id)
  entry.cacheDir = path.join(locatorRoot, 'daily_conversation', safeDate, id)
  entry.recordFile = path.join(entry.cacheDir, '会话记录', '对话记录.jsonl')
  fs.mkdirSync(path.dirname(entry.recordFile), { recursive: true })
  fs.writeFileSync(entry.recordFile, '{}')
  return [id, entry]
}))
fs.writeFileSync(locatorState, JSON.stringify({ schemaVersion: 1, ...locatorMap }))
const expectedSessions = path.join(process.env.DSH_HOME, 'sessions')
const badLocator = await makeIsolatedContext(locatorRoot, locatorState, locatorConfig, (meta) => {
  const id = String(meta.id)
  if (id === 'outside') return { path: path.join(tmp, 'outside-locator', id, 'session.jsonl.zstd') }
  if (id === 'other') return { path: path.join(expectedSessions, 'other-session', 'session.jsonl.zstd') }
  return { path: path.join(expectedSessions, 'ancestor', 'child', 'session.jsonl.zstd') }
})
for (const id of locatorIds) {
  await badLocator.workspaceRegistry.archiveSession(id)
  const purged = await badLocator.service.purgeSession(id)
  const mapped = JSON.parse(fs.readFileSync(locatorState, 'utf8'))[id]
  if (fs.existsSync(path.join(mapped.archivePath, '.dsh-session'))) throw new Error(`不可信 locator 不得移动 DSH 会话: ${id}`)
  if (purged.ok || !mapped || !fs.existsSync(mapped.archivePath)) throw new Error(`不可信 locator 的 purge 必须失败且保持可重试: ${id}`)
}

const recycleFailureRoot = path.join(tmp, 'recycle-failure')
const recycleFailureState = path.join(recycleFailureRoot, 'state.json')
const recycleFailureConfig = path.join(recycleFailureRoot, 'config.json')
const recycleFailureLogs = path.join(recycleFailureRoot, 'dsh-sessions')
const recycleFailure = await makeIsolatedContext(recycleFailureRoot, recycleFailureState, recycleFailureConfig, (meta) => ({ path: path.join(recycleFailureLogs, fakeSessionProjectKey(meta.cwd), String(meta.id), 'session.jsonl.zstd') }), {
  sessionPersistence: { root: recycleFailureLogs, compression: 'zstd' },
  purge: { deleteDshSession: false },
  recycle: async () => ({ ok: false, error: 'injected-recycle-failure' }),
})
const recycleFailureDaily = path.join(recycleFailureRoot, 'daily_conversation')
fs.mkdirSync(recycleFailureDaily, { recursive: true })
recycleFailure.context.emit('session/created', { header: { id: 'recycle-failure-session', cwd: recycleFailureDaily, createdAt: t0 } })
const recycleFailureLog = path.join(recycleFailureLogs, fakeSessionProjectKey(recycleFailureDaily), 'recycle-failure-session', 'session.jsonl.zstd')
fs.mkdirSync(path.dirname(recycleFailureLog), { recursive: true })
fs.writeFileSync(recycleFailureLog, 'native log')
await recycleFailure.workspaceRegistry.archiveSession('recycle-failure-session')
const recycleFailureResult = await recycleFailure.service.purgeSession('recycle-failure-session')
if (recycleFailureResult.ok || !recycleFailure.workspaceRegistry.archivedSessionIds.includes('recycle-failure-session')) throw new Error('回收失败必须保留 DSH 原生归档状态')
console.log('✓ 回收失败保留原生归档状态')

// Once plugin cache recycle has succeeded, an independently failing DSH-log
// recycle must keep native archive truth and persist a recoverable block.
const dshPartialRoot = path.join(tmp, 'dsh-log-partial')
const dshPartialState = path.join(dshPartialRoot, 'state.json')
const dshPartialConfig = path.join(dshPartialRoot, 'config.json')
const dshPartialLogs = path.join(dshPartialRoot, 'dsh-sessions')
const dshPartial = await makeIsolatedContext(
  dshPartialRoot,
  dshPartialState,
  dshPartialConfig,
  (meta) => ({ path: path.join(dshPartialLogs, fakeSessionProjectKey(meta.cwd), String(meta.id), 'session.jsonl.zstd') }),
  {
    sessionPersistence: { root: dshPartialLogs, compression: 'zstd' },
    recycle: async (target) => { fs.rmSync(target, { recursive: true, force: true }); return { ok: true } },
    dshRecycle: async () => ({ ok: false, reason: 'injected-dsh-log-recycle-failed' }),
  },
)
const dshPartialDaily = path.join(dshPartialRoot, 'daily_conversation')
fs.mkdirSync(dshPartialDaily, { recursive: true })
dshPartial.context.emit('session/created', { header: { id: 'dsh-log-partial-session', cwd: dshPartialDaily, createdAt: t0 } })
const dshPartialLog = path.join(dshPartialLogs, fakeSessionProjectKey(dshPartialDaily), 'dsh-log-partial-session', 'session.jsonl.zstd')
fs.mkdirSync(path.dirname(dshPartialLog), { recursive: true })
fs.writeFileSync(dshPartialLog, 'native log')
await dshPartial.workspaceRegistry.archiveSession('dsh-log-partial-session')
const dshPartialResult = await dshPartial.service.purgeSession('dsh-log-partial-session')
const dshPartialStatus = JSON.parse(fs.readFileSync(path.join(dshPartialRoot, 'status.json'), 'utf8')).purgePending
if (dshPartialResult.ok || dshPartialResult.partialPhase !== 'cache-recycled-dsh-pending' || !dshPartial.workspaceRegistry.archivedSessionIds.includes('dsh-log-partial-session') || dshPartialStatus?.phase !== 'cache-recycled-dsh-pending') throw new Error('DSH 日志回收失败必须持久化部分阶段并保留原生归档: ' + JSON.stringify({ dshPartialResult, archived: dshPartial.workspaceRegistry.archivedSessionIds, dshPartialStatus }))
const blockedRestore = await dshPartial.service.restoreSession('dsh-log-partial-session')
if (blockedRestore.ok || blockedRestore.reason !== 'purge-partial-recovery-pending') throw new Error('部分删除阶段不得误导性恢复会话')
console.log('✓ DSH 日志回收失败（部分阶段可恢复且阻止恢复）')

const brokenRoot = path.join(tmp, 'broken-boot')
const brokenState = path.join(brokenRoot, 'state.json')
const brokenConfig = path.join(brokenRoot, 'config.json')
fs.mkdirSync(brokenRoot, { recursive: true })
fs.writeFileSync(brokenState, '{')
fs.writeFileSync(brokenConfig, JSON.stringify({ backup: { enabled: false } }))
const broken = await makeIsolatedContext(brokenRoot, brokenState, brokenConfig, () => null)
broken.service.status()
if (fs.readFileSync(brokenState, 'utf8') !== '{' || fs.readFileSync(brokenConfig, 'utf8') !== JSON.stringify({ backup: { enabled: false } }) || fs.existsSync(path.join(brokenRoot, 'status.json'))) throw new Error('损坏 mapping 启动后不得产生任何持久化写入')
await broken.workspaceRegistry.archiveSession('native-readonly')
const readOnlyRestore = await broken.service.restoreSession('native-readonly')
if (!readOnlyRestore.ok || !readOnlyRestore.nativeRestored || broken.workspaceRegistry.archivedSessionIds.includes('native-readonly')) throw new Error('映射只读时仍必须先恢复 DSH 原生归档')
console.log('✓ 防篡改映射 / locator / 损坏状态启动（拒绝删除且零写入）')

// A broken status store is a sibling-store failure too: startup must not
// migrate or write mapping/config/status, and all mutating actions stay closed.
const brokenStatusRoot = path.join(tmp, 'broken-status')
const brokenStatusState = path.join(brokenStatusRoot, 'state.json')
const brokenStatusConfig = path.join(brokenStatusRoot, 'config.json')
const brokenStatusFile = path.join(brokenStatusRoot, 'status.json')
fs.mkdirSync(brokenStatusRoot, { recursive: true })
fs.writeFileSync(brokenStatusState, JSON.stringify({ schemaVersion: 1 }))
fs.writeFileSync(brokenStatusConfig, JSON.stringify({ schemaVersion: 1 }))
fs.writeFileSync(brokenStatusFile, JSON.stringify({ schemaVersion: 2, stale: true }))
const brokenStatus = await makeIsolatedContext(brokenStatusRoot, brokenStatusState, brokenStatusConfig, () => null)
if ((await brokenStatus.service.newProject('must-not-write')).ok) throw new Error('损坏 status 时不得执行写操作')
if (fs.readFileSync(brokenStatusFile, 'utf8') !== JSON.stringify({ schemaVersion: 2, stale: true }) || fs.existsSync(path.join(brokenStatusRoot, '对话归档'))) throw new Error('损坏 status 启动不得迁移或产生写入')
console.log('✓ 损坏 status 启动（零写入且全局只读）')

// The daily managed root is also validated before layout creation.
const dailyJunctionRoot = path.join(tmp, 'daily-junction-boundary')
const dailyJunctionOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-daily-junction-outside-'))
fs.mkdirSync(dailyJunctionOutside, { recursive: true })
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `New-Item -ItemType Junction -Path '${dailyJunctionRoot}' -Target '${dailyJunctionOutside}' | Out-Null`], { stdio: 'ignore' })
const dailyJunctionState = path.join(tmp, 'daily-junction-state.json')
const dailyJunctionConfig = path.join(tmp, 'daily-junction-config.json')
const dailyJunction = await makeIsolatedContext(tmp, dailyJunctionState, dailyJunctionConfig, () => null, { dailyDirName: 'daily-junction-boundary' })
dailyJunction.context.emit('session/created', { header: { id: 'junction-daily-session', cwd: dailyJunctionRoot, createdAt: t0 } })
const dailyJunctionMap = fs.existsSync(dailyJunctionState) ? JSON.parse(fs.readFileSync(dailyJunctionState, 'utf8')) : {}
if (dailyJunctionMap['junction-daily-session'] || fs.existsSync(path.join(dailyJunctionOutside, '2026-08-31'))) throw new Error('daily junction 越界时不得创建缓存')
fs.rmSync(dailyJunctionOutside, { recursive: true, force: true })
console.log('✓ session/created（日常 junction 越界拒绝）')

// Cleanup must reject an archive root outside DSH and must not recurse through
// an archive junction into another directory.
const cleanupBoundaryRoot = path.join(tmp, 'cleanup-boundary')
const cleanupBoundaryState = path.join(cleanupBoundaryRoot, 'state.json')
const cleanupBoundaryConfig = path.join(cleanupBoundaryRoot, 'config.json')
const cleanupBoundary = await makeIsolatedContext(cleanupBoundaryRoot, cleanupBoundaryState, cleanupBoundaryConfig, () => null, { archiveDirName: '..\\cleanup-outside' })
const cleanupOutside = path.join(tmp, 'cleanup-outside')
fs.mkdirSync(cleanupOutside, { recursive: true })
await cleanupBoundary.route.handler({ url: '/conversation-archive-api?action=cleanup', method: 'GET', headers: {} }, poisonRes)
if (poisonResponse.status !== 404 || !fs.existsSync(cleanupOutside)) throw new Error('遗留 cleanup 路由不得删除越界 archiveDirName')
const cleanupJunctionRoot = path.join(tmp, 'cleanup-junction')
const cleanupJunctionOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-cleanup-junction-outside-'))
fs.mkdirSync(path.join(cleanupJunctionOutside, 'keep'), { recursive: true })
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `New-Item -ItemType Junction -Path '${cleanupJunctionRoot}' -Target '${cleanupJunctionOutside}' | Out-Null`], { stdio: 'ignore' })
const cleanupJunctionState = path.join(tmp, 'cleanup-junction-state.json')
const cleanupJunctionConfig = path.join(tmp, 'cleanup-junction-config.json')
const cleanupJunction = await makeIsolatedContext(tmp, cleanupJunctionState, cleanupJunctionConfig, () => null, { archiveDirName: 'cleanup-junction' })
await cleanupJunction.route.handler({ url: '/conversation-archive-api?action=cleanup', method: 'GET', headers: {} }, poisonRes)
if (poisonResponse.status !== 404 || !fs.existsSync(cleanupJunctionOutside)) throw new Error('遗留 cleanup 路由不得递归 archive junction')
fs.rmSync(cleanupJunctionOutside, { recursive: true, force: true })
console.log('✓ API cleanup（越界 archive 根与 junction 拒绝）')

// Purge records an atomic intent before recycling. If mapping persistence then
// fails, the next startup removes only the already-recycled mapping safely.
const purgeFailureRoot = path.join(tmp, 'purge-failure')
const purgeFailureState = path.join(purgeFailureRoot, 'state.json')
const purgeFailureConfig = path.join(purgeFailureRoot, 'config.json')
const purgeFailureLogs = path.join(purgeFailureRoot, 'dsh-sessions')
let failPurgeStateCommit = false
const purgeFailureFs = Object.create(fs)
purgeFailureFs.renameSync = (source, destination) => {
  if (failPurgeStateCommit && path.resolve(destination) === path.resolve(purgeFailureState)) throw new Error('injected-state-commit-failure')
  return fs.renameSync(source, destination)
}
const purgeFailureLocate = (meta) => ({ path: path.join(purgeFailureLogs, fakeSessionProjectKey(meta.cwd), String(meta.id), 'session.jsonl.zstd') })
const purgeFailureDaily = path.join(purgeFailureRoot, 'daily_conversation')
const purgeFailureSnapshots = async () => [{ header: { id: 'purge-failure-session', cwd: purgeFailureDaily, createdAt: t0 } }]
const purgeFailure = await makeIsolatedContext(purgeFailureRoot, purgeFailureState, purgeFailureConfig, purgeFailureLocate, { fsApi: purgeFailureFs, sessionPersistence: { root: purgeFailureLogs, compression: 'zstd', listSnapshots: purgeFailureSnapshots } })
fs.mkdirSync(purgeFailureDaily, { recursive: true })
purgeFailure.context.emit('session/created', { header: { id: 'purge-failure-session', cwd: purgeFailureDaily, createdAt: t0 } })
const purgeFailureLog = path.join(purgeFailureLogs, fakeSessionProjectKey(purgeFailureDaily), 'purge-failure-session', 'session.jsonl.zstd')
fs.mkdirSync(path.dirname(purgeFailureLog), { recursive: true })
fs.writeFileSync(purgeFailureLog, 'native log')
await purgeFailure.workspaceRegistry.archiveSession('purge-failure-session')
const purgeFailureStatus = path.join(path.dirname(purgeFailureState), 'status.json')
await new Promise((resolve) => setTimeout(resolve, 1300)) // let mapping flush and public archive reconciliation finish before the final purge commit failure
if (JSON.parse(fs.readFileSync(purgeFailureState, 'utf8'))['purge-failure-session']?.status !== 'archived') throw new Error('purge failure fixture was not reconciled before fault injection')
failPurgeStateCommit = true
const purgeFailureResult = await purgeFailure.service.purgeSession('purge-failure-session')
if (purgeFailureResult.ok || !JSON.parse(fs.readFileSync(purgeFailureStatus, 'utf8')).purgePending) throw new Error('持久化失败时 purge 必须保留可恢复意图: ' + JSON.stringify(purgeFailureResult) + ' status=' + fs.readFileSync(purgeFailureStatus, 'utf8'))
failPurgeStateCommit = false
const purgeRecovered = await makeIsolatedContext(purgeFailureRoot, purgeFailureState, purgeFailureConfig, purgeFailureLocate, { fsApi: purgeFailureFs, sessionPersistence: { root: purgeFailureLogs, compression: 'zstd', listSnapshots: purgeFailureSnapshots }, archivedIds: ['purge-failure-session'] })
if (purgeRecovered.service.status().archived.some((entry) => entry.id === 'purge-failure-session') || JSON.parse(fs.readFileSync(purgeFailureState, 'utf8'))['purge-failure-session']) throw new Error('启动恢复必须收敛已回收会话映射')
console.log('✓ purge 意图与持久化失败恢复')

const malformedStatusRoot = path.join(tmp, 'malformed-status-entry')
const malformedStatusState = path.join(malformedStatusRoot, 'state.json')
const malformedStatusConfig = path.join(malformedStatusRoot, 'config.json')
fs.mkdirSync(malformedStatusRoot, { recursive: true })
fs.mkdirSync(path.join(malformedStatusRoot, 'outside'), { recursive: true })
fs.writeFileSync(malformedStatusState, JSON.stringify({ schemaVersion: 1, bad: { id: 'bad', kind: 'daily', date: 'not-a-date', tag: 'bad', status: 'active', cacheDir: path.join(malformedStatusRoot, 'outside'), recordFile: path.join(malformedStatusRoot, 'outside', 'record') } }))
fs.writeFileSync(malformedStatusConfig, JSON.stringify({ schemaVersion: 1 }))
const malformedStatus = await makeIsolatedContext(malformedStatusRoot, malformedStatusState, malformedStatusConfig, () => null)
const malformedView = malformedStatus.service.status()
if (malformedView.active.some((entry) => entry.id === 'bad') || !malformedView.invalidEntries.some((entry) => entry.id === 'bad')) throw new Error('status 必须过滤并标记损坏映射')
console.log('✓ status 过滤损坏映射')

// A configured protection directory outside the DSH root must never be
// accepted by the release endpoint, even though the child name itself is safe.
const unsafeProtectRoot = path.join(tmp, 'unsafe-protected')
fs.mkdirSync(unsafeProtectRoot, { recursive: true })
fs.writeFileSync(path.join(unsafeProtectRoot, 'keep'), 'x')
const unsafeProtect = await makeIsolatedContext(path.join(tmp, 'protected-boundary'), path.join(tmp, 'protected-boundary', 'state.json'), path.join(tmp, 'protected-boundary', 'config.json'), () => null, { protectDirName: '..\\unsafe-protected' })
await unsafeProtect.route.handler({ url: '/conversation-archive-api?action=releaseProtected', method: 'GET', headers: {} }, poisonRes)
if (poisonResponse.status !== 404 || !fs.existsSync(path.join(unsafeProtectRoot, 'keep'))) throw new Error('遗留 releaseProtected 路由不得回收外部文件')
console.log('✓ 保护目录越界拒绝（遗留 releaseProtected 已移除）')

// Task 6 service surface accepts retained ids/provenance ids only. Its list
// response is safe for the later browser client: no machine paths are sent.
const retainedServiceRoot = path.join(tmp, 'retained-service')
const retainedServiceState = path.join(retainedServiceRoot, 'state.json')
const retainedServiceConfig = path.join(retainedServiceRoot, 'config.json')
const retainedServiceStateRoot = path.dirname(retainedServiceState)
const retainedContent = 'service-retained-result'
const retainedHash = crypto.createHash('sha256').update(retainedContent).digest('hex')
const retainedBytes = path.join(retainedServiceRoot, '重要文件保护', 'files', `${retainedHash}.md`)
const retainedOriginalParent = path.join(retainedServiceRoot, 'daily_conversation', '2026-08-31', 'deleted-cache', '文档')
fs.mkdirSync(path.dirname(retainedBytes), { recursive: true })
fs.mkdirSync(retainedOriginalParent, { recursive: true })
fs.writeFileSync(retainedBytes, retainedContent)
fs.writeFileSync(retainedServiceState, JSON.stringify({ schemaVersion: 1 }))
fs.writeFileSync(retainedServiceConfig, JSON.stringify({ schemaVersion: 1 }))
fs.writeFileSync(path.join(retainedServiceStateRoot, 'retained.json'), JSON.stringify({ schemaVersion: 1, files: {
  [retainedHash]: {
    sha256: retainedHash, path: retainedBytes, size: retainedContent.length, savedAt: 1,
    sources: [{ id: 'service-provenance', sessionId: 'service-session', projectRoot: '', originalPath: path.join(retainedOriginalParent, '成果.md'), originalRelativePath: path.join('文档', '成果.md'), reason: '最终成果', savedAt: 1 }],
  },
} }))
const retainedService = await makeIsolatedContext(retainedServiceRoot, retainedServiceState, retainedServiceConfig, () => null)
const retainedView = retainedService.service.retainedFiles()
if (retainedView.length !== 1 || retainedView[0].id !== retainedHash || JSON.stringify(retainedView).includes(retainedServiceRoot)) throw new Error('保留文件服务必须按 ID 返回安全元数据')
const retainedRestore = retainedService.service.restoreRetainedFile(retainedHash)
if (!retainedRestore.ok || !fs.existsSync(path.join(retainedOriginalParent, '成果.md'))) throw new Error('保留文件服务必须仅按可信 ID 恢复')
if (retainedService.service.restoreRetainedFile(retainedBytes).ok) throw new Error('保留文件服务不得接受路径作为恢复参数')
const beforePoll = JSON.parse(fs.readFileSync(path.join(retainedServiceRoot, 'status.json'), 'utf8')).lastRetentionReminderAt
retainedService.service.status()
if (JSON.parse(fs.readFileSync(path.join(retainedServiceRoot, 'status.json'), 'utf8')).lastRetentionReminderAt !== beforePoll) throw new Error('提醒轮询不得自动确认')
const reminderAck = retainedService.service.acknowledgeRetentionReminder()
if (!reminderAck.ok || !JSON.parse(fs.readFileSync(path.join(retainedServiceRoot, 'status.json'), 'utf8')).lastRetentionReminderAt) throw new Error(`提醒必须通过显式应用操作确认: ${JSON.stringify(reminderAck)}`)
console.log('✓ 保留文件服务（ID 操作、路径脱敏、显式提醒确认）')

// 清理测试产物
fs.rmSync(path.join(tmp, '对话归档'), { recursive: true, force: true })

console.log('\n✅ Loader 集成测试全部通过')
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(0)
