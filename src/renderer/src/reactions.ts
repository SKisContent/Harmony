import type { MessageRow, ReactionRow } from '@shared/types'

export interface EmojiRef {
  key: string
  name: string
  id: string | null
  animated: boolean
}

export function cdnEmoji(r: { id: string | null; animated: boolean }): string {
  return `https://cdn.discordapp.com/emojis/${r.id}.${r.animated ? 'gif' : 'png'}?size=44`
}

/**
 * Apply a +1/-1 reaction change to a message row. `mine` is true when the change
 * is the current user's own toggle (so `me` on the pill flips too).
 */
export function applyReactionDelta(
  row: MessageRow,
  emoji: EmojiRef,
  delta: 1 | -1,
  mine: boolean
): MessageRow {
  const reactions: ReactionRow[] = []
  let found = false
  for (const r of row.reactions) {
    if (r.key !== emoji.key) {
      reactions.push(r)
      continue
    }
    found = true
    const count = Math.max(0, r.count + delta)
    if (count === 0) continue
    reactions.push({ ...r, count, me: mine ? delta === 1 : r.me })
  }
  if (!found && delta === 1) {
    reactions.push({
      key: emoji.key,
      name: emoji.name,
      id: emoji.id,
      animated: emoji.animated,
      count: 1,
      me: mine
    })
  }
  return { ...row, reactions }
}
