import { existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

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

const args = parseArgs(process.argv.slice(2))
const installerPath = join(args.plugin, 'src', 'installer.js')
if (!existsSync(installerPath)) throw new Error(`找不到插件下载器：${installerPath}`)
const { ensureCorpusRelease, resolveModelScopeCurrentRelease } =
  await import(pathToFileURL(installerPath).href)

const latest = await resolveModelScopeCurrentRelease()
if (!latest?.releaseId) throw new Error('无法从 ModelScope 解析最新语料版本。')

let lastProgress = ''
const result = await ensureCorpusRelease({
  releasesDir: args.out,
  releaseId: latest.releaseId,
  order: ['modelscope'],
  requireRelease: true,
  onProgress(progress) {
    const text = `${progress.phase} ${progress.filesDone}/${progress.filesTotal ?? '?'} files`
    if (text !== lastProgress) {
      lastProgress = text
      console.log(`ModelScope corpus: ${text}`)
    }
  },
})

const pointer = JSON.parse(readFileSync(join(args.out, 'current.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(join(
  args.out, latest.releaseId, 'release-manifest.json'), 'utf8'))
if (pointer.release_id !== latest.releaseId || manifest.release_id !== latest.releaseId) {
  throw new Error(`语料 release 不符：需要 ${latest.releaseId}`)
}
if (latest.dataVersion && (manifest.data_version !== latest.dataVersion
    || pointer.data_version !== latest.dataVersion)) {
  throw new Error(`语料 data_version 不符：需要 ${latest.dataVersion}，实际 ${manifest.data_version}`)
}
console.log(`ModelScope latest corpus ready: ${latest.releaseId} (${result.status})`)
