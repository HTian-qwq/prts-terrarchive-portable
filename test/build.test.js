import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fetchCurrentCorpus, TRUSTED_CURRENT_URL } from '../scripts/fetch-current-corpus.mjs'
import { packageCurrentCorpus } from '../scripts/corpus-artifact.mjs'

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'prts-build-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function put(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'object' ? JSON.stringify(value) : value)
}

const hash = (value) => createHash('sha256').update(value).digest('hex')

function corpusFixture(t) {
  const root = temporaryRoot(t)
  const releasesDir = join(root, 'cache')
  const targetDir = join(root, 'artifact')
  const releaseId = 'selected-release'
  const manifest = { release_id: releaseId, data_version: 'a'.repeat(64), document_count: 1 }
  const pointer = { release_id: releaseId, data_version: manifest.data_version }
  const files = {
    'shards/00000.jsonl.gz': 'verified shard',
    'search-index/00000.bin.gz': 'verified index',
    'catalog/documents.jsonl.gz': 'verified catalog',
  }
  const asset = (path) => ({ path, sha256: hash(files[path]) })
  const pack = { shards: [asset('shards/00000.jsonl.gz')],
    search_index: { shards: [asset('search-index/00000.bin.gz')] },
    document_catalog: asset('catalog/documents.jsonl.gz') }
  put(join(releasesDir, 'current.json'), pointer)
  put(join(releasesDir, releaseId, 'release-manifest.json'), manifest)
  put(join(releasesDir, releaseId, 'official_game/pack-manifest.json'), pack)
  for (const [path, value] of Object.entries(files)) put(join(releasesDir, releaseId, 'official_game', path), value)
  let locked = false
  const validations = []
  // 安装器替身只负责已有的锁和 SHA 校验接口，封装文件选择由被测模块完成。
  const installer = {
    async withReleaseMutationLock(path, operation) {
      assert.equal(path, releasesDir)
      locked = true
      try { return await operation() } finally { locked = false }
    },
    async readCurrentReleasePointer(path) {
      assert.equal(locked, true)
      return JSON.parse(readFileSync(join(path, 'current.json'), 'utf8'))
    },
    async validateLocalRelease(path, requested, options) {
      assert.equal(locked, true)
      assert.equal(requested, releaseId)
      assert.equal(options.verifyHashes, true)
      validations.push(path)
      for (const [file, bytes] of Object.entries(files)) {
        assert.equal(hash(readFileSync(join(path, releaseId, 'official_game', file))), hash(bytes),
          '不得封装或激活哈希不匹配的分片')
      }
      assert.deepEqual(JSON.parse(readFileSync(join(path, releaseId, 'release-manifest.json'))), manifest)
      assert.deepEqual(JSON.parse(readFileSync(join(path, releaseId, 'official_game/pack-manifest.json'))), pack)
      return options.details ? { manifest, packManifests: new Map([['official_game', pack]]),
        releaseDir: join(path, releaseId) } : manifest
    },
  }
  return { releasesDir, targetDir, releaseId, manifest, pointer, files, installer, validations }
}

function relativeFiles(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    return entry.isDirectory() ? relativeFiles(root, path) : [path]
  }).sort()
}

test('语料发行只收录当前清单资产，排除旧版本、失败下载和 release 内部残留', async (t) => {
  const fixture = corpusFixture(t)
  const { releasesDir, targetDir, releaseId, manifest, pointer, files, validations } = fixture
  for (const path of ['old-release/shards/old.gz', 'failed-release/download.tmp',
    '.release-mutation-locks/old-lease', `${releaseId}/release-manifest.json.stale.tmp`,
    `${releaseId}/official_game/shards/00001.jsonl.gz`,
    `${releaseId}/official_game/search-index/partial.tmp`]) put(join(releasesDir, path), 'unlisted')
  const result = await packageCurrentCorpus(fixture)
  assert.deepEqual(result, { pointer, manifest })
  assert.deepEqual(relativeFiles(targetDir), ['current.json', `${releaseId}/release-manifest.json`,
    `${releaseId}/official_game/pack-manifest.json`,
    ...Object.keys(files).map((file) => `${releaseId}/official_game/${file}`)].sort())
  assert.deepEqual(validations, [releasesDir, targetDir], '来源和成品都必须逐文件校验')
  assert.deepEqual(JSON.parse(readFileSync(join(targetDir, 'current.json'))), pointer)
})

test('来源校验失败或指针不一致时不能产出可激活的 current', async (t) => {
  for (const corruptPointer of [false, true]) {
    const fixture = corpusFixture(t)
    if (corruptPointer) put(join(fixture.releasesDir, 'current.json'), {
      ...fixture.pointer, data_version: 'b'.repeat(64),
    })
    else put(join(fixture.releasesDir, fixture.releaseId, 'official_game/shards/00000.jsonl.gz'), 'corrupt')
    await assert.rejects(() => packageCurrentCorpus(fixture))
    assert.equal(existsSync(join(fixture.targetDir, 'current.json')), false)
  }
})

test('拒绝非空发行目标，避免沿用先前构建的残留文件', async (t) => {
  const fixture = corpusFixture(t)
  put(join(fixture.targetDir, 'old.tmp'), 'leftover')
  await assert.rejects(() => packageCurrentCorpus(fixture), /目标目录必须为空/u)
  assert.equal(readFileSync(join(fixture.targetDir, 'old.tmp'), 'utf8'), 'leftover')
})

test('current 发布切换时沿用同一次 HTTP 快照，不再次联网选版', async (t) => {
  const root = temporaryRoot(t)
  const plugin = join(root, 'plugin')
  put(join(plugin, 'package.json'), { type: 'module', version: '0.1.0' })
  put(join(plugin, 'src/installer.js'), `
    import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
    import { join } from 'node:path'
    const snapshots = new WeakMap()
    export async function resolveTrustedCurrentRelease({ fetchImpl }) {
      const data = (await (await fetchImpl(${JSON.stringify(TRUSTED_CURRENT_URL)})).json()).data
      const handle = Object.freeze({ releaseId: data.release_id })
      snapshots.set(handle, data)
      return handle
    }
    export async function ensureCorpusRelease(options) {
      const handle = snapshots.has(options.trustedCurrent) ? options.trustedCurrent
        : await resolveTrustedCurrentRelease({ fetchImpl: options.fetchImpl })
      const data = snapshots.get(handle)
      if (data.release_id !== options.releaseId) throw new Error('RELEASE_NOT_CURRENT')
      mkdirSync(join(options.releasesDir, data.release_id), { recursive: true })
      const manifest = { release_id: data.release_id, data_version: data.data_version,
        document_count: data.document_count }
      writeFileSync(join(options.releasesDir, 'current.json'), JSON.stringify(manifest))
      writeFileSync(join(options.releasesDir, data.release_id, 'release-manifest.json'), JSON.stringify(manifest))
      for (const pack of data.packs) {
        mkdirSync(join(options.releasesDir, data.release_id, pack.pack_id), { recursive: true })
        writeFileSync(join(options.releasesDir, data.release_id, pack.manifest_path), JSON.stringify(pack))
      }
      return { status: 'downloaded', source: 'site' }
    }
    export async function validateLocalRelease(root, releaseId, options) {
      if (!options.verifyHashes) throw new Error('Missing hash verification')
      return JSON.parse(readFileSync(join(root, releaseId, 'release-manifest.json'), 'utf8'))
    }
  `)
  const packIds = ['official_game', 'endfield_official_game', 'endfield_reviewed_knowledge',
    'reviewed_wiki', 'terra_journey', 'entities', 'references']
  let currentRequests = 0
  const result = await fetchCurrentCorpus({ plugin, out: join(root, 'releases') }, {
    fetchImpl: async (url) => {
      assert.equal(String(url), TRUSTED_CURRENT_URL)
      currentRequests += 1
      return new Response(JSON.stringify({ code: 200, data: {
        release_id: currentRequests === 1 ? 'release-A' : 'release-B',
        data_version: (currentRequests === 1 ? 'a' : 'b').repeat(64),
        minimum_agent_version: '0.1.0', distribution_status: 'published', document_count: 7,
        packs: packIds.map((pack_id) => ({ pack_id, manifest_path: `${pack_id}/pack-manifest.json`,
          data_version: 'c'.repeat(64) })),
      } }))
    },
  })
  assert.equal(currentRequests, 1)
  assert.equal(result.manifest.release_id, 'release-A')
  assert.equal(result.current.dataVersion, 'a'.repeat(64))
})

function workflowStep(name) {
  const workflow = readFileSync(new URL('../.github/workflows/build-windows.yml', import.meta.url), 'utf8')
    .replaceAll('\r\n', '\n')
  const block = workflow.split('      - name: ').find((part) => part.startsWith(`${name}\n`))
  const lines = block.split('\n')
  const start = lines.indexOf('        run: |') + 1
  return lines.slice(start).filter((line) => line.startsWith('          '))
    .map((line) => line.slice(10)).join('\n')
}

const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`
for (const [step, failure, expectedPrograms] of [
  ['Check portable builder and plugin', 'npm test', ['npm', 'npm']],
  ['Install and build official DSH', 'pnpm install', ['pnpm']],
  ['Deploy official locked DSH runtime closure', 'pnpm --config.node-linker=hoisted', ['pnpm', 'git']],
  ['Publish desktop executable', 'dotnet restore', ['dotnet']],
]) {
  test(`CI 原生命令失败必须终止步骤：${step}`, { skip: process.platform !== 'win32' }, (t) => {
    const root = temporaryRoot(t)
    mkdirSync(join(root, '.build/plugin'), { recursive: true })
    const commandsLog = join(root, 'commands.jsonl')
    const stub = join(root, 'native-command.mjs')
    put(stub, `
      import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
      const args = process.argv.slice(2)
      appendFileSync(process.env.PRTS_COMMANDS_LOG, JSON.stringify(args) + '\\n')
      if (args.slice(0, 2).join(' ') === process.env.PRTS_FAIL_COMMAND) process.exit(9)
      if (args[0] === 'dotnet' && args[1] === 'publish') {
        mkdirSync('.build/desktop', { recursive: true })
        writeFileSync('.build/desktop/PRTS Terrarchive.exe', '')
      }
    `)
    const run = workflowStep(step).replace(/^(\s*)(npm|pnpm|git|dotnet)(?=\s)/gmu,
      (_, spaces, program) => `${spaces}& ${psQuote(process.execPath)} ${psQuote(stub)} ${psQuote(program)}`)
    const script = join(root, 'workflow-step.ps1')
    put(script, `$ErrorActionPreference = 'Stop'\n${run}\n`
      + 'if ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }\n')
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script], {
      cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_WORKSPACE: root,
        PRTS_COMMANDS_LOG: commandsLog, PRTS_FAIL_COMMAND: failure },
    })
    assert.ifError(result.error)
    assert.notEqual(result.status, 0, result.stdout)
    const called = readFileSync(commandsLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line)[0])
    assert.deepEqual(called, expectedPrograms, '只能执行失败前的命令及必要的 finally 清理')
  })
}
