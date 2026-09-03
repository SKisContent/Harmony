import { useEffect, useMemo, useState } from 'react'
import type { CategoryGroup, MessageRow, UnifiedState } from '@shared/types'
import { MessagePane } from './MessagePane'
import { LogoAvatar } from './LogoAvatar'

const STATUS_LABEL: Record<string, string> = {
  idle: 'Starting…',
  'no-token': 'Not signed in',
  connecting: 'Connecting…',
  identifying: 'Signing in…',
  ready: 'Connected',
  reconnecting: 'Reconnecting…',
  closed: 'Disconnected',
  error: 'Error'
}

type CatSort = 'alpha' | 'recent'

/** Sidebar glyphs. category = :heavy_equals_sign:, channel = :heavy_minus_sign:, thread = :wavy_dash: */
const ICON = {
  category: '\u{1F7F0}', // 🟰
  channel: '\u{2796}', //  ➖
  thread: '\u{3030}\u{FE0F}' // 〰️
} as const

export interface Selection {
  guildId: string
  guildName: string
  channelId: string
  channelName: string
  isThread?: boolean
  isDm?: boolean
}

function usePersistedState<T extends string | boolean>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw != null) return JSON.parse(raw) as T
    } catch {
      /* ignore */
    }
    return initial
  })
  const set = (v: T) => {
    setValue(v)
    try {
      localStorage.setItem(key, JSON.stringify(v))
    } catch {
      /* ignore */
    }
  }
  return [value, set]
}

function sortCategories(cats: CategoryGroup[], mode: CatSort): CategoryGroup[] {
  const uncategorised = cats.filter((c) => c.id === null)
  const named = cats.filter((c) => c.id !== null)
  named.sort((a, b) => {
    if (mode === 'recent') {
      const av = BigInt(a.recentActivity || '0')
      const bv = BigInt(b.recentActivity || '0')
      return av > bv ? -1 : av < bv ? 1 : 0
    }
    return (a.name ?? '').localeCompare(b.name ?? '')
  })
  return [...uncategorised, ...named]
}

export function App(): JSX.Element {
  const [state, setState] = useState<UnifiedState | null>(null)
  const [busy, setBusy] = useState(false)
  const [scope, setScope] = usePersistedState<string>('scope', 'all')
  const [unreadOnly, setUnreadOnly] = usePersistedState<boolean>('unreadOnly', false)
  const [hideMuted, setHideMuted] = usePersistedState<boolean>('hideMuted', true)
  const [catSort, setCatSort] = usePersistedState<CatSort>('catSort', 'alpha')
  const [mode, setMode] = usePersistedState<'servers' | 'dms'>('mode', 'servers')
  const [selection, setSelection] = useState<Selection | null>(null)

  useEffect(() => {
    window.harmony.getState().then(setState)
    return window.harmony.onState(setState)
  }, [])

  const login = async () => {
    setBusy(true)
    const res = await window.harmony.login()
    setBusy(false)
    if (!res.ok && res.error) alert(res.error)
  }

  const pasteToken = async () => {
    const token = window.prompt(
      'Paste your Discord account token.\n\n' +
        'Get it from the Discord web app: DevTools → Network → any /api/v9 request → ' +
        'Request Headers → authorization.'
    )
    if (!token) return
    const res = await window.harmony.setToken(token)
    if (!res.ok && res.error) alert(res.error)
  }

  const guilds = useMemo(() => {
    if (!state) return []
    let gs = state.guilds
    if (scope !== 'all') gs = gs.filter((g) => g.id === scope)
    return gs
      .map((g) => {
        const categories = sortCategories(g.categories, catSort)
          .map((cat) => ({
            ...cat,
            channels: cat.channels.filter((c) => {
              if (unreadOnly && !c.unread && c.mentionCount === 0) return false
              if (hideMuted && c.muted) return false
              return true
            })
          }))
          .filter((cat) => cat.channels.length > 0)
        return { ...g, categories }
      })
      .filter((g) => g.categories.length > 0)
  }, [state, scope, unreadOnly, hideMuted, catSort])

  const connected = state?.status === 'ready' || (state?.guilds.length ?? 0) > 0

  return (
    <div className="app">
      <header className="topbar">
        <span className="title">Harmony</span>
        <span className="status">
          {STATUS_LABEL[state?.status ?? 'idle'] ?? state?.status}
          {state?.detail ? ` · ${state.detail}` : ''}
          {state?.self ? ` · ${state.self.globalName ?? state.self.username}` : ''}
        </span>
        <span className="spacer" />
        {state && connected && (
          <span className="counts">
            {state.counts.guilds} servers · {state.counts.channels} channels ·{' '}
            {state.counts.unread} unread · {state.counts.mentions} mentions
          </span>
        )}
        {connected ? (
          <button className="ghost" onClick={() => window.harmony.logout()}>
            Sign out
          </button>
        ) : (
          <button onClick={login} disabled={busy}>
            {busy ? 'Waiting for Discord…' : 'Sign in to Discord'}
          </button>
        )}
      </header>

      {connected && state && ['error', 'reconnecting', 'closed'].includes(state.status) && (
        <div className="banner">
          <span>
            {state.status === 'error' ? 'Connection problem' : 'Reconnecting…'}
            {state.detail ? ` — ${state.detail}` : ''}. Showing the last synced list.
          </span>
          <button onClick={() => window.harmony.reconnect()}>Retry</button>
          <button className="ghost" onClick={login}>
            Sign in again
          </button>
        </div>
      )}

      {!connected ? (
        <div className="list">
          <div className="empty">
            <h2>See every channel, in one place</h2>
            <p>
              Sign in with your Discord account. Harmony opens Discord's real login page, captures the
              session, and connects to the gateway — then this list fills with every channel you can
              read, across every server, with real unread and mention badges.
            </p>
            <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              Password not working? Use the <b>QR code</b> in the login window (scan with the Discord
              mobile app) — no password or CAPTCHA.
            </p>
            <button onClick={login} disabled={busy}>
              {busy ? 'Waiting for Discord…' : 'Sign in to Discord'}
            </button>
            <div style={{ marginTop: 14 }}>
              <button className="ghost" onClick={pasteToken}>
                Paste a token instead
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="body">
          <aside className="sidebar">
            <div className="mode-switch">
              <button
                className={mode === 'servers' ? 'seg on' : 'seg'}
                onClick={() => setMode('servers')}
              >
                Servers
              </button>
              <button className={mode === 'dms' ? 'seg on' : 'seg'} onClick={() => setMode('dms')}>
                Direct Messages
                {state && state.dms.some((d) => d.unread) ? <span className="seg-dot" /> : null}
              </button>
            </div>

            <div className="controls">
              {mode === 'servers' && (
                <>
                  <label>
                    Server
                    <select value={scope} onChange={(e) => setScope(e.target.value)}>
                      <option value="all">All servers</option>
                      {state?.guilds.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Categories
                    <select value={catSort} onChange={(e) => setCatSort(e.target.value as CatSort)}>
                      <option value="alpha">Alphabetical</option>
                      <option value="recent">Most recent message</option>
                    </select>
                  </label>
                </>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={unreadOnly}
                  onChange={(e) => setUnreadOnly(e.target.checked)}
                />
                Unread only
              </label>
              {mode === 'servers' && (
                <label>
                  <input
                    type="checkbox"
                    checked={hideMuted}
                    onChange={(e) => setHideMuted(e.target.checked)}
                  />
                  Hide muted
                </label>
              )}
            </div>

            {mode === 'dms' && (
              <div className="list">
                {(state?.dms ?? [])
                  .filter((d) => (unreadOnly ? d.unread || d.mentionCount > 0 : true))
                  .map((d) => (
                    <div key={d.id}>
                      <div
                        className={
                          'dm' +
                          (d.unread ? ' is-unread' : '') +
                          (d.muted ? ' is-muted' : '') +
                          (selection?.channelId === d.id ? ' is-active' : '')
                        }
                        onClick={() =>
                          setSelection({
                            guildId: '',
                            guildName: 'Direct Messages',
                            channelId: d.id,
                            channelName: d.name,
                            isDm: true
                          })
                        }
                      >
                        <span className="dm-av-wrap">
                          {d.iconUrl ? (
                            <img className="dm-avatar" src={d.iconUrl} alt="" />
                          ) : (
                            <LogoAvatar seed={d.id} />
                          )}
                          <span className={'presence ' + d.status} />
                        </span>
                        <span className="name">{d.name}</span>
                        {d.mentionCount > 0 ? (
                          <span className="badge">{d.mentionCount}</span>
                        ) : d.unread ? (
                          <span className="dot" />
                        ) : null}
                      </div>

                      {d.type === 3 &&
                        d.members.map((m) => (
                          <div className="dm-member" key={m.id}>
                            <span className="dm-av-wrap sm">
                              {m.avatarUrl ? (
                                <img className="dm-avatar" src={m.avatarUrl} alt="" />
                              ) : (
                                <LogoAvatar seed={m.id} />
                              )}
                              <span className={'presence ' + m.status} />
                            </span>
                            <span className="name">{m.name}</span>
                          </div>
                        ))}
                    </div>
                  ))}
                {(state?.dms ?? []).length === 0 && (
                  <div className="empty small">No direct messages.</div>
                )}
              </div>
            )}

            {mode === 'servers' && (
            <div className="list">
              {guilds.length === 0 && <div className="empty small">Nothing matches the filters.</div>}
              {guilds.map((g) => {
                let gUnread = 0
                let gMentions = 0
                for (const cat of g.categories)
                  for (const c of cat.channels) {
                    if (c.unread) gUnread++
                    gMentions += c.mentionCount
                  }
                return (
                  <section className="guild" key={g.id}>
                    <div className="guild-head">
                      {g.iconUrl && <img src={g.iconUrl} alt="" />}
                      <span className="g-name">{g.name}</span>
                      <span className="g-counts">
                        {gUnread ? `${gUnread}` : ''}
                        {gMentions ? ` · ${gMentions}✳` : ''}
                      </span>
                    </div>

                    {g.categories.map((cat) => (
                      <div className="cat" key={cat.id ?? '__none__'}>
                        {cat.name && (
                          <div className="cat-head">
                            <span className="icon">{ICON.category}</span>
                            {cat.name}
                          </div>
                        )}
                        {cat.channels.map((c) => (
                          <div key={c.id}>
                            <div
                              className={
                                'chan' +
                                (c.unread ? ' is-unread' : '') +
                                (c.muted ? ' is-muted' : '') +
                                (selection?.channelId === c.id ? ' is-active' : '')
                              }
                              onClick={() =>
                                setSelection({
                                  guildId: g.id,
                                  guildName: g.name,
                                  channelId: c.id,
                                  channelName: c.name
                                })
                              }
                            >
                              <span className="icon">{ICON.channel}</span>
                              <span className="name">{c.name}</span>
                              {c.mentionCount > 0 ? (
                                <span className="badge">{c.mentionCount}</span>
                              ) : c.unread ? (
                                <span className="dot" />
                              ) : null}
                            </div>
                            {c.threads.map((t) => (
                              <div
                                key={t.id}
                                className={
                                  'thread' +
                                  (t.unread ? ' is-unread' : '') +
                                  (selection?.channelId === t.id ? ' is-active' : '')
                                }
                                onClick={() =>
                                  setSelection({
                                    guildId: g.id,
                                    guildName: g.name,
                                    channelId: t.id,
                                    channelName: t.name,
                                    isThread: true
                                  })
                                }
                              >
                                <span className="icon">{ICON.thread}</span>
                                <span className="name">{t.name}</span>
                                {t.mentionCount > 0 ? (
                                  <span className="badge">{t.mentionCount}</span>
                                ) : t.unread ? (
                                  <span className="dot" />
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    ))}
                  </section>
                )
              })}
            </div>
            )}
          </aside>

          <main className="content">
            <MessagePane selection={selection} onOpen={setSelection} />
          </main>
        </div>
      )}
    </div>
  )
}

export type { MessageRow }
