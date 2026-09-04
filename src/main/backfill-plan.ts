// Pure paging logic for the FR-4 mentions backfill.
//
// Discord's `/guilds/{id}/messages/search` caps `offset` at 9975 (25/page).
// To reach older matches we page to the ceiling, then re-query with
// `max_id` set to the oldest hit of the sweep and start `offset` again.

export interface SweepState {
  offset: number
  maxId: string | null
}

export interface PageInfo {
  /** hits returned by the last request */
  count: number
  /** id of the oldest hit in the last request, if any */
  oldestId: string | null
}

const PAGE = 25
const OFFSET_CEILING = 9975

/** Decide the next request for a guild sweep, or `'done'`. */
export function nextSweep(state: SweepState, page: PageInfo): SweepState | 'done' {
  if (page.count === 0) return 'done'

  const nextOffset = state.offset + PAGE
  if (nextOffset > OFFSET_CEILING) {
    // window back — but stop if the boundary didn't move (no older results)
    if (!page.oldestId || page.oldestId === state.maxId) return 'done'
    return { offset: 0, maxId: page.oldestId }
  }
  if (page.count < PAGE) return 'done'
  return { offset: nextOffset, maxId: state.maxId }
}
