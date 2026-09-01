/**
 * The dev server's byte-read door has the SAME jail and the SAME cap as the
 * Rust command it stands in for.
 *
 * `fs_read_bytes` (src-tauri/src/commands/filesystem.rs) resolves through
 * resolve_path -> contain_within and refuses anything over 16 MiB. In the
 * browser dev surface there is no Rust, so vite.config.ts's
 * /local-api/fs-read-bytes middleware carries the boundary — these tests pin
 * the pure half of that middleware, case by case against the Rust unit tests
 * next to `fs_read_bytes`.
 *
 * NEGATIVE CONTROL (verified by hand): make containWithin return the candidate
 * unconditionally and every escape case below goes red; drop the `Math.min` in
 * effectiveByteCap and "a caller cannot raise the ceiling" goes red.
 *
 * Run: npx vitest run src/lib/__tests__/dev-fs-jail.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  devResolveWithinJail,
  devWorkspaceRoot,
  containWithin,
  lexicalNormalize,
  isAbsolutePath,
  normalizeDuplicateDrivePrefix,
  effectiveByteCap,
  DEV_READ_BYTES_CAP,
  JailEscapeError,
} from '../dev-fs-jail'
// Der Ordnername kommt aus app-identity (dieser Branch hängt einen Suffix an),
// damit die Zusicherungen den Namen nicht gegen sich selbst ausspielen.
import { AGENT_WORKSPACE_DIR as WS } from '../app-identity'

const HOME = '/Users/dev'
const ROOT = '/Users/dev/projects/lu'

describe('devWorkspaceRoot', () => {
  it('prefers the picked folder workspace', () => {
    expect(devWorkspaceRoot(HOME, 'chat-1', ROOT)).toBe(ROOT)
  })

  it('falls back to the per-chat sandbox', () => {
    expect(devWorkspaceRoot(HOME, 'chat-1', '')).toBe(`/Users/dev/${WS}/chat-1`)
    expect(devWorkspaceRoot(HOME, null, null)).toBe(`/Users/dev/${WS}/default`)
  })

  it('sanitises the chat id the way the Rust side does', () => {
    // Der Punkt wird ERSETZT, nicht durchgelassen. Diese Zusicherung stand
    // hier als `.._.._etc` und hat damit den IPC-1-Fehler festgeschrieben:
    // ein `..`, das die Sanitisierung überlebt, kollabiert die Käfigwurzel in
    // `lexicalNormalize` auf `$HOME`. Die vollständige Gegenüberstellung mit
    // `agent::sanitize_chat_slug` steht in dev-fs-jail-slug.test.ts.
    expect(devWorkspaceRoot(HOME, '../../etc', null)).toBe(`/Users/dev/${WS}/______etc`)
    expect(devWorkspaceRoot(HOME, 'a/b c', null)).toBe(`/Users/dev/${WS}/a_b_c`)
    expect(devWorkspaceRoot(HOME, '..', null)).toBe(`/Users/dev/${WS}/__`)
  })

  it('caps the chat id at 64 chars', () => {
    const long = 'a'.repeat(200)
    expect(devWorkspaceRoot(HOME, long, null)).toBe(`/Users/dev/${WS}/${'a'.repeat(64)}`)
  })
})

describe('the jail', () => {
  it('resolves a relative path inside the root', () => {
    expect(devResolveWithinJail({ path: 'src/app.ts', homeDir: HOME, workingDirectory: ROOT })).toBe(
      `${ROOT}/src/app.ts`,
    )
  })

  it('accepts an absolute path that already sits inside the root', () => {
    expect(
      devResolveWithinJail({ path: `${ROOT}/assets/logo.png`, homeDir: HOME, workingDirectory: ROOT }),
    ).toBe(`${ROOT}/assets/logo.png`)
  })

  it('refuses a climb out of the root', () => {
    expect(() =>
      devResolveWithinJail({ path: '../../.ssh/id_rsa', homeDir: HOME, workingDirectory: ROOT }),
    ).toThrow(JailEscapeError)
  })

  it('refuses an absolute path outside the root', () => {
    expect(() =>
      devResolveWithinJail({ path: '/etc/passwd', homeDir: HOME, workingDirectory: ROOT }),
    ).toThrow(JailEscapeError)
    expect(() =>
      devResolveWithinJail({ path: '/Users/dev/.ssh/id_rsa', homeDir: HOME, workingDirectory: ROOT }),
    ).toThrow(JailEscapeError)
  })

  it('refuses a sibling folder that merely shares the root prefix', () => {
    expect(() => containWithin('/w/root', '/w/rootless/secret')).toThrow(JailEscapeError)
  })

  it('jails the per-chat sandbox too, not just a picked folder', () => {
    expect(devResolveWithinJail({ path: 'note.txt', homeDir: HOME, chatId: 'c1' })).toBe(
      `/Users/dev/${WS}/c1/note.txt`,
    )
    expect(() =>
      devResolveWithinJail({ path: '../c2/note.txt', homeDir: HOME, chatId: 'c1' }),
    ).toThrow(JailEscapeError)
  })

  it('lets the root itself through', () => {
    expect(containWithin(ROOT, '.')).toBe(ROOT)
  })

  it('handles a backslash climb (the dev server also runs on Windows)', () => {
    expect(() => containWithin('C:/work/lu', '..\\..\\Windows\\System32\\config')).toThrow(
      JailEscapeError,
    )
    expect(containWithin('C:/work/lu', 'src\\main.ts')).toBe('C:/work/lu/src/main.ts')
  })

  it('compares Windows roots case-insensitively', () => {
    expect(containWithin('C:/Work/LU', 'c:/work/lu/src/a.ts')).toBe('c:/work/lu/src/a.ts')
  })

  it('strips a duplicated drive prefix before judging', () => {
    expect(normalizeDuplicateDrivePrefix('D:/a/D:/a/file.txt')).toBe('D:/a/file.txt')
    expect(containWithin('D:/a', 'D:/a/D:/a/file.txt')).toBe('D:/a/file.txt')
  })
})

describe('path primitives', () => {
  it('normalizes . and .. lexically', () => {
    expect(lexicalNormalize('/a/b/../c/./d')).toBe('/a/c/d')
    expect(lexicalNormalize('a/../../b')).toBe('b')
    expect(lexicalNormalize('C:\\a\\b\\..\\c')).toBe('C:/a/c')
  })

  it('knows an absolute path on both platforms', () => {
    expect(isAbsolutePath('/etc')).toBe(true)
    expect(isAbsolutePath('C:\\Windows')).toBe(true)
    expect(isAbsolutePath('c:/windows')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share')).toBe(true)
    expect(isAbsolutePath('src/app.ts')).toBe(false)
    expect(isAbsolutePath('')).toBe(false)
  })
})

describe('the byte cap', () => {
  it('matches READ_BYTES_CAP in filesystem.rs', () => {
    expect(DEV_READ_BYTES_CAP).toBe(16 * 1024 * 1024)
  })

  it('defaults to the ceiling', () => {
    expect(effectiveByteCap(undefined)).toBe(DEV_READ_BYTES_CAP)
    expect(effectiveByteCap(null)).toBe(DEV_READ_BYTES_CAP)
    expect(effectiveByteCap(0)).toBe(DEV_READ_BYTES_CAP)
  })

  it('honours a SMALLER request', () => {
    expect(effectiveByteCap(1024)).toBe(1024)
  })

  it('a caller cannot raise the ceiling', () => {
    expect(effectiveByteCap(1024 * 1024 * 1024)).toBe(DEV_READ_BYTES_CAP)
  })
})
