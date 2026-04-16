/**
 * Regression tests for the Codex path-resolution bug.
 *
 * Before the fix in useCodex.ts, the absolute-path check was:
 *   !p.startsWith('/') && !p.startsWith('C:') && !p.startsWith('\\\\')
 * which incorrectly treated `D:/foo`, `E:/bar` (any non-C: drive) as RELATIVE
 * and prepended workDir, producing the doubled-path bug:
 *   workDir=D:/Pictures/foo, p=D:/Pictures/foo/x.html →
 *   D:/Pictures/foo/D:/Pictures/foo/x.html
 *
 * After the fix the check is:
 *   /^[a-zA-Z]:[/\\]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')
 * which recognises ALL drive letters as absolute.
 *
 * These tests exercise the absolute-path detection logic in isolation so we
 * never regress into the broken C:-only check again.
 */
import { describe, it, expect } from 'vitest'

// Standalone copy of the fixed absolute-path predicate — must stay in sync
// with useCodex.ts. The drift-detection test at the bottom re-reads the hook
// source to confirm parity.
function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[/\\]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')
}

// Mirrors the workDir-prepend block in useCodex.ts so we can assert on
// end-to-end behaviour (given workDir + path, what is the resolved path?).
function resolveCodexPath(p: string, workDir: string): string {
  if (isAbsolutePath(p) || !workDir) return p
  return workDir.replace(/\\/g, '/') + '/' + p
}

describe('useCodex absolute-path detection', () => {
  it('treats C: drive as absolute', () => {
    expect(isAbsolutePath('C:/foo/bar.txt')).toBe(true)
    expect(isAbsolutePath('C:\\foo\\bar.txt')).toBe(true)
  })

  it('treats D: drive as absolute (regression — previously broken)', () => {
    expect(isAbsolutePath('D:/Pictures/foo/bar.txt')).toBe(true)
    expect(isAbsolutePath('D:\\Pictures\\foo\\bar.txt')).toBe(true)
  })

  it('treats all other drive letters as absolute', () => {
    expect(isAbsolutePath('E:/foo')).toBe(true)
    expect(isAbsolutePath('F:/foo')).toBe(true)
    expect(isAbsolutePath('Z:/foo')).toBe(true)
  })

  it('treats lowercase drive letters as absolute', () => {
    expect(isAbsolutePath('d:/foo/bar.txt')).toBe(true)
    expect(isAbsolutePath('e:\\foo')).toBe(true)
  })

  it('treats Unix-absolute paths as absolute', () => {
    expect(isAbsolutePath('/etc/passwd')).toBe(true)
    expect(isAbsolutePath('/home/user/x.txt')).toBe(true)
  })

  it('treats UNC paths as absolute', () => {
    expect(isAbsolutePath('\\\\server\\share\\file.txt')).toBe(true)
  })

  it('treats relative paths as NOT absolute', () => {
    expect(isAbsolutePath('./foo.txt')).toBe(false)
    expect(isAbsolutePath('foo/bar.txt')).toBe(false)
    expect(isAbsolutePath('subdir/file.txt')).toBe(false)
    expect(isAbsolutePath('../up/x.txt')).toBe(false)
  })

  it('treats strings that LOOK like drive refs but are not, as relative', () => {
    // `X:filename` (no slash after colon) is ambiguous; we require a slash
    expect(isAbsolutePath('C:foo')).toBe(false)
    expect(isAbsolutePath('label:value')).toBe(false)
  })
})

describe('useCodex resolveCodexPath (end-to-end path doubling regression)', () => {
  const workDir = 'D:/Pictures/UbisoftConnect'

  it('does NOT double a D:/ path under a D:/ workDir (the user bug)', () => {
    const resolved = resolveCodexPath('D:/Pictures/UbisoftConnect/index.html', workDir)
    expect(resolved).toBe('D:/Pictures/UbisoftConnect/index.html')
    // The broken behaviour would have produced:
    //   D:/Pictures/UbisoftConnect/D:/Pictures/UbisoftConnect/index.html
    expect(resolved).not.toContain('UbisoftConnect/D:')
  })

  it('does NOT double a C:/ path under a D:/ workDir', () => {
    const resolved = resolveCodexPath('C:/Windows/x.dll', workDir)
    expect(resolved).toBe('C:/Windows/x.dll')
  })

  it('still prepends workDir for relative paths', () => {
    expect(resolveCodexPath('index.html', workDir)).toBe('D:/Pictures/UbisoftConnect/index.html')
    expect(resolveCodexPath('sub/file.txt', workDir)).toBe('D:/Pictures/UbisoftConnect/sub/file.txt')
  })

  it('leaves absolute Unix paths alone even with workDir set', () => {
    expect(resolveCodexPath('/tmp/x.txt', workDir)).toBe('/tmp/x.txt')
  })

  it('leaves UNC paths alone even with workDir set', () => {
    expect(resolveCodexPath('\\\\server\\share\\x.txt', workDir)).toBe('\\\\server\\share\\x.txt')
  })

  it('with no workDir, returns path as-is', () => {
    expect(resolveCodexPath('foo.txt', '')).toBe('foo.txt')
    expect(resolveCodexPath('D:/foo.txt', '')).toBe('D:/foo.txt')
  })
})

// ────────────────────────────────────────────────────────────────────────
// Drift detection — re-read useCodex.ts and assert it contains the updated
// regex (not the old C:-only check).
// ────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

describe('useCodex path-resolution drift detection', () => {
  it('matches the absolute-path regex currently in useCodex.ts', () => {
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = dirname(__filename)
    const src = readFileSync(join(__dirname, '../useCodex.ts'), 'utf8')

    // The hook must contain the updated regex (not the old C:-only check)
    expect(src).toMatch(/\/\^\[a-zA-Z\]:\[\/\\\\\]\//)
    // And must NOT contain the old broken C:-only check
    expect(src).not.toContain("!p.startsWith('C:') && !p.startsWith('\\\\\\\\')")
  })
})
