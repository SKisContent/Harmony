// Shared UnifiedState fixtures for renderer tests.
import type { ChannelRow, CategoryGroup, ThreadRow, UnifiedState } from '@shared/types'

export function thread(over: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id: 't1',
    parentId: 'c1',
    name: 'design-notes',
    archived: false,
    messageCount: 12,
    unread: false,
    mentionCount: 0,
    pinned: false,
    ...over
  }
}

export function channel(over: Partial<ChannelRow> = {}): ChannelRow {
  return {
    id: 'c1',
    guildId: 'g1',
    name: 'general',
    type: 0,
    parentId: 'cat1',
    position: 0,
    unread: false,
    mentionCount: 0,
    muted: false,
    pinned: false,
    pinSortKey: 0,
    notifyLevel: 3,
    threads: [],
    ...over
  }
}

export function category(over: Partial<CategoryGroup> = {}): CategoryGroup {
  return {
    id: 'cat1',
    name: 'General',
    position: 0,
    recentActivity: '0',
    channels: [],
    pinned: false,
    pinSortKey: 0,
    collapsed: false,
    hidden: false,
    ...over
  }
}

export function makeState(over: Partial<UnifiedState> = {}): UnifiedState {
  return {
    status: 'ready',
    self: { id: 'me', username: 'me', globalName: 'Me' },
    syncedAt: Date.now(),
    counts: { guilds: 1, channels: 2, unread: 0, mentions: 0 },
    dms: [],
    guilds: [
      {
        id: 'g1',
        name: 'Acme',
        iconUrl: null,
        position: 0,
        muted: false,
        notifyLevel: 0,
        categories: [
          category({
            id: 'cat1',
            name: 'General',
            channels: [
              channel({
                id: 'c1',
                name: 'general',
                parentId: 'cat1',
                threads: [
                  thread({ id: 't1', name: 'design-notes', pinned: false }),
                  thread({ id: 't2', name: 'standup', pinned: true })
                ]
              })
            ]
          }),
          category({
            id: 'cat2',
            name: 'Archive',
            hidden: true,
            channels: [channel({ id: 'c2', name: 'old-stuff', parentId: 'cat2', muted: true })]
          })
        ]
      }
    ],
    local: {
      hideEmptyCategories: true,
      emptyMode: 'no-visible',
      bookmarks: [],
      pinnedChannels: [],
      pinnedThreads: [
        {
          id: 't2',
          name: 'standup',
          guildId: 'g1',
          guildName: 'Acme',
          parentId: 'c1',
          parentName: 'general',
          archived: false,
          unread: true,
          mentionCount: 0,
          messageCount: 4,
          note: 'daily',
          label: null,
          sortKey: 0,
          missing: false
        },
        {
          id: 'gone',
          name: 'Removed thread',
          guildId: '',
          guildName: '',
          parentId: '',
          parentName: '',
          archived: false,
          unread: false,
          mentionCount: 0,
          messageCount: 0,
          note: null,
          label: null,
          sortKey: 1,
          missing: true
        }
      ]
    },
    ...over
  }
}
