import { contextBridge, ipcRenderer } from 'electron'
import type {
  BackfillProgress,
  HarmonyApi,
  LiveMessage,
  MessageRow,
  SearchScopeOpts,
  TypingEvent,
  UnifiedState,
  UploadedAttachment
} from '@shared/types'

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
    opts?: {
      replyToId?: string
      pingReply?: boolean
      attachments?: UploadedAttachment[]
      stickerIds?: string[]
    }
  ) => ipcRenderer.invoke('harmony:sendMessage', channelId, content, opts),
  editMessage: (channelId: string, messageId: string, content: string) =>
    ipcRenderer.invoke('harmony:editMessage', channelId, messageId, content),
  deleteMessage: (channelId: string, messageId: string) =>
    ipcRenderer.invoke('harmony:deleteMessage', channelId, messageId),
  react: (channelId: string, messageId: string, emoji: string, add: boolean) =>
    ipcRenderer.invoke('harmony:react', channelId, messageId, emoji, add),
  reactionUsers: (channelId: string, messageId: string, emoji: string) =>
    ipcRenderer.invoke('harmony:reactionUsers', channelId, messageId, emoji),
  search: (query: string, opts: SearchScopeOpts) =>
    ipcRenderer.invoke('harmony:search', query, opts),
  setMessageTriage: (
    messageId: string,
    patch: { resolved?: boolean; starred?: boolean; snoozeUntil?: number | null }
  ) => ipcRenderer.invoke('harmony:setMessageTriage', messageId, patch),
  backfillMentions: () => ipcRenderer.invoke('harmony:backfillMentions'),
  backfillMyMessages: () => ipcRenderer.invoke('harmony:backfillMyMessages'),
  addBookmark: (message: MessageRow, channelId: string) =>
    ipcRenderer.invoke('harmony:addBookmark', message, channelId),
  removeBookmark: (messageId: string) => ipcRenderer.invoke('harmony:removeBookmark', messageId),
  updateBookmark: (messageId: string, patch: { note?: string | null; label?: string | null }) =>
    ipcRenderer.invoke('harmony:updateBookmark', messageId, patch),
  refreshBookmark: (messageId: string) => ipcRenderer.invoke('harmony:refreshBookmark', messageId),
  onBackfill: (cb: (p: BackfillProgress) => void) => {
    const listener = (_e: unknown, p: BackfillProgress) => cb(p)
    ipcRenderer.on('harmony:backfill', listener)
    return () => ipcRenderer.removeListener('harmony:backfill', listener)
  },
  ackChannel: (channelId: string, messageId: string) =>
    ipcRenderer.invoke('harmony:ackChannel', channelId, messageId),
  setMuted: (target: { guildId?: string; channelId?: string }, muted: boolean) =>
    ipcRenderer.invoke('harmony:setMuted', target, muted),
  startTyping: (channelId: string) => ipcRenderer.invoke('harmony:startTyping', channelId),
  uploadAttachment: (
    channelId: string,
    file: { name: string; type: string; bytes: Uint8Array }
  ) => ipcRenderer.invoke('harmony:uploadAttachment', channelId, file),
  getThreads: (channelId: string) => ipcRenderer.invoke('harmony:getThreads', channelId),
  getGuildAssets: (guildId: string) => ipcRenderer.invoke('harmony:getGuildAssets', guildId),
  searchGifs: (query: string) => ipcRenderer.invoke('harmony:searchGifs', query),
  renameThread: (channelId: string, name: string) =>
    ipcRenderer.invoke('harmony:renameThread', channelId, name),
  setThreadArchived: (channelId: string, archived: boolean) =>
    ipcRenderer.invoke('harmony:setThreadArchived', channelId, archived),
  leaveThread: (channelId: string) => ipcRenderer.invoke('harmony:leaveThread', channelId),
  setChannelNotifyLevel: (target: { guildId?: string; channelId: string }, level: 0 | 1 | 2 | 3) =>
    ipcRenderer.invoke('harmony:setChannelNotifyLevel', target, level),
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
  onTyping: (cb: (evt: TypingEvent) => void) => {
    const listener = (_e: unknown, evt: TypingEvent) => cb(evt)
    ipcRenderer.on('harmony:typing', listener)
    return () => ipcRenderer.removeListener('harmony:typing', listener)
  },

  setPref: (key: string, value: string) => ipcRenderer.invoke('harmony:setPref', key, value),
  pinThread: (threadId: string, pinned: boolean) =>
    ipcRenderer.invoke('harmony:pinThread', threadId, pinned),
  setThreadPinMeta: (threadId: string, patch: { note?: string | null; label?: string | null }) =>
    ipcRenderer.invoke('harmony:setThreadPinMeta', threadId, patch),
  reorderPinnedThreads: (ids: string[]) =>
    ipcRenderer.invoke('harmony:reorderPinnedThreads', ids),
  pinChannel: (channelId: string, guildId: string, pinned: boolean) =>
    ipcRenderer.invoke('harmony:pinChannel', channelId, guildId, pinned),
  reorderPinnedChannels: (ids: string[]) =>
    ipcRenderer.invoke('harmony:reorderPinnedChannels', ids),
  setCategoryLayout: (
    categoryId: string,
    guildId: string,
    patch: { pinned?: boolean; collapsed?: boolean; force?: 'show' | 'hide' | null }
  ) => ipcRenderer.invoke('harmony:setCategoryLayout', categoryId, guildId, patch),
  reorderPinnedCategories: (ids: string[]) =>
    ipcRenderer.invoke('harmony:reorderPinnedCategories', ids)
}

contextBridge.exposeInMainWorld('harmony', api)
