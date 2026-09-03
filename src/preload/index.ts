import { contextBridge, ipcRenderer } from 'electron'
import type { HarmonyApi, LiveMessage, UnifiedState } from '@shared/types'

const api: HarmonyApi = {
  getState: () => ipcRenderer.invoke('harmony:getState'),
  login: () => ipcRenderer.invoke('harmony:login'),
  setToken: (token: string) => ipcRenderer.invoke('harmony:setToken', token),
  logout: () => ipcRenderer.invoke('harmony:logout'),
  reconnect: () => ipcRenderer.invoke('harmony:reconnect'),
  getMessages: (channelId: string, before?: string) =>
    ipcRenderer.invoke('harmony:getMessages', channelId, before),
  sendMessage: (
    channelId: string,
    content: string,
    opts?: { replyToId?: string; pingReply?: boolean }
  ) => ipcRenderer.invoke('harmony:sendMessage', channelId, content, opts),
  getThreads: (channelId: string) => ipcRenderer.invoke('harmony:getThreads', channelId),
  onState: (cb: (state: UnifiedState) => void) => {
    const listener = (_e: unknown, state: UnifiedState) => cb(state)
    ipcRenderer.on('harmony:state', listener)
    return () => ipcRenderer.removeListener('harmony:state', listener)
  },
  onMessage: (cb: (evt: LiveMessage) => void) => {
    const listener = (_e: unknown, evt: LiveMessage) => cb(evt)
    ipcRenderer.on('harmony:message', listener)
    return () => ipcRenderer.removeListener('harmony:message', listener)
  },

  setPref: (key: string, value: string) => ipcRenderer.invoke('harmony:setPref', key, value),
  pinThread: (threadId: string, pinned: boolean) =>
    ipcRenderer.invoke('harmony:pinThread', threadId, pinned),
  setThreadPinMeta: (threadId: string, patch: { note?: string | null; label?: string | null }) =>
    ipcRenderer.invoke('harmony:setThreadPinMeta', threadId, patch),
  reorderPinnedThreads: (ids: string[]) =>
    ipcRenderer.invoke('harmony:reorderPinnedThreads', ids),
  setCategoryLayout: (
    categoryId: string,
    guildId: string,
    patch: { pinned?: boolean; collapsed?: boolean; force?: 'show' | 'hide' | null }
  ) => ipcRenderer.invoke('harmony:setCategoryLayout', categoryId, guildId, patch),
  reorderPinnedCategories: (ids: string[]) =>
    ipcRenderer.invoke('harmony:reorderPinnedCategories', ids)
}

contextBridge.exposeInMainWorld('harmony', api)
