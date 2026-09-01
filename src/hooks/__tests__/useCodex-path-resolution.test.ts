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

// ────────────────────────────────────────────────────────────────────────
// `toolArgs.path` ist Modell-Ausgabe, keine Zusage (0e740f60).
//
// Derselbe Block wie oben, eine Zeile hoeher: `const p: string =
// toolArgs.path` war eine BEHAUPTUNG ueber das, was das Modell geschickt hat.
// Ein Tool-Call `{"path": 42}` — bei kleinen Modellen keine Seltenheit — ging
// ungeprueft in `p.startsWith(…)` und warf einen TypeError aus der
// Tool-SCHLEIFE heraus, also nicht am Tool vorbei, sondern am ganzen Turn.
// Der Fix ist der `typeof`-Guard an der oeffnenden Bedingung; die Zahl
// erreicht damit das Tool, das sie mit seiner eigenen Meldung ablehnt.
//
// Was dieser Test ist und was nicht: er liest die QUELLE, so wie die
// Drift-Erkennung darueber. Ein Test, der den echten Tool-Loop faehrt, gibt
// es hier nicht — useCodex ist ein React-Hook, die vitest-Umgebung ist `node`
// (keine DOM), und weder @testing-library/react noch react-test-renderer sind
// Abhaengigkeiten dieses Projekts. Keine der 25 Dateien in diesem Verzeichnis
// rendert einen Hook; alle pruefen entweder ausgelagerte Logik oder den
// Quelltext. Diese Sonde ist damit ein Pin gegen das Zuruecknehmen des
// Guards, kein Verhaltensbeweis — und sie ist als solcher benannt.
// ────────────────────────────────────────────────────────────────────────

/**
 * Die Bedingung, unter der useCodex `toolArgs.path` als Zeichenkette liest —
 * aus der Quelle GEHOLT, nicht abgeschrieben. Verschwindet die gelesene Zeile,
 * scheitert der Test hier laut, statt still auf einer leeren Zeichenkette
 * weiterzulaufen.
 */
function theConditionGuardingThePathRead(source: string): string {
  const lines = source.split('\n')
  // Verankert am Zeilenanfang: der Kommentar direkt darueber ZITIERT die alte
  // Fassung derselben Zeile, und ein `includes` fände ihn zuerst.
  const at = lines.findIndex(l => /^\s*const p: string = toolArgs\.path\b/.test(l))
  if (at < 0) {
    throw new Error(
      'useCodex.ts liest `toolArgs.path` nicht mehr ueber `const p: string` — ' +
      'dieser Test muss mit dem Umbau mitziehen statt stumm gruen zu bleiben',
    )
  }
  for (let i = at - 1; i >= 0 && at - i <= 5; i--) {
    if (/^\s*if \(/.test(lines[i])) return lines[i]
  }
  throw new Error('ueber dem Pfad-Zugriff steht keine `if`-Zeile mehr')
}

describe('useCodex treats a model-supplied path as a string only when it is one', () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../useCodex.ts'),
    'utf8',
  )

  it('opens the path-rewrite branch behind a typeof check, not behind an annotation', () => {
    expect(theConditionGuardingThePathRead(src)).toContain("typeof toolArgs.path === 'string'")
  })

  it('keeps the empty-string skip the old truthiness guard already had', () => {
    // `''` ist ein String und wuerde den typeof-Test passieren; ohne die
    // Truthiness daneben haenge workDir sich an einen leeren Pfad.
    expect(theConditionGuardingThePathRead(src)).toMatch(/typeof toolArgs\.path === 'string' && toolArgs\.path/)
  })
})
