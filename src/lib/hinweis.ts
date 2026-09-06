/**
 * Die eine Regel fuer Anmerkungen und Fehlermeldungen in der Oberflaeche.
 *
 * David, 04.09.2026: „ich will nirgends gelbe anmerkungen oder fehlermeldungen
 * sehen, das sieht ja todes scheisse aus ... kein gelb mehr ohne farbe. und
 * sauber, nicht so klotzig ueberall die fehlermeldungen und anmerkungen."
 *
 * ## Was daran falsch war
 *
 * Gezaehlt am 04.09.2026: 319 Vorkommen von `amber-` und `yellow-` in 52
 * Dateien. Gelb war nicht EIN Zustand, sondern der Sammelplatz fuer alles, was
 * weder gut noch kaputt ist: ein Expertenhinweis in den Einstellungen, ein
 * gestoppter Server, ein veraltetes Manifest, ein Speicherlimit, die Kategorie
 * eines Gedaechtniseintrags, sogar die Marke eines Modells. Wenn dieselbe
 * Farbe fuenf verschiedene Dinge sagt, sagt sie keins davon.
 *
 * Dazu die Bauform: jede dieser Meldungen war ein Kasten. Fuellflaeche, Rahmen,
 * 10px Polster, fette Ueberschrift. Ein Satz, der erklaert, wofuer die
 * Expertenwerte gut sind, bekam damit dasselbe Gewicht wie ein Absturz.
 *
 * ## Die Regel
 *
 * Es gibt zwei Toene und keinen dritten.
 *
 *   `ruhig`  Alles, was der Nutzer wissen darf, aber nicht sofort. Gedaempftes
 *            Grau, dieselbe Familie wie sekundaerer Text. Kein Kasten.
 *   `fehler` Etwas ist wirklich schiefgegangen und jemand muss handeln. Rot,
 *            und auch das ohne Kasten: die Farbe traegt die Dringlichkeit,
 *            eine Fuellflaeche traegt nur Flaeche.
 *
 * Der dritte Ton, den es frueher gab, war Gelb, und der ist genau das Problem
 * gewesen. Was frueher gelb war, ist heute `ruhig`, wenn es nur informiert,
 * und `fehler`, wenn wirklich etwas kaputt ist. Es gibt kein Dazwischen mehr,
 * weil es nie eins gab.
 *
 * Fuer Zustandspunkte (die kleinen Ampeln an Anbietern und Servern) gilt
 * dasselbe: laeuft ist gruen, laeuft nicht ist grau, kaputt ist rot. „Gestoppt"
 * ist kein halber Fehler, sondern ein ruhiger Zustand.
 */

export type HinweisTon = 'ruhig' | 'fehler'

/** Die Schriftfarbe eines Hinweises. Mehr Farbe traegt ein Hinweis nicht. */
export const HINWEIS_TEXT: Record<HinweisTon, string> = {
  ruhig: 'text-gray-500 dark:text-gray-400',
  fehler: 'text-red-600 dark:text-red-400',
}

/**
 * Die Farbe eines Zustandspunkts.
 *
 * `aus` ist bewusst dasselbe Grau wie ruhiger Text und nicht Gelb: ein Server,
 * den niemand gestartet hat, ist kein Zwischenfall.
 */
export const PUNKT_FARBE = {
  an: 'bg-emerald-500',
  aus: 'bg-gray-400 dark:bg-gray-500',
  kaputt: 'bg-red-500',
} as const

/**
 * Die Zeile, aus der jeder Hinweis besteht: Symbol, Text, sonst nichts.
 *
 * Bewusst kein `rounded`, kein `bg-`, kein `border`. Wer einen Rahmen braucht,
 * hat keinen Hinweis, sondern einen Dialog.
 */
export const HINWEIS_ZEILE = 'flex items-start gap-1.5 t-micro leading-relaxed'
