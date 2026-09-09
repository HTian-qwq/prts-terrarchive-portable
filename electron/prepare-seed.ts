/** Add the local PRTS package to a clean official seed, then prove and archive its offline installation. */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { verifySeedIntegrity } from '../src/project-manager.ts'
import { verifyDesktopCoreLockfile, verifyDesktopCorePackageSet } from '../src/core-package-set.ts'
import { archivePnpmStore, extractPnpmStoreArchives, removePnpmProjectRegistrations } from '../src/seed-store.ts'
import { createPrtsSeed, PRTS_PACKAGE, PRTS_SEED_FILE } from '../src/prts-seed-support.ts'
import { resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'

/** Write the same complete inventory checked by the official project manager on first launch. */
export function writePrtsSeedIntegrity(root: string): void {
  const files: { path: string; bytes: number; sha256: string }[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (path === join(root, 'integrity.json')) continue
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) {
        const body = readFileSync(path)
        files.push({ path: relative(root, path).split(sep).join('/'), bytes: body.byteLength,
          sha256: createHash('sha256').update(body).digest('hex') })
      } else throw new Error(`PRTS Desktop: unsupported seed entry ${path}`)
    }
  }
  visit(root)
  files.sort((left, right) => left.path.localeCompare(right.path))
  writeFileSync(join(root, 'integrity.json'), `${JSON.stringify({ schemaVersion: 2, files }, undefined, 2)}\n`)
}

/** Construct a new community seed without changing or accumulating old plugins in the official base seed. */
export async function preparePrtsSeed(options: {
  readonly baseSeed: string
  readonly output: string
  readonly pluginTarball: string
  readonly runtime: { readonly node: string; readonly pnpm: string }
}): Promise<void> {
  const { baseSeed, output, pluginTarball, runtime } = options
  if (resolve(baseSeed) === resolve(output)) throw new Error('PRTS Desktop: community output must differ from the official base seed')
  verifySeedIntegrity(baseSeed)
  if (existsSync(join(baseSeed, PRTS_SEED_FILE))) throw new Error('PRTS Desktop: expected a clean official seed')
  const release = JSON.parse(readFileSync(join(baseSeed, 'desktop-release.json'), 'utf8')) as { version: string }
  verifyDesktopCorePackageSet(baseSeed, release.version)
  const packed = JSON.parse(execFileSync('tar', ['-xOzf', pluginTarball, 'package/package.json'], {
    encoding: 'utf8', maxBuffer: 1024 * 1024,
  })) as { name?: string; version?: string; exports?: Record<string, unknown>; dsh?: { bundle?: { patch?: string } } }
  if (packed.name !== PRTS_PACKAGE || typeof packed.version !== 'string' || !packed.dsh?.bundle?.patch) {
    throw new Error('PRTS Desktop: tarball must contain the PRTS npm bundle')
  }
  const files = new Set(execFileSync('tar', ['-tzf', pluginTarball], { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim().split(/\r?\n/u))
  if (packed.exports?.['./presets'] !== './presets/register.js'
    || packed.dsh.bundle.patch !== './cordis.patch.yml'
    || !['package/presets/register.js', 'package/cordis.patch.yml', 'package/src/index.js'].every(path => files.has(path))) {
    throw new Error('PRTS Desktop: package is missing the Electron-compatible bundle or preset registration')
  }
  const body = readFileSync(pluginTarball)
  const hash = createHash('sha256').update(body).digest('hex')
  const file = `${PRTS_PACKAGE}-${hash}.tgz`
  const seed = createPrtsSeed({ name: PRTS_PACKAGE, version: packed.version, file, bytes: body.byteLength,
    integrity: `sha512-${createHash('sha512').update(body).digest('base64')}` })
  mkdirSync(dirname(output), { recursive: true })
  const temporary = mkdtempSync(join(dirname(output), '.prts-seed-'))
  const staging = join(temporary, 'seed')
  const store = join(staging, 'store')
  const config = join(temporary, 'pnpm-config')
  const npmrc = join(config, 'npmrc')
  mkdirSync(config)
  writeFileSync(npmrc, '')
  const runPnpm = (args: string[]): Promise<void> => new Promise((settle, reject) => {
    const child = spawn(runtime.node, [runtime.pnpm,
      '--config.registry=https://registry.npmjs.org/', `--config.store-dir=${store}`,
      '--config.enable-global-virtual-store=false', `--config.userconfig=${npmrc}`, ...args,
    ], {
      cwd: staging,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) =>
          !/^DSH_DESKTOP_/u.test(name) && !/^(?:npm|pnpm|corepack)_/iu.test(name))),
        NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/', NPM_CONFIG_STORE_DIR: store,
        NPM_CONFIG_USERCONFIG: npmrc, PATH: `${dirname(runtime.node)}${delimiter}${process.env.PATH ?? ''}`,
        XDG_CACHE_HOME: join(temporary, 'cache'), XDG_CONFIG_HOME: config,
        XDG_STATE_HOME: join(temporary, 'state'),
      },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (code, signal) => code === 0 ? settle()
      : reject(new Error(`PRTS seed: pnpm exited with ${String(code ?? signal)}`)))
  })
  try {
    cpSync(baseSeed, staging, { recursive: true, filter: () => true })
    extractPnpmStoreArchives(staging, store)
    copyFileSync(pluginTarball, join(staging, 'desktop-packages', file))
    writeFileSync(join(staging, PRTS_SEED_FILE), `${JSON.stringify(seed, undefined, 2)}\n`)
    const manifestPath = join(staging, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } }
    }
    manifest.dependencies[PRTS_PACKAGE] = `file:./desktop-packages/${file}`
    manifest.dsh.profile.bundles.push(PRTS_PACKAGE)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
    await runPnpm(['install', '--no-frozen-lockfile', '--ignore-scripts'])
    const packageSet = verifyDesktopCorePackageSet(staging, release.version)
    verifyDesktopCoreLockfile(readFileSync(join(staging, 'pnpm-lock.yaml'), 'utf8'), packageSet)
    rmSync(join(staging, 'node_modules'), { recursive: true, force: true })
    await runPnpm(['install', '--offline', '--frozen-lockfile', '--trust-lockfile'])
    const installed = JSON.parse(readFileSync(join(staging, 'node_modules', PRTS_PACKAGE, 'package.json'), 'utf8')) as { version: string }
    if (installed.version !== packed.version) throw new Error('PRTS Desktop: offline installed plugin version does not match its tarball')
    rmSync(join(staging, 'node_modules'), { recursive: true, force: true })
    removePnpmProjectRegistrations(store)
    archivePnpmStore(staging, store)
    writePrtsSeedIntegrity(staging)
    verifySeedIntegrity(staging)
    rmSync(output, { recursive: true, force: true })
    renameSync(staging, output)
    console.log(`PRTS Desktop seed: ${packed.version}, revision ${seed.revision}`)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { 'plugin-tarball': { type: 'string' } }, allowPositionals: false })
  if (!values['plugin-tarball']) throw new Error('usage: prts-prepare-seed.ts --plugin-tarball <prts-terrarchive.tgz>')
  const paths = resolveDesktopTargetBuildPaths()
  await preparePrtsSeed({ baseSeed: paths.seed, output: join(paths.root, 'prts-seed'),
    pluginTarball: resolve(values['plugin-tarball']), runtime: {
      node: join(paths.runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
      pnpm: join(paths.runtime, 'pnpm', 'bin', 'pnpm.mjs'),
    } })
}
