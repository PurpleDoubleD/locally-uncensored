/**
 * TEST-LOGIN (3.1.3): the test build's sign in with the fixed test account
 * (src-tauri/src/test_login.rs, src/lib/test-login.ts) must never reach a
 * shipped build, and even in a test build it lets in only the accounts its
 * allow list names.
 *
 * The proof on real builds (a release web bundle and a program built without
 * the feature carry no trace, the test build does) runs with
 * scripts/check-no-test-login.sh, see the TEST-LOGIN section of the 3.1.3
 * report; the release workflow runs the same script on every build.
 *
 * Run: npx vitest run src/lib/__tests__/test-login-never-ships.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isAllowed, runTestLogin, TEST_LOGIN_MARKER, type TestLoginDeps } from '../test-login'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')
/** Source without comments, so a sentence that names a thing is not a use of it. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')

describe('the feature stays out of every shipped build', () => {
  it('is no default and no other feature turns it on', () => {
    const features = read('src-tauri/Cargo.toml').split('[features]')[1]?.split(/\n\[/)[0] ?? ''
    const lines = features.split('\n').filter((l) => /=/.test(l) && !l.trim().startsWith('#'))
    expect(lines.some((l) => l.replace(/\s/g, '') === 'test-login=[]')).toBe(true)
    for (const l of lines) {
      if (l.trim().startsWith('test-login')) continue
      expect(l, `feature line enables it: ${l}`).not.toMatch(/test-login/)
    }
  })

  it('no workflow, npm script or build script builds with it', () => {
    const files = [
      'package.json',
      ...readdirSync(join(root, '.github/workflows')).map((f) => `.github/workflows/${f}`),
      ...readdirSync(join(root, 'scripts')).filter((f) => /\.(sh|mjs|js|ps1)$/.test(f)).map((f) => `scripts/${f}`),
      ...readdirSync(join(root, 'src-tauri')).filter((f) => /^tauri.*\.conf\.json$/.test(f)).map((f) => `src-tauri/${f}`),
    ].filter((f) => existsSync(join(root, f)))
    expect(files.length).toBeGreaterThan(5)
    for (const f of files) {
      expect(read(f), f).not.toMatch(/features?[\s=,"']+[^\n]*test-login/)
      expect(read(f), f).not.toMatch(/VITE_LU_TEST_LOGIN\s*[:=]/)
    }
  })

  it('every Rust trace sits behind the feature gate', () => {
    const lib = code(read('src-tauri/src/lib.rs'))
    for (const use of ['mod test_login;', 'test_login::test_login_take,', 'test_login::read_token_if_asked();']) {
      const at = lib.indexOf(use)
      expect(at, use).toBeGreaterThan(-1)
      expect(lib.slice(0, at).trimEnd().endsWith('#[cfg(feature = "test-login")]'), use).toBe(true)
    }
    expect((lib.match(/test_login::/g) ?? []).length).toBe(2)
  })

  it('the web half is imported once, behind the compile time constant', () => {
    const app = code(read('src/App.tsx'))
    const at = app.indexOf("import('./lib/test-login')")
    expect(at).toBeGreaterThan(-1)
    expect(app.slice(Math.max(0, at - 160), at)).toMatch(/if \(import\.meta\.env\.VITE_LU_TEST_LOGIN === '1'\) \{\s*void $/)
    // No other file of the app reaches it.
    const others = execFileSync('git', ['grep', '-l', 'test-login', '--', 'src'], { cwd: root, encoding: 'utf8' })
      .split('\n').filter(Boolean)
      .filter((f) => !f.includes('__tests__') && f !== 'src/App.tsx' && f !== 'src/lib/test-login.ts')
    expect(others).toEqual([])
  })

  it('the release workflow runs the guard after every build', () => {
    const wf = read('.github/workflows/release.yml')
    const guards = wf.match(/bash scripts\/check-no-test-login\.sh dist src-tauri\/target\/release\/bundle \$progs/g) ?? []
    expect(guards.length).toBe(3)
  })
})

describe('the guard script', () => {
  const run = (...paths: string[]) => {
    try {
      execFileSync('bash', [join(root, 'scripts/check-no-test-login.sh'), ...paths], { encoding: 'utf8', stdio: 'pipe' })
      return 0
    } catch (e) {
      return (e as { status?: number }).status ?? -1
    }
  }
  it('passes a clean build and fails one with any of the three traces', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lu-tl-'))
    writeFileSync(join(dir, 'index.js'), 'console.log("plain app")')
    writeFileSync(join(dir, 'prog'), Buffer.from([0, 1, 2, 3, 0x41, 0x42, 0]))
    expect(run(dir)).toBe(0)
    for (const trace of [TEST_LOGIN_MARKER, 'test_login_take', '--test-login-stdin']) {
      const bad = mkdtempSync(join(tmpdir(), 'lu-tl-'))
      writeFileSync(join(bad, 'prog'), Buffer.concat([Buffer.from([0, 7, 0]), Buffer.from(trace), Buffer.from([0])]))
      expect(run(dir, bad), trace).toBe(1)
    }
  })
  it('a missing path is an error, not a pass', () => {
    expect(run(join(tmpdir(), 'lu-tl-does-not-exist'))).toBe(2)
  })
})

describe('the sign in itself (test build)', () => {
  const session = (email: string | null) => ({ email, accessToken: 'a', refreshToken: 'r' })
  const deps = (email: string | null, over: Partial<TestLoginDeps> = {}) => {
    const d = {
      take: vi.fn(async () => ({ tokenHash: '0123456789abcdef0123', allow: ['Test@example.com'] })),
      verify: vi.fn(async () => session(email)),
      adopt: vi.fn(async () => {}),
      revoke: vi.fn(async () => {}),
      ...over,
    }
    return d
  }

  it('the test account is signed in', async () => {
    const d = deps('test@example.com')
    expect(await runTestLogin(d)).toBe('signed-in')
    expect(d.adopt).toHaveBeenCalledTimes(1)
    expect(d.revoke).not.toHaveBeenCalled()
  })

  it('any other account is refused, its session ended, the app stays signed out', async () => {
    const d = deps('someone@example.com')
    expect(await runTestLogin(d)).toBe('refused')
    expect(d.adopt).not.toHaveBeenCalled()
    expect(d.revoke).toHaveBeenCalledTimes(1)
  })

  it('no e-mail, no token, a failed check: nothing happens', async () => {
    expect(await runTestLogin(deps(null))).toBe('refused')
    expect(await runTestLogin(deps('test@example.com', { take: vi.fn(async () => null) }))).toBe('none')
    const failing = deps('test@example.com', { verify: vi.fn(async () => { throw new Error('expired') }) })
    expect(await runTestLogin(failing)).toBe('failed')
    expect(failing.adopt).not.toHaveBeenCalled()
  })

  it('the allow list is read case blind and never empty-matches', () => {
    expect(isAllowed(' TEST@example.com ', ['test@example.com'])).toBe(true)
    expect(isAllowed('', [''])).toBe(false)
    expect(isAllowed('a@b.c', [])).toBe(false)
  })
})
