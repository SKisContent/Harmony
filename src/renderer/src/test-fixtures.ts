// Shared UnifiedState fixtures for renderer tests.
import type { CategoryGroup, ThreadRow, UnifiedState } from '@shared/types'

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
        categories: [
          category({
            id: 'cat1',
            name: 'General',
            channels: [
              {
                id: 'c1',
                guildId: 'g1',
                name: 'general',
                type: 0,
                parentId: 'cat1',
                position: 0,
                unread: false,
                mentionCount: 0,
                muted: false,
                threads: [
                  thread({ id: 't1', name: 'design-notes', pinned: false }),
                  thread({ id: 't2', name: 'standup', pinned: true })
                ]
              }
            ]
          }),
          category({
            id: 'cat2',
            name: 'Archive',
            hidden: true,
            channels: [
              {
                id: 'c2',
                guildId: 'g1',
                name: 'old-stuff',
                type: 0,
                parentId: 'cat2',
                position: 0,
                unread: false,
                mentionCount: 0,
                muted: true,
                threads: []
              }
            ]
          })
        ]
      }
    ],
    local: {
      hideEmptyCategories: true,
      emptyMode: 'no-visible',
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
