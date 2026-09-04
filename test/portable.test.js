import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mergeProfileManifest,
  parseDshUrl,
  redactToken,
  syncManagedInstall,
} from '../src/portable.mjs'
import { assertWindowsX64Executable } from '../scripts/windows-pe.mjs'

test('解析 alpha.1 Host 启动 URL，并在日志中隐藏 token', () => {
  const line = 'Open http://127.0.0.1:43189/?token=Abc_123-xyz now'
  assert.equal(parseDshUrl(line), 'http://127.0.0.1:43189/?token=Abc_123-xyz')
  assert.equal(redactToken(line), 'Open http://127.0.0.1:43189/?token=[redacted] now')
})

test('合并 profile 时保留第三方 bundle，并固定托管插件', () => {
  const merged = mergeProfileManifest({
    name: 'custom-web',
    dependencies: { example: '1.0.0', 'prts-terrarchive': 'old' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'example', 'prts-terrarchive'] } },
  }, { pluginVersion: '0.1.0-alpha.1' })
  assert.deepEqual(merged.dependencies, {
    example: '1.0.0',
    'prts-terrarchive': '0.1.0-alpha.1',
  })
  assert.deepEqual(merged.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    'example',
    'prts-terrarchive',
  ])
  assert.equal(merged.dsh.profile.patchReload, 'live')
})

test('托管目录仅在发行标记变化时原子替换', () => {
  const root = mkdtempSync(join(tmpdir(), 'prts-managed-test-'))
  const appRoot = join(root, 'app')
  const dataRoot = join(root, 'data')
  const profile = join(appRoot, 'templates', 'profiles', 'web')
  const plugin = join(profile, 'node_modules', 'prts-terrarchive')
  const preset = join(appRoot, 'templates', '.agent-presets', 'prts')
  mkdirSync(plugin, { recursive: true })
  mkdirSync(preset, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    dependencies: { 'prts-terrarchive': '0.1.0-alpha.1' },
  }))
  writeFileSync(join(profile, 'cordis.yml'), 'name: web\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), 'patch: true\n')
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({
    name: 'prts-terrarchive', version: '0.1.0-alpha.1',
  }))
  writeFileSync(join(plugin, 'content.txt'), 'first')
  writeFileSync(join(plugin, '.prts-portable-source.json'), '{"build":"one"}\n')
  writeFileSync(join(preset, 'preset.txt'), 'first')
  writeFileSync(join(preset, '.prts-portable-source.json'), '{"build":"one"}\n')

  try {
    syncManagedInstall({ appRoot, dataRoot })
    const installed = join(dataRoot, 'profiles', 'web', 'node_modules', 'prts-terrarchive')
    writeFileSync(join(installed, 'sentinel.txt'), 'keep when current')
    syncManagedInstall({ appRoot, dataRoot })
    assert.equal(readFileSync(join(installed, 'sentinel.txt'), 'utf8'), 'keep when current')

    writeFileSync(join(plugin, 'content.txt'), 'second')
    writeFileSync(join(plugin, '.prts-portable-source.json'), '{"build":"two"}\n')
    syncManagedInstall({ appRoot, dataRoot })
    assert.equal(readFileSync(join(installed, 'content.txt'), 'utf8'), 'second')
    assert.equal(existsSync(join(installed, 'sentinel.txt')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('拒绝把 Linux ELF 伪装成 Windows node.exe', () => {
  const directory = mkdtempSync(join(tmpdir(), 'prts-pe-test-'))
  const executable = join(directory, 'node.exe')
  const fd = openSync(executable, 'w')
  try {
    writeSync(fd, Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    writeSync(fd, Buffer.alloc(60))
  } finally {
    closeSync(fd)
  }
  try {
    assert.throws(
      () => assertWindowsX64Executable(executable, 'Node.js'),
      /不是 Windows PE 文件/u,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('接受 Windows x64 PE 文件头', () => {
  const directory = mkdtempSync(join(tmpdir(), 'prts-pe-test-'))
  const executable = join(directory, 'node.exe')
  const header = Buffer.alloc(70)
  header.write('MZ', 0, 'ascii')
  header.writeUInt32LE(64, 0x3c)
  header.write('PE\0\0', 64, 'binary')
  header.writeUInt16LE(0x8664, 68)
  const fd = openSync(executable, 'w')
  try {
    writeSync(fd, header)
  } finally {
    closeSync(fd)
  }
  try {
    assert.doesNotThrow(() => assertWindowsX64Executable(executable, 'Node.js'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('无边框桌面外壳提供可拖动标题区与八方向缩放', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'desktop', 'MainWindow.cs'), 'utf8')
  assert.match(source, /#prts-desktop-drag[^]*height: 38px/u)
  assert.match(source, /\['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'\]/u)
  assert.match(source, /post\('resize:' \+ edge\)/u)
  assert.match(source, /action\.StartsWith\("resize:"/u)
  for (const hitTest of ['HtTop', 'HtBottom', 'HtLeft', 'HtRight',
    'HtTopLeft', 'HtTopRight', 'HtBottomLeft', 'HtBottomRight']) {
    assert.ok(source.includes(`=> ${hitTest}`), `缺少 ${hitTest} 缩放映射`)
  }
})

test('窗口进入后台时暂停地图并挂起 WebView2，且记录分进程内存', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'desktop', 'MainWindow.cs'), 'utf8')
  assert.match(source, /RequestBackgroundMode\(true\);[^]*Hide\(\);/u)
  assert.match(source, /await core\.TrySuspendAsync\(\)/u)
  assert.match(source, /if \(core\.IsSuspended\) core\.Resume\(\)/u)
  assert.match(source, /prts-shell-visibility/u)
  assert.match(source, /browserEnvironment\.GetProcessInfos\(\)/u)
  assert.match(source, /Memory\[\{reason\}\]/u)
})

test('正式构建固定 ModelScope 语料并在缺失时给出桌面提示', () => {
  const root = join(import.meta.dirname, '..')
  const build = readFileSync(join(root, 'build-local.ps1'), 'utf8')
  const assemble = readFileSync(join(root, 'scripts', 'assemble.mjs'), 'utf8')
  const versions = JSON.parse(readFileSync(join(root, 'versions.json'), 'utf8'))
  const launcher = readFileSync(join(root, 'src', 'launcher.mjs'), 'utf8')
  const host = readFileSync(join(root, 'desktop', 'DshHost.cs'), 'utf8')
  const window = readFileSync(join(root, 'desktop', 'MainWindow.cs'), 'utf8')
  assert.match(build, /fetch-modelscope-corpus\.mjs/u)
  assert.match(build, /--corpus-releases/u)
  assert.match(assemble, /bundled-modelscope-corpus/u)
  assert.match(assemble, /prts-agent-corpus-endfield/u)
  assert.match(assemble, /join\(args\.out, 'corpus', 'releases'\)/u)
  assert.match(launcher, /PRTS_CORPUS_RELEASES_DIR/u)
  assert.match(host, /WarnIfCorpusUnavailable/u)
  assert.match(window, /语料需要处理/u)
  const fetchCorpus = readFileSync(join(root, 'scripts', 'fetch-modelscope-corpus.mjs'), 'utf8')
  assert.equal(versions.corpus.track, 'latest')
  assert.match(fetchCorpus, /resolveModelScopeCurrentRelease/u)
  assert.doesNotMatch(fetchCorpus, /--release|--data-version/u)
  assert.doesNotMatch(build, /patch-dsh-cjk-markdown/u)
  assert.doesNotMatch(build, /status --porcelain/u)
  assert.doesNotMatch(assemble, /commit 不符|未提交改动/u)
})
