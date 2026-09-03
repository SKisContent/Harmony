import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { safeStorage } from 'electron'

// Persist small secrets/snapshots with a self-describing header so a later run can
// always read back what an earlier run wrote — even if safeStorage availability
// flipped between the two runs (a real macOS-dev gotcha), and even for files
// written by an earlier, header-less version of this code.
//
//   bytes 0..4 : "enc1\n"  -> rest is base64(ciphertext)
//   bytes 0..5 : "plain\n" -> rest is utf8 plaintext
//   otherwise  : legacy    -> try decrypt, else treat whole file as utf8

const ENC = 'enc1\n'
const PLAIN = 'plain\n'

export function writeSecure(path: string, value: string): void {
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

    if (head.startsWith(ENC)) {
      try {
        return safeStorage.decryptString(Buffer.from(buf.subarray(ENC.length).toString('utf8'), 'base64'))
      } catch (e) {
        console.error('[secure-file] enc1 decrypt failed:', (e as Error).message)
        return null
      }
    }
    if (head.startsWith(PLAIN)) {
      return buf.subarray(PLAIN.length).toString('utf8') || null
    }

    // legacy header-less file: an encrypted Buffer, or raw utf8
    try {
      const dec = safeStorage.decryptString(buf)
      // migrate it to the tagged format on the way out
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
