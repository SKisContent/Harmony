import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'

// Read/write a small secret to a file with a self-describing header:
//
//   "dev1\n"  -> base64(iv|tag|ciphertext), AES-256-GCM with a local key file
//   "enc1\n"  -> base64(safeStorage ciphertext), i.e. the OS keychain
//   "plain\n" -> utf8 plaintext
//   no header -> try safeStorage, else treat the whole file as utf8
//
// Packaged builds use safeStorage ("enc1"). Development uses the local key
// ("dev1"): an unsigned Electron's safeStorage key lives in the login Keychain
// under an ACL bound to the binary's ad-hoc signature, so launching it from a
// different path or under automation makes Chromium mint a fresh key and orphan
// everything encrypted with the old one.

const DEVBOX = 'dev1\n'
const ENC = 'enc1\n'
const PLAIN = 'plain\n'

const useDevBox = (): boolean => !app.isPackaged

function devKey(): Buffer {
  const path = join(app.getPath('userData'), 'dev-secret.key')
  if (existsSync(path)) return Buffer.from(readFileSync(path, 'utf8'), 'base64')
  const key = randomBytes(32)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, key.toString('base64'), { mode: 0o600 })
  return key
}

function devEncrypt(value: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', devKey(), iv)
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return DEVBOX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')
}

function devDecrypt(body: string): string {
  const raw = Buffer.from(body, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', devKey(), raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return decipher.update(raw.subarray(28), undefined, 'utf8') + decipher.final('utf8')
}

export function writeSecure(path: string, value: string): void {
  if (useDevBox()) {
    try {
      writeFileSync(path, devEncrypt(value), 'utf8')
      return
    } catch {
      /* fall through */
    }
  }
  try {
    if (safeStorage.isEncryptionAvailable()) {
      writeFileSync(path, ENC + safeStorage.encryptString(value).toString('base64'), 'utf8')
      return
    }
  } catch {
    /* fall through to plaintext */
  }
  writeFileSync(path, PLAIN + value, 'utf8')
}

export function readSecure(path: string): string | null {
  try {
    if (!existsSync(path)) return null
    const buf = readFileSync(path)
    const head = buf.subarray(0, 6).toString('latin1')

    if (head.startsWith(DEVBOX)) {
      try {
        return devDecrypt(buf.subarray(DEVBOX.length).toString('utf8'))
      } catch (e) {
        console.error('[secure-file] dev1 decrypt failed, discarding:', (e as Error).message)
        removeSecure(path)
        return null
      }
    }

    if (head.startsWith(ENC)) {
      try {
        const plain = safeStorage.decryptString(
          Buffer.from(buf.subarray(ENC.length).toString('utf8'), 'base64')
        )
        // in development, re-write in the dev1 format
        if (useDevBox()) writeSecure(path, plain)
        return plain
      } catch (e) {
        console.error('[secure-file] enc1 decrypt failed, discarding:', (e as Error).message)
        removeSecure(path)
        return null
      }
    }

    if (head.startsWith(PLAIN)) {
      const s = buf.subarray(PLAIN.length).toString('utf8')
      if (s && useDevBox()) writeSecure(path, s)
      return s || null
    }

    // header-less file: a safeStorage Buffer, or raw utf8
    try {
      const dec = safeStorage.decryptString(buf)
      writeSecure(path, dec)
      return dec
    } catch {
      const s = buf.toString('utf8')
      return s || null
    }
  } catch (e) {
    console.error('[secure-file] read failed for', path, (e as Error).message)
    return null
  }
}

export function removeSecure(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    /* nothing to remove */
  }
}
