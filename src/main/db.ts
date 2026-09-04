// The local SQLite store: a durable mirror of the gateway state so the UI can
// paint before the gateway connects, plus a full-text index for retrieval.
//
// The DB is plaintext on disk. The account token is encrypted separately by
// secure-file.

import { join } from 'node:path'
import { app } from 'electron'
import Database from 'better-sqlite3'
import type { MessageRow } from '@shared/types'
import type { ParsedQuery } from './search-query'
import { MSG_FLAG, type SearchOpts, buildSearchSql } from './search-sql'

export type { SearchOpts }

const SCHEMA_VERSION = 4

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- the guild blob carries its own channels[]; there is no separate channels table.
CREATE TABLE IF NOT EXISTS guilds (
  id   TEXT PRIMARY KEY,
  name TEXT,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id              TEXT PRIMARY KEY,
  parent_id       TEXT,
  guild_id        TEXT,
  name            TEXT,
  archived        INTEGER,
  last_message_id TEXT,
  data            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_parent ON threads(parent_id);

CREATE TABLE IF NOT EXISTS dm_channels (
  id              TEXT PRIMARY KEY,
  type            INTEGER,
  last_message_id TEXT,
  data            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id   TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS presences (
  user_id TEXT PRIMARY KEY,
  status  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS read_states (
  id              TEXT PRIMARY KEY,
  last_message_id TEXT,
  mention_count   INTEGER,
  data            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS muted (
  id   TEXT PRIMARY KEY,
  kind TEXT NOT NULL          -- 'guild' | 'channel'
);

-- message cache and full-text index (XR-3). Populated live from MESSAGE_CREATE,
-- on channel scroll, and by the FR-4 mentions backfill.
-- flags: bit0 mentions-me, bit1 authored-by-me, bit2 link, bit3 image,
--        bit4 file, bit5 video, bit6 embed, bit7 code, bit8 edited.
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL,
  guild_id    TEXT,
  author_id   TEXT,
  author_name TEXT,
  created_at  TEXT,
  edited_at   TEXT,
  flags       INTEGER NOT NULL DEFAULT 0,
  data        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  author_name,
  message_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Harmony-local triage state for the mentions inbox (FR-4).
CREATE TABLE IF NOT EXISTS message_triage (
  message_id   TEXT PRIMARY KEY,
  resolved     INTEGER NOT NULL DEFAULT 0,
  starred      INTEGER NOT NULL DEFAULT 0,
  snooze_until INTEGER,
  updated_at   INTEGER NOT NULL
);

-- Harmony-local layout state (never sent to Discord). FR-3 / FR-6 / FR-7.
CREATE TABLE IF NOT EXISTS pinned_threads (
  thread_id TEXT PRIMARY KEY,
  added_at  INTEGER NOT NULL,
  sort_key  REAL NOT NULL,
  note      TEXT,
  label     TEXT
);

CREATE TABLE IF NOT EXISTS pinned_channels (
  channel_id TEXT PRIMARY KEY,
  guild_id   TEXT NOT NULL,
  added_at   INTEGER NOT NULL,
  sort_key   REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS category_layout (
  category_id TEXT PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0,
  sort_key    REAL NOT NULL DEFAULT 0,
  collapsed   INTEGER NOT NULL DEFAULT 0,
  force       TEXT                         -- NULL | 'show' | 'hide'
);

CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

let handle: Database.Database | null = null

export function db(): Database.Database {
  if (handle) return handle
  const d = new Database(join(app.getPath('userData'), 'harmony.db'))
  d.pragma('journal_mode = WAL')
  d.pragma('synchronous = NORMAL')
  const from = d.pragma('user_version', { simple: true }) as number
  // v4 reshapes the (unpopulated) message index; safe to drop and recreate.
  if (from < 4) d.exec('DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS messages_fts;')
  d.exec(SCHEMA)
  d.pragma(`user_version = ${SCHEMA_VERSION}`)
  handle = d
  return d
}

/** Everything the in-memory store needs to rehydrate on launch. */
export interface StoreModel {
  self: unknown
  syncedAt: number | null
  guilds: Record<string, unknown>[]
  threads: Record<string, unknown>[]
  dmChannels: Record<string, unknown>[]
  users: Record<string, unknown>[]
  presences: [string, string][]
  readStates: Record<string, unknown>[]
  mutedGuilds: string[]
  mutedChannels: string[]
}

const str = (v: unknown): string | null => (v == null ? null : String(v))

export function saveModel(m: StoreModel): void {
  const d = db()
  const run = d.transaction((model: StoreModel) => {
    d.prepare('DELETE FROM guilds').run()
    d.prepare('DELETE FROM threads').run()
    d.prepare('DELETE FROM dm_channels').run()
    d.prepare('DELETE FROM users').run()
    d.prepare('DELETE FROM presences').run()
    d.prepare('DELETE FROM read_states').run()
    d.prepare('DELETE FROM muted').run()

    const gi = d.prepare('INSERT INTO guilds (id, name, data) VALUES (?, ?, ?)')
    for (const g of model.guilds) {
      const props = (g.properties ?? {}) as Record<string, unknown>
      gi.run(String(g.id), str(props.name ?? g.name), JSON.stringify(g))
    }

    const ti = d.prepare(
      `INSERT INTO threads (id, parent_id, guild_id, name, archived, last_message_id, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    for (const t of model.threads) {
      const meta = (t.thread_metadata ?? {}) as Record<string, unknown>
      ti.run(
        String(t.id),
        str(t.parent_id),
        str(t.guild_id),
        str(t.name),
        meta.archived ? 1 : 0,
        str(t.last_message_id),
        JSON.stringify(t)
      )
    }

    const di = d.prepare(
      'INSERT INTO dm_channels (id, type, last_message_id, data) VALUES (?, ?, ?, ?)'
    )
    for (const c of model.dmChannels) {
      di.run(String(c.id), Number(c.type ?? 0), str(c.last_message_id), JSON.stringify(c))
    }

    const ui = d.prepare('INSERT INTO users (id, data) VALUES (?, ?)')
    for (const u of model.users) ui.run(String(u.id), JSON.stringify(u))

    const pi = d.prepare('INSERT INTO presences (user_id, status) VALUES (?, ?)')
    for (const [id, s] of model.presences) pi.run(id, s)

    const ri = d.prepare(
      'INSERT INTO read_states (id, last_message_id, mention_count, data) VALUES (?, ?, ?, ?)'
    )
    for (const e of model.readStates) {
      ri.run(
        String(e.id),
        str(e.last_message_id),
        Number(e.mention_count ?? 0),
        JSON.stringify(e)
      )
    }

    const mi = d.prepare('INSERT INTO muted (id, kind) VALUES (?, ?)')
    for (const id of model.mutedGuilds) mi.run(id, 'guild')
    for (const id of model.mutedChannels) mi.run(id, 'channel')

    setMeta('self', JSON.stringify(model.self ?? null))
    setMeta('syncedAt', model.syncedAt == null ? '' : String(model.syncedAt))
  })
  run(m)
}

export function loadModel(): StoreModel | null {
  const d = db()
  const selfRaw = getMeta('self')
  const guilds = d.prepare('SELECT data FROM guilds').all() as { data: string }[]
  if (selfRaw == null && guilds.length === 0) return null

  const rows = (sql: string): Record<string, unknown>[] =>
    (d.prepare(sql).all() as { data: string }[]).map((r) => JSON.parse(r.data))

  const syncedAtRaw = getMeta('syncedAt')
  const mutedRows = d.prepare('SELECT id, kind FROM muted').all() as { id: string; kind: string }[]

  return {
    self: selfRaw ? JSON.parse(selfRaw) : null,
    syncedAt: syncedAtRaw ? Number(syncedAtRaw) : null,
    guilds: guilds.map((r) => JSON.parse(r.data)),
    threads: rows('SELECT data FROM threads'),
    dmChannels: rows('SELECT data FROM dm_channels'),
    users: rows('SELECT data FROM users'),
    presences: (d.prepare('SELECT user_id, status FROM presences').all() as {
      user_id: string
      status: string
    }[]).map((r) => [r.user_id, r.status]),
    readStates: rows('SELECT data FROM read_states'),
    mutedGuilds: mutedRows.filter((r) => r.kind === 'guild').map((r) => r.id),
    mutedChannels: mutedRows.filter((r) => r.kind === 'channel').map((r) => r.id)
  }
}

// --- Harmony-local layout state (FR-3 / FR-6 / FR-7) --------------------

export interface PinnedThreadRow {
  threadId: string
  addedAt: number
  sortKey: number
  note: string | null
  label: string | null
}

export interface CategoryLayoutRow {
  guildId: string
  pinned: boolean
  sortKey: number
  collapsed: boolean
  force: 'show' | 'hide' | null
}

export interface PinnedChannelRow {
  channelId: string
  guildId: string
  addedAt: number
  sortKey: number
}

export interface LocalState {
  prefs: Record<string, string>
  pinnedThreads: PinnedThreadRow[]
  pinnedChannels: PinnedChannelRow[]
  categoryLayout: Record<string, CategoryLayoutRow>
}

export function loadLocalState(): LocalState {
  const d = db()
  const prefs: Record<string, string> = {}
  for (const r of d.prepare('SELECT key, value FROM prefs').all() as {
    key: string
    value: string
  }[]) {
    prefs[r.key] = r.value
  }

  const pinnedThreads = (
    d
      .prepare('SELECT thread_id, added_at, sort_key, note, label FROM pinned_threads ORDER BY sort_key')
      .all() as {
      thread_id: string
      added_at: number
      sort_key: number
      note: string | null
      label: string | null
    }[]
  ).map((r) => ({
    threadId: r.thread_id,
    addedAt: r.added_at,
    sortKey: r.sort_key,
    note: r.note,
    label: r.label
  }))

  const pinnedChannels = (
    d
      .prepare('SELECT channel_id, guild_id, added_at, sort_key FROM pinned_channels ORDER BY sort_key')
      .all() as { channel_id: string; guild_id: string; added_at: number; sort_key: number }[]
  ).map((r) => ({
    channelId: r.channel_id,
    guildId: r.guild_id,
    addedAt: r.added_at,
    sortKey: r.sort_key
  }))

  const categoryLayout: Record<string, CategoryLayoutRow> = {}
  for (const r of d
    .prepare('SELECT category_id, guild_id, pinned, sort_key, collapsed, force FROM category_layout')
    .all() as {
    category_id: string
    guild_id: string
    pinned: number
    sort_key: number
    collapsed: number
    force: string | null
  }[]) {
    categoryLayout[r.category_id] = {
      guildId: r.guild_id,
      pinned: !!r.pinned,
      sortKey: r.sort_key,
      collapsed: !!r.collapsed,
      force: r.force === 'show' || r.force === 'hide' ? r.force : null
    }
  }

  return { prefs, pinnedThreads, pinnedChannels, categoryLayout }
}

export function setPref(key: string, value: string): void {
  db()
    .prepare('INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
    .run(key, value, value)
}

export function pinThread(threadId: string, sortKey: number): void {
  db()
    .prepare(
      `INSERT INTO pinned_threads (thread_id, added_at, sort_key) VALUES (?, ?, ?)
       ON CONFLICT(thread_id) DO NOTHING`
    )
    .run(threadId, Date.now(), sortKey)
}

export function unpinThread(threadId: string): void {
  db().prepare('DELETE FROM pinned_threads WHERE thread_id = ?').run(threadId)
}

export function updateThreadPin(
  threadId: string,
  patch: { note?: string | null; label?: string | null; sortKey?: number }
): void {
  const d = db()
  if (patch.note !== undefined)
    d.prepare('UPDATE pinned_threads SET note = ? WHERE thread_id = ?').run(patch.note, threadId)
  if (patch.label !== undefined)
    d.prepare('UPDATE pinned_threads SET label = ? WHERE thread_id = ?').run(patch.label, threadId)
  if (patch.sortKey !== undefined)
    d.prepare('UPDATE pinned_threads SET sort_key = ? WHERE thread_id = ?').run(
      patch.sortKey,
      threadId
    )
}

export function reorderPinnedThreads(orderedIds: string[]): void {
  const d = db()
  const upd = d.prepare('UPDATE pinned_threads SET sort_key = ? WHERE thread_id = ?')
  const run = d.transaction((ids: string[]) => ids.forEach((id, i) => upd.run(i, id)))
  run(orderedIds)
}

export function pinChannel(channelId: string, guildId: string, sortKey: number): void {
  db()
    .prepare(
      `INSERT INTO pinned_channels (channel_id, guild_id, added_at, sort_key) VALUES (?, ?, ?, ?)
       ON CONFLICT(channel_id) DO NOTHING`
    )
    .run(channelId, guildId, Date.now(), sortKey)
}

export function unpinChannel(channelId: string): void {
  db().prepare('DELETE FROM pinned_channels WHERE channel_id = ?').run(channelId)
}

export function reorderPinnedChannels(orderedIds: string[]): void {
  const d = db()
  const upd = d.prepare('UPDATE pinned_channels SET sort_key = ? WHERE channel_id = ?')
  const run = d.transaction((ids: string[]) => ids.forEach((id, i) => upd.run(i, id)))
  run(orderedIds)
}

export function setCategoryLayout(
  categoryId: string,
  guildId: string,
  patch: { pinned?: boolean; sortKey?: number; collapsed?: boolean; force?: 'show' | 'hide' | null }
): void {
  const d = db()
  d.prepare(
    `INSERT INTO category_layout (category_id, guild_id, pinned, sort_key, collapsed, force)
     VALUES (@id, @guild, 0, 0, 0, NULL)
     ON CONFLICT(category_id) DO NOTHING`
  ).run({ id: categoryId, guild: guildId })
  if (patch.pinned !== undefined)
    d.prepare('UPDATE category_layout SET pinned = ? WHERE category_id = ?').run(
      patch.pinned ? 1 : 0,
      categoryId
    )
  if (patch.sortKey !== undefined)
    d.prepare('UPDATE category_layout SET sort_key = ? WHERE category_id = ?').run(
      patch.sortKey,
      categoryId
    )
  if (patch.collapsed !== undefined)
    d.prepare('UPDATE category_layout SET collapsed = ? WHERE category_id = ?').run(
      patch.collapsed ? 1 : 0,
      categoryId
    )
  if (patch.force !== undefined)
    d.prepare('UPDATE category_layout SET force = ? WHERE category_id = ?').run(patch.force, categoryId)
}

export function reorderPinnedCategories(orderedIds: string[]): void {
  const d = db()
  const upd = d.prepare('UPDATE category_layout SET sort_key = ? WHERE category_id = ?')
  const run = d.transaction((ids: string[]) => ids.forEach((id, i) => upd.run(i, id)))
  run(orderedIds)
}

// --- message index + search (XR-3) ------------------------------------

const F = MSG_FLAG
const IMG_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i
const VID_RE = /\.(mp4|mov|webm|mkv|avi|m4v)$/i

interface IndexMeta {
  guildId: string | null
  channelId: string
  mentionsMe: boolean
  mine: boolean
  everyone?: boolean
  replyToMe?: boolean
}

function messageFlags(row: MessageRow, meta: IndexMeta): number {
  let f = 0
  if (meta.mentionsMe) f |= F.mention
  if (meta.mine) f |= F.mine
  if (meta.everyone) f |= F.everyone
  if (meta.replyToMe) f |= F.replyToMe
  if (/https?:\/\/\S+/i.test(row.content)) f |= F.link
  if (/(^|[^`])`[^`]|```/.test(row.content)) f |= F.code
  if (row.editedTimestamp) f |= F.edited
  if (row.embedCount > 0) f |= F.embed
  for (const a of row.attachments) {
    if (IMG_RE.test(a.name)) f |= F.image
    else if (VID_RE.test(a.name)) f |= F.video
    else f |= F.file
  }
  return f
}

export function indexMessage(row: MessageRow, meta: IndexMeta): void {
  if (row.system || !row.id) return
  const d = db()
  const flags = messageFlags(row, meta)
  const run = d.transaction(() => {
    d.prepare(
      `INSERT INTO messages (id, channel_id, guild_id, author_id, author_name, created_at, edited_at, flags, data)
       VALUES (@id, @channel_id, @guild_id, @author_id, @author_name, @created_at, @edited_at, @flags, @data)
       ON CONFLICT(id) DO UPDATE SET
         author_name = excluded.author_name, created_at = excluded.created_at,
         edited_at = excluded.edited_at, flags = excluded.flags, data = excluded.data`
    ).run({
      id: row.id,
      channel_id: meta.channelId,
      guild_id: meta.guildId,
      author_id: row.authorId,
      author_name: row.authorName,
      created_at: row.timestamp,
      edited_at: row.editedTimestamp,
      flags,
      data: JSON.stringify(row)
    })
    d.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(row.id)
    d.prepare(
      'INSERT INTO messages_fts (content, author_name, message_id) VALUES (?, ?, ?)'
    ).run(row.content, row.authorName, row.id)
  })
  run()
}

export function deleteIndexedMessage(id: string): void {
  const d = db()
  d.prepare('DELETE FROM messages WHERE id = ?').run(id)
  d.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(id)
}

export function indexedMessageCount(): number {
  return (db().prepare('SELECT count(*) c FROM messages').get() as { c: number }).c
}

export interface SearchHit {
  id: string
  channelId: string
  guildId: string | null
  row: MessageRow
  resolved: boolean
  starred: boolean
  snoozeUntil: number | null
}

export function searchMessages(q: ParsedQuery, opts: SearchOpts = {}): SearchHit[] {
  const d = db()
  const { where, params } = buildSearchSql(q, opts)
  params.limit = opts.limit ?? 100
  params.offset = opts.offset ?? 0

  const rows = d
    .prepare(
      `SELECT m.id, m.channel_id, m.guild_id, m.data,
              COALESCE(t.resolved, 0) AS resolved,
              COALESCE(t.starred, 0)  AS starred,
              t.snooze_until          AS snooze_until
         FROM messages m
         LEFT JOIN message_triage t ON t.message_id = m.id
        WHERE ${where}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT @limit OFFSET @offset`
    )
    .all(params) as {
    id: string
    channel_id: string
    guild_id: string | null
    data: string
    resolved: number
    starred: number
    snooze_until: number | null
  }[]

  return rows.map((r) => ({
    id: r.id,
    channelId: r.channel_id,
    guildId: r.guild_id,
    row: JSON.parse(r.data) as MessageRow,
    resolved: !!r.resolved,
    starred: !!r.starred,
    snoozeUntil: r.snooze_until
  }))
}

export function setTriage(
  messageId: string,
  patch: { resolved?: boolean; starred?: boolean; snoozeUntil?: number | null }
): void {
  const d = db()
  d.prepare(
    `INSERT INTO message_triage (message_id, resolved, starred, snooze_until, updated_at)
     VALUES (@id, 0, 0, NULL, @now)
     ON CONFLICT(message_id) DO NOTHING`
  ).run({ id: messageId, now: Date.now() })
  if (patch.resolved !== undefined)
    d.prepare('UPDATE message_triage SET resolved = ?, updated_at = ? WHERE message_id = ?').run(
      patch.resolved ? 1 : 0,
      Date.now(),
      messageId
    )
  if (patch.starred !== undefined)
    d.prepare('UPDATE message_triage SET starred = ?, updated_at = ? WHERE message_id = ?').run(
      patch.starred ? 1 : 0,
      Date.now(),
      messageId
    )
  if (patch.snoozeUntil !== undefined)
    d.prepare('UPDATE message_triage SET snooze_until = ?, updated_at = ? WHERE message_id = ?').run(
      patch.snoozeUntil,
      Date.now(),
      messageId
    )
}

/** Wipe every table — used on sign-out so the local cache really is cleared. */
export function clearModel(): void {
  const d = db()
  const tables = [
    'guilds',
    'threads',
    'dm_channels',
    'users',
    'presences',
    'read_states',
    'muted',
    'messages',
    'messages_fts',
    'message_triage',
    'meta'
  ]
  const run = d.transaction(() => {
    for (const t of tables) d.prepare(`DELETE FROM ${t}`).run()
  })
  run()
}

export function setMeta(key: string, value: string): void {
  db()
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
    .run(key, value, value)
}

export function getMeta(key: string): string | null {
  const row = db().prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function closeDb(): void {
  handle?.close()
  handle = null
}
