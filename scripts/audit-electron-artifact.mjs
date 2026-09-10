import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertWindowsX64Executable } from './windows-pe.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const electronVersions = JSON.parse(readFileSync(join(repositoryRoot, 'versions.electron.json'), 'utf8'))
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const hash = (path, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(readFileSync(path)).digest(encoding)
const check = (condition, message) => { if (!condition) throw new Error(message) }

function safePath(value) {
  check(typeof value === 'string' && value && !value.includes('\\') && !value.includes('\0')
    && !value.includes(':') && !value.startsWith('/')
    && value.split('/').every((part) => part && part !== '.' && part !== '..'), `不安全的发行文件路径：${String(value)}`)
  return value
}

function filesIn(root, prefix = '') {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix + entry.name
    const path = join(root, entry.name)
    check(!entry.isSymbolicLink(), `发行包不能含符号链接：${name}`)
    check(!['userdata', 'appdata'].includes(entry.name.toLowerCase()), `发行包不应携带用户数据目录：${name}`)
    if (entry.isDirectory()) return filesIn(path, name + '/')
    check(entry.isFile(), `发行包包含非常规文件：${name}`)
    return [name]
  }).sort()
}

function checkPrivateFiles(names, root) {
  for (const name of names) {
    const parts = name.toLowerCase().split('/')
    const file = parts.at(-1)
    check(!parts.some((part) => part === 'userdata' || part === 'appdata'), `发行包不应携带用户数据：${name}`)
    check(file !== 'app-update.yml', `Electron 便携版不应启用官方自动更新：${name}`)
    check(!/^(?:\.credentials\.ya?ml|\.env(?:\..*)?|id_rsa|id_dsa|id_ecdsa|id_ed25519)$/u.test(file)
      && !/\.(?:pfx|p12|ppk)$/u.test(file), `发行包不应携带凭据或私钥：${name}`)
    if (/\.(?:pem|key)$/u.test(file)) {
      check(!/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u.test(readFileSync(join(root, name), 'utf8')),
        `发行包不应携带私钥：${name}`)
    }
  }
}

function tarNames(path) {
  const names = execFileSync('tar', ['-tzf', path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .trim().split(/\r?\n/u).filter(Boolean).map((name) => name.replace(/\/$/u, ''))
  for (const name of names) {
    safePath(name)
    check(name === 'package' || name.startsWith('package/'), 'npm tarball 必须只包含 package/ 下的文件')
  }
  const details = execFileSync('tar', ['-tvzf', path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  check(details.split(/\r?\n/u).filter(Boolean).every((line) => line.startsWith('-') || line.startsWith('d')),
    'npm tarball 不能包含符号链接或硬链接')
  return names
}

function tarPackage(path) {
  return JSON.parse(execFileSync('tar', ['-xOzf', path, 'package/package.json'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }))
}

function checkAsar(path, versions) {
  const fd = openSync(path, 'r')
  try {
    const prefix = Buffer.alloc(16)
    check(readSync(fd, prefix, 0, 16, 0) === 16, 'Electron ASAR 文件头缺失')
    const length = prefix.readUInt32LE(12)
    const dataOffset = 8 + prefix.readUInt32LE(4)
    check(length > 0 && length <= 16 * 1024 * 1024 && length + 16 <= dataOffset
      && dataOffset < fstatSync(fd).size, 'Electron ASAR 文件头无效')
    const bytes = Buffer.alloc(length)
    check(readSync(fd, bytes, 0, length, 16) === length, 'Electron ASAR 文件头不完整')
    const header = JSON.parse(bytes.toString('utf8'))
    const entry = (name) => name.split('/').reduce((parent, part) => parent?.files?.[part], header)
    for (const name of ['package.json', 'portable-main.mjs', 'lib/main.js', 'lib/preload.cjs', 'lib/preload-app.cjs',
      'renderer/plugin-manager.html', 'renderer/plugin-manager.js', 'renderer/plugin-manager.css']) {
      const file = entry(name)
      check(file && !file.unpacked && !file.link && Number.isSafeInteger(file.size)
        && file.size > 0 && /^\d+$/u.test(file.offset) && Number.isSafeInteger(Number(file.offset))
        && dataOffset + Number(file.offset) + file.size <= fstatSync(fd).size, `Electron ASAR 缺少或损坏入口：${name}`)
    }
    const file = entry('package.json')
    check(file.size <= 1024 * 1024, 'Electron ASAR package.json 超出合理大小')
    const content = Buffer.alloc(file.size)
    check(readSync(fd, content, 0, content.length, dataOffset + Number(file.offset)) === content.length,
      'Electron ASAR package.json 不完整')
    const metadata = JSON.parse(content.toString('utf8'))
    check(metadata.main === 'portable-main.mjs' && metadata.version === versions.dsh.version
      && metadata.prtsPortable?.version === versions.portable && metadata.prtsPortable?.appId === versions.appId
      && metadata.prtsPortable?.layout === 'client-v1',
      'Electron ASAR 未使用正确的 PRTS 便携入口或版本')
  } finally { closeSync(fd) }
}

/** Validate the official shell's immutable offline inputs, before or after assembly. */
export function inspectElectronInput(artifact, { versions = electronVersions } = {}) {
  const root = resolve(artifact)
  const names = filesIn(root)
  checkPrivateFiles(names, root)
  for (const required of [
    `${versions.productName}.exe`, 'resources/app.asar', 'LICENSE.electron.txt', 'LICENSES.chromium.html',
    'resources/runtime/node/node.exe', 'resources/runtime/versions.json',
    'resources/runtime/pnpm/package.json', 'resources/runtime/pnpm/bin/pnpm.mjs', 'resources/runtime/node/LICENSE',
    'resources/seed/package.json', 'resources/seed/pnpm-lock.yaml',
    'resources/seed/pnpm-workspace.yaml', 'resources/seed/desktop-release.json',
    'resources/seed/desktop-packages.json', 'resources/seed/prts-seed.json',
    'resources/seed/store-archives.json', 'resources/seed/integrity.json',
  ]) check(names.includes(required), `Electron 发行包缺少文件：${required}`)
  assertWindowsX64Executable(join(root, `${versions.productName}.exe`), 'Electron 主程序')
  assertWindowsX64Executable(join(root, 'resources/runtime/node/node.exe'), '内置 Node.js')
  checkAsar(join(root, 'resources/app.asar'), versions)
  let nativeModules = 0
  for (const name of names.filter((name) => name.endsWith('.node'))) {
    assertWindowsX64Executable(join(root, name), '松散原生模块')
    nativeModules++
  }
  const runtime = json(join(root, 'resources/runtime/versions.json'))
  check(runtime.node === versions.node && runtime.pnpm === versions.pnpm, '内置 Node/pnpm 版本不符')
  check(json(join(root, 'resources/runtime/pnpm/package.json')).version === versions.pnpm, '内置 pnpm package.json 版本不符')
  const seed = join(root, 'resources/seed')
  const release = json(join(seed, 'desktop-release.json'))
  check(release.version === versions.dsh.version && release.nodeVersion === versions.node
    && release.pnpmVersion === versions.pnpm, '离线 seed 的 DSH/Node/pnpm 版本不符')
  const integrity = json(join(seed, 'integrity.json'))
  check(integrity.schemaVersion === 2 && Array.isArray(integrity.files), 'seed integrity inventory 格式错误')
  const expected = new Map()
  for (const entry of integrity.files) {
    safePath(entry.path)
    check(entry.path !== 'integrity.json' && !expected.has(entry.path)
      && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && /^[a-f0-9]{64}$/u.test(entry.sha256), 'seed integrity inventory 记录无效或重复')
    expected.set(entry.path, entry)
  }
  const seedFiles = filesIn(seed).filter((name) => name !== 'integrity.json')
  check(seedFiles.length === expected.size, 'seed integrity inventory 与实际文件集合不符')
  for (const name of seedFiles) {
    const entry = expected.get(name)
    check(entry && lstatSync(join(seed, name)).size === entry.bytes && hash(join(seed, name)) === entry.sha256,
      `seed integrity 校验失败：${name}`)
  }
  const core = json(join(seed, 'desktop-packages.json'))
  check(core.schemaVersion === 1 && Array.isArray(core.packages), 'Desktop core package set 格式错误')
  check(!core.packages.some((entry) => entry.name === 'prts-terrarchive'), 'PRTS 必须是普通插件依赖，不能成为 Desktop core override')
  for (const required of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host']) {
    const record = core.packages.find((entry) => entry.name === required)
    check(record?.version === versions.dsh.version, `Desktop core package 缺少正确版本：${required}`)
  }
  const packageRecords = json(join(seed, 'prts-seed.json'))
  check(packageRecords.schemaVersion === 1 && Array.isArray(packageRecords.packages)
    && packageRecords.packages.length === 1, 'PRTS seed revision 描述符无效')
  const revision = createHash('sha256').update(JSON.stringify({ schemaVersion: 1, packages: packageRecords.packages })).digest('hex')
  check(packageRecords.revision === revision, 'PRTS seed revision 与包记录不符')
  const pluginRecord = packageRecords.packages[0]
  check(pluginRecord.name === 'prts-terrarchive', 'PRTS seed 缺少插件包')
  for (const record of [...core.packages, pluginRecord]) {
    check(typeof record.file === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u.test(record.file), 'seed npm tarball 文件名无效')
    const file = join(seed, 'desktop-packages', record.file)
    check(existsSync(file) && lstatSync(file).size === record.bytes
      && `sha512-${hash(file, 'sha512', 'base64')}` === record.integrity, `seed npm tarball 校验失败：${record.name}`)
  }
  const pluginTarball = join(seed, 'desktop-packages', pluginRecord.file)
  const pluginSha256 = hash(pluginTarball)
  check(pluginRecord.file === `prts-terrarchive-${pluginSha256}.tgz`, 'PRTS tarball 文件名必须绑定完整 SHA-256')
  const profile = json(join(seed, 'package.json'))
  check(profile.dependencies?.['prts-terrarchive'] === `file:./desktop-packages/${pluginRecord.file}`,
    'seed 缺少可离线安装的 PRTS 普通依赖')
  check(profile.dsh?.profile?.bundles?.includes('prts-terrarchive'), 'seed profile 缺少 PRTS bundle')
  check(!Object.hasOwn(profile.pnpm?.overrides ?? {}, 'prts-terrarchive'), 'PRTS 不应被 pnpm core override 接管')
  check(!/^\s*["']?prts-terrarchive(?:@[^"':\s]+)?["']?\s*:/mu.test(readFileSync(join(seed, 'pnpm-workspace.yaml'), 'utf8')),
    'PRTS 不应被 pnpm workspace core override 接管')
  check(readFileSync(join(seed, 'pnpm-lock.yaml'), 'utf8').includes(pluginRecord.file), 'seed lockfile 没有锁定 PRTS 本地 tarball')
  const plugin = tarPackage(pluginTarball)
  check(plugin.name === pluginRecord.name && plugin.version === pluginRecord.version, 'PRTS tarball 包名或版本与 seed 不符')
  check(plugin.dsh?.bundle?.patch === './cordis.patch.yml' && plugin.exports?.['./presets'] === './presets/register.js',
    'PRTS tarball 缺少 bundle/preset 导出')
  const packedNames = tarNames(pluginTarball)
  for (const required of ['package.json', 'cordis.patch.yml', 'src/index.js', 'src/installer.js',
    'src/skill.js', 'lib/client.js', 'presets/register.js', 'presets/prts/agent.cordis.yml',
    'presets/prts/preset.yml', 'skills/prts-retrieval/SKILL.md']) {
    check(packedNames.includes(`package/${required}`), `PRTS tarball 缺少 ${required}`)
  }
  check(packedNames.some((name) => name.startsWith('package/lib/endfield-map/')), 'PRTS tarball 缺少地图资源')
  check(!packedNames.some((name) => /^package\/(?:data|userdata|runtime|node_modules|\.dsh-home)(?:\/|$)/u.test(name)),
    'PRTS npm 包不应夹带语料、用户数据或运行库')
  const store = json(join(seed, 'store-archives.json'))
  check(store.schemaVersion === 1 && Array.isArray(store.archives) && store.archives.length > 0,
    'seed 缺少离线 pnpm store archives')
  const archiveNames = store.archives.map((entry) => {
    check(/^store-[0-9a-f]{2}\.tar$/u.test(entry.file) && Number.isSafeInteger(entry.entries) && entry.entries > 0,
      'seed store archive 记录无效')
    return entry.file
  }).sort()
  assert.deepEqual(readdirSync(join(seed, 'store-archives')).sort(), archiveNames, 'seed store archive 集合不完整')
  return { root, seed, plugin, pluginRecord, pluginTarball, pluginSha256, revision, nativeModules }
}

/** Audit the finished Windows Electron distribution without installing or launching it. */
export async function auditElectronArtifact(artifact, { versions = electronVersions } = {}) {
  const root = resolve(artifact)
  checkPrivateFiles(filesIn(root), root)
  assert.deepEqual(readdirSync(root).sort(), [
    `${versions.productName}.exe`, 'client', 'corpus', 'LICENSES', '使用说明.txt', 'release-manifest.json',
  ].sort(), 'Electron 发行根目录应只包含启动器、client、语料和说明文件')
  const input = inspectElectronInput(join(root, 'client'), { versions })
  const { plugin, pluginSha256, revision } = input
  const manifest = json(join(root, 'release-manifest.json'))
  check(manifest.distribution === 'electron-portable' && manifest.platform === 'win32-x64', '不是 Windows Electron 便携版清单')
  const launcher = join(root, `${versions.productName}.exe`)
  assertWindowsX64Executable(launcher, '便携启动器')
  check(manifest.layout === 'client-v1' && hash(launcher) === manifest.launcherSha256, '便携启动器或目录布局与发行清单不符')
  check(lstatSync(launcher).size < 2 * 1024 * 1024, '便携启动器应小于 2 MiB')
  for (const [field, value] of Object.entries({
    portableVersion: versions.portable, electronVersion: versions.electron,
    dshVersion: versions.dsh.version, dshCommit: versions.dsh.commit,
    nodeVersion: versions.node, pnpmVersion: versions.pnpm,
    pluginVersion: plugin.version, pluginSha256, prtsSeedRevision: revision,
  })) check(manifest[field] === value, `Electron 发行清单字段不符：${field}`)
  for (const name of ['使用说明.txt', 'LICENSES/NOTICE.txt', 'LICENSES/PRTS-Terrarchive-Portable-MIT.txt',
    'LICENSES/DeepSeek-Harness-MIT.txt', 'LICENSES/prts-terrarchive-LICENSE',
    'LICENSES/prts-terrarchive-THIRD_PARTY_NOTICES.md', 'LICENSES/prts-terrarchive-GAME_ASSETS.md']) {
    check(existsSync(join(root, name)), `发行包缺少声明：${name}`)
  }
  const releases = join(root, 'corpus/releases')
  const pointer = json(join(releases, 'current.json'))
  safePath(pointer.release_id)
  check(!pointer.release_id.includes('/'), '语料 release_id 不能包含子目录')
  assert.deepEqual(readdirSync(releases).sort(), ['current.json', pointer.release_id].sort(), '发行包只应包含 current 选定的一份语料')
  const temporary = mkdtempSync(join(tmpdir(), 'prts-electron-audit-'))
  try {
    execFileSync('tar', ['-xzf', input.pluginTarball, '-C', temporary])
    const packageRoot = join(temporary, 'package')
    checkPrivateFiles(filesIn(packageRoot), packageRoot)
    const installer = await import(pathToFileURL(join(packageRoot, 'src/installer.js')).href)
    const { manifest: corpus, packManifests } = await installer.validateLocalRelease(releases, pointer.release_id, { verifyHashes: true, details: true })
    for (const packId of ['official_game', 'endfield_official_game', 'endfield_reviewed_knowledge',
      'reviewed_wiki', 'terra_journey', 'entities', 'references']) {
      check(packManifests.has(packId) && corpus.required_packs.includes(packId), `完整双游戏语料缺少资料包：${packId}`)
    }
    check(pointer.data_version === corpus.data_version && corpus.release_id === manifest.corpusReleaseId
      && corpus.data_version === manifest.corpusDataVersion && corpus.document_count === manifest.corpusDocumentCount,
      '当前语料与 Electron 发行清单不符')
    const allowed = ['release-manifest.json']
    for (const [packId, pack] of packManifests) {
      allowed.push(`${packId}/pack-manifest.json`)
      for (const asset of [...pack.shards, ...(pack.search_index?.shards ?? []), ...(pack.document_catalog ? [pack.document_catalog] : [])]) {
        allowed.push(`${packId}/${asset.path}`)
      }
    }
    assert.deepEqual(filesIn(join(releases, pointer.release_id)), allowed.sort(), '语料发行目录包含清单外残留文件')
  } finally {
    rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  return { manifest, nativeModules: input.nativeModules }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  check(process.argv.length === 3, '用法：node scripts/audit-electron-artifact.mjs <artifact-directory>')
  const { manifest } = await auditElectronArtifact(process.argv[2])
  console.log(`Windows Electron 静态审计通过：DSH ${manifest.dshVersion} / Electron ${manifest.electronVersion} / ${manifest.corpusDocumentCount} documents`)
}
