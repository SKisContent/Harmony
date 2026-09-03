# Harmony — User Guide

An alternative Discord client focused on seeing everything at once and finding
things fast. This guide covers what works today.

---

## 1. Signing in

Click **Sign in to Discord**. A window opens with Discord's own login page.

- **Easiest: QR code.** Scan the QR in that window with the Discord mobile app →
  Confirm. No password, no CAPTCHA.
- **Password:** type your email + password. Discord may add a CAPTCHA, an email
  "verify it's you" step, or a 2FA prompt — all handled by Discord's page.
  If you normally sign in with Google / Apple / a passkey, use the QR instead.
- **Paste a token:** *Paste a token instead* on the start screen, for advanced
  users. Get it from the Discord web app: DevTools → Network → any `/api/v9`
  request → Request Headers → `authorization`.

You stay signed in. On the next launch Harmony shows your cached list instantly
and reconnects in the background. If your session is ever rejected, a yellow bar
appears with **Retry** / **Sign in again** — your cached view stays visible.

**Sign out** is top-right. It clears the stored session and local cache.

---

## 2. The window

| Area | What it is |
|---|---|
| **Top bar** | Connection status, your name, and totals (servers · channels · unread · mentions). |
| **Left sidebar** | The mode switch, filters, and the channel or DM list. |
| **Main pane** | Messages for whatever you've selected, with the composer at the bottom. |
| **Right panel** | The Threads panel, when open. |

---

## 3. Servers vs Direct Messages

At the top of the sidebar, a two-way switch: **Servers** / **Direct Messages**.
A small red dot on the DM tab means you have an unread direct message.

### Servers mode

Controls at the top of the sidebar:

- **Server** — *All servers* (every channel you can read, grouped by server) or a
  single server.
- **Categories** — sort order for categories within each server:
  - *Alphabetical* (default)
  - *Most recent message* — categories with the newest activity float to the top.
- **Unread only** — hide channels with nothing new.
- **Hide muted** — hide channels/servers you've muted in Discord.

Channels that sit outside any category are listed first, above the sorted
categories.

**Icons in the list:**

| Icon | Meaning |
|---|---|
| 🟰 | Category |
| ➖ | Channel |
| 〰️ | Thread |

**Badges:**

- A solid dot = unread messages.
- A red number = messages that directly mention you.
- Dimmed row = muted.

### Direct Messages mode

The server/category controls disappear and the list becomes your DMs and group
DMs, most-recently-active first, each with an avatar, unread dot, and mention
badge. Click one to open it. *Unread only* still applies.

---

## 4. Threads

Threads show up in two places:

- **Under a channel in the sidebar** — threads you've joined appear indented
  beneath their channel with the 〰️ icon. Click to open.
- **The Threads panel** — open a channel and click **`〰️ Threads (N)`** at the
  right of the channel header. A panel opens on the right listing **every** thread
  in that channel — **Active** and **Archived**, not just the recent few. Click
  any to open it; the one you're viewing is highlighted. **✕** closes the panel.

A thread opens just like a channel — read it, post in it, reply in it.

---

## 5. Reading messages

Click a channel, thread, or DM. The pane loads the most recent messages.

- Consecutive messages from the same person within 5 minutes are grouped.
- Images preview inline; other attachments show as a 📎 link.
- A message that is itself a reply shows a "↳ replying to …" line.
- Embed-only messages show as `[1 embed]`.

The breadcrumb at the top shows **server › channel** (or **Direct Messages ›
name**, or a 〰️ for a thread).

---

## 6. Posting a message

Type in the box at the bottom.

- **Enter** — send.
- **Shift + Enter** — new line.
- The counter turns red past 2000 characters; **Send** is disabled while empty,
  over the limit, or sending.
- If Discord rejects it (rate limit, no permission, slowmode) the reason shows in
  red above the box.

Plain text only for now — no attachments, emoji picker, or `@`-autocomplete yet.

---

## 7. Replying to a specific message

1. **Hover the message** you want to reply to. A small **↩** button appears at its
   top-right.
2. Click it. A **reply bar** appears above the composer: *Replying to **name** —
   preview*.
3. Options in the bar:
   - **Ping** checkbox — on by default (notifies the person, like Discord).
     Uncheck to reply quietly.
   - **✕** — cancel the reply. **Esc** in the text box does the same.
4. Type your reply and press **Enter**.

The message being replied to is highlighted with a blue bar while you compose.
The result is a real Discord reply — it appears as one everywhere, not just here.
Works in channels, threads, and DMs.

---

## 8. Filters and layout preferences

These persist between launches:

- Servers / Direct Messages mode
- Selected server and category sort
- *Unread only* and *Hide muted*

---

## 9. Not yet built

Being honest about the edges:

- No live message updates in an open channel — reopen it to refresh. (Sidebar
  unread badges *do* update live.)
- No scrolling back beyond the most recent messages.
- No Markdown formatting; `@mentions` and `#channels` show as raw IDs.
- No attachments, emoji picker, reactions, typing indicator, or edit/delete.
- No pinning threads or categories, no hide-empty-categories, no mention inbox,
  no "my messages" view, no bookmarks — all planned (see `requirements.md`).
- Voice, video, and stage channels are out of scope.
