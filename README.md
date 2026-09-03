# Harmony

**An alternative Discord client built for seeing everything at once and finding things fast.**

Harmony is a desktop client for Discord that inverts the official app's defaults.
Instead of one server at a time, a handful of "recent" threads, and per-server
search, Harmony shows *everything you have access to* in one place and treats
retrieval — "where was I mentioned?", "what did I post?", "every thread in this
channel" — as a first-class feature.

> **Status: pre-alpha.** [Features](#features) lists what works and what does
> not. macOS is the only tested platform.

---

## Table of contents

- [Why](#why)
- [Features](#features)
- [Screenshots](#screenshots)
- [Architecture](#architecture)
- [Getting started](#getting-started)
- [Build & install locally](#build--install-locally)
- [Usage](#usage)
- [Project structure](#project-structure)
- [Development](#development)
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

**Works**

- **Sign in** via Discord's real login page (QR code recommended). The session is
  stored encrypted and restored on launch.
- **Unified channel list** — every text channel across every server in one tree,
  or scoped to a single server. Group DMs show their members inline.
- **Category controls** — sort alphabetically or by most-recent message; filter
  to unread only; hide muted channels.
- **Pin threads** — from the sidebar or the per-channel panel; pinned threads
  sort first. A **Pinned** mode lists every pinned thread across all servers with
  a server › channel breadcrumb, reorder, and unpin.
- **Pin, reorder, and collapse categories** — pinned categories float to the top
  of a server; collapse state persists.
- **Hide empty categories** — categories with no viewable channels (or, opt-in,
  no unread) are hidden, with a per-server toggle to reveal them.
- **Threads panel** — every thread in a channel, active **and** archived.
- **Direct messages** — a dedicated mode with 1:1 and group DMs, live presence
  dots (online / idle / DND / offline), and group-member sublists.
- **Read, post, and reply** — message history with scroll-back, live
  create/edit/delete in the open channel, a composer, and reply-to-a-message with
  an optional ping toggle. Works in channels, threads, and DMs.
- **Markdown rendering** — bold/italic/code/quotes/spoilers, resolved
  `@mentions` / `#channels`, custom emoji, `<t:…>` timestamps.
- **Local SQLite store** — mirrors gateway state so the UI paints on launch
  before the gateway connects. Includes an FTS5 table (not yet populated).

**Not built**

- Cross-server **Mentions inbox** and **My Messages** views with search-within.
- Message **bookmarks**.
- Global search UI / query language over the local index.
- Attachments, emoji/sticker picker, `@`/`#`/`:` autocomplete, reactions,
  edit/delete, typing indicator, mark-as-read, mute from Harmony.
- Command palette and full keyboard navigation.
- Desktop notifications.
- Notarised builds; auto-update; Windows/Linux testing.

Out of scope: voice, video, stage channels, and server administration.

---

## Screenshots

_None yet._

---

## Architecture

- **Electron + React + TypeScript**, built with `electron-vite`.
- The **main process** runs the sync engine: a WebSocket gateway client, a
  rate-limit-aware REST client, and an in-memory store that ingests gateway events
  and derives the view model. It mirrors state to a local SQLite database
  (`better-sqlite3`), with a full-text index for retrieval.
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

- **Node.js** 20+ (Electron bundles its own Node 20).
- **macOS** — the only tested platform.
- A **Discord account**.

### Install

```bash
git clone <this-repo> harmony
cd harmony
npm install
```

Three install quirks you may hit on a fresh machine (npm 11):

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

3. **The `better-sqlite3` native module** is rebuilt against Electron's ABI by a
   `postinstall` step. If that was skipped or fails, run it yourself:

   ```bash
   npm run rebuild
   ```

### Run

```bash
npm run dev
```

Electron launches with a sign-in screen. Use the **QR code** in the pop-up window
(scan it with the Discord mobile app) — no password or CAPTCHA needed. Your
session is then remembered between launches.

`npm run dev` is the development loop (renderer hot-reload; restart it after
editing `src/main/**`). To run the app the way an end user would, build and
install it — see below.

---

## Build & install locally

To produce an installable macOS app bundle:

```bash
npm run dist:local
```

This writes **`dist/mac-arm64/Harmony.app`** — a real, code-signed[^sign] app —
reusing the Electron runtime already in `node_modules/`, so it needs no network.
The first run takes a couple of minutes (it rebuilds the `better-sqlite3` native
module for the target and signs the ~250 MB bundle); later runs are quicker.
`dist:local` targets **Apple Silicon**.

| Command | Output |
|---|---|
| `npm run dist:local` | `dist/mac-arm64/Harmony.app` — arm64, unpacked, fully offline. |
| `npm run dist` | Full set: `.dmg` + `.zip` (macOS arm64/x64), NSIS installer + `.zip` (Windows), `.AppImage` + `.deb` (Linux). Downloads the Electron runtime per target on first run, then caches it. |
| push a `vX.Y.Z` tag | CI ([`.github/workflows/build.yml`](.github/workflows/build.yml)) builds all three platforms and opens a draft GitHub Release with the installers attached. |

### Install (macOS)

```bash
cp -R dist/mac-arm64/Harmony.app /Applications/
```

The build is **not notarised**, so Gatekeeper blocks the first launch. Either
right-click the app in Finder → **Open** → **Open**, or clear the quarantine
flag:

```bash
xattr -dr com.apple.quarantine /Applications/Harmony.app
```

It launches normally after that. Sign in with the QR code as in [Run](#run).

[^sign]: Signed with whatever code-signing identity is in your keychain, or
ad-hoc if there is none — not an Apple-notarised Developer ID build.

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
├── electron.vite.config.ts  Bundling (main / preload / renderer)
├── electron-builder.yml     App packaging (dmg / zip / nsis / AppImage / deb)
├── vitest.config.ts
├── tsconfig.json
└── package.json
```

---

## Development

| Command | What it does |
|---|---|
| `npm run dev` | Build main/preload, start the renderer dev server, launch Electron (renderer hot-reloads). |
| `npm run typecheck` | `tsc --noEmit` over the whole project, tests included. |
| `npm test` | Vitest unit + component suite (`npm run test:watch` to watch). |
| `npm run build` | `electron-vite build` → `out/` (bundles only, no app packaging). |
| `npm run dist:local` / `npm run dist` | Package an app bundle — see [Build & install locally](#build--install-locally). |

Notes:

- Editing files under `src/main/**` requires stopping and re-running `npm run dev`;
  the renderer hot-reloads on its own.
- Local data — the encrypted token, a dev encryption key (`dev-secret.key`), and
  the SQLite database (`harmony.db`) — lives in
  `~/Library/Application Support/harmony/`. Delete it to start clean.

---

## Contributing

The full spec is in [`docs/requirements.md`](docs/requirements.md); the
[Features](#features) list tracks what is and isn't built.

- Discuss anything non-trivial in an issue first.
- Keep PRs scoped to one change. Run `npm run typecheck` and `npm test` before
  opening one.
- Match the surrounding code style.
- By contributing you agree your work is licensed under the project's license
  (see below).

There is no `CONTRIBUTING.md` or issue/PR template.

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

GNU General Public License v3.0. See [`LICENSE`](LICENSE).

---

## Acknowledgements

- The broader third-party Discord client and client-mod community, whose
  reverse-engineering work over the years documented much of what Harmony relies
  on.
- Built with [Electron](https://www.electronjs.org/),
  [electron-vite](https://electron-vite.org/),
  [React](https://react.dev/), and [Vite](https://vitejs.dev/).
