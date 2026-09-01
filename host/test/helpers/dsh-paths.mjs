import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const dshPackageJson = process.env.PATH.split(path.delimiter)
  .map((entry) => path.join(entry, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  .find((candidate) => fs.existsSync(candidate))
if (!dshPackageJson) throw new Error('Unable to locate installed @deepseek-ai/dsh package')
const dshRoot = path.dirname(path.dirname(path.dirname(dshPackageJson)))

export function resolveDshPackage(name) {
  const packageJson = require.resolve(`${name}/package.json`, { paths: [dshRoot, path.join(dshRoot, '@deepseek-ai', 'dsh')] })
  return pathToFileURL(packageJson).href.replace(/package\.json$/, 'lib/index.js')
}
