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
import {
  fetchCurrentCorpus,
  resolveTrustedCurrentRelease,
  TRUSTED_CURRENT_URL,
} from '../scripts/fetch-current-corpus.mjs'
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

test('正式构建先校验 PRTS.chat current 语料并传给组装器', () => {
  const root = join(import.meta.dirname, '..')
  const build = readFileSync(join(root, 'build-local.ps1'), 'utf8')
  const workflow = readFileSync(join(root, '.github', 'workflows', 'build-windows.yml'), 'utf8')
  const assemble = readFileSync(join(root, 'scripts', 'assemble.mjs'), 'utf8')
  const versions = JSON.parse(readFileSync(join(root, 'versions.json'), 'utf8'))
  const launcher = readFileSync(join(root, 'src', 'launcher.mjs'), 'utf8')
  const host = readFileSync(join(root, 'desktop', 'DshHost.cs'), 'utf8')
  const window = readFileSync(join(root, 'desktop', 'MainWindow.cs'), 'utf8')
  assert.match(build, /fetch-current-corpus\.mjs/u)
  assert.match(build, /--corpus-releases/u)
  assert.match(workflow, /node scripts\/fetch-current-corpus\.mjs[^]*--out \.build\/corpus\/releases/u)
  assert.match(workflow, /node scripts\/assemble\.mjs[^]*--corpus-releases \.build\/corpus\/releases/u)
  assert.match(workflow, /audit-windows-artifact\.mjs/u)
  assert.ok(workflow.indexOf('node scripts/fetch-current-corpus.mjs')
    < workflow.indexOf('node scripts/assemble.mjs'))
  assert.ok(workflow.indexOf('node scripts/assemble.mjs')
    < workflow.indexOf('audit-windows-artifact.mjs'))
  assert.ok(workflow.indexOf('audit-windows-artifact.mjs')
    < workflow.indexOf('smoke-artifact.mjs'))
  assert.match(assemble, /bundled-verified-corpus/u)
  assert.match(assemble, /prts-agent-corpus-endfield/u)
  assert.match(assemble, /join\(args\.out, 'corpus', 'releases'\)/u)
  assert.match(launcher, /PRTS_CORPUS_RELEASES_DIR/u)
  assert.match(host, /WarnIfCorpusUnavailable/u)
  assert.match(window, /语料需要处理/u)
  const fetchCorpus = readFileSync(join(root, 'scripts', 'fetch-current-corpus.mjs'), 'utf8')
  assert.deepEqual(versions.dsh, { tag: 'dsh-v0.1.3-alpha.1', version: '0.1.3-alpha.1' })
  assert.match(build, /Cached DSH version[^]*Remove \.build\\dsh and rebuild/u)
  assert.match(build, /Assert-NativeBuildTools/u)
  assert.match(build, /Microsoft\.VisualStudio\.Component\.VC\.Tools\.x86\.x64/u)
  assert.match(build, /Desktop development with C\+\+/u)
  assert.deepEqual(versions.corpus, { source: 'prts.chat', track: 'current' })
  assert.match(fetchCorpus, /resolveTrustedCurrentRelease/u)
  assert.match(fetchCorpus, /order: \['modelscope', 'site'\]/u)
  assert.match(fetchCorpus, /Corpus \$\{sourceLabel\}/u)
  assert.match(fetchCorpus, /source=\$\{result\.source \?\? pointer\.channel/u)
  assert.doesNotMatch(fetchCorpus, /resolveModelScopeCurrentRelease/u)
  assert.doesNotMatch(fetchCorpus, /--release|--data-version/u)
  assert.doesNotMatch(build, /patch-dsh-cjk-markdown/u)
  assert.doesNotMatch(build, /status --porcelain/u)
  assert.doesNotMatch(assemble, /commit 不符|未提交改动/u)
})

test('ModelScope 只有 community 发布新目录时仍由 PRTS.chat current 决定完整版本', async () => {
  const releaseId = 'agent-corpus-v2-20260905-character-activity-split-v1'
  const dataVersion = 'a'.repeat(64)
  const packIds = [
    'official_game',
    'endfield_official_game',
    'endfield_reviewed_knowledge',
    'reviewed_wiki',
    'terra_journey',
    'entities',
    'references',
  ]
  const requested = []
  const current = await resolveTrustedCurrentRelease({
    fetchImpl: async (url) => {
      requested.push(url)
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            code: 200,
            data: {
              release_id: releaseId,
              data_version: dataVersion,
              minimum_agent_version: '0.1.0',
              distribution_status: 'published',
              document_count: 31092,
              packs: packIds.map((packId, index) => ({
                pack_id: packId,
                manifest_path: `${packId}/pack-manifest.json`,
                data_version: (index + 1).toString(16).repeat(64),
              })),
              // This is the real partial-publication shape that previously made
              // a lexicographic ModelScope scan select a release absent in two repos.
              mirrors: [{
                provider: 'modelscope',
                repo_id: 'HTiantian/prts-agent-corpus-selfbuilt',
                pack_ids: ['reviewed_wiki', 'terra_journey', 'entities', 'references'],
              }],
            },
          })
        },
      }
    },
  })

  assert.equal(current.releaseId, releaseId)
  assert.equal(current.dataVersion, dataVersion)
  assert.equal(current.minimumAgentVersion, '0.1.0')
  assert.equal(current.distributionStatus, 'published')
  assert.equal(current.packVersions.size, 7)
  assert.deepEqual(requested, [TRUSTED_CURRENT_URL])
  assert.doesNotMatch(requested.join('\n'), /modelscope/u)
})

test('pinned alpha 插件低于 current 稳定版门槛时在下载前失败', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prts-version-gate-test-'))
  const plugin = join(root, 'plugin')
  const marker = join(root, 'ensure-called')
  mkdirSync(join(plugin, 'src'), { recursive: true })
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({
    type: 'module',
    version: '0.1.0-alpha.1',
  }))
  writeFileSync(join(plugin, 'src', 'installer.js'), [
    "import { writeFileSync } from 'node:fs'",
    `export async function ensureCorpusRelease() { writeFileSync(${JSON.stringify(marker)}, '') }`,
    'export async function validateLocalRelease() { throw new Error("unexpected validation") }',
  ].join('\n'))
  const packIds = [
    'official_game', 'endfield_official_game', 'endfield_reviewed_knowledge',
    'reviewed_wiki', 'terra_journey', 'entities', 'references',
  ]
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ code: 200, data: {
        release_id: 'agent-corpus-test',
        data_version: 'a'.repeat(64),
        minimum_agent_version: '0.1.0',
        distribution_status: 'published',
        document_count: 7,
        packs: packIds.map((packId, index) => ({
          pack_id: packId,
          manifest_path: `${packId}/pack-manifest.json`,
          data_version: (index + 1).toString(16).repeat(64),
        })),
      } })
    },
  })
  try {
    await assert.rejects(
      () => fetchCurrentCorpus({ plugin, out: join(root, 'releases') }, { fetchImpl }),
      /至少需要 prts-terrarchive 0\.1\.0[^]*0\.1\.0-alpha\.1/u,
    )
    assert.equal(existsSync(marker), false, 'ensureCorpusRelease 不应被调用')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
