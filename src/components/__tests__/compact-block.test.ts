/**
 * Die Verdichtungslinie — und die Regel, die sie NICHT brechen darf.
 *
 * Im Kopf von `CompactBlock.tsx` steht die eigentliche Entscheidung: der Block
 * LOESCHT NICHTS und VERSTECKT NICHTS. Verdichtet wird die Nutzlast an das
 * Modell, nicht der Verlauf des Menschen. Sichtbar wird allein die LINIE: ab
 * hier sieht das Modell die Zusammenfassung statt der Turns darueber.
 *
 * Diese Regel ist genau die Art Regel, die eine spaetere Aufraeumaktion
 * kassiert, ohne dass irgendetwas kaputtgeht: die ersetzten Turns einzuklappen
 * oder wegzufiltern sieht aufgeraeumter aus, laesst jeden Test gruen und nimmt
 * dem Nutzer trotzdem sein Protokoll. Deshalb steht hier nicht nur „der Block
 * rendert", sondern eine Zaehlung der Filter, die MessageList ueberhaupt auf
 * `conversation.messages` legt. Kommt ein dritter dazu — egal mit welchem
 * Argument — faellt dieser Test.
 *
 * ── Was hier gerendert wird und was nicht ──────────────────────────────────
 *
 * `CompactBlock` nimmt nur eine Prop und keinen Store, also laeuft er hier
 * ECHT durch `renderToStaticMarkup` (dieselbe Bauform wie
 * models/__tests__/das-raster-zaehlt-seine-knoten.test.ts). Zugeklappt-als-
 * Voreinstellung und die Zahlen im Etikett sind darum gemessenes Verhalten,
 * kein abgelesener Quelltext.
 *
 * `MessageList` und `CodexView` gehen nicht, dreimal nachgemessen am
 * 02.09.2026:
 *   1. `useChatStore` liefert beim Server-Rendern den ANFANGSZUSTAND —
 *      zustand v5 gibt `getInitialState` als `getServerSnapshot` in
 *      `useSyncExternalStore`. Ein im Test gesetzter Chat kommt in der
 *      Komponente nie an, sie rendert `null`.
 *   2. Am Anfangszustand vorbei gerendert faellt `MessageBubble` ueber
 *      `SpeakerButton → useVoice → window.speechSynthesis`.
 *   3. Mit einem `window`-Stub daneben faellt framer-motion
 *      (`target.addEventListener is not a function`).
 * Es gibt in diesem Projekt keine Render-Umgebung fuer Store-Komponenten, und
 * ein halber DOM-Nachbau waere hier mehr Testgeruest als Test. Die beiden
 * Verlaufsflaechen sind darum am Quelltext gesichert — dasselbe Muster wie
 * chat/__tests__/long-transcripts-stay-cheap.test.ts und
 * cloud/__tests__/cloud-path-shortened.test.ts.
 *
 * Die Datei heisst `.test.ts` und nicht `.test.tsx`: `vitest.config.ts` sammelt
 * `src/**\/__tests__/**\/*.test.ts`. Eine `.tsx`-Datei wird nie eingesammelt
 * („No test files found") und waere ein Waechter, der nie laeuft — deshalb
 * `createElement` statt JSX, so wie in den anderen rendernden Tests hier.
 *
 * Run: npx vitest run src/components/__tests__/compact-block.test.ts
 */
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { resolve } from 'node:path'
import { quelldateien, quelltext } from './quelldateien'
import { CompactBlock } from '../chat/CompactBlock'
import { renderCompactSummary, EMPTY_SUMMARY } from '../../lib/compact-summary'
import type { CompactionRecord } from '../../types/chat'

const SRC = resolve(__dirname, '..', '..')
const DATEIEN = quelldateien(resolve(SRC, 'components'), { endungen: /\.tsx$/, relativZu: SRC })

const LISTE = quelltext(DATEIEN, 'components/chat/MessageList.tsx')
const CODEX = quelltext(DATEIEN, 'components/chat/CodexView.tsx')

/** Zeilen ohne die auskommentierten — die Kommentare hier sind lang und reden
 *  ueber genau die Dinge, nach denen unten gesucht wird. */
const codeZeilen = (src: string): string[] =>
  src.split('\n').map((z) => z.trim()).filter((z) => z && !z.startsWith('//') && !z.startsWith('*') && !z.startsWith('/*'))

/** Eine Zusammenfassung, wie sie wirklich im Datensatz steht: gerendert, mit
 *  Markern und Praeambel. MARKE ist das Wort, das zugeklappt nirgends
 *  auftauchen darf. */
const ZUSAMMENFASSUNG = renderCompactSummary({
  ...EMPTY_SUMMARY,
  task: 'MARKE-TASK: den Audit-Build abnehmen',
  progress: 'MARKE-PROGRESS: zwei Dateien gelesen',
})

const datensatz = (over: Partial<CompactionRecord> = {}): CompactionRecord => ({
  id: 'c1',
  summary: ZUSAMMENFASSUNG,
  upToMessageId: 'm2',
  replaced: 7,
  atMessageCount: 9,
  tokensBefore: 18240,
  tokensAfter: 412,
  trigger: 'auto',
  at: 1_756_000_000_000,
  ...over,
})

const rendern = (record: CompactionRecord): string =>
  renderToStaticMarkup(createElement(CompactBlock, { record }))

describe('Eine Verdichtung nimmt dem Verlauf nichts weg', () => {
  it('MessageList filtert die Nachrichten genau zweimal: Rolle und hidden', () => {
    // Die Zaehlung ist der Waechter, nicht die Formulierung. Wer die Liste
    // spaeter „aufraeumt", schreibt einen dritten Filter — und der Verlauf
    // verliert Nachrichten, die der Nutzer geschrieben und gelesen hat. Ein
    // Test auf „der alte Filter ist noch da" wuerde das durchlassen.
    //
    // 2.6.8: die zweite Zeile ist umbrochen, seit App-Hinweise
    // (`role:'system'` mit `notice`) im Verlauf stehen duerfen — sie
    // erreichen das Modell nie und gehoeren trotzdem angezeigt. Der Waechter
    // haengt deshalb an der ANZAHL und an dem, worauf gefiltert wird, nicht
    // mehr am Wortlaut einer Zeile; sonst haette er bei jedem Umbruch
    // angeschlagen, ohne dass sich die Regel geaendert hat.
    const filter = codeZeilen(LISTE).filter((z) => z.includes('.filter('))
    expect(filter.length).toBe(2)
    expect(filter[0]).toContain("m.role === 'user'")
    // Der zweite Filter entscheidet ueber die Sichtbarkeit und darf genau
    // zwei Dinge lesen: die Rolle und `hidden` (plus `notice`, das eine
    // Systemnachricht wieder sichtbar macht).
    const sichtbarkeit = codeZeilen(LISTE)
      .slice(codeZeilen(LISTE).indexOf(filter[1]))
      .slice(0, 4).join(' ')
    expect(sichtbarkeit).toContain('visibleMessages')
    expect(sichtbarkeit).toMatch(/m\.role !== 'system'/)
    expect(sichtbarkeit).toContain('m.hidden')
    // Und nichts schneidet die Liste zu: kein Fenster, keine Seite.
    expect(codeZeilen(LISTE).filter((z) => z.includes('.slice('))).toEqual([])
  })

  it('keine Verdichtung entscheidet, welche Nachrichten die Liste zeigt', () => {
    // `compactions` und `upToMessageId` sind Anzeige-Eingaben. Sobald eines
    // von beiden in einem Filter, einem Schnitt oder einer Bedingung um die
    // Nachrichtenabbildung auftaucht, faengt die Anzeige an, den Verlauf zu
    // beschneiden — und der Block behauptet dann etwas, was nicht mehr stimmt.
    for (const z of codeZeilen(LISTE)) {
      if (z.includes('.filter(') || z.includes('.slice(')) {
        expect(z, 'ein Filter/Schnitt liest eine Verdichtung').not.toMatch(/compact|upTo/i)
      }
    }
    // `compactions` wird an genau einer Stelle gelesen: als drittes Argument
    // von compactionAnchors.
    const compactions = codeZeilen(LISTE).filter((z) => z.includes('compactions'))
    expect(compactions).toEqual(['conversation.compactions,'])
    // Der Schnittpunkt selbst kommt in der Komponente gar nicht vor — die
    // Zuordnung Nachricht → Linie macht compactionAnchors, nicht die Liste.
    expect(LISTE).not.toContain('upToMessageId')
    // Das Ergebnis wird nur nachgeschlagen, nie zum Aussortieren benutzt.
    const compactAt = codeZeilen(LISTE).filter((z) => z.includes('compactAt'))
    expect(compactAt).toEqual([
      'const compactAt = compactionAnchors(',
      '{compactAt.get(message.id)?.map((record) => (',
    ])
  })

  it('die Linie kommt zur Nachricht dazu, sie ersetzt sie nicht', () => {
    // Beide stehen im selben Wrapper der Abbildung, und die Blase steht
    // zuerst. Ein `record ? <CompactBlock/> : <MessageBubble/>` waere genau
    // der Entwurf, den der Kopf von CompactBlock.tsx verwirft.
    const wrapper = LISTE.indexOf('key={message.id}')
    const blase = LISTE.indexOf('<MessageBubble')
    const linie = LISTE.indexOf('<CompactBlock')
    expect(wrapper).toBeGreaterThan(-1)
    expect(blase).toBeGreaterThan(wrapper)
    expect(linie).toBeGreaterThan(blase)
    // Vom Wrapper bis zum Ende der Blase steht keine Verdichtung — die Blase
    // haengt an nichts, was eine Verdichtung entscheidet.
    expect(LISTE.slice(wrapper, LISTE.indexOf('/>', blase))).not.toMatch(/compactAt|compactions/)
  })

  it('auch der Code-Verlauf haengt die Linie an die Nachricht an', () => {
    // CodexView baut die Nachricht in `gerendert` und gibt sie OHNE Linie
    // unveraendert zurueck; mit Linie kommt sie im Fragment zuerst. Damit ist
    // dort dieselbe Regel strukturell erzwungen wie in MessageList.
    expect(CODEX).toContain('if (!linien?.length) return gerendert')
    const fragment = CODEX.indexOf('{gerendert}')
    const linie = CODEX.indexOf('<CompactBlock')
    expect(fragment).toBeGreaterThan(-1)
    expect(linie).toBeGreaterThan(fragment)
    // Auch hier: die volle Liste geht in die Rechnung, gefiltert wird nur
    // `hidden` — die Verdichtung filtert nichts.
    expect(CODEX).toContain("messages.filter((m) => !m.hidden).map((m) => m.id)")
    for (const z of codeZeilen(CODEX)) {
      if (z.includes('messages.filter(') || z.includes('messages.slice(')) {
        expect(z, 'ein Filter/Schnitt liest eine Verdichtung').not.toMatch(/compact|upTo/i)
      }
    }
  })
})

describe('Die Linie steht in jedem Verlauf, nicht nur im ersten', () => {
  /**
   * Eine Verlaufsflaeche wird hier an ihren zwei Merkmalen erkannt, nicht am
   * Namen: sie haengt am gemeinsamen Rollanker (`useAutoScroll`) und zeigt den
   * Laufanker (`<WorkingAnchor`) unter dem Verlauf. Beides hat heute genau
   * MessageList und CodexView.
   *
   * GRENZE: eine dritte Flaeche, die einen Verlauf OHNE diese beiden Teile
   * zeigt, faellt durch dieses Raster. Darum stehen die zwei bekannten unten
   * zusaetzlich beim Namen — dann kann die Ableitung nicht stillschweigend auf
   * eine Datei zusammenschrumpfen und trotzdem gruen bleiben.
   */
  const verlaeufe = DATEIEN
    .filter(([, inhalt]) => inhalt.includes('useAutoScroll(') && inhalt.includes('<WorkingAnchor'))
    .map(([name]) => name)

  it('jede Verlaufsflaeche montiert den Block', () => {
    expect(verlaeufe).toContain('components/chat/MessageList.tsx')
    expect(verlaeufe).toContain('components/chat/CodexView.tsx')
    for (const name of verlaeufe) {
      const src = quelltext(DATEIEN, name)
      expect(src, `${name} importiert CompactBlock nicht`).toContain("from './CompactBlock'")
      expect(src, `${name} rendert keine Verdichtungslinie`).toContain('<CompactBlock')
      expect(src, `${name} rechnet die Linien nicht aus`).toContain('compactionAnchors(')
    }
  })

  it('ein Datensatz, eine Linie — geschluesselt an record.id', () => {
    // Der Index waere hier falsch: zwei Verdichtungen koennen auf derselben
    // sichtbaren Zeile landen (compactionAnchors, Fall 3), und beim naechsten
    // Lauf steht eine dritte dazwischen.
    for (const name of verlaeufe) {
      expect(quelltext(DATEIEN, name)).toContain('key={record.id}')
    }
    // Gemessen: ein Datensatz ergibt genau ein Etikett, zwei ergeben zwei.
    const eins = rendern(datensatz())
    expect(eins.match(/summarised/g)).toHaveLength(1)
    const zwei = renderToStaticMarkup(
      createElement(
        'div',
        null,
        [datensatz(), datensatz({ id: 'c2', replaced: 3 })].map((r) =>
          createElement(CompactBlock, { key: r.id, record: r }),
        ),
      ),
    )
    expect(zwei.match(/summarised/g)).toHaveLength(2)
  })
})

describe('Zugeklappt ist die Voreinstellung', () => {
  it('die Zusammenfassung steht nicht im ersten Rendern', () => {
    // Sie ist fuer das Modell geschrieben, nicht fuer den Leser. Aufgeklappt
    // waere sie ein Textblock mitten im Verlauf, den niemand angefordert hat —
    // und nach jeder Verdichtung einer mehr.
    // Gegenprobe zuerst: die Marke steht wirklich im Datensatz. Ohne sie
    // waeren die drei Verneinungen darunter still gruen — dieselbe Falle, die
    // `quelltext` mit seinem Fehler statt `?? ''` schliesst.
    expect(ZUSAMMENFASSUNG).toContain('MARKE-TASK')
    expect(ZUSAMMENFASSUNG).toContain('MARKE-PROGRESS')
    expect(ZUSAMMENFASSUNG).toContain('TASK')

    const html = rendern(datensatz())
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('MARKE-TASK')
    expect(html).not.toContain('MARKE-PROGRESS')
    expect(html).not.toContain('TASK')
    // Die Linie selbst ist da — zugeklappt heisst nicht unsichtbar.
    expect(html).toContain('7 messages summarised')
  })

  it('auch eine unlesbare Zusammenfassung klappt nichts auf', () => {
    // Der Ruecktext „could not be read back" steht IM aufgeklappten Bereich.
    // Stuende er aussen, wuerde ein alter oder kaputter Datensatz von selbst
    // eine Fehlermeldung in den Verlauf schreiben.
    const html = rendern(datensatz({ summary: '' }))
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('could not be read back')
    expect(html).toContain('7 messages summarised')
  })
})

describe('Das Etikett sagt, was passiert ist', () => {
  it('eine Nachricht heisst message, mehrere heissen messages', () => {
    expect(rendern(datensatz({ replaced: 1 }))).toContain('1 message summarised')
    expect(rendern(datensatz({ replaced: 2 }))).toContain('2 messages summarised')
    // „auto" steht nur dran, wenn die Schwelle ausgeloest hat — bei /compact
    // hat der Nutzer selbst gedrueckt und braucht die Auskunft nicht.
    expect(rendern(datensatz({ trigger: 'auto' }))).toContain('>auto<')
    expect(rendern(datensatz({ trigger: 'manual' }))).not.toContain('>auto<')
  })

  it('unter 1000 bleibt die Zahl ganz', () => {
    // „0.4k" ist keine Verbesserung gegenueber „412": dieselbe Laenge, weniger
    // Information. Genau das steht als Begruendung ueber `short`.
    const html = rendern(datensatz({ tokensBefore: 999, tokensAfter: 412 }))
    expect(html).toContain('999 → 412')
    expect(html).not.toMatch(/0\.\dk/)
  })

  it('ab 1000 kuerzt die Anzeige auf k', () => {
    expect(rendern(datensatz({ tokensBefore: 18240, tokensAfter: 412 }))).toContain('18.2k → 412')
    expect(rendern(datensatz({ tokensBefore: 1000, tokensAfter: 1 }))).toContain('1.0k → 1')
  })

  it('eine kaputte Zahl wird zu 0, nicht zu einem Minus', () => {
    // Die Zahlen kommen aus einer Schaetzung in einem gespeicherten Datensatz.
    // Eine negative Restlaenge ist Unsinn, aber „-50" im Etikett sieht aus wie
    // eine Aussage ueber den Chat.
    expect(rendern(datensatz({ tokensBefore: 1000, tokensAfter: -50 }))).toContain('1.0k → 0')
  })

  it('ohne Ersparnis stehen gar keine Zahlen da', () => {
    // Ein Pfeil zwischen zwei gleichen Zahlen behauptet einen Gewinn, den es
    // nicht gab.
    const html = rendern(datensatz({ tokensBefore: 500, tokensAfter: 500 }))
    expect(html).not.toContain('→')
    expect(html).toContain('7 messages summarised')
  })
})
