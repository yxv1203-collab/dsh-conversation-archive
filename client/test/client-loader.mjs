import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { resolveDshPackage } from '../../host/test/helpers/dsh-paths.mjs'

const { Context } = await import(resolveDshPackage('@deepseek-ai/cordis'))

let registration
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
vm.runInNewContext(source, {
  window: { __ModuleLoader__: { load(value) { registration = value } } },
})

assert.equal(registration?.id, 'dsh-conversation-archive')
const plugin = registration.factory((name) => {
  if (name === 'react') return { createElement() {} }
  throw new Error(`unexpected client dependency: ${name}`)
})

const slots = {
  inject(name, callback) {
    assert.equal(name, 'settings.section')
    callback()
  },
  register() {},
}
const root = new Context()
root.provide('slots', slots)

let applied = 0
const fiber = root.plugin({
  ...plugin,
  apply(ctx) {
    applied += 1
    return plugin.apply(ctx)
  },
})

await new Promise((resolve) => setImmediate(resolve))
assert.equal(applied, 0, 'client must wait for the workspaces service during cold start')

root.provide('workspaces', { pickDirectory() {} })
await fiber
assert.equal(applied, 1, 'client activates once all declared services are ready')

console.log('client cold-start loader checks passed')
