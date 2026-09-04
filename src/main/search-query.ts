// Parser for Harmony's one search box (docs/requirements.md XR-3 / Q17):
// tokenised full-text plus Discord-style operators. Pure — no electron/db.
//
//   bare words          AND-combined, prefix-matched
//   "exact phrase"      matched verbatim
//   -word / -"phrase"   excluded
//   OR                  binds the surrounding terms
//   from:@user  in:#channel  in:"Guild Name"  thread:name
//   has:link|image|file|video|embed|code
//   mentions:@user
//   before:YYYY-MM-DD  after:YYYY-MM-DD  during:YYYY-MM
//   is:unread|resolved|edited|mention|starred|snoozed

export interface ParsedQuery {
  /** FTS5 MATCH expression over the `content` column ('' when there is no text). */
  match: string
  from: string[]
  in: string[]
  thread: string[]
  mentions: string[]
  has: string[]
  is: string[]
  before: string | null
  after: string | null
}

const HAS = new Set(['link', 'image', 'file', 'video', 'embed', 'code'])
const IS = new Set(['unread', 'resolved', 'edited', 'mention', 'starred', 'snoozed'])
const OPERATORS = new Set(['from', 'in', 'thread', 'has', 'mentions', 'before', 'after', 'during', 'is'])

interface Token {
  /** operator key when the token was `key:value` / `key:"value"`, else null */
  key: string | null
  text: string
  quoted: boolean
  negate: boolean
}

/** Split on whitespace; honours "quotes", a leading '-', and `key:"quoted value"`. */
function tokenize(input: string): Token[] {
  const out: Token[] = []
  const re = /(-)?(?:([A-Za-z]+):)?(?:"([^"]*)"|(\S+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(input))) {
    if (!m[0]) {
      re.lastIndex++
      continue
    }
    const quoted = m[3] !== undefined
    out.push({
      key: m[2] ? m[2].toLowerCase() : null,
      text: quoted ? m[3] : m[4],
      quoted,
      negate: m[1] === '-'
    })
  }
  return out
}

function operatorOf(tok: Token): { key: string; value: string } | null {
  if (tok.key && OPERATORS.has(tok.key)) return { key: tok.key, value: tok.text }
  return null
}

/** Escape a bare word to a safe FTS5 term, prefix-matched. */
function ftsWord(w: string): string {
  const clean = w.replace(/["*]/g, '')
  if (!clean) return ''
  return /^[\p{L}\p{N}_]+$/u.test(clean) ? `${clean}*` : `"${clean}"`
}

function monthRange(ym: string): { after: string; before: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(ym)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  if (mo < 1 || mo > 12) return null
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`
  return { after: `${ym}-01`, before: `${next}-01` }
}

const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s)

export function parseQuery(input: string): ParsedQuery {
  const q: ParsedQuery = {
    match: '',
    from: [],
    in: [],
    thread: [],
    mentions: [],
    has: [],
    is: [],
    before: null,
    after: null
  }

  const ftsParts: string[] = []
  let pendingOr = false

  const pushTerm = (term: string): void => {
    if (!term) return
    if (pendingOr && ftsParts.length) {
      ftsParts[ftsParts.length - 1] += ` OR ${term}`
      pendingOr = false
    } else {
      ftsParts.push(term)
    }
  }

  for (const tok of tokenize(input)) {
    if (!tok.quoted && !tok.key && tok.text === 'OR' && ftsParts.length && !tok.negate) {
      pendingOr = true
      continue
    }

    const op = operatorOf(tok)
    if (op) {
      const val = op.value.replace(/^[@#]+/, '').trim()
      switch (op.key) {
        case 'from':
          if (val) q.from.push(val)
          break
        case 'mentions':
          if (val) q.mentions.push(val)
          break
        case 'in':
          if (val) q.in.push(val)
          break
        case 'thread':
          if (val) q.thread.push(val)
          break
        case 'has':
          if (HAS.has(val.toLowerCase())) q.has.push(val.toLowerCase())
          break
        case 'is':
          if (IS.has(val.toLowerCase())) q.is.push(val.toLowerCase())
          break
        case 'before':
          if (isDate(val)) q.before = val
          break
        case 'after':
          if (isDate(val)) q.after = val
          break
        case 'during': {
          const r = monthRange(val)
          if (r) {
            q.after = q.after && q.after > r.after ? q.after : r.after
            q.before = q.before && q.before < r.before ? q.before : r.before
          }
          break
        }
      }
      continue
    }

    // plain text term (a non-operator `key:` folds back into the literal)
    const raw = tok.key ? `${tok.key}:${tok.text}` : tok.text
    const term = tok.quoted ? `"${tok.text.replace(/"/g, '')}"` : ftsWord(raw)
    if (!term) continue
    pushTerm(tok.negate ? `NOT ${term}` : term)
  }

  // FTS5 rejects an expression that is only NOT clauses; keep positives only then.
  const positives = ftsParts.filter((p) => !p.startsWith('NOT '))
  q.match = positives.length ? ftsParts.join(' ') : ''
  return q
}
