import { appendFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseDshUrl,
  readHostState,
  redactToken,
  removeHostState,
  syncManagedInstall,
  writeHostState,
} from './portable.mjs'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = process.env.PRTS_DATA_DIR
  ? resolve(process.env.PRTS_DATA_DIR)
  : join(appRoot, 'userdata')
const statePath = join(dataRoot, '.portable', 'host.json')
const logPath = join(dataRoot, 'logs', 'dsh.log')
const nodePath = process.platform === 'win32'
  ? join(appRoot, 'runtime', 'node', 'node.exe')
  : join(appRoot, 'runtime', 'node', 'bin', 'node')
const dshEntry = join(
  appRoot, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

async function probe(url) {
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(1500),
    })
    return response.status >= 200 && response.status < 500
  } catch {
    return false
  }
}

function openUrl(url) {
  if (process.env.PRTS_NO_OPEN === '1') return
  if (process.platform === 'win32') {
    const roots = [
      process.env.LOCALAPPDATA,
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
    ].filter(Boolean)
    const candidates = roots.flatMap((root) => [
      join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ])
    const browser = candidates.find(existsSync)
    const command = browser ?? 'explorer.exe'
    const args = browser ? [`--app=${url}`, '--new-window'] : [url]
    const opened = spawn(command, args, { detached: true, stdio: 'ignore' })
    opened.unref()
    return
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
  const opened = spawn(command, [url], { detached: true, stdio: 'ignore' })
  opened.unref()
}

async function stopRunning() {
  const state = readHostState(statePath)
  if (!state) {
    console.log('PRTS Host 当前没有运行。')
    return
  }
  if (!await probe(state.url)) {
    removeHostState(statePath)
    console.log('已清理失效的 Host 状态。')
    return
  }
  try {
    process.kill(state.pid)
    console.log(`已停止 PRTS Host（PID ${state.pid}）。`)
  } finally {
    removeHostState(statePath)
  }
}

async function start() {
  const prepared = syncManagedInstall({ appRoot, dataRoot })
  if (process.argv.includes('--prepare-only')) {
    console.log(`便携环境已准备：${prepared.profileDir}`)
    return
  }
  const existing = readHostState(statePath)
  if (existing && await probe(existing.url)) {
    console.log('PRTS Host 已在运行，正在打开窗口。')
    openUrl(existing.url)
    return
  }
  if (existing) removeHostState(statePath)
  if (!existsSync(nodePath) || !existsSync(dshEntry)) {
    throw new Error('运行时文件不完整，请重新下载并完整解压发行包。')
  }

  const child = spawn(nodePath, [
    dshEntry,
    '--profile', 'web',
    '--no-open',
    '--host', '127.0.0.1',
    '--port', '0',
  ], {
    cwd: appRoot,
    env: {
      ...process.env,
      DSH_HOME: dataRoot,
      PRTS_PORTABLE: '1',
    },
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: process.platform === 'win32',
  })

  let opened = false
  const consume = (chunk, output) => {
    const text = chunk.toString()
    output.write(text)
    appendFileSync(logPath, redactToken(text))
    if (opened) return
    const url = parseDshUrl(text)
    if (!url) return
    opened = true
    writeHostState(statePath, {
      pid: child.pid,
      url,
      startedAt: new Date().toISOString(),
      pluginVersion: prepared.pluginVersion,
    })
    openUrl(url)
  }
  child.stdout.on('data', (chunk) => consume(chunk, process.stdout))
  child.stderr.on('data', (chunk) => consume(chunk, process.stderr))

  const shutdown = () => {
    if (child.exitCode === null) child.kill()
  }
  if (process.env.PRTS_DESKTOP === '1') {
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (text) => {
      if (text.split(/\r?\n/u).some((line) => line.trim() === 'shutdown')) shutdown()
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  child.once('exit', (code, signal) => {
    const state = readHostState(statePath)
    if (state?.pid === child.pid) removeHostState(statePath)
    if (signal) console.log(`\nPRTS Host 已停止（${signal}）。`)
    else if (code) console.error(`\nPRTS Host 异常退出，代码 ${code}。日志：${logPath}`)
    process.exitCode = code || 0
  })
}

if (process.argv.includes('--stop')) await stopRunning()
else await start()
