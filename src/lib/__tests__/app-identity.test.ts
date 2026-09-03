import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  AGENT_WORKSPACE_DIR,
  APP_CONFIG_DIR,
  APP_DIR,
  APP_DISPLAY_DIR,
} from '../app-identity'

/**
 * Die Namen der app-eigenen Verzeichnisse stehen an zwei Stellen: Rust für die
 * Tauri-App, TypeScript für die vite-Middlewares von `npm run dev`. Beide legen
 * dieselben Dateien an, und ein Build, der sich verrechnet, schreibt in ein
 * fremdes Datenverzeichnis. Am 2026-08-31 ist genau das passiert und hat ein
 * Store-Backup überschrieben.
 *
 * Diese Datei ist die Klammer: sie liest die Rust-Konstanten und vergleicht sie
 * mit den TS-Konstanten, damit die beiden Seiten nicht auseinander laufen
 * können.
 */
describe('Verzeichnisnamen dieses Builds', () => {
  const rust = readFileSync(
    resolve(process.cwd(), 'src-tauri/src/app_identity.rs'),
    'utf8',
  )

  /** `pub const NAME: &str = "wert";` auflösen. */
  function rustConst(name: string): string {
    const m = new RegExp(`pub const ${name}: &str =\\s*"([^"]*)";`).exec(rust)
    expect(m, `${name} nicht in app_identity.rs gefunden`).not.toBeNull()
    return m![1]
  }

  it('stimmen mit der Rust-Seite überein', () => {
    // Ein Jail, das anders rechnet als der Ordner, in den geschrieben wird,
    // lehnt jeden Zugriff ab — die beiden Seiten MÜSSEN identisch sein.
    expect(AGENT_WORKSPACE_DIR).toBe(rustConst('AGENT_WORKSPACE_DIR'))
    expect(APP_CONFIG_DIR).toBe(rustConst('APP_CONFIG_DIR'))
    expect(APP_DIR).toBe(rustConst('APP_DIR'))
    expect(APP_DISPLAY_DIR).toBe(rustConst('APP_DISPLAY_DIR'))
  })

  it('sind die Verzeichnisnamen dieser App und tragen keinen Anhang', () => {
    // Bewusst eigene Literale: ein Test, der seine Erwartung aus dem ableitet,
    // was er absichern soll, prüft nichts. Ein Build aus einem
    // Experimentierzweig trägt hier einen Suffix und fällt damit durch, bevor
    // er beim Nutzer die falschen Ordner anlegt.
    expect(AGENT_WORKSPACE_DIR).toBe('agent-workspace')
    expect(APP_CONFIG_DIR).toBe('locally-uncensored')
    expect(APP_DIR).toBe('lu-labs')
    expect(APP_DISPLAY_DIR).toBe('Locally Uncensored')
  })

  it('werden im vite-Dev-Server nicht von Hand zusammengebaut', () => {
    // Die Präfix-/Literal-Falle auf der TS-Seite: `lu-labs-experiment` fängt
    // mit `lu-labs` an, und ein neu hingeschriebenes Literal wandert an
    // app-identity.ts vorbei. vite.config.ts bedient den `npm run dev`-Pfad
    // und schreibt mit echten Node-fs-Aufrufen auf die Platte.
    //
    // Die Prüfung WANDERT MIT dem Code: Teile des Dev-Servers liegen inzwischen
    // in src/dev/ (herausgelöst, damit sie testbar sind). Wäre hier nur
    // vite.config.ts genannt, hätte das Verschieben das Loch nur umgezogen —
    // deshalb wird das Verzeichnis gelesen, nicht eine Dateiliste gepflegt.
    for (const [name, text] of devServerSources()) {
      for (const echt of ['lu-labs', 'locally-uncensored', 'Locally Uncensored', 'agent-workspace']) {
        expect(text, `${name}: '${echt}' als Pfadbestandteil hartkodiert`)
          .not.toContain(`'${echt}'`)
        expect(text, `${name}: '${echt}/' als Pfadbestandteil hartkodiert`)
          .not.toContain(`/${echt}/`)
      }
    }
  })

  it('deckt alle Dev-Server-Quellen ab, auch neu hinzugekommene', () => {
    // Ohne diese Zusicherung könnte die Prüfung oben still auf null Dateien
    // laufen — ein grüner Test, der nichts liest.
    const namen = devServerSources().map(([name]) => name)
    expect(namen).toContain('vite.config.ts')
    expect(namen).toContain('src/lib/dev-fs-jail.ts')
    expect(namen.filter((n) => n.startsWith('src/dev/')).length).toBeGreaterThan(0)
  })
})

/**
 * Jede Quelldatei, die den `npm run dev`-Pfad bedient: die vite-Konfiguration,
 * der Pfad-Käfig und alles, was aus der Konfiguration nach `src/dev/`
 * herausgelöst wurde (ohne die Tests dort).
 */
function devServerSources(): [string, string][] {
  const root = process.cwd()
  const dateien = ['vite.config.ts', 'src/lib/dev-fs-jail.ts']
  for (const entry of readdirSync(resolve(root, 'src/dev'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts')) dateien.push(`src/dev/${entry.name}`)
  }
  return dateien.map((name) => [name, readFileSync(resolve(root, name), 'utf8')])
}
