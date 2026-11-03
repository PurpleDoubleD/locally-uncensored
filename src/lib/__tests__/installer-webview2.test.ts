/**
 * The Windows installer has to leave a WebView2 Runtime that the person who
 * starts LU can use.
 *
 * 2026-11-03, a fresh Windows install: LU opened only Tauri's "Could not find
 * the WebView2 Runtime ... installed on another user account". The stock
 * section counts a "pv" of 0.0.0.0 as installed, counts the HKCU of whoever
 * ran the setup (an admin, for an install for all users), skips updates, and
 * with the default download mode a blocked download ends the setup. The
 * reasons are written out in installer-hooks.nsh (LU_ENSURE_WEBVIEW2); this
 * pins the parts that a later edit could quietly undo.
 *
 * Run: npx vitest run src/lib/__tests__/installer-webview2.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8')

const hooks = read('src-tauri/windows/installer-hooks.nsh')
const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as {
  bundle?: { windows?: { webviewInstallMode?: { type?: string; silent?: boolean } } }
}
const ensure = hooks.slice(
  hooks.indexOf('!macro LU_ENSURE_WEBVIEW2'),
  hooks.indexOf('!macro NSIS_HOOK_POSTINSTALL'),
)

describe('the installer leaves a WebView2 Runtime for this user', () => {
  it('embeds the bootstrapper, so a blocked download cannot end the setup', () => {
    expect(conf.bundle?.windows?.webviewInstallMode).toEqual({ type: 'embedBootstrapper', silent: true })
  })

  it('runs its own check after the files are in place', () => {
    const post = hooks.slice(hooks.indexOf('!macro NSIS_HOOK_POSTINSTALL'))
    expect(post).toMatch(/^!macro NSIS_HOOK_POSTINSTALL\s+!insertmacro LU_ENSURE_WEBVIEW2\s+!macroend/)
  })

  it('treats a pv of 0.0.0.0 as missing, as Microsoft says', () => {
    const read = hooks.slice(hooks.indexOf('!macro LU_READ_WEBVIEW2'), hooks.indexOf('!macro LU_ENSURE_WEBVIEW2'))
    expect(read).toContain('${If} $R1 == "0.0.0.0"')
    expect(read).toContain('StrCpy $R1 ""')
  })

  it("does not count the HKCU of an install for all users", () => {
    const hkcu = ensure.indexOf('LU_READ_WEBVIEW2 HKCU')
    const guard = ensure.lastIndexOf('${If} $R2 != "AllUsers"', hkcu)
    expect(hkcu).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(-1)
    expect(ensure.slice(guard, hkcu)).not.toContain('${EndIf}')
  })

  it('never aborts the setup over the runtime', () => {
    expect(ensure).not.toMatch(/\bAbort\b/)
    expect(ensure).toContain('https://developer.microsoft.com/microsoft-edge/webview2/')
  })

  it('removes its bootstrapper copy on uninstall, or the folder stays behind', () => {
    const copy = ensure.match(/File "\/oname=(\$INSTDIR\\[^"]+)"/)
    expect(copy).not.toBeNull()
    const pre = hooks.slice(hooks.indexOf('!macro NSIS_HOOK_PREUNINSTALL'))
    expect(pre).toContain(`Delete "${copy![1]}"`)
  })
})
