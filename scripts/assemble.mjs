import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertWindowsX64Executable } from './windows-pe.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const versions = JSON.parse(readFileSync(join(repositoryRoot, 'versions.json'), 'utf8'))

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value) throw new Error(`无效参数：${key ?? ''}`)
    result[key.slice(2)] = resolve(value)
  }
  for (const required of ['dsh-deploy', 'dsh-source', 'plugin', 'corpus-releases',
    'node-dir', 'desktop-exe', 'out']) {
    if (!result[required]) throw new Error(`缺少 --${required}`)
  }
  return result
}

function assertBuildOutput(path) {
  const relativePath = relative(repositoryRoot, path)
  if (!relativePath || relativePath.startsWith('..') || basename(path).length < 8) {
    throw new Error(`输出目录必须位于本仓库内：${path}`)
  }
}

function copyPackage(source, target) {
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  mkdirSync(target, { recursive: true })
  cpSync(join(source, 'package.json'), join(target, 'package.json'))
  for (const entry of manifest.files ?? []) {
    const from = join(source, entry)
    if (!existsSync(from)) throw new Error(`插件发布文件不存在：${entry}`)
    cpSync(from, join(target, entry), { recursive: true, dereference: true })
  }
  return manifest
}

function materializeLinks(root) {
  let count = 0
  const visit = (path) => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      const source = realpathSync(path)
      rmSync(path, { force: true })
      cpSync(source, path, { recursive: true, dereference: true })
      count += 1
      return
    }
    if (!stat.isDirectory()) return
    for (const entry of readdirSync(path)) visit(join(path, entry))
  }
  visit(root)
  return count
}

const args = parseArgs(process.argv.slice(2))
assertBuildOutput(args.out)
for (const [label, path] of Object.entries(args)) {
  if (label !== 'out' && !existsSync(path)) throw new Error(`${label} 不存在：${path}`)
}

const dshPackageDir = join(args['dsh-deploy'], 'node_modules', '@deepseek-ai', 'dsh')
const dshManifest = JSON.parse(readFileSync(join(dshPackageDir, 'package.json'), 'utf8'))
if (dshManifest.name !== '@deepseek-ai/dsh' || dshManifest.version !== versions.dsh.version) {
  throw new Error(`DSH 部署版本不符：${dshManifest.name}@${dshManifest.version}`)
}
const actualCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: args['dsh-source'], encoding: 'utf8',
}).trim()
if (actualCommit !== versions.dsh.commit) {
  throw new Error(`DSH commit 不符：期望 ${versions.dsh.commit}，实际 ${actualCommit}`)
}
const pluginCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: args.plugin, encoding: 'utf8',
}).trim()
const pluginDirty = execFileSync('git', ['status', '--short'], {
  cwd: args.plugin, encoding: 'utf8',
}).trim().length > 0
const sourceNodeExecutable = join(args['node-dir'], 'node.exe')
if (!existsSync(sourceNodeExecutable)) throw new Error('Node.js 目录中缺少 node.exe。')
assertWindowsX64Executable(sourceNodeExecutable, '待打包的 Node.js')
const desktopExeName = 'PRTS Terrarchive.exe'
let desktopExeSource = args['desktop-exe']
let desktopBundleDir = null
if (lstatSync(desktopExeSource).isDirectory()) {
  desktopBundleDir = desktopExeSource
  desktopExeSource = join(desktopBundleDir, desktopExeName)
  if (!existsSync(desktopExeSource)) throw new Error(`桌面发布目录中缺少 ${desktopExeName}。`)
}
assertWindowsX64Executable(desktopExeSource, 'PRTS Terrarchive 桌面程序')

rmSync(args.out, { recursive: true, force: true })
mkdirSync(args.out, { recursive: true })
cpSync(args['dsh-deploy'], join(args.out, 'runtime', 'dsh'), {
  recursive: true,
  dereference: true,
})
cpSync(args['node-dir'], join(args.out, 'runtime', 'node'), {
  recursive: true,
  dereference: true,
})
mkdirSync(join(args.out, 'corpus'), { recursive: true })
cpSync(args['corpus-releases'], join(args.out, 'corpus', 'releases'), {
  recursive: true,
  dereference: true,
})
mkdirSync(join(args.out, 'app'), { recursive: true })
for (const file of ['portable.mjs', 'launcher.mjs']) {
  cpSync(join(repositoryRoot, 'src', file), join(args.out, 'app', file))
}
if (desktopBundleDir) {
  for (const entry of readdirSync(desktopBundleDir)) {
    cpSync(join(desktopBundleDir, entry), join(args.out, entry), { recursive: true, dereference: true })
  }
} else {
  cpSync(desktopExeSource, join(args.out, desktopExeName))
}
cpSync(join(repositoryRoot, 'templates', 'README-PORTABLE.txt'), join(args.out, '使用说明.txt'))

const profileDir = join(args.out, 'templates', 'profiles', 'web')
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
for (const file of ['cordis.yml', 'cordis.patch.yml']) {
  cpSync(join(repositoryRoot, 'templates', 'profile', file), join(profileDir, file))
}
const pluginDir = join(profileDir, 'node_modules', 'prts-terrarchive')
const pluginManifest = copyPackage(args.plugin, pluginDir)
const managedBuildId = pluginDirty
  ? `${pluginCommit}-dirty-${Date.now()}`
  : pluginCommit
const managedSourceMarker = `${JSON.stringify({
  pluginVersion: pluginManifest.version,
  pluginCommit,
  managedBuildId,
}, null, 2)}\n`
writeFileSync(join(pluginDir, '.prts-portable-source.json'), managedSourceMarker)
writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dependencies: {
    'prts-terrarchive': pluginManifest.version,
  },
  dsh: {
    profile: {
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        'prts-terrarchive',
      ],
      patchReload: 'live',
    },
  },
}, null, 2)}\n`)

execFileSync(process.execPath, [join(args.plugin, 'bin', 'install.js'), 'web', '--preset-only'], {
  cwd: args.plugin,
  env: { ...process.env, DSH_HOME: join(args.out, 'templates') },
  stdio: 'inherit',
})
writeFileSync(
  join(args.out, 'templates', '.agent-presets', 'prts', '.prts-portable-source.json'),
  managedSourceMarker,
)

const licensesDir = join(args.out, 'LICENSES')
mkdirSync(licensesDir, { recursive: true })
cpSync(join(repositoryRoot, 'LICENSE'), join(licensesDir, 'PRTS-Terrarchive-Portable-MIT.txt'))
cpSync(join(args['dsh-source'], 'LICENSE'), join(licensesDir, 'DeepSeek-Harness-MIT.txt'))
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'GAME_ASSETS.md']) {
  cpSync(join(args.plugin, file), join(licensesDir, `prts-terrarchive-${file}`))
}
writeFileSync(join(licensesDir, 'NOTICE.txt'), [
  'PRTS Terrarchive Portable is an independent community distribution.',
  'DeepSeek Harness and prts-terrarchive remain governed by their respective notices.',
  'The bundled corpus was fetched from the pinned ModelScope datasets at build time.',
  'Corpus data is not licensed under this distribution\'s MIT License and remains subject',
  'to the source declarations and terms on the corresponding ModelScope dataset pages:',
  'https://modelscope.cn/datasets/HTiantian/prts-agent-corpus-arknights-gamedata',
  'https://modelscope.cn/datasets/HTiantian/prts-agent-corpus-selfbuilt',
  'Arknights and Endfield names, images, models, textures, and other game materials are',
  'not licensed under MIT. See prts-terrarchive-GAME_ASSETS.md for the exact boundary.',
  '',
].join('\n'))

writeFileSync(join(args.out, 'release-manifest.json'), `${JSON.stringify({
  portableVersion: versions.portable,
  desktopFramework: versions.desktop.framework,
  webView2SdkVersion: versions.desktop.webView2Sdk,
  nodeVersion: versions.node,
  pnpmVersion: versions.pnpm,
  dshVersion: dshManifest.version,
  dshCommit: actualCommit,
  dshCompatibilityPatches: versions.dsh.compatibilityPatches ?? [],
  pluginVersion: pluginManifest.version,
  pluginCommit,
  pluginDirty,
  corpusSource: versions.corpus.source,
  corpusReleaseId: versions.corpus.releaseId,
  corpusDataVersion: versions.corpus.dataVersion,
  features: ['prts-agent-live-retrieval-scene', 'readable-title-pagination',
    'bundled-modelscope-corpus'],
  platform: 'win32-x64',
}, null, 2)}\n`)

const nodeExecutable = join(args.out, 'runtime', 'node', 'node.exe')
const dshEntry = join(
  args.out, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!existsSync(nodeExecutable) || !existsSync(dshEntry)) {
  throw new Error('组装后的 Node 或 DSH 入口缺失。')
}
assertWindowsX64Executable(nodeExecutable, '组装后的 Node.js')
chmodSync(join(args.out, 'app', 'launcher.mjs'), 0o755)
const materializedLinks = materializeLinks(args.out)
if (materializedLinks) console.log(`已实体化 ${materializedLinks} 个运行时链接。`)
console.log(`已组装 ${args.out}`)
