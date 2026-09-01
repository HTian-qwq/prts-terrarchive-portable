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
  ['PRTS Terrarchive.exe', 'PRTS Terrarchive 桌面程序'],
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
  'PRTS Terrarchive.exe',
  '使用说明.txt',
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

for (const forbiddenPath of ['Start PRTS.cmd', 'Stop PRTS.cmd', 'userdata']) {
  if (existsSync(join(artifact, forbiddenPath))) {
    throw new Error(`发行包不应携带运行时文件或旧入口：${forbiddenPath}`)
  }
}

const gameAssetNotice = join(artifact, 'LICENSES', 'prts-terrarchive-GAME_ASSETS.md')
if (!existsSync(gameAssetNotice) || !readFileSync(gameAssetNotice, 'utf8').includes('not covered by the MIT License')) {
  throw new Error('发行包缺少游戏相关资源的非 MIT 授权边界声明。')
}

if (!manifest.features?.includes('prts-agent-live-retrieval-scene')) {
  throw new Error('发行清单没有声明 PRTS Agent 动态检索场景能力。')
}
const pluginClient = readFileSync(join(
  artifact, 'templates', 'profiles', 'web', 'node_modules', 'prts-terrarchive', 'lib', 'client.js'), 'utf8')
for (const signature of [
  'buildSceneSnapshotModel',
  'sceneSnapshotSignature',
  'QUERYING RETRIEVAL SERVICE',
  'SOURCE CONTEXT READY',
]) {
  if (!pluginClient.includes(signature)) {
    throw new Error(`发行包中的 PRTS Agent 动态检索场景不完整：缺少 ${signature}`)
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
  `  Desktop ${manifest.desktopFramework} / WebView2 SDK ${manifest.webView2SdkVersion}`,
  `  DSH ${manifest.dshVersion} (${manifest.dshCommit})`,
  `  Plugin ${manifest.pluginVersion} (${manifest.pluginCommit})`,
].join('\n'))
