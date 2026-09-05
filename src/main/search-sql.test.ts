import { describe, expect, it } from 'vitest'
import { parseQuery } from './search-query'
import { MSG_FLAG, buildSearchSql } from './search-sql'

const build = (query: string, opts = {}) => buildSearchSql(parseQuery(query), opts)

describe('buildSearchSql', () => {
  it('adds an FTS subquery only when there are text terms', () => {
    expect(build('hello').where).toContain('messages_fts MATCH @match')
    expect(build('hello').params.match).toBe('hello*')
    expect(build('from:@x').where).not.toContain('MATCH')
  })

  it('applies the mention filter for mentionsOnly and widens it with the toggles', () => {
    expect(build('', { mentionsOnly: true }).where).toContain(`(m.flags & ${MSG_FLAG.mention}) != 0`)
    const widened = build('', {
      mentionsOnly: true,
      includeEveryone: true,
      includeReplies: true
    }).where
    const bits = MSG_FLAG.mention | MSG_FLAG.everyone | MSG_FLAG.replyToMe
    expect(widened).toContain(`(m.flags & ${bits}) != 0`)
  })

  it('maps has: to the right flag bit', () => {
    expect(build('has:image').where).toContain(`(m.flags & ${MSG_FLAG.image}) != 0`)
    expect(build('has:link has:code').where).toContain(`(m.flags & ${MSG_FLAG.code}) != 0`)
  })

  it('turns from: into a LIKE and dates into range bounds', () => {
    const r = build('from:@Ann before:2026-02-01 after:2026-01-01')
    expect(r.where).toContain('m.author_name LIKE @from0')
    expect(r.params.from0).toBe('%Ann%')
    expect(r.params.before).toBe('2026-02-01T00:00:00')
    expect(r.params.after).toBe('2026-01-01T00:00:00')
  })

  it('scopes to a guild or to DMs', () => {
    expect(build('x', { guildId: 'g1' }).where).toContain('m.guild_id = @guildId')
    expect(build('x', { guildId: 'g1' }).params.guildId).toBe('g1')
    expect(build('x', { guildId: 'dm' }).where).toContain('m.guild_id IS NULL')
  })

  it('restricts / excludes channel id sets', () => {
    const inc = build('x', { channelIds: ['c1', 'c2'] })
    expect(inc.where).toContain('m.channel_id IN (@ch0, @ch1)')
    expect(inc.params).toMatchObject({ ch0: 'c1', ch1: 'c2' })

    expect(build('x', { channelIds: [] }).where).toContain('0=1')

    const exc = build('x', { excludeChannelIds: ['m1'] })
    expect(exc.where).toContain('m.channel_id NOT IN (@exch0)')
  })

  it('handles is:edited / is:resolved / is:starred', () => {
    const r = build('is:edited is:resolved is:starred')
    expect(r.where).toContain(`(m.flags & ${MSG_FLAG.edited}) != 0`)
    expect(r.where).toContain('t.resolved = 1')
    expect(r.where).toContain('t.starred = 1')
  })
})
