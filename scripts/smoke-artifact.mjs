import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const artifact = resolve(process.argv[2] ?? '')
if (!artifact || !existsSync(join(artifact, 'release-manifest.json'))) {
  throw new Error('用法：node scripts/smoke-artifact.mjs <artifact-directory>')
}
const node = join(artifact, 'runtime', 'node', 'node.exe')
const launcher = join(artifact, 'app', 'launcher.mjs')
const dsh = join(
  artifact, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const home = mkdtempSync(join(tmpdir(), 'prts-portable-smoke-'))
const systemPaths = process.platform === 'win32'
  ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')]
  : ['/usr/bin', '/bin']
const smokeEnv = {
  ...process.env,
  PATH: [dirname(node), ...systemPaths].join(delimiter),
  PRTS_DATA_DIR: home,
  PRTS_NO_OPEN: '1',
}

function run(program, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { ...options, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0
      ? resolvePromise()
      : reject(new Error(`${program} 退出代码 ${code}`)))
  })
}

await run(node, [launcher, '--prepare-only'], {
  cwd: artifact,
  env: smokeEnv,
})

const manifest = JSON.parse(readFileSync(join(artifact, 'release-manifest.json'), 'utf8'))
const profile = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
if (profile.dependencies?.['prts-terrarchive'] !== manifest.pluginVersion) {
  throw new Error('准备后的 profile 未锁定发行版插件版本。')
}

const child = spawn(node, [
  dsh,
  '--profile', 'web',
  '--no-open',
  '--host', '127.0.0.1',
  '--port', '0',
], {
  cwd: artifact,
  env: { ...smokeEnv, DSH_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let buffer = ''
let settled = false
const timeout = setTimeout(() => finish(new Error('等待 DSH Host URL 超时。')), 60_000)

async function verify(url) {
  const bootstrap = await fetch(url, { redirect: 'manual' })
  const cookies = bootstrap.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ')
  if (![200, 303].includes(bootstrap.status) || !cookies) {
    throw new Error(`bootstrap 失败：HTTP ${bootstrap.status}`)
  }
  const headers = { cookie: cookies }
  const settings = await fetch(new URL('/prts-corpus/ui-skin.json', url), { headers })
  if (settings.status !== 200) throw new Error(`PRTS 设置路由失败：HTTP ${settings.status}`)
  const homepage = await fetch(new URL('/', url), { headers })
  const html = await homepage.text()
  if (!html.includes('prts-terrarchive/client.js')) {
    throw new Error('首页没有加载 PRTS 客户端 bundle。')
  }
}

function finish(error) {
  if (settled) return
  settled = true
  clearTimeout(timeout)
  child.kill()
  if (error) {
    console.error(error)
    process.exitCode = 1
  } else {
    console.log('便携发行包冒烟通过。')
  }
}

const consume = (chunk) => {
  const text = chunk.toString()
  process.stdout.write(text.replace(/([?&]token=)[A-Za-z0-9_-]+/gu, '$1[redacted]'))
  buffer = `${buffer}${text}`.slice(-4096)
  const url = buffer.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/\?token=[A-Za-z0-9_-]+/u)?.[0]
  if (url) verify(url).then(() => finish(), finish)
}
child.stdout.on('data', consume)
child.stderr.on('data', consume)
child.once('error', finish)
child.once('exit', (code) => {
  if (!settled) finish(new Error(`DSH Host 提前退出：${code}`))
})

await new Promise((resolvePromise) => child.once('close', resolvePromise))
rmSync(home, { recursive: true, force: true })
if (process.exitCode) process.exit(process.exitCode)
