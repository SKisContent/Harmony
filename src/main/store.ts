import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { app } from 'electron'
import { readSecure, writeSecure } from './secure-file'
import {
  type CategoryGroup,
  type ChannelRow,
  type ConnectionStatus,
  type DmMemberRow,
  type DmRow,
  type GuildGroup,
  type PresenceStatus,
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

const snapshotPath = () => join(app.getPath('userData'), 'snapshot.bin')

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

  constructor() {
    super()
    this.loadSnapshot()
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
        this.saveSnapshot()
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
        this.emit('change')
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
    }
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
        mentionCount: rs?.mention_count ?? 0
      }
      const list = threadsByParent.get(t.parent_id) ?? threadsByParent.set(t.parent_id, []).get(t.parent_id)!
      list.push(row)
    }
    for (const list of threadsByParent.values()) {
      list.sort((a, b) => Number(b.unread) - Number(a.unread) || a.name.localeCompare(b.name))
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
          threads: threadsByParent.get(c.id) ?? []
        }
        const key = c.parent_id && categoryNames.has(c.parent_id) ? c.parent_id : ''
        ;(buckets.get(key) ?? buckets.set(key, []).get(key)!).push(row)
      }

      const categories: CategoryGroup[] = []
      for (const [key, rows] of buckets) {
        rows.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
        const recentActivity = rows.reduce((max, r) => {
          const raw = this.guilds.get(g.id)?.channels?.find((c) => c.id === r.id)?.last_message_id
          return raw && BigInt(raw) > BigInt(max) ? raw : max
        }, '0')
        const meta = key ? categoryNames.get(key) : undefined
        categories.push({
          id: key || null,
          name: meta?.name ?? null,
          position: meta?.position ?? -1,
          recentActivity,
          channels: rows
        })
      }

      groups.push({
        id: g.id,
        name,
        iconUrl: icon ? `https://cdn.discordapp.com/icons/${g.id}/${icon}.png?size=64` : null,
        position: 0,
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
      }
    }
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
    this.emit('change')
  }

  // --- snapshot persistence (JSON via secure-file; SQLite replaces this next) ---

  private saveSnapshot(): void {
    try {
      const json = JSON.stringify({
        self: this.self,
        guilds: [...this.guilds.values()],
        threads: [...this.threads.values()],
        dmChannels: [...this.dmChannels.values()],
        users: [...this.users.values()],
        presences: [...this.presences.entries()],
        readStates: [...this.readStates.values()],
        mutedGuilds: [...this.mutedGuilds],
        mutedChannels: [...this.mutedChannels],
        syncedAt: this.syncedAt
      })
      writeSecure(snapshotPath(), json)
    } catch {
      /* best effort */
    }
  }

  private loadSnapshot(): void {
    const json = readSecure(snapshotPath())
    if (!json) return
    try {
      const s = JSON.parse(json)
      this.self = s.self ?? null
      for (const g of s.guilds ?? []) this.guilds.set(g.id, g)
      for (const t of s.threads ?? []) this.threads.set(t.id, t)
      for (const c of s.dmChannels ?? []) this.dmChannels.set(c.id, c)
      for (const u of s.users ?? []) this.users.set(u.id, u)
      for (const [id, st] of s.presences ?? []) this.presences.set(id, asStatus(st))
      for (const e of s.readStates ?? []) this.readStates.set(e.id, e)
      this.rebuildDmUserIds()
      this.mutedGuilds = new Set(s.mutedGuilds ?? [])
      this.mutedChannels = new Set(s.mutedChannels ?? [])
      this.syncedAt = s.syncedAt ?? null
      console.log('[store] snapshot loaded:', this.guilds.size, 'guilds')
      if (this.guilds.size > 0) this.status = 'ready'
    } catch {
      console.error('[store] snapshot parse failed')
    }
  }
}
