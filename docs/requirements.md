# Harmony — Feature Requirements (Draft v0.1)

> An alternative Discord client focused on **navigability, completeness, and
> retrieval**: see everything, find anything, lose nothing.

Status: **DRAFT — core architecture decided (§3.0); pending §9 answers.**
Author: sushil@a-sk.com · Date: 2026-09-03

### Decisions locked (2026-09-03)

| # | Decision |
|---|---|
| **Data access** | **Option A** — standalone app, authenticates with the user's own Discord account token, calls the private client HTTP API + Gateway. Local SQLite index. Optional per-guild bot tokens may be added later where the user is an admin. |
| **Client scope** | **Full replacement client.** Compose, edit, delete, react, create threads, attachments, notifications — everything except voice/video/stage (still out for v1, §8). XR-4 is now **P0**. |
| **Write-back** | **Full write-back** to Discord-side state (send, ack/read, mute, thread join/leave/unarchive, etc.). Harmony-local-only state remains: thread pins, category pins/order/collapse, hidden-category rules, mention triage. |
| **Stack** | **Electron + React + TypeScript.** Main process hosts the sync engine (Gateway `ws`, HTTP client) + `better-sqlite3` store/index; renderer is React. Keeps the door open to later embedding the real Discord web app in a `BrowserView` for voice. |
| **Backfill depth** | **Recent window, default ~12–24 months**, older results fetched lazily on scroll-back / date-range search. Setting to expand to full backfill later. (§9 Q6 resolved.) |
| **DMs in channel list** | **Yes** — a dedicated "Direct Messages" section pinned at the top of the unified list (above guild groups), same unread/mention/filter treatment as channels. (§9 Q4 resolved.) |
| **Device sync** | **Local-only for v1.** Harmony-local tables use stable, portable IDs and a monotonic `updated_at` so a sync layer can be added later with no schema migration. (§9 Q8 resolved.) |
| **Multi-account** | **One account live at a time**, credentials stored for several, fast switch re-syncs. Single Gateway connection. (§9 Q15 resolved.) |
| Still open | §9 Q1 (main vs secondary account), Q3, Q5, Q7, Q10–Q14, Q17, Q18. |

---

## 1. Problem statement

The official Discord client optimises for *real-time presence in one channel at a
time*. It actively hides information to reduce clutter:

- Only one server's channel list is visible at once.
- The channel list hides channels you haven't opened recently or that are muted.
- Threads are surfaced only when "active"; older threads are effectively invisible
  without hunting through per-channel archive popovers.
- There is no cross-server view of anything — not channels, not threads, not
  mentions, not your own history.
- Search is per-server, modal, and forgets your last query.
- Categories can't be reordered freely or pinned; empty categories still take space.

Harmony inverts these defaults. The organising principles:

1. **Everything is visible by default; the user filters *down*, not *up*.**
2. **Retrieval is first-class**: "messages that mention me" and "messages I wrote"
   are permanent, searchable views — not a search you have to reconstruct.
3. **The user controls layout**: pin, reorder, collapse, hide — and it persists.
4. **Keyboard-first navigation** (Discord's clunkiness is largely mouse-dependence).

Non-goals for v1: replacing Discord's voice/video/stage/activities stack. See §8.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Guild** | Discord's internal name for a "server". |
| **Channel** | Text, announcement, forum, voice, or stage channel within a guild. |
| **Category** | A collapsible group of channels within a guild. |
| **Thread** | A sub-conversation hanging off a message in a text/forum channel. Can be *active* or *archived*; *public* or *private*. |
| **DM / Group DM** | Direct message conversation (1:1 or up to 10 people), not attached to a guild. |
| **Mention** | A message containing `@me`, a role I hold, `@everyone`/`@here`, or a reply to my message. |
| **Read state** | Per-channel/thread marker of the last message I've seen + mention count. |
| **Gateway** | Discord's real-time WebSocket feed of events (new messages, edits, presence…). |
| **Unified view** | Any Harmony view that merges data across multiple guilds. |

---

## 3. Architecture & data-access strategy

**This is the single most important open decision and it gates every feature
below.** Discord does not offer a supported API for "act as a human user and read
everything they can see". The realistic options:

### Option A — User-account API (a.k.a. "self-bot")
Harmony authenticates with the user's own Discord account token and calls the same
private HTTP API + Gateway the official web client uses.

- ✅ Full access to exactly what the user can see: all guilds, channels, threads,
  message history, the `/search` endpoint (with `mentions=`, `author_id=` filters),
  DMs, read states.
- ✅ Every feature in this document is achievable.
- ❌ **Violates Discord's Terms of Service** (automating a user account). Realistic
  risk of account suspension/termination, though third-party read-only clients
  historically attract low enforcement. Risk rises with aggressive polling.
- ⚠️ Mitigations: conservative rate limiting, mimic official client headers/behaviour,
  prefer Gateway events over polling, optionally use a secondary/burner account,
  never automate sending in bulk.

### Option B — Official Bot API
Register a bot application, invite it to each guild.

- ✅ Fully ToS-compliant.
- ❌ Only sees guilds it is invited to and channels it has permission in — you
  cannot invite a bot to guilds you don't administer.
- ❌ No access to the `/search` endpoint at all. "Mentions of me" / "my messages"
  would require Harmony to index every message via the Gateway from install time
  forward — no historical backfill.
- ❌ Cannot see your DMs. Cannot represent "you" — a bot is a separate identity.
- Verdict: **cannot deliver the requested feature set.** Viable only as an
  opt-in supplement for guilds you own.

### Option C — Client modification (BetterDiscord / Vencord / Replugged style)
Harmony ships as a patched Electron build (or injected bundle) that runs *inside*
the official client, reusing its authenticated session and in-memory Flux stores,
and rendering alternative UI over/around Discord's React tree.

- ✅ Reuses the official session — no separate token handling; lower detection risk
  than Option A in practice; large tolerated precedent.
- ✅ Can read everything already loaded in the client's stores, and call the
  client's own internal API modules for the rest (including `/search`).
- ➖ Still technically against ToS (client modification), but enforcement against
  the established modded-client ecosystem is effectively nil.
- ❌ Tightly coupled to Discord's ever-changing webpack internals; high maintenance.
- ❌ "Alternative UI shell" is fighting Discord's own DOM; a full re-skin is a lot
  of adverse-possession CSS/patching.

### Option D — Hybrid: standalone client (Option A transport) + optional bot (Option B) for owned guilds
Standalone Electron/Tauri app, user-token transport, with a local persistent index
(SQLite) built from Gateway events + backfilled via the HTTP API. Bot tokens can be
added per-guild later for a compliant path where the user is an admin.

**Recommended pending §9 answers.** Gives the full feature set, a clean custom UI,
offline/instant search via the local index, and a migration path toward compliance.

### Cross-cutting architectural components (assuming Option A/D)

| Component | Purpose |
|---|---|
| **Transport** | HTTP client (rate-limit aware, per-route buckets, 429 backoff) + Gateway WebSocket (resume/reconnect, compression, heartbeat). |
| **Local store** | SQLite (or similar): guilds, channels, categories, threads, messages, read states, users, roles, plus Harmony-local tables (pins, category order, hidden state, saved searches). |
| **Sync engine** | On launch: hydrate from `READY` + `READY_SUPPLEMENTAL`; reconcile local store; lazily backfill history/threads on demand and in the background within rate limits. |
| **Index** | Full-text search over locally-stored messages (SQLite FTS5 or Tantivy) so "search within my mentions / my messages" is instant and offline. Live `/search` used for gap-fill and for content not yet indexed. |
| **Renderer** | Message renderer: markdown, mentions, custom/animated emoji, embeds, link previews, attachments (image/video/audio/file), spoilers, code blocks, replies, stickers, poll blocks, system messages. |
| **UI shell** | Custom layout: unified sidebar, filter bar, list/detail panes, command palette, keyboard router. |
| **Auth** | Token obtained by embedding Discord's real login page in a webview and intercepting the `Authorization` header (Discord's own UI handles CAPTCHA/MFA/email-verify; no native credential form). See XR-7. |
| **Secrets** | Token stored in OS keychain (macOS Keychain via `keytar`/`safeStorage`); never plaintext on disk, never logged. `localStorage` is not a viable token source — Discord deletes it from `window` at runtime (confirmed 2026-09-03). |

---

## 4. Feature requirements

Each feature: **user story · rationale · behaviour · acceptance criteria · data
source · dependencies · open questions · risks.**

Priority key: **P0** = core to v1 · **P1** = v1 if cheap, else v1.1 · **P2** = later.

---

### FR-1 — Unified channel browser (P0)

**User story.** As a user in many servers, I want one list of *all* channels I have
access to, that I can either view merged across servers or filter to one server, so
I can navigate without server-hopping.

**Rationale.** Discord shows one guild's channels at a time and hides "inactive"
ones. Cross-server work (e.g. following the same topic in several communities)
means constant context switches.

**Behaviour.**
- A left sidebar lists channels. A **scope switch** at the top toggles:
  - **All servers** — every text/announcement/forum channel the user can read,
    across all guilds, grouped by guild (guild header rows, collapsible).
  - **Single server** — pick one guild; behaves like Discord's list but with
    Harmony's enhancements (FR-2, FR-6, FR-7).
  - *(Optional, pending §9)* **Flat mode** — no guild grouping, one sorted list.
- Every channel is shown regardless of recent-activity/"hidden" status. Channels
  the user genuinely lacks `VIEW_CHANNEL` permission for are omitted.
- **Filters** (composable, persisted): unread only · has mentions · not muted ·
  by channel type · by category · favourites only · text match on channel name.
- **Sort options**: guild default order · most-recent-activity · alphabetical ·
  unread first.
- Each row shows: name, guild (in All-servers mode), unread dot, mention badge,
  muted state, pinned/favourite marker, last-activity timestamp (optional).
- Muted channels/guilds: shown but de-emphasised; togglable via "not muted" filter.
- Selecting a channel opens it in the message pane (§7 rendering).
- Virtualised list — must stay smooth at 1000+ channels.

**Acceptance criteria.**
- [ ] With N guilds, "All servers" shows the union of readable text-capable
      channels, grouped by guild, with correct unread/mention state.
- [ ] Switching scope to a single guild is ≤1 interaction and ≤150 ms to render.
- [ ] Filters and sort persist across restarts and are per-scope.
- [ ] A channel muted in Discord appears muted here and vice-versa (or: read-only
      mirror — see open questions).
- [ ] Newly created/deleted channels appear/disappear live via Gateway.

**Data source.** `READY` payload (guilds, channels, read states); Gateway
`CHANNEL_CREATE/UPDATE/DELETE`, `GUILD_CREATE`. Permissions computed from roles +
overwrites.

**Dependencies.** Local store, sync engine, permission calculator.

**Open questions.** See §9 Q4 (DMs in this list?), Q5 (flat mode?), Q9 (write
actions like mute from Harmony?).

**Risks.** Permission calculation is fiddly (role hierarchy, category-inherited
overwrites, `@everyone` base). Large accounts (100+ guilds) stress initial hydrate.

---

### FR-2 — Complete thread enumeration (P0)

**User story.** As a user, I want to see *all* threads in a channel — active and
archived, however old — not just the handful Discord considers "active", so I can
find and follow ongoing sub-conversations.

**Rationale.** Discord's thread list shows active threads plus a shallow, awkward
archived-thread popover. Threads that matter (design discussions, support cases)
vanish from view days later.

**Behaviour.**
- Each channel has a **Threads panel** listing:
  - Active threads.
  - Archived public threads (paginated backfill to completion, cached).
  - Archived private threads the user has access to / has joined.
  - For **forum channels**: all posts (which are threads) with their tags.
- Per-thread row: title, parent channel, author/creator, message count, last
  activity, participants (avatars), archived/locked state, unread/mention badge,
  joined state, **pin marker** (FR-3), tags (forum).
- Thread list has its own filters: unread · mentions · joined only · not archived ·
  by tag (forum) · title text match · created-by-me · participated-in-by-me.
- Thread sort: last activity · created date · message count · alphabetical.
- A **global "All threads" view** (unified, cross-channel and optionally
  cross-guild), same filters/sort — mirrors FR-1's scope switch.
- Selecting a thread opens its messages in the detail pane; parent-channel context
  reachable in one click.
- Background job keeps archived-thread caches fresh within rate limits; manual
  "refresh threads" per channel.

**Acceptance criteria.**
- [ ] For a channel with X total threads (active + archived), Harmony eventually
      lists all X, with pagination handled transparently.
- [ ] Forum channels list every post as a thread with tags shown and filterable.
- [ ] "All threads" unified view aggregates across all readable channels.
- [ ] New threads and thread archival/unarchival reflect live via Gateway.
- [ ] Thread filters/sort persist per scope.

**Data source.** *(revised per §11.3 live findings — `/guilds/{id}/threads/active`
is `403` for user tokens.)*
- **Active threads: Gateway only.** `READY_SUPPLEMENTAL.guilds[].threads` at
  connect, `THREAD_LIST_SYNC` on channel focus, then
  `THREAD_CREATE/UPDATE/DELETE`, `THREAD_MEMBERS_UPDATE`.
- **Archived + name/tag filter: `GET /channels/{id}/threads/search`**
  `?archived=true&sort_by=last_message_time&sort_order=desc&limit=25&offset=N`
  `&name=<substr>&tag_setting=match_some` → `{threads,members,has_more,
  total_results}`; loop `offset` until `has_more=false`. `total_results` drives a
  determinate progress indicator.
- Legacy cross-check: `GET /channels/{id}/threads/archived/public?before=&limit=100`.
- Archived private (joined): `?archived=true` on `threads/search` includes joined
  private threads; `GET /channels/{id}/users/@me/threads/archived/private` as backup.
- Forum: `threads/search` on the forum channel; parent `available_tags` + thread
  `applied_tags`.

**Dependencies.** Local store (threads table with parent linkage), rate-limited
backfill queue, FR-1 scope infra.

**Open questions.** §9 Q6 (how aggressively to backfill on first open vs lazy),
Q7 (retention: keep full thread history locally forever?).

**Risks.** Very large channels (years of archived threads) → many paginated
requests; must be background, resumable, and rate-limit-polite. Private threads
not joined are invisible by design.

---

### FR-3 — Pin threads (P0)

**User story.** As a user, I want to pin specific threads so they stay at the top
of the thread list (and optionally in a dedicated "Pinned threads" view),
regardless of activity.

**Rationale.** Long-running threads I care about keep sinking. Discord has no
user-level thread pinning (channel-message "pins" are a different, per-channel,
shared concept).

**Behaviour.**
- Pin/unpin from a thread row context menu, the thread header, and the command
  palette.
- Pinned threads sort above unpinned in every thread list (with a visible divider),
  preserving secondary sort within each group.
- A dedicated **Pinned threads** view (in the unified nav) lists all pins across
  channels/guilds, manually reorderable (drag or keyboard move).
- Pins are **Harmony-local** (not visible to other Discord users), stored locally.
- Pins survive thread archival; a pinned archived thread is clearly marked and
  still opens read-only (or offers "unarchive" if permitted — see Q9).
- Optional: pin with a **note** and/or **colour/label** for the user's own reference.
- Optional: **auto-unpin** when a thread is deleted upstream (with a tombstone in
  the pinned view rather than silent removal).

**Acceptance criteria.**
- [ ] Pinning a thread moves it to the pinned group in all relevant lists within
      one frame and persists across restarts.
- [ ] "Pinned threads" view shows every pin with parent channel + guild context
      and supports manual reordering that persists.
- [ ] Deleting/losing access to a pinned thread yields a tombstone, not a crash.

**Data source.** Harmony-local `pinned_threads(thread_id, added_at, sort_key,
note, label)`. Thread metadata from FR-2 store.

**Dependencies.** FR-2.

**Open questions.** §9 Q8 (sync pins across the user's devices, or local-only?),
Q2 (notes/labels in v1 or later?).

**Risks.** Low. Main one is cross-device sync scope (Q8).

---

### FR-4 — Mention inbox + search-within (P0)

**User story.** As a user, I want a single always-available list of every message
that directly tags me — across all servers and DMs — and I want to full-text
search *within that set* without leaving the view.

**Rationale.** Discord's "Inbox → Mentions" is capped, recency-limited, per-guild
filtered, non-searchable, and easy to accidentally clear. Mentions are how work
reaches you; they deserve a permanent, queryable home.

**Behaviour.**
- A top-level **Mentions** view. Contents:
  - **Default set: direct `@`-mentions of me only.** (§9 Q3 resolved — the user
    wants a tight inbox of things aimed squarely at them.)
  - Toggles, all **off by default**, each surfaced as its own filter chip / tab:
    include role mentions · include `@everyone`/`@here` · include replies to my
    messages (Discord reply without an explicit ping).
- Scope switch: **All** · per-guild · **DMs only** · exclude muted channels (toggle).
- Each result row: author (avatar + name), guild ›  channel › thread breadcrumb,
  timestamp, rendered message preview, jump-to-context button, read/unread,
  reactions, "resolved/archived by me" flag (Harmony-local triage state).
- **Search within**: a search box filters the current mention set by
  - free text (FTS over content),
  - author, guild, channel, thread,
  - date range,
  - has: link / attachment / image / embed,
  - is: unread / unresolved.
- Sort: newest · oldest · by guild · by author.
- **Triage actions** (Harmony-local): mark resolved, snooze until <date>, star.
  Resolved items hide by default, recoverable via filter.
- **Data pipeline.**
  - *Backfill:* on first run, query `/search?mentions={me}` per guild + DM search
    to seed the index; store results locally.
  - *Live:* Gateway `MESSAGE_CREATE` where the payload's `mentions` includes me
    (or `mention_roles` ∩ my roles, or `mention_everyone`, or `referenced_message.author == me`)
    → append to index immediately.
  - *Gap-fill:* periodic reconciliation query to catch anything missed while offline.
- Everything after backfill is served from the **local index** → instant, offline,
  and searchable regardless of Discord's search limitations.

**Acceptance criteria.**
- [ ] Opening Mentions shows a unified, reverse-chronological list across all
      guilds + DMs, with correct breadcrumbs and jump-to-context.
- [ ] A message that mentions me appears in the view within ~2 s of being posted
      while Harmony is running.
- [ ] Search-within returns results purely from the local index (verified offline)
      and supports text + author + channel + date + has:/is: filters.
- [ ] Toggling role-mentions / @everyone / replies changes the set correctly.
- [ ] Triage state (resolved/snooze/star) persists and is filterable.
- [ ] Backfill completes within rate limits without user-visible errors and is
      resumable if interrupted.

**Data source.** `GET /guilds/{id}/messages/search?mentions={me}` (+ `author_id`,
`channel_id`, `has`, `min_id`/`max_id` for date, pagination via `offset`);
DM/group-DM search endpoint; Gateway `MESSAGE_CREATE`. Local FTS index.

**Dependencies.** Local store + index, sync engine, role/permission data,
renderer, jump-to-context navigation.

**Open questions.** §9 Q6 (backfill depth — all history, or last 12 months?),
Q3 (default: include role mentions? @everyone?), Q10 (retention/pruning of index).

**Risks.** `/search` is rate-limited and eventually-consistent (Discord indexes
asynchronously; very recent messages may not appear in `/search` for seconds;
`doing_deep_historical_index:true` / HTTP `202` means the guild index is still
building — retry, don't treat as empty). **`offset` is capped at 9975** (§11.4) →
for any guild/filter with >9975 matches, backfill must **walk backwards in date
windows** (`max_id` = oldest `hit` id from the previous sweep) rather than just
incrementing `offset`. Per-guild iteration is slow for large accounts → must be
background + cached. Role-mention resolution needs current role membership per
guild.

---

### FR-5 — "My messages" view + search-within (P0)

**User story.** As a user, I want one click to see every message *I've* posted —
across all servers, channels, threads, and DMs — and to full-text search within my
own history.

**Rationale.** "What did I say about X, and where?" is currently near-impossible in
Discord: search is per-guild, `author_id` self-filter is hidden behind operators,
and there's no unified personal archive.

**Behaviour.**
- A top-level **My Messages** view. One click → reverse-chronological list of all
  messages authored by me.
- Scope switch: **All** · per-guild · **DMs only** · by channel/thread.
- Row: destination breadcrumb (guild › channel › thread), timestamp, rendered
  content, edited indicator, reaction summary, reply count, jump-to-context.
- **Search within** (same engine as FR-4): free text · guild · channel · thread ·
  date range · has: link/attachment/image/code · in-thread vs top-level ·
  got-replies / got-reactions.
- Sort: newest · oldest · most-reacted · most-replied · by guild.
- **Aggregates panel** (optional, P1): counts per guild/channel, activity heatmap
  by date/hour, most-used channels — a lightweight "your Discord footprint".
- Bulk actions (P2, guarded): export selection (JSON/Markdown), or bulk-delete my
  own messages in a channel (destructive → explicit multi-step confirm, rate-limited).
- Same **backfill + live + gap-fill** pipeline as FR-4, keyed on `author_id = me`.

**Acceptance criteria.**
- [ ] One interaction from anywhere opens My Messages, unified across guilds + DMs.
- [ ] A message I send appears in the view within ~2 s (from local echo / Gateway).
- [ ] Search-within works offline from the local index with the full filter set.
- [ ] Breadcrumbs + jump-to-context resolve correctly, including into threads.
- [ ] Backfill is background, resumable, rate-limit-safe.
- [ ] (If included) export produces valid JSON/Markdown of the selected messages.

**Data source.** `GET /guilds/{id}/messages/search?author_id={me}&sort_by=timestamp
&sort_order=desc&offset=N` (response `{messages:[[…]],threads,members,total_results,
doing_deep_historical_index}`, match = `hit:true` in each context group); DM search
via `GET /channels/{id}/messages/search`; Gateway `MESSAGE_CREATE` (own) +
`MESSAGE_UPDATE`/`DELETE` to keep the archive accurate. Local FTS index. Same
`offset ≤ 9975` ceiling + date-window backfill as FR-4 (§11.4).

**Dependencies.** Same as FR-4.

**Open questions.** §9 Q6 (backfill depth), Q11 (include the aggregates panel in
v1?), Q12 (allow destructive bulk-delete at all?).

**Risks.** Same `/search` rate-limit + eventual-consistency caveats as FR-4.
Bulk-delete is dangerous and abuse-adjacent — likely P2 behind heavy guards or cut.

---

### FR-6 — Hide empty categories (P0)

**User story.** As a user, I want categories with nothing worth showing to
collapse out of the way automatically, so the sidebar isn't padded with dead space.

**Rationale.** Muted/archived community sections leave empty category headers that
waste vertical space and add scrolling.

**Behaviour.**
- Setting: **Hide empty categories** (on by default). **Default definition of
  "empty": the category contains zero channels the user has permission to view**
  (§9 Q13 resolved — conservative; a quiet-but-readable channel keeps its category).
  Optional stricter modes, opt-in: *no channels with unread*, or *no channels
  active in the last N days*.
- Hidden categories are collapsed to nothing (not just collapsed headers). A small
  "N hidden categories" affordance at the bottom of the guild reveals them on click.
- Interacts with filters (FR-1): when a filter (e.g. "unread only") empties a
  category, it hides too, live.
- Per-guild override: force-show or force-hide a specific category regardless of
  the global rule.
- Never hides a category the user has **pinned** (FR-7) or explicitly force-shown.

**Acceptance criteria.**
- [ ] With the setting on, categories meeting the "empty" definition render zero
      height and are absent from tab-order.
- [ ] Changing the "empty" definition re-evaluates all categories live.
- [ ] Applying an "unread only" filter hides now-empty categories and restores
      them when the filter clears.
- [ ] Pinned / force-shown categories are never auto-hidden.
- [ ] "N hidden categories" reveal works and persists its expanded/collapsed state.

**Data source.** Local: channel/category tree + read states + activity timestamps.
No Discord API writes.

**Dependencies.** FR-1, FR-7.

**Open questions.** §9 Q13 (default definition of "empty": no-visible-channels vs
no-unread).

**Risks.** Low. Edge case: a category that's empty now but gets a new channel —
must appear immediately.

---

### FR-7 — Pin / reorder categories (P0)

**User story.** As a user, I want to pin categories to the top of a guild's list
(and reorder them freely), so the sections I use are always in reach.

**Rationale.** Discord category order is set by server admins; a member can't
promote the two categories they actually use.

**Behaviour.**
- Pin/unpin a category from its header context menu or the command palette.
- Pinned categories float to the top of that guild's list, above unpinned, in a
  user-defined order (drag or keyboard move: `Alt+↑/↓`).
- Unpinned categories retain the guild's server-defined order (or the user's
  chosen sort from FR-1).
- Optional: **pin across scope** — in "All servers" mode, a pinned category can be
  promoted within its guild group; a separate "Pinned categories" section at the
  very top of the unified sidebar is an optional stretch.
- A pinned category is exempt from FR-6 auto-hide.
- Collapsed/expanded state per category persists (independent of pinning).
- All category layout state is **Harmony-local**.

**Acceptance criteria.**
- [ ] Pinning a category moves it above unpinned categories in that guild and
      persists across restarts.
- [ ] Manual reordering of pinned categories persists and is keyboard-accessible.
- [ ] Pinned categories are never auto-hidden by FR-6.
- [ ] Collapse state persists per category, per scope.

**Data source.** Harmony-local `category_layout(category_id, pinned, sort_key,
collapsed, force_visibility)`.

**Dependencies.** FR-1, FR-6.

**Open questions.** §9 Q8 (device sync of layout), Q14 (unified "Pinned
categories" super-section in v1 or later?).

**Risks.** Low.

---

### FR-8 — Bookmark / save messages (P1)

**User story.** As a user, I want to save any individual message to a personal
"Saved" list with one click, so I can find it again later without remembering
which channel it was in.

**Rationale.** Discord has no bookmarking. The community workaround is forwarding a
message to yourself in a DM, which is clumsy and loses context. Explicitly
requested by the user (§9 Q18, 2026-09-03).

**Behaviour.**
- Save / unsave a message from: the message hover toolbar, its right-click menu,
  the command palette, and a keyboard shortcut (e.g. `s` on the focused message).
- A top-level **Saved** view in the rail, alongside Mentions / My Messages.
- Each saved item shows: author (avatar + name), breadcrumb (server › channel ›
  thread), original timestamp, **date saved**, rendered message content, and a
  one-click **jump to the message in context**.
- **Content is snapshotted at save time.** A bookmark keeps its own local copy of
  the message content + attachments list, so it survives the original being
  edited or deleted upstream. If the original later changes, show an "edited since
  you saved" marker with a way to refresh the snapshot; if deleted, keep the
  saved copy with a "deleted from Discord" tag rather than dropping it.
- **Organise:** optional per-bookmark **note** and **labels/folders**; the Saved
  view can filter by label and group by label or by server.
- **Search within** the saved set, using the same query box + operators as the
  Mentions / My Messages views (§XR-3).
- Sort: date saved · date posted · by server · by label.
- Attachments/images in a saved message remain viewable; if Discord's CDN link
  later expires, fall back to the snapshot's cached copy where one was stored
  (large media is link-only by default; setting to also cache the file locally).
- All bookmark data is **Harmony-local** (private, not visible to anyone on
  Discord), stored locally — device sync deferred with the other local state
  (§9.1 Q8).

**Acceptance criteria.**
- [ ] Saving a message adds it to the Saved view within one frame and persists
      across restarts.
- [ ] Each saved item resolves its breadcrumb and "jump to context" correctly,
      including messages inside threads and DMs.
- [ ] Deleting or editing the original message upstream does not lose the saved
      copy; the item is marked accordingly.
- [ ] Search-within the Saved set works offline from the local index with the
      full operator set.
- [ ] Labels/notes persist and the Saved view can filter and group by label.

**Data source.** Harmony-local
`bookmarks(message_id, channel_id, guild_id, thread_id, author_id, posted_at,
saved_at, note, labels, snapshot_json, snapshot_media_path, upstream_state)`.
Live message data from the local message store; renderer from XR-1.

**Dependencies.** Message store, XR-1 renderer, XR-3 index, jump-to-context nav,
XR-6 command palette / shortcuts.

**Open questions.** §9 Q8 (device sync), and: cache saved-message media files
locally by default, or link-only? (Proposed: link-only, with a per-bookmark
"keep a copy" action and a global setting.)

**Risks.** Low. Main design call is how much to snapshot (text only vs text +
media files) — covered above.

---

## 5. Cross-cutting requirements

### XR-1 — Message rendering (P0)
Full-fidelity renderer: markdown (incl. Discord extensions — `||spoilers||`,
`> quotes`, headings, lists, `~~strike~~`, masked links), fenced code with syntax
highlighting, user/role/channel mentions (resolved to names + colours), custom &
animated emoji, Unicode emoji, embeds (rich, article, image, video, link preview),
attachments (image lightbox, inline video/audio, file cards), stickers, replies
(with jump), reactions (add/remove, hover for who), polls, system messages
(joins, pins, boosts), forwarded messages, timestamps (`<t:...>`), edited/deleted
markers.

### XR-2 — Real-time sync (P0)
Single Gateway connection with proper `IDENTIFY`/`RESUME`, heartbeat, zlib-stream
compression, reconnect/backoff. **The Gateway is the *only* source for several
things REST won't give a user token** (§11.2–11.3): the guild/channel tree with
per-user **read state** (`READY.read_state`), **mute / notification overrides**
(`READY.user_guild_settings`), and **active threads**
(`READY_SUPPLEMENTAL.guilds[].threads`, `THREAD_LIST_SYNC` on channel focus).
Handle at minimum: `READY`, `READY_SUPPLEMENTAL`, `MESSAGE_CREATE/UPDATE/DELETE`,
`CHANNEL_*`, `THREAD_CREATE/UPDATE/DELETE`, `THREAD_LIST_SYNC`,
`THREAD_MEMBERS_UPDATE`, `THREAD_MEMBER_UPDATE`, `GUILD_CREATE/UPDATE/DELETE`,
`GUILD_MEMBER_UPDATE` (own roles, for role-mention resolution), `MESSAGE_ACK`
(read state), `USER_GUILD_SETTINGS_UPDATE`, `CHANNEL_UNREAD_UPDATE`,
`TYPING_START` (optional), `RELATIONSHIP_*`. Large accounts: expect
`READY` to be delivered in a gzipped multi-MB payload and/or require the
`GUILD_MEMBERS`/lazy-guild (`op 14`) subscription pattern for member data. Local
store is the source of truth for the UI; Gateway mutates it.

### XR-3 — Local search index (P0)
SQLite FTS5 over all locally-stored messages. Powers FR-4/FR-5 search-within and a
general cross-guild search. Incremental indexing on `MESSAGE_CREATE/UPDATE/DELETE`.

**Query language (§9 Q17 resolved): tokenised full-text + Discord-style
operators.** The one search box accepts:
- bare words (AND-combined), `"exact phrases"`, `OR`, leading `-` to exclude;
- operators: `from:@user` `in:#channel` `in:"Guild Name"` `thread:<name>`
  `has:link|image|file|video|embed|code` `before:YYYY-MM-DD` `after:YYYY-MM-DD`
  `during:YYYY-MM` `is:unread|resolved|edited` `mentions:@user`;
- a **regex toggle** on the box for power queries (stretch).
Same grammar in Mentions, My Messages, and global search — only the implicit
scope differs. Configurable retention (§9 Q10).

### XR-4 — Composing & interaction (P0 — full client, per §3.0)
Send messages (markdown, emoji/sticker/gif pickers, `@`/`#`/`:` autocomplete,
attachments w/ drag-drop + paste, spoiler toggle, replies, edit/delete own),
react (add/remove), create/join/leave/rename/archive/unarchive threads, start
forum posts, mark channels/threads read, mute/unmute channels & guilds, set
per-channel notification level, typing indicator, drafts persisted per channel.
Slash-command / button / modal surfaces from bots: **render + basic invoke**
(stretch: full component interaction). Voice/video/stage remain out (§8).

### XR-5 — Notifications (P1)
Native desktop notifications honouring per-channel/guild notification settings and
mute; click → jump to message. "Mentions only" global toggle. Quiet hours.

### XR-6 — Navigation & keyboard model (P0)
Command palette (`⌘K`): jump to any channel/thread/guild/view, run any action.
Global shortcuts for the top-level views (Mentions, My Messages, All Threads,
All Channels). Vim-ish list navigation (`j/k`, `Enter`, `g g`/`G`). Every action
reachable without the mouse. Back/forward history stack.

### XR-7 — Auth & accounts (P0)

**Login model: embed Discord's real login page; never build a native credential
form.** The Discord login flow is a reproducible sequence of HTTPS calls
(`POST /api/v9/auth/login` → `{token}` | `{mfa:true,ticket}` | `{captcha_*}` |
new-location challenge; then `POST /api/v9/auth/mfa/totp` with `{code,ticket}`),
but the parts Harmony cannot cleanly replicate are all designed to be answered by
a *rendered Discord UI*:

| Blocker | Why a scripted login can't clear it |
|---|---|
| **hCaptcha** | Since ~2023 `/auth/login` returns `captcha-required` for almost any client Discord doesn't recognise (new IP, datacenter IP, unfamiliar fingerprint, scripted-looking request). No API to solve it; only options are a paid captcha farm (unreliable, ToS-violating) or rendering the hCaptcha widget — i.e. a webview. |
| **Device fingerprinting** | Real client sends `X-Super-Properties` (base64 JSON: OS, browser, `client_build_number`, version…), matching User-Agent, `X-Discord-Locale`, `X-Fingerprint`, plus TLS/JA3 signals. Stale/mismatched values raise CAPTCHA rate and flag risk; `client_build_number` rotates every few days → permanent maintenance treadmill. |
| **New-location email verification** | First login from an unrecognised device/IP emails a "verify it's you" link; flow can't proceed until the user clicks it out-of-band. |
| **Raw password handling** | A native form puts the plaintext password through Harmony's own process. Embedding `discord.com/login` keeps the password on Discord's real TLS-served page only. |

**Chosen flow.**
1. First run (and re-auth): open `https://discord.com/login` in a dedicated
   Electron `BrowserView`/webview. Discord's own UI renders CAPTCHA, MFA, and
   email-verify — Harmony implements none of them.
2. On success, capture the account token by **intercepting the `Authorization`
   header on the first authenticated XHR** from that webview. (`localStorage` is
   not readable — Discord deletes it from `window` at runtime as an
   anti-token-theft measure; confirmed in live testing 2026-09-03.) Fallback:
   read it from the webview partition's LevelDB.
3. Store the token in the **OS keychain** (macOS Keychain via `keytar` /
   `safeStorage`); never on disk in plaintext, never logged.
4. All subsequent traffic (Gateway + REST) uses the stored token directly; the
   login webview is never shown again unless the token is revoked/invalid.
5. Manual token paste remains as an escape hatch for advanced users.

A native login form is explicitly **out of scope**: it only works in the happy
path (known residential IP, clean fingerprint, no CAPTCHA), and the webview path
must be built anyway to handle CAPTCHA — so the form adds risk and no capability.

**Multi-account** (§9 Q15): store several tokens in the keychain, one live at a
time; switching re-runs the sync engine against the selected token. Adding an
account re-opens the login webview. Clear logout wipes the token and optionally
purges that account's local store/index.

### XR-8 — Offline (P1)
Everything in the local store is browsable offline: channel/thread lists, cached
messages, Mentions, My Messages, search. Compose queues and sends on reconnect
(if XR-4 in scope).

### XR-9 — Theming (P2)
Dark/light + custom accent; density toggle (comfortable/compact); font size.
Respect OS theme by default.

---

## 6. Non-functional requirements

| # | Requirement |
|---|---|
| NFR-1 | **Rate-limit safety.** Global + per-route token buckets; respect `X-RateLimit-*` headers and `Retry-After`; exponential backoff on 429; all backfill work on a throttled background queue with a configurable ceiling (e.g. ≤ N req/s). Never hammer `/search`. |
| NFR-2 | **Performance.** Sidebar smooth (60 fps) at 150 guilds / 3000 channels / 20k threads via virtualisation. Cold start to interactive < 3 s with a warm local store. Search-within results < 200 ms for a 1M-message index. |
| NFR-3 | **Resilience.** All backfill/index jobs are resumable across restarts and network drops. Gateway auto-resumes; falls back to fresh `IDENTIFY` on invalid session. |
| NFR-4 | **Security.** Token only in OS keychain; never logged, never written plaintext, never sent anywhere except Discord. Login via embedded Discord page only — Harmony never implements a credential form and never stores the password. Local DB optionally encrypted at rest. No telemetry by default. |
| NFR-5 | **ToS risk minimisation.** Mimic the official client request signature: send the full header set from §11.1 (`x-super-properties`, `x-discord-locale`, `x-discord-timezone`, `x-debug-options`, matching `user-agent`/`sec-ch-ua*`) and **scrape the live `client_build_number`** from the current web bundle on startup — never hard-code it. Conservative rate defaults; no automated bulk sending; universal 429 handling (Discord 429s even its own telemetry — §11.1); prominent one-time disclosure of the account-suspension risk (§3 Option A). |
| NFR-6 | **Data footprint.** Local store size disclosed and capped by retention policy; user can see and prune it. |
| NFR-7 | **Cross-platform.** macOS first (user is on macOS). Windows/Linux to follow if the stack allows (§9 Q1). |
| NFR-8 | **Accessibility.** Full keyboard operability (XR-6), screen-reader labels on list rows and actions, respects reduced-motion, adjustable font size. |
| NFR-9 | **Recoverability.** Corner cases (lost thread access, deleted guild, revoked token) degrade to tombstones/prompts, never crashes or data loss of Harmony-local state (pins, layout, triage). |

---

## 7. Suggested UI structure (for discussion, not final)

```
┌────────────┬───────────────────────────────┬───────────────────────┐
│  RAIL      │  LIST PANE                     │  DETAIL PANE          │
│            │                               │                       │
│ ⌘K search  │  [scope: All ▼] [filters…]     │  #channel / thread    │
│            │                               │  ─────────────────    │
│ ★ Mentions │  ▸ Guild A                     │  message              │
│ ★ My Msgs  │     # general        ● 3       │  message              │
│ ★ Saved    │     # dev            ●         │  message              │
│ ★ Threads  │  ▸ Guild B                     │  …                    │
│ ★ Channels │     # design                  │                       │
│ ★ Pinned   │     ⨯ 4 hidden categories      │  [composer if XR-4]   │
│ ─ guilds ─ │                               │                       │
│ (icons)    │                               │                       │
└────────────┴───────────────────────────────┴───────────────────────┘
```

- **Rail**: the permanent top-level views (Mentions, My Messages, Saved,
  All Threads, All Channels, Pinned) above the classic guild icon column.
- **List pane**: whatever the active view lists (channels / threads / mention
  results / my-message results), always with the same scope switch + filter bar +
  search-within box.
- **Detail pane**: the selected conversation, with inline thread expansion.
- Panes resizable/collapsible; a focus mode hides the rail.

---

## 8. Out of scope for v1 (confirm in §9)

- Voice / video / stage channels, screenshare, Go Live, "Activities". *(Keep the
  official client for these.)*
- Server management/admin (moderation, roles, settings, audit log).
- Server discovery / onboarding / joining new servers.
- Nitro-only composing features (animated avatar, >8MB upload, etc.) beyond what
  the account already permits.
- Bot/app command UIs (slash-command surfaces, buttons/modals) — *render only,
  interaction TBD*.
- Mobile apps (desktop-only for v1; the local-index architecture doesn't preclude
  a later mobile companion).

---

## 9. Decisions log & remaining questions

### 9.1 Resolved (2026-09-03)

| Q | Decision |
|---|---|
| Q1 Architecture / ToS | Option A, standalone app, **automating the user's MAIN account**, risk accepted. Harmony must ship: prominent one-time risk disclosure, conservative rate limits, Gateway-first (minimise polling), one-click local data **export**, easy token re-auth, and a settings **"reduce activity"** mode for when a warning lands. |
| Q2 Client scope | **Full replacement client** (XR-4 → P0). Voice/video/stage still out (§8). |
| Q3 Mention defaults | **Direct `@`-mentions of me only.** Role mentions, `@everyone`/`@here`, and replies-to-me are opt-in filters/tabs, off by default. |
| Q4 DMs in list | **Yes** — dedicated "Direct Messages" section pinned above guild groups in the unified list. |
| Q6 Backfill depth | **Recent window, default ~12–24 months** (configurable), older fetched lazily on scroll-back / date-range search; "expand to full backfill" setting. |
| Q8 Device sync | **Local-only for v1**; store schema uses portable IDs + `updated_at` so sync can be added later without migration. |
| Q9 Write-back | **Full write-back** to Discord (send, ack, mute, thread lifecycle, notification level, …). |
| Q13 Empty category | Default "empty" = **no channels the user can view**. Stricter modes (no-unread / no-recent-activity) are opt-in. |
| Q15 Multi-account | **One account live at a time**; store multiple, fast-switch re-syncs; single Gateway connection. |
| Q16 Stack | **Electron + React + TypeScript.** Main process: sync engine (`ws` Gateway, HTTP client) + `better-sqlite3` (store + FTS5). Renderer: React. |
| Q17 Search syntax | **Tokenised full-text + Discord-style operators** (`from:` `in:` `has:` `before:`/`after:` `during:` `is:` `mentions:`, quotes, `OR`, `-`), plus a stretch **regex toggle**. Case-insensitive by default. |

### 9.2 Still open — please answer

**Q5 — Flat channel mode.** Beyond "grouped by server, all servers visible at
once", do you also want a *truly flat* single list (no guild grouping) as a mode —
e.g. sorted purely by recent activity, DMs interleaved? (Proposed default: ship
grouped-by-server; add flat mode as a P1 toggle.)

**Q7 — Thread message retention.** For archived threads, keep **metadata always +
fetch messages on open** (lighter), or also **cache full thread message history
locally** once opened (heavier, fully offline)? (Proposed default: metadata always;
cache messages for threads you've opened or pinned.)

**Q10 — Index retention / disk cap.** Let the local message index grow unbounded,
or prune messages older than *X* months / cap at *Y* GB — while **always** keeping
your Mentions and My-Messages sets permanently regardless? (Proposed default:
keep Mentions + My-Messages forever; general channel-message cache pruned past
12 months or a user-set GB cap, whichever first.)

**Q11 — "Footprint" analytics.** Do you want the aggregates panel in My Messages
(counts per server/channel, activity heatmap by date/hour) in v1, or defer to
v1.1? (Proposed default: defer — nice-to-have, not core.)

**Q12 — Destructive bulk actions.** Should Harmony offer **bulk-delete of your own
messages** at all? Bulk **export** (JSON/Markdown) of a selection? (Proposed
default: ship export; make bulk-delete a later, heavily-guarded, opt-in feature.)

**Q14 — Unified "Pinned" super-section.** In "All servers" mode, do you want one
"Pinned" section at the very top mixing pinned **channels + threads + categories**
across every server, or keep pins scoped within each guild's group? (Proposed
default: both — a global Pinned view in the rail *and* in-place pinning within
each guild group.)

**Q18 — What else? (the big one)** You said "there may be more." Dump every other
Discord pain point, however vague, and I'll spec each into an FR. Prompts to react
to:
- Notification overload / no good "catch up" flow / unread count anxiety?
- Marking whole servers read, or "read everything older than X"?
- Drafts lost when switching channels?
- Can't find an attachment/image/link someone posted weeks ago?
- ✅ **Bookmark / save messages → now FR-8** (confirmed 2026-09-03).
- Reply/thread context hard to follow; conversation jumps around?
- Emoji/reaction picker slow; can't see who reacted at a glance?
- No read receipts → uncertainty whether someone saw your message?
- Server-hop amnesia (lose your place when you switch servers)?
- Per-account identity confusion; nicknames vs usernames?
- Media viewer weak (no gallery, no zoom, no download-all)?
- Search too shallow / forgets your query / can't search DMs well?
- Accessibility, font size, information density?
- Anything about how *composing* should feel (Markdown preview, snippets, templates)?

---

## 10. Appendix — capability ↔ endpoint map (Option A, per §3.0)

| Capability | Mechanism | Verified |
|---|---|---|
| Enumerate guilds / roles / read states / mute+notif settings | Gateway `READY` + `READY_SUPPLEMENTAL` only (no REST equivalent the client uses) | — |
| Channel list per guild | `GET /guilds/{id}/channels` → array; keys incl. `id,type,parent_id,position,permission_overwrites,topic,rate_limit_per_user,nsfw`. **Excludes threads, read state, membership.** Types: 0 text, 2 voice, 4 category, 5 announcement, 13 stage, 15 forum. | ✅ 200 |
| Live tree changes | Gateway `GUILD_CREATE/UPDATE/DELETE`, `CHANNEL_CREATE/UPDATE/DELETE` | — |
| **Active threads (guild-wide)** | ~~`GET /guilds/{id}/threads/active`~~ → **403 for user tokens, dead.** Use Gateway `READY_SUPPLEMENTAL` (`guilds[].threads`) + `THREAD_LIST_SYNC` (sent on channel focus) + `THREAD_CREATE/UPDATE/DELETE`. | ✅ 403 confirmed |
| **Threads per channel (archived OR active), modern** | `GET /channels/{id}/threads/search?archived=true|false&sort_by=last_message_time&sort_order=desc&limit=25&offset=N&name=<substr>&tag_setting=match_some` → `{threads,members,has_more,total_results}`. `total_results` = exact count upfront. Offset pagination. Server-side name + tag filter. | ✅ 200 |
| Threads per channel, legacy fallback | `GET /channels/{id}/threads/archived/public?before=<ISO ts>&limit=N` → `{threads,has_more}`, cursor by `before`. Still live. | ✅ 200 |
| Archived private threads (joined) | `GET /channels/{id}/users/@me/threads/archived/private` (or `/channels/{id}/threads/search?archived=true` also returns joined private) | partial |
| Thread membership | Gateway `THREAD_MEMBERS_UPDATE`, `THREAD_MEMBER_UPDATE`; `PUT/DELETE /channels/{id}/thread-members/@me` | — |
| Messages (history) | `GET /channels/{id}/messages?limit=100&before=` | — |
| **Mentions of me (backfill)** | `GET /guilds/{id}/messages/search?mentions={me}&sort_by=timestamp&sort_order=desc&offset=N` → `{messages:[[ctx…]],threads,members,total_results,doing_deep_historical_index}`. Match in each group has `hit:true`. | ✅ 200, `total_results` 228 in one guild |
| **My messages (backfill)** | same endpoint, `?author_id={me}`. Other params: `content=`, `channel_id=`, `has=link|image|video|sound|file|embed`, `min_id=`/`max_id=` (snowflake date bounds), `pinned=`, `mention_everyone=`. | ✅ 200, `total_results` 301 in one guild |
| **Search offset ceiling** | `offset` must be **≤ 9975** (400 `NUMBER_TYPE_MAX` above). Page size fixed 25 → **≤ ~9975 results reachable by offset**. Beyond that, window by `max_id`/`min_id` and re-paginate. | ✅ 400 at 10000 |
| Search index not ready | `doing_deep_historical_index:true` and/or HTTP `202 {retry_after,documents_indexed}` → retry with backoff, don't treat as empty. | knowledge |
| DM / group-DM search | `GET /channels/{id}/messages/search?…` (same params, no guild scope) | — |
| Mentions / my-msgs (live) | Gateway `MESSAGE_CREATE`, filter client-side on `mentions[]`, `author.id`, `referenced_message.author.id` | — |
| Read state | `READY` read states + Gateway `MESSAGE_ACK`; write via `POST /channels/{id}/messages/{id}/ack` | — |
| Send/edit/delete/react | `POST/PATCH/DELETE /channels/{id}/messages/...`, `PUT /reactions/...` | — |
| Mute channel/guild, notification level | `PATCH /users/@me/guilds/{id}/settings` (guild + per-channel overrides) | — |
| Upload attachments | `POST /channels/{id}/attachments` (cloud upload slots) then reference in message | — |
| Typing indicator | `POST /channels/{id}/typing` | — |
| Auth | Bearer token in `Authorization` header on **every** call — cookies alone → 401. Token readable from any authenticated XHR; first `.`-segment base64-decodes to the user ID. | ✅ 401 without header |

*All mechanics above are unofficial and change without notice; keep the transport
layer isolated and patchable. "Verified" = observed live on 2026-09-03, see §11.*

---

## 11. Live reconnaissance findings (2026-09-03)

Captured by driving the real web client (`discord.com`, stable, build `605958`)
under Playwright with the project's own account. Test guild: a ~69-channel
community server. These supersede assumptions elsewhere in the doc.

### 11.1 Auth & client signature
- **API is Bearer-only.** `fetch` to `/api/v9/...` without an `Authorization`
  header returns `401` even with session cookies present. Harmony **must** obtain
  the token; a webview cookie jar is not enough.
- **Token is trivially interceptable** — it rides in the `authorization` header of
  every authenticated XHR (plain string, not `Bearer`-prefixed). Its first
  `.`-delimited segment is `base64(user_id)`.
- **`localStorage` is deleted** from `window` at runtime (`ReferenceError:
  localStorage is not defined` on access) — anti-token-theft. Fallback token
  sources: intercept the header (preferred), or read the webview partition's
  LevelDB.
- **Headers the real client sends** on every API call (Harmony should mirror these
  — NFR-5): `authorization`, `x-super-properties` (base64 JSON, see below),
  `x-discord-locale`, `x-discord-timezone`, `x-installation-id`,
  `x-debug-options: bugReporterEnabled`, a matching `user-agent` + `sec-ch-ua*`.
- **`x-super-properties` decoded:**
  ```json
  { "os": "Mac OS X", "browser": "Chrome", "device": "",
    "system_locale": "en-US", "has_client_mods": false,
    "browser_user_agent": "Mozilla/5.0 (Macintosh; …) Chrome/152.0.0.0 Safari/537.36",
    "browser_version": "152.0.0.0", "os_version": "10.15.7",
    "release_channel": "stable", "client_build_number": 605958,
    "client_event_source": null, "client_launch_id": "…",
    "launch_signature": "…", "client_app_state": "focused",
    "client_heartbeat_session_id": "…" }
  ```
  `client_build_number` changes every few days; Harmony must scrape the current
  value from the client bundle (`/assets/version.stable.json` +
  build-number regex in the entry chunk) rather than hard-code it. A stale build
  number raises CAPTCHA/flag risk.
- Renderer-context `fetch()` to the API fails (`Failed to fetch` — CSP
  `connect-src` / service worker). Node / `page.request` context works. Irrelevant
  for Harmony's Electron main process; relevant only if scripting the renderer.
- A background `POST /users/@me/meaningfully-online` was observed returning `429`
  during normal use — Discord rate-limits even its own telemetry; the transport's
  429 handling must be universal, not endpoint-specific.

### 11.2 Channels (FR-1)
- `GET /guilds/{id}/channels` → `200`, array of 69 objects. Keys:
  `id, type, last_message_id, flags, guild_id, name, parent_id,
  rate_limit_per_user, topic, position, permission_overwrites, nsfw, icon_emoji,
  theme_color`.
- Types present in the wild: `0` text, `2` voice, `4` category, `5` announcement,
  `15` forum (also expect `13` stage, `14` directory).
- **This endpoint does not carry**: threads, per-user **read state**, per-user
  **mute / notification overrides**, or **membership/join** state. All of those
  are Gateway-only (`READY` → `read_state`, `user_guild_settings`;
  `READY_SUPPLEMENTAL` → `guilds[].threads`). ⇒ FR-1's unread/mention badges and
  FR-6's "empty" test depend on a working Gateway ingest, not REST.

### 11.3 Threads (FR-2) — endpoint landscape changed
- **`GET /guilds/{id}/threads/active` → `403` for user tokens. Treat as removed.**
  Guild-wide active-thread state must come from the Gateway
  (`READY_SUPPLEMENTAL.guilds[].threads`, then `THREAD_LIST_SYNC` on channel
  focus, then `THREAD_CREATE/UPDATE/DELETE`).
- **Primary per-channel endpoint (new):**
  `GET /channels/{id}/threads/search`
  `?archived=true|false&sort_by=last_message_time&sort_order=desc`
  `&limit=25&offset=N&name=<substring>&tag_setting=match_some`
  → `{ threads: Channel[], members: [], has_more: bool, total_results: int }`.
  - Works for **both** `archived=true` and `archived=false` (unified).
  - `total_results` is the exact count → FR-2 can show "N threads" and a
    determinate backfill progress bar.
  - `name` does server-side substring match (verified: `name=demo` → 1 result).
  - Offset pagination, page size 25.
- **Legacy endpoint still live** (fallback / cross-check):
  `GET /channels/{id}/threads/archived/public?before=<ISO ts>&limit=N`
  → `{ threads, has_more }`, cursor by `before` timestamp.
- **Thread object shape** (from `threads/search`): standard channel fields plus
  `thread_metadata { archived, archive_timestamp, auto_archive_duration, locked,
  create_timestamp }`, `message_count`, `member_count`, `total_message_sent`,
  `owner` (full guild-member object incl. nested `user`), `member_ids_preview`
  (array of user IDs). `type`: `11` public, `12` private, `10` announcement.
- Forum channels (`type 15`): same `threads/search` endpoint; parent has
  `available_tags[]`, each thread has `applied_tags[]`.
- ⇒ **FR-2 data-source rewrite:** active = Gateway; archived + name/tag filter =
  `threads/search`; legacy `archived/public` kept only as a reconciliation
  cross-check.
- **Correction (from §11.6 Gateway capture):** `READY.d.guilds[].threads` at
  connect contains **only threads the user is a member of** (guild[0]: 1 thread,
  each carrying a `member{join_timestamp,muted,flags}` sub-object).
  `READY_SUPPLEMENTAL` in the capture carried `voice_states` + presences, **not**
  threads. The full active-thread list for a channel arrives via
  `THREAD_LIST_SYNC` **only when that channel is focused/subscribed**. ⇒ Harmony
  must either (a) issue a lazy-guild / channel subscription per channel to pull
  `THREAD_LIST_SYNC`, or (b) treat `threads/search?archived=false` as the active
  source too (it returned correctly, 0 for an idle channel). Recommend (b) for
  the unified "all threads" views + (a) opportunistically for focused channels.

### 11.4 Search — Mentions (FR-4) & My Messages (FR-5)
- `GET /guilds/{id}/messages/search?mentions={me}` and `?author_id={me}` both
  `200`. Full param set observed / known: `content`, `author_id`, `mentions`,
  `channel_id` (repeatable), `has` (`link|image|video|sound|file|embed`),
  `min_id`, `max_id` (snowflake date bounds), `pinned`, `mention_everyone`,
  `sort_by=timestamp|relevance`, `sort_order=asc|desc`, `offset`.
- Response: `{ analytics_id, messages: Message[][], threads: [], members: [],
  total_results: int, doing_deep_historical_index: bool }`.
  `messages` is an array of **context groups**; within each group the matching
  message has `hit: true`, the rest are surrounding context.
- **Hard limit: `offset ≤ 9975`** (`10000` → `400 Invalid Form Body`,
  `code 50035`, `NUMBER_TYPE_MAX … ≤ 9975`). Page size fixed at 25 ⇒ **only the
  most recent ~9975 matches are reachable by offset paging**. For any
  guild/filter with more, Harmony must **walk backwards in date windows**: page to
  the end, take the oldest `hit` id, re-query with `max_id = that id`, repeat.
  This belongs in the FR-4/FR-5 backfill design and NFR-1.
- `doing_deep_historical_index: true` (or HTTP `202` with
  `{ retry_after, documents_indexed }`) ⇒ Discord is still building that guild's
  search index; retry with backoff, do **not** render as "no results".
- Live counts for the project account in the one test guild: **228** messages
  mention me, **301** authored by me. A full account spans many guilds → the
  per-guild iteration + date-windowing is the dominant cost of first-run backfill
  (reinforces §9.1 Q6: ship the recent-window default).

### 11.6 The Gateway — how the client actually receives messages

Captured by hooking `window.WebSocket` on a fresh page load, rewriting the socket
URL to drop `&compress=zlib-stream`, and buffering the plaintext frames.

- **Transport.** Exactly **one** long-lived WebSocket:
  `wss://gateway.discord.gg/?encoding=json&v=9&compress=zlib-stream`. No HTTP
  polling anywhere. It does not appear under the DevTools Network **XHR/Fetch**
  filter — only under **WS** — and it shows as a single connection that never
  closes; the individual events are in that entry's **Messages** sub-tab, and
  they render as unreadable binary because of `zlib-stream`. That's why the
  Network tab "looks quiet".
- **Handshake.** Server → `op 10 Hello` `{ heartbeat_interval: ~41250 }`. Client →
  `op 2 IDENTIFY` (token, `properties` = the same `x-super-properties` payload,
  `capabilities` bitfield, `compress`, `presence`). Server → `op 0 t:READY` then
  `op 0 t:READY_SUPPLEMENTAL`.
- **Heartbeat.** Client sends `op 1` `{ d: <last seq> }` every
  `heartbeat_interval` ms; server replies `op 11 Heartbeat ACK`. **These are
  WebSocket frames, not HTTP requests** — nothing in the Network waterfall.
  Missed ACK ⇒ client drops and reconnects.
- **New messages.** Server pushes `op 0 t:MESSAGE_CREATE` frames (captured live —
  ~2.7 KB each). Payload keys: `id, type, content, author, member, channel_id,
  channel_type, guild_id, timestamp, edited_timestamp, mentions[] (full user
  objects), mention_roles[], mention_everyone, attachments[], embeds[],
  components[], flags, pinned, tts, nonce`. Also seen streaming:
  `PRESENCE_UPDATE`, and (on channel focus) `TYPING_START`, `MESSAGE_UPDATE`,
  `MESSAGE_DELETE`, `MESSAGE_ACK`, `THREAD_LIST_SYNC`, `CHANNEL_UNREAD_UPDATE`.
- **Reconnect/resume.** `READY.d.resume_gateway_url`
  (`wss://gateway-us-east1-d.discord.gg` in the capture) + `session_id` → `op 6
  RESUME` replays missed events; on `op 9 Invalid Session` fall back to a fresh
  IDENTIFY.
- ⇒ Harmony's `MESSAGE_CREATE` handler **is** the live pipeline for the message
  store, FR-4 (mentions), FR-5 (my messages), and unread bumps. No polling.

**`READY.d` payload shape** (≈192 KB for a 3-guild account; grows with account
size — large accounts get `data_mode:"partial"` guilds and must lazy-load):

| Field | Shape / use |
|---|---|
| `user` | Self object — includes `email`, `phone`, `mfa_enabled`, `premium_type`, `global_name`, `pronouns`, `bio`. The private self-view. |
| `users` | Flat user cache (everyone referenced elsewhere in READY). |
| `guilds[]` | Per guild: `{ id, properties:{…all guild fields: name, icon, owner_id, features, preferred_locale, …}, channels:[…], threads:[…], roles:[…], emojis, stickers, stage_instances, guild_scheduled_events, member_count, joined_at, large, lazy, data_mode, version }`. **`channels[]` here is a superset of REST `/guilds/{id}/channels`** — adds `last_pin_timestamp`, forum fields (`available_tags`, `default_sort_order`, `default_reaction_emoji`, `default_tag_setting`), `theme_color`, `status`, voice-hangout fields ⇒ use the Gateway list as primary for FR-1. **`threads[]` = only threads the current user is a member of** (each with a `member{join_timestamp,muted,flags}`), *not* the channel's full active list (see §11.3 correction). No `members[]` (lazy). |
| `read_state` | `{ version, partial, entries[] }`, one entry per read channel/thread: `{ id, last_message_id, last_viewed, last_pin_timestamp, mention_count, flags }`. **THE source for FR-1 unread dots + mention badges and the FR-6 "empty category" test.** Live deltas via `MESSAGE_ACK` / `CHANNEL_UNREAD_UPDATE`. |
| `user_guild_settings` | `{ version, partial, entries[] }`, one per guild (+ a global `guild_id:null`): `{ guild_id, muted, message_notifications (0 all /1 mentions /2 none /3 inherit), mobile_push, suppress_everyone, suppress_roles, notify_highlights, hide_muted_channels, mute_config, channel_overrides[] }`. `channel_overrides[]`: `{ channel_id, muted, mute_config, message_notifications, collapsed, flags }`. ⇒ FR-1's mute filter, FR-6, and **`collapsed` seeds FR-7's category collapse state**; `hide_muted_channels` is Discord's own partial FR-1 feature. Write-back: `PATCH /users/@me/guilds/{id}/settings`. |
| `private_channels` | 52 DMs. `{ id, type (1 DM / 3 group), recipient_ids[], last_message_id, is_spam, is_message_request, flags }` (+ `name,icon,owner_id` for group). **No inline read state** — DM unread is `read_state` entries keyed by the DM channel id. ⇒ FR-1 "Direct Messages" section source. |
| `merged_members` | Parallel array to `guilds` — `merged_members[i]` = member objects for `guilds[i]` (self + a few at connect): `{ user_id, roles[], nick, joined_at, premium_since, pending, flags, communication_disabled_until, avatar, banner }`. **`roles[]` per guild = what FR-4 needs to resolve role-mentions of me.** |
| `relationships` | Friends / blocked (`type` 1 friend, 2 blocked, 3/4 pending). |
| `session_id`, `resume_gateway_url`, `auth_session_id_hash`, `analytics_token`, `api_code_version`, `v:9` | Session plumbing. `user_settings_proto` is a base64 protobuf (theme, status, folders, guild order) — decode needed if Harmony wants to honour Discord's server/folder ordering. |

**`READY_SUPPLEMENTAL.d`** in this capture: `{ guilds[]: { id, voice_states[],
embedded_activities[], activity_instances[] }, merged_presences, merged_members,
lazy_private_channels, game_invites, disclose }` — i.e. **voice + presence
hydration**, not threads.

### 11.7 Doc changes triggered by this pass
0. §11.6 added: Gateway transport + full `READY` shape mapped to FR-1/4/5/6/7.
1. §10 appendix rewritten with verified endpoints + the `403` / offset-ceiling
   facts. ✅ done
2. FR-2 "Data source" → active-threads via Gateway, archived via `threads/search`
   (see §11.3). ✅ reflected below
3. FR-4 / FR-5 "Risks" → add the `offset ≤ 9975` ceiling and the date-window
   backfill requirement. ✅ reflected below
4. XR-2 event list → add `READY_SUPPLEMENTAL`, `THREAD_LIST_SYNC`. ✅
5. NFR-5 → add "scrape live `client_build_number`; mirror the full header set
   from §11.1". ✅
6. XR-7 → `localStorage`-deleted note already present; add "cookies alone = 401,
   token capture is mandatory". ✅
