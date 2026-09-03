import { contextBridge, ipcRenderer } from 'electron'
import type { HarmonyApi, UnifiedState } from '@shared/types'

const api: HarmonyApi = {
  getState: () => ipcRenderer.invoke('harmony:getState'),
  login: () => ipcRenderer.invoke('harmony:login'),
  setToken: (token: string) => ipcRenderer.invoke('harmony:setToken', token),
  logout: () => ipcRenderer.invoke('harmony:logout'),
  reconnect: () => ipcRenderer.invoke('harmony:reconnect'),
  getMessages: (channelId: string) => ipcRenderer.invoke('harmony:getMessages', channelId),
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
  }
}

contextBridge.exposeInMainWorld('harmony', api)
