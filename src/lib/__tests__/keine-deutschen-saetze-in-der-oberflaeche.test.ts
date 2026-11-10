/**
 * Die Oberflaeche und die Logdatei sprechen Englisch, die Kommentare Deutsch.
 *
 * Stehende Regel: Fehlermeldungen immer Englisch, keine lokalisierten Texte
 * durchreichen. Kommentare sind davon ausgenommen, sie erreichen keinen Kunden.
 * Zeichenkettenliterale erreichen ihn sehr wohl, und zwar auch dann, wenn sie
 * auf keinem Bildschirm erscheinen: `lib/logger.ts` spiegelt `warn` und `error`
 * in die Tagesdatei, und `components/settings/LogFileSettings.tsx` bittet den
 * Kunden ausdruecklich, genau diese Datei anzuhaengen.
 *
 * Gefunden hat den einen Treffer die Logikkontrolle 3.0.0 (R2-53):
 * `components/layout/LazyView.tsx` meldete den gescheiterten Chunk-Import auf
 * Deutsch, als einzige Stelle unter `src/components` und `src/lib`. Dieser
 * Waechter haelt die Zahl bei null.
 *
 * Gelesen wird mit dem Scanner von TypeScript selbst, nicht mit einem Ausdruck.
 * Ein Ausdruck faellt ueber jede zweite Datei: ueber `'https://...'`, dessen
 * zwei Schraegstriche wie ein Kommentar aussehen, ueber ein `/[;&|`\n]/`, dessen
 * Backtick wie eine Schablone aussieht, und ueber jedes "don't" im JSX-Text.
 * Der Syntaxbaum kennt den Unterschied, und die sechs Ausnahmen unten sind
 * dadurch wirklich die einzigen (seit der Handy-Suche sechs).
 *
 * Run: npx vitest run src/lib/__tests__/keine-deutschen-saetze-in-der-oberflaeche.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

const SRC = resolve(__dirname, '..', '..')
const ORDNER = ['components', 'lib']

/**
 * Deutsche Woerter, die im Englischen nichts bedeuten. Absichtlich ohne `die`,
 * `den`, `hat` und `so`: die gibt es im Englischen auch, und ein Waechter, der
 * bei jedem zweiten Satz anschlaegt, wird abgeschaltet statt befolgt.
 */
const DEUTSCHE_WOERTER = [
  'aber', 'auch', 'auf', 'aus', 'beim', 'bereits', 'damit', 'dann', 'dass',
  'durch', 'ein', 'eine', 'einen', 'einer', 'fuer', 'gegen', 'ist', 'jede',
  'jeder', 'kann', 'kein', 'keine', 'mit', 'muss', 'nach', 'nicht', 'noch',
  'nur', 'oder', 'ohne', 'schon', 'sich', 'sind', 'soll', 'ueber', 'und',
  'vom', 'von', 'vor', 'weil', 'wenn', 'werden', 'wie', 'wird', 'wurde',
  'wurden', 'zum', 'zur',
  'Abbruch', 'Anbieter', 'Anfrage', 'Antwort', 'Auftrag', 'Datei', 'Dateien',
  'Einstellungen', 'Fehler', 'fehlgeschlagen', 'Meldung', 'Modell',
  'Nachschlag', 'Nutzer', 'Ordner', 'Seite', 'Speicher', 'Zeile',
]

const DEUTSCH = new RegExp(`\\b(${DEUTSCHE_WOERTER.join('|')})\\b`)

/**
 * Die sechs Dateien, in denen Deutsch in einem Literal richtig ist, mit dem
 * Grund. Keine davon schreibt dem Kunden etwas hin: fuenf lesen, was er getippt
 * hat, und eine sagt denselben Satz zweimal.
 *
 * Jeder Eintrag wird unten dagegen gehalten, dass er ueberhaupt noch einen
 * Treffer traegt. Eine Ausnahme, die nichts mehr ausnimmt, gehoert geloescht.
 */
const DEUTSCH_MIT_GRUND: Record<string, string> = {
  'lib/chat-tool-intent.ts': 'Verbstaemme, gegen die getippte deutsche Saetze gelesen werden.',
  'lib/tool-selection.ts': 'Deutsche Suchhinweise, gegen die getippte Saetze gelesen werden.',
  'lib/turn-summary.ts': 'Absichtlich zweisprachig, deutscher und englischer Satz in einer Zeile.',
  'lib/release-notes.ts': 'Ein englischer Blattsatz, der eine getippte deutsche Wendung zitiert.',
  'lib/plan-gate.ts': 'Deutsche Planbitten, gegen die getippte Saetze gelesen werden.',
  'lib/create/media-wish.ts': 'Deutsche Medienwuensche, gegen die getippte Saetze gelesen werden (aus dem Web gespiegelt).',
  'lib/create/chat-control.ts': 'Muster, gegen die der Schlusstext eines Modells gelesen wird, auch der deutsche (aus dem Web gespiegelt). Nichts davon wird angezeigt.',
  'lib/explicit-search.ts': 'Deutsche Suchauftraege, gegen die getippte Saetze gelesen werden.',
  'lib/session-search.ts': 'Deutsche Fuellwoerter, die aus einer getippten Suchanfrage fallen.',
}

/** Jede .ts und .tsx unter den Ordnern, ohne die Testbaeume. */
function quellen(): string[] {
  const out: string[] = []
  const lauf = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) {
        if (name !== '__tests__' && name !== 'node_modules') lauf(p)
      } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        out.push(p)
      }
    }
  }
  for (const o of ORDNER) lauf(join(SRC, o))
  return out.sort()
}

/** Jedes Zeichenkettenliteral einer Datei, aus dem Syntaxbaum, mit Zeile. */
export function literale(datei: string, src: string): { zeile: number; text: string }[] {
  const sf = ts.createSourceFile(
    datei,
    src,
    ts.ScriptTarget.Latest,
    true,
    datei.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const out: { zeile: number; text: string }[] = []
  const lauf = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      out.push({ zeile: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: node.text })
    }
    ts.forEachChild(node, lauf)
  }
  lauf(sf)
  return out
}

function treffer(): { datei: string; zeile: number; wort: string; text: string }[] {
  const out: { datei: string; zeile: number; wort: string; text: string }[] = []
  for (const pfad of quellen()) {
    const datei = relative(SRC, pfad).split('\\').join('/')
    for (const l of literale(pfad, readFileSync(pfad, 'utf8'))) {
      const wort = DEUTSCH.exec(l.text)
      if (wort) out.push({ datei, zeile: l.zeile, wort: wort[1], text: l.text })
    }
  }
  return out
}

describe('kein deutscher Satz in einem Zeichenkettenliteral', () => {
  it('findet in src/components und src/lib keinen einzigen', () => {
    const offen = treffer()
      .filter((t) => !(t.datei in DEUTSCH_MIT_GRUND))
      .map((t) => `${t.datei}:${t.zeile} [${t.wort}] ${JSON.stringify(t.text.slice(0, 120))}`)
    expect(offen, offen.join('\n')).toEqual([])
  })

  it('und jede der sechs Ausnahmen traegt noch das Deutsch, fuer das sie dasteht', () => {
    // Sonst waechst die Liste der Ausnahmen, waehrend der Grund laengst weg ist.
    const mitTreffer = new Set(treffer().map((t) => t.datei))
    for (const datei of Object.keys(DEUTSCH_MIT_GRUND)) {
      expect(mitTreffer.has(datei), `Ausnahme ohne Grund, gehoert raus: ${datei}`).toBe(true)
    }
  })

  it('und liest dabei wirklich etwas, nicht nur eine leere Liste', () => {
    // Negativkontrolle zum Waechter selbst: ein Waechter, dessen Scanner
    // nichts findet, ist immer gruen und beweist nichts.
    const dateien = quellen()
    expect(dateien.length).toBeGreaterThan(300)
    const alle = dateien.flatMap((d) => literale(d, readFileSync(d, 'utf8')))
    expect(alle.length).toBeGreaterThan(5000)
    expect(alle.some((l) => l.text === 'Could not read that file.')).toBe(true)
  })

  it('der Scanner faellt nicht auf https://, JSX-Text und Ausdruecke herein', () => {
    const texte = (src: string, datei = 'x.tsx') => literale(datei, src).map((l) => l.text)
    expect(texte("const a = 'https://lu-labs.ai' // ist nicht gelesen")).toEqual(['https://lu-labs.ai'])
    expect(texte('const a = `x ${ist} y`')).toEqual(['x ', ' y'])
    expect(texte('/* ist */ const a = "ok"')).toEqual(['ok'])
    expect(texte('const CH = /[;&|`\\n]/\nconst a = "ok"')).toEqual(['ok'])
    expect(texte('const V = () => <p>it doesn\'t und it won\'t</p>')).toEqual([])
    // Und er erkennt Deutsch, wenn es wirklich in einem Literal steht.
    expect(DEUTSCH.test('LazyView: Chunk-Import fehlgeschlagen, ein Nachschlag')).toBe(true)
    expect(DEUTSCH.test('LazyView: chunk import failed, retrying once')).toBe(false)
  })
})
