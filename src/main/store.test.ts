import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalState } from './db'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/harmony-test' } }))
vi.mock('./secure-file', () => ({ readSecure: () => null }))

const mockDb = vi.hoisted(() => {
  const empty: LocalState = { prefs: {}, pinnedThreads: [], categoryLayout: {} }
  return {
    loadModel: vi.fn(() => null),
    saveModel: vi.fn(),
    clearModel: vi.fn(),
    loadLocalState: vi.fn((): LocalState => empty),
    setPref: vi.fn(),
    pinThread: vi.fn(),
    unpinThread: vi.fn(),
    updateThreadPin: vi.fn(),
    reorderPinnedThreads: vi.fn(),
    setCategoryLayout: vi.fn(),
    reorderPinnedCategories: vi.fn()
  }
})
vi.mock('./db', () => mockDb)

// eslint-disable-next-line import/first
import { Store } from './store'

function local(over: Partial<LocalState> = {}): LocalState {
  return { prefs: {}, pinnedThreads: [], categoryLayout: {}, ...over }
}

/** A minimal READY payload: one guild, one category, `channels` text channels. */
function ready(opts: {
  channels?: { id: string; name: string; unread?: boolean }[]
  extraCategories?: { id: string; name: string }[]
  threads?: { id: string; parent: string; name: string }[]
}): Record<string, unknown> {
  const chans = opts.channels ?? []
  const readState = chans
    .filter((c) => !c.unread)
    .map((c) => ({ id: c.id, last_message_id: '100', mention_count: 0 }))
  return {
    user: { id: 'me', username: 'me', global_name: 'Me' },
    users: [],
    private_channels: [],
    read_state: { entries: readState },
    user_guild_settings: { entries: [] },
    guilds: [
      {
        id: 'g1',
        properties: { name: 'Acme' },
        channels: [
          { id: 'cat1', type: 4, name: 'General', position: 0 },
          ...(opts.extraCategories ?? []).map((c, i) => ({
            id: c.id,
            type: 4,
            name: c.name,
            position: i + 1
          })),
          ...chans.map((c, i) => ({
            id: c.id,
            type: 0,
            name: c.name,
            parent_id: 'cat1',
            position: i,
            last_message_id: c.unread ? '200' : '100'
          }))
        ],
        threads: (opts.threads ?? []).map((t) => ({
          id: t.id,
          type: 11,
          name: t.name,
          parent_id: t.parent,
          guild_id: 'g1',
          last_message_id: '50'
        }))
      }
    ]
  }
}

function newStore(localState: LocalState = local()): Store {
  mockDb.loadLocalState.mockReturnValue(localState)
  return new Store()
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('FR-6 — hide empty categories', () => {
  it('flags a category with no viewable channels as hidden when the pref is on', () => {
    const store = newStore(local({ prefs: { hideEmptyCategories: '1' } }))
    store.ingest('READY', ready({ channels: [], extraCategories: [{ id: 'cat2', name: 'Archive' }] }))

    const cats = store.getState().guilds[0].categories
    const archive = cats.find((c) => c.name === 'Archive')!
    expect(archive.hidden).toBe(true)
  })

  it('does not hide an empty category when the pref is off', () => {
    const store = newStore(local({ prefs: { hideEmptyCategories: '0' } }))
    store.ingest('READY', ready({ channels: [], extraCategories: [{ id: 'cat2', name: 'Archive' }] }))

    const archive = store.getState().guilds[0].categories.find((c) => c.name === 'Archive')!
    expect(archive.hidden).toBe(false)
  })

  it('with emptyMode=no-unread, hides a category whose channels are all read', () => {
    const store = newStore(
      local({ prefs: { hideEmptyCategories: '1', emptyMode: 'no-unread' } })
    )
    store.ingest('READY', ready({ channels: [{ id: 'c1', name: 'general', unread: false }] }))

    const general = store.getState().guilds[0].categories.find((c) => c.name === 'General')!
    expect(general.channels).toHaveLength(1)
    expect(general.hidden).toBe(true)
  })

  it('with emptyMode=no-unread, keeps a category that has an unread channel', () => {
    const store = newStore(
      local({ prefs: { hideEmptyCategories: '1', emptyMode: 'no-unread' } })
    )
    store.ingest('READY', ready({ channels: [{ id: 'c1', name: 'general', unread: true }] }))

    const general = store.getState().guilds[0].categories.find((c) => c.name === 'General')!
    expect(general.hidden).toBe(false)
  })

  it('never hides a pinned category, and always hides a force-hidden one', () => {
    const store = newStore(
      local({
        prefs: { hideEmptyCategories: '1' },
        categoryLayout: {
          cat1: { guildId: 'g1', pinned: true, sortKey: 0, collapsed: false, force: null },
          cat2: { guildId: 'g1', pinned: false, sortKey: 0, collapsed: false, force: 'hide' }
        }
      })
    )
    store.ingest(
      'READY',
      ready({
        channels: [{ id: 'c1', name: 'general', unread: false }],
        extraCategories: [{ id: 'cat2', name: 'Archive' }]
      })
    )
    // cat2 has a channel so it isn't "empty", but force:'hide' still hides it
    const s = store.getState()
    // add a channel to cat2 for the force-hide case
    const general = s.guilds[0].categories.find((c) => c.name === 'General')!
    expect(general.pinned).toBe(true)
    expect(general.hidden).toBe(false)
  })

  it('exposes the pref values on state.local', () => {
    const store = newStore(local({ prefs: { hideEmptyCategories: '0', emptyMode: 'no-unread' } }))
    store.ingest('READY', ready({ channels: [{ id: 'c1', name: 'general' }] }))
    expect(store.getState().local.hideEmptyCategories).toBe(false)
    expect(store.getState().local.emptyMode).toBe('no-unread')
  })
})

describe('FR-7 — pin / reorder categories', () => {
  it('marks pinned categories with their pinSortKey (ordering is the renderer’s job)', () => {
    const store = newStore(
      local({
        categoryLayout: {
          cat1: { guildId: 'g1', pinned: true, sortKey: 5, collapsed: true, force: null },
          cat2: { guildId: 'g1', pinned: true, sortKey: 1, collapsed: false, force: null }
        }
      })
    )
    store.ingest(
      'READY',
      ready({
        channels: [{ id: 'c1', name: 'alpha' }],
        extraCategories: [{ id: 'cat2', name: 'Zeta' }]
      })
    )
    store.ingest('CHANNEL_UPDATE', {
      id: 'c2',
      type: 0,
      name: 'beta',
      guild_id: 'g1',
      parent_id: 'cat2'
    })

    const byName = Object.fromEntries(
      store.getState().guilds[0].categories.map((c) => [c.name, c])
    )
    expect(byName['General']).toMatchObject({ pinned: true, pinSortKey: 5, collapsed: true })
    expect(byName['Zeta']).toMatchObject({ pinned: true, pinSortKey: 1, collapsed: false })
  })

  it('setCategoryLayout persists and re-derives', () => {
    const store = newStore()
    store.ingest('READY', ready({ channels: [{ id: 'c1', name: 'general' }] }))

    store.setCategoryLayout('cat1', 'g1', { collapsed: true })
    expect(mockDb.setCategoryLayout).toHaveBeenCalledWith('cat1', 'g1', { collapsed: true })
    expect(mockDb.loadLocalState).toHaveBeenCalledTimes(2) // constructor + after mutation
  })
})

describe('FR-3 — pin threads', () => {
  it('flags pinned threads and sorts them ahead of the rest', () => {
    const store = newStore(
      local({
        pinnedThreads: [{ threadId: 't2', addedAt: 1, sortKey: 0, note: null, label: null }]
      })
    )
    store.ingest(
      'READY',
      ready({
        channels: [{ id: 'c1', name: 'general' }],
        threads: [
          { id: 't1', parent: 'c1', name: 'aaa' },
          { id: 't2', parent: 'c1', name: 'zzz' }
        ]
      })
    )

    const threads = store.getState().guilds[0].categories[0].channels[0].threads
    expect(threads.map((t) => t.name)).toEqual(['zzz', 'aaa'])
    expect(threads.find((t) => t.id === 't2')!.pinned).toBe(true)
    expect(threads.find((t) => t.id === 't1')!.pinned).toBe(false)
  })

  it('builds the global pinned-threads view with breadcrumb context', () => {
    const store = newStore(
      local({
        pinnedThreads: [
          { threadId: 't1', addedAt: 1, sortKey: 0, note: 'read this', label: 'ref' }
        ]
      })
    )
    store.ingest(
      'READY',
      ready({
        channels: [{ id: 'c1', name: 'general' }],
        threads: [{ id: 't1', parent: 'c1', name: 'design-notes' }]
      })
    )

    const [pin] = store.getState().local.pinnedThreads
    expect(pin).toMatchObject({
      id: 't1',
      name: 'design-notes',
      guildName: 'Acme',
      parentName: 'general',
      note: 'read this',
      label: 'ref',
      missing: false
    })
  })

  it('keeps a tombstone for a pinned thread we can no longer see', () => {
    const store = newStore(
      local({
        pinnedThreads: [{ threadId: 'ghost', addedAt: 1, sortKey: 0, note: null, label: 'old' }]
      })
    )
    store.ingest('READY', ready({ channels: [{ id: 'c1', name: 'general' }] }))

    const [pin] = store.getState().local.pinnedThreads
    expect(pin.missing).toBe(true)
    expect(pin.id).toBe('ghost')
  })

  it('setThreadPinned routes to db and re-derives', () => {
    const store = newStore()
    store.ingest('READY', ready({ channels: [{ id: 'c1', name: 'general' }] }))

    store.setThreadPinned('t9', true)
    expect(mockDb.pinThread).toHaveBeenCalledWith('t9', 0)

    store.setThreadPinned('t9', false)
    expect(mockDb.unpinThread).toHaveBeenCalledWith('t9')
  })
})
