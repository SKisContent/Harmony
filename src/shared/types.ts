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
  /** Harmony-local pin (FR-3). */
  pinned: boolean
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
  /** Harmony-local pin — floats to the top of its category (FR-3-style). */
  pinned: boolean
  /** order among pinned channels in the same category; 0 when not pinned. */
  pinSortKey: number
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
  /** Harmony-local: pinned to the top of the guild (FR-7). */
  pinned: boolean
  /** order among pinned categories (lower first); 0 when not pinned. */
  pinSortKey: number
  /** Harmony-local: collapsed in the sidebar (FR-7). */
  collapsed: boolean
  /**
   * Harmony-local: auto-hidden because it has no viewable channels and
   * "hide empty categories" is on (FR-6). Channels are still included so the
   * "N hidden" affordance can reveal them.
   */
  hidden: boolean
}

export interface PinnedThreadView {
  id: string
  name: string
  guildId: string
  guildName: string
  parentId: string
  parentName: string
  archived: boolean
  unread: boolean
  mentionCount: number
  messageCount: number
  note: string | null
  label: string | null
  sortKey: number
  /** upstream thread we can no longer see — show a tombstone, don't drop it. */
  missing: boolean
}

export interface PinnedChannelView {
  id: string
  name: string
  guildId: string
  guildName: string
  categoryName: string
  unread: boolean
  mentionCount: number
  muted: boolean
  sortKey: number
  missing: boolean
}

export interface GuildGroup {
  id: string
  name: string
  iconUrl: string | null
  position: number
  muted: boolean
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
  /** Harmony-local layout state (FR-3 / FR-6 / FR-7). */
  local: {
    hideEmptyCategories: boolean
    /** definition of "empty" for FR-6. */
    emptyMode: 'no-visible' | 'no-unread'
    /** every pinned thread and channel, across all guilds, for the Pinned view. */
    pinnedThreads: PinnedThreadView[]
    pinnedChannels: PinnedChannelView[]
  }
}

export interface ReactionRow {
  /** the form Discord's reaction API expects: `name:id` for custom, else the char. */
  key: string
  name: string
  id: string | null
  animated: boolean
  count: number
  /** true when the current user has reacted with this emoji. */
  me: boolean
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
  reactions: ReactionRow[]
}

/** A live change to a single message, pushed over IPC while a channel is open. */
export type LiveMessage =
  | { kind: 'create'; channelId: string; message: MessageRow }
  | { kind: 'update'; channelId: string; message: MessageRow }
  | { kind: 'delete'; channelId: string; id: string }
  | {
      kind: 'reaction'
      channelId: string
      messageId: string
      emoji: { key: string; name: string; id: string | null; animated: boolean }
      delta: 1 | -1
      me: boolean
    }

export interface TypingEvent {
  channelId: string
  userId: string
  userName: string
}

export interface BackfillProgress {
  guild: number
  guilds: number
  indexed: number
  done: boolean
}

/** One hit from the message index (XR-3 / FR-4), with breadcrumb + triage. */
export interface SearchResult extends MessageRow {
  channelId: string
  guildId: string
  guildName: string
  channelName: string
  threadName: string | null
  isDm: boolean
  unread: boolean
  resolved: boolean
  starred: boolean
  snoozeUntil: number | null
}

export interface SearchScopeOpts {
  /** 'all' · 'dm' · a guild id */
  scope: string
  excludeMuted: boolean
  /** FR-4 — restrict to messages that mention me */
  mentionsOnly: boolean
  /** widen mentionsOnly to also include @everyone/@here and replies to me */
  includeEveryone: boolean
  includeReplies: boolean
  limit: number
  offset: number
}

export interface UploadedAttachment {
  id: string
  filename: string
  uploaded_filename: string
}

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
    opts?: {
      replyToId?: string
      pingReply?: boolean
      attachments?: UploadedAttachment[]
    }
  ): Promise<{ ok: boolean; message?: MessageRow; error?: string }>
  editMessage(
    channelId: string,
    messageId: string,
    content: string
  ): Promise<{ ok: boolean; message?: MessageRow; error?: string }>
  deleteMessage(channelId: string, messageId: string): Promise<{ ok: boolean; error?: string }>
  react(
    channelId: string,
    messageId: string,
    emoji: string,
    add: boolean
  ): Promise<{ ok: boolean; error?: string }>
  reactionUsers(
    channelId: string,
    messageId: string,
    emoji: string
  ): Promise<{ ok: boolean; users?: { id: string; name: string }[]; error?: string }>
  search(
    query: string,
    opts: SearchScopeOpts
  ): Promise<{ ok: boolean; results?: SearchResult[]; indexed?: number; error?: string }>
  setMessageTriage(
    messageId: string,
    patch: { resolved?: boolean; starred?: boolean; snoozeUntil?: number | null }
  ): Promise<void>
  backfillMentions(): Promise<{ ok: boolean; indexed?: number; error?: string }>
  onBackfill(cb: (p: BackfillProgress) => void): () => void
  ackChannel(channelId: string, messageId: string): Promise<void>
  setMuted(
    target: { guildId?: string; channelId?: string },
    muted: boolean
  ): Promise<{ ok: boolean; error?: string }>
  startTyping(channelId: string): Promise<void>
  uploadAttachment(
    channelId: string,
    file: { name: string; type: string; bytes: Uint8Array }
  ): Promise<{ ok: boolean; ref?: UploadedAttachment; error?: string }>
  getThreads(
    channelId: string
  ): Promise<{ ok: boolean; threads?: ThreadSummary[]; error?: string }>
  onState(cb: (state: UnifiedState) => void): () => void
  /** Live message create/update/delete/reaction for whichever channel is open. */
  onMessage(cb: (evt: LiveMessage) => void): () => void
  /** Someone started typing in some channel. */
  onTyping(cb: (evt: TypingEvent) => void): () => void

  // --- Harmony-local layout (FR-3 / FR-6 / FR-7) ---
  setPref(key: string, value: string): Promise<void>
  pinThread(threadId: string, pinned: boolean): Promise<void>
  setThreadPinMeta(
    threadId: string,
    patch: { note?: string | null; label?: string | null }
  ): Promise<void>
  reorderPinnedThreads(ids: string[]): Promise<void>
  pinChannel(channelId: string, guildId: string, pinned: boolean): Promise<void>
  reorderPinnedChannels(ids: string[]): Promise<void>
  setCategoryLayout(
    categoryId: string,
    guildId: string,
    patch: { pinned?: boolean; collapsed?: boolean; force?: 'show' | 'hide' | null }
  ): Promise<void>
  reorderPinnedCategories(ids: string[]): Promise<void>
}
