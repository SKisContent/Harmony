import { BrowserWindow, app } from 'electron'
import { join } from 'node:path'
import { readSecure, removeSecure, writeSecure } from './secure-file'

// The account token is stored via secure-file. See docs/requirements.md XR-7
// for the account model.
const tokenPath = () => join(app.getPath('userData'), 'token.bin')

export function loadToken(): string | null {
  const t = readSecure(tokenPath())
  console.log('[auth] loadToken:', t ? `present (${t.length} chars)` : 'none')
  return t
}

export function saveToken(token: string): void {
  writeSecure(tokenPath(), token)
  console.log('[auth] saveToken: stored', token.length, 'chars')
}

export function clearToken(): void {
  removeSecure(tokenPath())
}

/**
 * Opens Discord's real login page in a window and captures the account token by
 * reading the `Authorization` header off the first authenticated API request.
 * Discord's own UI handles CAPTCHA / MFA / email-verify — we implement none of it.
 */
// A normal Chrome UA — Electron's default UA contains "Electron/…", which makes
// Discord's login page more suspicious (extra CAPTCHA, odd rejections).
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'

export function captureTokenViaLogin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 920,
      height: 820,
      title: 'Sign in to Discord',
      autoHideMenuBar: true,
      webPreferences: {
        partition: 'persist:discord-login',
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    win.webContents.setUserAgent(CHROME_UA)

    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
      if (!win.isDestroyed()) setTimeout(() => !win.isDestroyed() && win.close(), 400)
    }

    win.webContents.session.webRequest.onBeforeSendHeaders(
      { urls: ['https://discord.com/api/*', 'https://*.discord.com/api/*'] },
      (details, cb) => {
        const h = details.requestHeaders
        const raw = h['Authorization'] ?? h['authorization']
        // Discord sends the bare user token (not "Bearer ...") on client API calls.
        if (raw && !/^Bearer\s/i.test(raw) && raw.length > 40) {
          saveToken(raw)
          finish(() => resolve(raw))
        }
        cb({ requestHeaders: details.requestHeaders })
      }
    )

    win.on('closed', () => {
      if (!settled) reject(new Error('Login window closed before a token was captured'))
    })

    void win.loadURL('https://discord.com/login')
  })
}
