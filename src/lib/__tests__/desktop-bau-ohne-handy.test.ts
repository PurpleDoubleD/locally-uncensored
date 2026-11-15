/**
 * The desktop package carries no mobile shell (B12 of the check "the desktop
 * must not break"), and a desktop release cannot load one (C3).
 *
 * Both hang on one build variable, and since the integration with the
 * desktop of 3.0.6 it is the phone that names itself:
 *  - only VITE_LU_BUILD_TARGET=mobile packs the mobile shell,
 *  - no desktop build sets the variable, so the desktop configurations of
 *    Tauri, the CI and `npm run build` are what they are without a phone app,
 *  - the phone configurations, the build scripts of the phone, the dev server
 *    for the mobile shell and the Playwright project `mobile` set it,
 *  - main.tsx asks for it LITERALLY in front of the one import of src/mobile,
 *    because only a literal lets the bundler drop the branch (routed through
 *    a constant of another module the chunks stayed, measured 08.10.2026:
 *    454 JS files against 94).
 *
 * The second block builds the app twice and looks into the packages.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PHONE_VERSION_CONSTANT, PHONE_VERSION_META, phoneVersion } from '../../dev/phone-version'

const ROOT = resolve(__dirname, '../../..')
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8')
const conf = (name: string): { build?: { beforeBuildCommand?: unknown; beforeDevCommand?: unknown } } => JSON.parse(read(`src-tauri/${name}`))

describe('only a build that names the phone carries the mobile shell', () => {
  it('no desktop configuration sets the variable: their build is the shared one', () => {
    expect(conf('tauri.conf.json').build?.beforeBuildCommand).toBe('npm run build')
    expect(conf('tauri.conf.json').build?.beforeDevCommand).toBe('npm run dev')
    for (const name of ['tauri.macos.conf.json', 'tauri.windows.conf.json', 'tauri.linux.conf.json', 'tauri.release.conf.json']) {
      expect(conf(name).build, name).toBeUndefined()
      expect(read(`src-tauri/${name}`), name).not.toContain('VITE_LU_BUILD_TARGET')
    }
    expect(read('src-tauri/tauri.conf.json')).not.toContain('VITE_LU_BUILD_TARGET')
    expect(read('vite.config.ts')).not.toMatch(/VITE_LU_BUILD_TARGET\s*[:=]\s*['"]/)
  })

  it('the two phone configurations set it for the build and for the dev server', () => {
    for (const name of ['tauri.android.conf.json', 'tauri.ios.conf.json']) {
      expect(conf(name).build?.beforeBuildCommand, name).toBe('VITE_LU_BUILD_TARGET=mobile npm run build')
      expect(conf(name).build?.beforeDevCommand, name).toBe('VITE_LU_BUILD_TARGET=mobile npm run dev')
    }
  })

  it('every build script of the phone exports it', () => {
    for (const script of ['scripts/mobile/android-bauen.sh', 'scripts/mobile/ios/bauen.sh', 'scripts/mobile/ios/bauen-geraet-unsigniert.sh', 'scripts/mobile/ios/geraet-bauen.sh']) {
      const text = read(script)
      const at = text.indexOf('export VITE_LU_BUILD_TARGET=mobile')
      expect(at, script).toBeGreaterThan(0)
      // Before Tauri is started, not after.
      expect(at, script).toBeLessThan(text.lastIndexOf('npx tauri'))
    }
  })

  it('no other script under scripts/mobile starts a phone build without it', () => {
    // Found by looking, not by a list: a build script added later is held to the same rule.
    const found: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        const path = `${dir}/${name}`
        if (statSync(join(ROOT, path)).isDirectory()) walk(path)
        else if (/\.sh$/.test(name) && /^\s*npx tauri\b/m.test(read(path))) found.push(path)
      }
    }
    walk('scripts/mobile')
    expect(found.length).toBeGreaterThanOrEqual(4)
    for (const script of found) expect(read(script), script).toContain('export VITE_LU_BUILD_TARGET=mobile')
  })

  it('the preview server of the acceptance frame (mobile-tests) sets it', () => {
    // It shows the mobile shell in a Vite dev server. Without the variable it would show the desktop.
    expect(read('mobile-tests/trocken/server.mjs')).toContain("VITE_LU_BUILD_TARGET: 'mobile'")
  })

  it('the dev server for the mobile shell and the Playwright project mobile set it', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts
    expect(scripts['dev:mobile']).toBe('VITE_LU_BUILD_TARGET=mobile vite')
    expect(scripts['build:mobile']).toBe('VITE_LU_BUILD_TARGET=mobile vite build')
    // The desktop scripts name no phone. Before Vite they only copy the Wasm
    // files of the face detection out of node_modules (head crop of the swap
    // photos, scripts/copy-face-assets.mjs), nothing else.
    expect(scripts.dev).not.toContain('VITE_LU_BUILD_TARGET')
    expect(scripts.build).not.toContain('VITE_LU_BUILD_TARGET')
    expect(scripts.dev).toBe('node scripts/copy-face-assets.mjs && vite')
    expect(scripts.build).toBe('node scripts/copy-face-assets.mjs && vite build')
    const playwright = read('playwright.config.ts')
    expect(playwright).toContain("env: { VITE_LU_BUILD_TARGET: 'mobile' }")
    expect(playwright).toContain('baseURL: mobileOrigin')
  })

  it('main.tsx asks the variable literally, directly in front of the import of the mobile shell', () => {
    const main = read('src/main.tsx')
    const at = main.indexOf("await import('./mobile/boot')")
    expect(at).toBeGreaterThan(0)
    // The line of the import itself, then the line above it.
    const lines = main.slice(0, at).split('\n')
    const before = lines[lines.length - 2].trim()
    expect(before).toBe("if (import.meta.env.VITE_LU_BUILD_TARGET === 'mobile' && mobileHost) {")
  })

  it('the release lock of mobile-host.ts reads the same variable', () => {
    const host = read('src/lib/mobile-host.ts')
    expect(host).toContain("import.meta.env.VITE_LU_BUILD_TARGET === 'mobile'")
    expect(host).toContain('desktopBuild: !MOBILE_BUILD,')
    // The lock is the first decision of the rule.
    const rule = host.slice(host.indexOf('export function mobileHostFrom'))
    const lock = rule.indexOf('if (!input.devBuild && (input.desktopBuild === true || nativeDesktop)) return false')
    expect(lock).toBeGreaterThan(0)
    expect(rule.slice(0, lock)).not.toContain('return ')
  })
})

/**
 * The packages themselves. A string that only src/mobile writes is the mark:
 * the class of the tab bar, the test id of the close button of a sheet and
 * the one of the chat options. All three are string literals and survive the
 * minifier, whatever quotes it writes around them.
 */
describe('the packages: a desktop build has no piece of src/mobile, a phone build has it', () => {
  const MARKS = ['m-tabbar', 'm-sheet-close', 'm-chat-options']
  let work = ''
  const out = { desktop: '', mobile: '' }

  function build(target: 'desktop' | 'mobile'): string {
    const dir = join(work, target)
    const env: NodeJS.ProcessEnv = { ...process.env }
    // The desktop build is the one WITHOUT the variable, whatever the shell of the test run carries.
    delete env.VITE_LU_BUILD_TARGET
    delete env.VITE_LU_STORE_PRESET
    delete env.TAURI_ENV_PLATFORM
    if (target === 'mobile') env.VITE_LU_BUILD_TARGET = 'mobile'
    execFileSync(process.execPath, [resolve(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dir, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, env, stdio: 'pipe' })
    return dir
  }

  function scripts(dir: string): string[] {
    const found: string[] = []
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const path = join(d, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(js|css|html)$/.test(name)) found.push(path)
      }
    }
    walk(dir)
    return found
  }

  const carrying = (dir: string, mark: string): string[] => scripts(dir).filter((file) => readFileSync(file, 'utf8').includes(mark))

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'lu-bau-'))
    out.desktop = build('desktop')
    out.mobile = build('mobile')
  }, 300_000)

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true })
  })

  it('the marks are what src/mobile writes, and nothing else in the app does', () => {
    expect(read('src/mobile/ui/TabBar.tsx')).toContain('className="m-tabbar"')
    expect(read('src/mobile/ui/Sheet.tsx')).toContain("'m-sheet-close'")
    // Since prompt v2 (m310) the options button is drawn by the composer and
    // ChatPage hands the id over as a prop value, still a string literal.
    expect(read('src/mobile/screens/chat/ChatPage.tsx')).toContain("testid: 'm-chat-options'")
    // Nothing outside src/mobile writes them (the one way in is main.tsx).
    for (const file of ['src/main.tsx', 'src/App.tsx', 'src/index.css']) {
      for (const mark of MARKS) expect(read(file), `${file} ${mark}`).not.toContain(mark)
    }
  })

  it('a build without the variable is a desktop build: no file carries a mark of the mobile shell', () => {
    expect(scripts(out.desktop).length).toBeGreaterThan(20)
    for (const mark of MARKS) expect(carrying(out.desktop, mark), mark).toEqual([])
  })

  // The version the phone shows is the one of the phone package (src/dev/phone-version.ts).
  it('the desktop build knows nothing of the phone version: no constant, no tag in the page', () => {
    expect(carrying(out.desktop, PHONE_VERSION_CONSTANT)).toEqual([])
    expect(carrying(out.desktop, PHONE_VERSION_META)).toEqual([])
  })

  it('the phone build carries the version of the phone package, in the page and on About', () => {
    const version = phoneVersion(ROOT)
    expect(readFileSync(join(out.mobile, 'index.html'), 'utf8')).toContain(`<meta name="${PHONE_VERSION_META}" content="${version}">`)
    // The constant is replaced everywhere, nothing asks for it at run time.
    expect(carrying(out.mobile, PHONE_VERSION_CONSTANT)).toEqual([])
    // The file that draws the version row of About carries the version as a literal.
    const about = carrying(out.mobile, 'm-settings-about-version-value')
    expect(about.length).toBeGreaterThan(0)
    const literal = scripts(out.mobile).filter((file) => new RegExp(`["'\`]${version.replace(/\./g, '\\.')}["'\`]`).test(readFileSync(file, 'utf8')))
    expect(literal.length).toBeGreaterThan(0)
  })

  it('a build with VITE_LU_BUILD_TARGET=mobile carries the mobile shell', () => {
    for (const mark of MARKS) expect(carrying(out.mobile, mark).length, mark).toBeGreaterThan(0)
    // And it is the larger package: the shell is extra, the desktop tree stays.
    expect(scripts(out.mobile).length).toBeGreaterThan(scripts(out.desktop).length)
  })
})
