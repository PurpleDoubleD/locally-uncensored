/**
 * Den Quellbaum einlesen und seine Dateien beim Namen nennen — EINMAL.
 *
 * ── Der Befund (KF-10), gemessen am 01.09.2026 ──
 *
 * Derselbe Commit, `npx vitest run`: macOS 7863 gruen / 0 rot, Windows 8 rot
 * in 6 Dateien. Kein Produktfehler — ein Testfehler, und zwar SECHSMAL
 * DERSELBE. Fuenf Testdateien trugen eine eigene Kopie desselben Waelzers:
 *
 *     const p = resolve(dir, e.name)
 *     out.push([p.slice(SRC.length + 1), readFileSync(p, 'utf8')])
 *
 * `resolve` liefert die Trennzeichen des Wirtssystems. Unter Windows heisst
 * die Datei danach `components\layout\Titlebar.tsx`, und der Nachschlag
 * daneben suchte `components/layout/Titlebar.tsx`. Er fand nichts.
 *
 * ── Warum das schlimmer war als acht rote Tests ──
 *
 * Der Nachschlag endete ueberall auf `?? ''`:
 *
 *     const src = DATEIEN.find(([n]) => n === f)?.[1] ?? ''
 *
 * Ein leerer String ist keine Fehlermeldung, sondern eine Datei ohne Inhalt.
 * Ob daraus ein rotes oder ein STILL GRUENES Ergebnis wird, entscheidet
 * allein die Zusicherung dahinter: `expect(src).toContain(x)` faellt, aber
 * `expect(src).not.toContain(x)` haelt — und behauptet dann Deckung, die es
 * nicht gibt. Nachgezaehlt trugen die betroffenen Stellen zufaellig alle eine
 * positive Zusicherung, also wurden sie rot statt still gruen. Auf Zufall
 * gebaute Ehrlichkeit ist keine.
 *
 * Deshalb gibt es hier ZWEI Ausfahrten und nicht nur eine: `quelldateien`
 * normalisiert die Namen, und `quelltext` verweigert den leeren String. Wer
 * eine Datei beim Namen holt, bekommt sie oder einen Fehler — `?? ''` kommt
 * in keiner Testdatei mehr vor.
 *
 * ── Was hier bewusst NICHT passiert ──
 *
 *   • Zeilenenden werden nicht umgeschrieben. `.gitattributes` setzt
 *     `* text=auto eol=lf` und haelt damit JEDEN Arbeitsbaum auf LF — auf der
 *     Windows-Maschine nachgemessen (Titlebar.tsx: 132x LF, 0x CR). Das ist
 *     an der Quelle geloest; ein zweiter Weg daneben waere genau der
 *     Grundfehler, den dieses Projekt an anderer Stelle schon bezahlt hat.
 *   • Es wird nicht gefiltert, was der Aufrufer filtern will. Die Endung
 *     kommt herein, die `__tests__`-Ausnahme bleibt drin: sie ist in allen
 *     fuenf Kopien gleich gewesen und ist die Grenze zwischen App und
 *     Pruefung, nicht eine Vorliebe der Aufrufer.
 *
 * Keine Testdatei: `vitest.config.ts` sammelt nur `**\/__tests__\/**\/*.test.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

/** Eine Quelldatei: ihr Name relativ zur Bezugswurzel, und ihr Inhalt. */
export type Quelldatei = readonly [name: string, inhalt: string]

export interface QuelldateienOptionen {
  /** Welche Dateien zaehlen. Voreinstellung: `.ts` und `.tsx`. */
  endungen?: RegExp
  /**
   * Wogegen die Namen relativ sind. Voreinstellung: die begangene Wurzel.
   * `icon-leiter` begeht `src/components`, benennt aber ab `src/` — deshalb
   * ist das ein eigener Knopf und nicht fest verdrahtet.
   */
  relativZu?: string
}

/**
 * Alle Quelldateien unter `wurzel`, rekursiv, ohne `__tests__`.
 *
 * Die Namen tragen IMMER `/`, auf jedem Wirtssystem. Das ist der ganze Zweck:
 * ein Test, der `components/layout/Titlebar.tsx` sucht, soll sie finden, egal
 * womit das Betriebssystem seine Pfade zusammensetzt.
 */
export function quelldateien(
  wurzel: string,
  opts: QuelldateienOptionen = {},
): Quelldatei[] {
  const endungen = opts.endungen ?? /\.tsx?$/
  const bezug = resolve(opts.relativZu ?? wurzel)
  const out: Quelldatei[] = []

  const begehen = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '__tests__') continue
      const p = resolve(dir, e.name)
      if (e.isDirectory()) begehen(p)
      else if (endungen.test(e.name)) out.push([posixName(p, bezug), readFileSync(p, 'utf8')])
    }
  }
  begehen(resolve(wurzel))
  return out
}

/**
 * Ein absoluter Pfad als Name relativ zu `bezug`, mit `/` als Trennzeichen.
 *
 * `split(sep).join('/')` statt `replace(/\\/g, '/')`: auf Posix IST `\` ein
 * gueltiges Zeichen in einem Dateinamen, und eine Datei, die einen traegt,
 * duerfte davon nicht zerschnitten werden. `sep` ist das, was diese Maschine
 * wirklich benutzt.
 */
function posixName(absolut: string, bezug: string): string {
  return absolut.slice(bezug.length + 1).split(sep).join('/')
}

/**
 * Den Inhalt EINER Datei beim Namen — oder ein Fehler, niemals ein leerer
 * String.
 *
 * Das ist die Haelfte, die aus dem Befund folgt: der `?? ''`-Rueckfall der
 * fuenf Kopien machte aus „ich habe die Datei nicht gefunden" ein „die Datei
 * ist leer", und damit war jede verneinende Zusicherung dahinter still
 * gruen. Hier gibt es diesen Zustand nicht mehr.
 */
export function quelltext(dateien: readonly Quelldatei[], name: string): string {
  const treffer = dateien.find(([n]) => n === name)
  if (treffer) return treffer[1]
  // Die naechstliegenden Namen mitgeben — ein Tippfehler oder ein
  // verschobenes Verzeichnis soll hier sofort lesbar sein.
  const blatt = name.slice(name.lastIndexOf('/') + 1)
  const nah = dateien.map(([n]) => n).filter((n) => n.endsWith(`/${blatt}`))
  throw new Error(
    `keine Quelldatei "${name}" unter den ${dateien.length} eingelesenen` +
      (nah.length ? ` — gemeint war vielleicht: ${nah.join(', ')}` : ''),
  )
}
