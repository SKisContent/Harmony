import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveMessage, MessageRow, ThreadSummary } from '@shared/types'
import { MessagePane } from './MessagePane'
import type { Selection } from './App'

function msg(over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 'm1',
    authorId: 'u1',
    authorName: 'Alice',
    content: 'hello',
    timestamp: new Date().toISOString(),
    editedTimestamp: null,
    attachments: [],
    embedCount: 0,
    replyTo: null,
    system: false,
    mentions: [],
    ...over
  }
}

const selection: Selection = {
  guildId: 'g1',
  guildName: 'Acme',
  channelId: 'c1',
  channelName: 'general'
}

function mount(opts: {
  messages?: MessageRow[]
  threads?: ThreadSummary[]
  pinned?: Set<string>
}) {
  let onMsg: ((e: LiveMessage) => void) | null = null
  const getMessages = vi.fn().mockResolvedValue({ ok: true, messages: opts.messages ?? [] })
  const harmony = {
    getMessages,
    getThreads: vi.fn().mockResolvedValue({ ok: true, threads: opts.threads ?? [] }),
    sendMessage: vi.fn().mockResolvedValue({ ok: false }),
    pinThread: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn((cb: (e: LiveMessage) => void) => {
      onMsg = cb
      return () => {}
    })
  }
  ;(window as unknown as { harmony: unknown }).harmony = harmony
  render(
    <MessagePane
      selection={selection}
      channelNames={new Map()}
      pinnedThreadIds={opts.pinned ?? new Set()}
      onOpen={vi.fn()}
    />
  )
  return { harmony, emit: (e: LiveMessage) => act(() => onMsg?.(e)) }
}

afterEach(() => vi.restoreAllMocks())

describe('live channel updates', () => {
  it('appends a MESSAGE_CREATE for the open channel', async () => {
    const { emit } = mount({ messages: [msg({ id: 'm1', content: 'first' })] })
    expect(await screen.findByText('first')).toBeInTheDocument()

    emit({ kind: 'create', channelId: 'c1', message: msg({ id: 'm2', content: 'second' }) })
    expect(screen.getByText('second')).toBeInTheDocument()
  })

  it('ignores messages for a different channel', async () => {
    const { emit } = mount({ messages: [msg({ id: 'm1', content: 'first' })] })
    await screen.findByText('first')
    emit({ kind: 'create', channelId: 'other', message: msg({ id: 'x', content: 'nope' }) })
    expect(screen.queryByText('nope')).not.toBeInTheDocument()
  })

  it('patches content on MESSAGE_UPDATE and shows the edited marker', async () => {
    const { emit } = mount({ messages: [msg({ id: 'm1', content: 'before' })] })
    await screen.findByText('before')

    emit({
      kind: 'update',
      channelId: 'c1',
      message: msg({ id: 'm1', content: 'after', editedTimestamp: new Date().toISOString() })
    })
    expect(screen.queryByText('before')).not.toBeInTheDocument()
    expect(screen.getByText('after')).toBeInTheDocument()
    expect(screen.getByText(/\(edited\)/)).toBeInTheDocument()
  })

  it('drops a message on MESSAGE_DELETE', async () => {
    const { emit } = mount({ messages: [msg({ id: 'm1', content: 'doomed' })] })
    await screen.findByText('doomed')
    emit({ kind: 'delete', channelId: 'c1', id: 'm1' })
    expect(screen.queryByText('doomed')).not.toBeInTheDocument()
  })

  it('does not duplicate a create it already has (optimistic echo)', async () => {
    const { emit } = mount({ messages: [msg({ id: 'm1', content: 'once' })] })
    await screen.findByText('once')
    emit({ kind: 'create', channelId: 'c1', message: msg({ id: 'm1', content: 'once' }) })
    expect(screen.getAllByText('once')).toHaveLength(1)
  })
})

describe('scroll-back', () => {
  it('fetches an older page when scrolled to the top and prepends it', async () => {
    const first = Array.from({ length: 50 }, (_, i) =>
      msg({ id: `n${i}`, content: `msg ${i}` })
    )
    const { harmony } = mount({ messages: first })
    await screen.findByText('msg 49')
    expect(harmony.getMessages).toHaveBeenCalledTimes(1)

    harmony.getMessages.mockResolvedValueOnce({
      ok: true,
      messages: [msg({ id: 'old1', content: 'ancient' })]
    })

    const scroller = document.querySelector('.messages') as HTMLElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 5000, configurable: true })
    scroller.scrollTop = 0
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll'))
    })

    expect(harmony.getMessages).toHaveBeenLastCalledWith('c1', 'n0')
    expect(await screen.findByText('ancient')).toBeInTheDocument()
  })
})

describe('threads panel — FR-3 pin', () => {
  it('toggles a thread pin from the panel', async () => {
    const user = userEvent.setup()
    const { harmony } = mount({
      threads: [{ id: 't1', name: 'design', archived: false, messageCount: 3 }]
    })

    await user.click(await screen.findByRole('button', { name: /Threads \(1\)/ }))
    const row = (await screen.findByText(/design/)).closest('.ts-item') as HTMLElement
    await user.click(within(row).getByTitle('Pin thread'))
    expect(harmony.pinThread).toHaveBeenCalledWith('t1', true)
  })

  it('marks an already-pinned thread row', async () => {
    const user = userEvent.setup()
    mount({
      threads: [{ id: 't1', name: 'design', archived: false, messageCount: 3 }],
      pinned: new Set(['t1'])
    })
    await user.click(await screen.findByRole('button', { name: /Threads \(1\)/ }))
    const row = (await screen.findByText(/design/)).closest('.ts-item') as HTMLElement
    expect(row).toHaveClass('pinned')
    expect(within(row).getByTitle('Unpin thread')).toBeInTheDocument()
  })
})
