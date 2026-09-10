import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { packageCurrentCorpus } from './corpus-artifact.mjs'
import { auditElectronArtifact, electronVersions, inspectElectronInput } from './audit-electron-artifact.mjs'
import { assertWindowsX64Executable } from './windows-pe.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const check = (condition, message) => { if (!condition) throw new Error(message) }

function gitState(directory) {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().length > 0
    return { commit, dirty }
  } catch { return { commit: null, dirty: null } }
}

function contains(parent, child) {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')))
}

/** Assemble a second distribution from the official Electron --dir product. */
export async function assemble(options, { versions = electronVersions } = {}) {
  const paths = {}
  for (const name of ['electronDir', 'launcher', 'dshSource', 'plugin', 'corpusReleases', 'out']) {
    check(typeof options[name] === 'string' && options[name].trim(), `缺少组装参数：${name}`)
    paths[name] = resolve(options[name])
    if (name !== 'out') check(existsSync(paths[name]), `组装输入不存在：${name}`)
  }
  for (const name of ['electronDir', 'launcher', 'dshSource', 'plugin', 'corpusReleases']) {
    check(!contains(paths.out, paths[name]) && !contains(paths[name], paths.out), `组装输出不能与输入目录重叠：${name}`)
  }
  check(!existsSync(paths.out) || readdirSync(paths.out).length === 0, 'Electron 输出目录必须不存在或为空，拒绝覆盖已有发行版或用户数据')
  const input = inspectElectronInput(paths.electronDir, { versions })
  assertWindowsX64Executable(paths.launcher, '便携启动器')
  const launcherBytes = readFileSync(paths.launcher)
  check(launcherBytes.length < 2 * 1024 * 1024, '便携启动器应小于 2 MiB，不能使用 Electron 主程序代替')
  const dsh = json(join(paths.dshSource, 'package.json'))
  const desktop = json(join(paths.dshSource, 'apps/desktop/package.json'))
  const source = gitState(paths.dshSource)
  check(dsh.version === versions.dsh.version && desktop.version === versions.dsh.version,
    'DSH/Electron 源码包版本不符')
  check(source.commit === versions.dsh.commit, 'DSH 源码 commit 与 versions.electron.json 不符')
  check([versions.electron, `^${versions.electron}`].includes(desktop.devDependencies?.electron), 'DSH 源码 Electron 依赖与固定版本不符')
  const plugin = json(join(paths.plugin, 'package.json'))
  check(plugin.name === 'prts-terrarchive' && plugin.version === input.plugin.version, '插件源码与离线 seed 包版本不符')
  const pluginSource = gitState(paths.plugin)
  const installer = await import(pathToFileURL(join(paths.plugin, 'src/installer.js')).href)
  mkdirSync(paths.out, { recursive: true })
  // A filter deliberately keeps Node 22's Unicode directory traversal in JS.
  cpSync(paths.electronDir, join(paths.out, 'client'), { recursive: true, dereference: true, filter: () => true })
  writeFileSync(join(paths.out, `${versions.productName}.exe`), launcherBytes)
  const { manifest: corpus } = await packageCurrentCorpus({
    releasesDir: paths.corpusReleases,
    targetDir: join(paths.out, 'corpus/releases'),
    installer,
  })
  const licenses = join(paths.out, 'LICENSES')
  mkdirSync(licenses, { recursive: true })
  cpSync(join(repositoryRoot, 'LICENSE'), join(licenses, 'PRTS-Terrarchive-Portable-MIT.txt'))
  cpSync(join(paths.dshSource, 'LICENSE'), join(licenses, 'DeepSeek-Harness-MIT.txt'))
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'GAME_ASSETS.md']) {
    cpSync(join(paths.plugin, name), join(licenses, `prts-terrarchive-${name}`))
  }
  writeFileSync(join(licenses, 'NOTICE.txt'), [
    'PRTS Terrarchive Electron Portable is an independent community distribution, not an official DeepSeek release.',
    'DeepSeek Harness and prts-terrarchive remain governed by their respective notices.',
    'Electron/Chromium and Node.js notices are preserved alongside their bundled runtimes.',
    'The complete corpus was selected from https://prts.chat current and hash-verified at build time.',
    'Corpus data is not licensed under the code MIT license; consult the dataset terms:',
    'https://modelscope.cn/datasets/HTiantian/prts-agent-corpus-arknights',
    'https://modelscope.cn/datasets/HTiantian/prts-agent-corpus-endfield',
    'Arknights and Endfield names, images, models, textures and other game materials are not licensed under MIT.',
    'See prts-terrarchive-GAME_ASSETS.md and prts-terrarchive-THIRD_PARTY_NOTICES.md.',
    '',
  ].join('\n'))
  writeFileSync(join(paths.out, '使用说明.txt'), [
    'PRTS Terrarchive — 官方 Electron 客户端社区便携版',
    '',
    `解压完整文件夹后双击 ${versions.productName}.exe。无需另装 Node、pnpm 或 WebView2。`,
    '根目录 EXE 是小型启动器；Electron 主程序及 DLL、语言包、离线安装材料统一位于 client/。',
    '首次启动在本目录 userdata/ 中离线初始化运行环境，预装 PRTS 插件与 PRTS 模式。',
    '完整语料位于 corpus/releases/；首次使用不需要下载语料。模型服务需配置自己的凭据。',
    '资料更新请在插件设置中操作，下载仍写入 corpus/releases/。会话和设置保存在本目录 userdata/。',
    '本便携版关闭官方应用自动更新；升级时先退出旧程序，将新版解压到新目录，再把原 userdata/ 复制到新版根目录。',
    '从旧版升级时，旧根目录的 resources、DLL、pak 等文件不需要复制。语料更新过的用户请同时保留自己的 corpus/。',
    '现有 WebView2 便携版仍单独提供。本发行版未包含任何用户数据。',
    '来源、许可证及游戏资源说明见 LICENSES/。',
    '',
  ].join('\n'))
  const manifest = {
    distribution: 'electron-portable', platform: 'win32-x64',
    layout: 'client-v1', launcherSha256: createHash('sha256').update(launcherBytes).digest('hex'),
    portableVersion: versions.portable, electronVersion: versions.electron,
    nodeVersion: versions.node, pnpmVersion: versions.pnpm,
    dshVersion: versions.dsh.version, dshCommit: source.commit, dshDirty: source.dirty,
    pluginVersion: plugin.version, pluginCommit: pluginSource.commit, pluginDirty: pluginSource.dirty,
    pluginSha256: input.pluginSha256, pluginTarball: input.pluginRecord.file,
    prtsSeedRevision: input.revision,
    corpusSource: versions.corpus.source, corpusReleaseId: corpus.release_id,
    corpusDataVersion: corpus.data_version, corpusDocumentCount: corpus.document_count,
    features: ['official-electron-client', 'offline-prts-seed', 'bundled-verified-corpus'],
  }
  writeFileSync(join(paths.out, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await auditElectronArtifact(paths.out, { versions })
  return manifest
}

export const assembleElectron = assemble

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: Object.fromEntries(
    ['electron-dir', 'launcher', 'dsh-source', 'plugin', 'corpus-releases', 'out'].map((name) => [name, { type: 'string' }]),
  ) })
  const manifest = await assemble({
    electronDir: values['electron-dir'], launcher: values.launcher, dshSource: values['dsh-source'], plugin: values.plugin,
    corpusReleases: values['corpus-releases'], out: values.out,
  })
  console.log(`已组装 Electron 便携版：DSH ${manifest.dshVersion} / ${manifest.corpusReleaseId}`)
}
