import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SearchResult } from '@shared/types'
import { SearchPane } from './SearchPane'

function result(over: Partial<SearchResult> = {}): SearchResult {
  return {
    id: 'm1',
    authorId: 'u2',
    authorName: 'Bob',
    content: 'ship the release notes',
    timestamp: '2026-02-01T12:00:00.000Z',
    editedTimestamp: null,
    attachments: [],
    embedCount: 0,
    replyTo: null,
    system: false,
    mentions: [],
    reactions: [],
    channelId: 'c1',
    guildId: 'g1',
    guildName: 'Acme',
    channelName: 'general',
    threadName: null,
    isDm: false,
    unread: false,
    resolved: false,
    starred: false,
    snoozeUntil: null,
    ...over
  }
}

function mount(mode: 'search' | 'mentions', results: SearchResult[] = []) {
  const search = vi.fn().mockResolvedValue({ ok: true, results, indexed: results.length })
  const setMessageTriage = vi.fn().mockResolvedValue(undefined)
  const backfillMentions = vi.fn().mockResolvedValue({ ok: true, indexed: 0 })
  ;(window as unknown as { harmony: unknown }).harmony = {
    search,
    setMessageTriage,
    backfillMentions,
    onBackfill: () => () => {}
  }
  const onOpen = vi.fn()
  render(
    <SearchPane
      mode={mode}
      guilds={[{ id: 'g1', name: 'Acme' }]}
      channelNames={new Map()}
      selection={null}
      onOpen={onOpen}
    />
  )
  return { search, setMessageTriage, backfillMentions, onOpen }
}

afterEach(() => vi.restoreAllMocks())

describe('SearchPane', () => {
  it('debounces a query and calls search with the scope options', async () => {
    const user = userEvent.setup()
    const { search } = mount('search', [result()])
    await user.type(screen.getByRole('textbox'), 'release')
    // the component also fires a debounced search on mount (with an empty query);
    // wait for the specific post-typing call rather than for any content to appear,
    // since the mock resolves the same canned result regardless of the query.
    await vi.waitFor(() => expect(search.mock.calls.at(-1)?.[0]).toBe('release'))
    const [q, opts] = search.mock.calls.at(-1) as [string, { scope: string; mentionsOnly: boolean }]
    expect(q).toBe('release')
    expect(opts).toMatchObject({ scope: 'all', mentionsOnly: false })
    expect(await screen.findByText(/ship the release notes/)).toBeInTheDocument()
  })

  it('mentions mode sends mentionsOnly and hides resolved by default', async () => {
    const { search } = mount('mentions', [])
    await vi.waitFor(() => expect(search).toHaveBeenCalled())
    const [q, opts] = search.mock.calls.at(-1) as [string, { mentionsOnly: boolean }]
    expect(opts.mentionsOnly).toBe(true)
    expect(q).toContain('-is:resolved')
  })

  it('renders a result breadcrumb and jumps to context on click', async () => {
    const user = userEvent.setup()
    const { onOpen } = mount('search', [result({ threadName: 'launch' })])
    const row = (await screen.findByText(/ship the release notes/)).closest('.search-row')!
    expect(within(row as HTMLElement).getByText(/Acme › general › 〰️ launch/)).toBeInTheDocument()
    await user.click(row as HTMLElement)
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'c1', channelName: 'launch', isThread: true })
    )
  })

  it('kicks off a mentions backfill from the Sync button', async () => {
    const user = userEvent.setup()
    const { backfillMentions } = mount('mentions', [])
    await user.click(screen.getByRole('button', { name: /Sync mentions/ }))
    expect(backfillMentions).toHaveBeenCalled()
  })

  it('stars and resolves a mention', async () => {
    const user = userEvent.setup()
    const { setMessageTriage } = mount('mentions', [result()])
    const row = (await screen.findByText(/ship the release notes/)).closest('.search-row')!
    await user.click(within(row as HTMLElement).getByTitle('Star'))
    expect(setMessageTriage).toHaveBeenCalledWith('m1', { starred: true })
    await user.click(within(row as HTMLElement).getByTitle('Mark resolved'))
    expect(setMessageTriage).toHaveBeenCalledWith('m1', { resolved: true })
  })
})
