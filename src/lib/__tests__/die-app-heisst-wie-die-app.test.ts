/**
 * Was in den Tauri-Konfigurationen steht, entscheidet ueber die Identitaet des
 * ausgelieferten Programms: wie es heisst, wohin es installiert wird, welches
 * Datenprofil es liest, und ob es je ein Update bekommt.
 *
 * Am 03.09.2026 kam beim Zusammenfuehren des Design-Stroms die
 * Experiment-Identitaet in die Release-Linie. Der Bau auf der Box packte ein
 * "LU Experiment_2.6.8_x64-setup.exe", und niemand haette es an den Tests
 * gemerkt, weil kein Test die Konfiguration las. Ein so gebautes 2.6.8 waere
 * fuer jeden Kunden eine fremde, leere App neben seiner eigenen gewesen, ohne
 * seine Modelle, ohne seine Chats, und ohne einen Update-Kanal, um je wieder
 * herauszukommen.
 *
 * Die Experiment-Identitaet ist richtig, sie gehoert nur auf den
 * Experiment-Zweig. Hier wird festgehalten, was auf der Release-Linie steht.
 *
 * Run: npx vitest run src/lib/__tests__/die-app-heisst-wie-die-app.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const TAURI = resolve(__dirname, '../../../src-tauri')
const lies = (name: string) => JSON.parse(readFileSync(resolve(TAURI, name), 'utf8'))

const basis = lies('tauri.conf.json')
const windows = lies('tauri.windows.conf.json')
const linux = lies('tauri.linux.conf.json')
const macos = lies('tauri.macos.conf.json')

describe('wie das ausgelieferte Programm heisst', () => {
  it('nirgends steht Experiment', () => {
    // Der eine Griff, der alles andere nach sich zieht. Ein Name mit Suffix
    // heisst: eigener Programmordner, eigenes Datenprofil, eigene
    // Schluesselbund-Eintraege.
    for (const [wo, cfg] of [['basis', basis], ['windows', windows], ['linux', linux], ['macos', macos]] as const) {
      const text = JSON.stringify(cfg)
      expect(text, `${wo} traegt eine Experiment-Identitaet`).not.toMatch(/experiment/i)
    }
  })

  it('Windows und Linux installieren unter dem ausgeschriebenen Namen', () => {
    // C:\Program Files\Locally Uncensored\ ist der Pfad, unter dem die
    // vorhandenen Installationen liegen. Ein anderer Name dort ist keine
    // Umbenennung, sondern eine zweite Installation.
    expect(windows.productName).toBe('Locally Uncensored')
    expect(linux.productName).toBe('Locally Uncensored')
  })

  it('der Mac bleibt bei LU, und das ist Absicht', () => {
    // LU.app, kurz genug fuer das Dock. macOS uebernimmt den Basisnamen, es
    // steht also bewusst KEIN productName in der Mac-Datei.
    expect(macos.productName).toBeUndefined()
    expect(basis.productName).toBe('LU')
  })

  it('die Kennung ist die der echten App', () => {
    expect(basis.identifier).toBe('com.purpledoubled.locally-uncensored')
  })
})

describe('ob ein Update je ankommt', () => {
  it('es gibt ueberhaupt einen Kanal', () => {
    // Eine leere Liste ist kein deaktivierter Updater, sie ist ein Updater,
    // der jede Suche still mit "nichts gefunden" beantwortet. Wer so eine
    // Fassung installiert hat, sitzt darauf fest.
    const eps: unknown = basis.plugins?.updater?.endpoints
    expect(Array.isArray(eps) && eps.length > 0, 'kein Update-Endpunkt konfiguriert').toBe(true)
  })

  it('und er zeigt auf die latest.json des Release-Kanals', () => {
    const eps: string[] = basis.plugins.updater.endpoints
    expect(eps.some((e) => e.endsWith('/latest.json'))).toBe(true)
    // Kein festverdrahtetes Tag: der Endpunkt folgt dem Latest-Flag, das erst
    // nach der Pruefung gesetzt wird. Ein Tag im Pfad friert den Kanal ein.
    expect(eps.join(' ')).not.toMatch(/\/v?\d+\.\d+\.\d+\//)
  })

  it('der Bau legt die Update-Dateien ueberhaupt an', () => {
    // Ohne createUpdaterArtifacts entsteht keine latest.json und keine
    // Signatur, und dann ist der Endpunkt oben eine Adresse ohne Ziel.
    expect(basis.bundle?.createUpdaterArtifacts).toBe('v1Compatible')
  })

  it('Ziel und Artefakte gehoeren zusammen', () => {
    // Aus dem Experiment-Zweig uebernommen, weil der Befund auf beiden Linien
    // gilt: `createUpdaterArtifacts` an und `endpoints` leer ist der halbe
    // Zustand, in dem `tauri build` die Installer fertig auf die Platte legt
    // und DANACH mit "A public key has been found, but no private key" auf
    // Exit 1 geht (gemessen am 31.08.2026 unter Windows, am 01.09. auf dem
    // Mac). Verboten ist die Kombination, nicht das einzelne Feld.
    const zielt = (basis.plugins?.updater?.endpoints ?? []).length > 0
    const signiert = basis.bundle?.createUpdaterArtifacts !== undefined
      && basis.bundle?.createUpdaterArtifacts !== false
    expect(signiert && !zielt, 'Artefakte an, aber kein Ziel').toBe(false)
  })

  it('der oeffentliche Schluessel steht da, solange main.rs das Plugin registriert', () => {
    // Ueberreinigen bricht die App beim START, nicht beim Kompilieren:
    // `tauri-plugin-updater` deklariert `pubkey` ohne serde-Default, ein
    // Deserialisierungsfehler wird ein hartes Err, und main.rs beendet den
    // Aufbau mit expect(). Ohne pubkey startet die App also gar nicht mehr.
    const mainRs = readFileSync(resolve(TAURI, 'src/main.rs'), 'utf8')
    if (mainRs.includes('tauri_plugin_updater::Builder::new().build()')) {
      expect(typeof basis.plugins?.updater?.pubkey).toBe('string')
      expect(basis.plugins.updater.pubkey.length).toBeGreaterThan(40)
    }
  })
})
