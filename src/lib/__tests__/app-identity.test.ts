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
 * Dieser Branch (`experiment/audits-komplett`) hat bewusst eigene
 * Datenverzeichnisse: der Experiment-Build hat am 2026-08-31 in
 * `~/Library/Application Support/lu-labs/` — dem Verzeichnis der ECHTEN App —
 * geschrieben und dabei ein Store-Backup überschrieben.
 *
 * Die Namen stehen an zwei Stellen (Rust für die Tauri-App, TypeScript für die
 * vite-Middlewares von `npm run dev`). Diese Datei ist die Klammer: sie liest
 * die Rust-Konstanten und vergleicht sie mit den TS-Konstanten, damit die
 * beiden Seiten nicht auseinander laufen können.
 */
describe('Verzeichnisnamen dieses Builds', () => {
  const rust = readFileSync(
    resolve(process.cwd(), 'src-tauri/src/app_identity.rs'),
    'utf8',
  )

  /** `pub const NAME: &str = concat!("basis", branch_dir_suffix!());` auflösen. */
  function rustConst(name: string): string {
    const suffix = /macro_rules!\s+branch_dir_suffix\s*\{\s*\(\)\s*=>\s*\{\s*"([^"]*)"/.exec(rust)
    expect(suffix, 'branch_dir_suffix!() nicht in app_identity.rs gefunden').not.toBeNull()
    const re = new RegExp(
      `pub const ${name}: &str =\\s*concat!\\("([^"]*)",\\s*branch_dir_suffix!\\(\\)\\);`,
    )
    const m = re.exec(rust)
    expect(m, `${name} nicht in app_identity.rs gefunden`).not.toBeNull()
    return `${m![1]}${suffix![1]}`
  }

  it('stimmen mit der Rust-Seite überein', () => {
    // Ein Jail, das anders rechnet als der Ordner, in den geschrieben wird,
    // lehnt jeden Zugriff ab — die beiden Seiten MÜSSEN identisch sein.
    expect(AGENT_WORKSPACE_DIR).toBe(rustConst('AGENT_WORKSPACE_DIR'))
    expect(APP_CONFIG_DIR).toBe(rustConst('APP_CONFIG_DIR'))
    expect(APP_DIR).toBe(rustConst('APP_DIR'))
    expect(APP_DISPLAY_DIR).toBe(rustConst('APP_DISPLAY_DIR'))
  })

  it('sind keine Verzeichnisnamen der echten App', () => {
    // Bewusst eigene Literale: ein Test, der seine Erwartung aus dem ableitet,
    // was er absichern soll, prüft nichts.
    const echt = ['lu-labs', 'locally-uncensored', 'Locally Uncensored', 'agent-workspace']
    for (const name of [AGENT_WORKSPACE_DIR, APP_CONFIG_DIR, APP_DIR, APP_DISPLAY_DIR]) {
      expect(echt, `'${name}' ist der Verzeichnisname der ECHTEN App`).not.toContain(name)
    }
  })

  it('werden im vite-Dev-Server nicht von Hand zusammengebaut', () => {
    // Die Präfix-/Literal-Falle auf der TS-Seite: `lu-labs-experiment` fängt
    // mit `lu-labs` an, und ein neu hingeschriebenes Literal wandert an
    // app-identity.ts vorbei. vite.config.ts bedient den `npm run dev`-Pfad
    // und schreibt mit echten Node-fs-Aufrufen auf die Platte.
    const vite = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8')
    const jail = readFileSync(resolve(process.cwd(), 'src/lib/dev-fs-jail.ts'), 'utf8')
    for (const name of ['lu-labs', 'locally-uncensored', 'Locally Uncensored', 'agent-workspace']) {
      for (const quelle of [
        ['vite.config.ts', vite],
        ['src/lib/dev-fs-jail.ts', jail],
      ] as const) {
        expect(quelle[1], `${quelle[0]}: '${name}' als Pfadbestandteil hartkodiert`)
          .not.toContain(`'${name}'`)
        expect(quelle[1], `${quelle[0]}: '${name}/' als Pfadbestandteil hartkodiert`)
          .not.toContain(`/${name}/`)
      }
    }
  })
})
