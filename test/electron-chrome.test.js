import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { overlaySource } from '../electron/source-overlay.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dsh = resolve(process.env.PRTS_DSH_SOURCE || join(root, '../deepseek-harness'))
const supported = existsSync(join(dsh, 'node_modules/tsx/package.json'))
const integration = (name, fn) => test(name, { skip: !supported && 'Set PRTS_DSH_SOURCE to an installed DSH workspace' }, fn)
let buildSync
if (supported) {
  const requireDsh = createRequire(join(dsh, 'package.json'))
  ;({ buildSync } = createRequire(requireDsh.resolve('tsx/package.json'))('esbuild'))
}
function bundle(path) {
  return buildSync({ entryPoints: [path], bundle: true, write: false,
    platform: 'node', format: 'cjs', external: ['electron'] }).outputFiles[0].text
}
function preloadBundle(t) {
  const dir = mkdtempSync(join(tmpdir(), 'prts-chrome-preload-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'preload-app.ts'), overlaySource('src/preload-app.ts',
    readFileSync(join(dsh, 'apps/desktop/src/preload-app.ts'), 'utf8')))
  writeFileSync(join(dir, 'prts-window-preload.ts'), readFileSync(join(root, 'electron/prts-window-preload.ts')))
  return bundle(join(dir, 'preload-app.ts'))
}

integration('window controls restrict IPC to the owned main frame and preserve menu, fullscreen and cleanup', () => {
  const ipcMain = new EventEmitter()
  const contents = new EventEmitter()
  contents.mainFrame = { url: 'dsh-app://app/index.html' }
  contents.isDestroyed = () => false
  const states = []
  contents.send = (channel, state) => states.push({ channel, state })
  const window = new EventEmitter()
  let maximized = false, fullscreen = false, minimized = 0, closed = 0, menus = 0, plugins = 0
  Object.assign(window, {
    webContents: contents, isDestroyed: () => false,
    setMenu: value => assert.equal(value, null),
    isMaximized: () => maximized, isFullScreen: () => fullscreen,
    maximize() { maximized = true; window.emit('maximize') },
    unmaximize() { maximized = false; window.emit('unmaximize') },
    setFullScreen(value) { fullscreen = value; window.emit(value ? 'enter-full-screen' : 'leave-full-screen') },
    minimize() { minimized++ }, close() { closed++ },
  })
  const module = { exports: {} }
  vm.runInNewContext(bundle(join(root, 'electron/prts-window-chrome.ts')), {
    module, exports: module.exports, URL,
    require(name) {
      assert.equal(name, 'electron')
      return { ipcMain, Menu: { getApplicationMenu: () => ({ popup: options => { assert.equal(options.window, window); menus++ } }) } }
    },
  })
  module.exports.installPrtsWindowChrome(window, () => plugins++)
  const send = (action, overrides = {}) => ipcMain.emit('prts-shell:window-action',
    { sender: contents, senderFrame: contents.mainFrame, ...overrides }, action)
  for (const overrides of [{ sender: {} }, { senderFrame: null },
    { senderFrame: { url: 'dsh-app://app/frame' } }]) send('close', overrides)
  for (const url of ['', 'https://example.invalid/', 'dsh-app://shell/plugin-manager.html']) {
    contents.mainFrame.url = url; send('close')
  }
  assert.equal(closed, 0)
  contents.mainFrame.url = 'dsh-app://app/index.html'
  send('unrecognized'); send({ action: 'close' })
  assert.equal(closed, 0)
  send('state'); assert.equal(states.at(-1).state.maximized, false)
  send('maximize'); assert.equal(states.at(-1).state.maximized, true)
  send('maximize'); assert.equal(states.at(-1).state.maximized, false)
  send('menu'); assert.equal(menus, 1)
  send('minimize'); assert.equal(minimized, 1)
  const key = (key, extra = {}) => {
    let prevented = false
    contents.emit('before-input-event', { preventDefault() { prevented = true } }, { type: 'keyDown', key, ...extra })
    return prevented
  }
  assert.equal(key('F11'), true); assert.equal(fullscreen, true)
  key('F11', { isAutoRepeat: true }); assert.equal(fullscreen, true)
  key('Escape'); assert.equal(fullscreen, false)
  assert.equal(key('Escape'), false)
  key('F11'); send('maximize'); assert.equal(fullscreen, false)
  key(',', { control: true }); assert.equal(plugins, 1)
  key(',', { control: true, shift: true }); assert.equal(plugins, 1)
  send('close'); assert.equal(closed, 1)
  window.emit('closed'); assert.equal(ipcMain.listenerCount('prts-shell:window-action'), 0)
})

integration('sandbox preload keeps the official transport marker and ignores unowned documents', t => {
  const source = preloadBundle(t)
  const marker = []
  for (const location of [{ protocol: 'https:', hostname: 'app' }, { protocol: 'dsh-app:', hostname: 'shell' }]) {
    const window = {}; window.top = window
    vm.runInNewContext(source, { window, location, document: { readyState: 'complete' },
      require: () => ({ contextBridge: { exposeInMainWorld: (...args) => marker.push(args) } }),
    })
  }
  assert.equal(JSON.stringify(marker), JSON.stringify([
    ['dshDesktop', { protocolVersion: 1 }], ['dshDesktop', { protocolVersion: 1 }],
  ]))
})

test('both legacy chrome skins render and switch in Chromium, with clickable controls and unobstructed AIC HUD', {
  skip: !supported || !process.env.PRTS_PLAYWRIGHT_MODULE ? 'Set PRTS_DSH_SOURCE and PRTS_PLAYWRIGHT_MODULE for browser coverage' : false,
}, async t => {
  const { chromium } = await import(pathToFileURL(process.env.PRTS_PLAYWRIGHT_MODULE).href)
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PRTS_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PRTS_CHROMIUM_EXECUTABLE } : {}) })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent('<html><head></head><body><div class="aic-root"><div class="aic-hud aic-hud-tr"><button id="reset">RESET_VIEW</button><span class="aic-clock">19:06:17</span></div></div></body></html>')
  for (const name of ['common', 'prts-agent', 'endfield-aic']) await page.addStyleTag({ path: join(root, '../prts-terrarchive/lib/skins', name + '.css') })
  await page.evaluate(source => {
    const listeners = new Map()
    window.actions = []
    window.state = state => listeners.get('prts-shell:window-state')?.({}, state)
    const electron = { ipcRenderer: {
      on: (channel, fn) => listeners.set(channel, fn),
      removeListener: channel => listeners.delete(channel),
      send: (channel, action) => window.actions.push({ channel, action }),
    }, contextBridge: { exposeInMainWorld: (name, api) => { window[name] = api } } }
    // Chromium has no dsh-app handler. The bundled preload uses a protocol fixture;
    // DOM, style cascade, skin changes and button events run in the real browser.
    new Function('require', 'location', source)(() => electron, { protocol: 'dsh-app:', hostname: 'app' })
  }, preloadBundle(t))
  assert.equal(await page.evaluate(() => window.dshDesktop.protocolVersion), 1)
  const chrome = page.locator('#prts-desktop-chrome')
  for (const skin of ['agent', 'endfield-aic', 'agent']) {
    await page.evaluate(skin => { document.body.dataset.prtsSkin = skin }, skin)
    assert.equal(await chrome.evaluate(element => getComputedStyle(element).borderRadius), skin === 'agent' ? '13px' : '5px')
    assert.equal(await chrome.evaluate(element => getComputedStyle(element).color), skin === 'agent' ? 'rgba(22, 25, 29, 0.78)' : 'rgb(245, 250, 61)')
    for (const action of ['menu', 'minimize', 'maximize', 'close']) {
      await chrome.locator(`[data-action="${action}"]`).click()
      assert.equal(await page.evaluate(() => window.actions.at(-1).action), action)
    }
    if (skin === 'endfield-aic') {
      const hud = await page.locator('.aic-hud-tr').boundingBox()
      const controls = await chrome.boundingBox()
      assert(hud.x + hud.width < controls.x, 'AIC clock must not overlap window controls')
      await page.locator('#reset').click()
    }
  }
  await page.evaluate(() => window.state({ maximized: true, fullscreen: false }))
  assert.equal(await chrome.locator('[data-action="maximize"]').getAttribute('title'), '还原')
  await page.evaluate(() => window.state({ maximized: false, fullscreen: true }))
  assert.equal(await chrome.locator('[data-action="maximize"]').getAttribute('title'), '退出全屏')
  assert.equal(await page.locator('#prts-desktop-drag').isVisible(), false)
  assert.equal(await page.locator('#prts-desktop-chrome').count(), 1)
  assert.deepEqual(errors, [])
})
