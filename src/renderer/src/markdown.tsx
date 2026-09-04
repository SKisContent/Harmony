// A focused renderer for the slice of Discord-flavoured markdown that actually
// shows up in messages: bold/italic/underline/strike, inline + fenced code,
// blockquotes, headings, spoilers, links, and <@id> / <#id> / <:emoji:> /
// <t:unix> tokens. Not a spec-complete markdown implementation.

import { type ReactElement, type ReactNode, useState } from 'react'

export interface MdContext {
  /** user id -> display name, for <@id> */
  mentions: Map<string, string>
  /** channel/thread id -> name, for <#id> */
  channels: Map<string, string>
}

function Spoiler({ children }: { children: ReactNode }): ReactElement {
  const [shown, setShown] = useState(false)
  return (
    <span
      className={'md-spoiler' + (shown ? ' revealed' : '')}
      onClick={() => !shown && setShown(true)}
      role="button"
      tabIndex={0}
    >
      {children}
    </span>
  )
}

function formatTimestamp(unix: number, style?: string): string {
  const d = new Date(unix * 1000)
  if (Number.isNaN(d.getTime())) return ''
  switch (style) {
    case 't':
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    case 'T':
      return d.toLocaleTimeString()
    case 'd':
      return d.toLocaleDateString()
    case 'D':
      return d.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' })
    case 'F':
      return d.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })
    case 'R':
      return relativeTime(d)
    default:
      return d.toLocaleString()
  }
}

function relativeTime(d: Date): string {
  const secs = Math.round((d.getTime() - Date.now()) / 1000)
  const abs = Math.abs(secs)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (abs < 60) return rtf.format(secs, 'second')
  if (abs < 3600) return rtf.format(Math.round(secs / 60), 'minute')
  if (abs < 86_400) return rtf.format(Math.round(secs / 3600), 'hour')
  if (abs < 2_592_000) return rtf.format(Math.round(secs / 86_400), 'day')
  if (abs < 31_536_000) return rtf.format(Math.round(secs / 2_592_000), 'month')
  return rtf.format(Math.round(secs / 31_536_000), 'year')
}

interface Rule {
  re: RegExp
  /** leaf rules don't recurse; wrapping rules re-parse capture group 1 */
  render: (m: RegExpExecArray, ctx: MdContext, k: string) => ReactNode
}

const RULES: Rule[] = [
  // custom / animated emoji
  {
    re: /<(a?):(\w+):(\d+)>/,
    render: (m, _ctx, k) => (
      <img
        key={k}
        className="md-emoji"
        src={`https://cdn.discordapp.com/emojis/${m[3]}.${m[1] === 'a' ? 'gif' : 'png'}?size=44`}
        alt={`:${m[2]}:`}
        title={`:${m[2]}:`}
      />
    )
  },
  // <t:unix:style> timestamp
  {
    re: /<t:(-?\d+)(?::([tTdDfFR]))?>/,
    render: (m, _ctx, k) => (
      <span key={k} className="md-time">
        {formatTimestamp(Number(m[1]), m[2])}
      </span>
    )
  },
  // user mention
  {
    re: /<@!?(\d+)>/,
    render: (m, ctx, k) => (
      <span key={k} className="md-mention">
        @{ctx.mentions.get(m[1]) ?? 'user'}
      </span>
    )
  },
  // role mention (no role data available yet)
  {
    re: /<@&(\d+)>/,
    render: (_m, _ctx, k) => (
      <span key={k} className="md-mention">
        @role
      </span>
    )
  },
  // channel mention
  {
    re: /<#(\d+)>/,
    render: (m, ctx, k) => (
      <span key={k} className="md-mention">
        #{ctx.channels.get(m[1]) ?? 'channel'}
      </span>
    )
  },
  // @everyone / @here
  {
    re: /@(everyone|here)\b/,
    render: (m, _ctx, k) => (
      <span key={k} className="md-mention">
        @{m[1]}
      </span>
    )
  },
  // masked link [text](url)
  {
    re: /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/,
    render: (m, ctx, k) => (
      <a key={k} href={m[2]} target="_blank" rel="noreferrer">
        {parseInline(m[1], ctx)}
      </a>
    )
  },
  // bare URL (stop before trailing punctuation)
  {
    re: /(https?:\/\/[^\s<]+[^\s<.,!?:;)\]])/,
    render: (m, _ctx, k) => (
      <a key={k} href={m[1]} target="_blank" rel="noreferrer">
        {m[1]}
      </a>
    )
  },
  // inline code — leaf, no inner parsing
  {
    re: /`([^`\n]+)`/,
    render: (m, _ctx, k) => (
      <code key={k} className="md-code">
        {m[1]}
      </code>
    )
  },
  { re: /\|\|([\s\S]+?)\|\|/, render: (m, ctx, k) => <Spoiler key={k}>{parseInline(m[1], ctx)}</Spoiler> },
  { re: /\*\*([\s\S]+?)\*\*/, render: (m, ctx, k) => <strong key={k}>{parseInline(m[1], ctx)}</strong> },
  { re: /__([\s\S]+?)__/, render: (m, ctx, k) => <u key={k}>{parseInline(m[1], ctx)}</u> },
  { re: /~~([\s\S]+?)~~/, render: (m, ctx, k) => <s key={k}>{parseInline(m[1], ctx)}</s> },
  { re: /\*([^\s*][\s\S]*?)\*/, render: (m, ctx, k) => <em key={k}>{parseInline(m[1], ctx)}</em> },
  { re: /(?:^|(?<=\s))_([^\s_][\s\S]*?)_(?=\s|$)/, render: (m, ctx, k) => <em key={k}>{parseInline(m[1], ctx)}</em> }
]

export function parseInline(text: string, ctx: MdContext): ReactNode[] {
  const out: ReactNode[] = []
  let rest = text
  let guard = 0
  while (rest.length && guard++ < 5000) {
    let best: { idx: number; len: number; node: ReactNode } | null = null
    for (const rule of RULES) {
      const m = rule.re.exec(rest)
      if (!m) continue
      if (best === null || m.index < best.idx) {
        best = { idx: m.index, len: m[0].length, node: rule.render(m, ctx, `n${out.length}`) }
        if (m.index === 0) break
      }
    }
    if (!best) {
      out.push(rest)
      break
    }
    if (best.idx > 0) out.push(rest.slice(0, best.idx))
    out.push(best.node)
    rest = rest.slice(best.idx + best.len)
  }
  return out
}

/** Render a message body: block structure first, then inline. */
export function renderContent(text: string, ctx: MdContext): ReactNode {
  if (!text) return null
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let para: string[] = []

  const flushPara = (): void => {
    if (!para.length) return
    blocks.push(
      <div key={`b${blocks.length}`} className="md-p">
        {parseInline(para.join('\n'), ctx)}
      </div>
    )
    para = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (/^```/.test(line)) {
      flushPara()
      const buf: string[] = []
      // allow ```lang on the opening line; content until a lone closing fence
      const firstRest = line.slice(3).replace(/^\w+\s*/, '')
      if (firstRest) buf.push(firstRest)
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i])
        i++
      }
      blocks.push(
        <pre key={`b${blocks.length}`} className="md-pre">
          <code>{buf.join('\n')}</code>
        </pre>
      )
      continue
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      flushPara()
      const Tag = (['h1', 'h2', 'h3'] as const)[heading[1].length - 1]
      blocks.push(
        <Tag key={`b${blocks.length}`} className="md-h">
          {parseInline(heading[2], ctx)}
        </Tag>
      )
      continue
    }

    if (/^>\s?/.test(line)) {
      flushPara()
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      i--
      blocks.push(
        <blockquote key={`b${blocks.length}`} className="md-quote">
          {parseInline(buf.join('\n'), ctx)}
        </blockquote>
      )
      continue
    }

    para.push(line)
  }
  flushPara()
  return <>{blocks}</>
}
