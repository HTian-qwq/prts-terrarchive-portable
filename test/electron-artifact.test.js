import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { assemble } from '../scripts/assemble-electron.mjs'
import { auditElectronArtifact, electronVersions, inspectElectronInput } from '../scripts/audit-electron-artifact.mjs'
import { createPortableBuilderConfig } from '../electron/builder-config.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const explicitPlugin = process.env.PRTS_PLUGIN_TEST_ROOT?.trim()
const pluginRoot = (explicitPlugin ? [resolve(explicitPlugin)] : [resolve(repositoryRoot, '../prts-terrarchive'), join(repositoryRoot, '.build/plugin')])
  .find((path) => existsSync(join(path, 'src/installer.js')) && existsSync(join(path, 'presets/register.js')))
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding)
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
function put(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value, null, 2) + '\n' : value)
}
function files(root, prefix = '') {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? files(join(root, entry.name), prefix + entry.name + '/') : [prefix + entry.name]).sort()
}
function seal(seed) {
  put(join(seed, 'integrity.json'), { schemaVersion: 2, files: files(seed).filter((path) => path !== 'integrity.json')
    .map((path) => { const bytes = readFileSync(join(seed, path)); return { path, bytes: bytes.length, sha256: digest(bytes) } }) })
}
function pe(machine = 0x8664) {
  const bytes = Buffer.alloc(128)
  bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(machine, 68)
  return bytes
}
function asar(versions, { omit, main = 'portable-main.mjs', invalidOffset } = {}) {
  const contents = {
    'package.json': JSON.stringify({ version: versions.dsh.version, main,
      prtsPortable: { version: versions.portable, appId: versions.appId } }),
    'portable-main.mjs': 'import("./lib/main.js")', 'lib/main.js': 'export {}',
    'lib/preload.cjs': 'module.exports = {}', 'lib/preload-app.cjs': 'module.exports = {}',
    'renderer/plugin-manager.html': '<main></main>', 'renderer/plugin-manager.js': '// fixture',
    'renderer/plugin-manager.css': 'body{}',
  }
  delete contents[omit]
  const header = { files: {} }; const payload = []; let offset = 0
  for (const [path, value] of Object.entries(contents)) {
    const bytes = Buffer.from(value); const parts = path.split('/'); const leaf = parts.pop()
    let parent = header
    for (const part of parts) parent = parent.files[part] ??= { files: {} }
    parent.files[leaf] = { size: bytes.length, offset: path === invalidOffset ? '999999999' : String(offset) }
    payload.push(bytes); offset += bytes.length
  }
  const encoded = Buffer.from(JSON.stringify(header))
  const headerPickle = Buffer.alloc(8 + Math.ceil(encoded.length / 4) * 4)
  headerPickle.writeUInt32LE(headerPickle.length - 4, 0); headerPickle.writeUInt32LE(encoded.length, 4); encoded.copy(headerPickle, 8)
  const sizePickle = Buffer.alloc(8); sizePickle.writeUInt32LE(4, 0); sizePickle.writeUInt32LE(headerPickle.length, 4)
  return Buffer.concat([sizePickle, headerPickle, ...payload])
}
function tarball(root, packageRoot, name) {
  const target = join(root, name + '.tgz')
  execFileSync('tar', ['-czf', target, '-C', dirname(packageRoot), 'package'])
  const bytes = readFileSync(target)
  return { target, bytes, sha256: digest(bytes), integrity: `sha512-${digest(bytes, 'sha512', 'base64')}` }
}
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value)

function corpusFixture(root, pluginVersion) {
  const packIds = ['official_game', 'endfield_official_game', 'endfield_reviewed_knowledge', 'reviewed_wiki', 'terra_journey', 'entities', 'references']
  const plain = Buffer.from('{"fixture":"offline corpus"}\n'); const bytes = gzipSync(plain)
  const packManifests = packIds.map((pack_id, index) => ({
    algorithm: 'prts-browser-corpus-pack-v1', schema_version: 1, pack_id, authority: 'official',
    data_version: String(index + 1).repeat(64), document_count: 1, line_count: 1,
    compressed_size: bytes.length, uncompressed_size: plain.length,
    shards: [{ path: 'shards/00000.jsonl.gz', sha256: digest(bytes), compressed_size: bytes.length, uncompressed_size: plain.length }],
  }))
  const dataVersion = digest(canonical({ compiler_version: 'fixture', source_snapshot: 'fixture',
    packs: packManifests.map((pack) => ({ pack_id: pack.pack_id, data_version: pack.data_version, authority: pack.authority,
      shards: pack.shards.map(({ path, sha256 }) => ({ path, sha256 })), search_index_shards: [] })) }))
  const manifest = { algorithm: 'prts-browser-corpus-release-v1', schema_version: 1, release_id: 'release-A',
    data_version: dataVersion, corpus_version: dataVersion, content_tree_sha256: dataVersion,
    compiler_version: 'fixture', source_update_id: 'local-snapshot:fixture', minimum_agent_version: pluginVersion,
    required_packs: packIds, packs: packManifests.map((pack) => ({ pack_id: pack.pack_id,
      manifest_path: `${pack.pack_id}/pack-manifest.json`, authority: pack.authority, data_version: pack.data_version,
      document_count: 1, line_count: 1, compressed_size: bytes.length, uncompressed_size: plain.length, shard_count: 1 })),
    document_count: 7, line_count: 7, compressed_size: bytes.length * 7, uncompressed_size: plain.length * 7 }
  put(join(root, 'current.json'), { release_id: 'release-A', data_version: dataVersion })
  put(join(root, 'release-A/release-manifest.json'), manifest)
  for (const pack of packManifests) {
    put(join(root, 'release-A', pack.pack_id, 'pack-manifest.json'), pack)
    put(join(root, 'release-A', pack.pack_id, 'shards/00000.jsonl.gz'), bytes)
  }
  put(join(root, 'old-release/old-data'), 'history must not ship')
  put(join(root, 'release-A/official_game/shards/residue.tmp'), 'residue must not ship')
}

function fixture(t) {
  assert.ok(pluginRoot, 'Set PRTS_PLUGIN_TEST_ROOT to the compatible plugin source')
  const root = mkdtempSync(join(tmpdir(), 'prts-electron-资料 '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const versions = structuredClone(electronVersions)
  const dshSource = join(root, 'dsh'); const plugin = join(root, 'plugin-source'); const electronDir = join(root, 'win-unpacked')
  put(join(dshSource, 'package.json'), { version: versions.dsh.version })
  put(join(dshSource, 'apps/desktop/package.json'), { version: versions.dsh.version, devDependencies: { electron: '^' + versions.electron } })
  put(join(dshSource, 'LICENSE'), 'MIT fixture')
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) {
    execFileSync('git', args, { cwd: dshSource, stdio: 'pipe' })
  }
  versions.dsh.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dshSource, encoding: 'utf8' }).trim()
  // Real package installer/compatibility code validates our seven tiny gzip packs.
  const packageRoot = join(root, 'npm/package')
  for (const name of ['src/installer.js', 'src/release-compatibility.js', 'package.json', 'cordis.patch.yml',
    'presets/register.js', 'presets/prts/preset.yml', 'presets/prts/agent.cordis.yml', 'skills/prts-retrieval/SKILL.md',
    'LICENSE', 'THIRD_PARTY_NOTICES.md', 'GAME_ASSETS.md']) {
    put(join(packageRoot, name), readFileSync(join(pluginRoot, name)))
  }
  for (const name of ['src/index.js', 'src/skill.js', 'lib/client.js', 'lib/endfield-map/fixture.js']) put(join(packageRoot, name), 'export {}\n')
  cpSync(packageRoot, plugin, { recursive: true, filter: () => true })
  const pluginPackage = json(join(plugin, 'package.json'))
  const seed = join(electronDir, 'resources/seed')
  const pluginTar = tarball(root, packageRoot, 'prts')
  const pluginFile = `prts-terrarchive-${pluginTar.sha256}.tgz`
  const pluginRecord = { name: 'prts-terrarchive', version: pluginPackage.version, file: pluginFile,
    bytes: pluginTar.bytes.length, integrity: pluginTar.integrity }
  put(join(seed, 'desktop-packages', pluginFile), pluginTar.bytes)
  const coreRecords = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host'].map((name, index) => {
    const corePackage = join(root, `core-${index}/package`)
    put(join(corePackage, 'package.json'), { name, version: versions.dsh.version })
    const packed = tarball(root, corePackage, `core-${index}`); const file = `core-${index}.tgz`
    put(join(seed, 'desktop-packages', file), packed.bytes)
    return { name, version: versions.dsh.version, file, bytes: packed.bytes.length, integrity: packed.integrity }
  })
  const records = { schemaVersion: 1, packages: [pluginRecord] }
  put(join(seed, 'prts-seed.json'), { schemaVersion: 1, revision: digest(JSON.stringify(records)), packages: records.packages })
  put(join(seed, 'desktop-packages.json'), { schemaVersion: 1, packages: coreRecords })
  put(join(seed, 'desktop-release.json'), { schemaVersion: 1, version: versions.dsh.version, hostProtocolVersion: 1,
    nodeVersion: versions.node, pnpmVersion: versions.pnpm })
  put(join(seed, 'package.json'), { private: true, dependencies: Object.fromEntries([...coreRecords, pluginRecord]
    .map((record) => [record.name, `file:./desktop-packages/${record.file}`])),
    dsh: { profile: { bundles: ['@deepseek-ai/dsh', 'prts-terrarchive'] } } })
  put(join(seed, 'pnpm-workspace.yaml'), 'packages: []\n')
  put(join(seed, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\n# fixture local ref: ${pluginFile}\n`)
  put(join(seed, 'store-archives.json'), { schemaVersion: 1, shardCount: 16, archives: [{ file: 'store-00.tar', entries: 1 }] })
  put(join(root, 'store/v11/files/fixture'), 'offline content-addressed payload fixture')
  mkdirSync(join(seed, 'store-archives'), { recursive: true })
  execFileSync('tar', ['-cf', join(seed, 'store-archives/store-00.tar'), '-C', join(root, 'store'), 'v11/files/fixture'])
  seal(seed)
  put(join(electronDir, `${versions.productName}.exe`), pe())
  put(join(electronDir, 'resources/runtime/node/node.exe'), pe())
  put(join(electronDir, 'resources/native/runtime.node'), pe())
  put(join(electronDir, 'resources/runtime/node/LICENSE'), 'Node license fixture')
  put(join(electronDir, 'resources/runtime/pnpm/package.json'), { version: versions.pnpm })
  put(join(electronDir, 'resources/runtime/pnpm/bin/pnpm.mjs'), '// fixture')
  put(join(electronDir, 'resources/runtime/versions.json'), { node: versions.node, pnpm: versions.pnpm })
  put(join(electronDir, 'resources/app.asar'), asar(versions))
  put(join(electronDir, 'LICENSE.electron.txt'), 'Electron license fixture')
  put(join(electronDir, 'LICENSES.chromium.html'), '<html>Chromium license fixture</html>')
  const corpusReleases = join(root, 'corpus-source'); corpusFixture(corpusReleases, pluginPackage.version)
  return { root, versions, seed, pluginFile, options: { electronDir, dshSource, plugin, corpusReleases, out: join(root, '中文 output') } }
}

test('Electron assembly preserves current seven packs and hashes the offline plugin, including Unicode paths', {
  skip: !explicitPlugin && !pluginRoot ? 'Compatible plugin source is unavailable' : false,
}, async (t) => {
  const { versions, options } = fixture(t)
  const manifest = await assemble(options, { versions })
  assert.equal(manifest.corpusDocumentCount, 7)
  assert.equal(manifest.corpusReleaseId, 'release-A')
  assert.equal(manifest.dshVersion, versions.dsh.version)
  assert.equal(manifest.dshCommit, versions.dsh.commit)
  assert.match(manifest.pluginSha256, /^[a-f0-9]{64}$/u)
  assert.deepEqual(readdirSync(join(options.out, 'corpus/releases')).sort(), ['current.json', 'release-A'])
  assert.equal(existsSync(join(options.out, 'corpus/releases/release-A/official_game/shards/residue.tmp')), false)
  assert.equal(existsSync(join(options.out, 'userdata')), false)
  assert.equal((await auditElectronArtifact(options.out, { versions })).nativeModules, 1)
  assert.equal(existsSync(join(options.corpusReleases, 'old-release/old-data')), true)
  assert.equal(existsSync(join(options.corpusReleases, 'release-A/official_game/shards/residue.tmp')), true)
  put(join(options.out, 'userdata/preserve.txt'), 'user data')
  await assert.rejects(assemble(options, { versions }), /拒绝覆盖/u)
  assert.equal(readFileSync(join(options.out, 'userdata/preserve.txt'), 'utf8'), 'user data')
  await assert.rejects(assemble({ ...options, out: join(options.plugin, 'output') }, { versions }), /重叠/u)
})

test('Windows packaging removes pnpm foreign bindings while retaining its x64 runtime and strict native audit', { skip: !pluginRoot }, (t) => {
  const { versions, options } = fixture(t)
  const appRoot = join(options.dshSource, 'apps/desktop')
  const prepared = join(appRoot, '.desktop-build/targets/win-x64/runtime/pnpm/dist/node_modules/@reflink')
  const packaged = join(options.electronDir, 'resources/runtime/pnpm/dist/node_modules/@reflink')
  const bindings = {
    'reflink-darwin-arm64/reflink.darwin-arm64.node': Buffer.alloc(128, 0xcf),
    'reflink-darwin-x64/reflink.darwin-x64.node': Buffer.alloc(128, 0xcf),
    'reflink-win32-arm64-msvc/reflink.win32-arm64-msvc.node': pe(0xaa64),
    'reflink-win32-x64-msvc/reflink.win32-x64-msvc.node': pe(),
    'reflink/index.js': '// shared platform loader',
  }
  for (const [name, content] of Object.entries(bindings)) put(join(prepared, name), content)
  cpSync(prepared, packaged, { recursive: true, filter: () => true })
  const inspect = () => inspectElectronInput(options.electronDir, { versions })
  assert.throws(inspect, /不是 Windows PE/u, 'reproduce the mixed-platform pnpm package failure')
  const config = createPortableBuilderConfig({ portableRoot: repositoryRoot, appRoot, output: dirname(options.electronDir) })
  for (let attempt = 0; attempt < 2; attempt++) {
    config.afterPack({ appOutDir: options.electronDir })
    assert.equal(inspect().nativeModules, 2)
    assert.deepEqual(readdirSync(packaged).sort(), ['reflink', 'reflink-win32-x64-msvc'])
    assert.equal(readFileSync(join(packaged, 'reflink/index.js'), 'utf8'), bindings['reflink/index.js'])
    for (const [name, content] of Object.entries(bindings)) {
      assert.deepEqual(readFileSync(join(prepared, name)), Buffer.from(content), 'prepared pnpm stays unchanged')
    }
  }
  put(join(packaged, 'reflink-win32-x64-msvc/reflink.win32-x64-msvc.node'), pe(0xaa64))
  assert.throws(inspect, /不是 Windows x64/u, 'the retained binding must still pass the architecture check')
  put(join(packaged, 'reflink-win32-x64-msvc/reflink.win32-x64-msvc.node'), pe())
  put(join(packaged, 'unexpected/runtime.node'), Buffer.alloc(128, 0x7f))
  config.afterPack({ appOutDir: options.electronDir })
  assert.throws(inspect, /不是 Windows PE/u, 'unrecognized native modules are never exempted or silently deleted')
})

test('Electron audit detects damaged seed and PRTS registration even with a rebuilt inventory', { skip: !pluginRoot }, (t) => {
  const { versions, options, seed } = fixture(t)
  const inspect = () => inspectElectronInput(options.electronDir, { versions })
  const lock = readFileSync(join(seed, 'pnpm-lock.yaml'))
  put(join(seed, 'pnpm-lock.yaml'), 'tamper')
  assert.throws(inspect, /integrity/u)
  put(join(seed, 'pnpm-lock.yaml'), lock); seal(seed)
  const profile = json(join(seed, 'package.json'))
  put(join(seed, 'package.json'), { ...profile, dsh: { profile: { bundles: ['@deepseek-ai/dsh'] } } }); seal(seed)
  assert.throws(inspect, /PRTS bundle/u)
  put(join(seed, 'package.json'), { ...profile, dependencies: { ...profile.dependencies, 'prts-terrarchive': '0.1.0' } }); seal(seed)
  assert.throws(inspect, /普通依赖/u)
  put(join(seed, 'package.json'), profile); seal(seed)
  put(join(seed, 'pnpm-workspace.yaml'), 'overrides:\n  prts-terrarchive: file:./desktop-packages/wrong.tgz\n'); seal(seed)
  assert.throws(inspect, /workspace core override/u)
  put(join(seed, 'pnpm-workspace.yaml'), 'packages: []\n'); seal(seed)
  const descriptor = json(join(seed, 'desktop-packages.json'))
  descriptor.packages.push(json(join(seed, 'prts-seed.json')).packages[0])
  put(join(seed, 'desktop-packages.json'), descriptor); seal(seed)
  assert.throws(inspect, /core override/u)
})

test('Electron audit rejects unsafe runtime, incomplete ASAR, update feed and private user files', { skip: !pluginRoot }, (t) => {
  const { versions, options } = fixture(t)
  const inspect = () => inspectElectronInput(options.electronDir, { versions })
  const binary = join(options.electronDir, 'resources/native/runtime.node')
  put(binary, pe(0xaa64)); assert.throws(inspect, /不是 Windows x64/u); put(binary, pe())
  for (const changes of [{ main: 'lib/main.js' }, { omit: 'lib/preload.cjs' }, { invalidOffset: 'renderer/plugin-manager.js' }]) {
    put(join(options.electronDir, 'resources/app.asar'), asar(versions, changes))
    assert.throws(inspect, /ASAR/u)
  }
  put(join(options.electronDir, 'resources/app.asar'), asar(versions))
  for (const path of ['resources/app-update.yml', 'userdata/settings.yaml', 'AppData/config', 'resources/.credentials.yaml', 'resources/private.pem']) {
    put(join(options.electronDir, path), '-----BEGIN PRIVATE KEY-----\nfixture\n')
    assert.throws(inspect, /用户数据|自动更新|私钥/u)
    rmSync(join(options.electronDir, path))
    if (['userdata', 'AppData'].includes(path.split('/')[0])) rmSync(join(options.electronDir, path.split('/')[0]), { recursive: true })
  }
})

test('Finished Electron artifact rejects corpus history, extra assets and corrupted compressed bytes', { skip: !pluginRoot }, async (t) => {
  const { versions, options } = fixture(t)
  await assemble(options, { versions })
  const audit = () => auditElectronArtifact(options.out, { versions })
  put(join(options.out, 'corpus/releases/old-release/stale'), 'history')
  await assert.rejects(audit, /current/u)
  rmSync(join(options.out, 'corpus/releases/old-release'), { recursive: true })
  const extra = join(options.out, 'corpus/releases/release-A/official_game/shards/extra.tmp')
  put(extra, 'extra'); await assert.rejects(audit, /残留/u); rmSync(extra)
  const shard = join(options.out, 'corpus/releases/release-A/official_game/shards/00000.jsonl.gz')
  const bytes = readFileSync(shard); bytes[bytes.length - 1] ^= 1; put(shard, bytes)
  await assert.rejects(audit, /校验|SHA|sha|hash/u)
})
