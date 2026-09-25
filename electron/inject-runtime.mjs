/** Add the local PRTS npm package to an already prepared DSH 0.1.7 Desktop runtime. */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

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
  if (manifest.name !== 'prts-terrarchive' || typeof manifest.version !== 'string'
    || manifest.dsh?.bundle?.patch !== './cordis.patch.yml'
    || Object.keys(dependencies).length !== 1 || dependencies.zod !== '4.4.3') {
    throw new Error('PRTS tarball must be the pinned prts-terrarchive Desktop bundle with zod 4.4.3')
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
    // The npm tarball does not contain dependencies. Embed the exact installed
    // zod release under PRTS so the offline Host can resolve direct imports.
    const requireDsh = createRequire(join(source, 'packages/boot/plugin-manager/package.json'))
    const zodPath = dirname(realpathSync(requireDsh.resolve('zod/package.json')))
    const zodManifest = JSON.parse(readFileSync(join(zodPath, 'package.json'), 'utf8'))
    if (zodManifest.name !== 'zod' || zodManifest.version !== packed.dependencies.zod) {
      throw new Error('Prepared DSH workspace has no matching PRTS zod dependency')
    }
    mkdirSync(join(plugin, 'node_modules'), { recursive: true })
    cpSync(zodPath, join(plugin, 'node_modules', 'zod'), { recursive: true, dereference: true })
    assertRegularPackageTree(join(plugin, 'node_modules', 'zod'))
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
