import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveMessage, MessageRow, ThreadSummary, TypingEvent } from '@shared/types'
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
    reactions: [],
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
  saved?: Set<string>
  selfId?: string
}) {
  let onMsg: ((e: LiveMessage) => void) | null = null
  let onTyp: ((e: TypingEvent) => void) | null = null
  const getMessages = vi.fn().mockResolvedValue({ ok: true, messages: opts.messages ?? [] })
  const harmony = {
    getMessages,
    getThreads: vi.fn().mockResolvedValue({ ok: true, threads: opts.threads ?? [] }),
    sendMessage: vi.fn().mockResolvedValue({ ok: false }),
    editMessage: vi.fn().mockResolvedValue({ ok: false }),
    deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
    react: vi.fn().mockResolvedValue({ ok: true }),
    reactionUsers: vi.fn().mockResolvedValue({ ok: true, users: [] }),
    ackChannel: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn().mockResolvedValue(undefined),
    uploadAttachment: vi.fn().mockResolvedValue({ ok: true, ref: { id: '0', filename: 'x', uploaded_filename: 'u' } }),
    pinThread: vi.fn().mockResolvedValue(undefined),
    addBookmark: vi.fn().mockResolvedValue({ ok: true }),
    removeBookmark: vi.fn().mockResolvedValue(undefined),
    getGuildAssets: vi.fn().mockResolvedValue({ ok: true, emojis: [], stickers: [] }),
    searchGifs: vi.fn().mockResolvedValue({ ok: true, gifs: [] }),
    renameThread: vi.fn().mockResolvedValue({ ok: true }),
    setThreadArchived: vi.fn().mockResolvedValue({ ok: true }),
    leaveThread: vi.fn().mockResolvedValue({ ok: true }),
    setChannelNotifyLevel: vi.fn().mockResolvedValue({ ok: true }),
    onMessage: vi.fn((cb: (e: LiveMessage) => void) => {
      onMsg = cb
      return () => {}
    }),
    onTyping: vi.fn((cb: (e: TypingEvent) => void) => {
      onTyp = cb
      return () => {}
    })
  }
  ;(window as unknown as { harmony: unknown }).harmony = harmony
  const { unmount } = render(
    <MessagePane
      selection={selection}
      channelNames={new Map()}
      pinnedThreadIds={opts.pinned ?? new Set()}
      savedIds={opts.saved ?? new Set()}
      selfId={opts.selfId ?? 'u1'}
      onOpen={vi.fn()}
    />
  )
  return {
    harmony,
    unmount,
    emit: (e: LiveMessage) => act(() => onMsg?.(e)),
    emitTyping: (e: TypingEvent) => act(() => onTyp?.(e))
  }
}

const renderPane = (): ReturnType<typeof mount> => mount({ messages: [msg({ id: 'm1' })] })

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

describe('mark-as-read', () => {
  it('acks the newest message once the channel loads', async () => {
    const { harmony } = mount({
      messages: [msg({ id: 'a' }), msg({ id: 'b' }), msg({ id: 'newest', content: 'the last one' })]
    })
    await screen.findByText('the last one')
    expect(harmony.ackChannel).toHaveBeenCalledWith('c1', 'newest')
  })

  it('acks a live message that arrives while at the bottom', async () => {
    const { harmony, emit } = mount({ messages: [msg({ id: 'a' })] })
    await screen.findByText('hello')
    harmony.ackChannel.mockClear()
    emit({ kind: 'create', channelId: 'c1', message: msg({ id: 'live', content: 'new one' }) })
    expect(harmony.ackChannel).toHaveBeenCalledWith('c1', 'live')
  })
})

describe('per-channel drafts', () => {
  it('persists the draft to localStorage and restores it', async () => {
    const user = userEvent.setup()
    const { unmount } = renderPane()
    const box = await screen.findByRole('textbox')
    await user.type(box, 'half a thought')
    expect(localStorage.getItem('draft:c1')).toBe('half a thought')

    unmount()
    renderPane()
    expect(await screen.findByRole('textbox')).toHaveValue('half a thought')
  })

  it('clears the draft after a successful send', async () => {
    const user = userEvent.setup()
    const { harmony } = renderPane()
    harmony.sendMessage.mockResolvedValueOnce({ ok: true, message: msg({ id: 's', content: 'sent' }) })
    const box = await screen.findByRole('textbox')
    await user.type(box, 'ship it{Enter}')
    expect(localStorage.getItem('draft:c1')).toBeNull()
  })
})

describe('edit / delete own messages', () => {
  it('edits via the hover toolbar', async () => {
    const user = userEvent.setup()
    const { harmony } = mount({
      selfId: 'u1',
      messages: [msg({ id: 'm1', authorId: 'u1', content: 'typo' })]
    })
    harmony.editMessage.mockResolvedValueOnce({
      ok: true,
      message: msg({ id: 'm1', authorId: 'u1', content: 'fixed' })
    })
    const row = (await screen.findByText('typo')).closest('.msg') as HTMLElement
    await user.click(within(row).getByTitle('Edit'))
    const editBox = within(row).getByRole('textbox')
    await user.clear(editBox)
    await user.type(editBox, 'fixed{Enter}')
    expect(harmony.editMessage).toHaveBeenCalledWith('c1', 'm1', 'fixed')
  })

  it('does not offer edit/delete on other people’s messages', async () => {
    mount({ selfId: 'u1', messages: [msg({ id: 'm1', authorId: 'someone-else' })] })
    const row = (await screen.findByText('hello')).closest('.msg') as HTMLElement
    expect(within(row).queryByTitle('Edit')).toBeNull()
    expect(within(row).queryByTitle('Delete')).toBeNull()
  })

  it('deletes after confirming', async () => {
    const user = userEvent.setup()
    const { harmony } = mount({
      selfId: 'u1',
      messages: [msg({ id: 'm1', authorId: 'u1', content: 'oops' })]
    })
    const row = (await screen.findByText('oops')).closest('.msg') as HTMLElement
    await user.click(within(row).getByTitle('Delete'))
    await user.click(within(row).getByRole('button', { name: 'Delete' }))
    expect(harmony.deleteMessage).toHaveBeenCalledWith('c1', 'm1')
  })
})

describe('reactions', () => {
  it('toggles an existing reaction pill', async () => {
    const user = userEvent.setup()
    const { harmony } = mount({
      messages: [
        msg({
          id: 'm1',
          reactions: [{ key: '👍', name: '👍', id: null, animated: false, count: 2, me: false }]
        })
      ]
    })
    const row = (await screen.findByText('hello')).closest('.msg') as HTMLElement
    await user.click(within(row).getByText('2').closest('button')!)
    expect(harmony.react).toHaveBeenCalledWith('c1', 'm1', '👍', true)
    expect(within(row).getByText('3')).toBeInTheDocument() // optimistic
  })

  it('adds a reaction from the quick-react row', async () => {
    const user = userEvent.setup()
    const { harmony } = mount({ messages: [msg({ id: 'm1' })] })
    const row = (await screen.findByText('hello')).closest('.msg') as HTMLElement
    await user.click(within(row).getByTitle('Add reaction'))
    await user.click(within(row).getByText('🎉'))
    expect(harmony.react).toHaveBeenCalledWith('c1', 'm1', '🎉', true)
  })

  it('applies a live reaction event', async () => {
    const { emit } = mount({ messages: [msg({ id: 'm1' })] })
    await screen.findByText('hello')
    emit({
      kind: 'reaction',
      channelId: 'c1',
      messageId: 'm1',
      emoji: { key: '🔥', name: '🔥', id: null, animated: false },
      delta: 1,
      me: false
    })
    expect(screen.getByText('1')).toBeInTheDocument()
  })
})

describe('typing indicator', () => {
  it('shows who is typing from an incoming event', async () => {
    const { emitTyping } = mount({ messages: [msg({ id: 'm1' })], selfId: 'me' })
    await screen.findByText('hello')
    emitTyping({ channelId: 'c1', userId: 'u2', userName: 'Bob' })
    expect(screen.getByText('Bob is typing…')).toBeInTheDocument()
  })

  it('ignores your own typing and other channels', async () => {
    const { emitTyping } = mount({ messages: [msg({ id: 'm1' })], selfId: 'me' })
    await screen.findByText('hello')
    emitTyping({ channelId: 'c1', userId: 'me', userName: 'Me' })
    emitTyping({ channelId: 'other', userId: 'u2', userName: 'Bob' })
    expect(screen.queryByText(/is typing/)).toBeNull()
  })

  it('pings the typing endpoint as you type (throttled)', async () => {
    const user = userEvent.setup()
    const { harmony } = renderPane()
    await user.type(await screen.findByRole('textbox'), 'abcdef')
    expect(harmony.startTyping).toHaveBeenCalledTimes(1)
    expect(harmony.startTyping).toHaveBeenCalledWith('c1')
  })
})

describe('attachments', () => {
  it('adds a chosen file as a pending chip and uploads it on send', async () => {
    const user = userEvent.setup()
    const { harmony } = renderPane()
    await screen.findByText('hello')

    const file = new File(['x'], 'shot.png', { type: 'image/png' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) })
    const input = document.querySelector('input[type=file]') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
      await Promise.resolve()
    })
    expect(await screen.findByText('shot.png')).toBeInTheDocument()

    harmony.sendMessage.mockResolvedValueOnce({ ok: true, message: msg({ id: 's' }) })
    await user.click(screen.getByRole('button', { name: /Send/ }))
    expect(harmony.uploadAttachment).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ name: 'shot.png', type: 'image/png' })
    )
    expect(screen.queryByText('shot.png')).not.toBeInTheDocument() // tray cleared
  })
})
