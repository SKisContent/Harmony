import { type ReactElement, useEffect, useMemo, useState } from 'react'
import type { CategoryGroup, MessageRow, UnifiedState } from '@shared/types'
import { MessagePane } from './MessagePane'
import { SearchPane } from './SearchPane'
import { SavedPane } from './SavedPane'
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
  const byMode = (a: CategoryGroup, b: CategoryGroup): number => {
    if (mode === 'recent') {
      const av = BigInt(a.recentActivity || '0')
      const bv = BigInt(b.recentActivity || '0')
      return av > bv ? -1 : av < bv ? 1 : 0
    }
    return (a.name ?? '').localeCompare(b.name ?? '')
  }
  // FR-7: pinned categories float to the top, in their user-defined order.
  const pinned = named.filter((c) => c.pinned).sort((a, b) => a.pinSortKey - b.pinSortKey)
  const rest = named.filter((c) => !c.pinned).sort(byMode)
  return [...uncategorised, ...pinned, ...rest]
}

/** localStorage-backed set of ids (used for per-guild "reveal hidden"). */
function usePersistedSet(key: string): [Set<string>, (id: string) => void] {
  const [set, setSet] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw) return new Set(JSON.parse(raw) as string[])
    } catch {
      /* ignore */
    }
    return new Set()
  })
  const toggle = (id: string): void => {
    setSet((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem(key, JSON.stringify([...next]))
      } catch {
        /* ignore */
      }
      return next
    })
  }
  return [set, toggle]
}

export function App(): ReactElement {
  const [state, setState] = useState<UnifiedState | null>(null)
  const [busy, setBusy] = useState(false)
  const [scope, setScope] = usePersistedState<string>('scope', 'all')
  const [unreadOnly, setUnreadOnly] = usePersistedState<boolean>('unreadOnly', false)
  const [hideMuted, setHideMuted] = usePersistedState<boolean>('hideMuted', true)
  const [catSort, setCatSort] = usePersistedState<CatSort>('catSort', 'alpha')
  const [mode, setMode] = usePersistedState<
    'servers' | 'dms' | 'pinned' | 'mentions' | 'mine' | 'saved' | 'search'
  >('mode', 'servers')
  const [selection, setSelection] = useState<Selection | null>(null)
  const [revealed, toggleRevealed] = usePersistedSet('revealedGuilds')

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
    const filterActive = unreadOnly || hideMuted
    return gs
      .map((g) => {
        const isRevealed = revealed.has(g.id)
        const cats = sortCategories(g.categories, catSort).map((cat) => {
          const channels = cat.channels.filter((c) => {
            if (unreadOnly && !c.unread && c.mentionCount === 0) return false
            if (hideMuted && c.muted) return false
            return true
          })
          const emptyAfterFilter = channels.length === 0
          // FR-6: hidden by the empty-category rule (store-computed, respects
          // pin / force). Revealing the guild shows them anyway.
          const ruleHidden = cat.hidden && !isRevealed
          // filter-emptied categories just drop out; they come back with the filter.
          const filterHidden =
            filterActive && emptyAfterFilter && !cat.pinned && !cat.hidden
          const uncategorisedEmpty = cat.id === null && emptyAfterFilter
          return {
            ...cat,
            channels,
            hide: ruleHidden || filterHidden || uncategorisedEmpty
          }
        })
        const hiddenCount = cats.filter((c) => c.id !== null && c.hidden && !c.pinned).length
        const anyShown = cats.some((c) => !c.hide)
        return { ...g, cats, hiddenCount, isRevealed, anyShown }
      })
      .filter((g) => g.anyShown || g.hiddenCount > 0)
  }, [state, scope, unreadOnly, hideMuted, catSort, revealed])

  // id -> name for every channel and joined thread, so <#id> mentions resolve
  const channelNames = useMemo(() => {
    const m = new Map<string, string>()
    for (const g of state?.guilds ?? [])
      for (const cat of g.categories)
        for (const c of cat.channels) {
          m.set(c.id, c.name)
          for (const t of c.threads) m.set(t.id, t.name)
        }
    for (const d of state?.dms ?? []) m.set(d.id, d.name)
    return m
  }, [state])

  const connected = state?.status === 'ready' || (state?.guilds.length ?? 0) > 0
  const pinnedThreadIds = useMemo(
    () => new Set((state?.local.pinnedThreads ?? []).map((p) => p.id)),
    [state]
  )
  const savedIds = useMemo(
    () => new Set((state?.local.bookmarks ?? []).map((b) => b.id)),
    [state]
  )

  const setLayout = (
    categoryId: string,
    guildId: string,
    patch: { pinned?: boolean; collapsed?: boolean; force?: 'show' | 'hide' | null }
  ): void => void window.harmony.setCategoryLayout(categoryId, guildId, patch)

  const moveCategory = (pinnedIds: string[], catId: string, dir: -1 | 1): void => {
    const i = pinnedIds.indexOf(catId)
    const j = i + dir
    if (i < 0 || j < 0 || j >= pinnedIds.length) return
    const next = [...pinnedIds]
    ;[next[i], next[j]] = [next[j], next[i]]
    void window.harmony.reorderPinnedCategories(next)
  }

  const movePinnedThread = (id: string, dir: -1 | 1): void => {
    const ids = (state?.local.pinnedThreads ?? []).map((p) => p.id)
    const i = ids.indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    void window.harmony.reorderPinnedThreads(ids)
  }

  const movePinnedChannel = (id: string, dir: -1 | 1): void => {
    const ids = (state?.local.pinnedChannels ?? []).map((p) => p.id)
    const i = ids.indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    void window.harmony.reorderPinnedChannels(ids)
  }

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
            <h2>Harmony. It's not Discord.</h2>
            <p>Less clutter, more intuitive</p>
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
                DMs
                {state && state.dms.some((d) => d.unread) ? <span className="seg-dot" /> : null}
              </button>
              <button
                className={mode === 'pinned' ? 'seg on' : 'seg'}
                onClick={() => setMode('pinned')}
              >
                Pinned
                {state &&
                [...state.local.pinnedThreads, ...state.local.pinnedChannels].some(
                  (p) => p.unread
                ) ? (
                  <span className="seg-dot" />
                ) : null}
              </button>
              <button
                className={mode === 'mentions' ? 'seg on' : 'seg'}
                onClick={() => setMode('mentions')}
              >
                Mentions
                {state && state.counts.mentions > 0 ? <span className="seg-dot" /> : null}
              </button>
              <button
                className={mode === 'mine' ? 'seg on' : 'seg'}
                onClick={() => setMode('mine')}
              >
                My Messages
              </button>
              <button
                className={mode === 'saved' ? 'seg on' : 'seg'}
                onClick={() => setMode('saved')}
              >
                Saved
                {state && state.local.bookmarks.some((b) => b.editedSince || b.deletedUpstream) ? (
                  <span className="seg-dot" />
                ) : null}
              </button>
              <button
                className={mode === 'search' ? 'seg on' : 'seg'}
                onClick={() => setMode('search')}
              >
                Search
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
                  <label>
                    <input
                      type="checkbox"
                      checked={state?.local.hideEmptyCategories ?? true}
                      onChange={(e) =>
                        void window.harmony.setPref(
                          'hideEmptyCategories',
                          e.target.checked ? '1' : '0'
                        )
                      }
                    />
                    Hide empty categories
                  </label>
                  {(state?.local.hideEmptyCategories ?? true) && (
                    <label>
                      Empty means
                      <select
                        value={state?.local.emptyMode ?? 'no-visible'}
                        onChange={(e) => void window.harmony.setPref('emptyMode', e.target.value)}
                      >
                        <option value="no-visible">No viewable channels</option>
                        <option value="no-unread">Nothing unread</option>
                      </select>
                    </label>
                  )}
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
                        <button
                          className={'mute-btn' + (d.muted ? ' on' : '')}
                          title={d.muted ? 'Unmute conversation' : 'Mute conversation'}
                          onClick={(e) => {
                            e.stopPropagation()
                            void window.harmony.setMuted({ channelId: d.id }, !d.muted)
                          }}
                        >
                          {d.muted ? '🔕' : '🔔'}
                        </button>
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
                for (const cat of g.cats)
                  for (const c of cat.channels) {
                    if (c.unread) gUnread++
                    gMentions += c.mentionCount
                  }
                const pinnedIds = g.cats.filter((c) => c.pinned && c.id).map((c) => c.id as string)
                return (
                  <section className="guild" key={g.id}>
                    <div className={'guild-head' + (g.muted ? ' is-muted' : '')}>
                      {g.iconUrl && <img src={g.iconUrl} alt="" />}
                      <span className="g-name">{g.name}</span>
                      <button
                        className={'mute-btn' + (g.muted ? ' on' : '')}
                        title={g.muted ? 'Unmute server' : 'Mute server'}
                        onClick={() =>
                          void window.harmony.setMuted({ guildId: g.id }, !g.muted)
                        }
                      >
                        {g.muted ? '🔕' : '🔔'}
                      </button>
                      <span className="g-counts">
                        {gUnread ? `${gUnread}` : ''}
                        {gMentions ? ` · ${gMentions}✳` : ''}
                      </span>
                    </div>

                    {g.cats.map((cat) => {
                      if (cat.hide && !g.isRevealed) return null
                      const key = cat.id ?? '__none__'
                      const pinIdx = cat.id ? pinnedIds.indexOf(cat.id) : -1
                      return (
                        <div
                          className={'cat' + (cat.hide ? ' is-dimmed' : '')}
                          key={key}
                        >
                          {cat.name && cat.id && (
                            <div
                              className={'cat-head' + (cat.pinned ? ' is-pinned' : '')}
                              tabIndex={0}
                              onClick={() =>
                                setLayout(cat.id!, g.id, { collapsed: !cat.collapsed })
                              }
                              onKeyDown={(e) => {
                                if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                                  e.preventDefault()
                                  if (cat.pinned)
                                    moveCategory(pinnedIds, cat.id!, e.key === 'ArrowUp' ? -1 : 1)
                                } else if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault()
                                  setLayout(cat.id!, g.id, { collapsed: !cat.collapsed })
                                }
                              }}
                            >
                              <span className="chev">{cat.collapsed ? '▸' : '▾'}</span>
                              <span className="icon">{ICON.category}</span>
                              <span className="cat-name">{cat.name}</span>
                              <span className="cat-actions">
                                {cat.pinned && (
                                  <>
                                    <button
                                      title="Move up (Alt+↑)"
                                      disabled={pinIdx <= 0}
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        moveCategory(pinnedIds, cat.id!, -1)
                                      }}
                                    >
                                      ↑
                                    </button>
                                    <button
                                      title="Move down (Alt+↓)"
                                      disabled={pinIdx < 0 || pinIdx >= pinnedIds.length - 1}
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        moveCategory(pinnedIds, cat.id!, 1)
                                      }}
                                    >
                                      ↓
                                    </button>
                                  </>
                                )}
                                <button
                                  className={cat.pinned ? 'on' : ''}
                                  title={cat.pinned ? 'Unpin category' : 'Pin category to top'}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setLayout(cat.id!, g.id, { pinned: !cat.pinned })
                                  }}
                                >
                                  📌
                                </button>
                              </span>
                            </div>
                          )}
                          {!cat.collapsed &&
                            cat.channels.map((c) => (
                              <div key={c.id}>
                                <div
                                  className={
                                    'chan' +
                                    (c.pinned ? ' is-pinned' : '') +
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
                                  <button
                                    className={'pin-btn' + (c.pinned ? ' on' : '')}
                                    title={c.pinned ? 'Unpin channel' : 'Pin channel'}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      void window.harmony.pinChannel(c.id, g.id, !c.pinned)
                                    }}
                                  >
                                    📌
                                  </button>
                                  <button
                                    className={'mute-btn' + (c.muted ? ' on' : '')}
                                    title={c.muted ? 'Unmute channel' : 'Mute channel'}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      void window.harmony.setMuted(
                                        { guildId: g.id, channelId: c.id },
                                        !c.muted
                                      )
                                    }}
                                  >
                                    {c.muted ? '🔕' : '🔔'}
                                  </button>
                                  <select
                                    className="notify-sel"
                                    title="Notification level"
                                    value={c.notifyLevel}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => {
                                      e.stopPropagation()
                                      void window.harmony.setChannelNotifyLevel(
                                        { guildId: g.id, channelId: c.id },
                                        Number(e.target.value) as 0 | 1 | 2 | 3
                                      )
                                    }}
                                  >
                                    <option value={3}>Default</option>
                                    <option value={0}>All</option>
                                    <option value={1}>Mentions</option>
                                    <option value={2}>Nothing</option>
                                  </select>
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
                                      (t.pinned ? ' is-pinned' : '') +
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
                                    <button
                                      className={'pin-btn' + (t.pinned ? ' on' : '')}
                                      title={t.pinned ? 'Unpin thread' : 'Pin thread'}
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        void window.harmony.pinThread(t.id, !t.pinned)
                                      }}
                                    >
                                      📌
                                    </button>
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
                      )
                    })}

                    {g.hiddenCount > 0 && (
                      <button className="cat-hidden-toggle" onClick={() => toggleRevealed(g.id)}>
                        {g.isRevealed
                          ? 'Hide empty categories'
                          : `⨯ ${g.hiddenCount} hidden ${
                              g.hiddenCount === 1 ? 'category' : 'categories'
                            }`}
                      </button>
                    )}
                  </section>
                )
              })}
            </div>
            )}

            {mode === 'pinned' && (
              <div className="list">
                {(state?.local.pinnedChannels ?? []).length === 0 &&
                  (state?.local.pinnedThreads ?? []).length === 0 && (
                    <div className="empty small">
                      Nothing pinned. Hover a channel or thread in the sidebar and hit 📌.
                    </div>
                  )}

                {(state?.local.pinnedChannels ?? []).length > 0 && (
                  <div className="ts-label">Channels</div>
                )}
                {(state?.local.pinnedChannels ?? []).map((p, i, arr) => (
                  <div
                    key={p.id}
                    className={
                      'pin-row' +
                      (p.missing ? ' is-missing' : '') +
                      (p.unread ? ' is-unread' : '') +
                      (selection?.channelId === p.id ? ' is-active' : '')
                    }
                    onClick={() =>
                      !p.missing &&
                      setSelection({
                        guildId: p.guildId,
                        guildName: p.guildName,
                        channelId: p.id,
                        channelName: p.name
                      })
                    }
                  >
                    <span className="icon">{ICON.channel}</span>
                    <div className="pin-body">
                      <div className="pin-title">
                        {p.name}
                        {p.missing && <span className="pin-tag warn">removed from Discord</span>}
                      </div>
                      {!p.missing && (
                        <div className="pin-crumb">
                          {p.guildName}
                          {p.categoryName ? ` › ${p.categoryName}` : ''}
                        </div>
                      )}
                    </div>
                    {p.mentionCount > 0 ? (
                      <span className="badge">{p.mentionCount}</span>
                    ) : p.unread ? (
                      <span className="dot" />
                    ) : null}
                    <span className="pin-actions">
                      <button
                        title="Move up"
                        disabled={i === 0}
                        onClick={(e) => {
                          e.stopPropagation()
                          movePinnedChannel(p.id, -1)
                        }}
                      >
                        ↑
                      </button>
                      <button
                        title="Move down"
                        disabled={i === arr.length - 1}
                        onClick={(e) => {
                          e.stopPropagation()
                          movePinnedChannel(p.id, 1)
                        }}
                      >
                        ↓
                      </button>
                      <button
                        title="Unpin"
                        onClick={(e) => {
                          e.stopPropagation()
                          void window.harmony.pinChannel(p.id, p.guildId, false)
                        }}
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                ))}

                {(state?.local.pinnedThreads ?? []).length > 0 && (
                  <div className="ts-label">Threads</div>
                )}
                {(state?.local.pinnedThreads ?? []).map((p, i, arr) => (
                  <div
                    key={p.id}
                    className={
                      'pin-row' +
                      (p.missing ? ' is-missing' : '') +
                      (p.unread ? ' is-unread' : '') +
                      (selection?.channelId === p.id ? ' is-active' : '')
                    }
                    onClick={() =>
                      !p.missing &&
                      setSelection({
                        guildId: p.guildId,
                        guildName: p.guildName,
                        channelId: p.id,
                        channelName: p.name,
                        isThread: true
                      })
                    }
                  >
                    <span className="icon">{ICON.thread}</span>
                    <div className="pin-body">
                      <div className="pin-title">
                        {p.label && <span className="pin-label">{p.label}</span>}
                        {p.name}
                        {p.archived && <span className="pin-tag">archived</span>}
                        {p.missing && <span className="pin-tag warn">removed from Discord</span>}
                      </div>
                      {!p.missing && (
                        <div className="pin-crumb">
                          {p.guildName} › {p.parentName || 'channel'}
                        </div>
                      )}
                      {p.note && <div className="pin-note">{p.note}</div>}
                    </div>
                    {p.mentionCount > 0 ? (
                      <span className="badge">{p.mentionCount}</span>
                    ) : p.unread ? (
                      <span className="dot" />
                    ) : null}
                    <span className="pin-actions">
                      <button
                        title="Move up"
                        disabled={i === 0}
                        onClick={(e) => {
                          e.stopPropagation()
                          movePinnedThread(p.id, -1)
                        }}
                      >
                        ↑
                      </button>
                      <button
                        title="Move down"
                        disabled={i === arr.length - 1}
                        onClick={(e) => {
                          e.stopPropagation()
                          movePinnedThread(p.id, 1)
                        }}
                      >
                        ↓
                      </button>
                      <button
                        title="Unpin"
                        onClick={(e) => {
                          e.stopPropagation()
                          void window.harmony.pinThread(p.id, false)
                        }}
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </aside>

          <main className="content">
            {mode === 'search' || mode === 'mentions' || mode === 'mine' ? (
              <SearchPane
                mode={mode}
                guilds={(state?.guilds ?? []).map((g) => ({ id: g.id, name: g.name }))}
                channelNames={channelNames}
                selection={selection}
                onOpen={(sel) => {
                  setSelection(sel)
                  setMode('servers')
                }}
              />
            ) : mode === 'saved' ? (
              <SavedPane
                bookmarks={state?.local.bookmarks ?? []}
                channelNames={channelNames}
                selection={selection}
                onOpen={(sel) => {
                  setSelection(sel)
                  setMode('servers')
                }}
              />
            ) : (
              <MessagePane
                selection={selection}
                channelNames={channelNames}
                pinnedThreadIds={pinnedThreadIds}
                savedIds={savedIds}
                selfId={state?.self?.id ?? ''}
                onOpen={setSelection}
              />
            )}
          </main>
        </div>
      )}
    </div>
  )
}

export type { MessageRow }
