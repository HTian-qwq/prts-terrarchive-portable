/** PRTS main-window controls; the official plugin window keeps its native frame. */
import { ipcMain, Menu, type BrowserWindow, type IpcMainEvent } from 'electron'

const ACTION_CHANNEL = 'prts-shell:window-action'
const STATE_CHANNEL = 'prts-shell:window-state'

export function installPrtsWindowChrome(window: BrowserWindow, openPlugins?: () => void): void {
  // Keep the official application menu available as a popup without a menu-bar row.
  window.setMenu(null)
  const contents = window.webContents
  const publishState = (): void => {
    if (window.isDestroyed() || contents.isDestroyed()) return
    contents.send(STATE_CHANNEL, {
      maximized: window.isMaximized(),
      fullscreen: window.isFullScreen(),
    })
  }
  const toggleMaximize = (): void => {
    if (window.isFullScreen()) window.setFullScreen(false)
    else if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  }
  const onAction = (event: IpcMainEvent, action: unknown): void => {
    if (window.isDestroyed() || event.sender !== contents
      || event.senderFrame === null || event.senderFrame !== contents.mainFrame) return
    const url = URL.parse(event.senderFrame.url)
    if (url === null) return
    if (url.protocol !== 'dsh-app:' || url.hostname !== 'app') return
    switch (action) {
      case 'state': publishState(); break
      case 'menu': Menu.getApplicationMenu()?.popup({ window }); break
      case 'minimize': window.minimize(); break
      case 'maximize': toggleMaximize(); break
      case 'close': window.close(); break
    }
  }
  ipcMain.on(ACTION_CHANNEL, onAction)
  window.once('closed', () => { ipcMain.removeListener(ACTION_CHANNEL, onAction) })
  window.on('maximize', publishState)
  window.on('unmaximize', publishState)
  window.on('enter-full-screen', publishState)
  window.on('leave-full-screen', publishState)
  contents.on('did-finish-load', publishState)
  // These continue to work when the renderer is busy or the application menu is hidden.
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F11') {
      event.preventDefault()
      if (!input.isAutoRepeat) window.setFullScreen(!window.isFullScreen())
    } else if (input.key === 'Escape' && window.isFullScreen()) {
      event.preventDefault()
      window.setFullScreen(false)
    } else if (input.key === ',' && (input.control || input.meta) && !input.alt && !input.shift) {
      event.preventDefault()
      if (!input.isAutoRepeat) openPlugins?.()
    }
  })
}
