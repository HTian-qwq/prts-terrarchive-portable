import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { configurePortableElectron, startPortableElectron } from '../electron/portable-main.mjs'
import { createPortableBuilderConfig } from '../electron/builder-config.mjs'

const repository = resolve(import.meta.dirname, '..')
const versions = JSON.parse(readFileSync(join(repository, 'versions.electron.json'), 'utf8'))

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'prts-electron-bootstrap-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function application() {
  return {
    paths: {},
    setPath(name, path) { assert(existsSync(path)); this.paths[name] = path },
    setAppLogsPath(path) { assert(existsSync(path)); this.paths.logs = path },
    setName(name) { this.name = name },
    setAppUserModelId(id) { this.appId = id },
  }
}

test('官方主程序加载前，数据、浏览器会话和完整语料路径均绑定程序所在目录', async (t) => {
  const root = join(temporary(t), '泰拉资料 Portable')
  const environment = { DSH_HOME: '/external/dsh', PRTS_CORPUS_RELEASES_DIR: '/external/corpus' }
  const app = application()
  let mainLoaded = false
  await startPortableElectron(app, {
    executable: join(root, 'PRTS Terrarchive.exe'), environment, branding: versions,
  }, async () => {
    mainLoaded = true
    assert.equal(environment.DSH_HOME, join(root, 'userdata'))
    assert.equal(environment.PRTS_PORTABLE, '1')
    assert.equal(environment.PRTS_CORPUS_RELEASES_DIR, join(root, 'corpus', 'releases'))
    assert.equal(app.paths.userData, join(root, 'userdata', 'electron'))
    assert.equal(app.paths.sessionData, join(root, 'userdata', 'electron', 'session'))
    assert.equal(app.paths.crashDumps, join(root, 'userdata', 'electron', 'crash-dumps'))
    assert.equal(app.paths.logs, join(root, 'userdata', 'logs'))
    assert.equal(app.name, versions.productName)
    assert.equal(app.appId, versions.appId)
    const patch = readFileSync(join(environment.DSH_HOME, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /- id: agent-presets\s+config:\s+default: prts/u)
    assert.doesNotMatch(patch, /id: prts-corpus/u)
    assert.deepEqual(JSON.parse(readFileSync(join(environment.DSH_HOME, 'prts-corpus.json'), 'utf8')), { uiSkin: 'prts-agent' })
  })
  assert(mainLoaded)
})

test('再次启动完整保留用户的模式、皮肤及手写配置', (t) => {
  const root = temporary(t)
  const data = join(root, 'userdata')
  mkdirSync(join(data, 'settings'), { recursive: true })
  const choices = {
    'cordis.patch.yml': '# 用户注释\n- id: agent-presets\n  config:\n    default: standard\n',
    'prts-corpus.json': '{"uiSkin":"endfield-aic","enabledGames":["endfield"]}\n',
    'settings/agent-presets.json': '{"default":"minimal"}\n',
  }
  for (const [file, content] of Object.entries(choices)) writeFileSync(join(data, file), content)
  for (let i = 0; i < 2; i++) configurePortableElectron(application(), { executable: join(root, 'PRTS.exe'), environment: {} })
  for (const [file, content] of Object.entries(choices)) assert.equal(readFileSync(join(data, file), 'utf8'), content)
})

test('已有 home patch 而无 JSON 用户层时不添加更高优先级皮肤设置', (t) => {
  const root = temporary(t)
  const data = join(root, 'userdata')
  mkdirSync(data)
  const patch = '- id: prts-corpus\n  config:\n    uiSkin: harness\n'
  writeFileSync(join(data, 'cordis.patch.yml'), patch)
  configurePortableElectron(application(), { executable: join(root, 'PRTS.exe'), environment: {} })
  assert.equal(readFileSync(join(data, 'cordis.patch.yml'), 'utf8'), patch)
  assert.equal(existsSync(join(data, 'prts-corpus.json')), false)
})

test('移动便携目录后保留配置并重新定位 userdata 和 corpus', (t) => {
  const parent = temporary(t)
  const old = join(parent, 'before')
  const moved = join(parent, '移动之后')
  configurePortableElectron(application(), { executable: join(old, 'PRTS.exe'), environment: {} })
  const config = '{"uiSkin":"harness"}\n'
  writeFileSync(join(old, 'userdata', 'prts-corpus.json'), config)
  renameSync(old, moved)
  const environment = {}
  configurePortableElectron(application(), { executable: join(moved, 'PRTS.exe'), environment })
  assert.equal(environment.DSH_HOME, join(moved, 'userdata'))
  assert.equal(environment.PRTS_CORPUS_RELEASES_DIR, join(moved, 'corpus', 'releases'))
  assert.equal(readFileSync(join(moved, 'userdata', 'prts-corpus.json'), 'utf8'), config)
})

test('升级到 client 布局并移动中文目录后，直接启动客户端仍读取原会话、配置和语料', (t) => {
  const parent = temporary(t)
  const old = join(parent, 'client') // Old flat package may itself be named client.
  const initial = configurePortableElectron(application(), { executable: join(old, 'PRTS.exe'), environment: {} })
  assert.equal(initial.appRoot, old)
  const config = '{"uiSkin":"endfield-aic"}\n'
  writeFileSync(join(old, 'userdata', 'prts-corpus.json'), config)
  writeFileSync(join(old, 'userdata', 'electron', 'session', 'fixture'), 'saved session')
  mkdirSync(join(old, 'corpus', 'releases'), { recursive: true })
  writeFileSync(join(old, 'corpus', 'releases', 'current.json'), '{"release_id":"user-update"}\n')
  mkdirSync(join(old, 'client'))
  const branding = { ...versions, layout: 'client-v1' }
  const checkData = (root) => {
    const environment = { DSH_HOME: '/external', PRTS_CORPUS_RELEASES_DIR: '/external' }
    const app = application()
    const paths = configurePortableElectron(app, { executable: join(root, 'client', 'PRTS Terrarchive.exe'), environment, branding })
    assert.equal(paths.appRoot, root)
    assert.equal(environment.DSH_HOME, join(root, 'userdata'))
    assert.equal(environment.PRTS_CORPUS_RELEASES_DIR, join(root, 'corpus', 'releases'))
    assert.equal(readFileSync(join(environment.DSH_HOME, 'prts-corpus.json'), 'utf8'), config)
    assert.equal(readFileSync(join(app.paths.sessionData, 'fixture'), 'utf8'), 'saved session')
    assert.equal(JSON.parse(readFileSync(join(environment.PRTS_CORPUS_RELEASES_DIR, 'current.json'), 'utf8')).release_id, 'user-update')
    assert.equal(existsSync(join(root, 'client', 'userdata')), false)
  }
  checkData(old)
  const moved = join(parent, '资料 移动之后')
  renameSync(old, moved)
  checkData(moved)
})

test('带新版布局标记的主程序放错位置时，不在错误目录创建 userdata', (t) => {
  const root = temporary(t)
  assert.throws(() => configurePortableElectron(application(), {
    executable: join(root, 'PRTS Terrarchive.exe'), environment: {}, branding: { layout: 'client-v1' },
  }), /client/u)
  assert.equal(existsSync(join(root, 'userdata')), false)
})

async function executePackagedEntry(t, { failDirectory = false } = {}) {
  const root = temporary(t)
  const client = join(root, 'client')
  mkdirSync(join(client, 'node_modules', 'electron'), { recursive: true })
  mkdirSync(join(client, 'lib'))
  copyFileSync(join(repository, 'electron', 'portable-main.mjs'), join(client, 'portable-main.mjs'))
  writeFileSync(join(client, 'package.json'), JSON.stringify({
    type: 'module', productName: versions.productName, prtsPortable: { appId: versions.appId, layout: 'client-v1' },
  }))
  writeFileSync(join(client, 'node_modules', 'electron', 'index.js'), "module.exports = globalThis[Symbol.for('prts-electron-entry-test')]\n")
  writeFileSync(join(client, 'lib', 'main.js'), "globalThis[Symbol.for('prts-electron-entry-test')].enteredMain()\n")
  if (failDirectory) writeFileSync(join(root, 'userdata'), 'A file blocks creation of the portable data directory.')
  const symbol = Symbol.for('prts-electron-entry-test')
  const app = application()
  const errors = []
  let exitCode
  let entered = false
  const shim = {
    app: { ...app, exit(code) { exitCode = code } },
    dialog: { showErrorBox(title, message) { errors.push({ title, message }) } },
    enteredMain() {
      entered = true
      assert.equal(process.env.DSH_HOME, join(root, 'userdata'))
      assert.equal(shim.app.paths.sessionData, join(root, 'userdata', 'electron', 'session'))
    },
  }
  const executableDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath')
  const electronDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron')
  const previous = Object.fromEntries(['DSH_HOME', 'PRTS_PORTABLE', 'PRTS_CORPUS_RELEASES_DIR'].map(name => [name, process.env[name]]))
  globalThis[symbol] = shim
  try {
    Object.defineProperty(process, 'execPath', { ...executableDescriptor, value: join(client, 'PRTS Terrarchive.exe') })
    Object.defineProperty(process.versions, 'electron', { configurable: true, value: versions.electron })
    await import(pathToFileURL(join(client, 'portable-main.mjs')).href)
  } finally {
    Object.defineProperty(process, 'execPath', executableDescriptor)
    if (electronDescriptor) Object.defineProperty(process.versions, 'electron', electronDescriptor)
    else delete process.versions.electron
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    delete globalThis[symbol]
  }
  return { entered, errors, exitCode, application: shim.app }
}

test('打包入口使用包内品牌元数据并导入相邻的官方 main', async (t) => {
  const result = await executePackagedEntry(t)
  assert.equal(result.entered, true)
  assert.equal(result.application.name, versions.productName)
  assert.equal(result.application.appId, versions.appId)
  assert.deepEqual(result.errors, [])
  assert.equal(result.exitCode, undefined)
})

test('便携数据目录不可创建时显示本地错误窗，阻止官方 main 在错误目录启动', async (t) => {
  const result = await executePackagedEntry(t, { failDirectory: true })
  assert.equal(result.entered, false)
  assert.equal(result.exitCode, 1)
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0].title, /PRTS Terrarchive/u)
  assert.match(result.errors[0].message, /userdata/u)
})

function builderFixture(t) {
  const root = temporary(t)
  const appRoot = join(root, 'official-desktop')
  mkdirSync(appRoot)
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ version: versions.dsh.version }))
  const output = join(root, 'artifacts')
  return { appRoot, output, config: createPortableBuilderConfig({ portableRoot: repository, appRoot, output, environment: {} }) }
}

test('免凭据构建使用官方主程序和独立 PRTS seed，保留图标并禁用发布', (t) => {
  const { appRoot, config } = builderFixture(t)
  assert.equal(config.extends, null)
  assert.equal(config.extraMetadata.main, 'portable-main.mjs')
  assert.equal(config.extraMetadata.prtsPortable.layout, 'client-v1')
  assert(config.files.includes('lib/*.js'))
  assert(config.files.includes('lib/*.cjs'))
  assert(config.files.includes('renderer/**/*'))
  assert.equal(config.asar, true)
  assert.equal(config.productName, versions.productName)
  assert.equal(config.appId, versions.appId)
  assert.equal(config.electronVersion, versions.electron)
  assert.equal(config.extraMetadata.version, undefined, '保留官方 shell 版本与 seed 的绑定')
  assert.equal(config.win.signExecutable, false)
  assert.notEqual(config.win.signAndEditExecutable, false, '免签名仍需应用 ICO 和 EXE 元数据')
  assert.equal(existsSync(config.win.icon), true)
  assert.equal(config.forceCodeSigning, false)
  assert.equal(config.win.forceCodeSigning, false)
  assert.deepEqual(config.win.target, [{ target: 'dir', arch: ['x64'] }])
  assert.equal(config.publish, null)
  assert.equal(config.win.publish, null)
  assert.deepEqual(config.extraResources, [
    { from: join(appRoot, '.desktop-build', 'targets', 'win-x64', 'runtime'), to: 'runtime' },
    { from: join(appRoot, '.desktop-build', 'targets', 'win-x64', 'prts-seed'), to: 'seed' },
  ])
})

test('拒绝把官方更新配置或不匹配的 shell 版本带入社区发行版', (t) => {
  const { appRoot, output, config } = builderFixture(t)
  assert.deepEqual(config.afterAllArtifactBuild(), [])
  const resources = join(output, 'win-unpacked', 'resources')
  mkdirSync(resources, { recursive: true })
  writeFileSync(join(resources, 'app-update.yml'), 'provider: generic\nurl: https://download.deepseek.com/\n')
  assert.throws(() => config.afterAllArtifactBuild(), /must not contain app-update.yml/u)
  writeFileSync(join(appRoot, 'package.json'), '{"version":"0.0.0"}')
  assert.throws(() => createPortableBuilderConfig({ portableRoot: repository, appRoot, output }), /does not match/u)
})
