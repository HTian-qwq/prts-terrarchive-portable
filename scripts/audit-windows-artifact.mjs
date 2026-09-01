import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assertWindowsX64Executable } from './windows-pe.mjs'

const artifact = resolve(process.argv[2] ?? '')
if (!artifact || !existsSync(join(artifact, 'release-manifest.json'))) {
  throw new Error('用法：node scripts/audit-windows-artifact.mjs <artifact-directory>')
}

const manifest = JSON.parse(readFileSync(join(artifact, 'release-manifest.json'), 'utf8'))
if (manifest.platform !== 'win32-x64') {
  throw new Error(`发行平台不符：${manifest.platform ?? 'unknown'}`)
}

const requiredFiles = [
  ['runtime/node/node.exe', 'Node.js'],
  ['runtime/dsh/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node', 'Koffi'],
  ['runtime/dsh/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.3.node', 'Sharp'],
  ['runtime/dsh/node_modules/node-addon-require-builtin-win32-x64-msvc/prebuilt/win32-x64-msvc-napi-v9.node', 'Node builtin loader'],
  ['runtime/dsh/node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe', 'ripgrep'],
  ['runtime/dsh/node_modules/node-pty/prebuilds/win32-x64/conpty.node', 'node-pty'],
]
for (const [relativePath, label] of requiredFiles) {
  const path = join(artifact, relativePath)
  if (!existsSync(path)) throw new Error(`缺少 Windows x64 ${label}：${relativePath}`)
  assertWindowsX64Executable(path, label)
}

const requiredPortableFiles = [
  'Start PRTS.cmd',
  'Stop PRTS.cmd',
  'app/launcher.mjs',
  'runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
  'templates/profiles/web/node_modules/prts-terrarchive/package.json',
  'templates/.agent-presets/prts/preset.yml',
]
for (const relativePath of requiredPortableFiles) {
  if (!existsSync(join(artifact, relativePath))) {
    throw new Error(`发行包缺少文件：${relativePath}`)
  }
}

const visit = (path) => {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`发行包仍含符号链接：${path}`)
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) visit(join(path, entry))
  }
}
visit(artifact)

console.log([
  'Windows x64 静态审计通过。',
  `  Node ${manifest.nodeVersion}`,
  `  DSH ${manifest.dshVersion} (${manifest.dshCommit})`,
  `  Plugin ${manifest.pluginVersion} (${manifest.pluginCommit})`,
].join('\n'))
