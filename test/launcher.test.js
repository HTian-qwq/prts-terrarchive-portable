import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repository = join(import.meta.dirname, '..')
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function fixture(t, program, { invalidNode = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'prts-launcher-test-'))
  const dataRoot = join(root, 'userdata')
  const profile = join(root, 'templates', 'profiles', 'web')
  const runtimeNode = process.platform === 'win32'
    ? join(root, 'runtime', 'node', 'node.exe')
    : join(root, 'runtime', 'node', 'bin', 'node')
  for (const directory of ['app', 'runtime/node/bin',
    'runtime/dsh/node_modules/@deepseek-ai/dsh/lib',
    'templates/profiles/web/node_modules/prts-terrarchive', 'templates/.agent-presets/prts']) {
    mkdirSync(join(root, directory), { recursive: true })
  }
  for (const name of ['launcher.mjs', 'portable.mjs']) {
    copyFileSync(join(repository, 'src', name), join(root, 'app', name))
  }
  if (invalidNode) writeFileSync(runtimeNode, 'not an executable\n', { mode: 0o600 })
  else if (process.platform === 'win32') copyFileSync(process.execPath, runtimeNode)
  else symlinkSync(process.execPath, runtimeNode)
  writeFileSync(join(root, 'runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'), program)
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    dependencies: { 'prts-terrarchive': '0.1.0' },
  }))
  writeFileSync(join(profile, 'node_modules/prts-terrarchive/package.json'), '{}\n')
  for (const name of ['cordis.yml', 'cordis.patch.yml']) writeFileSync(join(profile, name), '[]\n')

  const start = (args = []) => {
    const child = spawn(process.execPath, [join(root, 'app/launcher.mjs'), ...args], {
      cwd: root,
      env: { ...process.env, PRTS_DATA_DIR: dataRoot, PRTS_DESKTOP: '1', PRTS_NO_OPEN: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end()
        child.kill('SIGTERM')
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 1000)
        await closed.finally(() => clearTimeout(killTimer))
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })
    return { child, closed, output: () => output }
  }
  return { root, dataRoot, start, statePath: join(dataRoot, '.portable/host.json') }
}

async function within(promise, milliseconds = 4000) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('启动器没有及时完成退出或输出')), milliseconds)
    })])
  } finally {
    clearTimeout(timer)
  }
}

async function waitForOutput(run, expected) {
  const deadline = Date.now() + 4000
  while (!run.output().includes(expected)) {
    if (run.child.exitCode !== null || run.child.signalCode !== null) {
      throw new Error(`启动器提前退出：${run.output()}`)
    }
    if (Date.now() >= deadline) throw new Error(`等待启动器输出超时：${run.output()}`)
    await delay(20)
  }
}

test('DSH 启动失败后关闭启动器，并在桌面 stdin 仍打开时传回失败代码', async (t) => {
  const app = fixture(t, "console.error('fixture-start-failed'); process.exitCode = 17;\n")
  const run = app.start()
  assert.deepEqual(await within(run.closed), { code: 17, signal: null })
  assert.match(run.output(), /fixture-start-failed/u)
  assert.match(run.output(), /异常退出，代码 17/u)
  assert.equal(existsSync(app.statePath), false)
})

test('DSH 已就绪后正常退出也结束启动器并清除 Host 状态', async (t) => {
  const app = fixture(t, "console.log('http://127.0.0.1:12345/?token=fixture_ready');\n")
  const run = app.start()
  assert.deepEqual(await within(run.closed), { code: 0, signal: null })
  assert.equal(existsSync(app.statePath), false)
  assert.match(readFileSync(join(app.dataRoot, 'logs/dsh.log'), 'utf8'), /token=\[redacted\]/u)
})

test('桌面 shutdown 命令跨管道分块时仍及时关闭 Host 和启动器', async (t) => {
  const app = fixture(t, "console.log('fixture-running'); setTimeout(() => {}, 10000);\n")
  const run = app.start()
  await waitForOutput(run, 'fixture-running')
  run.child.stdin.write('shut')
  await delay(30)
  run.child.stdin.write('down\r\n')
  assert.deepEqual(await within(run.closed), { code: 0, signal: null })
})

test('桌面控制管道断开时停止 Host', async (t) => {
  const app = fixture(t, "console.log('fixture-running'); setTimeout(() => {}, 10000);\n")
  const run = app.start()
  await waitForOutput(run, 'fixture-running')
  run.child.stdin.end()
  assert.deepEqual(await within(run.closed), { code: 0, signal: null })
})

test('内置 Node 无法执行时启动器返回失败而不会等待桌面 stdin', async (t) => {
  const app = fixture(t, '', { invalidNode: true })
  const run = app.start()
  const result = await within(run.closed)
  assert.equal(result.code, 1)
  assert.match(run.output(), /PRTS Host 启动失败/u)
})

test('读取遗留 Host 状态时调试日志隐藏本地访问 token', async (t) => {
  const app = fixture(t, '')
  mkdirSync(join(app.dataRoot, '.portable'), { recursive: true })
  writeFileSync(app.statePath, JSON.stringify({
    pid: 999999, url: 'http://127.0.0.1:1/?token=fixture_private_token',
  }))
  const run = app.start(['--prepare-only'])
  assert.equal((await within(run.closed)).code, 0)
  const log = readFileSync(join(app.dataRoot, 'logs/launcher-debug.log'), 'utf8')
  assert.match(log, /readHostState.*token=\[redacted\]/u)
  assert.doesNotMatch(log, /fixture_private_token/u)
})

test('URL 和 token 跨输出分块时完整识别且不会将后半段令牌写进日志', async (t) => {
  const app = fixture(t, [
    "process.stdout.write('Open http://127.0.0.1:12345/?token=fixture_');",
    "setTimeout(() => process.stdout.write('private_token now\\n'), 80);",
    'setTimeout(() => {}, 10000);',
  ].join('\n'))
  const run = app.start()
  await waitForOutput(run, 'private_token now')
  const state = JSON.parse(readFileSync(app.statePath, 'utf8'))
  assert.equal(state.url, 'http://127.0.0.1:12345/?token=fixture_private_token')
  const log = readFileSync(join(app.dataRoot, 'logs/dsh.log'), 'utf8')
  assert.match(log, /token=\[redacted\] now/u)
  assert.doesNotMatch(log, /private_token/u)
  run.child.stdin.write('shutdown\n')
  assert.equal((await within(run.closed)).code, 0)
})
