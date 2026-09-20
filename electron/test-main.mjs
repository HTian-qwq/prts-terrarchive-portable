/** Development-only wrapper around the already built official Electron shell. */
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function startTestDesktop(config) {
  const { app, BrowserWindow } = createRequire(join(config.desktop, 'package.json'))('electron')
  const userData = join(config.home, 'electron')
  mkdirSync(userData, { recursive: true })
  mkdirSync(join(userData, 'session'), { recursive: true })
  app.setPath('userData', userData)
  app.setPath('sessionData', join(userData, 'session'))
  app.setName('PRTS Terrarchive Test')
  app.setAppUserModelId('chat.prts.terrarchive.local-test')
  process.env.DSH_HOME = config.home
  process.env.PRTS_PORTABLE = '1'
  process.env.PRTS_CORPUS_RELEASES_DIR = config.corpus
  process.env.DSH_DESKTOP_DEV_PROJECT_DIR = config.profile
  process.env.DSH_DESKTOP_NODE_BINARY = config.node
  process.env.DSH_DESKTOP_PNPM_ENTRY = config.pnpm
  process.env.DSH_DESKTOP_OPEN_DEVTOOLS = '0'
  process.env.DSH_DESKTOP_DIAGNOSTIC_FILE = join(config.testRoot, 'startup-error.log')
  // The official developer Host uses this loopback inspector to allow its linked profile.
  process.env.DSH_DESKTOP_HOST_INSPECT_PORT = '19330'
  const current = () => JSON.parse(readFileSync(join(config.testRoot, 'current.json'), 'utf8'))
  const restart = () => {
    const latest = current()
    app.relaunch({ execPath: latest.electron, args: [latest.app] })
    app.quit()
  }
  const updateBadge = async window => {
    if (window.isDestroyed() || !window.webContents.getURL().startsWith('dsh-app://app')) return
    const changed = current().id !== config.id
    const label = changed ? '测试版 · 新构建就绪 · Ctrl+Shift+R 应用' : '测试版 · ' + config.builtAt.slice(11, 19) + ' UTC'
    await window.webContents.executeJavaScript(`(() => { let el = document.getElementById('prts-local-test-build'); if (!el) { el = document.createElement('div'); el.id = 'prts-local-test-build'; Object.assign(el.style, {position:'fixed',left:'8px',bottom:'5px',zIndex:'2147483646',padding:'4px 7px',font:'10px system-ui',color:'#eaf0e3',background:'#3a4939',borderRadius:'3px',pointerEvents:'none'}); document.body.append(el); } el.textContent = ${JSON.stringify(label)}; })()`)
  }
  let ready = false
  app.on('browser-window-created', (_event, window) => {
    window.webContents.on('did-finish-load', () => { if (window.webContents.getURL().startsWith('dsh-app://app')) ready = true; void updateBadge(window).catch(error => console.error('Test build badge:', error.message)) })
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'r') { event.preventDefault(); restart() }
    })
  })
  const pipe = `\\\\.\\pipe\\prts-test-${createHash('sha256').update(config.testRoot).digest('hex').slice(0, 20)}`
  const token = randomUUID()
  const instanceFile = join(config.testRoot, 'instance.json')
  const server = createServer({ allowHalfOpen: true }, socket => {
    let body = ''
    socket.on('data', data => {
      body += data
      if (body.length > 4096) { socket.destroy(); return }
      if (!body.includes('\n')) return
      let request
      try { request = JSON.parse(body) } catch { socket.end('{"ok":false}'); return }
      if (request.token !== token) { socket.end('{"ok":false}'); return }
      if (request.command === 'quit') {
        app.once('will-quit', () => socket.end('{"ok":true}'))
        app.quit()
      } else if (request.command === 'updated') {
        for (const window of BrowserWindow.getAllWindows()) void updateBadge(window).catch(error => console.error('Test build badge:', error.message))
        socket.end('{"ok":true}')
      } else socket.end(JSON.stringify({ ok: true, ready, build: config.id, windows: BrowserWindow.getAllWindows().length }))
    })
    socket.on('error', error => { if (error.code !== 'ECONNRESET') console.error('Test control:', error.message) })
  })
  await new Promise((settle, reject) => { server.once('error', reject); server.listen(pipe, settle) })
  writeFileSync(instanceFile, JSON.stringify({ pid: process.pid, pipe, token, build: config.id }), { mode: 0o600 })
  app.on('will-quit', () => {
    server.close()
    if (existsSync(instanceFile) && JSON.parse(readFileSync(instanceFile, 'utf8')).token === token) unlinkSync(instanceFile)
  })
  await import(pathToFileURL(join(config.desktop, 'lib/main.js')).href)
}
