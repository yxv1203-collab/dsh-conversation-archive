import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  createBackup, verifyBackup, restoreBackup, listBackups,
  scheduleNextBackup, selectExpiredBackups, runOverdueBackup, backupScheduleView, resetBackupSchedule,
  isBackupTargetPath,
} from '../lib/core.js'

if (process.platform === 'win32') {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR
  if (systemRoot) process.env.PSModulePath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-backup-'))
const harnessRoot = path.join(root, 'harness')
const stateRoot = path.join(root, 'state')
const targetDir = path.join(root, 'backups')
const backupStatePath = path.join(stateRoot, 'backups.json')
const retainedRoot = path.join(harnessRoot, '重要文件保护')
const retainedIndexPath = path.join(stateRoot, 'retained.json')
const sessionId = 'backup123456'
const cacheDir = path.join(harnessRoot, 'daily_conversation', '2026-08-31', '备份测试-0800-backup123456')
const recordFile = path.join(cacheDir, '会话记录', '对话记录.jsonl')
const config = { backup: { enabled: true, targetDir, autoIntervalDays: 2, keepCount: 5 } }

function entry() {
  return {
    id: sessionId, kind: 'daily', date: '2026-08-31', tag: '备份测试', createdAt: 0,
    layoutVersion: 2, cacheKey: 'backup123456', status: 'active', cacheDir, recordFile,
    manifestFile: path.join(cacheDir, '会话记录', '备份测试.清单.md'),
  }
}

function deps(extra = {}) {
  return {
    fsApi: fs, harnessRoot, stateRoot, retainedRoot, retainedIndexPath, backupStatePath,
    config, mapping: { [sessionId]: entry() }, ...extra,
  }
}

try {
  assert.equal(scheduleNextBackup(new Date('2026-08-31T00:00:00.000Z'), { autoIntervalDays: 1 }), '2026-09-01T00:00:00.000Z')
  assert.equal(scheduleNextBackup(new Date('2026-08-31T00:00:00.000Z'), { autoIntervalDays: 2 }), '2026-09-02T00:00:00.000Z')
  assert.equal(scheduleNextBackup(new Date('2026-08-31T00:00:00.000Z'), { autoIntervalDays: 3 }), '2026-09-03T00:00:00.000Z')
  assert.deepEqual(selectExpiredBackups(['1.zip', '2.zip', '3.zip', '4.zip', '5.zip', '6.zip'], 5), ['1.zip'])
  assert.equal(isBackupTargetPath('\\\\server\\share\\backups'), true, 'UNC/mounted target is a supported local target')
  assert.equal(isBackupTargetPath('https://example.com/backup'), false, 'cloud URLs are not backup targets')
  console.log('✓ schedule and local/UNC target validation')

  fs.mkdirSync(path.join(cacheDir, '会话记录'), { recursive: true })
  fs.mkdirSync(path.join(cacheDir, '文档'), { recursive: true })
  fs.writeFileSync(recordFile, '{"event":"backup"}\n')
  fs.writeFileSync(path.join(cacheDir, '文档', '成果.md'), 'backup result')
  const retained = 'retained result'
  const retainedHash = crypto.createHash('sha256').update(retained).digest('hex')
  const retainedFile = path.join(retainedRoot, 'files', `${retainedHash}.md`)
  fs.mkdirSync(path.dirname(retainedFile), { recursive: true })
  fs.mkdirSync(stateRoot, { recursive: true })
  fs.writeFileSync(retainedFile, retained)
  fs.writeFileSync(retainedIndexPath, JSON.stringify({ schemaVersion: 1, files: {
    [retainedHash]: { sha256: retainedHash, path: retainedFile, size: retained.length, savedAt: 1, sources: [] },
  } }))

  const rejected = await createBackup({ type: 'session', ids: ['outside-id'] }, deps())
  assert.equal(rejected.ok, false)
  assert.equal(rejected.reason, 'unknown-backup-selection')

  const first = await createBackup({ type: 'session', ids: [sessionId] }, deps({ now: () => new Date('2026-08-31T00:00:00.000Z') }))
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.ok(first.id && !JSON.stringify(first).includes(root), 'backup output uses a safe ID and redacts paths')
  assert.ok(fs.existsSync(backupStatePath) && !fs.existsSync(path.join(harnessRoot, 'backups.json')), 'backup state remains under plugin state root, not workspace data root')
  assert.equal(listBackups(deps()).length, 1)
  const verified = await verifyBackup(first.id, deps())
  assert.equal(verified.ok, true)
  assert.equal(verified.manifest.files.length, 2)
  console.log('✓ registered session selection, manifest verification, and redacted backup listing')

  const restoreTarget = path.join(root, 'restore-empty')
  fs.mkdirSync(restoreTarget, { recursive: true })
  const restored = await restoreBackup(first.id, restoreTarget, deps())
  assert.equal(restored.ok, true)
  assert.equal(fs.readFileSync(path.join(restoreTarget, 'sessions', sessionId, '文档', '成果.md'), 'utf8'), 'backup result')
  assert.equal((await restoreBackup(first.id, restoreTarget, deps())).reason, 'restore-target-not-empty')
  console.log('✓ restore verifies trusted ID into an empty non-overwriting target')

  const existingArchives = new Set(fs.readdirSync(targetDir))
  const recycled = []
  const second = await createBackup({ type: 'retained', ids: [retainedHash] }, deps({
    config: { backup: { ...config.backup, keepCount: 1 } },
    now: () => new Date('2026-08-31T01:00:00.000Z'),
    recycle: async (file) => { recycled.push(path.basename(file)); return { ok: true } },
  }))
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(listBackups(deps()).length, 1, 'only verified newest archive stays listed after retention')
  assert.equal(recycled.length, 1, 'old archive enters Recycle Bin only after newest succeeds')
  const secondArchive = path.join(targetDir, fs.readdirSync(targetDir).find((name) => !existingArchives.has(name) && name.endsWith('.zip')))
  console.log('✓ newest verification precedes configured Recycle Bin retention')

  const failed = await createBackup({ type: 'retained', ids: [retainedHash] }, deps({
    exec: (_command, _args, callback) => callback(new Error('injected-compress-failure'), '', ''),
  }))
  assert.equal(failed.ok, false)
  assert.equal(listBackups(deps()).length, 1, 'failed compression is never published')
  const noArchive = await createBackup({ type: 'retained', ids: [retainedHash] }, deps({
    exec: (_command, _args, callback) => callback(null, '', ''),
  }))
  assert.equal(noArchive.ok, false)
  assert.equal(listBackups(deps()).length, 1, 'failed post-compression verification is never published')

  fs.writeFileSync(path.join(cacheDir, '文档', 'tamper.md'), 'tamper')
  assert.equal((await verifyBackup(second.id, deps())).ok, true, 'archive verification is independent of changed sources')
  fs.writeFileSync(secondArchive, 'not-a-zip')
  assert.equal((await verifyBackup(second.id, deps())).reason, 'backup-verification-failed')
  console.log('✓ compression/extraction failure and archive tampering never report success')

  const projectId = 'project12345'
  const projectRoot = path.join(harnessRoot, '备份项目')
  const projectCache = path.join(projectRoot, '.cache', projectId)
  const projectEntry = {
    id: projectId, kind: 'project', root: projectRoot, tag: '项目备份', createdAt: 0,
    layoutVersion: 2, cacheKey: projectId, status: 'active', cacheDir: projectCache,
    recordFile: path.join(projectCache, '会话记录', '对话记录.jsonl'),
    manifestFile: path.join(projectCache, '会话记录', '项目备份.清单.md'),
  }
  fs.mkdirSync(path.join(projectCache, '会话记录'), { recursive: true })
  fs.mkdirSync(path.join(projectCache, '文档'), { recursive: true })
  fs.writeFileSync(projectEntry.recordFile, '{}')
  fs.writeFileSync(path.join(projectCache, '文档', '项目成果.md'), 'managed project output')
  fs.writeFileSync(path.join(projectRoot, '原项目源码.md'), 'ORIGINAL-SOURCE-MUST-NOT-BE-BACKED-UP')
  const projectBackup = await createBackup({ type: 'project', ids: [projectId] }, deps({ mapping: { [sessionId]: entry(), [projectId]: projectEntry }, now: () => new Date('2026-08-31T02:00:00.000Z') }))
  assert.equal(projectBackup.ok, true, JSON.stringify(projectBackup))
  const projectVerified = await verifyBackup(projectBackup.id, deps({ mapping: { [sessionId]: entry(), [projectId]: projectEntry } }))
  assert.equal(projectVerified.ok, true)
  assert.equal(projectVerified.manifest.files.some((item) => item.path.includes('原项目源码')), false, 'project backup includes plugin-managed cache only')
  console.log('✓ project scope never includes original project source files')

  if (process.platform === 'win32') {
    const outside = path.join(root, 'junction-outside')
    const junction = path.join(cacheDir, '文档', 'outside')
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'secret.md'), 'must not follow')
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `New-Item -ItemType Junction -Path '${junction}' -Target '${outside}' | Out-Null`], { stdio: 'ignore' })
    const junctionBackup = await createBackup({ type: 'session', ids: [sessionId] }, deps())
    assert.equal(junctionBackup.ok, false)
    assert.ok(['backup-reparse-source', 'path-reparse-escape'].includes(junctionBackup.reason), 'junction source must fail closed')
    fs.rmdirSync(junction)
    const restoreOutside = path.join(root, 'restore-junction-outside')
    const restoreJunction = path.join(root, 'restore-junction')
    fs.mkdirSync(restoreOutside, { recursive: true })
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `New-Item -ItemType Junction -Path '${restoreJunction}' -Target '${restoreOutside}' | Out-Null`], { stdio: 'ignore' })
    assert.equal((await restoreBackup(projectBackup.id, restoreJunction, deps({ mapping: { [sessionId]: entry(), [projectId]: projectEntry } }))).reason, 'restore-target-unsafe')
    fs.rmdirSync(restoreJunction)
  }

  // Retention must verify an old catalogue entry again before recycling it.
  const tamperedTarget = path.join(root, 'tampered-retention')
  const tamperedState = path.join(stateRoot, 'tampered-backups.json')
  const tamperedConfig = { backup: { ...config.backup, targetDir: tamperedTarget, keepCount: 1 } }
  const tamperedDeps = (extra = {}) => deps({ config: tamperedConfig, backupStatePath: tamperedState, ...extra })
  const tamperedOld = await createBackup({ type: 'retained', ids: [retainedHash] }, tamperedDeps({ now: () => new Date('2026-08-31T03:00:00.000Z') }))
  assert.equal(tamperedOld.ok, true)
  fs.writeFileSync(path.join(tamperedTarget, fs.readdirSync(tamperedTarget).find((name) => name.endsWith('.zip'))), 'tampered old archive')
  let tamperedRecycleCalls = 0
  const tamperedNew = await createBackup({ type: 'retained', ids: [retainedHash] }, tamperedDeps({
    now: () => new Date('2026-08-31T04:00:00.000Z'),
    recycle: async () => { tamperedRecycleCalls += 1; return { ok: true } },
  }))
  assert.equal(tamperedNew.ok, true)
  assert.deepEqual(tamperedNew.retentionErrors, [tamperedOld.id])
  assert.equal(tamperedRecycleCalls, 0, 'tampered old archives must never reach the Recycle Bin')
  assert.equal(listBackups(tamperedDeps()).length, 2, 'a tampered old catalogue record remains retryable')

  // Once the new archive is published, a later retention-state failure must
  // not turn that successful archive into a dangling catalogue record.
  const failureTarget = path.join(root, 'retention-state-failure')
  const failureState = path.join(stateRoot, 'retention-state-failure.json')
  const failureConfig = { backup: { ...config.backup, targetDir: failureTarget, keepCount: 1 } }
  const failureDeps = (extra = {}) => deps({ config: failureConfig, backupStatePath: failureState, ...extra })
  const failureOld = await createBackup({ type: 'retained', ids: [retainedHash] }, failureDeps({ now: () => new Date('2026-08-31T05:00:00.000Z') }))
  assert.equal(failureOld.ok, true)
  let backupStateWrites = 0
  let failureRecycleCalls = 0
  const failureFs = Object.create(fs)
  failureFs.renameSync = (from, to) => {
    if (path.resolve(to) === path.resolve(failureState) && ++backupStateWrites === 2) throw new Error('injected-retention-state-save-failure')
    return fs.renameSync(from, to)
  }
  const failureNew = await createBackup({ type: 'retained', ids: [retainedHash] }, failureDeps({
    fsApi: failureFs, now: () => new Date('2026-08-31T06:00:00.000Z'),
    recycle: async () => { failureRecycleCalls += 1; return { ok: true } },
  }))
  assert.equal(failureNew.ok, true, JSON.stringify(failureNew))
  assert.deepEqual(failureNew.retentionErrors, [failureOld.id])
  assert.equal(failureRecycleCalls, 0, 'state failure before recycle must leave the old archive untouched')
  assert.ok(listBackups(failureDeps()).some((item) => item.id === failureNew.id), 'published newest archive remains catalogued')
  assert.equal(fs.readdirSync(failureTarget).filter((name) => name.endsWith('.zip')).length, 2, 'published newest archive is never deleted during best-effort retention')
  console.log('✓ retention re-verifies old archives and never rolls back a published newest backup')

  // Persisted due time triggers one catch-up only. The actual backup is injected,
  // proving scheduler state rather than timer-memory controls execution.
  fs.writeFileSync(backupStatePath, JSON.stringify({ schemaVersion: 1, backups: [], nextBackupAt: '2026-08-29T00:00:00.000Z' }))
  let runs = 0
  const overdue = await runOverdueBackup(new Date('2026-08-31T00:00:00.000Z'), deps({ create: async () => ({ ok: true, id: `run-${++runs}`, completedAt: '2026-08-31T00:00:00.000Z' }) }))
  assert.equal(overdue.ran, true)
  assert.equal(runs, 1)
  const resumed = await runOverdueBackup(new Date('2026-08-31T00:01:00.000Z'), deps({ create: async () => ({ ok: true, id: `run-${++runs}`, completedAt: '2026-08-31T00:01:00.000Z' }) }))
  assert.equal(resumed.ran, false)
  assert.equal(runs, 1)
  console.log('✓ persisted schedule runs at most one overdue catch-up and then advances')

  const shutdownConfig = { backup: { ...config.backup, mode: 'shutdown' } }
  assert.equal((await runOverdueBackup(new Date('2026-09-01T00:00:00.000Z'), deps({ config: shutdownConfig }))).reason, 'backup-schedule-disabled')
  const resetConfig = { backup: { ...config.backup, mode: 'periodic', autoIntervalDays: 3 } }
  const reset = resetBackupSchedule(new Date('2026-09-01T00:00:00.000Z'), deps({ config: resetConfig }))
  assert.equal(reset.ok, true)
  assert.equal(backupScheduleView(deps({ config: resetConfig })).nextBackupAt, '2026-09-04T00:00:00.000Z')
  const overlap = await createBackup({ type: 'session', ids: [sessionId] }, deps({ config: { backup: { ...config.backup, targetDir: path.join(cacheDir, 'nested-backups') } } }))
  assert.equal(overlap.reason, 'backup-target-overlaps-source')
  console.log('✓ backup modes, schedule rebasing, and source-overlap rejection')

  // A zip-slip archive must be rejected before extraction. Build it with the
  // Windows ZIP runtime used by production instead of trusting a fixture.
  if (process.platform === 'win32') {
    const slipName = 'conversation-archive-backup-zipslip.zip'
    const slip = path.join(targetDir, slipName)
    const ps = [
      'Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `$z=[IO.Compression.ZipFile]::Open('${slip.replace(/'/g, "''")}',[System.IO.Compression.ZipArchiveMode]::Create)`,
      "$e=$z.CreateEntry('../outside.txt')",
      '$w=[IO.StreamWriter]::new($e.Open()); $w.Write(\'x\'); $w.Dispose(); $z.Dispose()',
    ].join('; ')
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' })
    fs.writeFileSync(backupStatePath, JSON.stringify({ schemaVersion: 1, backups: [{ id: 'backup-zipslip1', fileName: slipName, createdAt: '2026-08-31T00:00:00.000Z', fileCount: 0, byteSize: 0 }], nextBackupAt: '' }))
    assert.equal((await verifyBackup('backup-zipslip1', deps())).reason, 'backup-zip-slip')
  }

  assert.deepEqual(selectExpiredBackups(['1.zip', '2.zip', '3.zip', '4.zip', '5.zip', '6.zip'], 5), ['1.zip'])
  console.log('✓ zip-slip rejection and keep-five selection')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
