import { type ReactElement, useMemo, useState } from 'react'
import type { SavedMessage } from '@shared/types'
import type { Selection } from './App'
import { type MdContext, renderContent } from './markdown'

function timeLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}
function savedLabel(ms: number): string {
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString([], { dateStyle: 'medium' })
}

export function SavedPane({
  bookmarks,
  channelNames,
  selection,
  onOpen
}: {
  bookmarks: SavedMessage[]
  channelNames: Map<string, string>
  selection: Selection | null
  onOpen: (sel: Selection) => void
}): ReactElement {
  const [labelFilter, setLabelFilter] = useState('')
  const [groupBy, setGroupBy] = useState<'none' | 'label' | 'server'>('none')
  const [editing, setEditing] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [labelDraft, setLabelDraft] = useState('')

  const labels = useMemo(
    () => [...new Set(bookmarks.map((b) => b.label).filter((l): l is string => !!l))].sort(),
    [bookmarks]
  )

  const visible = labelFilter
    ? bookmarks.filter((b) => (labelFilter === '__none__' ? !b.label : b.label === labelFilter))
    : bookmarks

  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: '', items: visible }]
    const map = new Map<string, SavedMessage[]>()
    for (const b of visible) {
      const key = groupBy === 'label' ? b.label || 'No label' : b.guildName || (b.isDm ? 'Direct Messages' : 'Unknown')
      ;(map.get(key) ?? map.set(key, []).get(key)!).push(b)
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, items]) => ({ key, items }))
  }, [visible, groupBy])

  const jump = (b: SavedMessage): void => {
    if (b.deletedUpstream) return
    onOpen({
      guildId: b.guildId,
      guildName: b.guildName || (b.isDm ? 'Direct Messages' : ''),
      channelId: b.channelId,
      channelName: b.threadName ?? b.channelName,
      isThread: !!b.threadName,
      isDm: b.isDm
    })
  }

  const startEdit = (b: SavedMessage): void => {
    setEditing(b.id)
    setNoteDraft(b.note ?? '')
    setLabelDraft(b.label ?? '')
  }
  const saveEdit = (id: string): void => {
    void window.harmony.updateBookmark(id, {
      note: noteDraft.trim() || null,
      label: labelDraft.trim() || null
    })
    setEditing(null)
  }

  const mdCtx: MdContext = { mentions: new Map(), channels: channelNames }

  return (
    <div className="search-pane">
      <div className="search-head">
        <div className="search-filters">
          <label>
            Label
            <select value={labelFilter} onChange={(e) => setLabelFilter(e.target.value)}>
              <option value="">All labels</option>
              <option value="__none__">No label</option>
              {labels.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label>
            Group by
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}>
              <option value="none">Nothing</option>
              <option value="label">Label</option>
              <option value="server">Server</option>
            </select>
          </label>
          <span className="dim">{bookmarks.length} saved</span>
        </div>
      </div>

      <div className="search-results">
        {bookmarks.length === 0 && (
          <div className="pane-note dim">
            Nothing saved. Hover a message and hit 🔖 (or press <kbd>s</kbd>) to save it here.
          </div>
        )}
        {groups.map((grp) => (
          <div key={grp.key || '_'}>
            {grp.key && <div className="ts-label">{grp.key}</div>}
            {grp.items.map((b) => (
              <div
                key={b.id}
                className={
                  'search-row saved-row' +
                  (b.deletedUpstream ? ' is-gone' : '') +
                  (selection?.channelId === b.channelId ? ' is-active' : '')
                }
                onClick={() => jump(b)}
              >
                <div className="sr-crumb">
                  {b.isDm ? 'DM' : b.guildName} › {b.channelName}
                  {b.threadName ? ` › 〰️ ${b.threadName}` : ''}
                </div>
                <div className="sr-meta">
                  <span className="sr-author">{b.authorName}</span>
                  <span className="sr-time">{timeLabel(b.timestamp)}</span>
                  <span className="sr-flag">saved {savedLabel(b.savedAt)}</span>
                  {b.editedSince && !b.deletedUpstream && (
                    <span className="sr-flag warn">edited since you saved</span>
                  )}
                  {b.deletedUpstream && <span className="sr-flag warn">deleted from Discord</span>}
                </div>
                {b.content && <div className="sr-body">{renderContent(b.content, mdCtx)}</div>}
                {b.attachments.length > 0 && (
                  <div className="sr-body dim">📎 {b.attachments.map((a) => a.name).join(', ')}</div>
                )}
                {b.label && !editing && <span className="saved-label">{b.label}</span>}
                {b.note && editing !== b.id && <div className="pin-note">{b.note}</div>}

                {editing === b.id ? (
                  <div className="saved-edit" onClick={(e) => e.stopPropagation()}>
                    <input
                      placeholder="Label"
                      value={labelDraft}
                      onChange={(e) => setLabelDraft(e.target.value)}
                    />
                    <input
                      placeholder="Note"
                      value={noteDraft}
                      onChange={(e) => setNoteDraft(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && saveEdit(b.id)}
                    />
                    <button onClick={() => saveEdit(b.id)}>Save</button>
                    <button className="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="sr-actions">
                    {!b.deletedUpstream && (
                      <button
                        title="Jump to message"
                        onClick={(e) => {
                          e.stopPropagation()
                          jump(b)
                        }}
                      >
                        ↪ jump
                      </button>
                    )}
                    {b.editedSince && !b.deletedUpstream && (
                      <button
                        title="Update the saved copy to the latest version"
                        onClick={(e) => {
                          e.stopPropagation()
                          void window.harmony.refreshBookmark(b.id)
                        }}
                      >
                        ⟳ refresh
                      </button>
                    )}
                    <button
                      title="Edit note / label"
                      onClick={(e) => {
                        e.stopPropagation()
                        startEdit(b)
                      }}
                    >
                      ✎ note
                    </button>
                    <button
                      title="Remove from Saved"
                      onClick={(e) => {
                        e.stopPropagation()
                        void window.harmony.removeBookmark(b.id)
                      }}
                    >
                      🔖 unsave
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
