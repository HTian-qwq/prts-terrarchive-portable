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
const distributionNotice = readFileSync(join(artifact, 'LICENSES', 'NOTICE.txt'), 'utf8')
if (!distributionNotice.includes('modelscope.cn/datasets/HTiantian/prts-agent-corpus-arknights-gamedata')
    || !distributionNotice.includes('modelscope.cn/datasets/HTiantian/prts-agent-corpus-endfield')
    || !distributionNotice.includes('Corpus data is not licensed')) {
  throw new Error('发行包缺少内置 ModelScope 语料的来源与非 MIT 声明。')
}

if (!manifest.features?.includes('prts-agent-live-retrieval-scene')) {
  throw new Error('发行清单没有声明 PRTS Agent 动态检索场景能力。')
}
if (!manifest.features?.includes('readable-title-pagination')) {
  throw new Error('发行清单没有声明可读标题分页能力。')
}
if (!manifest.features?.includes('bundled-modelscope-corpus')
    || manifest.corpusSource !== 'modelscope') {
  throw new Error('发行清单没有声明随包提供的 ModelScope 语料。')
}
const corpusRoot = join(artifact, 'corpus', 'releases')
const corpusPointerPath = join(corpusRoot, 'current.json')
if (!existsSync(corpusPointerPath)) throw new Error('发行包缺少 corpus/releases/current.json。')
const corpusPointer = JSON.parse(readFileSync(corpusPointerPath, 'utf8'))
const corpusManifestPath = join(corpusRoot, String(corpusPointer.release_id || ''), 'release-manifest.json')
if (!existsSync(corpusManifestPath)) throw new Error('发行包缺少当前语料 release-manifest.json。')
const corpusManifest = JSON.parse(readFileSync(corpusManifestPath, 'utf8'))
if (corpusPointer.release_id !== manifest.corpusReleaseId
    || corpusManifest.release_id !== manifest.corpusReleaseId
    || corpusPointer.data_version !== manifest.corpusDataVersion
    || corpusManifest.data_version !== manifest.corpusDataVersion
    || corpusManifest.document_count !== manifest.corpusDocumentCount) {
  throw new Error('发行包内语料与本次构建记录的版本不符：'
    + ` expected release=${manifest.corpusReleaseId}, data_version=${manifest.corpusDataVersion}, documents=${manifest.corpusDocumentCount};`
    + ` actual pointer_release=${corpusPointer.release_id ?? 'missing'}, manifest_release=${corpusManifest.release_id ?? 'missing'},`
    + ` pointer_data_version=${corpusPointer.data_version ?? 'missing'}, manifest_data_version=${corpusManifest.data_version ?? 'missing'},`
    + ` documents=${corpusManifest.document_count ?? 'missing'}。`)
}
const corpusPackIds = new Set((corpusManifest.packs || []).map((pack) => pack.pack_id))
if (!(corpusManifest.required_packs || []).length
    || corpusManifest.required_packs.some((packId) => !corpusPackIds.has(packId))) {
  throw new Error('发行包内语料缺少 required_packs。')
}
for (const pack of corpusManifest.packs || []) {
  if (!existsSync(join(corpusRoot, manifest.corpusReleaseId, String(pack.manifest_path || '')))) {
    throw new Error(`发行包内语料缺少 pack manifest：${pack.manifest_path ?? 'unknown'}`)
  }
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
const packagedPluginRoot = join(artifact, 'templates', 'profiles', 'web', 'node_modules',
  'prts-terrarchive')
const packagedSearch = readFileSync(join(packagedPluginRoot, 'src', 'search.js'), 'utf8')
const packagedStore = readFileSync(join(packagedPluginRoot, 'src', 'store.js'), 'utf8')
for (const signature of ['next_after', 'PAGE_ANCHOR_MISMATCH', 'checkpointAfterTitle']) {
  if (!packagedSearch.includes(signature)) {
    throw new Error(`发行包中的可读标题分页不完整：缺少 ${signature}`)
  }
}
for (const signature of ['角色活动 Wiki', '大地巡旅', '游戏内原文']) {
  if (!packagedStore.includes(signature)) {
    throw new Error(`发行包中的资料标题适配不完整：缺少 ${signature}`)
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
  `  Corpus ${manifest.corpusReleaseId} (${manifest.corpusDataVersion})`,
].join('\n'))
