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
  for (const key of ['plugin', 'out', 'release', 'data-version']) {
    if (!values[key]) throw new Error(`缺少 --${key}`)
  }
  return { plugin: resolve(values.plugin), out: resolve(values.out),
    releaseId: values.release, dataVersion: values['data-version'] }
}

const args = parseArgs(process.argv.slice(2))
const installerPath = join(args.plugin, 'src', 'installer.js')
if (!existsSync(installerPath)) throw new Error(`找不到插件下载器：${installerPath}`)
const { ensureCorpusRelease } = await import(pathToFileURL(installerPath).href)

let lastProgress = ''
const result = await ensureCorpusRelease({
  releasesDir: args.out,
  releaseId: args.releaseId,
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
const manifest = JSON.parse(readFileSync(
  join(args.out, args.releaseId, 'release-manifest.json'), 'utf8'))
if (pointer.release_id !== args.releaseId || manifest.release_id !== args.releaseId) {
  throw new Error(`语料 release 不符：需要 ${args.releaseId}`)
}
if (manifest.data_version !== args.dataVersion || pointer.data_version !== args.dataVersion) {
  throw new Error(`语料 data_version 不符：需要 ${args.dataVersion}，实际 ${manifest.data_version}`)
}
console.log(`ModelScope corpus ready: ${args.releaseId} (${result.status})`)
