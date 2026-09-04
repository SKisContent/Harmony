import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { app } from 'electron'
import { readSecure } from './secure-file'
import {
  type LocalState,
  type SearchHit,
  type SearchOpts,
  clearModel,
  deleteIndexedMessage,
  indexMessage,
  indexedMessageCount,
  loadLocalState,
  loadModel,
  pinChannel,
  pinThread,
  reorderPinnedCategories,
  reorderPinnedChannels,
  reorderPinnedThreads,
  saveModel,
  searchMessages,
  setCategoryLayout,
  setPref,
  setTriage,
  type StoreModel,
  unpinChannel,
  unpinThread,
  updateThreadPin
} from './db'
import { toRow } from './rest'
import { parseQuery } from './search-query'
import {
  type CategoryGroup,
  type ChannelRow,
  type ConnectionStatus,
  type DmMemberRow,
  type DmRow,
  type GuildGroup,
  type MessageRow,
  type PinnedChannelView,
  type PinnedThreadView,
  type PresenceStatus,
  type SearchResult,
  type SearchScopeOpts,
  type ThreadRow,
  type UnifiedState,
  CHANNEL_TYPE,
  TEXTISH_TYPES
} from '@shared/types'

const PRESENCE_RANK: Record<PresenceStatus, number> = { online: 3, idle: 2, dnd: 1, offline: 0 }
const asStatus = (s: unknown): PresenceStatus =>
  s === 'online' || s === 'idle' || s === 'dnd' ? s : 'offline'

const CATEGORY_TYPE = CHANNEL_TYPE.GUILD_CATEGORY

interface RawChannel {
  id: string
  type: number
  name?: string
  parent_id?: string | null
  position?: number
  last_message_id?: string | null
}

interface RawThread {
  id: string
  type: number
  name?: string
  parent_id?: string
  guild_id?: string
  last_message_id?: string | null
  message_count?: number
  thread_metadata?: { archived?: boolean }
}

interface RawGuild {
  id: string
  properties?: { name?: string; icon?: string | null }
  name?: string
  icon?: string | null
  channels?: RawChannel[]
  threads?: RawThread[]
}

interface RawUser {
  id: string
  username?: string
  global_name?: string | null
  avatar?: string | null
}

interface RawDm {
  id: string
  type: number
  name?: string | null
  icon?: string | null
  owner_id?: string
  recipient_ids?: string[]
  recipients?: RawUser[]
  last_message_id?: string | null
  /** true = someone added you but you haven't accepted; you're not a member yet. */
  is_message_request?: boolean
}

interface ReadStateEntry {
  id: string
  last_message_id?: string | null
  mention_count?: number
}

interface GuildSettings {
  guild_id: string | null
  muted?: boolean
  channel_overrides?: { channel_id: string; muted?: boolean }[]
}

const snapshotFilePath = () => join(app.getPath('userData'), 'snapshot.bin')

/** Owns the in-memory model and derives the UnifiedState the renderer renders. */
export class Store extends EventEmitter {
  private status: ConnectionStatus = 'idle'
  private detail?: string
  private self: UnifiedState['self'] = null
  private guilds = new Map<string, RawGuild>()
  private threads = new Map<string, RawThread>()
  private dmChannels = new Map<string, RawDm>()
  private users = new Map<string, RawUser>()
  private presences = new Map<string, PresenceStatus>()
  private dmUserIds = new Set<string>()
  private readStates = new Map<string, ReadStateEntry>()
  private mutedGuilds = new Set<string>()
  private mutedChannels = new Set<string>()
  private syncedAt: number | null = null
  private local: LocalState = { prefs: {}, pinnedThreads: [], pinnedChannels: [], categoryLayout: {} }

  constructor() {
    super()
    this.loadFromDb()
    this.reloadLocal()
  }

  private reloadLocal(): void {
    try {
      this.local = loadLocalState()
    } catch (e) {
      console.error('[store] local state load failed:', (e as Error).message)
    }
  }

  // --- Harmony-local layout mutations (FR-3 / FR-6 / FR-7) ---------------

  setPref(key: string, value: string): void {
    setPref(key, value)
    this.reloadLocal()
    this.emit('change')
  }

  setThreadPinned(threadId: string, pinned: boolean): void {
    if (pinned) pinThread(threadId, this.local.pinnedThreads.length)
    else unpinThread(threadId)
    this.reloadLocal()
    this.emit('change')
  }

  setThreadPinMeta(threadId: string, patch: { note?: string | null; label?: string | null }): void {
    updateThreadPin(threadId, patch)
    this.reloadLocal()
    this.emit('change')
  }

  reorderPinnedThreads(ids: string[]): void {
    reorderPinnedThreads(ids)
    this.reloadLocal()
    this.emit('change')
  }

  setChannelPinned(channelId: string, guildId: string, pinned: boolean): void {
    if (pinned) pinChannel(channelId, guildId, this.local.pinnedChannels.length)
    else unpinChannel(channelId)
    this.reloadLocal()
    this.emit('change')
  }

  reorderPinnedChannels(ids: string[]): void {
    reorderPinnedChannels(ids)
    this.reloadLocal()
    this.emit('change')
  }

  // --- message index + search (XR-3 / FR-4) -----------------------------

  private indexOne(d: any, mentionsMe: boolean): void {
    try {
      indexMessage(toRow(d), {
        guildId: d.guild_id ?? null,
        channelId: d.channel_id,
        mentionsMe,
        mine: !!this.self && d.author?.id === this.self.id,
        everyone: !!d.mention_everyone,
        replyToMe: !!this.self && d.referenced_message?.author?.id === this.self.id
      })
    } catch (e) {
      console.error('[store] index failed:', (e as Error).message)
    }
  }

  /** Cache-on-read: index a page of messages fetched for a channel view. */
  indexFetched(channelId: string, rows: MessageRow[]): void {
    const guildId = this.channelContext(channelId).guildId || null
    for (const row of rows) {
      try {
        indexMessage(row, {
          guildId,
          channelId,
          mentionsMe: !!this.self && row.mentions.some((u) => u.id === this.self!.id),
          mine: !!this.self && row.authorId === this.self.id
        })
      } catch {
        /* best effort */
      }
    }
  }

  setMessageTriage(
    messageId: string,
    patch: { resolved?: boolean; starred?: boolean; snoozeUntil?: number | null }
  ): void {
    setTriage(messageId, patch)
  }

  search(queryString: string, opts: SearchScopeOpts): { results: SearchResult[]; indexed: number } {
    const q = parseQuery(queryString)

    let channelIds: string[] | null = null
    const wanted = [...q.in, ...q.thread]
    if (wanted.length) {
      const frags = wanted.map((f) => f.toLowerCase())
      const set = new Set<string>()
      for (const g of this.guilds.values()) {
        const gname = (g.properties?.name ?? g.name ?? '').toLowerCase()
        const guildMatch = frags.some((f) => gname.includes(f))
        for (const c of g.channels ?? []) {
          if (!c.name || c.type === CATEGORY_TYPE) continue
          if (guildMatch || frags.some((f) => c.name!.toLowerCase().includes(f))) set.add(c.id)
        }
      }
      for (const t of this.threads.values())
        if (t.name && frags.some((f) => t.name!.toLowerCase().includes(f))) set.add(t.id)
      for (const dm of this.dmChannels.values())
        if (frags.some((f) => this.dmDisplayName(dm).toLowerCase().includes(f))) set.add(dm.id)
      channelIds = [...set]
    }

    const searchOpts: SearchOpts = {
      channelIds,
      guildId: opts.scope === 'all' ? null : opts.scope === 'dm' ? 'dm' : opts.scope,
      excludeChannelIds: opts.excludeMuted ? this.mutedChannelIdSet() : [],
      mentionsOnly: opts.mentionsOnly,
      includeEveryone: opts.includeEveryone,
      includeReplies: opts.includeReplies,
      limit: opts.limit,
      offset: opts.offset
    }

    let hits = searchMessages(q, searchOpts)

    if (q.mentions.length) {
      const frags = q.mentions.map((f) => f.toLowerCase())
      hits = hits.filter((h) =>
        h.row.mentions.some((u) => frags.some((f) => u.name.toLowerCase().includes(f)))
      )
    }
    if (q.is.includes('unread')) hits = hits.filter((h) => this.hitUnread(h.channelId, h.id))

    return { results: hits.map((h) => this.decorateHit(h)), indexed: indexedMessageCount() }
  }

  private hitUnread(channelId: string, messageId: string): boolean {
    const rs = this.readStates.get(channelId)
    if (!rs?.last_message_id || !/^\d+$/.test(messageId)) return true
    return BigInt(messageId) > BigInt(rs.last_message_id)
  }

  private mutedChannelIdSet(): string[] {
    const set = new Set(this.mutedChannels)
    for (const gid of this.mutedGuilds)
      for (const c of this.guilds.get(gid)?.channels ?? []) set.add(c.id)
    return [...set]
  }

  private dmDisplayName(c: RawDm): string {
    const ids = c.recipient_ids ?? c.recipients?.map((r) => r.id) ?? []
    if (c.type === 3) return c.name?.trim() || ids.map((id) => this.userName(id)).join(', ') || 'Group DM'
    return ids[0] ? this.userName(ids[0]) : 'Direct Message'
  }

  private channelContext(channelId: string): {
    guildId: string
    guildName: string
    channelName: string
    threadName: string | null
    isDm: boolean
  } {
    const dm = this.dmChannels.get(channelId)
    if (dm)
      return {
        guildId: '',
        guildName: 'Direct Messages',
        channelName: this.dmDisplayName(dm),
        threadName: null,
        isDm: true
      }
    const th = this.threads.get(channelId)
    if (th) {
      const g = th.guild_id ? this.guilds.get(th.guild_id) : undefined
      const parent = g?.channels?.find((c) => c.id === th.parent_id)
      return {
        guildId: th.guild_id ?? '',
        guildName: g?.properties?.name ?? g?.name ?? '',
        channelName: parent?.name ?? 'channel',
        threadName: th.name ?? 'thread',
        isDm: false
      }
    }
    for (const g of this.guilds.values()) {
      const c = g.channels?.find((x) => x.id === channelId)
      if (c)
        return {
          guildId: g.id,
          guildName: g.properties?.name ?? g.name ?? '',
          channelName: c.name ?? 'channel',
          threadName: null,
          isDm: false
        }
    }
    return { guildId: '', guildName: '', channelName: 'unknown', threadName: null, isDm: false }
  }

  private decorateHit(h: SearchHit): SearchResult {
    const ctx = this.channelContext(h.channelId)
    return {
      ...h.row,
      channelId: h.channelId,
      guildId: ctx.guildId,
      guildName: ctx.guildName,
      channelName: ctx.channelName,
      threadName: ctx.threadName,
      isDm: ctx.isDm,
      unread: this.hitUnread(h.channelId, h.id),
      resolved: h.resolved,
      starred: h.starred,
      snoozeUntil: h.snoozeUntil
    }
  }

  setCategoryLayout(
    categoryId: string,
    guildId: string,
    patch: { pinned?: boolean; collapsed?: boolean; force?: 'show' | 'hide' | null }
  ): void {
    setCategoryLayout(categoryId, guildId, patch)
    this.reloadLocal()
    this.emit('change')
  }

  reorderPinnedCategories(ids: string[]): void {
    reorderPinnedCategories(ids)
    this.reloadLocal()
    this.emit('change')
  }

  setStatus(status: ConnectionStatus, detail?: string): void {
    this.status = status
    this.detail = detail
    this.emit('change')
  }

  /** Feed every gateway dispatch through here. */
  ingest(type: string | null, d: any): void {
    switch (type) {
      case 'READY': {
        this.self = d.user
          ? { id: d.user.id, username: d.user.username, globalName: d.user.global_name ?? null }
          : null
        this.guilds.clear()
        this.threads.clear()
        for (const g of d.guilds ?? []) {
          this.upsertGuild(g)
          for (const t of g.threads ?? []) this.threads.set(t.id, t)
        }

        this.users.clear()
        for (const u of d.users ?? []) this.users.set(u.id, u)
        if (d.user) this.users.set(d.user.id, d.user) // so we can render "you" in group DMs

        this.dmChannels.clear()
        for (const c of d.private_channels ?? []) {
          this.dmChannels.set(c.id, c)
          for (const r of c.recipients ?? []) this.users.set(r.id, r)
        }
        this.rebuildDmUserIds()

        // some builds put friend presences right in READY
        for (const p of d.merged_presences?.friends ?? []) {
          if (p.user_id) this.presences.set(p.user_id, asStatus(p.status))
        }

        this.readStates.clear()
        const rs: ReadStateEntry[] = d.read_state?.entries ?? d.read_state ?? []
        for (const e of rs) this.readStates.set(e.id, e)

        this.mutedGuilds.clear()
        this.mutedChannels.clear()
        const ugs: GuildSettings[] = d.user_guild_settings?.entries ?? d.user_guild_settings ?? []
        for (const s of ugs) {
          if (s.muted && s.guild_id) this.mutedGuilds.add(s.guild_id)
          for (const o of s.channel_overrides ?? []) if (o.muted) this.mutedChannels.add(o.channel_id)
        }

        this.syncedAt = Date.now()
        this.status = 'ready'
        this.detail = undefined
        this.persist()
        this.emit('change')
        break
      }

      // With capabilities that lazy-load guilds, full guild objects arrive here.
      case 'GUILD_CREATE':
      case 'GUILD_UPDATE': {
        this.upsertGuild(d)
        this.emit('change')
        break
      }
      case 'GUILD_DELETE': {
        if (!d.unavailable) this.guilds.delete(d.id)
        this.emit('change')
        break
      }

      case 'READY_SUPPLEMENTAL': {
        const mp = d.merged_presences ?? {}
        for (const p of mp.friends ?? []) {
          if (p.user_id) this.presences.set(p.user_id, asStatus(p.status))
        }
        for (const guildArr of mp.guilds ?? []) {
          for (const p of guildArr ?? []) {
            if (p.user_id) this.presences.set(p.user_id, asStatus(p.status))
          }
        }
        this.emit('change')
        break
      }
      case 'PRESENCE_UPDATE': {
        const id = d.user?.id
        if (id) {
          this.presences.set(id, asStatus(d.status))
          if (this.dmUserIds.has(id)) this.emit('change')
        }
        break
      }

      case 'THREAD_CREATE':
      case 'THREAD_UPDATE': {
        if (d.id) {
          this.threads.set(d.id, d)
          this.emit('change')
        }
        break
      }
      case 'THREAD_DELETE': {
        if (d.id) {
          this.threads.delete(d.id)
          this.emit('change')
        }
        break
      }
      case 'THREAD_LIST_SYNC': {
        for (const t of d.threads ?? []) this.threads.set(t.id, t)
        this.emit('change')
        break
      }

      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE': {
        if (d.type === 1 || d.type === 3) {
          this.dmChannels.set(d.id, d)
          for (const r of d.recipients ?? []) this.users.set(r.id, r)
          this.rebuildDmUserIds()
          this.emit('change')
          break
        }
        const g = d.guild_id ? this.guilds.get(d.guild_id) : undefined
        if (g) {
          const channels: RawChannel[] = (g.channels = g.channels ?? [])
          const i = channels.findIndex((c) => c.id === d.id)
          if (i >= 0) channels[i] = d
          else channels.push(d)
          this.emit('change')
        }
        break
      }
      case 'CHANNEL_DELETE': {
        if (d.type === 1 || d.type === 3) {
          this.dmChannels.delete(d.id)
          this.rebuildDmUserIds()
          this.emit('change')
          break
        }
        const g = d.guild_id ? this.guilds.get(d.guild_id) : undefined
        if (g?.channels) {
          g.channels = g.channels.filter((c) => c.id !== d.id)
          this.emit('change')
        }
        break
      }

      case 'MESSAGE_CREATE': {
        // Bump unread: pretend the channel's last_message_id advanced.
        const g = d.guild_id ? this.guilds.get(d.guild_id) : undefined
        const ch = g?.channels?.find((c) => c.id === d.channel_id)
        if (ch) ch.last_message_id = d.id
        const dm = this.dmChannels.get(d.channel_id)
        if (dm) dm.last_message_id = d.id
        const th = this.threads.get(d.channel_id)
        if (th) th.last_message_id = d.id
        const mentionsMe =
          Array.isArray(d.mentions) && d.mentions.some((m: { id: string }) => m.id === this.self?.id)
        if (mentionsMe) {
          const rsEntry: ReadStateEntry = this.readStates.get(d.channel_id) ?? { id: d.channel_id }
          rsEntry.mention_count = (rsEntry.mention_count ?? 0) + 1
          this.readStates.set(d.channel_id, rsEntry)
        }
        this.indexOne(d, mentionsMe)
        this.emit('message', { kind: 'create', channelId: d.channel_id, message: toRow(d) })
        this.emit('change')
        break
      }

      case 'MESSAGE_UPDATE': {
        if (d.id && d.channel_id) {
          if (d.timestamp && d.author) {
            const mm =
              Array.isArray(d.mentions) &&
              d.mentions.some((m: { id: string }) => m.id === this.self?.id)
            this.indexOne(d, mm)
          }
          this.emit('message', { kind: 'update', channelId: d.channel_id, message: toRow(d) })
        }
        break
      }
      case 'MESSAGE_DELETE': {
        if (d.id && d.channel_id) {
          try {
            deleteIndexedMessage(d.id)
          } catch {
            /* index best-effort */
          }
          this.emit('message', { kind: 'delete', channelId: d.channel_id, id: d.id })
        }
        break
      }

      case 'MESSAGE_REACTION_ADD':
      case 'MESSAGE_REACTION_REMOVE': {
        if (!d.message_id || !d.channel_id || !d.emoji) break
        const e = d.emoji as { name: string | null; id: string | null; animated?: boolean }
        this.emit('message', {
          kind: 'reaction',
          channelId: d.channel_id,
          messageId: d.message_id,
          emoji: {
            key: e.id ? `${e.name ?? '_'}:${e.id}` : (e.name ?? ''),
            name: e.name ?? '',
            id: e.id,
            animated: !!e.animated
          },
          delta: type === 'MESSAGE_REACTION_ADD' ? 1 : -1,
          me: d.user_id === this.self?.id
        })
        break
      }

      case 'TYPING_START': {
        if (!d.channel_id || !d.user_id) break
        this.emit('typing', {
          channelId: d.channel_id,
          userId: d.user_id,
          userName: this.userName(d.user_id)
        })
        break
      }

      case 'MESSAGE_ACK': {
        const e: ReadStateEntry = this.readStates.get(d.channel_id) ?? { id: d.channel_id }
        e.last_message_id = d.message_id
        e.mention_count = typeof d.mention_count === 'number' ? d.mention_count : 0
        this.readStates.set(d.channel_id, e)
        this.emit('change')
        break
      }

      case 'USER_GUILD_SETTINGS_UPDATE': {
        const gid: string | null = d.guild_id ?? null
        if (gid) {
          if (d.muted) this.mutedGuilds.add(gid)
          else this.mutedGuilds.delete(gid)
        }
        for (const o of d.channel_overrides ?? []) {
          if (o.muted) this.mutedChannels.add(o.channel_id)
          else this.mutedChannels.delete(o.channel_id)
        }
        this.persist()
        this.emit('change')
        break
      }
    }
  }

  /** Optimistic read-state bump so the sidebar clears before the gateway echoes. */
  markReadLocal(channelId: string, messageId: string): void {
    const e: ReadStateEntry = this.readStates.get(channelId) ?? { id: channelId }
    e.last_message_id = messageId
    e.mention_count = 0
    this.readStates.set(channelId, e)
    this.emit('change')
  }

  /** Optimistic mute toggle. */
  setMutedLocal(id: string, kind: 'guild' | 'channel', muted: boolean): void {
    const set = kind === 'guild' ? this.mutedGuilds : this.mutedChannels
    if (muted) set.add(id)
    else set.delete(id)
    this.emit('change')
  }

  private upsertGuild(g: RawGuild): void {
    const existing = this.guilds.get(g.id)
    // GUILD_CREATE carries channels; keep the richest copy.
    if (existing && (!g.channels || g.channels.length === 0)) {
      this.guilds.set(g.id, { ...existing, ...g, channels: existing.channels })
    } else {
      this.guilds.set(g.id, g)
    }
  }

  getState(): UnifiedState {
    const groups: GuildGroup[] = []
    let unreadTotal = 0
    let mentionTotal = 0
    let channelTotal = 0

    const pinnedThreadIds = new Set(this.local.pinnedThreads.map((p) => p.threadId))
    const pinnedChannelMap = new Map(this.local.pinnedChannels.map((p) => [p.channelId, p]))
    const { categoryLayout } = this.local
    const hideEmptyCategories = this.local.prefs.hideEmptyCategories !== '0'
    const emptyMode: UnifiedState['local']['emptyMode'] =
      this.local.prefs.emptyMode === 'no-unread' ? 'no-unread' : 'no-visible'

    // active threads grouped by their parent channel id
    const threadsByParent = new Map<string, ThreadRow[]>()
    for (const t of this.threads.values()) {
      if (!t.parent_id) continue
      const rs = this.readStates.get(t.id)
      const unread =
        !!t.last_message_id &&
        (!rs?.last_message_id || BigInt(t.last_message_id) > BigInt(rs.last_message_id))
      const row: ThreadRow = {
        id: t.id,
        parentId: t.parent_id,
        name: t.name ?? 'thread',
        archived: !!t.thread_metadata?.archived,
        messageCount: t.message_count ?? 0,
        unread,
        mentionCount: rs?.mention_count ?? 0,
        pinned: pinnedThreadIds.has(t.id)
      }
      const list = threadsByParent.get(t.parent_id) ?? threadsByParent.set(t.parent_id, []).get(t.parent_id)!
      list.push(row)
    }
    for (const list of threadsByParent.values()) {
      list.sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          Number(b.unread) - Number(a.unread) ||
          a.name.localeCompare(b.name)
      )
    }

    for (const g of this.guilds.values()) {
      const name = g.properties?.name ?? g.name ?? 'Unknown server'
      const icon = g.properties?.icon ?? g.icon ?? null
      const allChannels = g.channels ?? []

      const categoryNames = new Map<string, { name: string; position: number }>()
      for (const c of allChannels) {
        if (c.type === CATEGORY_TYPE) {
          categoryNames.set(c.id, { name: c.name ?? 'Category', position: c.position ?? 0 })
        }
      }

      // bucket text-ish channels by parent category id ('' = no category)
      const buckets = new Map<string, ChannelRow[]>()
      for (const c of allChannels) {
        if (!TEXTISH_TYPES.includes(c.type)) continue
        channelTotal++
        const rs = this.readStates.get(c.id)
        const unread =
          !!c.last_message_id && (!rs?.last_message_id || BigInt(c.last_message_id) > BigInt(rs.last_message_id))
        const mentionCount = rs?.mention_count ?? 0
        if (unread) unreadTotal++
        mentionTotal += mentionCount
        const pin = pinnedChannelMap.get(c.id)
        const row: ChannelRow = {
          id: c.id,
          guildId: g.id,
          name: c.name ?? 'unknown',
          type: c.type,
          parentId: c.parent_id ?? null,
          position: c.position ?? 0,
          unread,
          mentionCount,
          muted: this.mutedGuilds.has(g.id) || this.mutedChannels.has(c.id),
          pinned: !!pin,
          pinSortKey: pin?.sortKey ?? 0,
          threads: threadsByParent.get(c.id) ?? []
        }
        const key = c.parent_id && categoryNames.has(c.parent_id) ? c.parent_id : ''
        ;(buckets.get(key) ?? buckets.set(key, []).get(key)!).push(row)
      }

      const categories: CategoryGroup[] = []
      for (const [key, rows] of buckets) {
        rows.sort(
          (a, b) =>
            Number(b.pinned) - Number(a.pinned) ||
            a.pinSortKey - b.pinSortKey ||
            a.position - b.position ||
            a.name.localeCompare(b.name)
        )
        const recentActivity = rows.reduce((max, r) => {
          const raw = this.guilds.get(g.id)?.channels?.find((c) => c.id === r.id)?.last_message_id
          return raw && BigInt(raw) > BigInt(max) ? raw : max
        }, '0')
        const meta = key ? categoryNames.get(key) : undefined
        const layout = key ? categoryLayout[key] : undefined
        const pinned = !!layout?.pinned

        // FR-6: hide a real category with nothing worth showing, unless pinned
        // or force-shown; force-hide always wins.
        const empty =
          emptyMode === 'no-unread'
            ? !rows.some((r) => r.unread || r.mentionCount > 0)
            : rows.length === 0
        let hidden = false
        if (layout?.force === 'hide') hidden = true
        else if (layout?.force === 'show' || pinned) hidden = false
        else if (hideEmptyCategories && key && empty) hidden = true

        categories.push({
          id: key || null,
          name: meta?.name ?? null,
          position: meta?.position ?? -1,
          recentActivity,
          channels: rows,
          pinned,
          pinSortKey: layout?.sortKey ?? 0,
          collapsed: !!layout?.collapsed,
          hidden
        })
      }

      // FR-6: categories with no viewable channels at all. Kept in the model
      // (flagged hidden) so the "N hidden categories" affordance can reveal them.
      for (const [catId, cmeta] of categoryNames) {
        if (buckets.has(catId)) continue
        const layout = categoryLayout[catId]
        const pinned = !!layout?.pinned
        let hidden = false
        if (layout?.force === 'hide') hidden = true
        else if (layout?.force === 'show' || pinned) hidden = false
        else if (hideEmptyCategories) hidden = true
        categories.push({
          id: catId,
          name: cmeta.name,
          position: cmeta.position,
          recentActivity: '0',
          channels: [],
          pinned,
          pinSortKey: layout?.sortKey ?? 0,
          collapsed: !!layout?.collapsed,
          hidden
        })
      }

      groups.push({
        id: g.id,
        name,
        iconUrl: icon ? `https://cdn.discordapp.com/icons/${g.id}/${icon}.png?size=64` : null,
        position: 0,
        muted: this.mutedGuilds.has(g.id),
        categories
      })
    }

    groups.sort((a, b) => a.name.localeCompare(b.name))

    const dms = this.buildDms()

    return {
      status: this.status,
      detail: this.detail,
      self: this.self,
      guilds: groups,
      dms,
      syncedAt: this.syncedAt,
      counts: {
        guilds: groups.length,
        channels: channelTotal,
        unread: unreadTotal,
        mentions: mentionTotal
      },
      local: {
        hideEmptyCategories,
        emptyMode,
        pinnedThreads: this.buildPinnedThreads(),
        pinnedChannels: this.buildPinnedChannels()
      }
    }
  }

  /** Resolve every pinned channel for the global "Pinned" view (Q14). */
  private buildPinnedChannels(): PinnedChannelView[] {
    return this.local.pinnedChannels.map((p) => {
      const g = this.guilds.get(p.guildId)
      const ch = g?.channels?.find((c) => c.id === p.channelId)
      const guildName = g?.properties?.name ?? g?.name ?? ''
      if (!g || !ch) {
        return {
          id: p.channelId,
          name: 'Removed channel',
          guildId: p.guildId,
          guildName,
          categoryName: '',
          unread: false,
          mentionCount: 0,
          muted: false,
          sortKey: p.sortKey,
          missing: true
        }
      }
      const rs = this.readStates.get(ch.id)
      const unread =
        !!ch.last_message_id &&
        (!rs?.last_message_id || BigInt(ch.last_message_id) > BigInt(rs.last_message_id))
      const cat = ch.parent_id ? g.channels?.find((c) => c.id === ch.parent_id) : undefined
      return {
        id: ch.id,
        name: ch.name ?? 'channel',
        guildId: g.id,
        guildName,
        categoryName: cat?.name ?? '',
        unread,
        mentionCount: rs?.mention_count ?? 0,
        muted: this.mutedGuilds.has(g.id) || this.mutedChannels.has(ch.id),
        sortKey: p.sortKey,
        missing: false
      }
    })
  }

  /** Resolve every pinned thread id for the global "Pinned" view (FR-3 / Q14). */
  private buildPinnedThreads(): PinnedThreadView[] {
    const guildName = (id: string | undefined): string => {
      if (!id) return ''
      const g = this.guilds.get(id)
      return g?.properties?.name ?? g?.name ?? 'Unknown server'
    }
    const channelName = (guildId: string | undefined, channelId: string | undefined): string => {
      if (!guildId || !channelId) return ''
      return this.guilds.get(guildId)?.channels?.find((c) => c.id === channelId)?.name ?? ''
    }

    return this.local.pinnedThreads.map((p) => {
      const t = this.threads.get(p.threadId)
      if (!t) {
        return {
          id: p.threadId,
          name: p.label || 'Removed thread',
          guildId: '',
          guildName: '',
          parentId: '',
          parentName: '',
          archived: false,
          unread: false,
          mentionCount: 0,
          messageCount: 0,
          note: p.note,
          label: p.label,
          sortKey: p.sortKey,
          missing: true
        }
      }
      const rs = this.readStates.get(t.id)
      const unread =
        !!t.last_message_id &&
        (!rs?.last_message_id || BigInt(t.last_message_id) > BigInt(rs.last_message_id))
      return {
        id: t.id,
        name: t.name ?? 'thread',
        guildId: t.guild_id ?? '',
        guildName: guildName(t.guild_id),
        parentId: t.parent_id ?? '',
        parentName: channelName(t.guild_id, t.parent_id),
        archived: !!t.thread_metadata?.archived,
        unread,
        mentionCount: rs?.mention_count ?? 0,
        messageCount: t.message_count ?? 0,
        note: p.note,
        label: p.label,
        sortKey: p.sortKey,
        missing: false
      }
    })
  }

  private userName(id: string): string {
    const u = this.users.get(id)
    return u?.global_name || u?.username || 'Unknown user'
  }

  private userAvatar(id: string): string | null {
    const av = this.users.get(id)?.avatar
    return av ? `https://cdn.discordapp.com/avatars/${id}/${av}.png?size=64` : null
  }

  private presenceOf(id: string): PresenceStatus {
    return this.presences.get(id) ?? 'offline'
  }

  private rebuildDmUserIds(): void {
    this.dmUserIds.clear()
    for (const c of this.dmChannels.values()) {
      const ids = c.recipient_ids ?? c.recipients?.map((r) => r.id) ?? []
      for (const id of ids) this.dmUserIds.add(id)
    }
  }

  private buildDms(): DmRow[] {
    const rows: DmRow[] = []
    for (const c of this.dmChannels.values()) {
      const recipientIds = c.recipient_ids ?? c.recipients?.map((r) => r.id) ?? []
      let name: string
      let iconUrl: string | null = null
      let status: PresenceStatus = 'offline'
      let members: DmMemberRow[] = []

      if (c.type === 3) {
        name = c.name?.trim() || recipientIds.map((id) => this.userName(id)).join(', ') || 'Group DM'
        iconUrl = c.icon ? `https://cdn.discordapp.com/channel-icons/${c.id}/${c.icon}.png?size=64` : null
        // recipient_ids never includes you — add yourself explicitly, first
        const otherMembers: DmMemberRow[] = recipientIds
          .filter((id) => id !== this.self?.id)
          .map((id) => ({
            id,
            name: this.userName(id),
            avatarUrl: this.userAvatar(id),
            status: this.presenceOf(id)
          }))
          .sort(
            (a, b) =>
              PRESENCE_RANK[b.status] - PRESENCE_RANK[a.status] || a.name.localeCompare(b.name)
          )
        // only list yourself when you're actually a participant — i.e. you own the
        // group or it's a real conversation, not a pending invite you haven't joined
        const joined = !c.is_message_request || c.owner_id === this.self?.id
        const selfMember: DmMemberRow[] =
          this.self && joined
            ? [
                {
                  id: this.self.id,
                  name: `${this.userName(this.self.id)} (you)`,
                  avatarUrl: this.userAvatar(this.self.id),
                  status: 'online'
                }
              ]
            : []
        members = [...selfMember, ...otherMembers]
        // rollup ignores you, so an idle group doesn't look green just because you're on
        status = otherMembers.reduce<PresenceStatus>(
          (best, m) => (PRESENCE_RANK[m.status] > PRESENCE_RANK[best] ? m.status : best),
          'offline'
        )
      } else {
        const other = recipientIds[0]
        name = other ? this.userName(other) : 'Direct Message'
        iconUrl = other ? this.userAvatar(other) : null
        status = other ? this.presenceOf(other) : 'offline'
      }

      const rs = this.readStates.get(c.id)
      const unread =
        !!c.last_message_id &&
        (!rs?.last_message_id || BigInt(c.last_message_id) > BigInt(rs.last_message_id))

      rows.push({
        id: c.id,
        type: c.type,
        name,
        iconUrl,
        unread,
        mentionCount: rs?.mention_count ?? 0,
        muted: this.mutedChannels.has(c.id),
        status,
        members
      })
    }
    rows.sort((a, b) => {
      const av = BigInt(this.dmChannels.get(a.id)?.last_message_id || '0')
      const bv = BigInt(this.dmChannels.get(b.id)?.last_message_id || '0')
      return av > bv ? -1 : av < bv ? 1 : 0
    })
    return rows
  }

  reset(): void {
    this.guilds.clear()
    this.threads.clear()
    this.dmChannels.clear()
    this.users.clear()
    this.presences.clear()
    this.dmUserIds.clear()
    this.readStates.clear()
    this.mutedGuilds.clear()
    this.mutedChannels.clear()
    this.self = null
    this.syncedAt = null
    this.status = 'no-token'
    try {
      clearModel()
    } catch (e) {
      console.error('[store] clear failed:', (e as Error).message)
    }
    this.emit('change')
  }

  // --- local mirror (SQLite via db.ts) ------------------------------------

  private toModel(): StoreModel {
    const rows = (v: Iterable<unknown>): Record<string, unknown>[] =>
      [...v] as Record<string, unknown>[]
    return {
      self: this.self,
      syncedAt: this.syncedAt,
      guilds: rows(this.guilds.values()),
      threads: rows(this.threads.values()),
      dmChannels: rows(this.dmChannels.values()),
      users: rows(this.users.values()),
      presences: [...this.presences.entries()],
      readStates: rows(this.readStates.values()),
      mutedGuilds: [...this.mutedGuilds],
      mutedChannels: [...this.mutedChannels]
    }
  }

  private applyModel(s: StoreModel): void {
    this.self = (s.self as UnifiedState['self']) ?? null
    for (const g of s.guilds) this.guilds.set(String(g.id), g as unknown as RawGuild)
    for (const t of s.threads) this.threads.set(String(t.id), t as unknown as RawThread)
    for (const c of s.dmChannels) this.dmChannels.set(String(c.id), c as unknown as RawDm)
    for (const u of s.users) this.users.set(String(u.id), u as unknown as RawUser)
    for (const [id, st] of s.presences) this.presences.set(id, asStatus(st))
    for (const e of s.readStates) this.readStates.set(String(e.id), e as unknown as ReadStateEntry)
    this.rebuildDmUserIds()
    this.mutedGuilds = new Set(s.mutedGuilds)
    this.mutedChannels = new Set(s.mutedChannels)
    this.syncedAt = s.syncedAt
  }

  private persist(): void {
    try {
      saveModel(this.toModel())
    } catch (e) {
      console.error('[store] persist failed:', (e as Error).message)
    }
  }

  private loadFromDb(): void {
    try {
      let model = loadModel()
      if (!model) model = this.loadSnapshotFile()
      if (!model) return
      this.applyModel(model)
      console.log('[store] loaded from db:', this.guilds.size, 'guilds')
      if (this.guilds.size > 0) this.status = 'ready'
    } catch (e) {
      console.error('[store] load failed:', (e as Error).message)
    }
  }

  /** Read a `snapshot.bin` JSON file into the database when the DB is empty. */
  private loadSnapshotFile(): StoreModel | null {
    const json = readSecure(snapshotFilePath())
    if (!json) return null
    try {
      const s = JSON.parse(json)
      const model: StoreModel = {
        self: s.self ?? null,
        syncedAt: s.syncedAt ?? null,
        guilds: s.guilds ?? [],
        threads: s.threads ?? [],
        dmChannels: s.dmChannels ?? [],
        users: s.users ?? [],
        presences: s.presences ?? [],
        readStates: s.readStates ?? [],
        mutedGuilds: s.mutedGuilds ?? [],
        mutedChannels: s.mutedChannels ?? []
      }
      saveModel(model)
      console.log('[store] loaded snapshot.bin')
      return model
    } catch {
      console.error('[store] snapshot.bin parse failed')
      return null
    }
  }
}
