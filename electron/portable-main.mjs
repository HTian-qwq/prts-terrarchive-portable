/** Locate portable data before the official Electron main module is evaluated. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'

const LEGACY_HOME_PATCH = '# Portable first-run mode; existing user settings take priority.\n- id: agent-presets\n  config:\n    default: prts\n'
const CURRENT_HOME_PATCH = '# Portable first-run mode; existing user settings take priority.\n- id: agent-preset-registry\n  config:\n    default: prts\n'

function writeFirstRunFile(path, contents) {
  try {
    writeFileSync(path, contents, { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
}

/** Carry the new Desktop profile without installing anything on the user's machine. */
export function prepareCurrentProfile(dataRoot) {
  const profile = join(dataRoot, 'profiles', 'desktop')
  const marker = join(dataRoot, '.prts-desktop-profile-v2')
  const manifestPath = join(profile, 'package.json')
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.name === '@deepseek-ai/dsh-desktop-runtime') {
      // The 0.1.5 profile installed its own core packages. Keep it intact for
      // rollback: the 0.1.7 Host must use the new immutable bundled runtime.
      let backup = join(dataRoot, 'profiles', 'desktop.pre-0.1.7')
      for (let number = 1; existsSync(backup); number++) backup = join(dataRoot, 'profiles', `desktop.pre-0.1.7-${number}`)
      renameSync(profile, backup)
    } else if (manifest.name !== 'dsh-profile-desktop' || !Array.isArray(manifest.dsh?.profile?.bundles)) {
      throw new Error('Desktop profile manifest is not recognized; preserve userdata and inspect profiles/desktop/package.json')
    } else if (!existsSync(marker) && !manifest.dsh.profile.bundles.includes('prts-terrarchive')) {
      manifest.dsh.profile.bundles.push('prts-terrarchive')
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    }
  }
  mkdirSync(profile, { recursive: true })
  writeFirstRunFile(manifestPath, `${JSON.stringify({
    name: 'dsh-profile-desktop', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'prts-terrarchive'] } },
  }, null, 2)}\n`)
  writeFirstRunFile(marker, 'DSH 0.1.7 bundled PRTS profile\n')
  return profile
}

/** Configure portable paths synchronously, before Electron creates its sessions. */
export function configurePortableElectron(application, {
  executable = process.execPath,
  environment = process.env,
  branding = {},
} = {}) {
  const executableRoot = dirname(resolve(executable))
  if (['client-v1', 'client-v2'].includes(branding.layout) && basename(executableRoot).toLowerCase() !== 'client') {
    throw new Error('PRTS Electron 主程序应位于 client/ 中，请完整解压新版便携包。')
  }
  // Metadata selects the layout explicitly: old flat packages (even one named
  // "client") retain their own data directory. Direct client launches also work.
  const appRoot = ['client-v1', 'client-v2'].includes(branding.layout) ? dirname(executableRoot) : executableRoot
  const dataRoot = join(appRoot, 'userdata')
  const electronRoot = join(dataRoot, 'electron')
  const sessionRoot = join(electronRoot, 'session')
  const crashRoot = join(electronRoot, 'crash-dumps')
  const logsRoot = join(dataRoot, 'logs')
  for (const directory of [sessionRoot, crashRoot, logsRoot]) mkdirSync(directory, { recursive: true })

  environment.DSH_HOME = dataRoot
  environment.PRTS_PORTABLE = '1'
  environment.PRTS_CORPUS_RELEASES_DIR = join(appRoot, 'corpus', 'releases')
  application.setPath('userData', electronRoot)
  application.setPath('sessionData', sessionRoot)
  application.setPath('crashDumps', crashRoot)
  application.setAppLogsPath(logsRoot)
  if (branding.productName) application.setName(branding.productName)
  if (branding.appId) application.setAppUserModelId(branding.appId)

  // The Host's settings remain above this default. Do not reference the PRTS
  // plugin row here: uninstalling the plugin must leave a loadable home patch.
  if (branding.layout === 'client-v2') prepareCurrentProfile(dataRoot)
  const homePatch = join(dataRoot, 'cordis.patch.yml')
  const hadHomePatch = existsSync(homePatch)
  if (branding.layout === 'client-v2' && hadHomePatch && readFileSync(homePatch, 'utf8') === LEGACY_HOME_PATCH) {
    writeFileSync(homePatch, CURRENT_HOME_PATCH)
  }
  writeFirstRunFile(homePatch, branding.layout === 'client-v2' ? CURRENT_HOME_PATCH : LEGACY_HOME_PATCH)
  // An existing home patch may already specify a skin. Preserve it as well as
  // the JSON user layer written when someone changes skins in the settings UI.
  if (!hadHomePatch) {
    writeFirstRunFile(join(dataRoot, 'prts-corpus.json'), '{\n  "uiSkin": "prts-agent"\n}\n')
  }
  return { appRoot, dataRoot, electronRoot, sessionRoot }
}

/** Enter the official shell only after portable ownership and defaults are ready. */
export async function startPortableElectron(application, options = {}, loadMain = () => import('./lib/main.js')) {
  const paths = configurePortableElectron(application, options)
  await loadMain()
  return paths
}

if (process.versions.electron) {
  // Synchronous Electron loading keeps setPath ahead of the first ready tick;
  // the official module is intentionally imported only after this setup.
  const { app, dialog } = createRequire(import.meta.url)('electron')
  try {
    const metadata = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    await startPortableElectron(app, { branding: {
      productName: metadata.productName,
      appId: metadata.prtsPortable.appId,
      layout: metadata.prtsPortable.layout,
    } })
  } catch (error) {
    dialog.showErrorBox('PRTS Terrarchive 启动失败', error instanceof Error ? error.message : String(error))
    app.exit(1)
  }
}
