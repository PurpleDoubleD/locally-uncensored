// Welche Wikipedia die letzte Rettungsstufe der Suche fragt.
//
// Gemessen am 04.09.2026, weil eine Persona am 03.09. eine deutsche Recherche
// fuhr und aus der Suche NICHTS bekam:
//
//   /local-api/web-search  →  {"results":[],"error":"All search tiers failed:
//                              Wikipedia returned no results"}
//
// Zwei Ursachen zusammen. DuckDuckGo antwortet auf die HTML-Endpunkte
// inzwischen mit HTTP 202 und einer Bot-Sperrseite (nachgemessen: 14 kB, kein
// einziges Ergebnis, sowohl `html.` als auch `lite.`) — die freie Web-Stufe
// ist damit tot. Und die Stufe darunter, ueber der im Code „always works"
// stand, fragte fest `en.wikipedia.org`:
//
//   en.wikipedia „Transparenzgesetz Hamburg Antragsfristen"  →   0 Treffer
//   de.wikipedia dieselbe Frage                              →  31 Treffer
//
// Fuer einen deutschsprachigen Nutzer hatte die Kette also gar keine
// funktionierende Stufe mehr. Diese Datei entscheidet nur, welche Sprachwiki
// zuerst gefragt wird; die andere wird trotzdem noch versucht, denn eine
// Sprachvermutung darf nichts verschliessen.

/** Sprachkuerzel, die die Kette kennt. Reihenfolge = Reihenfolge der Versuche. */
export type WikiSprache = 'de' | 'en'

// Kurze Liste, absichtlich: haeufige deutsche Funktions- und Fragewoerter, die
// in englischen Fragen nicht vorkommen. Kein Wortschatz-Projekt — es geht nur
// darum, „Transparenzgesetz Hamburg Antragsfristen" von „Hamburg transparency
// law deadlines" zu unterscheiden.
const DEUTSCHE_WOERTER =
  /\b(der|die|das|des|dem|den|und|oder|nicht|welche|welcher|wie|was|wer|wann|warum|wo|von|vom|zum|zur|fuer|über|ueber|mit|nach|bei|auf|aus|ein|eine|einer|einem|ist|sind|war|waren|wird|werden|kann|koennen|muss|soll|gibt|es|sich)\b/i

// Endungen, an denen ein deutsches Fachwort auch ohne Funktionswort erkennbar
// ist — genau der Fall der Persona: drei Substantive, kein Artikel.
const DEUTSCHE_ENDUNGEN =
  /\w{4,}(gesetz|gesetze|gesetzes|fristen|frist|ordnung|verordnung|behoerde|behörde|pflicht|pflichten|recht|rechte|antrag|antraege|anträge|gebuehr|gebühr|gebuehren|gebühren|verfahren|verwaltung|kammer|amt|aemter|ämter)\b/i

/** Enthaelt der Text deutsche Signale? Umlaute und ß zaehlen sofort. */
export function sprachSignalDeutsch(text: string): boolean {
  const t = (text || '').trim()
  if (!t) return false
  if (/[äöüßÄÖÜ]/.test(t)) return true
  if (DEUTSCHE_WOERTER.test(t)) return true
  return DEUTSCHE_ENDUNGEN.test(t)
}

/**
 * Die Wikipedias, die fuer diese Frage versucht werden — in dieser Reihenfolge.
 *
 * Immer BEIDE: die Vermutung entscheidet nur, wer zuerst drankommt. Eine
 * falsche Vermutung kostet dann eine Anfrage, waehrend eine Vermutung, die
 * die andere Sprache ausschliesst, genau den Fehler wiederholen wuerde, den
 * sie beheben soll.
 */
export function wikiSprachen(query: string): WikiSprache[] {
  return sprachSignalDeutsch(query) ? ['de', 'en'] : ['en', 'de']
}

/** Die API-Adresse einer Sprachwiki fuer eine Suchanfrage. */
export function wikiSuchUrl(sprache: WikiSprache, query: string, maxResults: number): string {
  return (
    `https://${sprache}.wikipedia.org/w/api.php?action=query&list=search&srsearch=` +
    encodeURIComponent(query) +
    `&format=json&srlimit=${maxResults}&utf8=1`
  )
}

/**
 * Die Anfragen, die die Wikipedia-Stufe der Reihe nach versucht.
 *
 * Zwei Verkuerzungen stecken darin, beide gemessen (04.09.2026):
 *
 *  1. SPRACHE. „Transparenzgesetz Hamburg Antragsfristen" auf en.wikipedia:
 *     0 Treffer. Auf de.wikipedia dieselbe Frage: ebenfalls 0 — aber siehe 2.
 *  2. LAENGE. Wikipedia UND-verknuepft die Begriffe. „Transparenzgesetz
 *     Hamburg" ergibt auf de.wikipedia 31 Treffer, mit „Antragsfristen"
 *     dahinter null. Die letzte Rettungsstufe darf an einem dritten Wort
 *     nicht scheitern, wenn die ersten beiden das Thema schon treffen.
 *
 * Gekuerzt wird von hinten: der letzte Begriff ist in einer Suchanfrage
 * ueblicherweise die engste Einschraenkung. Nie unter zwei Begriffe — ein
 * einzelnes Wort findet alles und damit nichts.
 */
export function wikiVersuche(
  query: string,
  maxVersuche = 4,
): { sprache: WikiSprache; query: string }[] {
  const begriffe = (query || '').trim().split(/\s+/).filter(Boolean)
  if (begriffe.length === 0) return []
  const varianten = [begriffe.join(' ')]
  for (let n = begriffe.length - 1; n >= 2; n--) varianten.push(begriffe.slice(0, n).join(' '))

  const out: { sprache: WikiSprache; query: string }[] = []
  for (const sprache of wikiSprachen(query)) {
    for (const v of varianten) {
      out.push({ sprache, query: v })
      if (out.length >= maxVersuche) return out
    }
  }
  return out
}
