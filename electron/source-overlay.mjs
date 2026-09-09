/** Apply the pinned community changes only to a disposable official Desktop build checkout. */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ownRoot = dirname(fileURLToPath(import.meta.url))
const builderRoot = dirname(ownRoot)

function replacement(source, before, after, subject) {
  if (source.includes(after)) {
    if (source.split(after).length !== 2) throw new Error(`Ambiguous applied overlay: ${subject}`)
    return source
  }
  if (source.split(before).length !== 2) throw new Error(`Pinned upstream overlay anchor changed: ${subject}`)
  return source.replace(before, after)
}

/** Return strict, repeatable source edits; kept separate from filesystem ownership checks for tests. */
export function overlaySource(relative, source) {
  if (relative === 'src/main.ts') {
    source = replacement(source, "import { resolveDesktopPaths } from './paths.ts'",
      "import { resolveDesktopPaths } from './paths.ts'\nimport { installPrtsWindowChrome } from './prts-window-chrome.ts'", relative)
    source = replacement(source, 'function createWindow(preload: string): BrowserWindow {',
      'function createWindow(preload: string, prtsChrome = false): BrowserWindow {', relative)
    source = replacement(source, '    show: false,\n    webPreferences:',
      "    show: false,\n    frame: !prtsChrome,\n    ...(prtsChrome ? { backgroundColor: '#f4f4f1' } : {}),\n    webPreferences:", relative)
    return replacement(source, '    const window = createWindow(appPreload)',
      '    const window = createWindow(appPreload, true)\n    installPrtsWindowChrome(window, development === undefined ? openPluginWindow : undefined)', relative)
  }
  if (relative === 'src/preload-app.ts') {
    return replacement(source, "import { contextBridge } from 'electron'",
      "import { contextBridge } from 'electron'\nimport './prts-window-preload.ts'", relative)
  }
  if (relative === 'scripts/prepare-runtime.ts') {
    return replacement(source,
      "  if (platform !== 'win') await chmod(destination, 0o755)",
      "  cpSync(join(extraction, folder, 'LICENSE'), join(destinationRoot, 'LICENSE'))\n  if (platform !== 'win') await chmod(destination, 0o755)", relative)
  }
  if (relative === 'src/core-package-set.ts') {
    source = replacement(source, "import { join } from 'node:path'",
      "import { join } from 'node:path'\nimport { prtsSeedPackageFiles } from './prts-seed-support.ts'", relative)
    return replacement(source, 'const expectedFiles = packageSet.packages.map(entry => entry.file).sort()',
      'const expectedFiles = [...packageSet.packages.map(entry => entry.file), ...prtsSeedPackageFiles(projectDir)].sort()', relative)
  }
  if (relative !== 'src/project-manager.ts') throw new Error(`Unknown overlay source: ${relative}`)
  source = replacement(source, "import { spawn } from 'node:child_process'",
    "import { spawn } from 'node:child_process'\nimport { desktopWorkspaceMatches } from './workspace-policy.ts'", relative)
  source = replacement(source,
    "readFileSync(join(projectDir, 'pnpm-workspace.yaml'), 'utf8') !== workspaceFile(expectedOverrides)",
    "!desktopWorkspaceMatches(readFileSync(join(projectDir, 'pnpm-workspace.yaml'), 'utf8'), workspaceFile(expectedOverrides))", relative)
  source = replacement(source, "import { extractPnpmStoreArchives, mergePnpmStore } from './seed-store.ts'",
    "import { extractPnpmStoreArchives, mergePnpmStore } from './seed-store.ts'\nimport { PRTS_SEED_FILE, reconcilePrtsSeedUpgrade, samePrtsSeedRevision } from './prts-seed-support.ts'", relative)
  source = replacement(source, '  DESKTOP_PACKAGE_SET_FILE,\n] as const',
    '  DESKTOP_PACKAGE_SET_FILE,\n  PRTS_SEED_FILE,\n] as const', relative)
  source = replacement(source,
    '        && this.installedPackageVersion(DESKTOP_HOST_PACKAGE) === target.version) {',
    '        && this.installedPackageVersion(DESKTOP_HOST_PACKAGE) === target.version\n        && samePrtsSeedRevision(this.paths.profile, seedDir)) {', relative)
  source = replacement(source,
    '        const remaining = pluginRecords(projectDir).filter(plugin => plugin.name !== mutation.name)',
    '        const remaining = pluginRecords(this.paths.profile).filter(plugin => plugin.name !== mutation.name)', relative)
  const before = [
    '          copyMetadata(seedDir, stagingProfile)',
    "          await this.runPnpm(stagingProfile, ['install', '--offline', '--frozen-lockfile', '--trust-lockfile'])",
    '          if (plugins.length > 0) {',
    '            await this.runPnpm(stagingProfile, [',
    "              'add',",
    '              ...plugins.map(plugin => `${plugin.name}@${plugin.version}`),',
    "              '--save-exact',",
    "              '--offline',",
    '            ])',
    '            writeProfilePlugins(stagingProfile, plugins)',
    '          }',
  ].join('\n')
  const after = `          copyMetadata(seedDir, stagingProfile)
          if (reconcilePrtsSeedUpgrade(this.paths.profile, stagingProfile, plugins)) {
            await this.runPnpm(stagingProfile, ['install', '--offline', '--no-frozen-lockfile', '--trust-lockfile'])
          } else {
${before.slice(before.indexOf('          await')).split('\n').map(line => '  ' + line).join('\n')}
          }`
  return replacement(source, before, after, relative)
}

export function applySourceOverlay(dshSource) {
  const target = realpathSync(resolve(dshSource))
  const expected = resolve(builderRoot, '.build/dsh-electron')
  if (!existsSync(expected) || lstatSync(expected).isSymbolicLink() || target !== realpathSync(expected)
    || !target.startsWith(realpathSync(builderRoot) + sep)) {
    throw new Error('Electron overlay only accepts this builder\'s .build/dsh-electron checkout; the upstream working tree is never edited')
  }
  const versions = JSON.parse(readFileSync(join(builderRoot, 'versions.electron.json'), 'utf8'))
  const commit = execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (commit !== versions.dsh.commit) throw new Error('Electron source checkout does not match the pinned commit')
  const desktop = join(target, 'apps/desktop')
  const templates = [
    { from: join(ownRoot, 'prts-seed-support.ts'), to: join(desktop, 'src/prts-seed-support.ts') },
    { from: join(ownRoot, 'workspace-policy.ts'), to: join(desktop, 'src/workspace-policy.ts') },
    { from: join(ownRoot, 'prts-window-chrome.ts'), to: join(desktop, 'src/prts-window-chrome.ts') },
    { from: join(ownRoot, 'prts-window-preload.ts'), to: join(desktop, 'src/prts-window-preload.ts') },
    { from: join(ownRoot, 'prepare-seed.ts'), to: join(desktop, 'scripts/prts-prepare-seed.ts') },
  ]
  for (const { from } of templates) readFileSync(from)
  const edits = ['src/main.ts', 'src/preload-app.ts', 'src/core-package-set.ts', 'src/project-manager.ts', 'scripts/prepare-runtime.ts'].map(relative => {
    const path = join(desktop, relative)
    return { path, body: overlaySource(relative, readFileSync(path, 'utf8')) }
  })
  for (const { path, body } of edits) writeFileSync(path, body)
  for (const { from, to } of templates) copyFileSync(from, to)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'dsh-source': { type: 'string' } }, allowPositionals: false })
  if (!values['dsh-source']) throw new Error('usage: source-overlay.mjs --dsh-source <.build/dsh-electron>')
  applySourceOverlay(values['dsh-source'])
}
