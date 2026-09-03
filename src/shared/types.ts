// Types shared between the main process and the renderer.

export type ConnectionStatus =
  | 'idle'
  | 'no-token'
  | 'connecting'
  | 'identifying'
  | 'ready'
  | 'reconnecting'
  | 'closed'
  | 'error'

/** Discord channel types we care about for the channel list. */
export const CHANNEL_TYPE = {
  GUILD_TEXT: 0,
  DM: 1,
  GUILD_VOICE: 2,
  GROUP_DM: 3,
  GUILD_CATEGORY: 4,
  GUILD_ANNOUNCEMENT: 5,
  ANNOUNCEMENT_THREAD: 10,
  PUBLIC_THREAD: 11,
  PRIVATE_THREAD: 12,
  GUILD_STAGE_VOICE: 13,
  GUILD_FORUM: 15
} as const

/** Text-capable channel types that belong in the unified channel list. */
export const TEXTISH_TYPES: number[] = [
  CHANNEL_TYPE.GUILD_TEXT,
  CHANNEL_TYPE.GUILD_ANNOUNCEMENT,
  CHANNEL_TYPE.GUILD_FORUM
]

export interface ThreadRow {
  id: string
  parentId: string
  name: string
  archived: boolean
  messageCount: number
  unread: boolean
  mentionCount: number
}

export interface ChannelRow {
  id: string
  guildId: string
  name: string
  type: number
  parentId: string | null
  position: number
  /** true when the channel's last message id is ahead of our read state. */
  unread: boolean
  /** number of unread messages that directly mention us. */
  mentionCount: number
  /** muted via Discord's per-guild / per-channel settings. */
  muted: boolean
  /** active threads we're a member of (from the gateway READY payload). */
  threads: ThreadRow[]
}

export interface ThreadSummary {
  id: string
  name: string
  archived: boolean
  messageCount: number
}

export interface CategoryGroup {
  /** null = channels that sit outside any category. */
  id: string | null
  name: string | null
  /** Discord's own ordering, kept for reference. */
  position: number
  /** highest child-channel last_message_id (snowflake string); '0' if none. */
  recentActivity: string
  channels: ChannelRow[]
}

export interface GuildGroup {
  id: string
  name: string
  iconUrl: string | null
  position: number
  categories: CategoryGroup[]
}

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline'

export interface DmMemberRow {
  id: string
  name: string
  avatarUrl: string | null
  status: PresenceStatus
}

export interface DmRow {
  id: string
  /** 1 = direct message, 3 = group DM. */
  type: number
  name: string
  iconUrl: string | null
  unread: boolean
  mentionCount: number
  muted: boolean
  /** presence of the other person (1:1) or the "best" among members (group). */
  status: PresenceStatus
  /** for group DMs: the members, to show indented. */
  members: DmMemberRow[]
}

export interface UnifiedState {
  status: ConnectionStatus
  detail?: string
  self: { id: string; username: string; globalName: string | null } | null
  guilds: GuildGroup[]
  dms: DmRow[]
  /** epoch ms of the last successful READY ingest. */
  syncedAt: number | null
  counts: { guilds: number; channels: number; unread: number; mentions: number }
}

export interface MessageRow {
  id: string
  authorId: string
  authorName: string
  content: string
  timestamp: string
  editedTimestamp: string | null
  attachments: { name: string; url: string }[]
  embedCount: number
  replyTo: string | null
  system: boolean
  /** users referenced by <@id> in this message, for mention rendering. */
  mentions: { id: string; name: string }[]
}

/** A live change to a single message, pushed over IPC while a channel is open. */
export type LiveMessage =
  | { kind: 'create'; channelId: string; message: MessageRow }
  | { kind: 'update'; channelId: string; message: MessageRow }
  | { kind: 'delete'; channelId: string; id: string }

export interface HarmonyApi {
  getState(): Promise<UnifiedState>
  login(): Promise<{ ok: boolean; error?: string }>
  /** Escape hatch: supply an account token directly (XR-7 step 5). */
  setToken(token: string): Promise<{ ok: boolean; error?: string }>
  logout(): Promise<void>
  reconnect(): Promise<void>
  getMessages(
    channelId: string,
    before?: string
  ): Promise<{ ok: boolean; messages?: MessageRow[]; error?: string }>
  sendMessage(
    channelId: string,
    content: string,
    opts?: { replyToId?: string; pingReply?: boolean }
  ): Promise<{ ok: boolean; message?: MessageRow; error?: string }>
  getThreads(
    channelId: string
  ): Promise<{ ok: boolean; threads?: ThreadSummary[]; error?: string }>
  onState(cb: (state: UnifiedState) => void): () => void
  /** Live message create/update/delete for whichever channel is open. */
  onMessage(cb: (evt: LiveMessage) => void): () => void
}
