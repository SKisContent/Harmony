import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MessageRow, ThreadSummary } from '@shared/types'
import type { Selection } from './App'
import { type MdContext, renderContent } from './markdown'

const IMG = /\.(png|jpe?g|gif|webp|avif)$/i
const PAGE = 50

function timeLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return sameDay ? `Today ${t}` : `${d.toLocaleDateString()} ${t}`
}

/** Keep a complete update wholesale; merge a partial one onto what we have. */
function applyUpdate(prev: MessageRow[], patch: MessageRow): MessageRow[] {
  const complete = !!patch.timestamp && !!patch.authorId
  return prev.map((m) => {
    if (m.id !== patch.id) return m
    if (complete) return { ...patch, editedTimestamp: patch.editedTimestamp ?? m.editedTimestamp }
    return {
      ...m,
      content: patch.content || m.content,
      editedTimestamp: patch.editedTimestamp ?? m.editedTimestamp,
      attachments: patch.attachments.length ? patch.attachments : m.attachments,
      embedCount: patch.embedCount || m.embedCount
    }
  })
}

export function MessagePane({
  selection,
  channelNames,
  pinnedThreadIds,
  onOpen
}: {
  selection: Selection | null
  channelNames: Map<string, string>
  pinnedThreadIds: Set<string>
  onOpen: (sel: Selection) => void
}): JSX.Element {
  const [messages, setMessages] = useState<MessageRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [threadsOpen, setThreadsOpen] = useState(false)
  const [replyTo, setReplyTo] = useState<MessageRow | null>(null)
  const [pingReply, setPingReply] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const atBottomRef = useRef(true)
  const prependRef = useRef<number | null>(null)

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
        } else setError(res.error ?? 'Failed to load messages.')
      })
      .finally(() => !cancelled && setLoading(false))
    setDraft('')
    setSendError(null)
    setThreads([])
    setThreadsOpen(false)
    setReplyTo(null)

    // only guild text channels have threads
    if (!selection.isThread && !selection.isDm) {
      window.harmony.getThreads(selection.channelId).then((res) => {
        if (!cancelled && res.ok && res.threads) setThreads(res.threads)
      })
    }
    return () => {
      cancelled = true
    }
  }, [selection?.channelId, selection?.isThread, selection?.isDm])

  // live create / update / delete for the open channel
  useEffect(() => {
    if (!selection) return
    const channelId = selection.channelId
    return window.harmony.onMessage((evt) => {
      if (evt.channelId !== channelId) return
      if (evt.kind === 'create') {
        atBottomRef.current = isNearBottom()
        setMessages((prev) =>
          prev.some((m) => m.id === evt.message.id) ? prev : [...prev, evt.message]
        )
      } else if (evt.kind === 'update') {
        setMessages((prev) => applyUpdate(prev, evt.message))
      } else {
        setMessages((prev) => prev.filter((m) => m.id !== evt.id))
      }
    })
  }, [selection?.channelId])

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
      // keep the viewport anchored on the same message after prepending history
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

  const send = async (): Promise<void> => {
    if (!selection || sending) return
    const text = draft.trim()
    if (!text) return
    setSending(true)
    setSendError(null)
    const res = await window.harmony.sendMessage(
      selection.channelId,
      text,
      replyTo ? { replyToId: replyTo.id, pingReply } : undefined
    )
    setSending(false)
    if (res.ok && res.message) {
      atBottomRef.current = true
      setMessages((prev) =>
        prev.some((m) => m.id === res.message!.id) ? prev : [...prev, res.message!]
      )
      setDraft('')
      setReplyTo(null)
    } else {
      setSendError(res.error ?? 'Failed to send.')
    }
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

  const renderThreadRow = (t: ThreadSummary): JSX.Element => {
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
          (selection?.channelId === t.id ? ' current' : '')
        }
        onClick={() =>
          selection &&
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
        <div className="messages-col">
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
                  <button className="msg-reply" title="Reply" onClick={() => startReply(m)}>
                    ↩
                  </button>
                  {!grouped && (
                    <div className="msg-meta">
                      <span className="author">{m.authorName}</span>
                      <span className="ts">{timeLabel(m.timestamp)}</span>
                    </div>
                  )}
                  {m.replyTo && <div className="reply-to">↳ replying to {m.replyTo}</div>}
                  {m.content && (
                    <div className="msg-body">
                      {renderContent(m.content, mdCtxFor(m))}
                      {m.editedTimestamp && (
                        <span className="edited-tag" title={timeLabel(m.editedTimestamp)}>
                          {' '}
                          (edited)
                        </span>
                      )}
                    </div>
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
                </div>
              )
            })}
          </div>

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
              onChange={(e) => setDraft(e.target.value)}
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
              <span className={draft.length > 2000 ? 'over' : ''}>{draft.length}/2000</span>
              <button
                disabled={sending || !draft.trim() || draft.length > 2000}
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
