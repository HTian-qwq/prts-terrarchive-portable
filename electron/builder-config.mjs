/** Package the official shell with portable ownership and community branding. */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Create the unsigned Windows shell configuration from prepared upstream files. */
export function createPortableBuilderConfig({
  environment = process.env,
  portableRoot = environment.PRTS_PORTABLE_BUILDER_ROOT,
  appRoot = process.cwd(),
  output = environment.PRTS_ELECTRON_OUTPUT,
} = {}) {
  if (!portableRoot || !output) throw new Error('Set PRTS_PORTABLE_BUILDER_ROOT and PRTS_ELECTRON_OUTPUT before packaging')
  const source = resolve(appRoot)
  const root = resolve(portableRoot)
  const versions = JSON.parse(readFileSync(join(root, 'versions.electron.json'), 'utf8'))
  const desktop = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  if (desktop.version !== versions.dsh.version) {
    throw new Error(`Electron shell version ${desktop.version} does not match the prepared DSH release ${versions.dsh.version}`)
  }
  const targetRoot = join(source, '.desktop-build', 'targets', 'win-x64')
  const artifacts = resolve(output)
  return {
    // Do not inherit the upstream release config: evaluating it requires the
    // official EV signer and selects DeepSeek's signed update stream.
    extends: null,
    appId: versions.appId,
    productName: versions.productName,
    executableName: versions.productName,
    electronVersion: versions.electron,
    artifactName: 'PRTS-Terrarchive-Electron-${version}-windows-${arch}.${ext}',
    directories: { app: source, output: artifacts },
    asar: true,
    files: ['portable-main.mjs', 'lib/*.js', 'lib/*.cjs', 'renderer/**/*', 'package.json'],
    extraMetadata: {
      main: 'portable-main.mjs',
      productName: versions.productName,
      prtsPortable: { version: versions.portable, appId: versions.appId },
    },
    extraResources: [
      { from: join(targetRoot, 'runtime'), to: 'runtime' },
      { from: join(targetRoot, 'prts-seed'), to: 'seed' },
    ],
    forceCodeSigning: false,
    win: {
      target: [{ target: 'dir', arch: ['x64'] }],
      icon: join(root, 'desktop', 'assets', 'prts-agent-p.ico'),
      forceCodeSigning: false,
      // electron-builder 26.15.3 keeps EXE icon/metadata editing with this flag.
      signExecutable: false,
      publish: null,
    },
    publish: null,
    afterPack({ appOutDir }) {
      // pnpm 11.7 ships these optional native packages together on every OS.
      // Prune only the generated Windows x64 copy, after extraResources lands;
      // keep the shared loader, Windows x64 binding, and prepared runtime intact.
      const scope = join(appOutDir, 'resources', 'runtime', 'pnpm', 'dist', 'node_modules', '@reflink')
      for (const name of ['reflink-darwin-arm64', 'reflink-darwin-x64', 'reflink-win32-arm64-msvc']) {
        rmSync(join(scope, name), { recursive: true, force: true })
      }
    },
    afterAllArtifactBuild() {
      // Upstream disables its updater when this resource is absent. Refuse a
      // stale or accidentally generated update feed before outer ZIP assembly.
      if (existsSync(join(artifacts, 'win-unpacked', 'resources', 'app-update.yml'))) {
        throw new Error('The portable Electron shell must not contain app-update.yml')
      }
      return []
    },
  }
}

/** electron-builder calls the factory after reading its project directory. */
export default function portableBuilderConfiguration(request) {
  return createPortableBuilderConfig({ appRoot: request?.projectDir ?? process.cwd() })
}
