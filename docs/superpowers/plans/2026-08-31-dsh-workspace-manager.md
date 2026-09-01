# DSH Workspace Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the v0.3.1 prototype into a complete Windows-only DeepSeek Harness workspace-management plugin backed by DSH native archive state, safe per-session cache deletion, automatic AI-assisted file retention, local backup, native settings UI, and a distributable update flow.

**Architecture:** Keep the existing Cordis host/client package shape. Add one focused DSH compatibility adapter, keep deterministic filesystem logic in `core.js`, and let `index.js` orchestrate services and HTTP operations; the browser client remains dependency-free and mounts through `settings.section`.

**Tech Stack:** Node.js 20+ ESM, DeepSeek Harness 0.1.1-rc.2 Cordis services, React supplied by DSH, PowerShell/Windows Shell for Recycle Bin and installer behavior, Node built-ins only.

**Spec:** `docs/superpowers/specs/2026-08-31-dsh-workspace-manager-design.md`

## Global Constraints

- This is a DeepSeek Harness plugin, not a Codex plugin; never add `.codex-plugin` metadata.
- First public release supports Windows only.
- DSH native `archivedSessionIds` is the sole archive-status authority.
- Never delete an existing project source directory; only registered per-session cache paths may be recycled.
- Retained files are copied and hash-verified before original data is recycled.
- If AI review fails, deletion stops safely.
- Use DSH/React/Node/PowerShell capabilities already present; add no database, UI framework, cloud SDK, or runtime dependency.
- All filesystem state carries `schemaVersion`; migration failure disables writes without destroying old state.
- Host and client package versions must remain identical.

---

### Task 1: Portable Test and Package Baseline

**Files:**
- Modify: `host/package.json`
- Modify: `client/package.json`
- Modify: `host/test/integration-loader.mjs`
- Create: `host/test/helpers/dsh-paths.mjs`

**Interfaces:**
- Produces: `resolveDshPackage(name: string): string` and package scripts `test`, `test:unit`, `test:integration`, `check`.
- Consumes: Node `createRequire`, `pathToFileURL`, and the installed `@deepseek-ai/dsh` package location.

- [ ] **Step 1: Add a failing portability test to the integration loader**

```js
import { resolveDshPackage } from './helpers/dsh-paths.mjs'

const cordisUrl = resolveDshPackage('@deepseek-ai/cordis')
if (!cordisUrl.startsWith('file:')) throw new Error('Cordis must resolve to a file URL')
if (cordisUrl.includes('Users')) throw new Error('test contains a user-specific path')
```

- [ ] **Step 2: Run the integration test and verify the helper is missing**

Run: `node host/test/integration-loader.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `helpers/dsh-paths.mjs`.

- [ ] **Step 3: Implement package resolution without fixed paths**

```js
// host/test/helpers/dsh-paths.mjs
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

export function resolveDshPackage(name) {
  return pathToFileURL(require.resolve(`${name}/package.json`)).href.replace(/package\.json$/, 'lib/index.js')
}
```

Update `integration-loader.mjs` to import Cordis and Loader with dynamic `await import(resolveDshPackage(...))`, and derive the plugin URL with `new URL('../lib/index.js', import.meta.url)`.

- [ ] **Step 4: Add executable package scripts and align versions**

```json
"scripts": {
  "test:unit": "node test/run-tests.mjs",
  "test:integration": "node test/integration-loader.mjs",
  "test": "npm run test:unit && npm run test:integration",
  "check": "node --check lib/index.js && node --check lib/core.js"
}
```

Set both packages to `1.0.0-alpha.1` and update descriptions to “工作区管理”.

- [ ] **Step 5: Verify and commit**

Run: `npm test && npm run check` from `host`, then `node --check client/lib/client.js`.

Expected: all existing tests pass and no path refers to a specific user or old plugin location.

```bash
git add host/package.json client/package.json host/test/integration-loader.mjs host/test/helpers/dsh-paths.mjs
git commit -m "test: make DSH integration checks portable"
```

### Task 2: Versioned State, Atomic Writes, and Path Boundaries

**Files:**
- Modify: `host/lib/core.js`
- Modify: `host/test/run-tests.mjs`

**Interfaces:**
- Produces: `atomicWriteJson(file, value, fsApi)`, `loadVersionedJson(file, defaults, migrate, fsApi)`, `isPathInside(root, target)`, `assertManagedPath(target, roots)`.
- Consumes: Node `path`, filesystem rename semantics, and `schemaVersion: 1` records.

- [ ] **Step 1: Write failing tests for traversal, sibling-prefix paths, and migration**

```js
test('managed path rejects escape and sibling prefix', () => {
  assert.equal(isPathInside('C:\\work', 'C:\\work\\a'), true)
  assert.equal(isPathInside('C:\\work', 'C:\\work-other\\a'), false)
  assert.equal(isPathInside('C:\\work', 'C:\\work\\..\\secret'), false)
})

test('versioned JSON migrates once and writes atomically', () => {
  fs.writeFileSync(file, JSON.stringify({ old: true }))
  const value = loadVersionedJson(file, { schemaVersion: 1 }, (v) => ({ schemaVersion: 1, migrated: v.old }), fs)
  assert.deepEqual(value, { schemaVersion: 1, migrated: true })
})
```

- [ ] **Step 2: Run the unit suite and verify missing exports fail**

Run: `node host/test/run-tests.mjs`

Expected: FAIL because `isPathInside` and `loadVersionedJson` are not exported.

- [ ] **Step 3: Implement the minimal boundary and atomic-state helpers**

```js
export function isPathInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)
}

export function assertManagedPath(target, roots) {
  const root = roots.find((candidate) => isPathInside(candidate, target))
  if (!root) throw new Error('path-outside-managed-roots')
  return path.resolve(target)
}

export function atomicWriteJson(file, value, fsApi) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fsApi.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  fsApi.renameSync(temp, file)
}
```

Implement `loadVersionedJson` so malformed or unsupported data throws a typed error instead of silently replacing it.

- [ ] **Step 4: Convert config/state writes to schema-versioned atomic writes**

Use `{ schemaVersion: 1, ...data }` for configuration, session mapping, retained-file index, and operation metadata. Preserve legacy v0.3.1 state through a single migration function.

- [ ] **Step 5: Verify and commit**

Run: `node host/test/run-tests.mjs`

Expected: all tests pass, including malformed JSON, unsupported versions, traversal, and sibling-prefix cases.

```bash
git add host/lib/core.js host/test/run-tests.mjs
git commit -m "feat: add safe versioned workspace state"
```

### Task 3: Native DSH Archive Adapter

**Files:**
- Create: `host/lib/dsh-adapter.js`
- Create: `host/test/dsh-adapter.mjs`
- Modify: `host/lib/index.js`
- Modify: `host/test/integration-loader.mjs`

**Interfaces:**
- Produces: `createDshAdapter(ctx, log)` returning `{ listArchivedIds(), restoreSession(id), locateSessionDir(id), compatibility() }`.
- Consumes: `ctx.workspaceRegistry`, `ctx.sessionPersistence`, DSH workspace domain change propagation.

- [ ] **Step 1: Write a failing adapter test using a fake native registry**

```js
const state = { initialized: true, workspaceIds: [], archivedSessionIds: ['s1', 's2'] }
const changes = []
const registry = {
  archivedSessionIds: state.archivedSessionIds,
  requireState: () => state,
  setState: async (next) => { Object.assign(state, next); registry.archivedSessionIds = next.archivedSessionIds; changes.push(next) },
}
const adapter = createDshAdapter(fakeContext({ workspaceRegistry: registry }), () => {})
assert.deepEqual(adapter.listArchivedIds(), ['s1', 's2'])
await adapter.restoreSession('s1')
assert.deepEqual(adapter.listArchivedIds(), ['s2'])
assert.equal(changes.length, 1)
```

- [ ] **Step 2: Run the adapter test and verify the module is absent**

Run: `node host/test/dsh-adapter.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `dsh-adapter.js`.

- [ ] **Step 3: Implement capability detection and restore verification**

```js
export function createDshAdapter(ctx, log = () => {}) {
  const registry = ctx.get('workspaceRegistry')
  const persistence = ctx.get('sessionPersistence')

  function listArchivedIds() {
    return [...(registry?.archivedSessionIds || [])].map(String)
  }

  async function restoreSession(id) {
    if (typeof registry?.unarchiveSession === 'function') await registry.unarchiveSession(id)
    else {
      const current = registry?.requireState?.()
      if (!current || typeof registry?.setState !== 'function') throw new Error('dsh-unarchive-unsupported')
      await registry.setState({ ...current, archivedSessionIds: current.archivedSessionIds.filter((value) => String(value) !== String(id)) })
    }
    if (listArchivedIds().includes(String(id))) throw new Error('dsh-unarchive-not-confirmed')
    return { ok: true, sessionId: String(id) }
  }
```

`compatibility()` reports whether public or compatibility restore is active and the detected DSH version. `locateSessionDir()` uses `sessionPersistence.locate` and returns the parent directory only for a known session.

- [ ] **Step 4: Replace plugin-owned archive status with the adapter**

Inject `workspaceRegistry` and `sessionPersistence`. Make status/list/restore routes read native archive IDs and enrich them with persisted session headers plus plugin file mappings. Remove cache-folder movement as an archive-state mechanism.

- [ ] **Step 5: Verify native echo and commit**

Run: `node host/test/dsh-adapter.mjs && node host/test/integration-loader.mjs`

Expected: archived IDs come from the native registry; restoring removes the ID and emits the fake domain state change; no test relies on plugin `entry.status` as archive authority.

```bash
git add host/lib/dsh-adapter.js host/test/dsh-adapter.mjs host/lib/index.js host/test/integration-loader.mjs
git commit -m "feat: manage DSH native archived sessions"
```

### Task 4: Global Per-Session Cache Layout and Mapping

**Files:**
- Modify: `host/lib/core.js`
- Modify: `host/lib/index.js`
- Modify: `host/test/run-tests.mjs`
- Modify: `host/test/integration-loader.mjs`

**Interfaces:**
- Produces: `sessionCacheLayout(entry, config)`, `ensureSessionCache(layout, fsApi)`, `pruneEmptyParents(cachePath, stopRoot, fsApi)`.
- Consumes: session `id`, `cwd`, `createdAt`, DSH-generated title, configured DSH workspace root.

- [ ] **Step 1: Add failing project and daily layout tests**

```js
assert.equal(
  sessionCacheLayout({ id: 'abcdef12', kind: 'project', projectRoot: 'C:\\p' }, cfg).root,
  path.join('C:\\p', '.cache', 'abcdef12')
)
assert.equal(
  sessionCacheLayout({ id: 'abcdef12', kind: 'daily', date: '2026-08-31', tag: '整理需求' }, cfg).root,
  path.join(cfg.harnessRoot, 'daily_conversation', '2026-08-31', '整理需求-abcdef12')
)
```

- [ ] **Step 2: Run tests and confirm the old shared project cache fails**

Run: `node host/test/run-tests.mjs`

Expected: FAIL because project sessions currently share category directories directly under `.cache`.

- [ ] **Step 3: Implement per-session roots with the existing category table**

Reuse `CATEGORY_DIRS`, `sanitizeName`, `dateStr`, and existing project classification. Do not create a second classification abstraction. Store the exact resolved cache root in the session map.

- [ ] **Step 4: Update event handlers and empty-date pruning**

On `session/created`, record the mapping and lazily create its root. On title events, rename only the daily conversation folder if no destination collision exists. On disposal, capture outputs into that session root. After deletion, call:

```js
pruneEmptyParents(cacheRoot, entry.kind === 'daily' ? dailyRoot : path.dirname(cacheRoot), fs)
```

- [ ] **Step 5: Verify and commit**

Run: `node host/test/run-tests.mjs && node host/test/integration-loader.mjs`

Expected: two sessions in one project have isolated caches; deleting the last daily session removes its empty date directory; project source files remain untouched.

```bash
git add host/lib/core.js host/lib/index.js host/test/run-tests.mjs host/test/integration-loader.mjs
git commit -m "feat: isolate cache storage per DSH session"
```

### Task 5: AI-Assisted Retention and Transactional Recycle

**Files:**
- Modify: `host/lib/core.js`
- Modify: `host/lib/index.js`
- Create: `host/test/retention.mjs`

**Interfaces:**
- Produces: `scanRetentionCandidates(root, fsApi, config)`, `buildRetentionPrompt(files)`, `parseRetentionDecision(text, allowedIds)`, `retainFiles(decisions, deps)`, `deleteArchivedSession(id)`.
- Consumes: DSH `llm` service, default model selection, the DSH adapter, registered cache mapping, Windows recycle implementation.

- [ ] **Step 1: Write failing tests for candidate filtering and model-output allowlisting**

```js
const candidates = scanRetentionCandidates(fixture, fs, cfg)
assert.deepEqual(candidates.map((item) => item.relativePath), ['outputs/report.docx', 'src/app.js'])

const decision = parseRetentionDecision('{"retain":[{"id":"known","reason":"final report"},{"id":"forged","reason":"x"}]}', new Set(['known']))
assert.deepEqual(decision.retain.map((item) => item.id), ['known'])
```

- [ ] **Step 2: Run the retention test and verify missing behavior**

Run: `node host/test/retention.mjs`

Expected: FAIL because retention helpers do not exist.

- [ ] **Step 3: Implement deterministic filtering and bounded content extraction**

Reuse the existing extension categories. Exclude `.git`, `node_modules`, build outputs, logs, archives generated by this plugin, and files outside the registered cache root. Assign an opaque candidate ID derived from SHA-256 of the normalized relative path. Limit total model input using configured per-file and total byte caps.

- [ ] **Step 4: Implement a strict structured AI decision**

The prompt requires one JSON object:

```json
{"retain":[{"id":"candidate-id","reason":"final user-authored deliverable that is not cheaply reproducible"}]}
```

Collect text blocks from `ctx.llm.stream`, parse only the first complete JSON object, reject malformed output, and ignore IDs not present in the candidate allowlist. A provider, model, quota, timeout, or parse failure returns `ai-review-failed` and performs no deletion.

- [ ] **Step 5: Implement copy-verify-log-recycle ordering**

For each selected file: copy to a temporary retained path, hash source and destination, atomically rename the verified copy, update `retained-files.json`, then append an operation phase. Only after all selected files verify may the flow recycle the native DSH session directory and registered cache root. Never pass a client-provided path into `recyclePath`.

- [ ] **Step 6: Test failure injection**

Inject copy failure, hash mismatch, model failure, missing mapping, and recycle failure. Expected in every pre-recycle failure: original session and cache still exist. Expected on recycle failure: the verified retained copy remains and the operation log identifies the incomplete phase.

- [ ] **Step 7: Verify and commit**

Run: `node host/test/retention.mjs && node host/test/run-tests.mjs && node host/test/integration-loader.mjs`

```bash
git add host/lib/core.js host/lib/index.js host/test/retention.mjs
git commit -m "feat: retain important outputs before safe deletion"
```

### Task 6: Retained-File Library and Reminder

**Files:**
- Modify: `host/lib/core.js`
- Modify: `host/lib/index.js`
- Modify: `host/test/run-tests.mjs`

**Interfaces:**
- Produces: `listRetainedFiles()`, `restoreRetainedFile(id, targetDir?)`, `recycleRetainedFile(id)`, `retentionReminderStatus(now)`.
- Consumes: retained-file index created in Task 5 and configured reminder days.

- [ ] **Step 1: Write failing tests for deduplication, restore collision, and reminder cadence**

```js
assert.equal(indexByHash(records).size, 1)
assert.deepEqual(await restoreRetainedFile('r1'), { ok: false, reason: 'target-exists' })
assert.equal(remindDue('2026-08-01T00:00:00Z', { remind: { intervalDays: 7 } }, new Date('2026-08-09')), true)
```

- [ ] **Step 2: Run tests and verify missing retained-library operations**

Run: `node host/test/run-tests.mjs`

Expected: FAIL on missing restore/recycle index behavior.

- [ ] **Step 3: Implement library operations without overwrites**

Restore to the original path only when its parent exists and target is absent; otherwise require a caller-selected directory. Recycling a retained file updates the index only after the Windows recycle operation succeeds.

- [ ] **Step 4: Persist application-only reminder state**

Store `lastRetentionReminderAt` and return a concise reminder count in status. Do not call Windows notification APIs.

- [ ] **Step 5: Verify and commit**

Run: `node host/test/run-tests.mjs && node host/test/integration-loader.mjs`

```bash
git add host/lib/core.js host/lib/index.js host/test/run-tests.mjs
git commit -m "feat: add global retained-file library"
```

### Task 7: Verified Backup Scheduler and Restore

**Files:**
- Modify: `host/lib/core.js`
- Modify: `host/lib/index.js`
- Create: `host/test/backup.mjs`

**Interfaces:**
- Produces: `createBackup(selection)`, `verifyBackup(zipPath, expectedManifest)`, `restoreBackup(zipPath, target)`, `scheduleNextBackup(now, config)`, `runOverdueBackup(now)`.
- Consumes: configured target directory, registered session/project cache roots, retained-file root, PowerShell `Compress-Archive` and `Expand-Archive`.

- [ ] **Step 1: Write failing tests for due-time persistence and retention count**

```js
assert.equal(scheduleNextBackup(new Date('2026-08-31T00:00:00Z'), { autoIntervalDays: 2 }), '2026-09-02T00:00:00.000Z')
assert.deepEqual(selectExpiredBackups(['1.zip','2.zip','3.zip','4.zip','5.zip','6.zip'], 5), ['1.zip'])
```

- [ ] **Step 2: Run the backup test and confirm timer-only behavior is insufficient**

Run: `node host/test/backup.mjs`

Expected: FAIL because persisted due-time and restore verification helpers do not exist.

- [ ] **Step 3: Create manifest-backed archives**

Before compression, write a temporary manifest containing relative path, size, and SHA-256 for every selected file. After compression, list/extract to a temporary verification directory and compare every manifest entry. Delete temporary verification data after success or failure.

- [ ] **Step 4: Add persisted scheduling and one-time catch-up**

Store `nextBackupAt`. On startup, if overdue, run exactly one backup and then calculate the next date from completion time. Use a short interval only to check whether the persisted due time has arrived; the interval is not the source of truth.

- [ ] **Step 5: Implement non-overwriting restore and version retention**

Restore into an empty user-selected directory. Refuse a non-empty target. Recycle archives beyond the configured count only after the newest archive verifies.

- [ ] **Step 6: Verify and commit**

Run: `node host/test/backup.mjs && node host/test/run-tests.mjs`

```bash
git add host/lib/core.js host/lib/index.js host/test/backup.mjs
git commit -m "feat: verify and schedule local backups"
```

### Task 8: Secure Host API and Diagnostics

**Files:**
- Modify: `host/lib/index.js`
- Modify: `host/test/integration-loader.mjs`

**Interfaces:**
- Produces POST operations: `restore`, `delete`, `restoreMany`, `deleteMany`, `retainedRestore`, `retainedDelete`, `backup`, `backupRestore`, `saveConfig`; GET operations: `status`, `archived`, `retained`, `backups`, `diagnostics`.
- Consumes: a boot-random CSRF token returned by an initial same-origin status bootstrap and required on every write.

- [ ] **Step 1: Add failing method/token/input tests**

```js
await call('GET', '/conversation-archive-api?action=delete&sessionId=s1')
assert.equal(response.status, 405)
await call('POST', '/conversation-archive-api?action=delete', { sessionId: 's1' }, {})
assert.equal(response.status, 403)
await call('POST', '/conversation-archive-api?action=delete', { path: 'C:\\Windows' }, auth)
assert.equal(response.status, 400)
```

- [ ] **Step 2: Run integration tests and confirm current GET/fixed-header API fails security expectations**

Run: `node host/test/integration-loader.mjs`

Expected: FAIL because current destructive actions accept GET and a constant header.

- [ ] **Step 3: Implement JSON body parsing with size and schema limits**

Accept at most 64 KiB, reject unknown actions, reject unknown fields on destructive requests, and validate session IDs against native archived IDs. Return `{ ok, result }` or `{ ok: false, error: { code, message } }` consistently.

- [ ] **Step 4: Remove arbitrary path deletion and redact diagnostics**

Delete `cacheDelete?name=<path>`. Diagnostics contain versions, feature flags, operation phases, and shortened/root-relative paths; exclude file contents, API keys, and full usernames.

- [ ] **Step 5: Verify and commit**

Run: `node host/test/integration-loader.mjs`

```bash
git add host/lib/index.js host/test/integration-loader.mjs
git commit -m "feat: secure workspace management API"
```

### Task 9: Native DSH Settings UI

**Files:**
- Modify: `client/lib/client.js`
- Modify: `client/package.json`
- Create: `client/test/client-contract.mjs`

**Interfaces:**
- Produces: `settings.section` entry labeled `工作区管理`; four sections for archived sessions, retained files, backup, and plugin settings.
- Consumes: the Task 8 API contract and DSH-provided React/slot services.

- [ ] **Step 1: Write a failing static contract test**

```js
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
for (const text of ['工作区管理', '已归档对话', '保留文件', '本地备份', '插件设置']) {
  assert.ok(source.includes(text), `missing UI label: ${text}`)
}
assert.ok(!source.includes('window.confirm('), 'must use an in-page DSH-style dialog')
assert.ok(!source.includes('X-Conversation-Archive": "dsh"'), 'must not use the fixed token')
```

- [ ] **Step 2: Run the contract test and verify current labels/security fail**

Run: `node client/test/client-contract.mjs`

Expected: FAIL on `工作区管理`, dialog behavior, and fixed authentication header.

- [ ] **Step 3: Replace the current custom dashboard with native settings composition**

Keep `slots.inject('settings.section', ...)` and register label `工作区管理`. Reuse DSH theme values through inherited colors and CSS custom properties; avoid hard-coded light backgrounds. Render four restrained sections:

```text
已归档对话 — search, select, restore, recycle
保留文件 — source, restore, recycle, reminder interval
本地备份 — target, run now, interval, keep count, restore
插件设置 — workspace root, AI limits, update toggle, compatibility, diagnostics
```

- [ ] **Step 4: Implement five-row internal scrolling and accessible states**

Use a fixed row-height list capped at five rows, keyboard-focusable controls, visible focus rings, `aria-label` on icon buttons, disabled busy actions, and inline success/error messages. Batch recycle opens an in-page modal showing conversation/cache/file counts; automatic AI retention itself requires no per-file confirmation.

- [ ] **Step 5: Bind POST operations and refresh native truth**

Bootstrap the runtime token from status, send JSON POST bodies, clear selections after batch completion, and refresh archived IDs after restore/delete. A returned `ok: false` must render as an error, never as success text.

- [ ] **Step 6: Verify and commit**

Run: `node client/test/client-contract.mjs && node --check client/lib/client.js`

Then start DSH and manually verify light, dark, and follow-system themes against the native Settings layout.

```bash
git add client/lib/client.js client/package.json client/test/client-contract.mjs
git commit -m "feat: add native DSH workspace settings UI"
```

### Task 10: Installer, Update Check, Documentation, and Final Acceptance

**Files:**
- Create: `scripts/install.ps1`
- Create: `scripts/uninstall.ps1`
- Create: `release-manifest.json`
- Modify: `host/README.md`
- Modify: `host/lib/index.js`
- Modify: `host/package.json`
- Modify: `client/package.json`
- Create: `.gitignore`

**Interfaces:**
- Produces: repeatable Windows install/update/uninstall commands, GitHub Releases update metadata, final v1 release candidate.
- Consumes: DSH CLI/global-package discovery, profile patch file, release URL configured at build time.

- [ ] **Step 1: Add installer dry-run assertions**

`install.ps1 -DryRun` must print resolved DSH home, source host/client, target locations, profile patch path, backup path, and health-check command without writing anything. It must fail if DSH is absent or unsupported.

- [ ] **Step 2: Implement idempotent install/update**

Use `Get-Command dsh`, resolve its package root, copy host/client to a versioned plugin directory, back up the current plugin and profile patch, update only the plugin-owned patch entries, then run syntax and loader health checks. On health-check failure restore the backup.

- [ ] **Step 3: Implement conservative uninstall**

Remove only plugin-owned profile entries and installed code. Preserve DSH storage, retained files, and backups unless `-RemoveUserData` is explicitly supplied.

- [ ] **Step 4: Add signed-data-ready update metadata**

```json
{
  "name": "dsh-conversation-archive",
  "version": "1.0.0",
  "dsh": { "min": "0.1.1-rc.2", "maxTested": "0.1.1-rc.2" },
  "platform": "win32",
  "sha256": {}
}
```

The plugin checks GitHub Releases only when enabled, compares semantic versions, displays compatibility, and links to the release; it never replaces running code.

- [ ] **Step 5: Rewrite user documentation**

Document purpose, Windows/DSH compatibility, install/update/uninstall, storage locations, automatic retention and token use, Recycle Bin guarantees and limits, backup/restore, diagnostics, and recovery from failed migration. Remove v0.3.0 claims and all user-specific paths.

- [ ] **Step 6: Run the complete automated verification**

Run:

```powershell
Set-Location host
npm test
npm run check
Set-Location ..\client
node test\client-contract.mjs
node --check lib\client.js
Set-Location ..
pwsh -File scripts\install.ps1 -DryRun
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 7: Run real DSH acceptance**

Verify all six acceptance scenarios in the spec: native settings entry, immediate native archive listing, native restore, retained-file-before-recycle ordering, empty daily-date pruning, and persistence across DSH restart. Test one forced AI failure and confirm no deletion occurs.

- [ ] **Step 8: Commit the release candidate**

```bash
git add .gitignore scripts release-manifest.json host client
git commit -m "release: prepare DSH workspace manager 1.0.0"
```
