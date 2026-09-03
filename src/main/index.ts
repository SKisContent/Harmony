import { join } from 'node:path'
import { BrowserWindow, app, ipcMain, shell } from 'electron'
import type { UnifiedState } from '@shared/types'
import { captureTokenViaLogin, clearToken, loadToken, saveToken } from './auth'
import { Gateway } from './gateway'
import { getMessages, getThreads, sendMessage } from './rest'
import { Store } from './store'

let win: BrowserWindow | null = null
let gateway: Gateway | null = null
let currentToken: string | null = null
const store = new Store()

function pushState(): void {
  const state: UnifiedState = store.getState()
  win?.webContents.send('harmony:state', state)
}

let pushQueued = false
store.on('change', () => {
  // coalesce bursts of gateway events into one render per tick
  if (pushQueued) return
  pushQueued = true
  setTimeout(() => {
    pushQueued = false
    pushState()
  }, 50)
})

// live per-message deltas for the open channel — sent straight through, uncoalesced
store.on('message', (evt) => win?.webContents.send('harmony:message', evt))

function startGateway(token: string): void {
  currentToken = token
  gateway?.disconnect()
  gateway = new Gateway(token)
  gateway.on('status', (s, detail) => store.setStatus(s as UnifiedState['status'], detail))
  gateway.on('dispatch', (type, data) => store.ingest(type, data))
  gateway.on('error', (err) => store.setStatus('error', err.message))
  gateway.connect()
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    title: 'Harmony',
    backgroundColor: '#1e1f22',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.webContents.once('did-finish-load', () => pushState())
}

ipcMain.handle('harmony:getState', () => store.getState())

ipcMain.handle('harmony:login', async () => {
  try {
    const token = await captureTokenViaLogin()
    startGateway(token)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
})

ipcMain.handle('harmony:setToken', (_e, token: string) => {
  const trimmed = (token ?? '').trim().replace(/^"|"$/g, '')
  if (trimmed.length < 40) return { ok: false, error: 'That does not look like a token.' }
  saveToken(trimmed)
  startGateway(trimmed)
  return { ok: true }
})

ipcMain.handle('harmony:logout', () => {
  gateway?.disconnect()
  gateway = null
  currentToken = null
  clearToken()
  store.reset()
  pushState()
})

ipcMain.handle('harmony:reconnect', () => {
  const token = loadToken()
  if (token) startGateway(token)
})

ipcMain.handle('harmony:getMessages', async (_e, channelId: string, before?: string) => {
  const token = currentToken ?? loadToken()
  if (!token) return { ok: false, error: 'Not signed in.' }
  try {
    const messages = await getMessages(channelId, token, 50, before)
    return { ok: true, messages }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
})

ipcMain.handle('harmony:getThreads', async (_e, channelId: string) => {
  const token = currentToken ?? loadToken()
  if (!token) return { ok: false, error: 'Not signed in.' }
  try {
    const threads = await getThreads(channelId, token)
    console.log(`[rest] getThreads(${channelId}) → ${threads.length} thread(s)`)
    return { ok: true, threads }
  } catch (e) {
    console.error('[rest] getThreads failed:', (e as Error).message)
    return { ok: false, error: (e as Error).message }
  }
})

ipcMain.handle(
  'harmony:sendMessage',
  async (_e, channelId: string, content: string, opts?: { replyToId?: string; pingReply?: boolean }) => {
    const token = currentToken ?? loadToken()
    if (!token) return { ok: false, error: 'Not signed in.' }
    const text = (content ?? '').trim()
    if (!text) return { ok: false, error: 'Message is empty.' }
    if (text.length > 2000) return { ok: false, error: 'Message is over 2000 characters.' }
    try {
      const message = await sendMessage(channelId, text, token, opts ?? {})
      return { ok: true, message }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }
)

app.whenReady().then(() => {
  createWindow()
  const token = loadToken()
  if (token) {
    console.log('[main] have stored token → connecting gateway')
    startGateway(token)
  } else {
    console.log('[main] no stored token → showing sign-in')
    store.setStatus('no-token')
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
