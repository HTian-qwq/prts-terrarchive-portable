import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { fetchCurrentCorpus, TRUSTED_CURRENT_URL } from '../scripts/fetch-current-corpus.mjs'
import { packageCurrentCorpus } from '../scripts/corpus-artifact.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const explicitPlugin = process.env.PRTS_PLUGIN_TEST_ROOT?.trim()
const candidates = explicitPlugin ? [resolve(explicitPlugin)]
  : [join(repositoryRoot, '.build/plugin'), resolve(repositoryRoot, '../prts-terrarchive')]
const pluginRoot = candidates.find((path) => existsSync(join(path, 'src/installer.js'))
  && existsSync(join(path, 'package.json')))
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const canonicalJson = (value) => Array.isArray(value)
  ? `[${value.map(canonicalJson).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
    : JSON.stringify(value)

test('真实插件离线集成：同一 current 句柄下载七包并只封装清单内资产', {
  skip: !explicitPlugin && !pluginRoot
    ? '未找到插件源码；可设置 PRTS_PLUGIN_TEST_ROOT 或 checkout .build/plugin' : false,
}, async (t) => {
  assert.ok(pluginRoot, `PRTS_PLUGIN_TEST_ROOT 不是可用的插件源码目录：${explicitPlugin}`)
  const installer = await import(pathToFileURL(join(pluginRoot, 'src/installer.js')).href)
  const pluginVersion = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')).version
  const root = mkdtempSync(join(tmpdir(), 'prts-real-installer-build-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const releasesDir = join(root, 'source')
  const targetDir = join(root, 'artifact')
  const packIds = ['official_game', 'endfield_official_game', 'endfield_reviewed_knowledge',
    'reviewed_wiki', 'terra_journey', 'entities', 'references']
  // 仅几百字节的离线分片；真实插件执行清单/内容根/压缩字节校验，不访问网络。
  const plain = Buffer.from('{"fixture":"small offline corpus"}\n')
  const bytes = gzipSync(plain)
  const packManifests = new Map(packIds.map((pack_id, index) => [pack_id, {
    algorithm: 'prts-browser-corpus-pack-v1', schema_version: 1, pack_id, authority: 'official',
    data_version: String(index + 1).repeat(64), document_count: 1, line_count: 1,
    compressed_size: bytes.length, uncompressed_size: plain.length,
    shards: [{ path: 'shards/00000.jsonl.gz', sha256: sha256(bytes),
      compressed_size: bytes.length, uncompressed_size: plain.length }],
  }]))
  const packs = packIds.map((pack_id) => {
    const pack = packManifests.get(pack_id)
    return { pack_id, manifest_path: `${pack_id}/pack-manifest.json`, authority: pack.authority,
      data_version: pack.data_version, document_count: 1, line_count: 1,
      compressed_size: pack.compressed_size, uncompressed_size: pack.uncompressed_size, shard_count: 1 }
  })
  const dataVersion = sha256(canonicalJson({
    compiler_version: 'fixture', source_snapshot: 'fixture',
    packs: packIds.map((pack_id) => {
      const pack = packManifests.get(pack_id)
      return { pack_id, data_version: pack.data_version, authority: pack.authority,
        shards: pack.shards.map((asset) => ({ path: asset.path, sha256: asset.sha256 })),
        search_index_shards: [] }
    }),
  }))
  const manifest = {
    algorithm: 'prts-browser-corpus-release-v1', schema_version: 1, release_id: 'release-A',
    data_version: dataVersion, corpus_version: dataVersion, content_tree_sha256: dataVersion,
    compiler_version: 'fixture', source_update_id: 'local-snapshot:fixture',
    minimum_agent_version: pluginVersion, required_packs: packIds, packs,
    document_count: 7, line_count: 7,
    compressed_size: bytes.length * 7, uncompressed_size: plain.length * 7,
  }
  let currentRequests = 0
  let assetRequests = 0
  const fetched = await fetchCurrentCorpus({ plugin: pluginRoot, out: releasesDir }, {
    fetchImpl: async (url) => {
      if (String(url) === TRUSTED_CURRENT_URL) {
        currentRequests += 1
        return new Response(JSON.stringify({ code: 200, data: { ...manifest,
          release_id: currentRequests === 1 ? 'release-A' : 'release-B', distribution_status: 'published' } }))
      }
      const path = String(url).split('/releases/release-A/')[1]
      if (path === 'release-manifest.json') return new Response(JSON.stringify(manifest))
      const packId = path?.split('/')[0]
      if (packManifests.has(packId) && path === `${packId}/pack-manifest.json`) {
        return new Response(JSON.stringify(packManifests.get(packId)))
      }
      if (packManifests.has(packId) && path === `${packId}/shards/00000.jsonl.gz`) {
        assetRequests += 1
        return new Response(bytes)
      }
      throw new Error(`离线 fixture 没有此资源：${url}`)
    },
  })
  assert.equal(currentRequests, 1)
  assert.equal(assetRequests, 7)
  assert.equal(fetched.manifest.data_version, dataVersion)
  mkdirSync(join(releasesDir, 'obsolete-release'))
  writeFileSync(join(releasesDir, 'obsolete-release/old.tmp'), 'leftover')
  writeFileSync(join(releasesDir, 'release-A/official_game/shards/residue.tmp'), 'leftover')
  const packaged = await packageCurrentCorpus({ releasesDir, targetDir, installer })
  assert.equal(packaged.manifest.data_version, dataVersion)
  assert.deepEqual(readdirSync(targetDir).sort(), ['current.json', 'release-A'])
  assert.equal(existsSync(join(targetDir, 'release-A/official_game/shards/residue.tmp')), false)
  const verified = await installer.validateLocalRelease(targetDir, 'release-A', { verifyHashes: true })
  assert.equal(verified.data_version, dataVersion)
})
