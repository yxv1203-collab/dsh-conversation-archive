import { assertPortableSources } from './helpers/portability-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const check = (sample, rejected) => {
  let failed = false
  try { assertPortableSources(sample, ['DeepSeek Harness/_plugins/dsh-conversation-archive', 'DeepSeek%20Harness/_plugins/dsh-conversation-archive']) } catch { failed = true }
  if (failed !== rejected) throw new Error(`portability assertion mismatch: ${sample}`)
}
check(String.raw`const p = "C:\\Users\\alice\\DeepSeek Harness\\_plugins\\dsh-conversation-archive"`, true)
check('file:///C:/Users/alice/DeepSeek%20Harness/_plugins/dsh-conversation-archive', true)
check('const url = new URL(\'../lib/index.js\', import.meta.url)', false)
assertPortableSources(fs.readFileSync(new URL('../lib/core.js', import.meta.url), 'utf8'))
const host = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const core = fs.readFileSync(new URL('../lib/core.js', import.meta.url), 'utf8')
assert.doesNotMatch(host, /请先手动创建项目文件夹|\bnewProject\b|\barchivedFiles\b|\brunCleanup\b|\bcacheScan\b|\bcacheDeleteItem\b/, 'runtime contains no obsolete workspace-management surface')
assert.doesNotMatch(host, /saveConfigFile\(apiObject\(body, \[[^\]]*['"](?:capture|categories|purge)['"]/, 'public settings API contains no legacy cache-layout controls')
assert.doesNotMatch(core, /export function (?:createProjectEnv|captureSessionFiles|ensureCacheLayout|appendRecord|scanCacheCandidates|cacheDelete)\b/, 'core exports no obsolete cache/project creators')
console.log('✓ portability guard focused assertions')
