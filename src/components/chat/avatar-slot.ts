/**
 * Der Avatar-Slot — EIN Rezept fuer beide Sprecher.
 *
 * Design-Audit §4, „Chat mit Antwort": „Zwei Avatar-Systeme: Assistent
 * rahmenlos, User als gerahmte Box mit 11px-Icon". Die Nutzerseite trug
 * Flaeche + Rahmen, das Monogramm sass nackt auf der Pane, und die Code-Ansicht
 * hatte mit `w-5 h-5` ohne Rahmen noch eine dritte Fassung.
 *
 * Warum das mehr ist als Geschmack: die Avatarspalte ist der Taktgeber beim
 * Ueberfliegen eines Transkripts. Zwei Silhouetten in einer Spalte heissen,
 * dass der Sprecherwechsel an der FORM nicht ablesbar ist — man muss den
 * Inhalt des Chips lesen, um zu wissen, wer spricht. Ein Chip fuer beide gibt
 * der Spalte eine konstante Kante.
 *
 * Nebeneffekt, und kein kleiner: das Monogramm ist weiss gezeichnet und wird
 * im Hellmodus per `invert` geschwaerzt. Ohne Chip stand es direkt auf der
 * jeweiligen Pane — im Hellmodus schwarz auf Weiss, im Dunkelmodus weiss auf
 * #1e1e1e. Mit Chip steht es in beiden Modi auf einer definierten Flaeche.
 */

/**
 * Der Chip selbst. 24x24 im Chat, dieselbe Klasse in der Code-Ansicht — die
 * Groesse steht hier und nicht mehr pro Datei, sonst laufen sie wieder
 * auseinander (Chat 24px, Code 20px war der Stand davor).
 */
export const AVATAR_SLOT =
  'w-6 h-6 rounded-md overflow-hidden flex items-center justify-center shrink-0 ' +
  'bg-gray-100 dark:bg-white/8 border border-gray-200 dark:border-white/10'
