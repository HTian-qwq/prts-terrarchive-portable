/** Assemble a portable ZIP from the DSH 0.1.7 official Desktop shell and bundled PRTS runtime. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { packageCurrentCorpus } from './corpus-artifact.mjs'
import { assertWindowsX64Executable } from './windows-pe.mjs'
import { inspectPrtsTarball } from '../electron/inject-runtime.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const versions = JSON.parse(readFileSync(join(root, 'versions.electron.current.json'), 'utf8'))
const json = path => JSON.parse(readFileSync(path, 'utf8'))
function requireFile(path) { if (!existsSync(path)) throw new Error(`Missing Electron artifact file: ${path}`) }
function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }

export async function assembleCurrent({ electronDir, launcher, dshSource, plugin, pluginTarball, corpusReleases, out }) {
  const source = resolve(dshSource)
  const target = resolve(out)
  if (existsSync(target) && readdirSync(target).length !== 0) throw new Error('Output must be absent or empty')
  const dsh = json(join(source, 'package.json'))
  const desktop = json(join(source, 'apps/desktop/package.json'))
  const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (commit !== versions.dsh.commit || dsh.version !== versions.dsh.version || desktop.version !== versions.dsh.version) {
    throw new Error('DSH Desktop source differs from the pinned release')
  }
  const packageManifest = json(join(plugin, 'package.json'))
  const parts = value => /^\d+\.\d+\.\d+$/u.test(value) ? value.split('.').map(Number) : null
  const actual = parts(packageManifest.version)
  const minimum = parts(versions.plugin.minimumVersion)
  const difference = actual?.findIndex((value, index) => value !== minimum?.[index]) ?? -1
  if (packageManifest.name !== versions.plugin.name || actual === null || minimum === null
    || (difference >= 0 && actual[difference] < minimum[difference])) {
    throw new Error('Local PRTS plugin is incompatible with this portable build')
  }
  const packedPlugin = inspectPrtsTarball(pluginTarball)
  if (packedPlugin.name !== packageManifest.name || packedPlugin.version !== packageManifest.version) {
    throw new Error('Packed PRTS plugin differs from the selected source')
  }
  const descriptor = json(join(source, 'apps/desktop/.desktop-build/targets/win-x64/dsh/desktop-runtime.json'))
  if (descriptor.release.version !== versions.dsh.version || descriptor.platform !== 'win32' || descriptor.arch !== 'x64'
    || !descriptor.sharedPackages.some(entry => entry.name === packageManifest.name && entry.version === packageManifest.version)) {
    throw new Error('Prepared runtime does not include the exact PRTS package')
  }
  const artifact = resolve(electronDir)
  const executable = join(artifact, `${versions.productName}.exe`)
  requireFile(executable)
  requireFile(join(artifact, 'resources', 'app.asar'))
  requireFile(join(artifact, 'resources', 'runtime', 'versions.json'))
  requireFile(join(artifact, 'resources', 'runtime', 'primary-runtime', 'runtime.json'))
  assertWindowsX64Executable(executable, 'Electron main program')
  assertWindowsX64Executable(launcher, 'portable launcher')
  if (readFileSync(launcher).length >= 2 * 1024 * 1024) throw new Error('Portable launcher exceeds 2 MiB')
  if (existsSync(join(artifact, 'resources', 'app-update.yml'))) throw new Error('Portable shell contains an official update feed')
  const runtimeVersions = json(join(artifact, 'resources', 'runtime', 'versions.json'))
  if (runtimeVersions.node !== descriptor.release.nodeVersion || runtimeVersions.pnpm !== versions.pnpm) {
    throw new Error('Bundled Electron runtime versions differ from the descriptor')
  }
  mkdirSync(target, { recursive: true })
  cpSync(artifact, join(target, 'client'), { recursive: true, dereference: true })
  cpSync(launcher, join(target, `${versions.productName}.exe`))
  const installer = await import(pathToFileURL(join(plugin, 'src/installer.js')).href)
  const { manifest: corpus } = await packageCurrentCorpus({
    releasesDir: resolve(corpusReleases), targetDir: join(target, 'corpus/releases'), installer,
  })
  const licenses = join(target, 'LICENSES')
  mkdirSync(licenses)
  cpSync(join(root, 'LICENSE'), join(licenses, 'PRTS-Terrarchive-Portable-MIT.txt'))
  cpSync(join(source, 'LICENSE'), join(licenses, 'DeepSeek-Harness-MIT.txt'))
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'GAME_ASSETS.md']) {
    cpSync(join(plugin, name), join(licenses, `prts-terrarchive-${name}`))
  }
  writeFileSync(join(licenses, 'NOTICE.txt'), [
    'PRTS Terrarchive Electron Portable is an independent community distribution, not an official DeepSeek release.',
    'DeepSeek Harness and prts-terrarchive retain their respective notices.',
    'The verified current PRTS.chat corpus is bundled under corpus/releases/ and has separate dataset terms.',
    'https://modelscope.cn/datasets/HTiantian/prts-agent-corpus-arknights',
    'https://modelscope.cn/datasets/HTiantian/prts-agent-corpus-endfield',
    '',
  ].join('\n'))
  writeFileSync(join(target, '使用说明.txt'), [
    'PRTS Terrarchive — DSH 0.1.7 官方 Electron 客户端社区便携版',
    '',
    `完整解压后双击 ${versions.productName}.exe。client/ 包含官方 Electron 主程序及内置 PRTS 插件。`,
    '首次启动在 userdata/ 创建 Desktop profile，默认使用 PRTS 模式和 PRTS Agent 皮肤。',
    '完整语料位于 corpus/releases/，无需另行下载；模型服务仍需用户配置。',
    '关闭窗口时官方客户端可继续在后台运行；从系统托盘退出才会结束任务。',
    '升级前请退出旧版。复制旧 userdata/ 到新版目录时，旧安装式 profile 会备份到 userdata/profiles/desktop.pre-0.1.7/。',
    '旧版额外安装的第三方插件需要在新版 Desktop 中重新安装；旧文件保留在备份中。',
    '本便携版不接入官方应用自动更新，语料仍可在 PRTS 设置中更新。',
    '详情及权利声明见 LICENSES/。',
    '',
  ].join('\n'))
  const release = {
    distribution: 'electron-portable', layout: 'client-v2', platform: 'win32-x64',
    portableVersion: versions.portable, dshVersion: versions.dsh.version, dshCommit: commit,
    electronVersion: versions.electron, nodeVersion: runtimeVersions.node, pnpmVersion: runtimeVersions.pnpm,
    pluginVersion: packageManifest.version, pluginSha256: sha256(pluginTarball),
    launcherSha256: sha256(launcher), corpusReleaseId: corpus.release_id,
    corpusDataVersion: corpus.data_version, corpusDocumentCount: corpus.document_count,
    features: ['official-electron-client', 'bundled-prts-runtime', 'bundled-verified-corpus'],
  }
  writeFileSync(join(target, 'release-manifest.json'), `${JSON.stringify(release, null, 2)}\n`)
  return release
}

if (import.meta.main) {
  const { values } = parseArgs({ options: Object.fromEntries(
    ['electron-dir', 'launcher', 'dsh-source', 'plugin', 'plugin-tarball', 'corpus-releases', 'out']
      .map(name => [name, { type: 'string' }]),
  ) })
  const required = ['electron-dir', 'launcher', 'dsh-source', 'plugin', 'plugin-tarball', 'corpus-releases', 'out']
  for (const name of required) if (!values[name]) throw new Error(`Missing --${name}`)
  const release = await assembleCurrent({
    electronDir: values['electron-dir'], launcher: values.launcher, dshSource: values['dsh-source'],
    plugin: values.plugin, pluginTarball: values['plugin-tarball'], corpusReleases: values['corpus-releases'], out: values.out,
  })
  console.log(`Assembled PRTS Electron Portable: DSH ${release.dshVersion} / ${release.corpusReleaseId}`)
}
