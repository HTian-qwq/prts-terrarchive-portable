/** Bundled into the sandboxed app preload; no IPC API is exposed to page scripts. */
import { ipcRenderer } from 'electron'

const ACTION_CHANNEL = 'prts-shell:window-action'
const STATE_CHANNEL = 'prts-shell:window-state'

const styles = `#prts-desktop-drag {
  position: fixed; z-index: 2147483646; inset: 0 164px auto 0; height: 38px;
  -webkit-app-region: drag; user-select: none; -webkit-user-select: none;
}

#prts-desktop-chrome {
  --shell-fg: rgba(22, 25, 29, .78);
  --shell-bg: rgba(250, 250, 248, .76);
  --shell-border: rgba(20, 24, 28, .10);
  --shell-hover: rgba(20, 24, 28, .075);
  position: fixed; z-index: 2147483647; top: 10px; right: 12px;
  box-sizing: border-box; display: flex; align-items: center; gap: 2px;
  height: 32px; padding: 3px;
  color: var(--shell-fg); background: var(--shell-bg);
  border: 1px solid var(--shell-border); border-radius: 13px;
  box-shadow: 0 7px 24px rgba(17, 20, 24, .10), inset 0 1px rgba(255,255,255,.62);
  backdrop-filter: blur(16px) saturate(1.15);
  -webkit-backdrop-filter: blur(16px) saturate(1.15);
  user-select: none; -webkit-user-select: none;
}
#prts-desktop-chrome button {
  appearance: none; box-sizing: border-box; display: grid; place-items: center;
  width: 31px; height: 24px; margin: 0; padding: 0;
  color: inherit; background: transparent; border: 0; border-radius: 9px;
  outline: none; cursor: default; transition: background-color 120ms ease, color 120ms ease;
}
#prts-desktop-chrome button:hover { background: var(--shell-hover); }
#prts-desktop-chrome button:active { transform: translateY(1px); }
#prts-desktop-chrome button[data-action='close']:hover { color: white; background: #c42b2b; }
#prts-desktop-chrome svg {
  width: 12px; height: 12px; display: block; fill: none;
  stroke: currentColor; stroke-width: 1.45; stroke-linecap: round; stroke-linejoin: round;
}

body[data-prts-skin='agent'] #prts-desktop-chrome {
  --shell-bg: rgba(248, 248, 245, .70);
  --shell-border: rgba(25, 28, 31, .12);
  --shell-hover: rgba(25, 28, 31, .09);
  box-shadow: 0 8px 26px rgba(12, 15, 18, .12), inset 0 1px rgba(255,255,255,.68);
}

body[data-prts-skin='endfield-aic'] #prts-desktop-chrome {
  --shell-fg: #f5fa3d; --shell-bg: rgba(7, 10, 11, .84);
  --shell-border: rgba(245, 250, 61, .40); --shell-hover: rgba(245, 250, 61, .13);
  top: 9px; right: 12px; gap: 0; height: 31px; padding: 2px 3px;
  border-radius: 5px; box-shadow: 0 8px 22px rgba(0,0,0,.30), inset 0 0 18px rgba(245,250,61,.025);
  clip-path: polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px);
}
body[data-prts-skin='endfield-aic'] #prts-desktop-chrome button {
  width: 31px; height: 25px; border-radius: 3px;
}
body[data-prts-skin='endfield-aic'] #prts-desktop-chrome button + button {
  border-left: 1px solid rgba(245, 250, 61, .16);
}
body[data-prts-skin='endfield-aic'] #prts-desktop-chrome button[data-action='close']:hover {
  color: #080a0b; background: #f5fa3d;
}
#prts-desktop-chrome { -webkit-app-region: no-drag; }
#prts-desktop-chrome button:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
body[data-prts-skin='endfield-aic'] #prts-desktop-drag { height: 18px; }
body[data-prts-skin='endfield-aic'] .aic-hud-tr { right: 164px; }
html[data-prts-desktop-fullscreen='true'] #prts-desktop-drag { display: none; }
`

function install(): void {
  if (window !== window.top || location.protocol !== 'dsh-app:' || location.hostname !== 'app'
    || !document.body || document.getElementById('prts-desktop-chrome')) return
  const style = document.createElement('style')
  style.id = 'prts-desktop-chrome-style'
  style.textContent = styles
  const drag = document.createElement('div')
  drag.id = 'prts-desktop-drag'
  drag.setAttribute('aria-hidden', 'true')
  const chrome = document.createElement('div')
  chrome.id = 'prts-desktop-chrome'
  chrome.setAttribute('role', 'group')
  chrome.setAttribute('aria-label', '窗口控制')
  const icons = {
    menu: '<svg viewBox="0 0 12 12"><path d="M2 3h8M2 6h8M2 9h8"/></svg>',
    minimize: '<svg viewBox="0 0 12 12"><path d="M2 8.5h8"/></svg>',
    maximize: '<svg viewBox="0 0 12 12"><rect x="2.25" y="2.25" width="7.5" height="7.5" rx="1"/></svg>',
    restore: '<svg viewBox="0 0 12 12"><path d="M4 2h6v6M2 4h6v6H2z"/></svg>',
    close: '<svg viewBox="0 0 12 12"><path d="m2.5 2.5 7 7m0-7-7 7"/></svg>',
  }
  const labels = { menu: '应用菜单', minimize: '最小化', maximize: '最大化', close: '关闭' }
  for (const action of ['menu', 'minimize', 'maximize', 'close'] as const) {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.action = action
    button.title = labels[action]
    button.setAttribute('aria-label', button.title)
    button.innerHTML = icons[action]
    button.addEventListener('click', event => {
      event.stopPropagation()
      ipcRenderer.send(ACTION_CHANNEL, action)
    })
    chrome.appendChild(button)
  }
  const syncState = (_event: unknown, state: { maximized: boolean; fullscreen: boolean }): void => {
    document.documentElement.dataset.prtsDesktopFullscreen = String(state.fullscreen)
    const button = chrome.querySelector<HTMLButtonElement>('[data-action="maximize"]')
    if (!button) return
    const restore = state.maximized || state.fullscreen
    button.innerHTML = restore ? icons.restore : icons.maximize
    button.title = state.fullscreen ? '退出全屏' : restore ? '还原' : '最大化'
    button.setAttribute('aria-label', button.title)
  }
  ipcRenderer.on(STATE_CHANNEL, syncState)
  window.addEventListener('unload', () => { ipcRenderer.removeListener(STATE_CHANNEL, syncState) }, { once: true })
  ;(document.head || document.documentElement).appendChild(style)
  document.body.append(drag, chrome)
  ipcRenderer.send(ACTION_CHANNEL, 'state')
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true })
else install()
