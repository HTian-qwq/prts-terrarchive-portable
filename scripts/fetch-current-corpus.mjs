import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const TRUSTED_CURRENT_URL = 'https://prts.chat/api/agent/data/releases/current'

const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const REQUIRED_PACK_IDS = Object.freeze([
  'official_game',
  'endfield_official_game',
  'endfield_reviewed_knowledge',
  'reviewed_wiki',
  'terra_journey',
  'entities',
  'references',
])
// 保留同一次可信 HTTP 响应的字节，供插件自己的校验器签发安装快照。
// 不重新请求可变 current，也不把普通 portable 元数据对象当作插件可信句柄。
const currentPayloads = new WeakMap()

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value) throw new Error(`无效参数：${key ?? ''}`)
    values[key.slice(2)] = value
  }
  for (const key of ['plugin', 'out']) {
    if (!values[key]) throw new Error(`缺少 --${key}`)
  }
  return { plugin: resolve(values.plugin), out: resolve(values.out) }
}

function parseSemver(value) {
  if (typeof value !== 'string') return null
  const match = SEMVER_PATTERN.exec(value)
  if (!match) return null
  const core = match.slice(1, 4)
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some((part) => /^\d+$/u.test(part) && part.length > 1 && part.startsWith('0'))) {
    return null
  }
  return { core, prerelease }
}

function compareSemver(left, right) {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (!a || !b) throw new Error('版本号不是有效 SemVer')
  const compareNumeric = (aPart, bPart) => aPart.length === bPart.length
    ? (aPart === bPart ? 0 : aPart < bPart ? -1 : 1)
    : aPart.length < bPart.length ? -1 : 1
  for (let index = 0; index < 3; index += 1) {
    const result = compareNumeric(a.core[index], b.core[index])
    if (result) return result
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const aPart = a.prerelease[index]
    const bPart = b.prerelease[index]
    if (aPart == null || bPart == null) return aPart == null ? -1 : 1
    if (aPart === bPart) continue
    const aNumeric = /^\d+$/u.test(aPart)
    const bNumeric = /^\d+$/u.test(bPart)
    if (aNumeric && bNumeric) return compareNumeric(aPart, bPart)
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    return aPart < bPart ? -1 : 1
  }
  return 0
}

/**
 * Resolve the public release from the mutable pointer owned by PRTS.chat.
 * ModelScope repositories are deliberately not listed here: they are mirrors and
 * can be published independently, so their lexicographically greatest directory
 * is not a trustworthy cross-repository composition.
 */
export async function resolveTrustedCurrentRelease({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl(TRUSTED_CURRENT_URL, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    redirect: 'error',
  })
  if (!response?.ok) {
    throw new Error(`无法读取 PRTS.chat 当前资料版本（HTTP ${response?.status ?? 'unknown'}）`)
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) {
    throw new Error('PRTS.chat current 响应超过 1 MiB')
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('PRTS.chat current 响应不是有效 JSON')
  }
  const data = payload?.data
  const releaseId = String(data?.release_id ?? '')
  const dataVersion = String(data?.data_version ?? '')
  const minimumAgentVersion = data?.minimum_agent_version
  const distributionStatus = data?.distribution_status
  if (payload?.code !== 200 || !RELEASE_ID_PATTERN.test(releaseId)
      || !SHA256_PATTERN.test(dataVersion)) {
    throw new Error('PRTS.chat current 响应缺少合法的 release_id 或 data_version')
  }
  if (!parseSemver(minimumAgentVersion)) {
    throw new Error('PRTS.chat current 响应缺少合法的 minimum_agent_version')
  }
  if (!['published', 'production'].includes(distributionStatus)) {
    throw new Error('PRTS.chat current 不是正式公开 release')
  }
  if (!Array.isArray(data.packs) || !data.packs.length) {
    throw new Error('PRTS.chat current 响应缺少 packs')
  }
  const packVersions = new Map()
  for (const pack of data.packs) {
    const packId = String(pack?.pack_id ?? '')
    const packVersion = String(pack?.data_version ?? '')
    if (!REQUIRED_PACK_IDS.includes(packId) || packVersions.has(packId)
        || pack?.manifest_path !== `${packId}/pack-manifest.json`
        || !SHA256_PATTERN.test(packVersion)) {
      throw new Error(`PRTS.chat current pack 描述非法：${packId || 'unknown'}`)
    }
    packVersions.set(packId, packVersion)
  }
  for (const packId of REQUIRED_PACK_IDS) {
    if (!packVersions.has(packId)) throw new Error(`PRTS.chat current 缺少必需 pack：${packId}`)
  }
  const current = {
    releaseId,
    dataVersion,
    minimumAgentVersion,
    distributionStatus,
    documentCount: data.document_count,
    packVersions,
  }
  currentPayloads.set(current, text)
  return current
}

export async function fetchCurrentCorpus(args, { fetchImpl = fetch } = {}) {
  const installerPath = join(args.plugin, 'src', 'installer.js')
  if (!existsSync(installerPath)) throw new Error(`找不到插件下载器：${installerPath}`)
  let pluginManifest
  try {
    pluginManifest = JSON.parse(readFileSync(join(args.plugin, 'package.json'), 'utf8'))
  } catch {
    throw new Error('插件 package.json 缺失或不是有效 JSON')
  }
  const pluginVersion = pluginManifest?.version
  if (!parseSemver(pluginVersion)) {
    throw new Error(`插件版本不是有效 SemVer：${pluginVersion ?? 'missing'}`)
  }

  const current = await resolveTrustedCurrentRelease({ fetchImpl })
  if (compareSemver(pluginVersion, current.minimumAgentVersion) < 0) {
    throw new Error(`当前资料至少需要 prts-terrarchive ${current.minimumAgentVersion}`
      + `，portable 固定的插件为 ${pluginVersion}`)
  }
  // Importing and invoking the downloader happens only after the compatibility
  // gate, so an incompatible build fails before any corpus asset transfer starts.
  const { ensureCorpusRelease, validateLocalRelease,
    resolveTrustedCurrentRelease: resolveInstallerCurrent } =
    await import(pathToFileURL(installerPath).href)
  if (typeof ensureCorpusRelease !== 'function' || typeof validateLocalRelease !== 'function'
      || typeof resolveInstallerCurrent !== 'function') {
    throw new Error('插件下载器缺少资料安装或校验接口')
  }
  const trustedCurrent = await resolveInstallerCurrent({
    fetchImpl: async (url) => {
      if (String(url) !== TRUSTED_CURRENT_URL) throw new Error('插件快照请求了非 current 地址')
      return new Response(currentPayloads.get(current), {
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  let lastReportedFiles = -50
  const result = await ensureCorpusRelease({
    releasesDir: args.out,
    releaseId: current.releaseId,
    trustedCurrent,
    // PRTS.chat current 决定唯一可信版本；ModelScope 只提供由该清单哈希约束的
    // 分仓字节，缺失或失败时再回退站点，不从镜像目录名猜测“最新版”。
    order: ['modelscope', 'site'],
    siteBaseUrl: new URL(TRUSTED_CURRENT_URL).origin,
    fetchImpl,
    requireRelease: true,
    onProgress(progress) {
      const total = progress.filesTotal ?? '?'
      const sourceLabel = progress.source === 'modelscope' ? 'ModelScope' : 'PRTS.chat fallback'
      const boundary = progress.phase !== 'downloading'
        || progress.filesDone === 0
        || progress.filesDone === progress.filesTotal
        || progress.filesDone - lastReportedFiles >= 50
      if (!boundary) return
      lastReportedFiles = progress.filesDone
      console.log(`Corpus ${sourceLabel}: ${progress.phase} ${progress.filesDone}/${total} files`)
    },
  })

  const pointer = JSON.parse(readFileSync(join(args.out, 'current.json'), 'utf8'))
  const manifest = await validateLocalRelease(args.out, current.releaseId, { verifyHashes: true })
  if (pointer.release_id !== current.releaseId || manifest.release_id !== current.releaseId) {
    throw new Error(`语料 release 不符：需要 ${current.releaseId}`)
  }
  if (pointer.data_version !== current.dataVersion || manifest.data_version !== current.dataVersion) {
    throw new Error(`语料 data_version 不符：需要 ${current.dataVersion}，实际 ${manifest.data_version}`)
  }
  if (Number.isInteger(current.documentCount)
      && manifest.document_count !== current.documentCount) {
    throw new Error(`语料 document_count 不符：需要 ${current.documentCount}，实际 ${manifest.document_count}`)
  }
  for (const [packId, expectedVersion] of current.packVersions) {
    const pack = JSON.parse(readFileSync(join(
      args.out, current.releaseId, packId, 'pack-manifest.json'), 'utf8'))
    if (pack.data_version !== expectedVersion) {
      throw new Error(`${packId} data_version 不符：需要 ${expectedVersion}，实际 ${pack.data_version}`)
    }
  }
  console.log(`PRTS.chat current corpus ready: ${current.releaseId}`
    + ` (status=${result.status}, source=${result.source ?? pointer.channel ?? 'cached'})`)
  return { current, result, manifest }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  await fetchCurrentCorpus(args)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main()
}
