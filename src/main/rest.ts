// Minimal authenticated REST client for Discord's private API.
// Mirrors the web client's headers (docs/requirements.md §11.1 / NFR-5).

import type { MessageRow } from '@shared/types'

const BASE = 'https://discord.com/api/v9'

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'

const SUPER_PROPERTIES = {
  os: 'Mac OS X',
  browser: 'Chrome',
  device: '',
  system_locale: 'en-US',
  browser_user_agent: CHROME_UA,
  browser_version: '152.0.0.0',
  os_version: '10.15.7',
  referrer: '',
  referring_domain: '',
  referrer_current: '',
  referring_domain_current: '',
  release_channel: 'stable',
  client_build_number: 605958,
  client_event_source: null
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: token,
    'X-Super-Properties': Buffer.from(JSON.stringify(SUPER_PROPERTIES)).toString('base64'),
    'X-Discord-Locale': 'en-US',
    'X-Discord-Timezone': 'America/Los_Angeles',
    'User-Agent': CHROME_UA,
    'Content-Type': 'application/json'
  }
}

export async function apiGet<T = unknown>(path: string, token: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: headers(token) })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText} — ${body.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

export async function apiPost<T = unknown>(path: string, token: string, payload: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(payload)
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    if (res.status === 429) {
      let wait = ''
      try {
        wait = ` Retry after ${JSON.parse(body).retry_after}s.`
      } catch {
        /* ignore */
      }
      throw new Error(`Rate limited by Discord.${wait}`)
    }
    throw new Error(`${res.status} ${res.statusText} — ${body.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

export interface RawMessage {
  id: string
  content?: string
  timestamp?: string
  edited_timestamp?: string | null
  channel_id?: string
  author?: { id: string; username?: string; global_name?: string | null }
  member?: { nick?: string | null }
  mentions?: { id: string; username?: string; global_name?: string | null }[]
  attachments?: { filename: string; url: string; size: number }[]
  embeds?: unknown[]
  type?: number
  referenced_message?: { author?: { global_name?: string | null; username?: string } } | null
}

/** Normalise a raw Discord message (REST or gateway) into the renderer shape. */
export function toRow(m: RawMessage): MessageRow {
  return {
    id: m.id,
    authorId: m.author?.id ?? '',
    authorName: m.member?.nick || m.author?.global_name || m.author?.username || 'unknown',
    content: m.content ?? '',
    timestamp: m.timestamp ?? '',
    editedTimestamp: m.edited_timestamp ?? null,
    attachments: (m.attachments ?? []).map((a) => ({ name: a.filename, url: a.url })),
    embedCount: (m.embeds ?? []).length,
    replyTo:
      m.referenced_message?.author?.global_name ?? m.referenced_message?.author?.username ?? null,
    // 0 default, 19 reply — anything else is a system message. type may be absent
    // on partial MESSAGE_UPDATE payloads, which are not system messages.
    system: m.type != null && m.type !== 0 && m.type !== 19,
    mentions: (m.mentions ?? []).map((u) => ({
      id: u.id,
      name: u.global_name || u.username || 'user'
    }))
  }
}

export async function getMessages(
  channelId: string,
  token: string,
  limit = 50,
  before?: string
): Promise<MessageRow[]> {
  const q = new URLSearchParams({ limit: String(limit) })
  if (before) q.set('before', before)
  const raw = await apiGet<RawMessage[]>(`/channels/${channelId}/messages?${q}`, token)
  return raw.map(toRow).reverse() // API returns newest-first; show oldest-first
}

export interface SendOptions {
  replyToId?: string
  pingReply?: boolean
}

export async function sendMessage(
  channelId: string,
  content: string,
  token: string,
  opts: SendOptions = {}
): Promise<MessageRow> {
  const payload: Record<string, unknown> = {
    content,
    tts: false,
    nonce: String(Date.now())
  }
  if (opts.replyToId) {
    payload.message_reference = { channel_id: channelId, message_id: opts.replyToId }
    payload.allowed_mentions = { parse: ['users', 'roles', 'everyone'], replied_user: opts.pingReply !== false }
  }
  const created = await apiPost<RawMessage>(`/channels/${channelId}/messages`, token, payload)
  return toRow(created)
}

interface RawThread {
  id: string
  name?: string
  message_count?: number
  thread_metadata?: { archived?: boolean }
}

export interface ThreadSummary {
  id: string
  name: string
  archived: boolean
  messageCount: number
}

/** All threads in a channel — active AND archived (docs/requirements.md FR-2). */
export async function getThreads(channelId: string, token: string): Promise<ThreadSummary[]> {
  const q = 'sort_by=last_message_time&sort_order=desc&limit=25&offset=0'
  const fetchSet = (archived: boolean) =>
    apiGet<{ threads: RawThread[] }>(
      `/channels/${channelId}/threads/search?archived=${archived}&${q}`,
      token
    ).catch(() => ({ threads: [] as RawThread[] }))

  const [active, archived] = await Promise.all([fetchSet(false), fetchSet(true)])
  const seen = new Set<string>()
  const out: ThreadSummary[] = []
  for (const t of [...active.threads, ...archived.threads]) {
    if (seen.has(t.id)) continue
    seen.add(t.id)
    out.push({
      id: t.id,
      name: t.name ?? 'thread',
      archived: !!t.thread_metadata?.archived,
      messageCount: t.message_count ?? 0
    })
  }
  return out
}
