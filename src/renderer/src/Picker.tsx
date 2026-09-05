import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react'
import type { GifResult, GuildEmoji, GuildSticker } from '@shared/types'
import { EMOJI, searchEmoji } from './emoji-data'

type Tab = 'emoji' | 'gif' | 'sticker'

export function Picker({
  guildId,
  emojis,
  stickers,
  onEmoji,
  onGif,
  onSticker,
  onClose
}: {
  guildId: string
  emojis: GuildEmoji[]
  stickers: GuildSticker[]
  onEmoji: (text: string) => void
  onGif: (url: string) => void
  onSticker: (id: string) => void
  onClose: () => void
}): ReactElement {
  const [tab, setTab] = useState<Tab>('emoji')
  const [term, setTerm] = useState('')
  const [gifs, setGifs] = useState<GifResult[]>([])
  const [gifLoading, setGifLoading] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const gifTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // GIF tab: debounced trending / search
  useEffect(() => {
    if (tab !== 'gif') return
    if (gifTimer.current) clearTimeout(gifTimer.current)
    setGifLoading(true)
    gifTimer.current = setTimeout(() => {
      void window.harmony.searchGifs(term.trim()).then((res) => {
        setGifLoading(false)
        setGifs(res.ok ? (res.gifs ?? []) : [])
      })
    }, 300)
    return () => {
      if (gifTimer.current) clearTimeout(gifTimer.current)
    }
  }, [tab, term])

  // dismiss on outside click / Escape
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const unicodeHits = useMemo(() => (term ? searchEmoji(term, 80) : EMOJI.slice(0, 80)), [term])
  const customHits = useMemo(() => {
    const q = term.trim().toLowerCase()
    return (q ? emojis.filter((c) => c.name.toLowerCase().includes(q)) : emojis).slice(0, 40)
  }, [emojis, term])
  const stickerHits = useMemo(() => {
    const q = term.trim().toLowerCase()
    return q ? stickers.filter((s) => s.name.toLowerCase().includes(q)) : stickers
  }, [stickers, term])

  return (
    <div className="picker" ref={rootRef}>
      <div className="picker-tabs">
        <button className={tab === 'emoji' ? 'on' : ''} onClick={() => setTab('emoji')}>
          Emoji
        </button>
        <button className={tab === 'gif' ? 'on' : ''} onClick={() => setTab('gif')}>
          GIF
        </button>
        <button
          className={tab === 'sticker' ? 'on' : ''}
          onClick={() => setTab('sticker')}
          disabled={!guildId}
        >
          Stickers
        </button>
      </div>

      <input
        className="picker-search"
        autoFocus
        value={term}
        placeholder={
          tab === 'gif' ? 'Search Tenor…' : tab === 'sticker' ? 'Search stickers…' : 'Search emoji…'
        }
        onChange={(e) => setTerm(e.target.value)}
      />

      {tab === 'emoji' && (
        <div className="picker-grid emoji">
          {customHits.map((c) => (
            <button
              key={c.id}
              title={`:${c.name}:`}
              onClick={() => onEmoji(`<${c.animated ? 'a' : ''}:${c.name}:${c.id}>`)}
            >
              <img
                src={`https://cdn.discordapp.com/emojis/${c.id}.${c.animated ? 'gif' : 'png'}?size=44`}
                alt={c.name}
              />
            </button>
          ))}
          {unicodeHits.map((it) => (
            <button key={it.n} title={`:${it.n}:`} onClick={() => onEmoji(it.e)}>
              {it.e}
            </button>
          ))}
          {customHits.length === 0 && unicodeHits.length === 0 && (
            <div className="picker-empty">No emoji match.</div>
          )}
        </div>
      )}

      {tab === 'gif' && (
        <div className="picker-grid gif">
          {gifLoading && <div className="picker-empty">Loading…</div>}
          {!gifLoading &&
            gifs.map((g) => (
              <button key={g.url} onClick={() => onGif(g.url)} title="Send GIF">
                <img src={g.preview} alt="" loading="lazy" />
              </button>
            ))}
          {!gifLoading && gifs.length === 0 && <div className="picker-empty">No GIFs.</div>}
        </div>
      )}

      {tab === 'sticker' && (
        <div className="picker-grid sticker">
          {stickerHits.map((s) => (
            <button key={s.id} title={s.name} onClick={() => onSticker(s.id)}>
              {s.format === 3 ? (
                <span className="sticker-lottie">{s.name}</span>
              ) : (
                <img
                  src={`https://cdn.discordapp.com/stickers/${s.id}.${s.format === 4 ? 'gif' : 'png'}?size=160`}
                  alt={s.name}
                />
              )}
            </button>
          ))}
          {stickerHits.length === 0 && (
            <div className="picker-empty">
              {guildId ? 'This server has no stickers.' : 'Open a server channel for stickers.'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
