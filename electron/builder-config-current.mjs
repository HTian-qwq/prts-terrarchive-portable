/** Package the prepared official 0.1.7 Desktop runtime as an unsigned community portable client. */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import { officePackageDirectories } from '../../scripts/libreoffice-packages.mjs'
import { resolveDesktopTargetBuildPaths } from './scripts/desktop-build-paths.mjs'
import { prepareWindowsAsarUnpack, verifyWindowsAsarUnpack } from './scripts/windows-asar-unpack.mjs'

export function createCurrentBuilderConfig({ environment = process.env, appRoot = process.cwd() } = {}) {
  const portableRoot = environment.PRTS_PORTABLE_BUILDER_ROOT
  const output = environment.PRTS_ELECTRON_OUTPUT
  if (!portableRoot || !output) throw new Error('Set PRTS_PORTABLE_BUILDER_ROOT and PRTS_ELECTRON_OUTPUT')
  const root = resolve(portableRoot)
  const source = resolve(appRoot)
  const versions = JSON.parse(readFileSync(join(root, 'versions.electron.current.json'), 'utf8'))
  const desktop = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  if (desktop.version !== versions.dsh.version) throw new Error('Desktop and portable DSH versions differ')
  const target = resolveDesktopTargetBuildPaths({ DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64' })
  let windowsCode = []
  return {
    extends: null,
    appId: versions.appId,
    productName: versions.productName,
    executableName: versions.productName,
    electronVersion: versions.electron,
    electronDist: target.electron,
    electronFuses: { runAsNode: true },
    artifactName: 'PRTS-Terrarchive-Electron-${version}-windows-${arch}.${ext}',
    directories: { app: source, output: resolve(output) },
    asar: true,
    asarUnpack: ['**/*.{node,dylib,dll,so,exe}', '**/*.so.*', '**/spawn-helper', '**/@vscode/ripgrep-*/bin/rg'],
    files: [
      'portable-main.mjs', 'lib/main.js', 'lib/welcome/**/*',
      'lib/preload-app.cjs', 'lib/preload-mandatory.cjs', 'lib/preload-platform-account.cjs',
      'lib/preload-update-dialog.cjs', 'lib/preload-welcome.cjs', 'renderer/**/*', 'package.json',
      { from: target.dsh, to: 'dsh', filter: ['**/*'] },
      { from: join(target.dsh, 'node_modules'), to: 'dsh/node_modules', filter: ['**/*'] },
    ],
    extraMetadata: {
      main: 'portable-main.mjs', productName: versions.productName,
      prtsPortable: { version: versions.portable, appId: versions.appId, layout: 'client-v2' },
    },
    extraResources: [
      { from: target.runtime, to: 'runtime' },
      { from: join(source, 'resources', 'icon-windows.png'), to: 'icon.png' },
      { from: join(source, 'resources', 'tray-windows.ico'), to: 'tray.ico' },
    ],
    forceCodeSigning: false,
    win: {
      target: [{ target: 'dir', arch: ['x64'] }],
      icon: join(root, 'desktop', 'assets', 'prts-agent-p.ico'),
      forceCodeSigning: false,
      signExecutable: false,
      publish: null,
    },
    publish: null,
    async beforePack(context) {
      const office = await officePackageDirectories(target.dsh, { platform: 'win32', arch: 'x64' })
      const patterns = office.map(directory => `**/${relative(target.dsh, directory).split(sep).join('/')}/**/*`)
      const existing = context.packager.config.asarUnpack ?? []
      context.packager.config.asarUnpack = [...(typeof existing === 'string' ? [existing] : existing), ...patterns]
      windowsCode = await prepareWindowsAsarUnpack(context, target.dsh)
    },
    async afterPack(context) {
      const { verifyDesktopRuntime } = await import('./lib/types/runtime-tree.js')
      await verifyDesktopRuntime(target.dsh, versions.dsh.version, { platform: 'win32', arch: 'x64' })
      const resources = context.packager.getResourcesDir(context.appOutDir)
      await verifyWindowsAsarUnpack(target.dsh, resources, windowsCode)
      const reflink = join(resources, 'runtime', 'pnpm', 'dist', 'node_modules', '@reflink')
      for (const name of ['reflink-darwin-arm64', 'reflink-darwin-x64', 'reflink-win32-arm64-msvc']) {
        rmSync(join(reflink, name), { recursive: true, force: true })
      }
      if (existsSync(join(resources, 'app-update.yml'))) throw new Error('Portable app must not include an update feed')
    },
  }
}

export default function portableBuilderConfiguration(request) {
  return createCurrentBuilderConfig({ appRoot: request?.projectDir ?? process.cwd() })
}
