import { join } from 'node:path'
import { BrowserWindow, app, ipcMain, shell } from 'electron'
import type { SearchScopeOpts, UnifiedState, UploadedAttachment } from '@shared/types'
import { captureTokenViaLogin, clearToken, loadToken, saveToken } from './auth'
import { Gateway } from './gateway'
import {
  ackMessage,
  addReaction,
  deleteMessage,
  editMessage,
  getMessages,
  getReactionUsers,
  getThreads,
  removeReaction,
  searchGuildMentions,
  sendMessage,
  setMuted,
  startTyping,
  uploadAttachment
} from './rest'
import { nextSweep } from './backfill-plan'
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
store.on('typing', (evt) => win?.webContents.send('harmony:typing', evt))

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
    store.indexFetched(channelId, messages)
    return { ok: true, messages }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
})

ipcMain.handle('harmony:search', (_e, query: string, opts: SearchScopeOpts) => {
  try {
    return { ok: true, ...store.search(query ?? '', opts) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
})

ipcMain.handle(
  'harmony:setMessageTriage',
  (_e, messageId: string, patch: { resolved?: boolean; starred?: boolean; snoozeUntil?: number | null }) => {
    store.setMessageTriage(messageId, patch ?? {})
  }
)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
let backfillRunning = false

async function runMentionBackfill(token: string): Promise<{ indexed: number }> {
  const self = store.selfId()
  if (!self) return { indexed: 0 }
  const guildIds = store.guildIds()
  let indexed = 0

  for (let gi = 0; gi < guildIds.length; gi++) {
    const gid = guildIds[gi]
    let state = { offset: 0, maxId: null as string | null }
    const seen = new Set<string>()
    let guardPages = 0

    while (guardPages++ < 2000) {
      let page
      try {
        page = await searchGuildMentions(gid, self, token, state.offset, state.maxId ?? undefined)
      } catch (e) {
        if (/Rate limited/.test((e as Error).message)) {
          await sleep(2500)
          continue
        }
        break // no access / other error — move to the next guild
      }
      if (page.indexing) {
        await sleep(3000)
        continue
      }
      const fresh = page.hits.filter((m) => !seen.has(m.id))
      for (const m of fresh) seen.add(m.id)
      indexed += store.indexMentionHits(gid, fresh)
      win?.webContents.send('harmony:backfill', {
        guild: gi + 1,
        guilds: guildIds.length,
        indexed,
        done: false
      })

      const oldestId = page.hits.length ? page.hits[page.hits.length - 1].id : null
      const next = nextSweep(state, { count: page.hits.length, oldestId })
      if (next === 'done') break
      state = next
      await sleep(600)
    }
  }

  win?.webContents.send('harmony:backfill', { guild: guildIds.length, guilds: guildIds.length, indexed, done: true })
  return { indexed }
}

ipcMain.handle('harmony:backfillMentions', async () => {
  if (backfillRunning) return { ok: false, error: 'A backfill is already running.' }
  const token = currentToken ?? loadToken()
  if (!token) return { ok: false, error: 'Not signed in.' }
  backfillRunning = true
  try {
    return { ok: true, ...(await runMentionBackfill(token)) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    backfillRunning = false
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
  async (
    _e,
    channelId: string,
    content: string,
    opts?: { replyToId?: string; pingReply?: boolean; attachments?: UploadedAttachment[] }
  ) => {
    const token = currentToken ?? loadToken()
    if (!token) return { ok: false, error: 'Not signed in.' }
    const text = (content ?? '').trim()
    if (!text && !opts?.attachments?.length) return { ok: false, error: 'Message is empty.' }
    if (text.length > 2000) return { ok: false, error: 'Message is over 2000 characters.' }
    try {
      const message = await sendMessage(channelId, text, token, opts ?? {})
      return { ok: true, message }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }
)

function withToken<T>(
  fn: (token: string) => Promise<T>
): Promise<T | { ok: false; error: string }> {
  const token = currentToken ?? loadToken()
  if (!token) return Promise.resolve({ ok: false, error: 'Not signed in.' })
  return fn(token).catch((e) => ({ ok: false, error: (e as Error).message }))
}

ipcMain.handle('harmony:editMessage', (_e, ch: string, id: string, content: string) =>
  withToken(async (t) => ({ ok: true, message: await editMessage(ch, id, content, t) }))
)
ipcMain.handle('harmony:deleteMessage', (_e, ch: string, id: string) =>
  withToken(async (t) => {
    await deleteMessage(ch, id, t)
    return { ok: true }
  })
)
ipcMain.handle('harmony:react', (_e, ch: string, id: string, emoji: string, add: boolean) =>
  withToken(async (t) => {
    await (add ? addReaction : removeReaction)(ch, id, emoji, t)
    return { ok: true }
  })
)
ipcMain.handle('harmony:reactionUsers', (_e, ch: string, id: string, emoji: string) =>
  withToken(async (t) => ({ ok: true, users: await getReactionUsers(ch, id, emoji, t) }))
)
ipcMain.handle('harmony:ackChannel', (_e, ch: string, id: string) => {
  store.markReadLocal(ch, id)
  const token = currentToken ?? loadToken()
  if (token) void ackMessage(ch, id, token).catch(() => {})
})
ipcMain.handle(
  'harmony:setMuted',
  (_e, target: { guildId?: string; channelId?: string }, muted: boolean) => {
    const guildId = target.guildId ?? '@me'
    store.setMutedLocal(
      target.channelId ?? target.guildId ?? '',
      target.channelId ? 'channel' : 'guild',
      muted
    )
    return withToken(async (t) => {
      await setMuted(guildId, target.channelId, muted, t)
      return { ok: true }
    })
  }
)
ipcMain.handle('harmony:startTyping', (_e, ch: string) => {
  const token = currentToken ?? loadToken()
  if (token) void startTyping(ch, token).catch(() => {})
})
ipcMain.handle(
  'harmony:uploadAttachment',
  (_e, ch: string, file: { name: string; type: string; bytes: Uint8Array }) =>
    withToken(async (t) => ({ ok: true, ref: await uploadAttachment(ch, file, t) }))
)

// --- Harmony-local layout (FR-3 / FR-6 / FR-7) ---
ipcMain.handle('harmony:setPref', (_e, key: string, value: string) => store.setPref(key, value))
ipcMain.handle('harmony:pinThread', (_e, threadId: string, pinned: boolean) =>
  store.setThreadPinned(threadId, pinned)
)
ipcMain.handle(
  'harmony:setThreadPinMeta',
  (_e, threadId: string, patch: { note?: string | null; label?: string | null }) =>
    store.setThreadPinMeta(threadId, patch ?? {})
)
ipcMain.handle('harmony:pinChannel', (_e, channelId: string, guildId: string, pinned: boolean) =>
  store.setChannelPinned(channelId, guildId, pinned)
)
ipcMain.handle('harmony:reorderPinnedChannels', (_e, ids: string[]) =>
  store.reorderPinnedChannels(ids ?? [])
)
ipcMain.handle('harmony:reorderPinnedThreads', (_e, ids: string[]) =>
  store.reorderPinnedThreads(ids ?? [])
)
ipcMain.handle(
  'harmony:setCategoryLayout',
  (
    _e,
    categoryId: string,
    guildId: string,
    patch: { pinned?: boolean; collapsed?: boolean; force?: 'show' | 'hide' | null }
  ) => store.setCategoryLayout(categoryId, guildId, patch ?? {})
)
ipcMain.handle('harmony:reorderPinnedCategories', (_e, ids: string[]) =>
  store.reorderPinnedCategories(ids ?? [])
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
