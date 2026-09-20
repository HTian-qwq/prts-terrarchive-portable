/** Local uncompressed desktop builds. Runtime caches are shared; plugin builds and user data are owned here. */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, symlinkSync, watch, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve, sep, delimiter } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { completeTestProfile, verifyTestProfile } from './test-profile.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
export const inside = (parent, child) => {
  const path = relative(resolve(parent), resolve(child))
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/** Snapshot exactly the declared published files, without archives or development dependencies. */
export function packageFiles(plugin) {
  const manifest = json(join(plugin, 'package.json'))
  if (manifest.name !== 'prts-terrarchive' || !Array.isArray(manifest.files)) throw new Error('Expected the prts-terrarchive source package')
  const files = new Set(['package.json'])
  const visit = path => {
    const full = resolve(plugin, path)
    if (!inside(plugin, full)) throw new Error(`Package file escapes its source: ${path}`)
    const stat = lstatSync(full)
    if (stat.isSymbolicLink()) throw new Error(`Published source must not contain junctions or symlinks: ${path}`)
    if (stat.isDirectory()) for (const entry of readdirSync(full)) visit(join(path, entry))
    else if (stat.isFile()) files.add(path)
    else throw new Error(`Unsupported package file: ${path}`)
  }
  for (const path of manifest.files) visit(path)
  return [...files].sort()
}

export function snapshotPlugin(plugin, output) {
  if (inside(plugin, output) || inside(output, plugin) || resolve(plugin) === resolve(output)) throw new Error('Plugin snapshot cannot overlap its source')
  if (existsSync(output)) throw new Error('Plugin snapshot must be a new directory')
  const files = packageFiles(plugin)
  const hash = createHash('sha256')
  for (const file of files) {
    const body = readFileSync(join(plugin, file))
    hash.update(file.split(sep).join('/') + '\0').update(body).update('\0')
    mkdirSync(dirname(join(output, file)), { recursive: true })
    writeFileSync(join(output, file), body)
  }
  return { sha256: hash.digest('hex'), files: files.length }
}

export function firstRunSettings(home) {
  mkdirSync(home, { recursive: true })
  for (const [name, text] of [
    ['cordis.patch.yml', '# Local desktop test profile; preserved on subsequent builds.\n- id: agent-presets\n  config:\n    default: prts\n'],
    ['prts-corpus.json', '{\n  "uiSkin": "rhine-lab"\n}\n'],
  ]) {
    try { writeFileSync(join(home, name), text, { flag: 'wx', mode: 0o600 }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  }
}

/** Changes arriving during a build coalesce into one follow-up build; failures remain retryable. */
export function buildQueue(build, onError = console.error) {
  let running = false, pending = false, closed = false, active = Promise.resolve()
  const request = () => {
    if (closed) return active
    pending = true
    if (running) return active
    running = true
    active = (async () => {
      try {
        while (pending && !closed) {
          pending = false
          try { await build() } catch (error) { onError(error) }
        }
      } finally { running = false }
    })()
    return active
  }
  return { request, close() { closed = true; pending = false; return active } }
}

export function shouldWatch(filename) {
  const file = String(filename).replaceAll('\\', '/')
  if (file === 'ui/rhine/original/array-detail-data.ts') return false
  return /^(ui\/|src\/|resources\/|contracts\/|skills\/|presets\/|lib\/skins\/|lib\/client\.js$|package\.json$|cordis\.patch\.yml$|vite\.rhine\.config\.ts$)/.test(file)
}

export function ensureTestRoot(testRoot) {
  const marker = join(testRoot, 'test-build-root.json')
  if (existsSync(testRoot) && readdirSync(testRoot).length && !existsSync(marker)) {
    throw new Error('Refusing to use an existing release or data directory as the test output')
  }
  mkdirSync(testRoot, { recursive: true })
  if (existsSync(marker)) {
    if (json(marker).kind !== 'prts-local-test-v1') throw new Error('Invalid test output marker')
  } else writeJson(marker, { kind: 'prts-local-test-v1' })
}

async function run(command, args, cwd, environment = process.env) {
  await new Promise((settle, reject) => {
    const child = spawn(command, args, { cwd, env: environment, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? settle() : reject(new Error(`Build command failed (${code ?? signal}): ${args.join(' ')}`)))
  })
}

function link(source, destination) {
  mkdirSync(dirname(destination), { recursive: true })
  symlinkSync(resolve(source), destination, process.platform === 'win32' ? 'junction' : 'dir')
}

export function publishCurrent(testRoot, build) {
  const temporary = join(testRoot, `current-${randomUUID()}.json`)
  writeJson(temporary, build)
  renameSync(temporary, join(testRoot, 'current.json'))
}

export async function control(testRoot, command) {
  const path = join(testRoot, 'instance.json')
  if (!existsSync(path)) return undefined
  const instance = json(path)
  return new Promise((settle, reject) => {
    const socket = connect(instance.pipe)
    let response = ''
    socket.setTimeout(30000, () => socket.destroy(new Error('The test app is still closing. Close it normally and retry.')))
    socket.once('connect', () => socket.end(JSON.stringify({ token: instance.token, command }) + '\n'))
    socket.on('data', data => { response += data })
    socket.once('end', () => settle(response ? JSON.parse(response) : undefined))
    socket.once('error', error => ['ENOENT', 'ECONNREFUSED'].includes(error.code) ? settle(undefined) : reject(error))
  })
}

export async function buildTestDesktop({ plugin = resolve(root, '../prts-terrarchive'), tools = resolve(root, '../.tools'), testRoot = join(root, 'dist/PRTS-Terrarchive-Test'), skipRhine = false } = {}) {
  plugin = resolve(plugin); testRoot = resolve(testRoot)
  if (!inside(join(root, 'dist'), testRoot)) throw new Error('Test output must be a child of this builder\'s dist directory')
  ensureTestRoot(testRoot)
  const dsh = join(root, '.build/dsh-electron')
  const desktop = join(dsh, 'apps/desktop')
  const versions = json(join(root, 'versions.electron.json'))
  const target = join(desktop, '.desktop-build/targets/win-x64')
  const runtime = join(target, 'runtime')
  const node = join(runtime, 'node/node.exe')
  const corpus = join(root, '.build/corpus/releases')
  for (const file of [join(desktop, 'lib/main.js'), join(dsh, 'apps/desktop-host/lib/index.js'), node, join(corpus, 'current.json')]) {
    if (!existsSync(file)) throw new Error(`Missing cached release prerequisite: ${file}\nRun build-electron.ps1 once to prepare the release runtime.`)
  }
  if (json(join(desktop, 'package.json')).version !== versions.dsh.version) throw new Error('Cached desktop version differs from versions.electron.json')
  const buildNode = join(tools, 'node/node.exe')
  const npm = join(tools, 'node/node_modules/npm/bin/npm-cli.js')
  const environment = { ...process.env, PATH: `${dirname(buildNode)}${delimiter}${process.env.PATH || ''}` }
  if (!skipRhine) await run(buildNode, [npm, 'run', 'build:rhine'], plugin, environment)
  for (const file of ['lib/client.js', 'src/index.js', 'lib/rhine/rhine.js']) await run(buildNode, ['--check', join(plugin, file)], plugin, environment)
  const desktopRequire = createRequire(join(desktop, 'package.json'))
  // Electron's own installer verifies and reuses the version-pinned local ZIP cache if necessary.
  const electron = desktopRequire('electron')
  const requireDsh = createRequire(join(dsh, 'package.json'))
  const { register } = await import(pathToFileURL(requireDsh.resolve('tsx/esm/api')).href)
  const unregister = register({ tsconfig: join(dsh, 'tsconfig.base.json') })
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8)
  const generation = join(testRoot, 'builds', id)
  const pluginOutput = join(generation, 'plugin')
  const profile = join(generation, 'profile')
  const app = join(generation, 'app')
  const home = join(testRoot, 'userdata')
  const snapshot = snapshotPlugin(plugin, pluginOutput)
  try {
    const { prepareDevelopmentProject } = await import(pathToFileURL(join(desktop, 'scripts/development-project.ts')).href)
    prepareDevelopmentProject({ projectDir: profile, cliDir: join(dsh, 'apps/cli'), hostDir: join(dsh, 'apps/desktop-host'),
      dependencyDir: join(dsh, 'node_modules/.pnpm/node_modules'), release: json(join(target, 'seed/desktop-release.json')) })
  } finally { unregister() }
  const linked = completeTestProfile(dsh, profile, json(join(target, 'seed/package.json')).dependencies)
  console.log(`Completed release dependencies: ${linked.length} additional workspace links`)
  // Node resolves a junctioned plugin from its snapshot directory. Link its
  // declared runtime dependencies there too, not only into the host profile.
  const pluginRequire = createRequire(join(plugin, 'package.json'))
  for (const dependency of Object.keys(json(join(plugin, 'package.json')).dependencies || {})) {
    const packagePath = pluginRequire.resolve(`${dependency}/package.json`)
    link(dirname(packagePath), join(pluginOutput, 'node_modules', dependency))
  }
  link(pluginOutput, join(profile, 'node_modules/prts-terrarchive'))
  const manifest = json(join(profile, 'package.json'))
  manifest.dependencies['prts-terrarchive'] = `file:${pluginOutput.split(sep).join('/')}`
  manifest.dsh.profile.bundles.push('prts-terrarchive')
  writeJson(join(profile, 'package.json'), manifest)
  mkdirSync(app, { recursive: true })
  link(join(desktop, 'renderer'), join(app, 'renderer'))
  writeJson(join(app, 'package.json'), { name: 'prts-terrarchive-test', productName: 'PRTS Terrarchive Test', version: versions.dsh.version, type: 'module', main: 'main.mjs' })
  const config = { id, testRoot, generation, profile, home, node, electron, corpus,
    pnpm: join(runtime, 'pnpm/bin/pnpm.mjs'), desktop, app, pluginSource: plugin, pluginSnapshot: pluginOutput,
    builtAt: new Date().toISOString(), ...snapshot }
  writeJson(join(app, 'config.json'), config)
  writeFileSync(join(app, 'main.mjs'), `import { readFileSync } from 'node:fs';\nimport { startTestDesktop } from ${JSON.stringify(pathToFileURL(join(root, 'electron/test-main.mjs')).href)};\nawait startTestDesktop(JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8')));\n`)
  await verifyTestProfile(config)
  firstRunSettings(home)
  publishCurrent(testRoot, config)
  console.log(`\nTest build ready: ${id}\nPlugin files: ${snapshot.files}; SHA-256: ${snapshot.sha256}\nOutput: ${generation}\nUser data: ${home}`)
  return config
}

export async function launchTestDesktop(config) {
  const verification = json(join(config.generation, 'verification.json'))
  if (!verification.passed || verification.build !== config.id || verification.pluginSha256 !== config.sha256) throw new Error('This test build has not passed its Host checks; rebuild it first.')
  await control(config.testRoot, 'quit')
  // The wrapper acknowledges only after the official Host has finished stopping.
  const log = join(config.testRoot, 'launch.log')
  appendFileSync(log, `\n[${new Date().toISOString()}] Starting test build ${config.id}\n`)
  const { openSync, closeSync } = await import('node:fs')
  const fd = openSync(log, 'a')
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.NODE_OPTIONS
  const child = spawn(config.electron, [config.app], { cwd: config.app, env: environment, detached: true, windowsHide: false, stdio: ['ignore', fd, fd] })
  closeSync(fd)
  await new Promise((settle, reject) => { child.once('spawn', settle); child.once('error', reject) })
  child.unref()
  const deadline = Date.now() + 60000
  let ready = false
  while (Date.now() < deadline) {
    const status = await control(config.testRoot, 'status')
    if (status?.ready) { ready = true; break }
    if (child.exitCode !== null) throw new Error(`Test desktop exited with ${child.exitCode}; see ${log}`)
    await new Promise(settle => setTimeout(settle, 400))
  }
  if (!ready) throw new Error(`Test desktop did not become ready; see ${log}`)
  appendFileSync(log, `[${new Date().toISOString()}] Test desktop ready: ${config.id}\n`)
  console.log('Test desktop opened. Existing test settings and sessions are preserved.')
}

async function main() {
  const { values } = parseArgs({ options: {
    plugin: { type: 'string' }, tools: { type: 'string' }, 'test-root': { type: 'string' },
    watch: { type: 'boolean' }, 'build-only': { type: 'boolean' }, 'run-only': { type: 'boolean' }, 'skip-rhine': { type: 'boolean' },
  } })
  if (process.platform !== 'win32') throw new Error('The desktop test entry requires Windows.')
  const options = { plugin: values.plugin, tools: values.tools, testRoot: values['test-root'], skipRhine: values['skip-rhine'] }
  const testRoot = resolve(options.testRoot || join(root, 'dist/PRTS-Terrarchive-Test'))
  if (!inside(join(root, 'dist'), testRoot)) throw new Error('Test output must be inside this builder dist directory')
  ensureTestRoot(testRoot)
  if (values['run-only']) {
    if (values.watch || values['build-only']) throw new Error('--run-only cannot be combined with --watch or --build-only')
    return launchTestDesktop(json(join(testRoot, 'current.json')))
  }
  const lock = join(testRoot, 'build.lock')
  try { writeFileSync(lock, String(process.pid), { flag: 'wx' }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const owner = Number(readFileSync(lock, 'utf8'))
    let alive = true
    try { process.kill(owner, 0) } catch (failure) { if (failure.code === 'ESRCH') alive = false; else throw failure }
    if (alive) throw new Error('A test build or watcher is already running; use the test window\'s Ctrl+Shift+R to apply its latest build.')
    unlinkSync(lock); writeFileSync(lock, String(process.pid), { flag: 'wx' })
  }
  const releaseLock = () => { if (existsSync(lock) && readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock) }
  process.once('exit', releaseLock)
  try {
    const config = await buildTestDesktop(options)
    if (!values['build-only']) await launchTestDesktop(config)
    if (!values.watch) return
    let timer
    const queue = buildQueue(async () => {
      await buildTestDesktop(options)
      await control(testRoot, 'updated')
      console.log('New build ready. Press Ctrl+Shift+R in the test window to restart with it; ongoing Agent work is left running.')
    }, error => console.error(`Build failed; previous test build remains usable.\n${error.stack || error}`))
    const watcher = watch(config.pluginSource, { recursive: true }, (_event, filename) => {
      if (!filename) return
      if (!shouldWatch(filename)) return
      clearTimeout(timer)
      timer = setTimeout(() => { void queue.request() }, 700)
    })
    console.log('Watching plugin source. Ctrl+C stops watching; the test desktop remains available.')
    await new Promise(settle => process.once('SIGINT', () => { clearTimeout(timer); watcher.close(); void queue.close().then(settle) }))
  } finally { releaseLock() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
}
