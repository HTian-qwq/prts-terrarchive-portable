/** Brand the pinned 0.1.7 Desktop shell and retain the PRTS window controls. */
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

function replaceExpected(source, before, after, file, expected = 1) {
  const count = value => source.split(value).length - 1
  if (count(before) === 0 && count(after) === expected) return source
  if (count(before) !== expected) throw new Error('Current Desktop branding anchor changed: ' + file)
  return source.replaceAll(before, after)
}

const BRANDING_CHANGES = {
  'scripts/client-build-environment.ts': [
    ["DSH_CLIENT_TITLE: 'DeepSeek Harness'", "DSH_CLIENT_TITLE: 'PRTS Terrarchive'"],
  ],
  'apps/desktop/src/locale.ts': [
    ["aboutMenu: 'About DeepSeek Harness'", "aboutMenu: 'About PRTS Terrarchive'"],
    ["aboutMenu: '关于 DeepSeek Harness'", "aboutMenu: '关于 PRTS Terrarchive'"],
    ["aboutProduct: 'DeepSeek Harness'", "aboutProduct: 'PRTS Terrarchive'", 2],
    ["welcomeTitle: 'DeepSeek Harness'", "welcomeTitle: 'PRTS Terrarchive'", 2],
    ["welcomeBrand: 'DeepSeek Harness'", "welcomeBrand: 'PRTS Terrarchive'", 2],
    ["welcomeTaglineBrand: 'DeepSeek Harness'", "welcomeTaglineBrand: 'PRTS Terrarchive'", 2],
    ["welcomeDescription: 'Build potential. Explore intelligence.'", "welcomeDescription: 'Find the source. Follow the story.'"],
    ["welcomeDescription: '组装无限可能，共探智能上限'", "welcomeDescription: '检索泰拉档案，核验故事原文'"],
    ["welcomeKeyDescription: 'Configure official DeepSeek models to start using Harness'", "welcomeKeyDescription: 'Configure a DeepSeek model to use PRTS Terrarchive'"],
    ["welcomeKeyDescription: '配置 DeepSeek 官方模型，即可开始使用'", "welcomeKeyDescription: '配置 DeepSeek 模型，即可使用 PRTS Terrarchive'"],
  ],
  'packages/client/ui-settings-account/src/client/locales/onboarding.ts': [
    ["onboardingBrand: 'DeepSeek Harness'", "onboardingBrand: 'PRTS Terrarchive'", 2],
    ["onboardingIntroduction: 'DeepSeek Harness 会以本地文件夹作为工作区，通过调用各种工具，读写本机文件，完成搜索整理资料、制作文档表格、编写代码、排查问题等各种任务。'", "onboardingIntroduction: '在本地检索泰拉与终末地资料，核对故事原文及出处，再整理成可追溯的回答。'"],
    ["onboardingIntroduction: 'DeepSeek Harness works in a local folder and uses tools to read and write files on your computer. It can help you research and organize information, create documents and spreadsheets, write code, troubleshoot issues, and more.'", "onboardingIntroduction: 'Search Terra and Endfield records, verify original story text and sources, and collect answers you can trace.'"],
    ["onboardingProcessDescription: '这只会影响工作过程的展示方式，不会影响 DeepSeek Harness 的工作能力。'", "onboardingProcessDescription: '这只会影响工作过程的展示方式，不会影响检索与回答能力。'"],
    ["onboardingProcessDescription: 'This only changes how progress is shown, not what DeepSeek Harness can do.'", "onboardingProcessDescription: 'This only changes how progress is shown, not what the app can do.'"],
    ["onboardingNoCreditDescription: '没有可用额度时，DeepSeek Harness 将无法开始新的任务。你可以稍后前往 个人中心 → 账号与余额 进行充值。'", "onboardingNoCreditDescription: '没有可用额度时，无法开始新的模型任务。你可以稍后前往 个人中心 → 账号与余额 进行充值。'"],
    ["onboardingNoCreditDescription: 'DeepSeek Harness can’t start new tasks without credits. You can add them later in Profile → Accounts.'", "onboardingNoCreditDescription: 'New model tasks require credits. You can add them later in Profile → Accounts.'"],
  ],
  'packages/client/ui-settings-account/src/client/OnboardingWelcomeStep.tsx': [
    ["import art from './assets/onboarding-welcome.png'", "import art from './assets/prts-onboarding.svg'"],
    ["import artDark from './assets/onboarding-welcome-dark.png'", "import artDark from './assets/prts-onboarding.svg'"],
    ["import artZh from './assets/onboarding-welcome-zh.png'", "import artZh from './assets/prts-onboarding.svg'"],
    ["import artZhDark from './assets/onboarding-welcome-zh-dark.png'", "import artZhDark from './assets/prts-onboarding.svg'"],
  ],
  'packages/client/ui-settings-account/src/client/OnboardingSurface.module.css': [
    ['  background: var(--dsw-alias-bg-base);', '  background: #f7f7f4;'],
    ["  user-select: none;\n}\n\n:global(html[data-platform='darwin']) .onboardingOverlay {",
      "  user-select: none;\n}\n\n:global(body[data-ds-dark-theme]) .onboardingOverlay { background: #171a1d; }\n\n:global(html[data-platform='darwin']) .onboardingOverlay {"],
  ],
}

export function overlayCurrentBranding(file, source) {
  const changes = BRANDING_CHANGES[file]
  if (!changes) throw new Error('Unsupported current branding source: ' + file)
  for (const [before, after, expected = 1] of changes) source = replaceExpected(source, before, after, file, expected)
  return source
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
  source = replaceOnce(source, "    applicationName: 'DeepSeek Harness',",
    "    applicationName: process.env.PRTS_PORTABLE === '1' ? 'PRTS Terrarchive' : 'DeepSeek Harness',", file)
  source = replaceOnce(source, "import { resolveDesktopPaths } from './paths.ts'",
    "import { resolveDesktopPaths } from './paths.ts'\nimport { installPrtsWindowChrome } from './prts-window-chrome.ts'", file)
  source = replaceOnce(source,
    'function createWindow(preload: string, show = false, primary = false): BrowserWindow {\n  const window = new BrowserWindow({',
    "function createWindow(preload: string, show = false, primary = false): BrowserWindow {\n  const portableChrome = process.platform === 'win32' && primary && process.env.PRTS_PORTABLE === '1'\n  const window = new BrowserWindow({", file)
  source = replaceOnce(source, "    show,\n    ...(process.platform === 'win32' && primary ? {",
    "    show,\n    title: portableChrome ? 'PRTS Terrarchive' : app.name,\n    frame: !portableChrome,\n    ...(portableChrome ? { backgroundColor: '#f4f4f1' } : {}),\n    ...(process.platform === 'win32' && primary && !portableChrome ? {", file)
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
    throw new Error("Current Desktop overlay only accepts this builder's disposable checkout")
  }
  const versions = JSON.parse(readFileSync(join(builder, 'versions.electron.current.json'), 'utf8'))
  const commit = execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (commit !== versions.dsh.commit) throw new Error('Current Desktop source does not match the pinned commit')
  const desktop = join(target, 'apps/desktop')
  const files = ['src/main.ts', 'src/preload-app.ts', 'src/preload-windows.ts'].map(file => {
    const path = join(desktop, file)
    return { path, body: overlayCurrentChrome(file, readFileSync(path, 'utf8')) }
  })
  const branding = Object.keys(BRANDING_CHANGES).map(file => {
    const path = join(target, file)
    return { path, body: overlayCurrentBranding(file, readFileSync(path, 'utf8')) }
  })
  for (const { path, body } of [...files, ...branding]) writeFileSync(path, body)
  copyFileSync(join(builder, 'electron/assets/prts-onboarding.svg'),
    join(target, 'packages/client/ui-settings-account/src/client/assets/prts-onboarding.svg'))
  copyFileSync(join(builder, 'electron/assets/prts-welcome-brand.svg'),
    join(desktop, 'renderer/assets/welcome-brand.svg'))
  for (const file of ['prts-window-chrome.ts', 'prts-window-preload.ts']) {
    copyFileSync(join(builder, 'electron', file), join(desktop, 'src', file))
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { 'dsh-source': { type: 'string' } } })
  if (!values['dsh-source']) throw new Error('usage: source-overlay-current.mjs --dsh-source DIR')
  applyCurrentChromeOverlay(values['dsh-source'])
}
