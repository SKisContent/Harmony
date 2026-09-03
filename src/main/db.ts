// The local SQLite store. Replaces the encrypted JSON snapshot: same idea (a
// durable local mirror so the UI paints before the gateway reconnects), but
// queryable and ready for the message index that FR-4 / FR-5 need.
//
// The DB is plaintext on disk (like Discord's own cache). The account token
// stays in the OS keychain via secure-file — that's the secret that matters.

import { join } from 'node:path'
import { app } from 'electron'
import Database from 'better-sqlite3'

const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- guild blob keeps its embedded channels[] for now; a normalised channels
-- table lands with the FR nav work when the store stops being guild-centric.
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

-- message cache + full-text index. Defined now so there's no migration later;
-- populated by FR-4/FR-5 (mentions / my-messages) and cache-on-open.
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  guild_id   TEXT,
  author_id  TEXT,
  created_at TEXT,
  edited_at  TEXT,
  flags      INTEGER NOT NULL DEFAULT 0,   -- bit0 mentions-me, bit1 authored-by-me
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_author  ON messages(author_id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  author_name,
  message_id UNINDEXED,
  channel_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
`

let handle: Database.Database | null = null

export function db(): Database.Database {
  if (handle) return handle
  const d = new Database(join(app.getPath('userData'), 'harmony.db'))
  d.pragma('journal_mode = WAL')
  d.pragma('synchronous = NORMAL')
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
