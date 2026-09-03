/**
 * Das Onboarding im eigenen Fenster — was der Quelltext darüber zusichert.
 *
 * Was hier NICHT steht: ob das Fenster erscheint, wie groß es ist, wo es
 * liegt. Das sieht nur eine laufende App (`npx tauri build --debug`, dann
 * messen). Was ein Quelltext-Test sagen kann: dass die Bausteine so
 * zusammengesteckt sind, wie der Entwurf es verlangt, und dass keiner von
 * ihnen leise wieder auseinanderläuft.
 *
 * Lauf: npx vitest run src/components/onboarding/__tests__/onboarding-fenster.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..', '..', '..')
const read = (...p: string[]) => readFileSync(resolve(ROOT, ...p), 'utf8')
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const MAIN_TSX = codeOnly(read('src', 'main.tsx'))
const APP_TSX = codeOnly(read('src', 'App.tsx'))
const WINDOW_TSX = codeOnly(read('src', 'components', 'onboarding', 'OnboardingWindow.tsx'))
const ONBOARDING_TSX = codeOnly(read('src', 'components', 'onboarding', 'Onboarding.tsx'))
const HOST = codeOnly(read('src', 'lib', 'host-window.ts'))
const BOOT_SYNC = codeOnly(read('src', 'lib', 'rust-boot-sync.ts'))
const RUST = read('src-tauri', 'src', 'onboarding_window.rs')
const CONF = JSON.parse(read('src-tauri', 'tauri.conf.json'))
const CAP_MAIN = JSON.parse(read('src-tauri', 'capabilities', 'default.json'))
const CAP_ONB = JSON.parse(read('src-tauri', 'capabilities', 'onboarding.json'))

// ── Frage 1: woher weiß das Frontend, in welchem Fenster es läuft? ─────────

describe('main.tsx verzweigt am Fensterlabel — und nur dort', () => {
  it('holt die Antwort aus lib/host-window und nicht aus einem eigenen Prädikat', () => {
    expect(MAIN_TSX).toContain("import('./lib/host-window')")
    expect(MAIN_TSX).toContain("hostWindow === 'onboarding'")
    expect(MAIN_TSX).not.toContain('__TAURI_INTERNALS__')
  })

  it('wartet im Hauptfenster auf die Übergabe, BEVOR es App oder einen Store importiert', () => {
    const wait = MAIN_TSX.indexOf('await awaitOnboardingHandover()')
    const app = MAIN_TSX.indexOf("import('./App.tsx')")
    const providers = MAIN_TSX.indexOf("import('./stores/providerStore')")
    expect(wait).toBeGreaterThan(-1)
    expect(app).toBeGreaterThan(wait)
    expect(providers).toBeGreaterThan(wait)
  })

  it('das Warten hört auf das Ereignis UND sieht nach dem Marker — das Ereignis kann vor dem Hörer gefeuert sein', () => {
    const fn = HOST.slice(HOST.indexOf('export async function awaitOnboardingHandover'))
    expect(fn).toContain("invoke<boolean>('onboarding_window_open')")
    expect(fn).toContain('listen(ONBOARDING_DONE_EVENT, settle)')
    expect(fn).toContain("invoke<boolean>('is_onboarding_done')")
    // Reihenfolge: erst hören, dann nachsehen. Andersherum bliebe die Lücke.
    expect(fn.indexOf('listen(ONBOARDING_DONE_EVENT')).toBeLessThan(fn.indexOf("invoke<boolean>('is_onboarding_done')"))
  })
})

// ── Frage 2: was rendert das Onboarding-Fenster? ───────────────────────────

describe('das kleine Fenster trägt den kleinsten Baum', () => {
  it('OnboardingWindow rendert den Assistenten — nicht App, nicht AppShell', () => {
    expect(WINDOW_TSX).toContain("from './Onboarding'")
    expect(WINDOW_TSX).not.toContain('AppShell')
    expect(WINDOW_TSX).not.toMatch(/from '\.\.\/\.\.\/App'/)
  })

  it('und um ihn herum genau das, was AppShell und App auch um ihn legen', () => {
    // MotionConfig (Bewegung reduzieren) wie in App, show_window wie in App.
    // Der LucideProvider (Strichstärke) liegt seit den zwei Wurzeln in
    // main.tsx über BEIDEN Bäumen — siehe icon-leiter.test.ts.
    expect(WINDOW_TSX).toContain('<MotionConfig reducedMotion="user">')
    expect(WINDOW_TSX).not.toContain('<LucideProvider')
    expect(WINDOW_TSX).toContain("invoke('show_window')")
    expect(APP_TSX).toContain('<MotionConfig reducedMotion="user">')
  })

  it('HF-Token und GPU-Wahl gehen aus BEIDEN Fenstern nach Rust, aus einer Funktion', () => {
    expect(BOOT_SYNC).toContain("invoke('set_gpu_selection', { selection })")
    expect(BOOT_SYNC).toContain('applyHfToken(stored)')
    expect(APP_TSX).toContain('pushPersistedChoicesToRust()')
    expect(WINDOW_TSX).toContain('pushPersistedChoicesToRust()')
    // Die alten Kopien in App.tsx sind weg.
    expect(APP_TSX).not.toContain('set_gpu_selection')
    expect(APP_TSX).not.toContain('applyHfToken')
  })

  it('das Hauptfenster zeichnet den Assistenten weiterhin selbst, wenn kein kleines Fenster da ist', () => {
    // Browser-Vorschau, die Playwright-Suite (Label `main`, Mock ohne
    // Fenster) und der Notweg in Rust (`reveal_decision`: ohne
    // Stellvertreter wird gezeigt) laufen alle über diesen Zweig.
    const shell = codeOnly(read('src', 'components', 'layout', 'AppShell.tsx'))
    expect(shell).toContain('if (!onboardingDone) {')
    expect(shell).toContain('<LazyView load={loadOnboarding} fallback={<OnboardingSkeleton />} />')
  })
})

// ── Frage 3: rahmenlos oder dekoriert? ────────────────────────────────────

describe('die Dekoration folgt dem Hauptfenster der jeweiligen Plattform', () => {
  const mac = JSON.parse(read('src-tauri', 'tauri.macos.conf.json')).app.windows[0]
  const win = JSON.parse(read('src-tauri', 'tauri.windows.conf.json')).app.windows[0]

  it('macOS: Overlay-Balken mit verstecktem Titel, wie das Hauptfenster', () => {
    expect(mac.titleBarStyle).toBe('Overlay')
    expect(mac.hiddenTitle).toBe(true)
    expect(RUST).toContain('#[cfg(target_os = "macos")]')
    expect(RUST).toContain('.title_bar_style(tauri::TitleBarStyle::Overlay)')
    expect(RUST).toContain('.hidden_title(true)')
  })

  it('Windows: rahmenlos und transparent ohne DWM-Schatten, wie das Hauptfenster', () => {
    expect(win.decorations).toBe(false)
    expect(win.transparent).toBe(true)
    expect(RUST).toContain('#[cfg(not(target_os = "macos"))]')
    expect(RUST).toContain('.decorations(false).transparent(true)')
    expect(RUST).toContain('#[cfg(target_os = "windows")]')
    expect(RUST).toContain('window.set_shadow(false)')
  })

  it('rahmenlos braucht eine Ziehfläche — der Streifen bleibt, festgenagelt', () => {
    expect(ONBOARDING_TSX).toContain('data-tauri-drag-region className="fixed top-0 left-0 right-0 h-8')
    expect(CAP_ONB.permissions).toContain('core:window:allow-start-dragging')
  })

  it('im eigenen Fenster gibt es kein Maximieren, auf dem Mac keine eigenen Knöpfe', () => {
    expect(ONBOARDING_TSX).toContain("const ownWindow = hostWindow === 'onboarding'")
    expect(ONBOARDING_TSX).toContain('{!(ownWindow && isMacOS()) && (<>')
    expect(ONBOARDING_TSX).toContain('{!ownWindow && (')
    expect(RUST).toContain('.resizable(false)')
    expect(RUST).toContain('.maximizable(false)')
    expect(CAP_ONB.permissions).not.toContain('core:window:allow-maximize')
    expect(CAP_ONB.permissions).not.toContain('core:window:allow-toggle-maximize')
  })
})

// ── Frage 4: der Download überlebt den Fensterwechsel ─────────────────────

describe('der Starter-Download läuft in Rust, und das Fenster geht nicht mittendrin zu', () => {
  it('download_model_to_path spawnt eine tokio-Task und hält den Stand im AppState', () => {
    const dl = read('src-tauri', 'src', 'commands', 'download.rs')
    const fn = dl.slice(dl.indexOf('pub async fn download_model_to_path('))
    expect(fn.slice(0, 4000)).toContain('tokio::spawn(async move {')
    expect(fn.slice(0, 4000)).toContain('Arc::clone(&state.downloads)')
  })

  it('der Ollama-Pull ebenso: Rust pullt, das Fenster hört nur Ereignisse', () => {
    const proxy = read('src-tauri', 'src', 'commands', 'proxy.rs')
    expect(proxy).toContain('app.emit("pull-progress"')
    const ollama = codeOnly(read('src', 'api', 'ollama.ts'))
    expect(ollama).toContain('listen<string>("pull-progress"')
  })

  it('kein Schritt lässt den Nutzer weiter, solange er lädt — also endet das Onboarding nie mit laufendem Download', () => {
    const models = codeOnly(read('src', 'components', 'onboarding', 'ModelsStep.tsx'))
    const embeds = codeOnly(read('src', 'components', 'onboarding', 'EmbeddingsStep.tsx'))
    // Modelle: „Skip for now" verschwindet, sobald ein Download läuft.
    expect(models).toMatch(/: !isDownloading \? \(\s*<button\s+onClick=\{\(\) => setStep\('embeddings'\)\}/)
    // Einbettungen: „Continue/Skip" ist deaktiviert, solange gepullt wird.
    expect(embeds).toContain('disabled={embeddingsPulling}')
  })

  it('und geschlossen wird das kleine Fenster erst, nachdem das große sichtbar ist', () => {
    const reveal = RUST.slice(RUST.indexOf('pub fn reveal('), RUST.indexOf('pub fn open('))
    const show = reveal.lastIndexOf('window.show()')
    const destroy = reveal.indexOf('o.destroy()')
    expect(show).toBeGreaterThan(-1)
    expect(destroy).toBeGreaterThan(show)
  })
})

// ── Frage 5: Größe ─────────────────────────────────────────────────────────

describe('die Größe ist gemessen, nicht geraten', () => {
  const w = Number(/pub const ONBOARDING_WIDTH: f64 = ([\d.]+);/.exec(RUST)?.[1])
  const h = Number(/pub const ONBOARDING_HEIGHT: f64 = ([\d.]+);/.exec(RUST)?.[1])

  it('640 x 640: trägt den längsten gemessenen Schritt (531 + 37 + 18) und ist kleiner als das Hauptfenster', () => {
    expect(w).toBe(640)
    expect(h).toBe(640)
    expect(h).toBeGreaterThanOrEqual(531 + 37 + 18)
    expect(w).toBeLessThan(CONF.app.windows[0].width)
    expect(h).toBeLessThan(CONF.app.windows[0].height)
  })

  it('was darüber hinausgeht, scrollt — ohne oben abgeschnitten zu werden', () => {
    expect(ONBOARDING_TSX).toContain('h-screen w-screen flex flex-col items-center justify-center gap-5 p-4 overflow-y-auto')
    expect(ONBOARDING_TSX).toContain('<div className="w-full flex flex-col items-center gap-5 my-auto">')
  })

  it('das Hauptfenster in tauri.conf.json ist unverändert das eine, große', () => {
    expect(CONF.app.windows).toHaveLength(1)
    expect(CONF.app.windows[0]).toMatchObject({ width: 1280, height: 800, visible: false })
    // Das kleine Fenster steht NICHT in der Konfiguration: Rust baut es,
    // und nur dann, wenn der Marker fehlt.
    expect(JSON.stringify(CONF)).not.toContain('"onboarding"')
  })
})

// ── Frage 6: Zurücksetzen in den Einstellungen ────────────────────────────

describe('„Re-run onboarding" bringt das kleine Fenster zurück — über den Marker', () => {
  it('die Einstellungen löschen den Marker, und die Fenster folgen ihm', () => {
    const settings = codeOnly(read('src', 'components', 'settings', 'SettingsPage.tsx'))
    expect(settings).toContain("await backendCall('set_onboarding_done', { done: false })")
    const system = read('src-tauri', 'src', 'commands', 'system.rs')
    expect(system).toContain('crate::onboarding_window::follow_marker(&app, done);')
    const follow = RUST.slice(RUST.indexOf('pub fn follow_marker('), RUST.indexOf('pub fn front_window('))
    expect(follow).toContain('else if onboarding.is_none()')
    expect(follow).toContain('open(app)')
  })

  it('erst zeigt sich das kleine, dann verschwindet das große — nie ein Moment ohne Fenster', () => {
    const reveal = RUST.slice(RUST.indexOf('pub fn reveal('), RUST.indexOf('pub fn open('))
    const showBlock = reveal.slice(reveal.indexOf('Reveal::Show =>'), reveal.indexOf('Reveal::ShowAndCloseOnboarding =>'))
    expect(showBlock.indexOf('window.show()')).toBeLessThan(showBlock.indexOf('main.hide()'))
  })
})

// ── Das Onboarding-Fenster als Fenster ────────────────────────────────────

describe('das Fenster selbst', () => {
  it('wird vom System mittig gesetzt, unsichtbar gebaut und vom Frontend gezeigt', () => {
    const open = RUST.slice(RUST.indexOf('pub fn open('), RUST.indexOf('fn quit('))
    expect(open).toContain('.center()')
    expect(open).toContain('.visible(false)')
    expect(open).toContain('WebviewUrl::default()')
  })

  it('zu heißt Ende, solange das Onboarding nicht fertig ist', () => {
    const open = RUST.slice(RUST.indexOf('pub fn open('), RUST.indexOf('fn quit('))
    expect(open).toContain('tauri::WindowEvent::CloseRequested')
    expect(open).toContain('if !is_onboarding_done()')
    expect(open).toContain('quit(&handle)')
    const quit = RUST.slice(RUST.indexOf('fn quit('), RUST.indexOf('#[tauri::command]'))
    expect(quit).toContain('shutdown_subprocesses()')
    expect(quit).toContain('app.exit(0)')
  })

  it('seine Capability ist die kleine, nicht die des Hauptfensters', () => {
    expect(CAP_MAIN.windows).toEqual(['main'])
    expect(CAP_ONB.windows).toEqual(['onboarding'])
    const spawn = CAP_ONB.permissions.find((p: unknown) => typeof p === 'object' && p !== null && (p as { identifier?: string }).identifier === 'shell:allow-spawn')
    expect(spawn).toBeUndefined()
    expect(CAP_ONB.permissions).not.toContain('updater:default')
    // Was der Assistent wirklich braucht: bewegen, minimieren, schließen,
    // Ereignisse hören (core:default), Herstellerseiten im Browser öffnen.
    for (const p of ['core:default', 'core:window:allow-minimize', 'core:window:allow-close', 'core:window:allow-start-dragging', 'shell:allow-open']) {
      expect(CAP_ONB.permissions).toContain(p)
    }
  })

  it('im eigenen Fenster ist der Marker kein stiller Fall: der Knopf sagt, was passiert, und ein Fehler steht da', () => {
    expect(ONBOARDING_TSX).toContain("setHandover({ phase: 'running' })")
    expect(ONBOARDING_TSX).toContain("await backendCall('set_onboarding_done')")
    expect(ONBOARDING_TSX).toContain("handover.phase === 'running' ? 'Opening LU…'")
    expect(ONBOARDING_TSX).toContain("{handover.phase === 'failed' && (")
  })
})
