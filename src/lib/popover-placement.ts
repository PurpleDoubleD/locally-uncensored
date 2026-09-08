/**
 * Wohin ein Popover aufgeht, und wie hoch es dabei werden darf.
 *
 * ── Der Befund vom 07.09.2026 ──
 *
 * David: das Kontextfenster im Chat ist abgeschnitten, "wenn man den Context
 * neu ausfuellen moechte". Nachgemessen im laufenden Fenster (1280x800,
 * Chromium, `e2e/kontextfenster-wird-nicht-abgeschnitten.spec.ts`): die Liste
 * stand von y=686 bis y=874, also 74 px unter dem Fensterrand, und der
 * `<main>`-Kasten mit seiner abgerundeten Flaeche schneidet ohnehin schon bei
 * y=790,8 ab. Sichtbar waren 105 von 188 px, die Haelfte der Auswahl fehlte.
 *
 * Die Ursache ist keine Klasse, sondern eine Annahme: das Menue ging fest nach
 * unten auf (`top-full`), und sein Ausloeser ist mit dem 2.6.8-Umbau der
 * Eingabezeile von oberhalb des Verlaufs an den unteren Rand gewandert, direkt
 * ueber den Composer. Unter dem Ausloeser sind seitdem rund 100 px Platz, das
 * Menue braucht 188.
 *
 * ── Warum die Rechnung hier steht und nicht im Bauteil ──
 *
 * Weil sie sonst nicht pruefbar waere. Die Testumgebung dieses Hauses ist
 * `environment: 'node'`, es gibt dort kein Layout und keine
 * `getBoundingClientRect`. Was das Bauteil beitraegt, sind vier gemessene
 * Zahlen; was hier steht, ist die Entscheidung daraus, und die ist rein.
 *
 * ── Warum eine Grenze und nicht das Fenster ──
 *
 * Das Fenster ist nicht das, was abschneidet. In dieser App liegt ueber dem
 * Chat ein `<main>` mit `overflow-hidden` (die abgerundete Pane), und dessen
 * Unterkante liegt 9 px ueber der des Fensters. Wer gegen das Fenster rechnet,
 * kommt an einer Stelle heraus, die schon geschnitten wird, und der Fehler
 * kaeme in kleinerer Form zurueck. Deshalb bekommt diese Rechnung die
 * abschneidende Flaeche gesagt, nicht das Fenster.
 */

/** Die vier Zahlen, die das Bauteil misst. Alle in Fensterkoordinaten. */
export interface PopoverRaum {
  /** Oberkante des Ausloesers. */
  readonly ankerOben: number
  /** Unterkante des Ausloesers. */
  readonly ankerUnten: number
  /** Oberkante der Flaeche, die abschneidet. */
  readonly grenzeOben: number
  /** Unterkante derselben Flaeche. */
  readonly grenzeUnten: number
  /** Was das Popover an Inhalt mitbringt, ungekuerzt. */
  readonly inhaltHoehe: number
  /** Abstand zwischen Ausloeser und Popover (`mt-1` / `mb-1` = 4 px). */
  readonly abstand: number
  /** Luft zwischen Popover und Kante der abschneidenden Flaeche. */
  readonly luft: number
}

export interface PopoverPlatz {
  /** Geht das Popover nach oben auf statt nach unten? */
  readonly nachOben: boolean
  /** Die Hoehe, die es hoechstens einnehmen darf. Darueber scrollt es. */
  readonly maxHoehe: number
}

/**
 * Die Seite mit mehr Platz gewinnt, aber nur, wenn die andere nicht reicht.
 *
 * Kein "immer die groessere Seite": das Menue soll dort aufgehen, wo Menues in
 * dieser App aufgehen, naemlich unter ihrem Ausloeser. Nach oben zu kippen ist
 * die Ausnahme, und sie hat einen Grund, den man messen kann.
 *
 * Und ausdruecklich KEINE Mindesthoehe. Eine Mindesthoehe waere die Zusage,
 * bei genug Enge doch wieder ueber die Kante zu laufen, also genau der Fehler,
 * gegen den diese Datei geschrieben ist: der erste Anlauf hatte 96 px als
 * Untergrenze, und im 300 px hohen Fenster stand die Liste damit wieder 6 px
 * im Geschnittenen. Bleibt wenig Platz, wird das Menue kurz und scrollt; das
 * ist sichtbar wenig und nicht heimlich abgeschnitten.
 */
export function platzFuerPopover(raum: PopoverRaum): PopoverPlatz {
  const unten = raum.grenzeUnten - raum.ankerUnten - raum.abstand - raum.luft
  const oben = raum.ankerOben - raum.grenzeOben - raum.abstand - raum.luft
  const nachOben = raum.inhaltHoehe > unten && oben > unten
  const frei = nachOben ? oben : unten
  return { nachOben, maxHoehe: Math.max(0, Math.floor(frei)) }
}
