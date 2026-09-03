import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dir = mkdtempSync(join(tmpdir(), 'harmony-sec-'))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => dir },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: () => {
      throw new Error('unavailable')
    }
  }
}))

// eslint-disable-next-line import/first
import { readSecure, removeSecure, writeSecure } from './secure-file'

const file = join(dir, 'token.bin')

beforeEach(() => removeSecure(file))
afterEach(() => removeSecure(file))

describe('secure-file dev box', () => {
  it('round-trips a value across write/read', () => {
    writeSecure(file, 'super-secret-token-0123456789')
    expect(readSecure(file)).toBe('super-secret-token-0123456789')
  })

  it('writes with the dev1 header (not plaintext)', () => {
    writeSecure(file, 'hello')
    const raw = readFileSync(file, 'utf8')
    expect(raw.startsWith('dev1\n')).toBe(true)
    expect(raw).not.toContain('hello')
  })

  it('returns null and discards a tampered file', () => {
    writeSecure(file, 'value')
    const raw = readFileSync(file, 'utf8')
    writeFileSync(file, raw.slice(0, -4) + 'AAAA') // corrupt the ciphertext tail
    expect(readSecure(file)).toBeNull()
    expect(existsSync(file)).toBe(false)
  })

  it('reads a legacy plain\\n file and migrates it to the dev box', () => {
    writeFileSync(file, 'plain\nlegacy-token')
    expect(readSecure(file)).toBe('legacy-token')
    expect(readFileSync(file, 'utf8').startsWith('dev1\n')).toBe(true)
  })

  it('returns null for a missing file', () => {
    expect(readSecure(join(dir, 'nope.bin'))).toBeNull()
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))
})
