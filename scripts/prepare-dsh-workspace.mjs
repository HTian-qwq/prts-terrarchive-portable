import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const dshRoot = resolve(process.argv[2] ?? '')
if (!dshRoot) throw new Error('用法：node scripts/prepare-dsh-workspace.mjs <dsh-source>')
const workspacePath = join(dshRoot, 'pnpm-workspace.yaml')
const source = readFileSync(workspacePath, 'utf8')
const relativeRule = "  '@deepseek-ai/dsh-subprocess-local@file:packages/subprocess/subprocess-local': true"
if (!source.includes(relativeRule)) {
  throw new Error('官方 DSH workspace 缺少预期的 subprocess-local allowBuilds 规则。')
}
const packageUrl = pathToFileURL(
  join(dshRoot, 'packages', 'subprocess', 'subprocess-local'),
).href
const absoluteRule = `  '@deepseek-ai/dsh-subprocess-local@${packageUrl}': true`
if (!source.includes(absoluteRule)) {
  writeFileSync(workspacePath, source.replace(relativeRule, `${relativeRule}\n${absoluteRule}`))
}
console.log(`已为 deploy 的绝对 file locator 添加精确 build allowlist：${packageUrl}`)
