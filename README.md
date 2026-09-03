# Harmony

**An alternative Discord client built for seeing everything at once and finding things fast.**

Harmony is a desktop client for Discord that inverts the official app's defaults.
Instead of one server at a time, a handful of "recent" threads, and per-server
search, Harmony aims to show *everything you have access to* in one place and make
retrieval — "where was I mentioned?", "what did I post?", "every thread in this
channel" — a first-class feature.

> **Status: early / pre-alpha.** A working vertical slice exists (sign-in,
> unified channel list, message reading + posting + replies, threads, DMs with
> presence). Large parts of the vision are not built yet. See
> [Roadmap](#roadmap). macOS is the only platform exercised so far.

---

## Table of contents

- [Why](#why)
- [Features](#features)
- [Screenshots](#screenshots)
- [Architecture](#architecture)
- [Getting started](#getting-started)
- [Usage](#usage)
- [Project structure](#project-structure)
- [Development](#development)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Disclaimer](#disclaimer)
- [License](#license)
- [Acknowledgements](#acknowledgements)

---

## Why

The official Discord client optimises for being present in one channel at a time,
and it hides information to reduce clutter: only one server's channels are visible,
inactive/muted channels disappear, old threads become unreachable, and there is no
cross-server view of anything — not channels, not threads, not your mentions, not
your own history.

Harmony's organising principles:

1. **Everything is visible by default; you filter *down*, not *up*.**
2. **Retrieval is first-class** — mentions of you and your own posts are permanent,
   searchable views, not a search you rebuild each time.
3. **You control the layout** — pin, reorder, collapse, hide, and it persists.
4. **Keyboard-friendly.**

The full product spec lives in [`docs/requirements.md`](docs/requirements.md).

---

## Features

**Working today**

- **Sign in once** via Discord's real login page (QR code recommended); session is
  stored encrypted and restored on launch.
- **Unified channel list** — every text channel across every server in one tree,
  or scoped to a single server. Group DMs show their members inline.
- **Category controls** — sort categories alphabetically or by most-recent
  message; filter to unread only; hide muted channels.
- **Threads** — joined threads in the sidebar, plus a per-channel panel listing
  *all* threads (active **and** archived), not just the recent few.
- **Direct messages** — a dedicated mode with 1:1 and group DMs, live presence
  dots (online / idle / DND / offline), and group-member sublists.
- **Read, post, and reply** — message history, a composer, and proper
  reply-to-a-message with an optional ping toggle. Works in channels, threads,
  and DMs.
- **Offline-friendly** — an encrypted local snapshot paints the UI instantly on
  launch, before the gateway reconnects.

**Planned** (not yet implemented): pin threads and categories, hide empty
categories, a cross-server **Mentions inbox** and **My Messages** view with
search-within, message **bookmarks**, Markdown/mention rendering, live updates in
the open channel, scroll-back, SQLite + full-text index. See [Roadmap](#roadmap).

Out of scope: voice, video, stage channels, and server administration.

---

## Screenshots

_TODO: add screenshots once the UI stabilises._

---

## Architecture

- **Electron + React + TypeScript**, built with `electron-vite`.
- The **main process** runs the sync engine: a WebSocket gateway client, a
  rate-limit-aware REST client, and an in-memory store that ingests gateway events
  and derives the view model. It persists an encrypted JSON snapshot (SQLite is
  planned).
- The **renderer** is a React app. It never talks to Discord directly —
  everything goes through a small typed IPC surface (`window.harmony`).
- **Auth**: Harmony authenticates as your own Discord account. It embeds Discord's
  real login page and captures the account token from the `Authorization` header;
  it never implements its own credential form (CAPTCHA / MFA / email verification
  are handled by Discord's page). The token is stored in the OS-encrypted store.

```
Discord gateway (WebSocket) ─▶ Gateway ─▶ Store.ingest ─▶ Store.getState()
Discord REST API           ◀─ rest.ts ◀─ IPC handlers            │
                                                                 ▼
                                            IPC ─▶ window.harmony.onState ─▶ React
```

Deeper detail: [`docs/handoff.md`](docs/handoff.md) (state dump, data flow,
reverse-engineering notes) and [`docs/requirements.md`](docs/requirements.md)
(spec, §10–§11 cover the API/gateway specifics).

---

## Getting started

### Prerequisites

- **Node.js** 20+ (developed against a much newer version; Electron bundles its
  own Node 20).
- **macOS** — the only platform tested so far. Windows/Linux are not yet
  supported.
- A **Discord account**.

### Install

```bash
git clone <this-repo> harmony
cd harmony
npm install
```

Two install quirks you may hit on a fresh machine (npm 11):

1. **Install scripts are gated.** `package.json` approves the ones needed via an
   `allowScripts` block. If Electron/esbuild postinstall didn't run:

   ```bash
   npm install-scripts approve electron esbuild
   npm rebuild electron esbuild
   ```

2. **The Electron binary may not extract.** If `node -e "require('electron')"`
   errors with *"Electron failed to install correctly"*, unpack the cached zip
   manually:

   ```bash
   rm -rf node_modules/electron/dist && mkdir -p node_modules/electron/dist
   unzip -q ~/Library/Caches/electron/*/electron-v*-darwin-*.zip -d node_modules/electron/dist
   printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
   ```

### Run

```bash
npm run dev
```

Electron launches with a sign-in screen. Use the **QR code** in the pop-up window
(scan it with the Discord mobile app) — no password or CAPTCHA needed. Your
session is then remembered between launches.

---

## Usage

See [`docs/user-guide.md`](docs/user-guide.md) for a full walkthrough. Quick
reference:

- **Top-left switch** toggles **Servers** and **Direct Messages**.
- **Enter** sends a message; **Shift+Enter** adds a newline.
- **Hover a message → ↩** to reply; toggle **Ping** in the reply bar; **Esc**
  cancels.
- In a channel header, **`〰️ Threads (N)`** opens the all-threads panel.

---

## Project structure

```
harmony/
├── docs/
│   ├── requirements.md   Product spec — vision, feature requirements, API/gateway notes
│   ├── user-guide.md     End-user how-to for what's built
│   └── handoff.md        Full engineering state dump / onboarding
├── src/
│   ├── shared/           Types shared between main and renderer
│   ├── main/             Electron main: auth, gateway, REST, store, IPC
│   ├── preload/          contextBridge -> window.harmony
│   └── renderer/         React app (App, MessagePane, styles)
├── electron.vite.config.ts
├── tsconfig.json
└── package.json
```

---

## Development

| Command | What it does |
|---|---|
| `npm run dev` | Build main/preload, start the renderer dev server, launch Electron. |
| `npm run typecheck` | `tsc --noEmit` over the whole project. |
| `npm run build` | `electron-vite build` (packaging is not yet configured). |

Notes:

- Editing files under `src/main/**` requires stopping and re-running `npm run dev`;
  the renderer hot-reloads on its own.
- There is no test suite yet.
- Local data (encrypted token + snapshot) lives in
  `~/Library/Application Support/harmony/`. Delete it to start clean.

---

## Roadmap

Roughly in priority order:

- [ ] Live message updates in the open channel; scroll-back / history paging
- [ ] Markdown rendering; resolve `@mentions`, `#channels`, custom emoji
- [ ] Pin threads, pin/reorder categories, hide empty categories
- [ ] **Mentions inbox** — every message that tags you, across servers, searchable
- [ ] **My Messages** — one-click list of everything you've posted, searchable
- [ ] **Bookmarks** — save any message to a private, searchable list
- [ ] Attachments, emoji/sticker picker, reactions, edit/delete, typing indicator
- [ ] SQLite + full-text search index (replacing the JSON snapshot)
- [ ] Windows / Linux builds; packaging, signing, auto-update
- [ ] Tests

The authoritative, detailed version is in
[`docs/requirements.md`](docs/requirements.md).

---

## Contributing

Contributions are welcome. This is an early project, so the most useful things
right now are: trying it, filing issues with clear reproduction steps, and small
focused pull requests.

- Discuss anything non-trivial in an issue first.
- Keep PRs scoped to one change; run `npm run typecheck` before opening one.
- Match the surrounding code style.
- By contributing you agree your work is licensed under the project's license
  (see below).

_A `CONTRIBUTING.md` and issue/PR templates will be added as the project
formalises._

---

## Disclaimer

Harmony works by automating your own Discord account (the same thing
"self-bot" / third-party clients do). **This is against
[Discord's Terms of Service](https://discord.com/terms), and using it carries a
real risk of your account being suspended or terminated.** Use it with that
understanding, and prefer a secondary account if that risk is unacceptable to you.

Harmony is an independent project. It is not affiliated with, endorsed by, or
sponsored by Discord Inc. "Discord" is a trademark of Discord Inc. The client
relies on undocumented, private API behaviour that can change or break without
notice.

No warranty of any kind. You are responsible for how you use it.

---

## License

Not yet chosen. Until a `LICENSE` file is added, no permissions are granted beyond
viewing the source. A permissive open-source license is intended.

---

## Acknowledgements

- The broader third-party Discord client and client-mod community, whose
  reverse-engineering work over the years documented much of what Harmony relies
  on.
- Built with [Electron](https://www.electronjs.org/),
  [electron-vite](https://electron-vite.org/),
  [React](https://react.dev/), and [Vite](https://vitejs.dev/).
