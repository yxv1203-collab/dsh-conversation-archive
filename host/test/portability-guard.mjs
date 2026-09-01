import { assertPortableSources } from './helpers/portability-guard.mjs'
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
console.log('✓ portability guard focused assertions')
