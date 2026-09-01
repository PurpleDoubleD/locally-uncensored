/**
 * KF-12 — eine `fs-write`-Anfrage, die keine Datei nennt.
 *
 * DER BEFUND, live ausgelöst und nicht vermutet: `POST /local-api/fs-write {}`
 * antwortete mit 200 `{"status":"saved"}` und hinterliess ein 0-Byte
 * `~/<AGENT_WORKSPACE_DIR>/default` — eine DATEI an der Stelle, an der der
 * nächste echte Schreibvorgang einen ORDNER braucht. Kein Ausbruch aus dem
 * Käfig: der Pfad liegt innerhalb dessen, was der Käfig erlaubt. Ein
 * Schreibvorgang an einer Stelle, die niemand gemeint hat.
 *
 * WOHER SO EINE ANFRAGE KOMMT: `executeFileWrite` in
 * src/api/mcp/builtin-tools.ts reicht `args.path` des MODELLS ungeprüft an
 * `backendCall('fs_write', …)` weiter. Lässt das Modell `path` weg, fällt es
 * bei `JSON.stringify` aus dem Körper — und der Körper ist `{content: "…"}`.
 *
 * WARUM DIE ANDEREN FÜNF TÜREN HIER MITSTEHEN: sie teilen sich eine
 * Zusicherung, und der wiederkehrende Grundfehler dieses Projekts ist die eine
 * Tür, die anders reagiert als ihre Geschwister. Gemessen (nicht vermutet)
 * reagierte genau eine anders — die einzige, die schreibt.
 *
 * KEIN MOCK: der Handler kommt aus derselben `registerFsRoutes`, die
 * dev-server/index.ts einhängt, hängt an einem echten node:http-Server und
 * bekommt echte Bytes (siehe echte-anfrage.ts).
 *
 * DAS HEIMATVERZEICHNIS WIRD UMGEBOGEN, statt das echte zu benutzen: die
 * Handler rufen `os.homedir()` selbst auf. Umgebogen werden BEIDE Variablen,
 * die `os.homedir()` liest — `HOME` unter POSIX und `USERPROFILE` unter
 * Windows. Nur `HOME` zu setzen hiesse, dass diese Fälle unter Windows gegen
 * einen Wegwerf-Pfad prüfen, den der Handler nie anfasst: sie wären dort
 * VAKUUM-GRÜN und blieben auch ohne die Prüfung grün, während der Handler ins
 * echte Profil schriebe.
 *
 * Run: npx vitest run dev-server/__tests__/schreiben-ohne-ziel.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_WORKSPACE_DIR } from '../../src/lib/app-identity'
import { registerFsRoutes } from '../fs-routes'
import { anfrage, routeHolen } from './echte-anfrage'

/** Alles, was diese Datei anlegt, damit `afterAll` es wieder los wird. */
const wegwerf: string[] = []

afterAll(() => {
  for (const p of wegwerf) rmSync(p, { recursive: true, force: true })
})

/** Ein frisches Wegwerf-Heimatverzeichnis. `realpathSync`, weil /var auf macOS ein Symlink ist. */
function frischesHeim(): string {
  const heim = realpathSync(mkdtempSync(join(tmpdir(), 'lu-kf12-')))
  wegwerf.push(heim)
  return heim
}

/** Die Käfigwurzel, die ein Request ohne `workingDirectory` und ohne `chatId` trifft. */
function sandkasten(heim: string): string {
  return join(heim, AGENT_WORKSPACE_DIR, 'default')
}

/** Die beiden Variablen, aus denen `os.homedir()` sein Ergebnis nimmt. */
const HEIM_VARIABLEN = ['HOME', 'USERPROFILE'] as const

/** Eine echte POST-Anfrage an eine der sechs fs-Türen, mit umgebogenem Heim. */
async function fsPost(
  endpunkt: string,
  koerper: Record<string, unknown>,
  heim?: string,
) {
  const handler = routeHolen(registerFsRoutes, `/local-api/${endpunkt}`)
  const vorher = HEIM_VARIABLEN.map((name) => [name, process.env[name]] as const)
  if (heim !== undefined) for (const name of HEIM_VARIABLEN) process.env[name] = heim
  try {
    return await anfrage(handler, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(koerper),
    })
  } finally {
    for (const [name, wert] of vorher) {
      if (wert === undefined) delete process.env[name]
      else process.env[name] = wert
    }
  }
}

describe('fs-write ohne Ziel legt die Käfigwurzel nicht als Datei an', () => {
  // Die vier Schreibweisen DERSELBEN Lage. Ein Test nur auf die erste wäre auch
  // grün, wenn die Prüfung auf dem rohen String statt auf dem aufgelösten Pfad
  // stünde — und die vierte Schreibweise käme dann durch.
  const schreibweisen: Array<[string, Record<string, unknown>]> = [
    ['gar kein path (der live ausgelöste Fall)', {}],
    ['path: ""', { path: '' }],
    ['path: "."', { path: '.' }],
    ['path: "unterordner/.." — dieselbe Wurzel, anders geschrieben', { path: 'unterordner/..' }],
  ]

  for (const [name, koerper] of schreibweisen) {
    it(`antwortet 400 auf ${name} und schreibt nichts`, async () => {
      const heim = frischesHeim()
      const res = await fsPost('fs-write', { ...koerper, content: 'darf nirgends landen' }, heim)
      expect(res.status).toBe(400)
      expect(String((res.json() as { error?: string }).error)).toContain('Missing path')
      // Die zweite Zusicherung ist die wichtigere: ein 400, nach dem die Datei
      // trotzdem dasteht, wäre wertlos.
      expect(existsSync(sandkasten(heim))).toBe(false)
    })
  }

  it('antwortet 400 auch mit chatId, statt den Chat-Ordner als Datei anzulegen', async () => {
    const heim = frischesHeim()
    const res = await fsPost('fs-write', { chatId: 'mein-chat', content: 'x' }, heim)
    expect(res.status).toBe(400)
    expect(existsSync(join(heim, AGENT_WORKSPACE_DIR, 'mein-chat'))).toBe(false)
  })

  it('antwortet 400 auf ein workingDirectory ohne path, statt den Ordner als Datei anzulegen', async () => {
    // Die schärfere Form: hier bestimmt der Aufrufer Ort UND Inhalt. Vorher
    // antwortete das mit 200 und einer 8-Byte-Datei namens `projekt-neu`.
    const basis = frischesHeim()
    const nochNichtDa = join(basis, 'projekt-neu')
    const res = await fsPost('fs-write', { workingDirectory: nochNichtDa, content: 'BELIEBIG' })
    expect(res.status).toBe(400)
    expect(existsSync(nochNichtDa)).toBe(false)
  })
})

describe('die Gegenprobe: der Käfig schreibt weiterhin, wenn eine Datei genannt ist', () => {
  // Ohne diese beiden wäre die Prüfung oben auch grün, wenn fs-write ALLES
  // ablehnte.
  it('legt die Wurzel als ORDNER an und die Datei hinein', async () => {
    const heim = frischesHeim()
    const res = await fsPost('fs-write', { path: 'notiz.txt', content: 'geschrieben' }, heim)
    expect(res.status).toBe(200)
    expect(res.json()).toMatchObject({ status: 'saved' })
    // Genau der Punkt, warum die Wurzel NICHT eigens angelegt werden muss: der
    // normale Weg legt sie über `mkdirSync(parentDir, { recursive: true })` an,
    // und zwar als Ordner.
    expect(lstatSync(sandkasten(heim)).isDirectory()).toBe(true)
    expect(readFileSync(join(sandkasten(heim), 'notiz.txt'), 'utf8')).toBe('geschrieben')
  })

  it('schreibt auch in einen tieferen Unterordner des Arbeitsordners', async () => {
    const basis = frischesHeim()
    const ws = join(basis, 'arbeitsordner')
    mkdirSync(ws, { recursive: true })
    const res = await fsPost('fs-write', {
      path: 'a/b/c.txt',
      content: 'tief drin',
      workingDirectory: ws,
    })
    expect(res.status).toBe(200)
    expect(readFileSync(join(ws, 'a', 'b', 'c.txt'), 'utf8')).toBe('tief drin')
  })
})

describe('die fünf Geschwister geraten nicht in dieselbe Lage', () => {
  // GEMESSEN, nicht vermutet. Mit leerem Körper `{}` löst jede der sechs Türen
  // auf dieselbe Käfigwurzel auf — nur eine von ihnen schreibt. Diese Fälle
  // halten fest, dass die anderen fünf NICHTS auf die Platte legen; wer einer
  // von ihnen ein „lege den Ordner schon mal an" beibringt, wird hier rot.
  const lesende = ['fs-read', 'fs-read-bytes', 'fs-list', 'fs-search', 'fs-info']

  for (const tuer of lesende) {
    it(`${tuer} legt mit leerem Körper nichts auf der Platte an`, async () => {
      const heim = frischesHeim()
      await fsPost(tuer, {}, heim)
      expect(existsSync(join(heim, AGENT_WORKSPACE_DIR)), tuer).toBe(false)
    })
  }

  it('fs-read-bytes hat für „nichts angegeben" schon die Meldung, die fs-write jetzt auch hat', async () => {
    // Die geteilte Zusicherung, an der sich fs-write ausrichtet: die Tür sagt
    // selbst, dass nichts angegeben wurde — der Käfig erfindet das nicht.
    const heim = frischesHeim()
    const res = await fsPost('fs-read-bytes', {}, heim)
    expect(res.status).toBe(400)
    expect(String((res.json() as { error?: string }).error)).toContain('Missing path')
  })

  it('fs-list mit path "." bleibt erlaubt — die Wurzel LESEN ist eine gültige Anfrage', async () => {
    // Die Gegenprobe zur Verallgemeinerung: „path, der auf die Wurzel zeigt"
    // ist NUR beim Schreiben sinnlos. Rust hält den Fall an derselben Stelle
    // eigens offen (`is_workspace_root_path`, filesystem.rs:474). Eine
    // Ablehnung hier wäre eine Verengung ohne Befund dahinter.
    const basis = frischesHeim()
    const ws = join(basis, 'arbeitsordner')
    mkdirSync(join(ws, 'unterordner'), { recursive: true })
    const res = await fsPost('fs-list', { path: '.', workingDirectory: ws })
    expect(res.status).toBe(200)
    expect(res.text).toContain('unterordner')
  })
})
