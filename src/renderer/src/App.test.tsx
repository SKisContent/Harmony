import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnifiedState } from '@shared/types'
import { App } from './App'
import { channel, makeState } from './test-fixtures'

type Harmony = Window['harmony']

function mountApp(state: UnifiedState = makeState()): {
  harmony: Record<keyof Harmony, ReturnType<typeof vi.fn>>
  push: (s: UnifiedState) => void
} {
  let listener: ((s: UnifiedState) => void) | null = null
  const harmony = {
    getState: vi.fn().mockResolvedValue(state),
    onState: vi.fn((cb: (s: UnifiedState) => void) => {
      listener = cb
      return () => {}
    }),
    onMessage: vi.fn(() => () => {}),
    onTyping: vi.fn(() => () => {}),
    login: vi.fn().mockResolvedValue({ ok: true }),
    setToken: vi.fn().mockResolvedValue({ ok: true }),
    logout: vi.fn().mockResolvedValue(undefined),
    reconnect: vi.fn().mockResolvedValue(undefined),
    getMessages: vi.fn().mockResolvedValue({ ok: true, messages: [] }),
    sendMessage: vi.fn().mockResolvedValue({ ok: false }),
    editMessage: vi.fn().mockResolvedValue({ ok: true }),
    deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
    react: vi.fn().mockResolvedValue({ ok: true }),
    reactionUsers: vi.fn().mockResolvedValue({ ok: true, users: [] }),
    ackChannel: vi.fn().mockResolvedValue(undefined),
    setMuted: vi.fn().mockResolvedValue({ ok: true }),
    startTyping: vi.fn().mockResolvedValue(undefined),
    uploadAttachment: vi.fn().mockResolvedValue({ ok: true }),
    getThreads: vi.fn().mockResolvedValue({ ok: true, threads: [] }),
    setPref: vi.fn().mockResolvedValue(undefined),
    pinThread: vi.fn().mockResolvedValue(undefined),
    setThreadPinMeta: vi.fn().mockResolvedValue(undefined),
    reorderPinnedThreads: vi.fn().mockResolvedValue(undefined),
    pinChannel: vi.fn().mockResolvedValue(undefined),
    reorderPinnedChannels: vi.fn().mockResolvedValue(undefined),
    setCategoryLayout: vi.fn().mockResolvedValue(undefined),
    reorderPinnedCategories: vi.fn().mockResolvedValue(undefined)
  }
  ;(window as unknown as { harmony: unknown }).harmony = harmony
  render(<App />)
  return {
    harmony: harmony as unknown as Record<keyof Harmony, ReturnType<typeof vi.fn>>,
    push: (s: UnifiedState) => act(() => listener?.(s))
  }
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('sidebar mode switch', () => {
  it('shows Servers, DMs and Pinned, and switches views', async () => {
    const user = userEvent.setup()
    mountApp()

    // servers view is the default
    expect(await screen.findByText('general')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Servers/ })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^Pinned/ }))
    // the pinned view lists the pinned thread and the tombstone
    expect(screen.getByText('standup')).toBeInTheDocument()
    expect(screen.getByText(/removed from Discord/i)).toBeInTheDocument()
    expect(screen.queryByText('general')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^DMs/ }))
    expect(screen.getByText('No direct messages.')).toBeInTheDocument()
  })
})

describe('FR-6 — hide empty categories', () => {
  it('hides a category flagged hidden and reveals it via the affordance', async () => {
    const user = userEvent.setup()
    mountApp()

    await screen.findByText('General')
    // "Archive" is hidden by the empty-category rule
    expect(screen.queryByText('Archive')).not.toBeInTheDocument()
    const reveal = screen.getByRole('button', { name: /1 hidden category/ })
    expect(reveal).toBeInTheDocument()

    await user.click(reveal)
    expect(screen.getByText('Archive')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Hide empty categories/ })).toBeInTheDocument()
  })

  it('reflects the pref in the checkbox and writes it on toggle', async () => {
    const user = userEvent.setup()
    const { harmony } = mountApp()

    const cb = await screen.findByRole('checkbox', { name: /Hide empty categories/ })
    expect(cb).toBeChecked()

    await user.click(cb)
    expect(harmony.setPref).toHaveBeenCalledWith('hideEmptyCategories', '0')
  })

  it('changes the empty-definition pref from the select', async () => {
    const user = userEvent.setup()
    const { harmony } = mountApp()

    const select = await screen.findByRole('combobox', { name: /Empty means/ })
    await user.selectOptions(select, 'no-unread')
    expect(harmony.setPref).toHaveBeenCalledWith('emptyMode', 'no-unread')
  })
})

describe('FR-7 — pin / collapse / reorder categories', () => {
  it('pins a category', async () => {
    const user = userEvent.setup()
    const { harmony } = mountApp()

    const head = (await screen.findByText('General')).closest('.cat-head')!
    await user.click(within(head as HTMLElement).getByTitle('Pin category to top'))
    expect(harmony.setCategoryLayout).toHaveBeenCalledWith('cat1', 'g1', { pinned: true })
  })

  it('collapses a category and stops rendering its channels', async () => {
    const user = userEvent.setup()
    const { harmony, push } = mountApp()

    expect(await screen.findByText('general')).toBeInTheDocument()
    await user.click(screen.getByText('General'))
    expect(harmony.setCategoryLayout).toHaveBeenCalledWith('cat1', 'g1', { collapsed: true })

    // simulate the store round-trip
    const next = makeState()
    next.guilds[0].categories[0].collapsed = true
    push(next)
    expect(screen.queryByText('general')).not.toBeInTheDocument()
  })

  it('renders pinned categories above unpinned ones, ordered by pinSortKey', async () => {
    const s = makeState()
    // two pinned categories (Archive pinned second) + keep General unpinned
    s.guilds[0].categories[1] = {
      ...s.guilds[0].categories[1],
      name: 'Zeta',
      hidden: false,
      pinned: true,
      pinSortKey: 1,
      channels: [
        channel({ id: 'c2', name: 'zeta-chan', parentId: 'cat2' })
      ]
    }
    s.guilds[0].categories.push({
      id: 'cat3',
      name: 'Alpha',
      position: 2,
      recentActivity: '0',
      channels: [
        channel({ id: 'c3', name: 'alpha-chan', parentId: 'cat3' })
      ],
      pinned: true,
      pinSortKey: 0,
      collapsed: false,
      hidden: false
    })
    mountApp(s)

    const heads = (await screen.findAllByText(/^(Zeta|Alpha|General)$/)).map((n) => n.textContent)
    // Alpha (key 0) then Zeta (key 1) — both pinned — then General (unpinned)
    expect(heads).toEqual(['Alpha', 'Zeta', 'General'])
  })

  it('reorders pinned categories with the arrow controls', async () => {
    const user = userEvent.setup()
    const s = makeState()
    s.guilds[0].categories[0].pinned = true
    s.guilds[0].categories[0].pinSortKey = 0
    s.guilds[0].categories[1] = {
      ...s.guilds[0].categories[1],
      hidden: false,
      pinned: true,
      pinSortKey: 1,
      channels: [channel({ id: 'c2', name: 'old-stuff', parentId: 'cat2' })]
    }
    const { harmony } = mountApp(s)

    const head = (await screen.findByText('General')).closest('.cat-head')!
    await user.click(within(head as HTMLElement).getByTitle(/Move down/))
    expect(harmony.reorderPinnedCategories).toHaveBeenCalledWith(['cat2', 'cat1'])
  })
})

describe('guild collapse / expand', () => {
  it('collapses a server to hide its categories, channels and threads, then expands it back', async () => {
    const user = userEvent.setup()
    mountApp()

    expect(await screen.findByText('general')).toBeInTheDocument()
    expect(screen.getByText('standup')).toBeInTheDocument()

    await user.click(screen.getByText('Acme', { selector: '.g-name' }))
    expect(screen.queryByText('General')).not.toBeInTheDocument()
    expect(screen.queryByText('general')).not.toBeInTheDocument()
    expect(screen.queryByText('standup')).not.toBeInTheDocument()
    // the guild header itself stays put so it can be expanded again
    expect(screen.getByText('Acme', { selector: '.g-name' })).toBeInTheDocument()

    await user.click(screen.getByText('Acme', { selector: '.g-name' }))
    expect(screen.getByText('general')).toBeInTheDocument()
    expect(screen.getByText('standup')).toBeInTheDocument()
  })

  it('remembers a category’s own collapsed state across a guild collapse/expand cycle', async () => {
    const user = userEvent.setup()
    const { push } = mountApp()

    expect(await screen.findByText('general')).toBeInTheDocument()
    // collapse just the "General" category first
    await user.click(screen.getByText('General'))
    const next = makeState()
    next.guilds[0].categories[0].collapsed = true
    push(next)
    expect(screen.queryByText('general')).not.toBeInTheDocument()
    expect(screen.getByText('General')).toBeInTheDocument()

    // now collapse and re-expand the whole server
    await user.click(screen.getByText('Acme', { selector: '.g-name' }))
    expect(screen.queryByText('General')).not.toBeInTheDocument()
    await user.click(screen.getByText('Acme', { selector: '.g-name' }))

    // "General" is visible again, but still collapsed — its channel stays hidden
    expect(screen.getByText('General')).toBeInTheDocument()
    expect(screen.queryByText('general')).not.toBeInTheDocument()
  })

  it('does not toggle collapse when muting the server', async () => {
    const user = userEvent.setup()
    const { harmony } = mountApp()

    const head = (await screen.findByText('Acme', { selector: '.g-name' })).closest('.guild-head')!
    await user.click(within(head as HTMLElement).getByTitle('Mute server'))
    expect(harmony.setMuted).toHaveBeenCalledWith({ guildId: 'g1' }, true)
    expect(screen.getByText('general')).toBeInTheDocument()
  })
})

describe('mute / unmute', () => {
  it('mutes a channel with the right target', async () => {
    const user = userEvent.setup()
    const { harmony } = mountApp()
    const row = (await screen.findByText('general')).closest('.chan')!
    await user.click(within(row as HTMLElement).getByTitle('Mute channel'))
    expect(harmony.setMuted).toHaveBeenCalledWith({ guildId: 'g1', channelId: 'c1' }, true)
  })

  it('mutes a server', async () => {
    const user = userEvent.setup()
    const { harmony } = mountApp()
    await screen.findByText('general')
    await user.click(screen.getByTitle('Mute server'))
    expect(harmony.setMuted).toHaveBeenCalledWith({ guildId: 'g1' }, true)
  })

  it('mutes a DM conversation', async () => {
    const user = userEvent.setup()
    const s = makeState()
    s.dms = [
      {
        id: 'dm1',
        type: 1,
        name: 'Dana',
        iconUrl: null,
        unread: false,
        mentionCount: 0,
        muted: false,
        status: 'offline',
        members: []
      }
    ]
    const { harmony } = mountApp(s)
    await user.click(await screen.findByRole('button', { name: /^DMs/ }))
    const row = (await screen.findByText('Dana')).closest('.dm')!
    await user.click(within(row as HTMLElement).getByTitle('Mute conversation'))
    expect(harmony.setMuted).toHaveBeenCalledWith({ channelId: 'dm1' }, true)
  })
})

describe('FR-3 — pin threads', () => {
  it('pins a thread from the sidebar', async () => {
    const user = userEvent.setup()
    const { harmony } = mountApp()

    const row = (await screen.findByText('design-notes')).closest('.thread')!
    await user.click(within(row as HTMLElement).getByTitle('Pin thread'))
    expect(harmony.pinThread).toHaveBeenCalledWith('t1', true)
  })

  it('marks the pinned thread row with is-pinned', async () => {
    mountApp()
    const row = (await screen.findByText('standup')).closest('.thread')
    expect(row).toHaveClass('is-pinned')
    const other = screen.getByText('design-notes').closest('.thread')
    expect(other).not.toHaveClass('is-pinned')
  })

  it('unpins and reorders from the Pinned view', async () => {
    const user = userEvent.setup()
    const { harmony } = mountApp()

    await user.click(await screen.findByRole('button', { name: /^Pinned/ }))

    const row = screen.getByText('standup').closest('.pin-row')!
    await user.click(within(row as HTMLElement).getByTitle('Unpin'))
    expect(harmony.pinThread).toHaveBeenCalledWith('t2', false)

    await user.click(within(row as HTMLElement).getByTitle('Move down'))
    expect(harmony.reorderPinnedThreads).toHaveBeenCalledWith(['gone', 't2'])
  })

  it('does not open a missing (tombstoned) pinned thread', async () => {
    const user = userEvent.setup()
    mountApp()
    await user.click(await screen.findByRole('button', { name: /^Pinned/ }))

    await user.click(screen.getByText('Removed thread'))
    // the click is inert — the message pane still has nothing selected
    expect(screen.getByText('Pick a channel on the left to read it.')).toBeInTheDocument()
  })
})

describe('channel pinning', () => {
  it('pins a channel from the sidebar row', async () => {
    const user = userEvent.setup()
    const { harmony } = mountApp()
    const row = (await screen.findByText('general')).closest('.chan')!
    await user.click(within(row as HTMLElement).getByTitle('Pin channel'))
    expect(harmony.pinChannel).toHaveBeenCalledWith('c1', 'g1', true)
  })

  it('marks a pinned channel row and lists it in the Pinned view', async () => {
    const user = userEvent.setup()
    const s = makeState()
    s.guilds[0].categories[0].channels[0] = channel({
      id: 'c1',
      name: 'general',
      pinned: true,
      threads: s.guilds[0].categories[0].channels[0].threads
    })
    s.local.pinnedChannels = [
      {
        id: 'c1',
        name: 'general',
        guildId: 'g1',
        guildName: 'Acme',
        categoryName: 'General',
        unread: false,
        mentionCount: 0,
        muted: false,
        sortKey: 0,
        missing: false
      }
    ]
    mountApp(s)

    expect((await screen.findByText('general')).closest('.chan')).toHaveClass('is-pinned')

    await user.click(screen.getByRole('button', { name: /^Pinned/ }))
    const row = screen.getByText('general').closest('.pin-row')!
    expect(within(row as HTMLElement).getByText(/Acme › General/)).toBeInTheDocument()
  })

  it('unpins and reorders channels from the Pinned view', async () => {
    const user = userEvent.setup()
    const s = makeState()
    const mk = (id: string, name: string, sortKey: number) => ({
      id,
      name,
      guildId: 'g1',
      guildName: 'Acme',
      categoryName: 'General',
      unread: false,
      mentionCount: 0,
      muted: false,
      sortKey,
      missing: false
    })
    s.local.pinnedChannels = [mk('c1', 'first', 0), mk('c9', 'second', 1)]
    const { harmony } = mountApp(s)

    await user.click(await screen.findByRole('button', { name: /^Pinned/ }))
    const row = screen.getByText('first').closest('.pin-row')!
    await user.click(within(row as HTMLElement).getByTitle('Unpin'))
    expect(harmony.pinChannel).toHaveBeenCalledWith('c1', 'g1', false)

    await user.click(within(row as HTMLElement).getByTitle('Move down'))
    expect(harmony.reorderPinnedChannels).toHaveBeenCalledWith(['c9', 'c1'])
  })
})
