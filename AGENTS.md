# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Harmony is an Electron + React + TypeScript desktop client for Discord that
authenticates as the user's own account and talks to Discord's **private** client
API + gateway WebSocket. It is an early vertical slice, not a finished product.

Three docs carry context beyond the code:
- `docs/requirements.md` — the product spec (feature requirements, and §10–§11
  document the real Discord API/gateway behaviour discovered by testing).
- `docs/handoff.md` — engineering state dump: data flow, bugs fixed, gotchas.
- `docs/user-guide.md` — end-user description of current behaviour.

## Commands

```bash
npm run dev         # electron-vite: builds main+preload, runs renderer dev server, launches Electron
npm run typecheck   # tsc --noEmit over the whole project — the only static check
npm run build       # electron-vite build (packaging/signing NOT configured)
```

There is **no test suite and no linter**. `npm run typecheck` is the gate; run it
after changes.

`electron-vite dev` does **not** reliably restart on `src/main/**` or
`src/preload/**` changes — kill and re-run `npm run dev` after editing those. The
renderer (`src/renderer/**`) hot-reloads.

### Fresh-machine install gotchas (npm 11)

`npm install` alone is not enough:
1. Install scripts are gated. `package.json` has an `allowScripts` block; if
   Electron/esbuild postinstall still didn't run:
   `npm install-scripts approve electron esbuild && npm rebuild electron esbuild`.
2. The Electron binary sometimes downloads but doesn't unpack. If
   `node -e "require('electron')"` errors, unzip
   `~/Library/Caches/electron/*/electron-v*-darwin-*.zip` into
   `node_modules/electron/dist/` and write
   `node_modules/electron/path.txt` = `Electron.app/Contents/MacOS/Electron`.

## Architecture

### Process split and data flow

The renderer **never** contacts Discord. Everything crosses one typed IPC surface.

```
gateway WS ─▶ Gateway (emits 'dispatch', type, data) ─▶ Store.ingest(type, d)
REST API   ◀─ rest.ts  ◀─ ipcMain handlers (index.ts)          │  mutates in-memory model
                                                               ▼
                            store 'change' ─(50ms coalesce, index.ts)─▶ Store.getState()
                                                               ▼
                     win.webContents.send('harmony:state', UnifiedState)
                                                               ▼
                       preload window.harmony.onState ─▶ React setState (App.tsx)
```

- **`src/main/store.ts`** is the single source of truth. It holds raw Discord
  shapes in `Map`s (`guilds`, `threads`, `dmChannels`, `users`, `presences`,
  `readStates`, `mutedGuilds/Channels`, `self`). `ingest(type, d)` is a big switch
  over gateway dispatch types. `getState()` derives the entire renderer view model
  (`UnifiedState`) on every push: guild → category (with an `alpha`/`recent` sort
  key) → channel (+ its joined threads); plus `dms` (1:1 and group, group members
  including a synthesised "you", presence rollup).
- **`src/main/gateway.ts`** — `Gateway` (EventEmitter). Connects **without**
  `compress` so frames are plain JSON. Handles `op 10` hello / heartbeat / `op 2`
  IDENTIFY (`capabilities: 161789`) / `op 6` RESUME / reconnect backoff. Close
  codes 4004/4010–4014 are surfaced as "token rejected, sign in again" rather than
  retried.
- **`src/main/rest.ts`** — `apiGet`/`apiPost` with the web client's header set
  (`Authorization` is the bare token, not `Bearer`; plus `X-Super-Properties`
  base64, `X-Discord-Locale`, Chrome UA). Message/thread/reply helpers live here.
- **`src/main/index.ts`** — window, all `ipcMain.handle('harmony:*')` handlers,
  the coalesced state push, and an in-memory `currentToken` cache so REST calls
  don't re-read disk.
- **`src/preload/index.ts`** — the `window.harmony` bridge; keep it and
  `HarmonyApi` in `src/shared/types.ts` in sync.
- **`src/renderer/`** — `App.tsx` (shell: topbar, reconnect banner, Servers/DMs
  mode switch, sidebar, filters — filter/sort/mode state persisted to
  `localStorage`), `MessagePane.tsx` (message list, composer, reply flow, the
  right-hand Threads panel), `styles.css` (single **light** palette, no dark
  mode).

`src/shared/types.ts` is the contract between processes. Its `@shared/*` alias is
wired in `tsconfig.json` and `electron.vite.config.ts` (main + renderer).

### Persistence — `src/main/secure-file.ts`

Token (`token.bin`) and the model snapshot (`snapshot.bin`), both in
`app.getPath('userData')`, are written via `writeSecure`/`readSecure`, which
prefix every file with `enc1\n` (base64 `safeStorage` ciphertext) or `plain\n`.
This tagging is deliberate: an earlier untagged format made reads unable to tell
encrypted from plaintext and caused a "keeps asking to sign in" loop. Do not
reintroduce ambiguous storage. The snapshot lets the UI paint before the gateway
reconnects (`Store` loads it in its constructor).

### Auth

Login embeds Discord's **real** login page in a `BrowserWindow` and captures the
token from the `Authorization` request header via
`session.webRequest.onBeforeSendHeaders` (`src/main/auth.ts`). Never build a
native credential form — CAPTCHA / MFA / email-verification are Discord's UI. A
"paste a token" escape hatch exists.

## Constraints from Discord's private API (verified — see requirements.md §11)

- **Bearer-only**: API calls need the `Authorization` header; cookies alone → 401.
- `localStorage` is **deleted from `window`** at runtime — not a token source.
- `GET /guilds/{id}/threads/active` is **403 for user tokens**. Active threads
  come from the gateway (`READY.guilds[].threads` = joined only, plus
  `THREAD_LIST_SYNC` / `THREAD_CREATE|UPDATE|DELETE`). All-threads-in-a-channel
  uses `GET /channels/{id}/threads/search?archived=true|false&...` (offset paged).
- `GET /guilds/{id}/messages/search` `offset` caps at **9975**; page size 25. For
  more results, date-window with `max_id` and re-page. A `202` / 
  `doing_deep_historical_index:true` response means the index is still building —
  retry with backoff.
- Read state, mute/notification settings, and membership are **gateway-only** —
  never in REST channel payloads.
- `private_channels` recipient lists **exclude the current user**.
- `client_build_number` (currently hard-coded `605958` in `rest.ts` and
  `gateway.ts`) changes every few days and should eventually be scraped live.
