/**
 * `/local-api/web-search` wertet fünf FREMDE Antworten aus und reicht das
 * Ergebnis an das Modell weiter. Vorher lief jede davon durch ein
 * `(r: any) => ({ title: r.title || '', … })` — also ungeprüft.
 *
 * Was diese Tests festnageln, ist die Grenze: was hereinkommt, hat keine
 * zugesicherte Form, und was hinausgeht, hat drei Strings.
 *
 * NEGATIVE CONTROL (von Hand geprüft):
 *   • in `listAt` das `.filter(isRecord)` streichen
 *     → "verwirft Einträge, die keine Objekte sind" wird rot.
 *   • in `text` das `asString(...) ?? ''` durch `String(record[key] ?? '')`
 *     ersetzen → "eine Zahl im Titel ist kein Titel" wird rot.
 *   • in `parseWikipediaResults` den `title === ''`-Zweig entfernen
 *     → "ein Eintrag ohne Titel wirft nicht" wird rot (TypeError).
 *   • in `parseDdgHtmlResults` `/^https?:\/\//i` durch `url.startsWith('http')`
 *     ersetzen → "nur http(s) kommt durch" wird rot.
 *
 * Run: npx vitest run src/dev/__tests__/web-search-parse.test.ts
 */
import { describe, expect, it } from 'vitest'
import {
  parseBraveResults,
  parseDdgHtmlResults,
  parseSearxngResults,
  parseTavilyResults,
  parseWikipediaResults,
} from '../web-search-parse'

/** Die vier JSON-Auswerter, jeder mit seiner echten Antwortform. */
const jsonParsers = [
  {
    name: 'SearXNG',
    parse: parseSearxngResults,
    good: { results: [{ title: 'T', url: 'https://a.example/1', content: 'S' }] },
    withoutList: { results: 'nope' },
  },
  {
    name: 'Brave',
    parse: parseBraveResults,
    good: { web: { results: [{ title: 'T', url: 'https://a.example/1', description: 'S' }] } },
    withoutList: { web: {} },
  },
  {
    name: 'Tavily',
    parse: parseTavilyResults,
    good: { results: [{ title: 'T', url: 'https://a.example/1', content: 'S' }] },
    withoutList: {},
  },
] as const

describe.each(jsonParsers)('$name', ({ parse, good, withoutList }) => {
  it('nimmt die Treffer heraus', () => {
    expect(parse(good, 5)).toEqual([{ title: 'T', url: 'https://a.example/1', snippet: 'S' }])
  })

  it('kappt bei max', () => {
    const many = JSON.parse(JSON.stringify(good)) as Record<string, unknown>
    const list = (('web' in many ? (many.web as { results: unknown[] }).results : many.results) as unknown[])
    for (let i = 0; i < 20; i++) list.push({ ...(list[0] as object), url: `https://a.example/${i + 2}` })
    expect(parse(many, 3)).toHaveLength(3)
  })

  it('gibt für eine Antwort ohne Liste nichts zurück, statt zu werfen', () => {
    expect(parse(withoutList, 5)).toEqual([])
    expect(parse(undefined, 5)).toEqual([])
    expect(parse(null, 5)).toEqual([])
    expect(parse('ein String', 5)).toEqual([])
    expect(parse(42, 5)).toEqual([])
  })
})

describe('SearXNG im Einzelnen', () => {
  it('verwirft Einträge, die keine Objekte sind', () => {
    const data = {
      results: ['string', null, 42, { title: 'T', url: 'https://a.example/1', content: 'S' }],
    }
    expect(parseSearxngResults(data, 5)).toEqual([{ title: 'T', url: 'https://a.example/1', snippet: 'S' }])
  })

  it('eine Zahl im Titel ist kein Titel', () => {
    // Ein `String(r.title)` hätte hier "42" als Überschrift ans Modell gegeben.
    const data = { results: [{ title: 42, url: 'https://a.example/1', content: null }] }
    expect(parseSearxngResults(data, 5)).toEqual([{ title: '', url: 'https://a.example/1', snippet: '' }])
  })

  it('wirft einen Eintrag ohne Titel UND ohne URL weg', () => {
    const data = { results: [{ content: 'nur ein Schnipsel' }, { title: 'T', url: '', content: '' }] }
    expect(parseSearxngResults(data, 5)).toEqual([{ title: 'T', url: '', snippet: '' }])
  })
})

describe('Wikipedia', () => {
  const data = {
    query: {
      search: [
        { title: 'Ada Lovelace', snippet: 'Eine <span class="hit">Mathematikerin</span>' },
        { title: 'Grace Hopper', snippet: 'Konteradmiralin' },
      ],
    },
  }

  it('baut die Artikel-URL aus dem Titel', () => {
    expect(parseWikipediaResults(data, 5)).toEqual([
      {
        title: 'Ada Lovelace',
        url: 'https://en.wikipedia.org/wiki/Ada_Lovelace',
        snippet: 'Eine Mathematikerin',
      },
      {
        title: 'Grace Hopper',
        url: 'https://en.wikipedia.org/wiki/Grace_Hopper',
        snippet: 'Konteradmiralin',
      },
    ])
  })

  it('kodiert Sonderzeichen im Titel', () => {
    const result = parseWikipediaResults({ query: { search: [{ title: 'C++ (Sprache)' }] } }, 5)
    expect(result[0].url).toBe('https://en.wikipedia.org/wiki/C%2B%2B_(Sprache)')
  })

  it('ein Eintrag ohne Titel wirft nicht', () => {
    // Vorher: `title: r.title || ''` und direkt daneben `r.title.replace(…)`.
    // Ein Eintrag ohne Titel warf eine TypeError in der LETZTEN Ebene der
    // Suchkette — aus "keine Treffer" wurde "alle Ebenen fehlgeschlagen".
    const kaputt = { query: { search: [{ snippet: 'ohne Titel' }, { title: 'Da' }] } }
    expect(() => parseWikipediaResults(kaputt, 5)).not.toThrow()
    expect(parseWikipediaResults(kaputt, 5)).toEqual([
      { title: 'Da', url: 'https://en.wikipedia.org/wiki/Da', snippet: '' },
    ])
  })

  it('gibt für eine Antwort ohne query.search nichts zurück', () => {
    expect(parseWikipediaResults({ query: {} }, 5)).toEqual([])
    expect(parseWikipediaResults({}, 5)).toEqual([])
  })
})

describe('DuckDuckGo-HTML', () => {
  const page = [
    '<div class="result">',
    '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2F1&rut=x">Erster <b>Treffer</b></a>',
    '<a class="result__snippet" href="#">Ein   Schnipsel &amp; mehr</a>',
    '</div>',
    '<div class="result">',
    '<a class="result__a" href="https://b.example/2">Zweiter &quot;Treffer&quot;</a>',
    '<a class="result__snippet" href="#">Noch einer</a>',
    '</div>',
  ].join('\n')

  it('packt die DDG-Weiterleitung aus', () => {
    expect(parseDdgHtmlResults(page, 5)[0]).toEqual({
      title: 'Erster Treffer',
      url: 'https://a.example/1',
      snippet: 'Ein Schnipsel & mehr',
    })
  })

  it('nimmt auch direkte Links', () => {
    expect(parseDdgHtmlResults(page, 5)[1]).toEqual({
      title: 'Zweiter "Treffer"',
      url: 'https://b.example/2',
      snippet: 'Noch einer',
    })
  })

  it('kappt bei max', () => {
    expect(parseDdgHtmlResults(page, 1)).toHaveLength(1)
  })

  it('nur http(s) kommt durch', () => {
    // `startsWith('http')` liess `httpfoo://` und – über die uddg-Umleitung –
    // jedes Schema durch, das mit "http" anfängt.
    const böse = [
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=javascript%3Aalert(1)">Klick</a>',
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=data%3Atext%2Fhtml%2Cx">Auch</a>',
      '<a class="result__a" href="httpfoo://x/1">Fast</a>',
      '<a class="result__a" href="https://gut.example/1">Gut</a>',
    ].join('\n')
    expect(parseDdgHtmlResults(böse, 5)).toEqual([
      { title: 'Gut', url: 'https://gut.example/1', snippet: '' },
    ])
  })

  it('überlebt eine kaputte Prozent-Kodierung', () => {
    const kaputt = '<a class="result__a" href="//duckduckgo.com/l/?uddg=%E0%A4%A">Kaputt</a>'
    expect(() => parseDdgHtmlResults(kaputt, 5)).not.toThrow()
    expect(parseDdgHtmlResults(kaputt, 5)).toEqual([])
  })

  it('gibt für eine Seite ohne Treffer nichts zurück', () => {
    expect(parseDdgHtmlResults('<html><body>Kein Ergebnis</body></html>', 5)).toEqual([])
    expect(parseDdgHtmlResults('', 5)).toEqual([])
  })

  it('kommt ohne Schnipsel aus', () => {
    const ohne = '<a class="result__a" href="https://a.example/1">Nur Titel</a>'
    expect(parseDdgHtmlResults(ohne, 5)).toEqual([
      { title: 'Nur Titel', url: 'https://a.example/1', snippet: '' },
    ])
  })
})
