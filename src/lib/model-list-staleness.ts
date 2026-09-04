/**
 * Welche Aenderung an einem Backend die Modelliste veralten laesst.
 *
 * Die Regel stand wortgleich zweimal im Baum, im Waehler ueber dem
 * Eingabefeld und in der Kopfleiste, und beide Fassungen kannten genau zwei
 * Felder: `enabled` und `baseUrl`. Die Quelle der ganzen Liste haengt aber an
 * `managed`. Haelt unsere eigene Engine den geteilten `openai`-Steckplatz,
 * fragt `useModels` `list_bundled_models` statt `/v1/models`, nimmt den
 * Steckplatz aus der Provider-Runde heraus und stellt die Zeilen des
 * verdraengten Backends unter eine eigene Ueberschrift daneben
 * (`isManagedBuiltinActive`, `standbyChatBackend`). Ein Schreiben, das nur den
 * Halter des Steckplatzes dreht, schreibt die Liste also am staerksten um, und
 * genau das loeste kein Nachladen aus.
 *
 * `name` ist aus demselben Grund dabei: er ist das Einzige, was die Zeilen
 * zweier Backends unterscheidet, die sich einen Steckplatz teilen
 * (`isRowOfBackend`), und er steht als Ueberschrift ueber der wartenden
 * Gruppe.
 *
 * NICHT dabei ist der Schluessel. Das Feld im Einstellungsblatt schreibt bei
 * jedem Tastendruck in den Store, und ein Nachladen pro Buchstabe waere eine
 * Anfrage-Lawine gegen einen Anbieter, der den halb getippten Schluessel
 * ohnehin ablehnt. Eingeschaltet wird der Anbieter danach ohnehin, und das
 * steht hier oben in der ersten Zeile.
 */

import type { ProviderConfig, ProviderId } from '../api/providers/types'

/** Die Felder, an denen die Liste haengt. */
const FELDER = ['enabled', 'baseUrl', 'name', 'managed'] as const

type Steckplaetze = Record<ProviderId, ProviderConfig>

/**
 * Hat sich an irgendeinem Steckplatz etwas geaendert, das die Modelliste
 * anders aussehen laesst.
 *
 * Beide Seiten kommen aus demselben Store, also haben sie dieselben
 * Schluessel; gelesen werden trotzdem beide, damit ein neu hinzugekommener
 * Steckplatz nicht uebersehen wird.
 */
export function modelListIsStale(next: Steckplaetze, prev: Steckplaetze): boolean {
  const ids = new Set([...Object.keys(next), ...Object.keys(prev)] as ProviderId[])
  for (const id of ids) {
    for (const feld of FELDER) {
      if (next[id]?.[feld] !== prev[id]?.[feld]) return true
    }
  }
  return false
}
