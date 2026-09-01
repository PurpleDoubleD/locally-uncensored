/**
 * In welchem Fenster läuft das Frontend? — die eine Stelle, die es weiß.
 *
 * Seit das Onboarding ein eigenes Fenster hat, lädt `index.html` zweimal:
 * im Hauptfenster `main` und im kleinen Fenster `onboarding`. Beide werden
 * aus dem Fensterlabel unterschieden, und zwar in `lib/host-window.ts` und
 * nirgends sonst — das ist die Regel, die dieser Test hält.
 *
 * Lauf: npx vitest run src/lib/__tests__/host-window.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { hostWindowFrom, hostWindow, ONBOARDING_WINDOW_LABEL, ONBOARDING_DONE_EVENT } from '../host-window'

const ROOT = resolve(__dirname, '..', '..', '..')
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    // KF-10d. Auf `/` normalisiert, bevor irgendjemand den Pfad vergleicht:
    // unter Windows liefert join() `src\lib\host-window.ts`, und der
    // Ausschluss `endsWith('/lib/host-window.ts')` unten griff nicht — die
    // Wache hielt die einzige erlaubte Datei fuer einen Verstoss. Auf der
    // echten Maschine gemessen, am selben Commit auf dem Mac gruen.
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p.replace(/\\/g, '/'))
  }
  return out
}

describe('hostWindowFrom: das Label sagt, welches Fenster', () => {
  it('kein Label heißt Browser-Vorschau', () => {
    expect(hostWindowFrom(null)).toBe('browser')
  })

  it('das Onboarding-Label heißt Onboarding-Fenster', () => {
    expect(hostWindowFrom(ONBOARDING_WINDOW_LABEL)).toBe('onboarding')
    expect(hostWindowFrom('onboarding')).toBe('onboarding')
  })

  it('jedes andere Label ist das Hauptfenster — auch ein unbekanntes', () => {
    // Ein drittes Fenster müsste hier ausdrücklich dazukommen. Bis dahin ist
    // „nicht das Onboarding" gleichbedeutend mit „die App".
    expect(hostWindowFrom('main')).toBe('main')
    expect(hostWindowFrom('something-new')).toBe('main')
    expect(hostWindowFrom('')).toBe('main')
  })

  it('ohne Tauri-Laufzeit (hier: node) ist der Wirt der Browser, und nichts wirft', () => {
    expect(hostWindow).toBe('browser')
  })
})

describe('das Label wird an EINER Stelle gelesen', () => {
  const files = walk(resolve(ROOT, 'src'))

  it('getCurrentWebviewWindow kommt außerhalb von host-window.ts nicht vor', () => {
    const offenders = files
      .filter((f) => !f.endsWith(`${'/lib/host-window.ts'}`))
      .filter((f) => codeOnly(readFileSync(f, 'utf8')).includes('getCurrentWebviewWindow'))
      .map((f) => f.slice(ROOT.length + 1))
    expect(offenders).toEqual([])
  })

  it('niemand liest metadata.currentWebview selbst', () => {
    const offenders = files
      .filter((f) => codeOnly(readFileSync(f, 'utf8')).includes('metadata.currentWebview'))
      .map((f) => f.slice(ROOT.length + 1))
    expect(offenders).toEqual([])
  })

  it('und wer die Antwort braucht, importiert sie von dort', () => {
    // Die drei Stellen, die verzweigen: der Einstieg (welcher Baum), die
    // Schale des Assistenten (welche Fensterknöpfe, welche Übergabe).
    for (const f of ['src/main.tsx', 'src/components/onboarding/Onboarding.tsx']) {
      expect(codeOnly(readFileSync(resolve(ROOT, f), 'utf8')), f).toMatch(/lib\/host-window'/)
    }
  })
})

describe('Rust und Frontend meinen dasselbe Label und dasselbe Ereignis', () => {
  const rust = readFileSync(resolve(ROOT, 'src-tauri', 'src', 'onboarding_window.rs'), 'utf8')

  it('das Label', () => {
    expect(rust).toContain(`pub const ONBOARDING: &str = "${ONBOARDING_WINDOW_LABEL}";`)
  })

  it('das Ereignis', () => {
    expect(rust).toContain(`pub const DONE_EVENT: &str = "${ONBOARDING_DONE_EVENT}";`)
  })

  it('die Capability des kleinen Fensters gilt genau diesem Label', () => {
    const cap = JSON.parse(readFileSync(resolve(ROOT, 'src-tauri', 'capabilities', 'onboarding.json'), 'utf8'))
    expect(cap.windows).toEqual([ONBOARDING_WINDOW_LABEL])
  })
})
