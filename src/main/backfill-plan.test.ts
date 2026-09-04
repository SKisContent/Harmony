import { describe, expect, it } from 'vitest'
import { nextSweep } from './backfill-plan'

describe('nextSweep', () => {
  it('stops on an empty page', () => {
    expect(nextSweep({ offset: 0, maxId: null }, { count: 0, oldestId: null })).toBe('done')
  })

  it('stops on a short page (ran out)', () => {
    expect(nextSweep({ offset: 50, maxId: null }, { count: 12, oldestId: 'x' })).toBe('done')
  })

  it('advances the offset while pages stay full', () => {
    expect(nextSweep({ offset: 50, maxId: null }, { count: 25, oldestId: 'a' })).toEqual({
      offset: 75,
      maxId: null
    })
  })

  it('windows back with max_id when the offset ceiling is reached', () => {
    expect(nextSweep({ offset: 9975, maxId: null }, { count: 25, oldestId: 'oldest1' })).toEqual({
      offset: 0,
      maxId: 'oldest1'
    })
  })

  it('stops if windowing back would not move the boundary', () => {
    expect(nextSweep({ offset: 9975, maxId: 'same' }, { count: 25, oldestId: 'same' })).toBe('done')
  })
})
