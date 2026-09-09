import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applySourceOverlay, overlaySource } from '../electron/source-overlay.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dsh = resolve(process.env.PRTS_DSH_SOURCE || join(root, '../deepseek-harness'))
const pnpmCandidates = [process.env.PRTS_PNPM_ENTRY,
  join(dsh, 'apps/desktop/node_modules/pnpm/bin/pnpm.mjs'),
  join(dsh, 'node_modules/pnpm/bin/pnpm.mjs'),
  join(process.env.HOME || '', '.local/share/pnpm/.tools/pnpm/11.7.0/node_modules/pnpm/bin/pnpm.mjs'),
].filter(Boolean)
const pnpm = pnpmCandidates.find(path => existsSync(path))
const supported = existsSync(join(dsh, 'apps/desktop/src/project-manager.ts')) && pnpm
const integration = (name, fn) => test(name, {
  skip: supported ? false : 'Set PRTS_DSH_SOURCE and PRTS_PNPM_ENTRY for real official Desktop + pnpm integration',
}, fn)

let api
if (supported) {
  const requireDsh = createRequire(join(dsh, 'package.json'))
  const { register } = await import(pathToFileURL(requireDsh.resolve('tsx/esm/api')).href)
  const unregister = register({ tsconfig: join(dsh, 'tsconfig.base.json') })
  after(unregister)
  const source = mkdtempSync(join(tmpdir(), 'prts-electron-source-test-'))
  after(() => rmSync(source, { recursive: true, force: true }))
  writeFileSync(join(source, 'package.json'), '{"type":"module"}')
  mkdirSync(join(source, 'node_modules'))
  for (const name of ['tar', 'semver', 'js-yaml']) {
    const store = join(dsh, 'node_modules/.pnpm')
    const installed = readdirSync(store).find(entry => entry.startsWith(`${name}@`))
    assert(installed, `DSH workspace must have ${name} installed`)
    symlinkSync(join(store, installed, 'node_modules', name), join(source, 'node_modules', name),
      process.platform === 'win32' ? 'junction' : 'dir')
  }
  for (const directory of ['src', 'scripts']) mkdirSync(join(source, directory))
  for (const file of ['project-manager.ts', 'core-package-set.ts', 'seed-store.ts', 'release.ts', 'host-protocol.ts', 'paths.ts']) {
    const original = readFileSync(join(dsh, 'apps/desktop/src', file), 'utf8')
    writeFileSync(join(source, 'src', file), ['project-manager.ts', 'core-package-set.ts'].includes(file)
      ? overlaySource(`src/${file}`, original) : original)
  }
  cpSync(join(root, 'electron/prts-seed-support.ts'), join(source, 'src/prts-seed-support.ts'))
  cpSync(join(root, 'electron/workspace-policy.ts'), join(source, 'src/workspace-policy.ts'))
  cpSync(join(root, 'electron/prepare-seed.ts'), join(source, 'scripts/prts-prepare-seed.ts'))
  cpSync(join(dsh, 'apps/desktop/scripts/desktop-build-paths.mjs'), join(source, 'scripts/desktop-build-paths.mjs'))
  api = Object.assign({}, ...await Promise.all([
    'src/project-manager.ts', 'src/core-package-set.ts', 'src/seed-store.ts', 'src/paths.ts',
    'src/host-protocol.ts', 'src/workspace-policy.ts', 'scripts/prts-prepare-seed.ts',
  ].map(file => import(pathToFileURL(join(source, file)).href))))
}

test('Desktop overlay refuses the upstream working tree', () => {
  assert.throws(() => applySourceOverlay(existsSync(dsh) ? dsh : root), /only accepts this builder/u)
})

integration('Pinned Desktop source overlays are exact and idempotent', () => {
  for (const file of ['src/project-manager.ts', 'src/core-package-set.ts', 'scripts/prepare-runtime.ts']) {
    const original = readFileSync(join(dsh, 'apps/desktop', file), 'utf8')
    const once = overlaySource(file, original)
    assert.notEqual(once, original)
    assert.equal(overlaySource(file, once), once)
    assert.throws(() => overlaySource(file, '// changed upstream'), /anchor changed/u)
  }
})

integration('Desktop workspace policy keeps core overrides and build permissions exact', () => {
  const expected = {
    packages: ['.'], overrides: { '@deepseek-ai/dsh': 'file:./desktop-packages/dsh.tgz' },
    nodeLinker: 'hoisted', autoInstallPeers: false, strictDepBuilds: true,
    allowBuilds: { 'node-pty': true, protobufjs: false },
  }
  const check = value => api.desktopWorkspaceMatches(JSON.stringify(value), JSON.stringify(expected))
  assert.equal(check({ ...expected, minimumReleaseAgeExclude: ['@deepseek-ai/node-addon-system-linux-x64@0.1.2'] }), true)
  assert.equal(check(Object.fromEntries(Object.entries(expected).reverse())), true)
  for (const value of [
    null, [], { ...expected, overrides: {} }, { ...expected, packages: ['*'] },
    { ...expected, allowBuilds: { ...expected.allowBuilds, protobufjs: true } },
    { ...expected, minimumReleaseAgeExclude: '*' },
    { ...expected, minimumReleaseAgeExclude: ['@deepseek-ai/*'] },
    { ...expected, minimumReleaseAgeExclude: [false] },
    { ...expected, minimumReleaseAge: 0 },
  ]) assert.equal(check(value), false)
  assert.equal(api.desktopWorkspaceMatches('packages: [', JSON.stringify(expected)), false)
  assert.equal(api.desktopWorkspaceMatches('packages: [.]\npackages: [.]\n', JSON.stringify(expected)), false)
})

function pack(directory, name, version, marker, plugin = true) {
  const source = mkdtempSync(join(directory, 'package-source-'))
  mkdirSync(join(source, 'package'))
  writeFileSync(join(source, 'package/package.json'), JSON.stringify({ name, version,
    ...(plugin ? { dsh: { bundle: { patch: './bundle.yml' } } } : {}),
    ...(name === 'prts-terrarchive' ? { dsh: { bundle: { patch: './cordis.patch.yml' } },
      exports: { './presets': './presets/register.js' } } : {}),
  }))
  writeFileSync(join(source, 'package/bundle.yml'), '[]\n')
  writeFileSync(join(source, 'package/marker.txt'), marker)
  if (name === 'prts-terrarchive') {
    mkdirSync(join(source, 'package/presets'))
    mkdirSync(join(source, 'package/src'))
    writeFileSync(join(source, 'package/presets/register.js'), '')
    writeFileSync(join(source, 'package/src/index.js'), '')
    writeFileSync(join(source, 'package/cordis.patch.yml'), '[]\n')
  }
  const path = join(directory, `${name.replaceAll(/[@/]/gu, '-')}-${version}-${marker}.tgz`)
  execFileSync('tar', ['-czf', path, '-C', source, 'package'])
  rmSync(source, { recursive: true, force: true })
  return path
}

async function fixture(t, { pnpmAgeExclusions = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prts-electron-seed-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
  const registryPackages = new Map()
  let registryRequests = 0
  const registry = createServer((request, response) => {
    registryRequests += 1
    const pathname = new URL(request.url, 'http://localhost').pathname
    const name = pathname.split('/')[1]
    const entry = registryPackages.get(name)
    if (!entry) { response.writeHead(404).end(); return }
    if (pathname.includes('/-/')) { response.end(readFileSync(entry.path)); return }
    const body = readFileSync(entry.path)
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ name, 'dist-tags': { latest: entry.version }, versions: {
      [entry.version]: { name, version: entry.version, dsh: { bundle: { patch: './bundle.yml' } }, dist: {
        tarball: `${origin}/${name}/-/${name}-${entry.version}.tgz`,
        shasum: createHash('sha1').update(body).digest('hex'),
        integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`,
      } },
    } }))
  })
  await new Promise(resolveReady => registry.listen(0, '127.0.0.1', resolveReady))
  const origin = `http://127.0.0.1:${registry.address().port}`
  const closeRegistry = () => new Promise(resolveClosed => {
    registry.close(resolveClosed)
    registry.closeAllConnections()
  })
  t.after(closeRegistry)
  const wrapper = join(dir, 'pnpm-wrapper.mjs')
  // Keep real pnpm and manager transactions; only route the external npm registry to this test's fixture.
  writeFileSync(wrapper, `process.argv = process.argv.map(value => value.startsWith('--config.registry=') ? ${JSON.stringify(`--config.registry=${origin}/`)} : value);\nprocess.env.NPM_CONFIG_REGISTRY = ${JSON.stringify(`${origin}/`)};\nawait import(${JSON.stringify(pathToFileURL(pnpm).href)});\n`)
  const runtime = { node: process.execPath, pnpm: wrapper }
  const base = join(dir, 'official-seed')
  const packagesDir = join(base, 'desktop-packages')
  mkdirSync(packagesDir, { recursive: true })
  const version = '0.1.5-alpha.1'
  const records = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host'].map(name => {
    const tarball = pack(dir, name, version, 'core', false)
    const body = readFileSync(tarball)
    const file = `${name.replaceAll(/[@/]/gu, '-')}.tgz`.replace(/^-+/u, '')
    cpSync(tarball, join(packagesDir, file))
    return { name, version, file, bytes: body.length,
      integrity: `sha512-${createHash('sha512').update(body).digest('base64')}` }
  }).sort((left, right) => left.name.localeCompare(right.name))
  writeFileSync(join(base, 'desktop-packages.json'), JSON.stringify({ schemaVersion: 1, packages: records }))
  api.createSeedMetadata(base, { schemaVersion: 1, version, hostProtocolVersion: api.DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: process.versions.node, pnpmVersion: '11.7.0' })
  if (pnpmAgeExclusions) {
    // pnpm uses this same YAML writer when it automatically records young
    // transitive versions, as in the real Windows build's base seed.
    execFileSync(process.execPath, [pnpm, 'config', 'set', '--location=project', '--json',
      'minimumReleaseAgeExclude', JSON.stringify([
        '@deepseek-ai/node-addon-system-darwin-arm64@0.1.2',
        '@deepseek-ai/node-addon-system-darwin-x64@0.1.2',
        '@deepseek-ai/node-addon-system-linux-arm64@0.1.2',
        '@deepseek-ai/node-addon-system-linux-x64@0.1.2',
      ])], { cwd: base, stdio: 'pipe' })
  }
  // Core packages are all local; this populates the same store later merged by the real manager.
  const { spawn } = await import('node:child_process')
  await new Promise((resolveDone, reject) => {
    const child = spawn(process.execPath, [pnpm, '--config.enable-global-virtual-store=false',
      `--config.store-dir=${join(base, 'store')}`, 'install', '--offline'], { cwd: base, stdio: 'pipe' })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolveDone() : reject(new Error(output)))
  })
  rmSync(join(base, 'node_modules'), { recursive: true, force: true })
  api.removePnpmProjectRegistrations(join(base, 'store'))
  api.archivePnpmStore(base, join(base, 'store'))
  api.writePrtsSeedIntegrity(base)
  const makeSeed = async marker => {
    const output = join(dir, `seed-${marker}`)
    await api.preparePrtsSeed({ baseSeed: base, output, pluginTarball: pack(dir, 'prts-terrarchive', '0.1.0', marker), runtime })
    return output
  }
  const seedA = await makeSeed('A')
  const seedB = await makeSeed('B')
  let manager = new api.DesktopProjectManager(api.resolveDesktopPaths(join(dir, 'userdata')), runtime)
  const hooks = { healthCheck: async directory => {
    assert(existsSync(join(directory, 'node_modules/@deepseek-ai/dsh/package.json')))
  }, beforeActivate: async () => {}, afterActivate: async () => {} }
  const apply = (seed, overrides = {}) => manager.applyRelease(seed, version, { ...hooks, ...overrides })
  const marker = name => readFileSync(join(manager.paths.profile, 'node_modules', name, 'marker.txt'), 'utf8')
  const relocate = () => {
    const destination = join(dir, 'moved 用户数据')
    renameSync(join(dir, 'userdata'), destination)
    manager = new api.DesktopProjectManager(api.resolveDesktopPaths(destination), runtime)
  }
  return { dir, base, seedA, seedB, get manager() { return manager }, hooks, apply, marker,
    registryPackages, get registryRequests() { return registryRequests }, closeRegistry, relocate }
}

integration('Official manager installs offline and replaces a changed PRTS tarball at the same DSH/npm version, with rollback', async t => {
  const f = await fixture(t)
  await f.closeRegistry()
  assert.equal(await f.apply(f.seedA), true)
  assert.equal(f.marker('prts-terrarchive'), 'A')
  assert.equal(await f.apply(f.seedA), false)
  f.relocate()
  assert.equal(f.marker('prts-terrarchive'), 'A')
  await assert.rejects(() => f.apply(f.seedB, { healthCheck: async () => { throw new Error('health failure') } }), /health failure/u)
  assert.equal(f.marker('prts-terrarchive'), 'A')
  assert.equal(await f.apply(f.seedB), true)
  assert.equal(f.marker('prts-terrarchive'), 'B')
  assert.equal(await f.apply(f.seedB), false)
  const manifest = JSON.parse(readFileSync(join(f.manager.paths.profile, 'package.json'), 'utf8'))
  assert.match(manifest.dependencies['prts-terrarchive'], /^file:\.\/desktop-packages\//u)
  const core = api.verifyDesktopCorePackageSet(f.manager.paths.profile, '0.1.5-alpha.1')
  assert.equal(core.packages.some(record => record.name === 'prts-terrarchive'), false)
  const metadata = JSON.parse(readFileSync(join(f.seedB, 'prts-seed.json'), 'utf8'))
  writeFileSync(join(f.seedB, 'desktop-packages', metadata.packages[0].file), 'corrupt')
  await assert.rejects(() => f.apply(f.seedB), /integrity verification failed/u)
  assert.equal(f.marker('prts-terrarchive'), 'B')
})

integration('Registry PRTS updates, removals, and third-party bundles survive offline community seed upgrades', async t => {
  const f = await fixture(t)
  await f.apply(f.seedA)
  f.registryPackages.set('prts-terrarchive', { version: '0.2.0', path: pack(f.dir, 'prts-terrarchive', '0.2.0', 'user') })
  f.registryPackages.set('test-third-party', { version: '1.0.0', path: pack(f.dir, 'test-third-party', '1.0.0', 'third') })
  await f.manager.mutate({ type: 'plugin-update', name: 'prts-terrarchive', version: '0.2.0' }, f.hooks)
  await f.manager.mutate({ type: 'plugin-add', spec: 'test-third-party@1.0.0' }, f.hooks)
  const beforeUpgrade = f.registryRequests
  assert.equal(await f.apply(f.seedB), true)
  assert.equal(f.registryRequests, beforeUpgrade, 'seed reconciliation must not contact the registry')
  assert.equal(f.marker('prts-terrarchive'), 'user')
  assert.equal(f.marker('test-third-party'), 'third')
  await f.manager.mutate({ type: 'plugin-remove', name: 'prts-terrarchive' }, f.hooks)
  await f.closeRegistry()
  assert.equal(await f.apply(f.seedA), true)
  assert.deepEqual(f.manager.listPlugins(), [{ name: 'test-third-party', version: '1.0.0' }])
  assert.equal(f.marker('test-third-party'), 'third')
})

integration('Official manager accepts pnpm workspace updates through offline install and seed upgrade', async t => {
  const f = await fixture(t, { pnpmAgeExclusions: true })
  await f.closeRegistry()
  assert.equal(await f.apply(f.seedA), true)
  assert.deepEqual(f.manager.listPlugins(), [{ name: 'prts-terrarchive', version: '0.1.0' }])
  const workspace = join(f.manager.paths.profile, 'pnpm-workspace.yaml')
  const original = readFileSync(workspace, 'utf8')
  assert.match(original, /minimumReleaseAgeExclude/u)
  assert.equal(await f.apply(f.seedB), true)
  assert.equal(f.marker('prts-terrarchive'), 'B')
  assert.deepEqual(f.manager.listPlugins(), [{ name: 'prts-terrarchive', version: '0.1.0' }])
  assert.equal(readFileSync(workspace, 'utf8'), original, 'preserve pnpm policy metadata unchanged')
  writeFileSync(workspace, '# Windows comments and CRLF\r\n' + original.replaceAll('\n', '\r\n'))
  assert.deepEqual(f.manager.listPlugins(), [{ name: 'prts-terrarchive', version: '0.1.0' }])
  for (const tampered of [
    original.replace('strictDepBuilds: true', 'strictDepBuilds: false'),
    original.replace(/file:\.\/desktop-packages\/[^\s"']+/u, '1.0.0'),
    original + '\nignoreScripts: false\n',
  ]) {
    writeFileSync(workspace, tampered)
    assert.throws(() => f.manager.listPlugins(), /core package mapping/u)
  }
  writeFileSync(workspace, original)
  await f.manager.mutate({ type: 'plugin-remove', name: 'prts-terrarchive' }, f.hooks)
  assert.deepEqual(f.manager.listPlugins(), [])
})
