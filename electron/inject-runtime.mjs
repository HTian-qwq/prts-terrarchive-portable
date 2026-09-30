/** Add the local PRTS npm package to an already prepared DSH 0.1.7 Desktop runtime. */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

/** Embed the supported dependency closure, including js-yaml's parser CLI dependency. */
export function embedPrtsDependencies(plugin, source, dependencies = {}) {
  if (!Object.keys(dependencies).length) return // Current packages ship lib/runtime directly.
  const copy = (name, version, resolver) => {
    const path = dirname(realpathSync(resolver.resolve(name + '/package.json')))
    const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
    if (manifest.name !== name || manifest.version !== version) {
      throw new Error('Prepared DSH workspace has no matching PRTS dependency: ' + name + '@' + version)
    }
    const destination = join(plugin, 'node_modules', name)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(path, destination, { recursive: true, dereference: true })
    assertRegularPackageTree(destination)
    return createRequire(join(path, 'package.json'))
  }
  copy('zod', dependencies.zod, createRequire(join(source, 'packages/boot/plugin-manager/package.json')))
  if (dependencies['js-yaml']) {
    // Desktop pins 4.3.1; the workspace root still pins 4.2.0.
    const yaml = copy('js-yaml', dependencies['js-yaml'], createRequire(join(source, 'apps/desktop/package.json')))
    copy('argparse', '2.0.1', yaml)
  }
}

export function inspectPrtsTarball(tarball) {
  const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .trim().split(/\r?\n/u)
  const listing = execFileSync('tar', ['-tvzf', tarball], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .trim().split(/\r?\n/u)
  if (listing.length !== entries.length || listing.some(line => !['-', 'd'].includes(line[0]))) {
    throw new Error('PRTS tarball contains a link or unsupported entry')
  }
  if (!entries.every(name => name.startsWith('package/') && !name.includes('\\')
    && !name.split('/').includes('..'))
    || !['package/package.json', 'package/cordis.patch.yml', 'package/presets/definition.js',
      'package/presets/register.js', 'package/src/index.js'].every(name => entries.includes(name))) {
    throw new Error('PRTS npm tarball is missing the Desktop bundle or contains an unsafe path')
  }
  const manifest = JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], {
    encoding: 'utf8', maxBuffer: 1024 * 1024,
  }))
  const dependencies = manifest.dependencies ?? {}
  const selfContained = Object.keys(dependencies).length === 0
  if (selfContained && !['yaml.js', 'zod.js', 'versions.json', 'licenses/js-yaml-MIT.txt', 'licenses/zod-MIT.txt']
    .every(file => entries.includes('package/lib/runtime/' + file))) {
    throw new Error('PRTS tarball is missing its bundled runtime libraries or notices')
  }
  const supportedDependencies = selfContained || dependencies.zod === '4.4.3'
    && Object.keys(dependencies).every(name => name === 'zod' || name === 'js-yaml')
    && (dependencies['js-yaml'] === undefined || dependencies['js-yaml'] === '4.3.1')
  if (manifest.name !== 'prts-terrarchive' || typeof manifest.version !== 'string'
    || manifest.dsh?.bundle?.patch !== './cordis.patch.yml'
    || !supportedDependencies) {
    throw new Error('PRTS tarball must include its runtime libraries or declare legacy zod 4.4.3 and optional js-yaml 4.3.1')
  }
  return manifest
}

function assertRegularPackageTree(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    const stat = lstatSync(path)
    if (stat.isDirectory()) assertRegularPackageTree(path)
    else if (!stat.isFile()) throw new Error('PRTS package contains a link or unsupported filesystem entry')
  }
}

/** electron-builder packs node_modules in the ASAR by rewriting every package.json into
 *  a normalized form (removing keywords/bugs/scripts, 2-space indentation, no trailing newline).
 *  The runtime inventory verifies by bytes, so the local copy on disk must first be written in the same form,
 *  otherwise the smoke test's ASAR integrity verification will inevitably fail. */
function normalizeModuleManifests(root) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    if (lstatSync(path).isDirectory()) normalizeModuleManifests(path)
  }
  const manifestPath = join(root, 'package.json')
  if (!existsSync(manifestPath)) return
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  delete manifest.keywords
  delete manifest.bugs
  delete manifest.scripts
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
}

export async function injectPortableRuntime({ dshSource, tarball }) {
  const source = resolve(dshSource)
  const versions = JSON.parse(readFileSync(new URL('../versions.electron.current.json', import.meta.url), 'utf8'))
  const dshVersion = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version
  if (dshVersion !== versions.dsh.version) throw new Error('Prepared DSH version does not match the portable pin')
  const { resolveDesktopTargetBuildPaths } = await import(pathToFileURL(join(source,
    'apps/desktop/scripts/desktop-build-paths.mjs')).href)
  const { readDesktopRuntime, writeDesktopRuntime, verifyDesktopRuntime } = await import(pathToFileURL(join(source,
    'apps/desktop/src/runtime-tree.ts')).href)
  const paths = resolveDesktopTargetBuildPaths({ DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64' })
  const runtime = paths.dsh
  if (!existsSync(join(runtime, 'desktop-runtime.json'))) throw new Error('Prepare the official Desktop runtime first')
  const descriptor = readDesktopRuntime(runtime)
  if (descriptor.release.version !== versions.dsh.version || descriptor.platform !== 'win32' || descriptor.arch !== 'x64') {
    throw new Error('Prepared Desktop runtime has the wrong release or target')
  }
  const packed = inspectPrtsTarball(tarball)
  const directory = mkdtempSync(join(tmpdir(), 'prts-desktop-package-'))
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', directory])
    assertRegularPackageTree(join(directory, 'package'))
    const plugin = join(runtime, 'node_modules', packed.name)
    rmSync(plugin, { recursive: true, force: true })
    cpSync(join(directory, 'package'), plugin, { recursive: true })
    embedPrtsDependencies(plugin, source, packed.dependencies)
    normalizeModuleManifests(plugin)
    const dshManifestPath = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    const dshManifest = JSON.parse(readFileSync(dshManifestPath, 'utf8'))
    dshManifest.dependencies = { ...dshManifest.dependencies, [packed.name]: packed.version }
    writeFileSync(dshManifestPath, `${JSON.stringify(dshManifest, null, 2)}\n`)
    writeDesktopRuntime(runtime, descriptor.release,
      [...descriptor.sharedPackages.map(entry => entry.name), packed.name], { platform: 'win32', arch: 'x64' })
    await verifyDesktopRuntime(runtime, versions.dsh.version, { platform: 'win32', arch: 'x64' })
    console.log(`PRTS bundled in official Desktop runtime: ${packed.name}@${packed.version}`)
    return { version: packed.version, runtime }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { 'dsh-source': { type: 'string' }, tarball: { type: 'string' } } })
  if (!values['dsh-source'] || !values.tarball) throw new Error('usage: inject-runtime.mjs --dsh-source DIR --tarball FILE')
  await injectPortableRuntime({ dshSource: values['dsh-source'], tarball: values.tarball })
}
