// Pure SQL fragment builder for the message index (XR-3). No db/electron import
// so it can be unit-tested; db.ts runs the query.

import type { ParsedQuery } from './search-query'

export const MSG_FLAG = {
  mention: 1,
  mine: 2,
  link: 4,
  image: 8,
  file: 16,
  video: 32,
  embed: 64,
  code: 128,
  edited: 256,
  everyone: 512,
  replyToMe: 1024
}

const HAS_BIT: Record<string, number> = {
  link: MSG_FLAG.link,
  image: MSG_FLAG.image,
  file: MSG_FLAG.file,
  video: MSG_FLAG.video,
  embed: MSG_FLAG.embed,
  code: MSG_FLAG.code
}

export interface SearchOpts {
  /** restrict to these channel/thread ids (from `in:` / `thread:` / scope) */
  channelIds?: string[] | null
  /** restrict to one guild (null = any, 'dm' = DMs only) */
  guildId?: string | 'dm' | null
  excludeChannelIds?: string[]
  /** FR-4 default — only messages that mention me */
  mentionsOnly?: boolean
  /** widen mentionsOnly to also include @everyone/@here and replies to me */
  includeEveryone?: boolean
  includeReplies?: boolean
  /** FR-5 — only messages I authored */
  mineOnly?: boolean
  /** result ordering by timestamp; defaults to 'newest' */
  orderBy?: 'newest' | 'oldest'
  limit?: number
  offset?: number
}

/** Build the WHERE clause + bound params for a message-index query. */
export function buildSearchSql(
  q: ParsedQuery,
  opts: SearchOpts
): { where: string; params: Record<string, unknown> } {
  const where: string[] = ['1=1']
  const params: Record<string, unknown> = { now: Date.now() }

  if (q.match) {
    where.push('m.id IN (SELECT message_id FROM messages_fts WHERE messages_fts MATCH @match)')
    params.match = q.match
  }

  if (opts.mentionsOnly || q.is.includes('mention')) {
    let bits = MSG_FLAG.mention
    if (opts.includeEveryone) bits |= MSG_FLAG.everyone
    if (opts.includeReplies) bits |= MSG_FLAG.replyToMe
    where.push(`(m.flags & ${bits}) != 0`)
  }
  if (opts.mineOnly || q.is.includes('mine')) where.push(`(m.flags & ${MSG_FLAG.mine}) != 0`)
  if (q.is.includes('edited')) where.push(`(m.flags & ${MSG_FLAG.edited}) != 0`)
  if (q.is.includes('resolved')) where.push('t.resolved = 1')
  if (q.is.includes('starred')) where.push('t.starred = 1')
  if (q.is.includes('snoozed')) where.push('t.snooze_until > @now')

  for (const h of q.has) if (HAS_BIT[h]) where.push(`(m.flags & ${HAS_BIT[h]}) != 0`)

  q.from.forEach((name, i) => {
    where.push(`m.author_name LIKE @from${i}`)
    params[`from${i}`] = `%${name}%`
  })

  if (q.before) {
    where.push('m.created_at < @before')
    params.before = `${q.before}T00:00:00`
  }
  if (q.after) {
    where.push('m.created_at >= @after')
    params.after = `${q.after}T00:00:00`
  }

  if (opts.guildId === 'dm') where.push('m.guild_id IS NULL')
  else if (opts.guildId) {
    where.push('m.guild_id = @guildId')
    params.guildId = opts.guildId
  }

  const inClause = (name: string, negate: boolean, ids: string[]): void => {
    const keys = ids.map((id, i) => {
      params[`${name}${i}`] = id
      return `@${name}${i}`
    })
    where.push(`m.channel_id ${negate ? 'NOT IN' : 'IN'} (${keys.join(', ')})`)
  }
  if (opts.channelIds) {
    if (opts.channelIds.length === 0) where.push('0=1') // asked for a set, none matched
    else inClause('ch', false, opts.channelIds)
  }
  if (opts.excludeChannelIds && opts.excludeChannelIds.length)
    inClause('exch', true, opts.excludeChannelIds)

  return { where: where.join(' AND '), params }
}
