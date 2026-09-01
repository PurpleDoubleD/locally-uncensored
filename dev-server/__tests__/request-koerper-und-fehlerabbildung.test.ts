/**
 * Die Grundschicht jedes /local-api-Handlers: `requirePost`, `withJsonBody`,
 * `sendJson`, `failRequest` — an echten Anfragen.
 *
 * WARUM DAS BISHER NICHT GING. Diese vier Funktionen standen in
 * `vite.config.ts`, ohne `export`, und ihre Aufrufer waren Middlewares an
 * einem `ViteDevServer`. Es gab also keinen Weg, sie zu rufen, ohne den halben
 * Rechner hochzufahren. Ihre BESCHREIBUNG stand seither in
 * src/dev/__tests__/dev-server-shape.test.ts als Textprüfung („der Ausdruck
 * kommt in der Datei vor") — nicht ihr Verhalten.
 *
 * ZWEI ARTEN VON FALL, und der Unterschied wird hier nicht verwischt:
 *
 *  1. „am ausgelieferten Endpunkt" — der Handler kommt aus
 *     `registerFsRoutes`, also aus derselben Funktion, die dev-server/index.ts
 *     einhängt. Nichts daran ist nachgebaut.
 *  2. „an der ausgelieferten Funktion" — `withJsonBody` und `failRequest`
 *     haben je einen Zweig, den KEIN ausgelieferter Endpunkt erreicht (ein
 *     Wurf, der kein JailEscapeError ist). Dort setzt der Test die
 *     Komposition selbst zusammen. Die FUNKTIONEN sind die ausgelieferten,
 *     die drei Zeilen Komposition sind es nicht — das steht hier, damit
 *     niemand den Unterschied für gedeckt hält.
 *
 * Run: npx vitest run dev-server/__tests__/request-koerper-und-fehlerabbildung.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Connect } from 'vite'
import { JailEscapeError } from '../../src/lib/dev-fs-jail'
import { failRequest, requirePost, sendJson, withJsonBody } from '../http'
import { registerFsRoutes } from '../fs-routes'
import { registerDownloadRoutes } from '../downloads'
import { anfrage, routeHolen } from './echte-anfrage'
import { anfrageImHeim, arbeitsordnerIn, frischesHeim, kulisseAufraeumen } from './kaefig-kulisse'

/**
 * Das Wegwerf-Heim, auf das `os.homedir()` für die Dauer jeder Anfrage an
 * einen EINGEHÄNGTEN Handler zeigt — siehe kaefig-kulisse.ts. Ohne das lag
 * `ws` unter Windows in `$HOME\AppData\Local\Temp`, und das erste Tor des
 * Käfigs lehnte die Wurzel mit 403 ab, bevor der geprüfte Code überhaupt
 * dran war.
 */
let heim = ''
let ws = ''

beforeAll(() => {
  heim = frischesHeim()
  ws = arbeitsordnerIn(heim, 'arbeit')
  mkdirSync(ws, { recursive: true })
})

afterAll(kulisseAufraeumen)

/**
 * Jede Anfrage an einen EINGEHÄNGTEN Handler läuft im Wegwerf-Heim. Die drei
 * hand-komponierten Handler weiter unten (`werfer`, `failRequest`, `sendJson`)
 * fassen kein Dateisystem an und rufen `os.homedir()` nie — sie bleiben
 * deshalb beim nackten `anfrage`, und der Unterschied ist genau dieser.
 */
const route = (register: Parameters<typeof routeHolen>[0], pfad: string) =>
  (optionen: Parameters<typeof anfrage>[1]) =>
    anfrageImHeim(routeHolen(register, pfad), heim, optionen)

const fsWrite = () => route(registerFsRoutes, '/local-api/fs-write')
const fsInfo = () => route(registerFsRoutes, '/local-api/fs-info')
const pauseDownload = () => route(registerDownloadRoutes, '/local-api/pause-download')

describe('requirePost — am ausgelieferten Endpunkt', () => {
  for (const methode of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    it(`beantwortet ${methode} mit 405 und leerem Körper`, async () => {
      const res = await fsInfo()({ method: methode })
      expect(res.status).toBe(405)
      expect(res.text).toBe('')
    })
  }

  it('lässt POST durch (die Antwort kommt vom Handler, nicht vom 405)', async () => {
    const res = await fsInfo()({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'gibtsnicht.txt', workingDirectory: ws }),
    })
    expect(res.status).not.toBe(405)
    // 400, weil `statSync` die Datei nicht findet — der Handler HAT geantwortet.
    expect(res.status).toBe(400)
  })
})

describe('withJsonBody — am ausgelieferten Endpunkt', () => {
  it('setzt ein Zeichen wieder zusammen, das auf der Chunk-Grenze zerfällt', async () => {
    // DER BEFUND, den src/dev/http-body.ts behebt: `body += chunk` dekodiert
    // JEDEN Chunk für sich. Ein Zeichen, dessen UTF-8-Bytes sich auf zwei
    // Chunks verteilen, kommt in beiden Hälften als U+FFFD an — und war damit
    // unwiederbringlich weg, BEVOR JSON.parse es je sah.
    //
    // Hier wird das nicht behauptet, sondern ausgelöst: der Körper geht als
    // ZWEI echte TCP-Segmente über die Leitung, und die Grenze liegt MITTEN in
    // den vier Bytes des Emoji.
    const inhalt = 'Grüße 😀 Ende'
    const koerper = Buffer.from(
      JSON.stringify({ path: 'chunk.txt', content: inhalt, workingDirectory: ws }),
      'utf8',
    )
    const emojiStart = koerper.indexOf(Buffer.from('😀', 'utf8'))
    expect(emojiStart, 'das Emoji muss im Körper stehen').toBeGreaterThan(0)
    const schnitt = emojiStart + 2 // mitten in den vier Bytes

    const res = await fsWrite()({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: [koerper.subarray(0, schnitt), koerper.subarray(schnitt)],
    })

    expect(res.status).toBe(200)
    // Der eigentliche Beweis steht auf der Platte, nicht in der Antwort.
    expect(readFileSync(join(ws, 'chunk.txt'), 'utf8')).toBe(inhalt)
  })

  it('beantwortet kaputtes JSON mit 400 statt den Prozess zu beenden', async () => {
    // Drei Handler riefen `JSON.parse(body)` ohne try, IN einem `end`-Zuhörer.
    // Ein Wurf dort kommt an, wenn die Middleware längst zurück ist — niemand
    // fängt ihn, und `npm run dev` endet an einer einzigen kaputten POST.
    //
    // GEPRÜFT AN `pause-download`, aus demselben Grund wie beim leeren Körper
    // weiter unten: bliebe der Leser einmal stehen und reichte den Körper als
    // `undefined` durch, fiele die Käfigwurzel eines fs-Endpunkts auf
    // `~/<AGENT_WORKSPACE_DIR>/default` — der Test würde dann beim Fehlschlagen
    // ins echte Heimatverzeichnis schreiben. Ein Test, der im Fehlerfall Müll
    // hinterlässt, ist beim Gegenprobieren nicht brauchbar.
    const res = await pauseDownload()({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ das ist kein JSON',
    })
    expect(res.status).toBe(400)
    expect(String((res.json() as { error?: string }).error)).toContain('Invalid JSON body')
  })

  it('und antwortet danach weiter (der Prozess lebt)', async () => {
    // Die Zusicherung, die den vorigen Fall erst zu einer macht: nach dem
    // kaputten Körper muss der nächste Request noch bedient werden.
    const res = await fsInfo()({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'chunk.txt', workingDirectory: ws }),
    })
    expect(res.status).toBe(200)
    expect(res.json()).toMatchObject({ isFile: true })
  })

  it('reicht einen LEEREN Körper als undefined durch, statt ihn abzulehnen', async () => {
    // Gemessen, nicht geraten: `parseJsonBody` gibt für einen leeren Körper
    // `{ ok: true, value: undefined }` zurück und sagt in seinem eigenen
    // Kommentar auch warum — die Endpunkte, die ohne Felder auskommen, sollen
    // durch ihre EIGENE Pflichtfeld-Prüfung laufen, nicht durch die des
    // Lesers. Der Test hielt hier zuerst 400 fest; das war meine Erwartung,
    // nicht das Verhalten.
    //
    // GEPRÜFT WIRD AN `pause-download`, nicht an einem fs-Endpunkt, und das
    // ist kein Zufall: ein leerer Körper kann kein `workingDirectory` tragen,
    // also fiele die Käfigwurzel dort auf `~/<AGENT_WORKSPACE_DIR>/default`
    // zurück — und der Test legte eine Datei im ECHTEN Heimatverzeichnis an.
    // Beim ersten Lauf dieser Datei ist genau das passiert (fs-write, 0 Bytes,
    // `~/agent-workspace-experiment/default`). `pause-download` fasst kein
    // Dateisystem an.
    const res = await pauseDownload()({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    })
    // Kein 400 vom Leser — der Handler antwortet selbst.
    expect(res.status).toBe(200)
    expect(res.json()).toEqual({ status: 'paused' })
  })
})

describe('withJsonBody und failRequest — an der ausgelieferten Funktion', () => {
  // ZUR EHRLICHKEIT: die drei Zeilen Komposition unten sind vom Test, nicht
  // aus der App. Die Funktionen sind die ausgelieferten. Es gibt keinen
  // Endpunkt, der diesen Zweig erreicht — jeder Wurf, der heute bis hierher
  // kommt, ist ein JailEscapeError —, und ein Zweig ohne Zusicherung ist der
  // Zweig, der beim nächsten Umbau still verschwindet.

  /** Ein Handler, der wirft, was der Test ihm sagt. */
  const werfer = (fehler: unknown): Connect.NextHandleFunction => (req, res) => {
    if (!requirePost(req, res)) return
    withJsonBody(req, res, () => { throw fehler })
  }

  it('bildet einen gewöhnlichen Wurf auf 400 ab', async () => {
    const res = await anfrage(werfer(new Error('etwas ging schief')), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(400)
    expect(res.json()).toEqual({ error: 'etwas ging schief' })
  })

  it('bildet einen JailEscapeError auf 403 ab', async () => {
    const res = await anfrage(werfer(new JailEscapeError('raus hier')), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(403)
    expect(res.json()).toEqual({ error: 'raus hier' })
  })

  it('failRequest trennt dieselben beiden Fälle', async () => {
    const mitFailRequest = (fehler: unknown): Connect.NextHandleFunction => (_req, res) => {
      failRequest(res, fehler)
    }
    const jail = await anfrage(mitFailRequest(new JailEscapeError('ausbruch')))
    expect(jail.status).toBe(403)
    expect(jail.json()).toEqual({ error: 'ausbruch' })

    const gewoehnlich = await anfrage(mitFailRequest(new Error('kaputt')))
    expect(gewoehnlich.status).toBe(400)
    expect(gewoehnlich.json()).toEqual({ error: 'kaputt' })
  })

  it('sendJson setzt Status und Content-Type, die jeder Handler hier schreibt', async () => {
    const res = await anfrage((_req, r) => { sendJson(r, 201, { a: 1 }) })
    expect(res.status).toBe(201)
    expect(res.headers['content-type']).toBe('application/json')
    expect(res.json()).toEqual({ a: 1 })
  })
})
