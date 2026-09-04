import { describe, expect, it } from 'vitest'
import type { MessageRow } from '@shared/types'
import { applyReactionDelta } from './reactions'

const base = (reactions: MessageRow['reactions'] = []): MessageRow => ({
  id: 'm',
  authorId: 'u',
  authorName: 'U',
  content: 'hi',
  timestamp: '',
  editedTimestamp: null,
  attachments: [],
  embedCount: 0,
  replyTo: null,
  system: false,
  mentions: [],
  reactions
})

const thumb = { key: '👍', name: '👍', id: null, animated: false }

describe('applyReactionDelta', () => {
  it('adds a new reaction with count 1', () => {
    const out = applyReactionDelta(base(), thumb, 1, true)
    expect(out.reactions).toEqual([{ key: '👍', name: '👍', id: null, animated: false, count: 1, me: true }])
  })

  it('increments an existing reaction and does not flip me for others', () => {
    const start = base([{ key: '👍', name: '👍', id: null, animated: false, count: 2, me: false }])
    const out = applyReactionDelta(start, thumb, 1, false)
    expect(out.reactions[0]).toMatchObject({ count: 3, me: false })
  })

  it('sets me=true when the current user adds their own', () => {
    const start = base([{ key: '👍', name: '👍', id: null, animated: false, count: 1, me: false }])
    const out = applyReactionDelta(start, thumb, 1, true)
    expect(out.reactions[0]).toMatchObject({ count: 2, me: true })
  })

  it('removes the reaction entirely when the count hits zero', () => {
    const start = base([{ key: '👍', name: '👍', id: null, animated: false, count: 1, me: true }])
    const out = applyReactionDelta(start, thumb, -1, true)
    expect(out.reactions).toEqual([])
  })

  it('clears my flag on a -1 that leaves others', () => {
    const start = base([{ key: '👍', name: '👍', id: null, animated: false, count: 3, me: true }])
    const out = applyReactionDelta(start, thumb, -1, true)
    expect(out.reactions[0]).toMatchObject({ count: 2, me: false })
  })

  it('ignores a -1 for an emoji that is not present', () => {
    const out = applyReactionDelta(base(), thumb, -1, true)
    expect(out.reactions).toEqual([])
  })
})
