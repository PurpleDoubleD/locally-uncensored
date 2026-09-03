/**
 * Der Käfig-Eingang der fünf `/local-api/fs-*`-Endpunkte.
 *
 * DER BEFUND, den diese Datei festnagelt: `fs-read`, `fs-write`, `fs-list`,
 * `fs-search` und `fs-info` prüften den Pfad aus dem Request nicht. Sie
 * standen alle fünf als
 *
 *     isAbsolute(p) ? p : join(os.homedir(), AGENT_WORKSPACE_DIR, p)
 *
 * da: ein absoluter Pfad wurde wörtlich übernommen, ein relativer durfte mit
 * `../../` herausklettern — und `fs-write` SCHRIEB auf das Ergebnis. Der
 * gepackte Build lehnt genau dieselben Aufrufe in `resolve_path`
 * (`src-tauri/src/commands/filesystem.rs`) ab.
 *
 * Was hier geprüft wird, ist deshalb die REGEL, die die Rust-Seite zieht, an
 * der Stelle, an der der Dev-Server sie ziehen muss:
 *
 *   1. Wurzel: ein nicht-leeres `workingDirectory` gewinnt, sonst der
 *      Chat-Sandkasten `<home>/<AGENT_WORKSPACE_DIR>/<chatId>`
 *      (`workspace_root`).
 *   2. Ein relativer Pfad löst gegen diese Wurzel auf.
 *   3. Ein absoluter Pfad wird NUR akzeptiert, wenn er ohnehin schon in der
 *      Wurzel liegt (`contain_within`).
 *
 * Die Regel selbst steht in `src/lib/dev-fs-jail.ts` und hat dort ihren
 * eigenen Test; hier geht es um den Weg vom REQUEST-KÖRPER in diese Regel —
 * also darum, dass die drei Felder gelesen werden und keins davon fehlt.
 *
 * MUTATIONSSONDE (von Hand geprüft): in `src/dev/fs-request-path.ts` den
 * Rückgabewert durch den alten Ausdruck ersetzen
 * (`bodyString(body, 'path') ?? ''`) → die vier Ausbruchsfälle unten werden
 * rot; die Zeile zurücknehmen → wieder grün.
 *
 * Run: npx vitest run src/dev/__tests__/fs-request-path.test.ts
 */
import { describe, expect, it } from 'vitest'
import { resolveFsRequestPath } from '../fs-request-path'
import { JailEscapeError } from '../../lib/dev-fs-jail'
import { AGENT_WORKSPACE_DIR } from '../../lib/app-identity'

/** Ein Heimatverzeichnis, das garantiert keins ist — der Test fasst keine Platte an. */
const HOME = '/home/tester'
const SANDBOX = `${HOME}/${AGENT_WORKSPACE_DIR}`

/** Ein Request-Körper, wie `withJsonBody` ihn an den Handler gibt. */
function body(fields: Record<string, unknown>): unknown {
  return fields
}

describe('die Wurzel eines fs-Requests', () => {
  it('ist der Chat-Sandkasten, wenn kein Arbeitsordner mitkommt', () => {
    expect(resolveFsRequestPath(body({ path: 'notes.md', chatId: 'chat-7' }), HOME))
      .toBe(`${SANDBOX}/chat-7/notes.md`)
  })

  it('heisst `default`, wenn auch die Chat-Id fehlt — wie `chat_id.unwrap_or("default")`', () => {
    expect(resolveFsRequestPath(body({ path: 'notes.md' }), HOME))
      .toBe(`${SANDBOX}/default/notes.md`)
  })

  it('ist der Arbeitsordner, sobald einer mitkommt', () => {
    const resolved = resolveFsRequestPath(
      body({ path: 'src/main.ts', chatId: 'chat-7', workingDirectory: '/projects/app' }),
      HOME,
    )
    expect(resolved).toBe('/projects/app/src/main.ts')
  })

  it('ignoriert einen leeren Arbeitsordner und fällt auf den Sandkasten zurück', () => {
    expect(resolveFsRequestPath(body({ path: 'a.txt', chatId: 'c1', workingDirectory: '   ' }), HOME))
      .toBe(`${SANDBOX}/c1/a.txt`)
  })

  it('ist ohne `path` die Wurzel selbst — der Endpunkt formuliert seine eigene Meldung', () => {
    expect(resolveFsRequestPath(body({ chatId: 'c1' }), HOME)).toBe(`${SANDBOX}/c1`)
  })
})

describe('der Ausbruchsversuch', () => {
  it('wird abgelehnt, wenn ein relativer Pfad aus dem Sandkasten klettert', () => {
    // Genau der Aufruf aus dem Auftrag: {"path":"../../.ssh/id_rsa"}.
    expect(() => resolveFsRequestPath(body({ path: '../../.ssh/id_rsa', chatId: 'c1' }), HOME))
      .toThrow(JailEscapeError)
  })

  it('wird abgelehnt, wenn ein relativer Pfad aus dem Arbeitsordner klettert', () => {
    expect(() =>
      resolveFsRequestPath(
        body({ path: '../../../etc/passwd', chatId: 'c1', workingDirectory: '/projects/app' }),
        HOME,
      ),
    ).toThrow(JailEscapeError)
  })

  it('wird abgelehnt, wenn ein absoluter Pfad ausserhalb der Wurzel liegt', () => {
    expect(() => resolveFsRequestPath(body({ path: '/etc/shadow', chatId: 'c1' }), HOME))
      .toThrow(JailEscapeError)
    expect(() => resolveFsRequestPath(body({ path: `${HOME}/.ssh/id_rsa`, chatId: 'c1' }), HOME))
      .toThrow(JailEscapeError)
  })

  it('wird abgelehnt, wenn ein absoluter Pfad NEBEN dem Arbeitsordner liegt', () => {
    // `…/app-secrets` beginnt textuell mit `…/app`; die Grenze läuft auf
    // Komponenten, nicht auf Zeichen.
    expect(() =>
      resolveFsRequestPath(
        body({ path: '/projects/app-secrets/.env', workingDirectory: '/projects/app' }),
        HOME,
      ),
    ).toThrow(JailEscapeError)
  })

  it('nennt beide Seiten, damit der Aufrufer sieht, wogegen geprüft wurde', () => {
    expect(() => resolveFsRequestPath(body({ path: '/etc/shadow', chatId: 'c1' }), HOME))
      .toThrow(/workspace root/)
  })
})

describe('was der Käfig durchlässt', () => {
  it('einen absoluten Pfad INNERHALB des Arbeitsordners — das ist der Alltag im Desktop-Build', () => {
    expect(
      resolveFsRequestPath(
        body({ path: '/projects/app/src/main.ts', workingDirectory: '/projects/app' }),
        HOME,
      ),
    ).toBe('/projects/app/src/main.ts')
  })

  it('ein `..`, das innerhalb der Wurzel bleibt', () => {
    expect(
      resolveFsRequestPath(
        body({ path: 'src/../README.md', workingDirectory: '/projects/app' }),
        HOME,
      ),
    ).toBe('/projects/app/README.md')
  })
})

describe('die Feldnamen', () => {
  it('sind genau die der Tauri-Befehle — `working_directory` setzt die Wurzel NICHT', () => {
    // `filesystem.rs` deklariert `chatId` / `workingDirectory` und kennt keine
    // zweite Schreibweise. Würde der Dev-Server hier grosszügiger lesen, gäbe
    // es einen Weg, die Käfigwurzel zu setzen, den die Rust-Seite nicht hat.
    expect(() =>
      resolveFsRequestPath(
        body({ path: '/projects/app/x.txt', working_directory: '/projects/app' }),
        HOME,
      ),
    ).toThrow(JailEscapeError)
    expect(resolveFsRequestPath(body({ path: 'x.txt', chat_id: 'c1' }), HOME))
      .toBe(`${SANDBOX}/default/x.txt`)
  })

  it('werden nur als Zeichenketten gelesen — ein Pfad als Zahl ist kein Pfad', () => {
    // Die `args` kommen aus einem Modell; die Typen im Schema sind ein Wunsch.
    expect(resolveFsRequestPath(body({ path: 42, chatId: 'c1' }), HOME)).toBe(`${SANDBOX}/c1`)
    expect(resolveFsRequestPath(body({ path: 'a.txt', workingDirectory: 17 }), HOME))
      .toBe(`${SANDBOX}/default/a.txt`)
  })

  it('überleben einen Körper, der gar kein Objekt ist', () => {
    expect(resolveFsRequestPath(null, HOME)).toBe(`${SANDBOX}/default`)
    expect(resolveFsRequestPath('nope', HOME)).toBe(`${SANDBOX}/default`)
  })
})
