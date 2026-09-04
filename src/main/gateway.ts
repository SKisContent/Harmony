import { EventEmitter } from 'node:events'
import WebSocket from 'ws'

const DEFAULT_GATEWAY = 'wss://gateway.discord.gg/?v=9&encoding=json'

// The real web client's IDENTIFY properties (docs/requirements.md §11.1 / NFR-5).
// client_build_number is a fixed value here; the real client reads it from the
// current web bundle.
const CLIENT_PROPERTIES = {
  os: 'Mac OS X',
  browser: 'Chrome',
  device: '',
  system_locale: 'en-US',
  browser_user_agent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  browser_version: '152.0.0.0',
  os_version: '10.15.7',
  referrer: '',
  referring_domain: '',
  referrer_current: '',
  referring_domain_current: '',
  release_channel: 'stable',
  client_build_number: 605958,
  client_event_source: null
}

export interface GatewayEvents {
  status: [state: string, detail?: string]
  dispatch: [type: string, data: any]
  error: [err: Error]
}

/**
 * Minimal Discord gateway client: IDENTIFY, heartbeat, RESUME, reconnect.
 * Emits every dispatch as ('dispatch', type, data); the store decides what to keep.
 */
export class Gateway extends EventEmitter {
  private token: string
  private ws?: WebSocket
  private seq: number | null = null
  private sessionId?: string
  private resumeUrl?: string
  private hbTimer?: NodeJS.Timeout
  private hbAcked = true
  private closedByUs = false
  private reconnectDelay = 1000

  constructor(token: string) {
    super()
    this.token = token
  }

  connect(url = this.resumeUrl ? `${this.resumeUrl}/?v=9&encoding=json` : DEFAULT_GATEWAY): void {
    this.closedByUs = false
    this.emit('status', 'connecting')
    const ws = new WebSocket(url)
    this.ws = ws

    ws.on('open', () => this.emit('status', 'connecting', 'socket open'))
    ws.on('message', (raw) => {
      let payload: any
      try {
        payload = JSON.parse(raw.toString())
      } catch (e) {
        this.emit('error', e as Error)
        return
      }
      this.handle(payload)
    })
    ws.on('error', (e) => this.emit('error', e as Error))
    ws.on('close', (code) => {
      this.stopHeartbeat()
      console.log('[gateway] socket closed, code', code, this.closedByUs ? '(by us)' : '')
      if (this.closedByUs) {
        this.emit('status', 'closed', `code ${code}`)
        return
      }
      // 4004 auth failed · 4010/4011/4012/4013/4014 fatal identify problems
      if ([4004, 4010, 4011, 4012, 4013, 4014].includes(code)) {
        this.emit('error', new Error(`Gateway rejected the token (close ${code}). Sign in again.`))
        this.emit('status', 'error', `token rejected (${code})`)
        return
      }
      this.emit('status', 'reconnecting', `socket closed (${code})`)
      setTimeout(() => this.connect(), this.reconnectDelay)
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000)
    })
  }

  disconnect(): void {
    this.closedByUs = true
    this.stopHeartbeat()
    this.ws?.close()
  }

  private handle(payload: { op: number; d: any; s: number | null; t: string | null }): void {
    const { op, d, s, t } = payload
    if (typeof s === 'number') this.seq = s

    switch (op) {
      case 10: // HELLO
        this.startHeartbeat(d.heartbeat_interval)
        if (this.sessionId && this.seq != null) this.resume()
        else this.identify()
        break
      case 11: // HEARTBEAT ACK
        this.hbAcked = true
        break
      case 1: // server asked for a heartbeat now
        this.sendHeartbeat()
        break
      case 7: // RECONNECT
        this.ws?.close(4000)
        break
      case 9: // INVALID SESSION
        this.sessionId = undefined
        this.seq = null
        setTimeout(() => this.identify(), 1500 + Math.random() * 3000)
        break
      case 0: // DISPATCH
        if (t === 'READY') {
          this.sessionId = d.session_id
          this.resumeUrl = d.resume_gateway_url
          this.reconnectDelay = 1000
        }
        this.emit('dispatch', t, d)
        break
    }
  }

  private identify(): void {
    this.emit('status', 'identifying')
    this.send(2, {
      token: this.token,
      capabilities: 161789,
      properties: CLIENT_PROPERTIES,
      compress: false,
      presence: { status: 'unknown', since: 0, activities: [], afk: false },
      client_state: { guild_versions: {} }
    })
  }

  private resume(): void {
    this.emit('status', 'connecting', 'resuming')
    this.send(6, { token: this.token, session_id: this.sessionId, seq: this.seq })
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat()
    this.hbAcked = true
    // jittered first beat, per Discord's guidance
    setTimeout(() => this.sendHeartbeat(), intervalMs * Math.random())
    this.hbTimer = setInterval(() => {
      if (!this.hbAcked) {
        this.ws?.close(4009) // zombied connection
        return
      }
      this.sendHeartbeat()
    }, intervalMs)
  }

  private stopHeartbeat(): void {
    if (this.hbTimer) clearInterval(this.hbTimer)
    this.hbTimer = undefined
  }

  private sendHeartbeat(): void {
    this.hbAcked = false
    this.send(1, this.seq)
  }

  private send(op: number, d: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op, d }))
  }
}
