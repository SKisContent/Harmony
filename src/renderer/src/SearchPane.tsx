import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react'
import type { SearchResult, SearchScopeOpts } from '@shared/types'
import type { Selection } from './App'
import { type MdContext, renderContent } from './markdown'

function timeLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

export function SearchPane({
  mode,
  guilds,
  channelNames,
  selection,
  onOpen
}: {
  mode: 'search' | 'mentions'
  guilds: { id: string; name: string }[]
  channelNames: Map<string, string>
  selection: Selection | null
  onOpen: (sel: Selection) => void
}): ReactElement {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('all')
  const [excludeMuted, setExcludeMuted] = useState(true)
  const [includeEveryone, setIncludeEveryone] = useState(false)
  const [includeReplies, setIncludeReplies] = useState(false)
  const [showResolved, setShowResolved] = useState(false)
  const [results, setResults] = useState<SearchResult[]>([])
  const [indexed, setIndexed] = useState(0)
  const [loading, setLoading] = useState(false)
  const [backfill, setBackfill] = useState<{ running: boolean; label: string }>({
    running: false,
    label: ''
  })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const mentionsMode = mode === 'mentions'

  const run = useMemo(
    () => (q: string): void => {
      const opts: SearchScopeOpts = {
        scope,
        excludeMuted,
        mentionsOnly: mentionsMode,
        includeEveryone: mentionsMode && includeEveryone,
        includeReplies: mentionsMode && includeReplies,
        limit: 200,
        offset: 0
      }
      const full = mentionsMode && !showResolved ? `${q} -is:resolved`.trim() : q
      setLoading(true)
      window.harmony.search(full, opts).then((res) => {
        setLoading(false)
        if (res.ok) {
          setResults(res.results ?? [])
          setIndexed(res.indexed ?? 0)
        }
      })
    },
    [scope, excludeMuted, mentionsMode, includeEveryone, includeReplies, showResolved]
  )

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => run(query.trim()), 250)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [query, run])

  useEffect(() => {
    return window.harmony.onBackfill((p) => {
      setBackfill({
        running: !p.done,
        label: p.done
          ? `Indexed ${p.indexed.toLocaleString()} mentions.`
          : `Syncing… server ${p.guild}/${p.guilds}, ${p.indexed.toLocaleString()} found`
      })
      if (p.done) run(query.trim())
    })
  }, [run, query])

  const startBackfill = (): void => {
    setBackfill({ running: true, label: 'Starting…' })
    void window.harmony.backfillMentions().then((res) => {
      if (!res.ok) setBackfill({ running: false, label: res.error ?? 'Backfill failed.' })
    })
  }

  const jump = (r: SearchResult): void => {
    onOpen({
      guildId: r.guildId,
      guildName: r.guildName || (r.isDm ? 'Direct Messages' : ''),
      channelId: r.channelId,
      channelName: r.threadName ?? r.channelName,
      isThread: !!r.threadName,
      isDm: r.isDm
    })
  }

  const triage = (r: SearchResult, patch: { resolved?: boolean; starred?: boolean }): void => {
    void window.harmony.setMessageTriage(r.id, patch)
    setResults((prev) =>
      prev
        .map((x) => (x.id === r.id ? { ...x, ...patch } : x))
        .filter((x) => showResolved || !mentionsMode || !x.resolved)
    )
  }

  const mdCtx = (r: SearchResult): MdContext => ({
    mentions: new Map(r.mentions.map((u) => [u.id, u.name])),
    channels: channelNames
  })

  return (
    <div className="search-pane">
      <div className="search-head">
        <input
          className="search-box"
          value={query}
          autoFocus
          placeholder={
            mentionsMode
              ? 'Filter your mentions —  from:@name  in:#channel  has:link  before:2026-01-01'
              : 'Search —  words, "a phrase", from:@name in:#channel has:image before:2026-01-01'
          }
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="search-filters">
          <label>
            Scope
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="all">Everywhere</option>
              <option value="dm">Direct messages</option>
              {guilds.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={excludeMuted}
              onChange={(e) => setExcludeMuted(e.target.checked)}
            />
            Exclude muted
          </label>
          {mentionsMode && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={includeEveryone}
                  onChange={(e) => setIncludeEveryone(e.target.checked)}
                />
                @everyone / @here
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={includeReplies}
                  onChange={(e) => setIncludeReplies(e.target.checked)}
                />
                Replies to me
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={showResolved}
                  onChange={(e) => setShowResolved(e.target.checked)}
                />
                Show resolved
              </label>
              <button
                className="ghost sync-btn"
                disabled={backfill.running}
                onClick={startBackfill}
              >
                {backfill.running ? 'Syncing…' : 'Sync mentions'}
              </button>
            </>
          )}
        </div>
        {backfill.label && <div className="search-backfill">{backfill.label}</div>}
      </div>

      <div className="search-results">
        {loading && results.length === 0 && <div className="pane-note">Searching…</div>}
        {!loading && results.length === 0 && (
          <div className="pane-note dim">
            {mentionsMode ? 'No mentions match.' : 'No matches.'}{' '}
            {indexed === 0
              ? 'The index is empty — open a few channels to fill it' +
                (mentionsMode ? ', or run a mentions backfill.' : '.')
              : `${indexed.toLocaleString()} messages indexed.`}
          </div>
        )}
        {results.map((r) => (
          <div
            key={r.id}
            className={
              'search-row' +
              (r.unread ? ' is-unread' : '') +
              (selection?.channelId === r.channelId ? ' is-active' : '')
            }
            onClick={() => jump(r)}
          >
            <div className="sr-crumb">
              {r.isDm ? 'DM' : r.guildName} › {r.channelName}
              {r.threadName ? ` › 〰️ ${r.threadName}` : ''}
            </div>
            <div className="sr-meta">
              <span className="sr-author">{r.authorName}</span>
              <span className="sr-time">{timeLabel(r.timestamp)}</span>
              {r.starred && <span className="sr-flag">★</span>}
              {r.resolved && <span className="sr-flag">✓ resolved</span>}
            </div>
            {r.content && <div className="sr-body">{renderContent(r.content, mdCtx(r))}</div>}
            {!r.content && r.attachments.length > 0 && (
              <div className="sr-body dim">📎 {r.attachments.map((a) => a.name).join(', ')}</div>
            )}
            <div className="sr-actions">
              <button
                title="Jump to message"
                onClick={(e) => {
                  e.stopPropagation()
                  jump(r)
                }}
              >
                ↪ jump
              </button>
              <button
                className={r.starred ? 'on' : ''}
                title={r.starred ? 'Unstar' : 'Star'}
                onClick={(e) => {
                  e.stopPropagation()
                  triage(r, { starred: !r.starred })
                }}
              >
                ★
              </button>
              {mentionsMode && (
                <button
                  className={r.resolved ? 'on' : ''}
                  title={r.resolved ? 'Unresolve' : 'Mark resolved'}
                  onClick={(e) => {
                    e.stopPropagation()
                    triage(r, { resolved: !r.resolved })
                  }}
                >
                  ✓
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
