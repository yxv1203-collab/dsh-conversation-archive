import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findRetentionCandidates, createRetentionPrompt, parseRetentionDecision, reviewRetentionCandidates, retainReviewedFiles, cacheLayoutFor, ensureCacheLayout, archiveSessionFlow, purgeSessionFlow, loadConfig } from '../lib/core.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-retention-'))
const cache = path.join(root, 'archive')
const stateRoot = path.join(root, 'dsh-state')
fs.mkdirSync(path.join(cache, '文档'), { recursive: true })
fs.mkdirSync(path.join(cache, '图片'), { recursive: true })
fs.mkdirSync(path.join(cache, 'node_modules', 'pkg'), { recursive: true })
fs.writeFileSync(path.join(cache, '文档', '成果.md'), '# final result\nkeep this')
fs.writeFileSync(path.join(cache, '临时.tmp'), 'discard')
fs.writeFileSync(path.join(cache, 'node_modules', 'pkg', 'ignored.js'), 'discard')
fs.writeFileSync(path.join(cache, '文档', '过大.md'), Buffer.alloc(8 * 1024 * 1024 + 1, 'x'))
fs.writeFileSync(path.join(cache, '图片', '预览.png'), Buffer.from('89504e470d0a1a0a', 'hex'))

try {
  const candidates = findRetentionCandidates(cache, fs)
  assert.equal(candidates.length, 3)
  const outputCandidate = candidates.find((candidate) => candidate.name === '成果.md')
  assert.equal(outputCandidate.relativePath, path.join('文档', '成果.md'))
  assert.match(outputCandidate.id, /^[a-f0-9]{64}$/)
  assert.match(outputCandidate.excerpt, /final result/)
  const oversized = findRetentionCandidates(cache, fs, { maxCandidateBytes: 1024, maxExcerptChars: 90 }).find((candidate) => candidate.name === '过大.md')
  assert.equal(oversized.sampleKind, 'representative-start-middle-end')
  assert.match(oversized.excerpt, /中段\/末段抽样/)
  assert.equal(oversized.excerpt.length <= 90, true)
  console.log('✓ 保留候选仅来自受管缓存，过滤临时/依赖文件并对大文本抽取首中尾')

  const prompt = createRetentionPrompt(candidates)
  assert.match(prompt, new RegExp(outputCandidate.id))
  assert.match(prompt, /final result/)
  assert.deepEqual(parseRetentionDecision(JSON.stringify({ retain: [{ id: outputCandidate.id, reason: '最终成果' }] }), candidates), [{ ...outputCandidate, reason: '最终成果' }])
  assert.deepEqual(parseRetentionDecision('{"retain":[]}', candidates), [], 'AI 可以判断没有值得保留的最终产出')
  for (const bad of [
    '{"retain":[{"id":"forged","reason":"x"}]}',
    JSON.stringify({ retain: [{ id: outputCandidate.id, reason: 'x' }, { id: outputCandidate.id, reason: 'y' }] }),
    'result: {}',
  ]) assert.throws(() => parseRetentionDecision(bad, candidates), { message: 'ai-review-failed' })
  console.log('✓ AI 结果只接受已知不重复 ID 的严格 JSON')

  const calls = []
  const ctx = {
    get: (name) => name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) } : undefined,
    llm: { stream: async function * (request) {
      calls.push(request)
      yield { type: 'text-delta', text: JSON.stringify({ retain: [{ id: outputCandidate.id, reason: '可交付成果' }] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
  }
  const reviewed = await reviewRetentionCandidates(ctx, candidates)
  assert.equal(reviewed.ok, true)
  assert.equal(reviewed.selected[0].reason, '可交付成果')
  assert.equal(calls[0].provider, 'default-provider')
  assert.equal(calls[0].model, 'default-model')
  assert.equal(calls[0].messages[0].role, 'user')
  console.log('✓ DSH 默认模型通过 ctx.llm.stream 完成审核')

  const imageCandidate = candidates.find((candidate) => candidate.name === '预览.png')
  let imageRequest
  const imageCtx = {
    get: (name) => name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'vision-provider', model: 'vision-model' }) }
      : name === 'attachments' ? { saveImage: async ({ data, mediaType, name }) => ({ attachmentId: 'saved-image', mediaType, bytes: data.length, width: 1, height: 1, name }) } : undefined,
    llm: {
      resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
      stream: async function * (request) {
        imageRequest = request
        yield { type: 'text-delta', text: JSON.stringify({ retain: [{ id: imageCandidate.id, reason: '图片成果' }] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  assert.equal((await reviewRetentionCandidates(imageCtx, [imageCandidate], { fsApi: fs })).ok, true)
  assert.equal(imageRequest.messages[0].content.some((block) => block.type === 'image' && block.attachment.attachmentId === 'saved-image'), true)
  console.log('✓ DSH 模型与附件服务支持时发送真实图片块')

  const retainedRoot = path.join(root, '重要文件保护')
  const indexPath = path.join(stateRoot, 'retained.json')
  const operationPath = path.join(stateRoot, 'retention-operation.json')
  const retained = retainReviewedFiles([{ ...outputCandidate, reason: '最终交付' }], {
    sessionId: 'retention-session', cacheRoot: cache, retainedRoot, indexPath, operationPath, harnessRoot: root, stateRoot, fsApi: fs,
  })
  assert.equal(retained.ok, true)
  assert.equal(fs.readFileSync(retained.retained[0].path, 'utf8'), '# final result\nkeep this')
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  assert.equal(index.schemaVersion, 1)
  assert.equal(index.files[outputCandidate.sha256].sources[0].sessionId, 'retention-session')
  assert.equal(JSON.parse(fs.readFileSync(operationPath, 'utf8')).phase, 'complete')
  const duplicate = retainReviewedFiles([{ ...outputCandidate, reason: '第二个来源' }], {
    sessionId: 'other-session', cacheRoot: cache, retainedRoot, indexPath, operationPath, harnessRoot: root, stateRoot, fsApi: fs,
  })
  assert.equal(duplicate.ok, true)
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(indexPath, 'utf8')).files).length, 1)
  assert.equal(JSON.parse(fs.readFileSync(indexPath, 'utf8')).files[outputCandidate.sha256].sources.length, 2)
  console.log('✓ 保留副本哈希校验、原子索引与多来源去重')

  const entry = { id: 'purge-retention-abcdef123456', kind: 'daily', date: '2026-08-31', createdAt: Date.now(), tag: '删除前审核', layoutVersion: 2, status: 'active' }
  const layout = cacheLayoutFor(entry, { harnessRoot: root })
  entry.cacheDir = layout.base
  entry.recordFile = layout.recordFile
  entry.manifestFile = path.join(layout.recordDir, `${entry.tag}.清单.md`)
  ensureCacheLayout(layout, fs)
  fs.writeFileSync(path.join(layout.base, '文档', '输出.md'), 'important')
  const mapping = { [entry.id]: entry }
  assert.equal(archiveSessionFlow(entry.id, entry, { fsApi: fs, harnessRoot: root, config: loadConfig(fs, {}, ''), mapping }).ok, true)
  let recycleCalled = false
  const blocked = await purgeSessionFlow(entry.id, entry, {
    fsApi: fs, harnessRoot: root, config: loadConfig(fs, {}, ''), mapping,
    retain: async () => ({ ok: false, reason: 'ai-review-failed' }),
    recycle: async () => { recycleCalled = true; return { ok: true } },
  })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'ai-review-failed')
  assert.equal(recycleCalled, false)
  assert.ok(fs.existsSync(entry.archivePath))
  console.log('✓ AI/复制失败时绝不回收缓存或改变归档状态')

  const ordered = []
  const completed = await purgeSessionFlow(entry.id, entry, {
    fsApi: fs, harnessRoot: root, config: loadConfig(fs, {}, ''), mapping,
    retain: async ({ target }) => {
      ordered.push('retain')
      const selected = findRetentionCandidates(target, fs).map((candidate) => ({ ...candidate, reason: '最终输出' }))
      return retainReviewedFiles(selected, { sessionId: entry.id, cacheRoot: target, retainedRoot, indexPath, operationPath, harnessRoot: root, stateRoot, fsApi: fs })
    },
    recycle: async (target) => { ordered.push('recycle'); fs.rmSync(target, { recursive: true, force: true }); return { ok: true } },
  })
  assert.equal(completed.ok, true)
  assert.deepEqual(ordered, ['retain', 'recycle'])
  console.log('✓ 已验证的保留索引必定先于缓存回收')

  const badCtx = { get: (name) => name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined, llm: { stream: async function * () { yield { type: 'finish', reason: { kind: 'error', failure: {} } } } } }
  assert.deepEqual(await reviewRetentionCandidates(badCtx, candidates), { ok: false, reason: 'ai-review-failed' })
  const copyFailureFs = Object.create(fs)
  copyFailureFs.copyFileSync = () => { throw new Error('copy-failed') }
  const failureSource = path.join(root, 'failure-source')
  fs.mkdirSync(failureSource, { recursive: true })
  fs.writeFileSync(path.join(failureSource, 'keep.md'), 'retain me')
  const failureCandidate = findRetentionCandidates(failureSource, fs)[0]
  assert.deepEqual(retainReviewedFiles([{ ...failureCandidate, reason: '保留' }], {
    sessionId: 'copy-failure-session', cacheRoot: failureSource, retainedRoot, indexPath: path.join(stateRoot, 'copy-failure-index.json'), operationPath, harnessRoot: root, stateRoot, fsApi: copyFailureFs,
  }), { ok: false, reason: 'retention-copy-failed' })
  assert.ok(fs.existsSync(path.join(failureSource, 'keep.md')))
  const indexFailurePath = path.join(stateRoot, 'index-write-failure.json')
  const indexFailureFs = Object.create(fs)
  indexFailureFs.renameSync = (from, to) => {
    if (path.resolve(to) === path.resolve(indexFailurePath)) throw new Error('index-write-failed')
    return fs.renameSync(from, to)
  }
  assert.deepEqual(retainReviewedFiles([{ ...failureCandidate, reason: '保留' }], {
    sessionId: 'index-failure-session', cacheRoot: failureSource, retainedRoot, indexPath: indexFailurePath, operationPath: path.join(stateRoot, 'index-failure-operation.json'), harnessRoot: root, stateRoot, fsApi: indexFailureFs,
  }), { ok: false, reason: 'retention-copy-failed' })
  assert.deepEqual(retainReviewedFiles([{ ...failureCandidate, reason: '保留' }], {
    sessionId: 'state-root-session', cacheRoot: failureSource, retainedRoot, indexPath: path.join(root, 'wrong-index.json'), operationPath: path.join(stateRoot, 'wrong-operation.json'), harnessRoot: root, stateRoot, fsApi: fs,
  }), { ok: false, reason: 'retention-copy-failed' })
  if (process.platform === 'win32') {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-retention-outside-'))
    const junction = path.join(root, 'retained-junction')
    const { execFileSync } = await import('node:child_process')
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `New-Item -ItemType Junction -Path '${junction}' -Target '${outside}' | Out-Null`], { stdio: 'ignore' })
    assert.deepEqual(retainReviewedFiles([{ ...failureCandidate, reason: '保留' }], {
      sessionId: 'junction-session', cacheRoot: failureSource, retainedRoot: junction, indexPath: path.join(stateRoot, 'junction-index.json'), operationPath, harnessRoot: root, stateRoot, fsApi: fs,
    }), { ok: false, reason: 'retention-copy-failed' })
    fs.rmSync(outside, { recursive: true, force: true })
  }
  console.log('✓ 模型/复制错误均失败关闭，原缓存保持不变')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
