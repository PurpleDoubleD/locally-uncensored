/**
 * Der Updater ist auf diesem Branch tot — und zwar GANZ, nicht halb.
 *
 * Isolationsvorgabe des Experiments: dieser Build darf sich nie selbst
 * updaten. `44a76aad` hat dafuer `plugins.updater.endpoints` geleert. Was
 * dabei stehen blieb: `bundle.createUpdaterArtifacts: "v1Compatible"`. Der
 * Bundler baute also weiter Updater-Artefakte (`.app.tar.gz`, `.msi.zip`,
 * `.nsis.zip`), sah den `pubkey` daneben, fand keinen privaten Schluessel und
 * brach ab — NACHDEM die Installer schon fertig auf der Platte lagen:
 *
 *     Finished 2 bundles at: .../LU Experiment_2.6.7_aarch64.dmg
 *     Error A public key has been found, but no private key.
 *           Make sure to set `TAURI_SIGNING_PRIVATE_KEY` environment variable.
 *     TAURI_BUILD_EXIT=1
 *
 * Gemessen am 2026-08-31 auf Windows (msi + nsis) und am 2026-09-01 auf macOS
 * (app + dmg). Ein Build, der sein Artefakt erzeugt und trotzdem Exit 1
 * liefert, ist fuer jede Pipeline ein Fehlschlag.
 *
 * Die beiden Haelften gehoeren deshalb in EINEN Test. Wer nur die Endpunkte
 * prueft, laesst `createUpdaterArtifacts` beim naechsten Merge aus dem
 * Release-Branch zurueckkommen — dort ist das Feld richtig, weil die echte
 * Pipeline `TAURI_SIGNING_PRIVATE_KEY` aus den GitHub-Secrets setzt
 * (`.github/workflows/release.yml`). Hier gibt es diesen Schluessel nicht und
 * soll es auch nicht geben.
 *
 * Was NICHT weg darf: der `pubkey`. `tauri-plugin-updater` deklariert ihn in
 * `Config` als `pub pubkey: String` ohne `#[serde(default)]`, und
 * `TauriPlugin::initialize` macht aus einem Deserialisierungsfehler ein
 * hartes `Err`. `src-tauri/src/main.rs` registriert das Plugin und beendet
 * den Aufbau mit `.expect("error while running tauri application")` — ohne
 * `pubkey` startet die App also gar nicht mehr. Der leere Endpunkt reicht
 * voellig: `UpdaterBuilder::build()` liefert bei leerer Liste
 * `Error::EmptyEndpoints`, der Store faengt das stumm ab.
 *
 * Run: npx vitest run src/lib/__tests__/updater-tot-und-unsigniert.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8')

const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as {
  plugins?: { updater?: { endpoints?: unknown; pubkey?: unknown } }
  bundle?: { createUpdaterArtifacts?: unknown }
}
const mainRs = read('src-tauri/src/main.rs')

describe('Updater: tot UND unsigniert — beides zusammen', () => {
  it('fragt nirgends nach: endpoints ist da und leer', () => {
    const endpoints = conf.plugins?.updater?.endpoints
    // Vorhanden, nicht bloss weggelassen: das Feld ist die sichtbare Aussage
    // "wir haben uns entschieden", nicht ein vergessener Default.
    expect(Array.isArray(endpoints)).toBe(true)
    expect(endpoints).toEqual([])
  })

  it('verlangt keine Signierartefakte: createUpdaterArtifacts ist aus', () => {
    // Tauri v2 kennt `true`, `false` und `"v1Compatible"`; alles ausser
    // `false` schaltet die Artefakterzeugung ein und damit den Signaturzwang.
    // Fehlt das Feld, gilt der Default `false` — beides ist hier in Ordnung.
    const flag = conf.bundle?.createUpdaterArtifacts
    expect(flag === undefined || flag === false).toBe(true)
  })

  it('haelt die zwei Haelften zusammen: kein Endpunkt heisst kein Artefakt', () => {
    // Der eigentliche Befund. Ein Updater ohne Ziel, der trotzdem signiert
    // werden will, ist der halbe Zustand, der den Build auf Exit 1 geschickt
    // hat. Die Kombination ist verboten, nicht die einzelnen Felder.
    const zielt = ((conf.plugins?.updater?.endpoints as unknown[]) ?? []).length > 0
    const signiert = conf.bundle?.createUpdaterArtifacts !== undefined
      && conf.bundle?.createUpdaterArtifacts !== false
    expect(
      signiert && !zielt,
      'createUpdaterArtifacts an, aber endpoints leer: `tauri build` baut die '
        + 'Installer und bricht danach mit "A public key has been found, but no '
        + 'private key" auf Exit 1 ab.',
    ).toBe(false)
  })

  it('laesst den pubkey stehen, solange main.rs das Plugin registriert', () => {
    // Ueberreinigen bricht die App beim Start, nicht beim Kompilieren. Solange
    // die Zeile unten in main.rs steht, ist der pubkey Pflicht.
    const registriert = mainRs.includes('tauri_plugin_updater::Builder::new().build()')
    if (registriert) {
      expect(typeof conf.plugins?.updater?.pubkey).toBe('string')
      expect((conf.plugins?.updater?.pubkey as string).length).toBeGreaterThan(0)
    }
  })
})
