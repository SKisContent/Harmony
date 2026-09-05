import { describe, expect, it } from 'vitest'
import { activeToken, applySuggestion, rankByName } from './composer-suggest'

describe('activeToken', () => {
  it('finds an @ mention token at the caret', () => {
    const t = activeToken('hello @ali', 10)
    expect(t).toEqual({ kind: '@', query: 'ali', start: 6, end: 10 })
  })

  it('finds a # channel token at the caret', () => {
    const t = activeToken('see #gen', 8)
    expect(t).toEqual({ kind: '#', query: 'gen', start: 4, end: 8 })
  })

  it('finds a : emoji token once it has at least one character', () => {
    const t = activeToken('nice :fir', 9)
    expect(t).toEqual({ kind: ':', query: 'fir', start: 5, end: 9 })
  })

  it('does not trigger on a bare colon (emoticons like :) )', () => {
    expect(activeToken('lol :', 5)).toBeNull()
    expect(activeToken('lol :)', 6)).toBeNull()
  })

  it('triggers at the very start of the string', () => {
    const t = activeToken('@bob', 4)
    expect(t).toEqual({ kind: '@', query: 'bob', start: 0, end: 4 })
  })

  it('requires whitespace (or start) immediately before the trigger', () => {
    expect(activeToken('foo@bar', 7)).toBeNull()
  })

  it('returns null when the caret is not inside a token', () => {
    expect(activeToken('hello world', 11)).toBeNull()
    expect(activeToken('@bob said hi', 12)).toBeNull()
  })

  it('returns null when the caret sits before the trigger token', () => {
    expect(activeToken('@bob', 0)).toBeNull()
  })
})

describe('applySuggestion', () => {
  it('replaces the token with the inserted text plus a trailing space', () => {
    const token = { kind: '@' as const, query: 'ali', start: 6, end: 10 }
    const { value, caret } = applySuggestion('hello @ali', token, '<@123>')
    expect(value).toBe('hello <@123> ')
    expect(caret).toBe(6 + '<@123>'.length + 1)
  })
})

describe('rankByName', () => {
  const items = [{ name: 'realm' }, { name: 'alice' }, { name: 'general' }, { name: 'ale' }]

  it('ranks names starting with the query before names merely containing it', () => {
    const ranked = rankByName(items, 'al')
    expect(ranked.map((i) => i.name)).toEqual(['alice', 'ale', 'realm', 'general'])
  })

  it('returns the first `limit` items unfiltered when the query is empty', () => {
    expect(rankByName(items, '', 2)).toEqual([items[0], items[1]])
  })

  it('is case-insensitive', () => {
    expect(rankByName(items, 'ALI').map((i) => i.name)).toEqual(['alice'])
  })

  it('caps results at `limit`', () => {
    expect(rankByName(items, 'e', 1)).toHaveLength(1)
  })
})
