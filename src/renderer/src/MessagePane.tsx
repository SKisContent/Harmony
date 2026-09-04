import { type ReactElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MessageRow, ThreadSummary, UploadedAttachment } from '@shared/types'
import type { Selection } from './App'
import { type MdContext, renderContent } from './markdown'
import { type EmojiRef, applyReactionDelta, cdnEmoji } from './reactions'

const IMG = /\.(png|jpe?g|gif|webp|avif)$/i
const PAGE = 50
const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '😢', '🔥', '✅']

function timeLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return sameDay ? `Today ${t}` : `${d.toLocaleDateString()} ${t}`
}

function loadDraft(channelId: string): string {
  try {
    return localStorage.getItem(`draft:${channelId}`) ?? ''
  } catch {
    return ''
  }
}
function saveDraft(channelId: string, value: string): void {
  try {
    if (value) localStorage.setItem(`draft:${channelId}`, value)
    else localStorage.removeItem(`draft:${channelId}`)
  } catch {
    /* ignore */
  }
}

/** Keep a complete update wholesale; merge a partial one onto what we have. */
function applyUpdate(prev: MessageRow[], patch: MessageRow): MessageRow[] {
  const complete = !!patch.timestamp && !!patch.authorId
  return prev.map((m) => {
    if (m.id !== patch.id) return m
    if (complete)
      return { ...patch, reactions: m.reactions, editedTimestamp: patch.editedTimestamp ?? m.editedTimestamp }
    return {
      ...m,
      content: patch.content || m.content,
      editedTimestamp: patch.editedTimestamp ?? m.editedTimestamp,
      attachments: patch.attachments.length ? patch.attachments : m.attachments,
      embedCount: patch.embedCount || m.embedCount
    }
  })
}

interface PendingFile {
  name: string
  type: string
  bytes: Uint8Array
  previewUrl?: string
}

export function MessagePane({
  selection,
  channelNames,
  pinnedThreadIds,
  selfId,
  onOpen
}: {
  selection: Selection | null
  channelNames: Map<string, string>
  pinnedThreadIds: Set<string>
  selfId: string
  onOpen: (sel: Selection) => void
}): ReactElement {
  const [messages, setMessages] = useState<MessageRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [draft, setDraftState] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [threadsOpen, setThreadsOpen] = useState(false)
  const [replyTo, setReplyTo] = useState<MessageRow | null>(null)
  const [pingReply, setPingReply] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [quickFor, setQuickFor] = useState<string | null>(null)
  const [whoFor, setWhoFor] = useState<{
    msgId: string
    key: string
    users: { id: string; name: string }[] | 'loading'
  } | null>(null)
  const [typers, setTypers] = useState<Map<string, { name: string; expiry: number }>>(new Map())
  const [pending, setPending] = useState<PendingFile[]>([])
  const [dragOver, setDragOver] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const atBottomRef = useRef(true)
  const prependRef = useRef<number | null>(null)
  const lastTypedRef = useRef(0)
  const whoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const channelId = selection?.channelId ?? ''
  const own = (m: MessageRow): boolean => !!selfId && m.authorId === selfId

  const setDraft = (v: string): void => {
    setDraftState(v)
    if (channelId) saveDraft(channelId, v)
  }

  const isNearBottom = (): boolean => {
    const el = scrollRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  useEffect(() => {
    if (!selection) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setMessages([])
    setHasMore(false)
    atBottomRef.current = true
    prependRef.current = null
    window.harmony
      .getMessages(selection.channelId)
      .then((res) => {
        if (cancelled) return
        if (res.ok && res.messages) {
          setMessages(res.messages)
          setHasMore(res.messages.length >= PAGE)
          const last = res.messages[res.messages.length - 1]
          if (last) void window.harmony.ackChannel(selection.channelId, last.id)
        } else setError(res.error ?? 'Failed to load messages.')
      })
      .finally(() => !cancelled && setLoading(false))
    setDraftState(loadDraft(selection.channelId))
    setSendError(null)
    setThreads([])
    setThreadsOpen(false)
    setReplyTo(null)
    setEditingId(null)
    setConfirmDelete(null)
    setQuickFor(null)
    setTypers(new Map())
    setPending([])

    if (!selection.isThread && !selection.isDm) {
      window.harmony.getThreads(selection.channelId).then((res) => {
        if (!cancelled && res.ok && res.threads) setThreads(res.threads)
      })
    }
    return () => {
      cancelled = true
    }
  }, [selection?.channelId, selection?.isThread, selection?.isDm])

  // live create / update / delete / reaction for the open channel
  useEffect(() => {
    if (!selection) return
    const ch = selection.channelId
    return window.harmony.onMessage((evt) => {
      if (evt.channelId !== ch) return
      if (evt.kind === 'create') {
        const nearBottom = isNearBottom()
        atBottomRef.current = nearBottom
        setMessages((prev) =>
          prev.some((m) => m.id === evt.message.id) ? prev : [...prev, evt.message]
        )
        if (nearBottom) void window.harmony.ackChannel(ch, evt.message.id)
      } else if (evt.kind === 'update') {
        setMessages((prev) => applyUpdate(prev, evt.message))
      } else if (evt.kind === 'delete') {
        setMessages((prev) => prev.filter((m) => m.id !== evt.id))
      } else {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === evt.messageId ? applyReactionDelta(m, evt.emoji, evt.delta, evt.me) : m
          )
        )
      }
    })
  }, [selection?.channelId])

  // typing indicator (incoming)
  useEffect(() => {
    if (!selection) return
    const ch = selection.channelId
    return window.harmony.onTyping((evt) => {
      if (evt.channelId !== ch || evt.userId === selfId) return
      setTypers((prev) => {
        const next = new Map(prev)
        next.set(evt.userId, { name: evt.userName, expiry: Date.now() + 9000 })
        return next
      })
    })
  }, [selection?.channelId, selfId])

  useEffect(() => {
    const iv = setInterval(() => {
      setTypers((prev) => {
        const now = Date.now()
        let changed = false
        const next = new Map(prev)
        for (const [k, v] of next) if (v.expiry < now) (next.delete(k), (changed = true))
        return changed ? next : prev
      })
    }, 2000)
    return () => clearInterval(iv)
  }, [])

  const loadOlder = async (): Promise<void> => {
    if (!selection || loadingMore || !hasMore || !messages.length) return
    setLoadingMore(true)
    prependRef.current = scrollRef.current?.scrollHeight ?? 0
    const res = await window.harmony.getMessages(selection.channelId, messages[0].id)
    setLoadingMore(false)
    if (!res.ok || !res.messages) {
      prependRef.current = null
      return
    }
    const batch = res.messages
    setMessages((prev) => {
      const known = new Set(prev.map((m) => m.id))
      const older = batch.filter((m) => !known.has(m.id))
      if (!older.length) return prev
      return [...older, ...prev]
    })
    if (batch.length < PAGE) setHasMore(false)
  }

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (el.scrollTop < 60) void loadOlder()
  }

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (prependRef.current != null) {
      el.scrollTop = el.scrollHeight - prependRef.current
      prependRef.current = null
    } else if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

  const startReply = (m: MessageRow): void => {
    setReplyTo(m)
    inputRef.current?.focus()
  }

  const addFiles = async (files: FileList | File[]): Promise<void> => {
    const next: PendingFile[] = []
    for (const f of Array.from(files)) {
      const bytes = new Uint8Array(await f.arrayBuffer())
      next.push({
        name: f.name || 'file',
        type: f.type,
        bytes,
        previewUrl: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined
      })
    }
    setPending((p) => [...p, ...next])
    inputRef.current?.focus()
  }

  const removePending = (i: number): void => {
    setPending((p) => {
      p[i]?.previewUrl && URL.revokeObjectURL(p[i].previewUrl!)
      return p.filter((_, idx) => idx !== i)
    })
  }

  const send = async (): Promise<void> => {
    if (!selection || sending) return
    const text = draft.trim()
    if (!text && pending.length === 0) return
    setSending(true)
    setSendError(null)
    try {
      let refs: UploadedAttachment[] = []
      for (const p of pending) {
        const up = await window.harmony.uploadAttachment(selection.channelId, {
          name: p.name,
          type: p.type,
          bytes: p.bytes
        })
        if (!up.ok || !up.ref) throw new Error(up.error ?? 'Attachment upload failed.')
        refs.push(up.ref)
      }
      refs = refs.map((r, i) => ({ ...r, id: String(i) }))
      const res = await window.harmony.sendMessage(selection.channelId, text, {
        ...(replyTo ? { replyToId: replyTo.id, pingReply } : {}),
        ...(refs.length ? { attachments: refs } : {})
      })
      if (res.ok && res.message) {
        atBottomRef.current = true
        setMessages((prev) =>
          prev.some((m) => m.id === res.message!.id) ? prev : [...prev, res.message!]
        )
        setDraft('')
        setReplyTo(null)
        pending.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl))
        setPending([])
      } else setSendError(res.error ?? 'Failed to send.')
    } catch (e) {
      setSendError((e as Error).message)
    } finally {
      setSending(false)
    }
  }

  const onComposerInput = (v: string): void => {
    setDraft(v)
    const now = Date.now()
    if (v && selection && now - lastTypedRef.current > 8000) {
      lastTypedRef.current = now
      void window.harmony.startTyping(selection.channelId)
    }
  }

  const saveEdit = async (): Promise<void> => {
    if (!selection || !editingId) return
    const text = editText.trim()
    if (!text) return
    const res = await window.harmony.editMessage(selection.channelId, editingId, text)
    if (res.ok && res.message) {
      const edited = res.message
      setMessages((prev) => prev.map((m) => (m.id === editingId ? { ...edited, reactions: m.reactions } : m)))
      setEditingId(null)
    } else setSendError(res.error ?? 'Edit failed.')
  }

  const doDelete = async (id: string): Promise<void> => {
    if (!selection) return
    const res = await window.harmony.deleteMessage(selection.channelId, id)
    if (res.ok) setMessages((prev) => prev.filter((m) => m.id !== id))
    else setSendError(res.error ?? 'Delete failed.')
    setConfirmDelete(null)
  }

  const toggleReaction = (m: MessageRow, emoji: EmojiRef, currentlyMe: boolean): void => {
    if (!selection) return
    setMessages((prev) =>
      prev.map((x) => (x.id === m.id ? applyReactionDelta(x, emoji, currentlyMe ? -1 : 1, true) : x))
    )
    void window.harmony.react(selection.channelId, m.id, emoji.key, !currentlyMe).then((res) => {
      if (!res.ok)
        setMessages((prev) =>
          prev.map((x) =>
            x.id === m.id ? applyReactionDelta(x, emoji, currentlyMe ? 1 : -1, true) : x
          )
        )
    })
  }

  const scheduleWho = (m: MessageRow, key: string): void => {
    if (whoTimer.current) clearTimeout(whoTimer.current)
    whoTimer.current = setTimeout(async () => {
      if (!selection) return
      setWhoFor({ msgId: m.id, key, users: 'loading' })
      const res = await window.harmony.reactionUsers(selection.channelId, m.id, key)
      setWhoFor({ msgId: m.id, key, users: res.ok && res.users ? res.users : [] })
    }, 400)
  }
  const cancelWho = (): void => {
    if (whoTimer.current) clearTimeout(whoTimer.current)
    setWhoFor(null)
  }

  const mdCtxFor = useMemo(() => {
    return (m: MessageRow): MdContext => ({
      mentions: new Map(m.mentions.map((u) => [u.id, u.name])),
      channels: channelNames
    })
  }, [channelNames])

  if (!selection) {
    return (
      <div className="pane-empty">
        <p>Pick a channel on the left to read it.</p>
      </div>
    )
  }

  const activeThreads = threads.filter((t) => !t.archived)
  const archivedThreads = threads.filter((t) => t.archived)
  const typerNames = [...typers.values()].map((v) => v.name)
  const typingLabel =
    typerNames.length === 0
      ? ''
      : typerNames.length === 1
        ? `${typerNames[0]} is typing…`
        : typerNames.length === 2
          ? `${typerNames[0]} and ${typerNames[1]} are typing…`
          : 'Several people are typing…'

  const renderThreadRow = (t: ThreadSummary): ReactElement => {
    const pinned = pinnedThreadIds.has(t.id)
    return (
      <div
        key={t.id}
        role="button"
        tabIndex={0}
        className={
          'ts-item' +
          (t.archived ? ' archived' : '') +
          (pinned ? ' pinned' : '') +
          (selection.channelId === t.id ? ' current' : '')
        }
        onClick={() =>
          onOpen({
            guildId: selection.guildId,
            guildName: selection.guildName,
            channelId: t.id,
            channelName: t.name,
            isThread: true
          })
        }
      >
        <span className="ts-name">〰️ {t.name}</span>
        <button
          className={'pin-btn' + (pinned ? ' on' : '')}
          title={pinned ? 'Unpin thread' : 'Pin thread'}
          onClick={(e) => {
            e.stopPropagation()
            void window.harmony.pinThread(t.id, !pinned)
          }}
        >
          📌
        </button>
        <span className="ts-count">{t.messageCount}</span>
      </div>
    )
  }

  return (
    <>
      <div className="content-header">
        <span className="crumb">{selection.guildName}</span>
        <span className="sep">›</span>
        {selection.isThread && <span className="sep">〰️</span>}
        <span className="chan-name">{selection.channelName}</span>
        {!selection.isThread && !selection.isDm && (
          <button
            className="ghost threads-toggle"
            onClick={() => setThreadsOpen((v) => !v)}
            title="Threads in this channel"
          >
            〰️ {threadsOpen ? 'Hide' : 'Threads'} ({threads.length})
          </button>
        )}
      </div>

      <div className="content-main">
        <div
          className={'messages-col' + (dragOver ? ' drag-over' : '')}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files)
          }}
        >
          <div className="messages" ref={scrollRef} onScroll={onScroll}>
            {loading && <div className="pane-note">Loading…</div>}
            {error && <div className="pane-note error">{error}</div>}
            {loadingMore && <div className="pane-note dim">Loading older…</div>}
            {!loading && !error && !hasMore && messages.length > PAGE && (
              <div className="pane-note dim">Beginning of the conversation.</div>
            )}
            {!loading && !error && messages.length === 0 && (
              <div className="pane-note">No messages here yet.</div>
            )}

            {messages.map((m, i) => {
              const prev = messages[i - 1]
              const grouped =
                prev &&
                prev.authorId === m.authorId &&
                !m.system &&
                !prev.system &&
                new Date(m.timestamp).getTime() - new Date(prev.timestamp).getTime() < 5 * 60_000

              if (m.system) {
                return (
                  <div className="msg system" key={m.id}>
                    <span className="sys-text">{m.content || '(system message)'}</span>
                    <span className="ts">{timeLabel(m.timestamp)}</span>
                  </div>
                )
              }

              return (
                <div
                  className={
                    'msg' + (grouped ? ' grouped' : '') + (replyTo?.id === m.id ? ' replying' : '')
                  }
                  key={m.id}
                >
                  <div className="msg-toolbar">
                    <button
                      title="Add reaction"
                      onClick={() => setQuickFor((v) => (v === m.id ? null : m.id))}
                    >
                      😀
                    </button>
                    <button title="Reply" onClick={() => startReply(m)}>
                      ↩
                    </button>
                    {own(m) && (
                      <button
                        title="Edit"
                        onClick={() => {
                          setEditingId(m.id)
                          setEditText(m.content)
                        }}
                      >
                        ✎
                      </button>
                    )}
                    {own(m) && (
                      <button title="Delete" onClick={() => setConfirmDelete(m.id)}>
                        🗑
                      </button>
                    )}
                  </div>

                  {!grouped && (
                    <div className="msg-meta">
                      <span className="author">{m.authorName}</span>
                      <span className="ts">{timeLabel(m.timestamp)}</span>
                    </div>
                  )}
                  {m.replyTo && <div className="reply-to">↳ replying to {m.replyTo}</div>}

                  {editingId === m.id ? (
                    <div className="msg-edit">
                      <textarea
                        value={editText}
                        autoFocus
                        onChange={(e) => setEditText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            void saveEdit()
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            setEditingId(null)
                          }
                        }}
                      />
                      <div className="msg-edit-hint">
                        escape to <button className="linky" onClick={() => setEditingId(null)}>cancel</button>{' '}
                        · enter to <button className="linky" onClick={() => void saveEdit()}>save</button>
                      </div>
                    </div>
                  ) : (
                    m.content && (
                      <div className="msg-body">
                        {renderContent(m.content, mdCtxFor(m))}
                        {m.editedTimestamp && (
                          <span className="edited-tag" title={timeLabel(m.editedTimestamp)}>
                            {' '}
                            (edited)
                          </span>
                        )}
                      </div>
                    )
                  )}

                  {m.attachments.map((a) => (
                    <div className="attach" key={a.url}>
                      {IMG.test(a.name) ? (
                        <img src={a.url} alt={a.name} />
                      ) : (
                        <a href={a.url} target="_blank" rel="noreferrer">
                          📎 {a.name}
                        </a>
                      )}
                    </div>
                  ))}
                  {m.embedCount > 0 && !m.content && (
                    <div className="msg-body dim">
                      [{m.embedCount} embed{m.embedCount > 1 ? 's' : ''}]
                    </div>
                  )}

                  {(m.reactions.length > 0 || quickFor === m.id) && (
                    <div className="reactions">
                      {m.reactions.map((r) => (
                        <button
                          key={r.key}
                          className={'react-pill' + (r.me ? ' me' : '')}
                          onClick={() =>
                            toggleReaction(
                              m,
                              { key: r.key, name: r.name, id: r.id, animated: r.animated },
                              r.me
                            )
                          }
                          onMouseEnter={() => scheduleWho(m, r.key)}
                          onMouseLeave={cancelWho}
                        >
                          {r.id ? (
                            <img className="react-emoji" src={cdnEmoji(r)} alt={r.name} />
                          ) : (
                            <span className="react-emoji">{r.name}</span>
                          )}
                          <span className="react-count">{r.count}</span>
                          {whoFor?.msgId === m.id && whoFor.key === r.key && (
                            <span className="react-who">
                              {whoFor.users === 'loading'
                                ? '…'
                                : whoFor.users.map((u) => u.name).join(', ') || 'no one'}
                            </span>
                          )}
                        </button>
                      ))}
                      {quickFor === m.id && (
                        <span className="quick-react">
                          {QUICK_REACTIONS.map((e) => (
                            <button
                              key={e}
                              onClick={() => {
                                toggleReaction(m, { key: e, name: e, id: null, animated: false }, false)
                                setQuickFor(null)
                              }}
                            >
                              {e}
                            </button>
                          ))}
                        </span>
                      )}
                    </div>
                  )}

                  {confirmDelete === m.id && (
                    <div className="msg-confirm">
                      Delete this message?
                      <button className="danger" onClick={() => void doDelete(m.id)}>
                        Delete
                      </button>
                      <button onClick={() => setConfirmDelete(null)}>Cancel</button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {typingLabel && <div className="typing-row">{typingLabel}</div>}

          <div className="composer">
            {sendError && <div className="composer-error">{sendError}</div>}
            {replyTo && (
              <div className="reply-bar">
                <span className="rb-text">
                  Replying to <b>{replyTo.authorName}</b>
                  {replyTo.content ? ` — ${replyTo.content.slice(0, 80)}` : ''}
                </span>
                <label className="rb-ping">
                  <input
                    type="checkbox"
                    checked={pingReply}
                    onChange={(e) => setPingReply(e.target.checked)}
                  />
                  Ping
                </label>
                <button className="rb-x" onClick={() => setReplyTo(null)} title="Cancel reply">
                  ✕
                </button>
              </div>
            )}
            {pending.length > 0 && (
              <div className="attach-tray">
                {pending.map((p, i) => (
                  <span className="attach-chip" key={i}>
                    {p.previewUrl ? (
                      <img src={p.previewUrl} alt={p.name} />
                    ) : (
                      <span className="attach-file">📎</span>
                    )}
                    <span className="attach-name">{p.name}</span>
                    <button onClick={() => removePending(i)} title="Remove">
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={inputRef}
              value={draft}
              placeholder={
                replyTo
                  ? `Reply to ${replyTo.authorName}`
                  : `Message ${selection.isDm || selection.isThread ? '' : '#'}${selection.channelName}`
              }
              rows={1}
              disabled={sending}
              onChange={(e) => onComposerInput(e.target.value)}
              onPaste={(e) => {
                const files = [...e.clipboardData.items]
                  .filter((it) => it.kind === 'file')
                  .map((it) => it.getAsFile())
                  .filter((f): f is File => !!f)
                if (files.length) {
                  e.preventDefault()
                  void addFiles(files)
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                } else if (e.key === 'Escape' && replyTo) {
                  e.preventDefault()
                  setReplyTo(null)
                }
              }}
            />
            <div className="composer-foot">
              <label className="attach-btn" title="Attach files">
                📎
                <input
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    if (e.target.files?.length) void addFiles(e.target.files)
                    e.target.value = ''
                  }}
                />
              </label>
              <span className={draft.length > 2000 ? 'over' : ''}>{draft.length}/2000</span>
              <button
                disabled={sending || (!draft.trim() && pending.length === 0) || draft.length > 2000}
                onClick={() => void send()}
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </div>

        {threadsOpen && !selection.isThread && (
          <aside className="threads-panel">
            <div className="tp-head">
              Threads
              <button className="ghost" onClick={() => setThreadsOpen(false)}>
                ✕
              </button>
            </div>
            <div className="tp-body">
              {threads.length === 0 && <div className="tp-empty">No threads in this channel.</div>}
              {activeThreads.length > 0 && (
                <div className="ts-label">Active — {activeThreads.length}</div>
              )}
              {activeThreads.map(renderThreadRow)}
              {archivedThreads.length > 0 && (
                <div className="ts-label">Archived — {archivedThreads.length}</div>
              )}
              {archivedThreads.map(renderThreadRow)}
            </div>
          </aside>
        )}
      </div>
    </>
  )
}
