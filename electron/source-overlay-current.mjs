/** Keep the existing PRTS window controls on the pinned 0.1.7 Desktop shell. */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const builder = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function replaceOnce(source, before, after, file) {
  if (source.includes(after)) return source
  if (source.split(before).length !== 2) throw new Error('Current Desktop chrome anchor changed: ' + file)
  return source.replace(before, after)
}

export function overlayCurrentChrome(file, source) {
  if (file === 'src/preload-app.ts') {
    return replaceOnce(source, "import { contextBridge, ipcRenderer, webUtils } from 'electron'",
      "import { contextBridge, ipcRenderer, webUtils } from 'electron'\nimport './prts-window-preload.ts'", file)
  }
  if (file === 'src/preload-windows.ts') {
    source = replaceOnce(source, "import { installWindowsMenu } from './preload-menu.ts'",
      '// PRTS portable supplies its own Windows titlebar menu.', file)
    return replaceOnce(source, '    const menu = installWindowsMenu()',
      "    const menu = { update() {}, dispose() {} }", file)
  }
  if (file !== 'src/main.ts') throw new Error('Unsupported current chrome source: ' + file)
  source = replaceOnce(source, "import { resolveDesktopPaths } from './paths.ts'",
    "import { resolveDesktopPaths } from './paths.ts'\nimport { installPrtsWindowChrome } from './prts-window-chrome.ts'", file)
  source = replaceOnce(source,
    'function createWindow(preload: string, show = false, primary = false): BrowserWindow {\n  const window = new BrowserWindow({',
    "function createWindow(preload: string, show = false, primary = false): BrowserWindow {\n  const portableChrome = process.platform === 'win32' && primary && process.env.PRTS_PORTABLE === '1'\n  const window = new BrowserWindow({", file)
  source = replaceOnce(source, "    show,\n    ...(process.platform === 'win32' && primary ? {",
    "    show,\n    frame: !portableChrome,\n    ...(portableChrome ? { backgroundColor: '#f4f4f1' } : {}),\n    ...(process.platform === 'win32' && primary && !portableChrome ? {", file)
  source = replaceOnce(source, '    mainWindow = window\n    browserGuests.bind(window,',
    "    mainWindow = window\n    if (process.env.PRTS_PORTABLE === '1' && process.platform === 'win32') installPrtsWindowChrome(window, undefined, () => { Menu.buildFromTemplate(applicationItems()).popup({ window }) })\n    browserGuests.bind(window,", file)
  source = replaceOnce(source,
    '      if (validColor(color) && validColor(symbolColor)) mainWindow.setTitleBarOverlay({ color, symbolColor })',
    "      if (process.env.PRTS_PORTABLE !== '1' && validColor(color) && validColor(symbolColor)) mainWindow.setTitleBarOverlay({ color, symbolColor })", file)
  return replaceOnce(source,
    "    { label: currentDesktopLocale().messages.checkUpdatesMenu, click: () => { void openUpdatePrompt(true) } },",
    "    ...(process.env.PRTS_PORTABLE === '1' ? [] : [{ label: currentDesktopLocale().messages.checkUpdatesMenu, click: () => { void openUpdatePrompt(true) } }]),", file)
}

export function applyCurrentChromeOverlay(dshSource) {
  const target = realpathSync(resolve(dshSource))
  const expected = resolve(builder, '.build/dsh-electron-current')
  if (!existsSync(expected) || lstatSync(expected).isSymbolicLink() || target !== realpathSync(expected)
    || !target.startsWith(realpathSync(builder) + sep)) {
    throw new Error("Current chrome overlay only accepts this builder's disposable checkout")
  }
  const versions = JSON.parse(readFileSync(join(builder, 'versions.electron.current.json'), 'utf8'))
  const commit = execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (commit !== versions.dsh.commit) throw new Error('Current Desktop source does not match the pinned commit')
  const desktop = join(target, 'apps/desktop')
  const files = ['src/main.ts', 'src/preload-app.ts', 'src/preload-windows.ts'].map(file => {
    const path = join(desktop, file)
    return { path, body: overlayCurrentChrome(file, readFileSync(path, 'utf8')) }
  })
  for (const { path, body } of files) writeFileSync(path, body)
  for (const file of ['prts-window-chrome.ts', 'prts-window-preload.ts']) {
    copyFileSync(join(builder, 'electron', file), join(desktop, 'src', file))
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { 'dsh-source': { type: 'string' } } })
  if (!values['dsh-source']) throw new Error('usage: source-overlay-current.mjs --dsh-source DIR')
  applyCurrentChromeOverlay(values['dsh-source'])
}
