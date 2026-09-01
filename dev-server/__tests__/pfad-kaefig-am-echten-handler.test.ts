/**
 * Der Pfad-Käfig, geprüft an den Handlern, die `npm run dev` ausliefert.
 *
 * WAS VORHER FEHLTE. Die Käfig-REGEL hat seit langem Tests
 * (src/lib/__tests__/dev-fs-jail*.test.ts, src/dev/__tests__/
 * fs-request-path.test.ts), und dass die sechs Türen sie AUFRUFEN, hält
 * src/dev/__tests__/dev-server-shape.test.ts als Textprüfung fest. Was es
 * nicht gab, war der Beweis, dass eine echte Anfrage an einen echten Handler
 * dann auch wirklich abgelehnt wird — die Handler steckten in
 * `vite.config.ts`, erreichbar nur über einen laufenden Vite-Dev-Server.
 *
 * Diese Datei schliesst genau diese Lücke: echte Bytes, echter Socket, echtes
 * Dateisystem, und der Handler ist der aus `registerFsRoutes` — dieselbe
 * Funktion, die dev-server/index.ts einhängt.
 *
 * Run: npx vitest run dev-server/__tests__/pfad-kaefig-am-echten-handler.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerFsRoutes } from '../fs-routes'
import { registerDownloadRoutes } from '../downloads'
import { routeHolen } from './echte-anfrage'
import { anfrageImHeim, arbeitsordnerIn, frischesHeim, kulisseAufraeumen } from './kaefig-kulisse'

/**
 * Das Wegwerf-Heim, in dem die Kulisse steht, und auf das `os.homedir()` für
 * die Dauer jeder Anfrage zeigt — siehe kaefig-kulisse.ts. Ohne das lag die
 * Wurzel unter Windows in `$HOME\AppData\Local\Temp` und wurde vom ERSTEN
 * Tor des Käfigs abgelehnt, bevor irgendein Pfad geprüft war: die fünf
 * 403-Fälle hier waren dort grün, aber aus dem falschen Grund.
 */
let heim = ''
/** Der Arbeitsordner, der in diesen Tests die Käfigwurzel ist. */
let ws = ''
/** Ein Ordner NEBEN dem Käfig — hierhin darf keine Anfrage reichen. */
let daneben = ''

beforeAll(() => {
  heim = frischesHeim()
  ws = arbeitsordnerIn(heim)
  daneben = join(heim, 'geheim')
  mkdirSync(ws, { recursive: true })
  mkdirSync(daneben, { recursive: true })
  writeFileSync(join(ws, 'drin.txt'), 'ich liege im Käfig\n', 'utf8')
  writeFileSync(join(daneben, 'passwort.txt'), 'streng geheim\n', 'utf8')
})

afterAll(kulisseAufraeumen)

/** Eine echte POST-Anfrage an einen der sechs fs-Endpunkte, im Wegwerf-Heim. */
function fsPost(endpunkt: string, koerper: Record<string, unknown>) {
  const handler = routeHolen(registerFsRoutes, `/local-api/${endpunkt}`)
  return anfrageImHeim(handler, heim, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(koerper),
  })
}

describe('der Käfig lässt herein, was drin liegt', () => {
  it('fs-read gibt eine Datei im Arbeitsordner zurück', async () => {
    const res = await fsPost('fs-read', { path: 'drin.txt', workingDirectory: ws })
    expect(res.status).toBe(200)
    expect(res.json()).toMatchObject({ content: 'ich liege im Käfig\n' })
  })

  it('fs-info beschreibt eine Datei im Arbeitsordner', async () => {
    const res = await fsPost('fs-info', { path: 'drin.txt', workingDirectory: ws })
    expect(res.status).toBe(200)
    expect(res.json()).toMatchObject({ isFile: true, isDir: false })
  })
})

describe('der Käfig weist ab, was hinausführt', () => {
  // Der Kern: `..` klettert aus dem Arbeitsordner heraus. Vor dem Käfig
  // beantworteten diese fünf Endpunkte genau das mit dem Inhalt der fremden
  // Datei.
  const ausbruch = '../geheim/passwort.txt'

  it('fs-read antwortet 403 und NICHT mit dem Inhalt', async () => {
    const res = await fsPost('fs-read', { path: ausbruch, workingDirectory: ws })
    expect(res.status).toBe(403)
    expect(res.text).not.toContain('streng geheim')
  })

  it('fs-info antwortet 403', async () => {
    const res = await fsPost('fs-info', { path: ausbruch, workingDirectory: ws })
    expect(res.status).toBe(403)
  })

  it('fs-read-bytes antwortet 403', async () => {
    const res = await fsPost('fs-read-bytes', { path: ausbruch, workingDirectory: ws })
    expect(res.status).toBe(403)
    expect(res.text).not.toContain('base64')
  })

  it('fs-list antwortet 403 statt 200 mit leerer Liste', async () => {
    // Diese Unterscheidung ist der Grund, warum der Käfig VOR dem `try` steht:
    // der catch dieses Handlers antwortet mit 200 und `entries: []`, ein
    // Ausbruchsversuch sähe darin aus wie ein leeres Verzeichnis.
    const res = await fsPost('fs-list', { path: '../geheim', workingDirectory: ws })
    expect(res.status).toBe(403)
    expect(res.text).not.toContain('passwort.txt')
  })

  it('fs-search antwortet 403 statt 200 mit leerer Trefferliste', async () => {
    const res = await fsPost('fs-search', {
      path: '../geheim',
      pattern: 'geheim',
      workingDirectory: ws,
    })
    expect(res.status).toBe(403)
    expect(res.text).not.toContain('passwort.txt')
  })

  it('fs-write antwortet 403 UND legt die Datei draussen nicht an', async () => {
    // Der teuerste der sechs: er schrieb auf jeden Pfad, den der Prozess
    // öffnen darf. Die zweite Zusicherung ist die wichtigere — ein 403, nach
    // dem die Datei trotzdem dasteht, wäre wertlos.
    const ziel = join(daneben, 'eingeschleust.txt')
    const res = await fsPost('fs-write', {
      path: '../geheim/eingeschleust.txt',
      content: 'hier war jemand',
      workingDirectory: ws,
    })
    expect(res.status).toBe(403)
    expect(existsSync(ziel)).toBe(false)
  })
})

describe('das erste Tor: welche Wurzel überhaupt ein Käfig sein darf', () => {
  it('lehnt workingDirectory "/" ab, statt die ganze Platte freizugeben', async () => {
    // Mit `/` als Wurzel liegt JEDER Pfad „innerhalb": die Prüfung wäre formal
    // intakt und praktisch wertlos. Am laufenden Dev-Server war das einmal so.
    const res = await fsPost('fs-read', { path: '/etc/hosts', workingDirectory: '/' })
    expect(res.status).toBe(403)
    expect(res.text).not.toContain('localhost')
  })

  it('lehnt das Heimatverzeichnis als Wurzel ab', async () => {
    // `heim` UND NICHT `process.env.HOME`: gemeint war immer „das
    // Heimatverzeichnis, das der Handler sieht". Unter Windows liest
    // `os.homedir()` `USERPROFILE`, nicht `HOME`, und der alte Ausdruck fiel
    // ohne gesetztes `HOME` auf `'/'` zurück — das ist ein 403 aus einem
    // ANDEREN Grund (Laufwerkswurzel). Die Aussage bleibt dieselbe, sie trifft
    // jetzt auf beiden Plattformen wirklich das Heimatverzeichnis.
    const res = await fsPost('fs-list', { path: '.', workingDirectory: heim })
    expect(res.status).toBe(403)
  })
})

describe('Symlinks führen nicht hinaus', () => {
  it('folgt einem Symlink aus dem Arbeitsordner nicht', async () => {
    // Der Käfig prüfte einmal rein lexikalisch, also glaubte er dem
    // Pfad-STRING: `<ws>/raus/passwort.txt` liest sich wie „drin".
    const link = join(ws, 'raus')
    if (!existsSync(link)) symlinkSync(daneben, link, 'dir')
    const res = await fsPost('fs-read', { path: 'raus/passwort.txt', workingDirectory: ws })
    expect(res.status).toBe(403)
    expect(res.text).not.toContain('streng geheim')
  })
})

describe('failRequest bildet den Ausbruch auf 403 ab, nicht auf 400', () => {
  it('download-model-to-path lehnt einen Dateinamen mit .. ab', async () => {
    // Der einzige ausgelieferte Handler, der `failRequest` auf einem Weg
    // erreicht, der KEINE ComfyUI-Installation braucht: `downloadToPathDest`
    // wirft, bevor irgendein Verzeichnis angelegt oder ein Byte geholt wird.
    const handler = routeHolen(registerDownloadRoutes, '/local-api/download-model-to-path')
    const res = await anfrageImHeim(handler, heim, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.invalid/modell.gguf',
        destDir: ws,
        filename: '../geheim/eingeschleust.gguf',
      }),
    })
    expect(res.status).toBe(403)
    expect(res.json()).toHaveProperty('error')
    expect(existsSync(join(daneben, 'eingeschleust.gguf'))).toBe(false)
  })

  it('und beantwortet einen gültigen Namen NICHT mit 403', async () => {
    // Die Gegenprobe: ein Test, der nur Ablehnung prüft, wäre auch grün, wenn
    // der Endpunkt alles ablehnte.
    const handler = routeHolen(registerDownloadRoutes, '/local-api/download-model-to-path')
    const res = await anfrageImHeim(handler, heim, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Kein `url`: der Handler antwortet mit „Missing …" — das reicht, um zu
      // zeigen, dass der Käfig hier nicht zugeschlagen hat, und es holt keine
      // Bytes aus dem Netz.
      body: JSON.stringify({ destDir: ws, filename: 'brav.gguf' }),
    })
    expect(res.status).toBe(400)
    expect(String((res.json() as { error?: string }).error)).toContain('Missing')
  })
})

describe('der Käfig schreibt wirklich, wenn er darf', () => {
  it('fs-write legt eine Datei im Arbeitsordner an', async () => {
    const res = await fsPost('fs-write', {
      path: 'neu/datei.txt',
      content: 'geschrieben',
      workingDirectory: ws,
    })
    expect(res.status).toBe(200)
    expect(readFileSync(join(ws, 'neu', 'datei.txt'), 'utf8')).toBe('geschrieben')
  })
})
