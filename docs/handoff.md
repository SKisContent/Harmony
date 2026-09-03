# Harmony — Session Handoff

Everything needed to continue this project on another machine. Written 2026-09-03.

> This is a state dump of a Claude Code session, not a raw context transcript.
> It captures the decisions, the code, the environment gotchas, the
> reverse-engineering findings, and what to do next.

---

## 0. TL;DR

**Harmony** is an alternative Discord desktop client (Electron + React + TS) built
around *seeing everything at once and finding things fast*. It authenticates with
the user's own Discord account token, talks to Discord's private client API + the
gateway WebSocket, and keeps an encrypted local snapshot.

**Working today:** sign-in (persisted), unified all-servers channel list with
categories/filters, message reading, posting, replying, threads (sidebar + right
panel, active + archived), direct messages with group-member sublists and live
presence dots.

**Not a git repo yet.** `git init` has not been run. `.gitignore` exists.

**To run:** see §3. There are two environment gotchas (npm 11 install scripts,
Electron binary) documented in §4 — a fresh `npm install` on another machine will
hit them.

---

## 1. Project goal & locked decisions

Full detail in `docs/requirements.md` (1000+ lines, the authoritative spec). The
essentials:

The official Discord client hides information (one server at a time, recent
threads only, per-server search, no cross-server anything). Harmony inverts that:
everything visible by default, retrieval is first-class, user controls layout,
keyboard-friendly.

**Locked architectural decisions** (requirements.md §3.0 / §9.1):

| Decision | Value |
|---|---|
| Data access | **Option A** — standalone app, authenticates as the user's own account token, calls the private client HTTP API + gateway. Local snapshot (SQLite planned, JSON-via-safeStorage today). |
| Account | Automates the user's **main** account; ToS/suspension risk accepted. Must ship conservative rate limits, gateway-first, one-click export, easy re-auth, a "reduce activity" mode. |
| Client scope | **Full replacement client** (compose/edit/react/threads). Voice/video/stage out of scope for v1. |
| Write-back | **Full** (send, ack, mute, thread lifecycle, …). Harmony-local-only: thread pins, category pins/order, hidden-category rules, mention triage, bookmarks. |
| Stack | **Electron + React + TypeScript.** Main process = sync engine + store; renderer = React. |
| Login | Embed Discord's real login page in a window, capture the token from the `Authorization` header. Never build a native credential form (CAPTCHA/MFA/email-verify are Discord's UI). |
| Backfill depth | Recent window (~12–24 months) default, older on demand. |
| DMs in list | Yes — dedicated section / mode. |
| Device sync | Local-only for v1; schema kept portable so sync can be added later. |
| Multi-account | One live at a time, fast switch. |
| Mentions default | Direct `@`-mentions of you only (role/@everyone/replies are opt-in). |
| Empty category | "empty" = no channels you can view (default). |
| Search syntax | Full-text + Discord-style operators (`from:` `in:` `has:` `before:` …). |

**Still-open requirements questions** (requirements.md §9.2): Q5 flat channel mode,
Q7 thread message retention, Q10 index retention, Q11 footprint analytics, Q12
bulk-delete, Q14 unified pinned super-section. Proposed defaults are in the doc.

**Feature FR-8 (bookmarks)** was added mid-session at the user's request.

---

## 2. Repository layout

```
harmony/
  package.json                electron-vite scripts; note "allowScripts" block (see §4)
  package-lock.json
  tsconfig.json               single config, noEmit, path alias @shared/* -> src/shared/*
  electron.vite.config.ts      main / preload / renderer builds; @shared alias in main+renderer
  .gitignore                   ignores .pw-profile/, .playwright*/, node_modules, out, etc.
  docs/
    requirements.md            THE spec — vision, 8 FRs, cross-cutting, NFRs, §11 live recon
    user-guide.md              end-user how-to for what's built
    handoff.md                 this file

  src/shared/types.ts          types shared main<->renderer (UnifiedState, ChannelRow,
                               ThreadRow, DmRow, DmMemberRow, PresenceStatus, MessageRow,
                               ThreadSummary, HarmonyApi, CHANNEL_TYPE, TEXTISH_TYPES)

  src/main/
    index.ts                   app lifecycle, BrowserWindow, all ipcMain handlers,
                               coalesced state push to renderer, in-memory currentToken cache
    auth.ts                    captureTokenViaLogin() — login window + webRequest header
                               sniff; loadToken/saveToken/clearToken via secure-file
    secure-file.ts             writeSecure/readSecure/removeSecure — tagged file format
                               ("enc1\n" base64 ciphertext | "plain\n" utf8); migrates
                               legacy header-less files. FIXES the "keeps asking to sign
                               in" bug (see §6).
    gateway.ts                 Gateway class (EventEmitter): connect, IDENTIFY (op 2),
                               heartbeat, RESUME (op 6), reconnect w/ backoff, close-code
                               handling (4004/401x -> "token rejected"). Emits
                               ('dispatch', type, data) for every gateway event.
                               URL: wss://gateway.discord.gg/?v=9&encoding=json  (no compress)
                               capabilities: 161789
    rest.ts                    apiGet/apiPost with the web client's header set
                               (Authorization, X-Super-Properties b64, X-Discord-Locale,
                               UA). getMessages, sendMessage (with optional reply
                               message_reference + allowed_mentions), getThreads
                               (threads/search archived=false + archived=true, merged).
    store.ts                   Store class (EventEmitter). In-memory model:
                               guilds, threads, dmChannels, users, presences, dmUserIds,
                               readStates, mutedGuilds, mutedChannels, self.
                               ingest(type,d) handles READY, READY_SUPPLEMENTAL,
                               PRESENCE_UPDATE, GUILD_*, THREAD_* , CHANNEL_* (incl DM
                               types 1/3), MESSAGE_CREATE (unread bump + self-mention),
                               MESSAGE_ACK. getState() derives UnifiedState:
                               guild -> category (alpha or recent sort key) -> channel
                               (+ its joined threads), plus dms (1:1 + group w/ member
                               sublist incl. "you", presence rollup). Persists an
                               encrypted JSON snapshot via secure-file
                               (userData/snapshot.bin).

  src/preload/index.ts         contextBridge -> window.harmony: getState, login, setToken,
                               logout, reconnect, getMessages, sendMessage(+opts),
                               getThreads, onState(cb)

  src/renderer/
    index.html                 CSP allows img from cdn.discordapp.com + media.discordapp.net
    src/main.tsx               React root
    src/global.d.ts            window.harmony typing
    src/styles.css             light theme (single palette, no dark mode), ~900 lines
    src/App.tsx                shell: topbar, reconnect banner, Servers/DMs mode switch,
                               sidebar (filters + channel tree OR DM list w/ group
                               members + presence dots), <MessagePane>
    src/MessagePane.tsx        message list (grouping, images, attachments, reply lines),
                               composer (Enter send / Shift+Enter newline / 2000 cap),
                               reply flow (hover ↩ -> reply bar w/ Ping toggle + Esc),
                               right-hand Threads panel (Active / Archived, click to open)
```

Approx sizes: store.ts ~570, styles.css ~900, App.tsx ~410, MessagePane.tsx ~290,
rest.ts ~176, gateway.ts ~174, types.ts ~155, index.ts ~163.

---

## 3. How to run

Requirements: Node (session used v26; Electron bundles its own Node 20). macOS
(only platform exercised).

```bash
cd harmony
npm install                       # then see §4 — install scripts + Electron binary
npm run dev                       # electron-vite dev: builds main/preload, Vite dev
                                  # server for renderer, launches Electron
npm run typecheck                 # tsc --noEmit
npm run build                     # electron-vite build (not yet exercised for packaging)
```

First launch shows a sign-in screen. Sign in with the **QR code** in the popup
window (scan with the Discord mobile app) — no password/CAPTCHA. Session persists
in `~/Library/Application Support/harmony/token.bin` (encrypted). The cached
channel snapshot is `snapshot.bin` in the same dir.

`electron-vite dev` does NOT auto-restart on main-process file changes reliably in
this setup — kill and re-run after editing `src/main/**`. Renderer hot-reloads
fine.

---

## 4. Environment gotchas (WILL bite on a fresh machine)

### 4.1 npm 11 gates install scripts
`npm install` with npm 11.19 does **not** run `postinstall` for `electron` or
`esbuild` by default — it prints an `install-scripts` warning. `package.json` now
carries an `allowScripts` block approving them:

```json
"allowScripts": { "electron@33.4.11": true, "esbuild@0.21.5": true }
```

If a fresh install still doesn't run them: `npm install-scripts approve electron esbuild`
then `npm rebuild electron esbuild`.

### 4.2 Electron binary may not extract
Even after the postinstall runs, `require('electron')` threw *"Electron failed to
install correctly"* — the ~99 MB zip downloaded to
`~/Library/Caches/electron/<hash>/electron-v33.4.11-darwin-arm64.zip` but wasn't
unpacked. Manual fix that worked:

```bash
rm -rf node_modules/electron/dist
mkdir -p node_modules/electron/dist
unzip -q ~/Library/Caches/electron/<hash>/electron-v33.4.11-darwin-arm64.zip \
  -d node_modules/electron/dist
printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
node -e "console.log(require('electron'))"   # should print the binary path
```

### 4.3 zsh `nomatch`
`rm foo-*.bar` aborts the whole command in zsh if the glob matches nothing. Use
explicit paths.

### 4.4 safeStorage across restarts
`safeStorage` DOES round-trip on macOS dev, but an earlier version wrote
header-less encrypted blobs and then couldn't tell encrypted from plaintext on
read. `secure-file.ts` now prefixes every file with `enc1\n` / `plain\n` and
migrates legacy files. Don't reintroduce ambiguous storage.

---

## 5. What works today (in the order it was built)

1. **Login + persisted session.** Embedded Discord login window, `Authorization`
   header sniff via `session.webRequest.onBeforeSendHeaders`, token stored
   encrypted. "Paste a token instead" escape hatch. Chrome UA on the login window
   (Electron's default UA triggers extra Discord friction).
2. **Unified channel list.** Servers → categories → channels. Scope = all servers
   or one. Category sort = **Alphabetical** (default) or **Most recent message**
   (by max child `last_message_id`). Filters: *Unread only*, *Hide muted*.
   Uncategorised channels pinned above categories. Icons: 🟰 category, ➖ channel,
   〰️ thread. Unread dot + red mention badge per row.
3. **Light theme.** Whole UI; no dark mode.
4. **Message pane.** Two-pane layout (288 px sidebar + content). Click a channel →
   `GET /channels/{id}/messages?limit=50`. Author/time/text, 5-min grouping,
   inline images, 📎 attachment links, reply lines, `[N embeds]` placeholder.
5. **Composer.** Enter send / Shift+Enter newline, 2000-char counter, error
   surface. `POST /channels/{id}/messages`.
6. **Threads.** Sidebar: joined threads under their channel (from
   `READY.guilds[].threads`). Header button `〰️ Threads (N)` opens a **right-hand
   panel** listing **all** threads via `threads/search` — Active + Archived
   sections — click to open (a thread is just a channel).
7. **Direct Messages.** Sidebar **Servers / Direct Messages** switch (segmented
   control, top of sidebar). DM mode: flat list, newest-active first, avatar +
   unread + mention badge; *Unread only* applies. Group DMs (type 3) show their
   **members indented** below the row (like channels under a category), including
   **you** as "<name> (you)" — but only when actually joined (skipped for
   `is_message_request` groups you don't own).
8. **Presence.** Green/yellow/red/grey dot on every DM/member avatar, from
   `merged_presences` (READY_SUPPLEMENTAL) + live `PRESENCE_UPDATE`. Group row dot
   is a rollup of the *other* members (you're excluded so a quiet group isn't
   green just because you're online). Caveat: Discord only sends presence for
   friends / shared-guild members; others always read grey.
9. **Replies.** Hover a message → ↩ button → reply bar above composer (*Replying
   to name — preview*, **Ping** checkbox default on, ✕ / Esc to cancel). Sends a
   real `message_reference` reply. Works in channels, threads, DMs.

Filters/mode/sort persist via `localStorage` in the renderer.

---

## 6. Bugs fixed this session (don't regress)

- **"Keeps asking me to sign in."** Root cause: storage read couldn't distinguish
  encrypted vs plaintext token files. Fixed with the tagged `secure-file` format
  (§4.4). Snapshot uses the same.
- **Login "invalid password."** User signs in via Google/passkey → no usable
  password. Solution: QR login + paste-token path + Chrome UA on the login window.
- **Threads button vanished.** Was only rendered when `threads.length > 0` and a
  long channel name pushed it off-screen. Now always rendered (`Threads (0)`),
  `flex:none`, channel name ellipsises.
- **"You" missing from group member list.** Discord's `recipient_ids` never
  includes self. Now synthesised, guarded by join state.

---

## 7. Reverse-engineering findings (condensed from requirements.md §11)

Verified live against `discord.com` (stable, build 605958) on 2026-09-03.

### Auth
- API is **Bearer-only** — cookies alone → 401. Token must be captured.
- Token rides in the plain `Authorization` header (not `Bearer …`) of every
  authenticated XHR. First `.`-segment is `base64(user_id)`.
- `localStorage` is deleted from `window` at runtime (anti-token-theft).
- Client sends `X-Super-Properties` (b64 JSON: os, browser, `client_build_number`
  605958, release_channel, UA, …), `X-Discord-Locale`, `X-Discord-Timezone`,
  `X-Debug-Options: bugReporterEnabled`. `client_build_number` changes every few
  days — should be scraped live, currently hard-coded in `rest.ts` + `gateway.ts`.

### Channels / threads
- `GET /guilds/{id}/channels` → 200. Superset of what the client uses is actually
  in the gateway `READY` (adds `last_pin_timestamp`, forum tag fields, etc.). Use
  the gateway list as primary. **No read state / mute / membership** in REST —
  gateway only.
- `GET /guilds/{id}/threads/active` → **403 for user tokens. Dead.** Active
  threads come from `READY.guilds[].threads` (only ones you're in) +
  `THREAD_LIST_SYNC` on channel focus + `THREAD_CREATE/UPDATE/DELETE`.
- `GET /channels/{id}/threads/search?archived=true|false&sort_by=last_message_time&sort_order=desc&limit=25&offset=N&name=<substr>&tag_setting=match_some`
  → `{ threads, members, has_more, total_results }`. Works for active AND
  archived. This is what `rest.ts getThreads` uses.
- Legacy `GET /channels/{id}/threads/archived/public?before=<ISO>&limit=N` still
  live as a fallback.

### Search (for FR-4 / FR-5, NOT yet implemented)
- `GET /guilds/{id}/messages/search?mentions={me}` / `?author_id={me}` +
  `sort_by=timestamp&sort_order=desc&offset=N`. Response
  `{ messages: Message[][], total_results, doing_deep_historical_index }`; the
  hit in each context group has `hit:true`.
- **`offset` cap = 9975** (10000 → HTTP 400). Page size 25. For >9975 matches you
  must date-window with `max_id` and re-paginate.
- `doing_deep_historical_index:true` / HTTP 202 → index still building, retry with
  backoff.

### Gateway (§11.6)
- One WebSocket: `wss://gateway.discord.gg/?encoding=json&v=9&compress=zlib-stream`
  (Harmony connects **without** compress so frames are plain JSON). Not visible
  under the DevTools XHR filter — it's under "WS", one connection, frames in the
  Messages sub-tab.
- Handshake: server `op 10 Hello {heartbeat_interval ~41250}` → client `op 2
  IDENTIFY` → server `op 0 READY` then `READY_SUPPLEMENTAL`.
- Heartbeat = `op 1` every interval, server `op 11` ack. WebSocket frames, no HTTP.
- `READY.d` (~192 KB for a 3-guild account) keys of interest: `user` (self,
  incl. email), `users` (cache), `guilds[]` (`properties`, `channels[]`,
  `threads[]` = joined only, `roles[]`, …), `read_state.entries[]`
  (`{id,last_message_id,last_viewed,mention_count,flags}`),
  `user_guild_settings.entries[]` (`muted`, `message_notifications`,
  `channel_overrides[]` w/ `collapsed`), `private_channels[]` (DMs, type 1/3,
  `recipient_ids` **excludes self**), `merged_members[i].roles` (your roles per
  guild), `merged_presences` (may be here or in SUPPLEMENTAL),
  `resume_gateway_url`, `session_id`.
- `READY_SUPPLEMENTAL.d`: `merged_presences {friends[], guilds[][]}`, voice states,
  `merged_members`. This is where presence hydration came from in testing.
- `MESSAGE_CREATE` frame keys: `id, content, author, member, channel_id,
  guild_id, timestamp, edited_timestamp, mentions[], mention_roles[],
  mention_everyone, attachments[], embeds[], components[], flags, referenced_message`.

Full endpoint↔mechanism table: requirements.md §10.

---

## 8. Data flow

```
Discord gateway WS ──▶ Gateway (gateway.ts) ──('dispatch', type, d)──▶ Store.ingest
                                                                          │
Discord REST  ◀── rest.ts ◀── ipcMain handlers (index.ts) ◀────────────── │
                                                                          ▼
                                                              Store.getState() -> UnifiedState
                                                                          │
                                            store 'change' (50 ms coalesced) in index.ts
                                                                          ▼
                                                    win.webContents.send('harmony:state', state)
                                                                          ▼
                                              preload window.harmony.onState -> React setState
```

- The renderer never talks to Discord directly. Everything goes through IPC.
- `Store` is the single source of truth for the UI; gateway events mutate it;
  `getState()` derives the view model each push.
- A snapshot (`snapshot.bin`, encrypted) is written on every READY and reloaded on
  launch so the UI paints before the gateway reconnects.

---

## 9. Known limitations / not yet built

- **No live messages in the open channel** — `MESSAGE_CREATE` updates sidebar
  unread badges but is not forwarded to `MessagePane`; reopen the channel to
  refresh. (Sidebar/DM badges do update live.)
- **No scroll-back** — only the latest ~50 messages; no pagination.
- **No Markdown / mention resolution** — `**bold**`, `<@id>`, `<#id>`, `<:emoji:>`
  render raw.
- **No** attachments upload, emoji/sticker/gif picker, `@`/`#`/`:` autocomplete,
  reactions, edit/delete, typing indicator, mark-as-read.
- **SQLite not wired** — model is in-memory + JSON snapshot. requirements.md wants
  SQLite + FTS5.
- **FR-3/6/7 not built** — pin threads, hide empty categories, pin/reorder
  categories.
- **FR-4/5 not built** — Mentions inbox, My Messages view, search-within.
- **FR-8 not built** — bookmarks.
- `client_build_number` hard-coded (605958) in `rest.ts` and `gateway.ts`.
- No packaging / code-signing / auto-update. `npm run build` untested for dist.
- No tests.
- macOS only exercised.

---

## 10. Suggested next steps (pick per priority)

1. **Live channel updates** — forward `MESSAGE_CREATE/UPDATE/DELETE` for the
   focused channel over IPC; append/patch in `MessagePane`; reconcile the
   optimistic sent-message echo. Small, removes the most jarring gap.
2. **Scroll-back** — `GET /channels/{id}/messages?before=<id>&limit=50` on scroll
   to top.
3. **Nav polish cluster (FR-3/6/7)** — all Harmony-local state, all sidebar
   rendering; one pass. Add a local-state store (start of the "SQLite later"
   path) for pins/order/hidden.
4. **Markdown + mention/#channel/emoji rendering** — makes reading usable; the
   `users`/`guilds` maps already have the names to resolve against.
5. **Mentions inbox (FR-4)** — the headline wish. Needs per-guild
   `messages/search?mentions={me}` with the offset-cap/date-window handling from
   §7, a local index, a new top-level view, search-within.
6. **SQLite** — replace the JSON snapshot; schema in requirements.md §3.
7. Answer requirements.md §9.2 open questions with the user; cut requirements
   v1.0.

---

## 11. Secrets, local state, external session

- `~/Library/Application Support/harmony/token.bin` — encrypted account token.
- `~/Library/Application Support/harmony/snapshot.bin` — encrypted cached model
  (contains guild/channel/DM metadata, your email via `self`). Safe to delete;
  rebuilds on next sync.
- `harmony/.pw-profile/` — a **Playwright** Chromium profile from the
  reverse-engineering phase, logged into the user's Discord. **gitignored.**
  `discord-auth.json` there is a Playwright storage-state. Not used by the app.
- A Playwright browser session named `discord` was left open during the session
  (`playwright-cli -s=discord ...`). Transient; won't transfer. Close with
  `playwright-cli -s=discord close` if still running.
- No credentials are in the repo. `.gitignore` covers `.pw-profile/`,
  `.playwright*/`, `node_modules/`, `out/`, `*.log`, `.env*`.

---

## 12. To resume on the new machine

1. Copy the repo (or `git init` + commit first — nothing is committed yet).
2. `npm install`, then work through §4 (install scripts + Electron binary).
3. `npm run dev`. Sign in via QR.
4. Read `docs/requirements.md` (spec) and `docs/user-guide.md` (current UX).
5. Continue from §10.
