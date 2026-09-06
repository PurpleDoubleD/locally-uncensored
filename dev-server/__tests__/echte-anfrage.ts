/**
 * Die Prüfvorrichtung dieses Ordners: EIN echter node:http-Server, EIN echter
 * Handler daran, ECHTE Anfragen darüber.
 *
 * WARUM DAS HIER NICHT MOGELT. Dieses Projekt hat die Regel, dass Tests gegen
 * Echtes laufen — der wiederkehrende Grundfehler ist „zwei Beschreibungen
 * derselben Sache, nur eine gepflegt". Hier wird deshalb NICHTS nachgebaut:
 *
 *  • Der Handler ist der, den `npm run dev` ausliefert. Er kommt aus derselben
 *    `register…Routes(routes)`-Funktion, die dev-server/index.ts aufruft; nur
 *    das `RouteMount` ist ein anderes (es sammelt statt einzuhängen).
 *  • Der Server ist `node:http`, der Socket ist ein echter Loopback-Socket,
 *    der Körper geht als echte Bytes über die Leitung.
 *
 * WAS HIER NICHT LÄUFT, und zwar mit Absicht: connects Pfad-Verteilung. Vite
 * hängt die Handler mit `server.middlewares.use(pfad, handler)` ein, und
 * connect schneidet den Einhängepfad vorher aus `req.url`. Diese Vorrichtung
 * hängt EINEN Handler auf die Wurzel und schickt genau die Pfade, die connect
 * ihm gäbe — also `mountRelativeUrl`. Damit wird connect nicht nachgebaut,
 * sondern umgangen: sein Verteiler ist Vites Code, nicht unserer.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { request as httpRequest } from 'node:http'
import type { Connect } from 'vite'
import type { RouteMount } from '../routes'

/**
 * Sammelt ein, was eine Register-Funktion einhängen WÜRDE, ohne einen
 * Vite-Server dafür zu brauchen. Der Rückgabewert bildet Einhängepfad auf
 * Handler ab — genau die Paare, die in der App an `server.middlewares.use`
 * gehen.
 */
export function sammleRouten(
  register: (routes: RouteMount) => void,
): Map<string, Connect.NextHandleFunction> {
  const gesammelt = new Map<string, Connect.NextHandleFunction>()
  register({
    use(pfad, handler) {
      gesammelt.set(pfad, handler)
    },
  })
  return gesammelt
}

/** Der Handler EINES Endpunkts, mit sprechendem Fehler, wenn es ihn nicht gibt. */
export function routeHolen(
  register: (routes: RouteMount) => void,
  pfad: string,
): Connect.NextHandleFunction {
  const routen = sammleRouten(register)
  const handler = routen.get(pfad)
  if (!handler) {
    throw new Error(`kein Handler für ${pfad} — vorhanden: ${[...routen.keys()].join(', ')}`)
  }
  return handler
}

export interface Antwort {
  status: number
  headers: Record<string, string | string[] | undefined>
  text: string
  /** Der Körper als JSON, oder ein sprechender Fehler statt eines nackten Wurfs. */
  json(): unknown
}

export interface AnfrageOptionen {
  method?: string
  /**
   * Die Adresse, wie connect sie dem Handler gäbe: OHNE den Einhängepfad.
   * `/local-api/fs-read` kommt beim Handler als `/` an, `/local-api/transcribe`
   * beim /local-api-Wächter als `/transcribe`.
   */
  url?: string
  headers?: Record<string, string>
  /**
   * Der Körper. Ein Array wird als MEHRERE Chunks geschickt, mit einer echten
   * Pause dazwischen, damit der Server sie als getrennte `data`-Ereignisse
   * sieht — das ist der einzige Weg, den Zeichen-auf-der-Chunk-Grenze-Fehler
   * überhaupt auszulösen.
   */
  body?: string | Buffer | Array<string | Buffer>
}

/**
 * Startet einen echten Server auf einem freien Port, schickt eine echte
 * Anfrage hindurch und hält ihn wieder an.
 *
 * Port 0 heisst „gib mir irgendeinen freien": diese Vorrichtung belegt
 * deshalb nie 5273 (der Dev-Server der e2e-Läufe) und auch sonst keinen Port,
 * den jemand erwartet.
 */
export async function anfrage(
  handler: Connect.NextHandleFunction,
  optionen: AnfrageOptionen = {},
): Promise<Antwort> {
  const server = createServer((req, res) => {
    handler(req, res, () => {
      // `next()` heisst hier: der Handler wollte nicht antworten. In der App
      // ginge es weiter zur nächsten Middleware; im Test ist das ein
      // unterscheidbarer Ausgang und kein stiller Hänger.
      res.writeHead(599, { 'Content-Type': 'text/plain' })
      res.end('next() aufgerufen — dieser Handler hat durchgereicht')
    })
  })

  await new Promise<void>((fertig) => server.listen(0, '127.0.0.1', fertig))
  const port = (server.address() as AddressInfo).port

  try {
    return await new Promise<Antwort>((erfuellen, ablehnen) => {
      const chunks = optionen.body === undefined
        ? []
        : Array.isArray(optionen.body) ? optionen.body : [optionen.body]

      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: optionen.method ?? 'GET',
          path: optionen.url ?? '/',
          headers: optionen.headers ?? {},
        },
        (res) => {
          const teile: Buffer[] = []
          res.on('data', (c: Buffer) => teile.push(c))
          res.on('end', () => {
            const text = Buffer.concat(teile).toString('utf8')
            erfuellen({
              status: res.statusCode ?? 0,
              headers: res.headers,
              text,
              json: () => {
                try {
                  return JSON.parse(text)
                } catch {
                  throw new Error(`Antwort war kein JSON (${res.statusCode}): ${text.slice(0, 200)}`)
                }
              },
            })
          })
        },
      )
      req.on('error', ablehnen)

      // Die Chunks EINZELN und mit echter Pause: ohne sie fasst der Kernel sie
      // zu einem TCP-Segment zusammen und der Server sieht ein einziges
      // `data`-Ereignis — dann kann der Fehler, den das prüfen soll, gar nicht
      // auftreten.
      const schreiben = (i: number) => {
        if (i >= chunks.length) {
          req.end()
          return
        }
        req.write(chunks[i], () => {
          if (chunks.length === 1) {
            req.end()
            return
          }
          setTimeout(() => schreiben(i + 1), 25)
        })
      }
      schreiben(0)
    })
  } finally {
    await new Promise<void>((fertig) => server.close(() => fertig()))
  }
}
