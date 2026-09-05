// Pure helpers for the composer's `@` / `#` / `:` autocomplete (XR-4). No React.

export interface ActiveToken {
  kind: '@' | '#' | ':'
  /** text after the trigger char, up to the caret */
  query: string
  /** index of the trigger char in the source string */
  start: number
  /** caret index (end of the token) */
  end: number
}

const TOKEN_RE = /(^|\s)([@#:])([\p{L}\p{N}_-]*)$/u

/** The trigger token immediately left of the caret, if the caret is inside one. */
export function activeToken(text: string, caret: number): ActiveToken | null {
  const before = text.slice(0, caret)
  const m = TOKEN_RE.exec(before)
  if (!m) return null
  // a `:` token needs at least one character so ":)" etc. don't pop the picker
  if (m[2] === ':' && m[3].length === 0) return null
  const start = m.index + m[1].length
  return { kind: m[2] as ActiveToken['kind'], query: m[3], start, end: caret }
}

/** Replace the active token with `insert` (+ a trailing space) and return the new value + caret. */
export function applySuggestion(
  text: string,
  token: ActiveToken,
  insert: string
): { value: string; caret: number } {
  const value = text.slice(0, token.start) + insert + ' ' + text.slice(token.end)
  return { value, caret: token.start + insert.length + 1 }
}

/** Case-insensitive "starts-with beats contains" ranking over a name list. */
export function rankByName<T extends { name: string }>(items: T[], query: string, limit = 8): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return items.slice(0, limit)
  const starts: T[] = []
  const contains: T[] = []
  for (const it of items) {
    const n = it.name.toLowerCase()
    if (n.startsWith(q)) starts.push(it)
    else if (n.includes(q)) contains.push(it)
  }
  return [...starts, ...contains].slice(0, limit)
}
