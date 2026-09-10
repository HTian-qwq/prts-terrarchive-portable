/** Locate portable data before the official Electron main module is evaluated. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'

function writeFirstRunFile(path, contents) {
  try {
    writeFileSync(path, contents, { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
}

/** Configure portable paths synchronously, before Electron creates its sessions. */
export function configurePortableElectron(application, {
  executable = process.execPath,
  environment = process.env,
  branding = {},
} = {}) {
  const executableRoot = dirname(resolve(executable))
  if (branding.layout === 'client-v1' && basename(executableRoot).toLowerCase() !== 'client') {
    throw new Error('PRTS Electron 主程序应位于 client/ 中，请完整解压新版便携包。')
  }
  // Metadata selects the layout explicitly: old flat packages (even one named
  // "client") retain their own data directory. Direct client launches also work.
  const appRoot = branding.layout === 'client-v1' ? dirname(executableRoot) : executableRoot
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
  const homePatch = join(dataRoot, 'cordis.patch.yml')
  const hadHomePatch = existsSync(homePatch)
  writeFirstRunFile(homePatch, '# Portable first-run mode; existing user settings take priority.\n- id: agent-presets\n  config:\n    default: prts\n')
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
