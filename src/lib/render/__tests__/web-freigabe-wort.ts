/**
 * Die EINE gewollte Abweichung zwischen Desktop und Web in den Mediennamen.
 *
 * 08.10.2026: die offenen Medienmodelle und drei Presets tragen im
 * Desktop das Wort der zweiten Marke ("Uncensored"). Das Web auf der
 * Zahlungsdomain fuehrt dafuer sein neutrales Wort und baut die Namen aus
 * einer Konstante (the web app, STATEMENT_MARK_LABEL).
 * Die Paritaetswaechter kennen genau diesen einen Tausch und lesen das Wort
 * des Webs aus dessen Datei, statt es hier zu tippen. Alles andere an Namen,
 * Ids und Reihenfolge bleibt Zeichen fuer Zeichen verglichen.
 *
 * Seit dem Zusatzfeld (08.10.2026) nennt das Web den Namen des Desktops
 * selbst: /api/jobs/catalog liefert ihn als `native_label` neben `label`, und
 * die App zeigt ihn (api/cloud/catalog.ts). Abgeleitet wird er im Web an einer
 * Stelle (the web app). Die Waechter laden genau
 * diese Datei, statt die Ableitung hier nachzubauen: verglichen wird gegen
 * das, was der Server wirklich schickt.
 *
 * Kein Test, nur der gemeinsame Leser fuer katalog-paritaet-web,
 * studio-contract und unfiltered-mark-parity-web.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { STATEMENT_MARK_LABEL } from '../../unfiltered-mark'
import { webModule } from '../../__tests__/web-checkout'

const REL_PATH = 'apps/web/lib/unfiltered-mark.ts'

/** So schreibt das Web das Wort in seine Katalognamen. */
// Seit dem 12.10.2026 hat das Web zwei Woerter: die Marke der Zeile
// (STATEMENT_MARK_LABEL) und den Baustein der Namen (STATEMENT_NAME_WORD).
// Die Namen bauen auf dem zweiten.
export const WEB_PLATZHALTER = '${STATEMENT_NAME_WORD}'

/** Das Wort des Desktops. */
export const DESKTOP_WORT = STATEMENT_MARK_LABEL

/** Das Wort des Webs, gelesen aus dem Checkout. Wirft, wenn es fehlt: ein
 *  Vergleich ohne das Wort waere ein Vergleich gegen eine Annahme. */
export function webWort(webRepo: string): string {
  const quelle = readFileSync(resolve(webRepo, REL_PATH), 'utf8')
  // Der Baustein der Namen. Ein Web von vor dem 12.10.2026 hat nur das eine
  // Wort der Marke.
  for (const name of ['STATEMENT_NAME_WORD', 'STATEMENT_MARK_LABEL']) {
    const m = quelle.match(new RegExp(`export const ${name} =\\s*\\n?\\s*(['"])(.*)\\1`))
    if (m && m[2]) return m[2]
  }
  throw new Error(`STATEMENT_NAME_WORD not found in ${REL_PATH}`)
}

/** Ein Name des Webs, wie der Desktop ihn fuehrt: das eine Wort getauscht,
 *  sonst nichts angefasst. */
export function alsDesktop(webName: string, wort: string): string {
  return webName.split(wort).join(DESKTOP_WORT)
}

const NAMEN_PATH = 'apps/web/lib/render/desktop-names.ts'

/** Die Ableitung des Webs, geladen aus dessen Checkout. */
export interface WebNamen {
  /** Das Wort, mit dem das Web den Platzhalter fuer die App fuellt. */
  DESKTOP_MARK_LABEL: string
  /** Was die Katalogroute als `native_label` schickt, null wo nichts abweicht. */
  desktopName: (webName: string) => string | null
  /** Die Gegenrichtung: ein Name der App im Wort des Webs. */
  webName: (name: string) => string
}

export async function webNamen(webRepo: string): Promise<WebNamen> {
  const namen = await webModule<Partial<WebNamen>>(webRepo, NAMEN_PATH)
  if (typeof namen.desktopName !== 'function' || typeof namen.webName !== 'function' || !namen.DESKTOP_MARK_LABEL) {
    throw new Error(`${NAMEN_PATH} does not export the desktop names`)
  }
  return namen as WebNamen
}

/** Der Name, den die App fuer einen Katalognamen des Webs zeigt: das
 *  Zusatzfeld, wo der Server eines schickt, sonst der Name selbst. Dieselbe
 *  Regel wie desktopCatalog in api/cloud/catalog.ts. */
export function gezeigt(namen: WebNamen, webName: string): string {
  return namen.desktopName(webName) ?? webName
}
