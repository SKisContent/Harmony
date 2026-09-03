import { useEffect, useRef, useState } from 'react'
import type { MessageRow, ThreadSummary } from '@shared/types'
import type { Selection } from './App'

const IMG = /\.(png|jpe?g|gif|webp|avif)$/i

function timeLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return sameDay ? `Today ${t}` : `${d.toLocaleDateString()} ${t}`
}

export function MessagePane({
  selection,
  onOpen
}: {
  selection: Selection | null
  onOpen: (sel: Selection) => void
}): JSX.Element {
  const [messages, setMessages] = useState<MessageRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [threadsOpen, setThreadsOpen] = useState(false)
  const [replyTo, setReplyTo] = useState<MessageRow | null>(null)
  const [pingReply, setPingReply] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!selection) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setMessages([])
    window.harmony
      .getMessages(selection.channelId)
      .then((res) => {
        if (cancelled) return
        if (res.ok && res.messages) setMessages(res.messages)
        else setError(res.error ?? 'Failed to load messages.')
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

  const startReply = (m: MessageRow) => {
    setReplyTo(m)
    inputRef.current?.focus()
  }

  const send = async () => {
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
      setMessages((prev) => (prev.some((m) => m.id === res.message!.id) ? prev : [...prev, res.message!]))
      setDraft('')
      setReplyTo(null)
    } else {
      setSendError(res.error ?? 'Failed to send.')
    }
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  if (!selection) {
    return (
      <div className="pane-empty">
        <p>Pick a channel on the left to read it.</p>
      </div>
    )
  }

  const activeThreads = threads.filter((t) => !t.archived)
  const archivedThreads = threads.filter((t) => t.archived)

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
          <div className="messages" ref={scrollRef}>
        {loading && <div className="pane-note">Loading…</div>}
        {error && <div className="pane-note error">{error}</div>}
        {!loading && !error && messages.length === 0 && (
          <div className="pane-note">No messages here yet.</div>
        )}

        {messages.map((m, i) => {
          const prev = messages[i - 1]
          const grouped =
            prev && prev.authorId === m.authorId && !m.system && !prev.system &&
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
              {m.content && <div className="msg-body">{m.content}</div>}
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
                <div className="msg-body dim">[{m.embedCount} embed{m.embedCount > 1 ? 's' : ''}]</div>
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
          <button disabled={sending || !draft.trim() || draft.length > 2000} onClick={() => void send()}>
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
              {activeThreads.length > 0 && <div className="ts-label">Active — {activeThreads.length}</div>}
              {activeThreads.map((t) => (
                <button
                  key={t.id}
                  className={'ts-item' + (selection.channelId === t.id ? ' current' : '')}
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
                  <span className="ts-count">{t.messageCount}</span>
                </button>
              ))}
              {archivedThreads.length > 0 && (
                <div className="ts-label">Archived — {archivedThreads.length}</div>
              )}
              {archivedThreads.map((t) => (
                <button
                  key={t.id}
                  className={'ts-item archived' + (selection.channelId === t.id ? ' current' : '')}
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
                  <span className="ts-count">{t.messageCount}</span>
                </button>
              ))}
            </div>
          </aside>
        )}
      </div>
    </>
  )
}
