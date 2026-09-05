import { describe, expect, it } from 'vitest'
import { parseQuery } from './search-query'

describe('parseQuery — text', () => {
  it('prefix-matches bare words, AND-combined', () => {
    expect(parseQuery('hello world').match).toBe('hello* world*')
  })

  it('keeps quoted phrases verbatim', () => {
    expect(parseQuery('"exact phrase" foo').match).toBe('"exact phrase" foo*')
  })

  it('negates with a leading dash', () => {
    expect(parseQuery('keep -drop').match).toBe('keep* NOT drop*')
  })

  it('joins terms around OR', () => {
    expect(parseQuery('cat OR dog').match).toBe('cat* OR dog*')
  })

  it('drops an all-negative match (FTS5 would reject it)', () => {
    expect(parseQuery('-nope').match).toBe('')
  })

  it('sanitises punctuation into a quoted term', () => {
    expect(parseQuery('c++').match).toBe('"c++"')
  })
})

describe('parseQuery — operators', () => {
  it('collects from: / in: / thread: / mentions:', () => {
    const q = parseQuery('from:@alice in:#general thread:"design chat" mentions:@bob')
    expect(q.from).toEqual(['alice'])
    expect(q.in).toEqual(['general'])
    expect(q.thread).toEqual(['design chat'])
    expect(q.mentions).toEqual(['bob'])
    expect(q.match).toBe('')
  })

  it('validates has: and is: values', () => {
    const q = parseQuery('has:image has:bogus is:unread is:nonsense is:resolved')
    expect(q.has).toEqual(['image'])
    expect(q.is).toEqual(['unread', 'resolved'])
  })

  it('parses before: / after: dates and ignores malformed ones', () => {
    const q = parseQuery('before:2026-01-15 after:not-a-date')
    expect(q.before).toBe('2026-01-15')
    expect(q.after).toBeNull()
  })

  it('expands during:YYYY-MM to a month window', () => {
    const q = parseQuery('during:2026-03')
    expect(q.after).toBe('2026-03-01')
    expect(q.before).toBe('2026-04-01')
  })

  it('rolls a December during: into the next year', () => {
    const q = parseQuery('during:2026-12')
    expect(q.after).toBe('2026-12-01')
    expect(q.before).toBe('2027-01-01')
  })

  it('mixes text and operators', () => {
    const q = parseQuery('deploy plan from:@ops has:link before:2026-02-01')
    expect(q.match).toBe('deploy* plan*')
    expect(q.from).toEqual(['ops'])
    expect(q.has).toEqual(['link'])
    expect(q.before).toBe('2026-02-01')
  })

  it('treats an unknown key: as a plain term', () => {
    expect(parseQuery('weird:thing').match).toBe('"weird:thing"')
  })
})
