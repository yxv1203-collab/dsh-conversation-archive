import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listRetainedFiles, restoreRetainedFile, removeRetainedProvenance, recycleRetainedFile, recoverRetainedRecycle, retentionReminder, markRetentionReminderSeen } from '../lib/core.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-retained-library-'))
const harnessRoot = path.join(root, 'harness')
const stateRoot = path.join(root, 'state')
const retainedRoot = path.join(harnessRoot, '重要文件保护')
const filesRoot = path.join(retainedRoot, 'files')
const indexPath = path.join(stateRoot, 'retained.json')
const deleteOperationPath = path.join(stateRoot, 'retained-delete.json')
const statusPath = path.join(stateRoot, 'status.json')
const originalParent = path.join(harnessRoot, 'daily_conversation', '2026-08-31', 'session-cache', '文档')
const alternateParent = path.join(root, 'restore-target')
const content = 'important final output'
const sha256 = crypto.createHash('sha256').update(content).digest('hex')
const sourceFile = path.join(filesRoot, `${sha256}.md`)
const deps = { retainedRoot, indexPath, deleteOperationPath, harnessRoot, stateRoot, fsApi: fs }

const writeIndex = (sources) => {
  fs.mkdirSync(filesRoot, { recursive: true })
  fs.mkdirSync(stateRoot, { recursive: true })
  fs.writeFileSync(sourceFile, content)
  fs.writeFileSync(indexPath, JSON.stringify({ schemaVersion: 1, files: {
    [sha256]: { sha256, path: sourceFile, size: Buffer.byteLength(content), savedAt: 100, sources },
  } }))
}

try {
  const sources = [
    { id: 'provenance-a', sessionId: 'conversation-a', projectRoot: path.join(harnessRoot, '项目A'), originalPath: path.join(originalParent, '成果.md'), originalRelativePath: path.join('文档', '成果.md'), reason: '最终交付', savedAt: 100 },
    { id: 'provenance-b', sessionId: 'conversation-b', projectRoot: '', originalPath: path.join(harnessRoot, 'other', '成果.md'), originalRelativePath: path.join('文档', '成果.md'), reason: '第二个来源', savedAt: 101 },
  ]
  writeIndex(sources)

  const listed = listRetainedFiles(deps)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, sha256)
  assert.equal(listed[0].sources.length, 2)
  const provenanceA = listed[0].sources[0].id
  const provenanceB = listed[0].sources[1].id
  assert.match(provenanceA, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(listed).includes(root), false, '客户端视图不得泄露绝对路径')
  assert.equal(listed[0].sources[0].conversationLabel, 'conversation-a')
  fs.writeFileSync(indexPath, JSON.stringify({ schemaVersion: 1, files: {
    [sha256]: { sha256, path: sourceFile, size: Buffer.byteLength(content), savedAt: 100, sources: [{ ...sources[0], originalRelativePath: '..\\unsafe' }] },
  } }))
  assert.equal(listRetainedFiles(deps)[0].sources[0].originalLocation, '', '不安全相对路径不得暴露给客户端')
  writeIndex(sources)
  console.log('✓ 保留列表以稳定 ID 展示，保留多来源且不泄露绝对路径')

  fs.mkdirSync(originalParent, { recursive: true })
  const original = restoreRetainedFile(sha256, deps)
  assert.equal(original.ok, true)
  assert.equal(fs.readFileSync(path.join(originalParent, '成果.md'), 'utf8'), content)
  assert.equal(restoreRetainedFile(sha256, deps).reason, 'target-exists')
  fs.rmSync(path.join(originalParent, '成果.md'))
  fs.rmSync(originalParent, { recursive: true })
  assert.equal(restoreRetainedFile(sha256, deps).reason, 'original-parent-missing')
  const secondParent = path.join(harnessRoot, 'other')
  fs.mkdirSync(secondParent, { recursive: true })
  const secondSourceRestore = restoreRetainedFile(sha256, { ...deps, provenanceId: provenanceB })
  assert.equal(secondSourceRestore.ok, true)
  fs.rmSync(path.join(secondParent, '成果.md'))
  fs.mkdirSync(alternateParent, { recursive: true })
  const alternate = restoreRetainedFile(sha256, { ...deps, targetDir: alternateParent })
  assert.equal(alternate.ok, true)
  assert.equal(fs.readFileSync(path.join(alternateParent, '成果.md'), 'utf8'), content)
  assert.equal(restoreRetainedFile(sha256, { ...deps, targetDir: alternateParent }).reason, 'target-exists')
  console.log('✓ 恢复只按 ID 解析，原位置/备选目录均不覆盖')

  const externalWorkspace = path.join(root, 'external-native-workspace')
  fs.mkdirSync(externalWorkspace)
  writeIndex([{ ...sources[0], originalPath: path.join(externalWorkspace, '跨盘成果.md') }])
  assert.equal(restoreRetainedFile(sha256, deps).ok, false, 'a stored path alone cannot authorize an external restore')
  assert.equal(restoreRetainedFile(sha256, { ...deps, workspaceRoots: [externalWorkspace] }).ok, true)
  assert.equal(fs.readFileSync(path.join(externalWorkspace, '跨盘成果.md'), 'utf8'), content)
  fs.rmSync(path.join(externalWorkspace, '跨盘成果.md'))
  writeIndex(sources)
  console.log('✓ DSH 已登记的跨盘工作区支持原位置恢复，未授权路径仍拒绝')

  fs.writeFileSync(sourceFile, 'tampered')
  assert.equal(restoreRetainedFile(sha256, { ...deps, targetDir: path.join(root, 'tampered-target') }).reason, 'retention-hash-mismatch')
  fs.mkdirSync(path.join(root, 'tampered-target'))
  assert.equal(restoreRetainedFile(sha256, { ...deps, targetDir: path.join(root, 'tampered-target') }).reason, 'retention-hash-mismatch')
  fs.writeFileSync(sourceFile, content)

  assert.deepEqual(removeRetainedProvenance(sha256, provenanceA, deps), { ok: true, id: sha256, remainingSources: 1 })
  assert.ok(fs.existsSync(sourceFile), '移除一个来源不得回收共享字节')
  assert.equal(listRetainedFiles(deps)[0].sources.length, 1)
  assert.deepEqual(removeRetainedProvenance(sha256, provenanceB, deps), { ok: false, reason: 'whole-file-confirmation-required' })
  assert.ok(fs.existsSync(sourceFile) && listRetainedFiles(deps)[0].sources.length === 1, '最后一个来源不得留下无索引字节')
  assert.equal((await recycleRetainedFile(sha256, { ...deps, recycle: async () => ({ ok: true }) })).reason, 'whole-file-confirmation-required')
  const failed = await recycleRetainedFile(sha256, { ...deps, wholeFile: true, recycle: async () => ({ ok: false, error: 'recycle-failed' }) })
  assert.equal(failed.reason, 'recycle-failed')
  assert.ok(fs.existsSync(sourceFile) && listRetainedFiles(deps).length === 1, '回收失败不得修改文件或索引')
  const deleted = await recycleRetainedFile(sha256, { ...deps, wholeFile: true, recycle: async (file) => { fs.rmSync(file); return { ok: true } } })
  assert.equal(deleted.ok, true)
  assert.equal(listRetainedFiles(deps).length, 0)
  console.log('✓ 共享来源可单独移除；最后一个来源必须显式 whole-file 回收')

  writeIndex(sources.slice(0, 1))
  let failIndexWrite = true
  const failingFs = Object.create(fs)
  failingFs.renameSync = (from, to) => {
    if (failIndexWrite && path.resolve(to) === path.resolve(indexPath)) throw new Error('injected-index-write-failure')
    return fs.renameSync(from, to)
  }
  const partial = await recycleRetainedFile(sha256, {
    ...deps, fsApi: failingFs, wholeFile: true,
    recycle: async (file) => { fs.rmSync(file); return { ok: true } },
  })
  assert.equal(partial.ok, false)
  assert.equal(partial.partialPhase, 'retained-recycled-index-pending')
  assert.equal(fs.existsSync(sourceFile), false)
  assert.equal(listRetainedFiles(deps)[0].partialPhase, 'retained-recycled-index-pending', '轮询不得把待恢复记录伪装为完整文件')
  failIndexWrite = false
  assert.deepEqual(recoverRetainedRecycle(deps), { ok: true, recovered: true, partialPhase: 'retained-recycled-index-converged' })
  assert.equal(listRetainedFiles(deps).length, 0)
  assert.equal(JSON.parse(fs.readFileSync(deleteOperationPath, 'utf8')).phase, 'complete')
  console.log('✓ 回收后索引写入失败以持久化意图在重启后安全收敛')

  assert.deepEqual(retentionReminder([], { now: 1 }), { due: false, count: 0, intervalDays: 1, text: '', action: '' })
  const records = [{ id: sha256 }]
  assert.equal(retentionReminder(records, { config: { remind: { intervalDays: 2 } }, now: 2 * 86400000, lastRetentionReminderAt: 0 }).due, true)
  assert.equal(retentionReminder(records, { config: { remind: { intervalDays: 2 } }, now: 2 * 86400000 - 1, lastRetentionReminderAt: 0 }).due, true, '从未确认时立即到期')
  assert.equal(retentionReminder(records, { config: { remind: { intervalDays: 2 } }, now: 2 * 86400000 - 1, lastRetentionReminderAt: 1 }).due, false)
  assert.equal(retentionReminder(records, { config: { remind: { intervalDays: 2 } }, now: 2 * 86400000 + 1, lastRetentionReminderAt: 1 }).due, true)
  assert.deepEqual(markRetentionReminderSeen(statusPath, { stateRoot, fsApi: fs, now: 1234 }), { ok: true, lastRetentionReminderAt: 1234 })
  assert.equal(JSON.parse(fs.readFileSync(statusPath, 'utf8')).lastRetentionReminderAt, 1234)
  console.log('✓ 提醒只读轮询不确认；显式确认原子持久化并可重启读取')

  if (process.platform === 'win32') {
    writeIndex(sources)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-retained-outside-'))
    const junction = path.join(root, 'junction-target')
    const { execFileSync } = await import('node:child_process')
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `New-Item -ItemType Junction -Path '${junction}' -Target '${outside}' | Out-Null`], { stdio: 'ignore' })
    assert.equal(restoreRetainedFile(sha256, { ...deps, targetDir: junction }).reason, 'path-reparse-escape')
    fs.rmSync(outside, { recursive: true, force: true })
    console.log('✓ 恢复拒绝 Junction 目标目录')
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
