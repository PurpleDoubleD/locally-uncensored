/**
 * Die Antwort-Auswertung von `/local-api/web-search` — fünf fremde Formate,
 * ohne Netz.
 *
 * Der Endpunkt versucht der Reihe nach SearXNG, Brave, Tavily, DuckDuckGo und
 * Wikipedia und nimmt die erste Ebene, die etwas liefert. Jede dieser fünf
 * Antworten ist FREMD: SearXNG läuft in einem Container des Benutzers, Brave
 * und Tavily sind Fremd-APIs, und die DuckDuckGo-Ebene liest HTML, das sich
 * ohne Ankündigung ändern darf. Vorher wurde jede davon mit `(r: any) =>`
 * durchgereicht — also ungeprüft — und die daraus gebauten Ergebnisse gingen
 * direkt an das Modell.
 *
 * Hier ist alles `unknown` plus Prüfung an der Grenze; ein Eintrag ohne
 * brauchbaren Titel oder URL fällt heraus, statt als `undefined` weiterzureisen.
 *
 * REIN, ABSICHTLICH: kein `node:*`-Import — das Modul liegt neben seinem Test.
 */

import { asString, isRecord, prop, propPath } from '../types/json-guards'

/** Ein Treffer, wie ihn der Endpunkt an das Modell zurückgibt. */
export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

/** Ein Feld als String, oder `''` — die Form, die der Endpunkt versprochen hat. */
function text(record: Record<string, unknown>, key: string): string {
  return asString(record[key]) ?? ''
}

/** Die Liste unter `keys` als Datensätze, oder `[]`. */
function listAt(data: unknown, ...keys: readonly string[]): Record<string, unknown>[] {
  const value = keys.length === 1 ? prop(data, keys[0]) : propPath(data, ...keys)
  return Array.isArray(value) ? value.filter(isRecord) : []
}

/**
 * Einträge ohne Titel UND ohne URL sind für den Aufrufer wertlos — ein Modell,
 * das eine leere URL zitiert bekommt, halluziniert darauf weiter.
 */
function usable(result: WebSearchResult): boolean {
  return result.title !== '' || result.url !== ''
}

/** SearXNG (`/search?format=json`): `{ results: [{ title, url, content }] }`. */
export function parseSearxngResults(data: unknown, max: number): WebSearchResult[] {
  return listAt(data, 'results')
    .slice(0, max)
    .map((r) => ({ title: text(r, 'title'), url: text(r, 'url'), snippet: text(r, 'content') }))
    .filter(usable)
}

/** Brave: `{ web: { results: [{ title, url, description }] } }`. */
export function parseBraveResults(data: unknown, max: number): WebSearchResult[] {
  return listAt(data, 'web', 'results')
    .slice(0, max)
    .map((r) => ({ title: text(r, 'title'), url: text(r, 'url'), snippet: text(r, 'description') }))
    .filter(usable)
}

/** Tavily: `{ results: [{ title, url, content }] }`. */
export function parseTavilyResults(data: unknown, max: number): WebSearchResult[] {
  return listAt(data, 'results')
    .slice(0, max)
    .map((r) => ({ title: text(r, 'title'), url: text(r, 'url'), snippet: text(r, 'content') }))
    .filter(usable)
}

/**
 * Wikipedia (`action=query&list=search`): `{ query: { search: [{ title, snippet }] } }`.
 *
 * Die URL wird aus dem Titel gebaut. Vorher stand dort `r.title.replace(…)`
 * hinter einem `title: r.title || ''` — ein Eintrag ohne Titel warf also eine
 * TypeError mitten in der letzten Ebene der Suchkette und machte aus „keine
 * Treffer" ein „alle Ebenen fehlgeschlagen". Hier fällt er einfach heraus.
 */
export function parseWikipediaResults(data: unknown, max: number): WebSearchResult[] {
  return listAt(data, 'query', 'search')
    .slice(0, max)
    .map((r) => {
      const title = text(r, 'title')
      return {
        title,
        url: title === ''
          ? ''
          : `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
        snippet: text(r, 'snippet').replace(/<[^>]*>/g, ''),
      }
    })
    .filter((r) => r.url !== '')
}

/** HTML-Entities, die in den DDG-Treffern vorkommen. */
function decodeEntities(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
}

/**
 * DuckDuckGos HTML-Endpunkt (`html.duckduckgo.com/html/`).
 *
 * DDG verpackt die Ziel-URL in eine eigene Weiterleitung
 * (`//duckduckgo.com/l/?uddg=<encoded>`); die wird hier ausgepackt, damit nicht
 * jeder Treffer über DDG zurückzeigt. Nur `http(s)`-Ziele werden übernommen —
 * ein `javascript:`- oder `data:`-Ziel aus fremdem HTML hat in der Antwort an
 * das Modell nichts verloren.
 */
export function parseDdgHtmlResults(html: string, max: number): WebSearchResult[] {
  const linkRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi

  const links: { title: string; url: string }[] = []
  let linkMatch: RegExpExecArray | null
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    let url = linkMatch[1]
    if (url.includes('uddg=')) {
      const uddg = url.split('uddg=')[1]?.split('&')[0]
      if (uddg) {
        try {
          url = decodeURIComponent(uddg)
        } catch {
          continue // kaputte Prozent-Kodierung → Treffer verwerfen
        }
      }
    }
    const title = decodeEntities(linkMatch[2]).trim()
    if (title && /^https?:\/\//i.test(url)) links.push({ title, url })
  }

  const snippets: string[] = []
  let snippetMatch: RegExpExecArray | null
  while ((snippetMatch = snippetRegex.exec(html)) !== null) {
    snippets.push(decodeEntities(snippetMatch[1]).replace(/\s+/g, ' ').trim())
  }

  const results: WebSearchResult[] = []
  for (let i = 0; i < Math.min(links.length, max); i++) {
    results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] ?? '' })
  }
  return results
}
