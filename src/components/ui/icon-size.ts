/**
 * Die Icon-Leiter: 12 / 16 / 20 — und die optische Korrektur dazu.
 *
 * Der Befund (Audit §2, Iconografie; nachgezaehlt am Stand 3883eaa8):
 * 668 `size={…}`-Fundstellen in `src/components` verteilen sich auf
 * NEUNZEHN verschiedene Werte — 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18,
 * 20, 22, 24, 26, 28, 30, 32, 36. Der Audit nennt „9 Icon-Groessen auf
 * einem Screen"; ueber die ganze App sind es 19.
 *
 * ── Die Leiter ──────────────────────────────────────────────────────
 * Drei Stufen reichen fuer alles, was diese App zeigt:
 *
 *   SM 12px  begleitet Text (Chips, Zeilen, Badges, Statuspunkte)
 *   MD 16px  steht fuer sich in einem Control (Composer, Kopfzeile, Menue)
 *   LG 20px  traegt eine Flaeche (Empty-State, Dialogkopf, Bereichsmarke)
 *
 * Warum 12/16/20 und nicht 11/14/18: alle drei sind bei den beiden
 * Geraetedichten, die diese App wirklich sieht (1x auf Windows/Linux,
 * 2x auf Retina), ganze Geraetepixel. `size` ist bei lucide eine reine
 * px-Zahl und laeuft damit AM 18,4px-Wurzelmass vorbei — die krummen
 * Groessen der App sind hier also nicht ererbt, sondern von Hand gesetzt.
 *
 * ── Die optische Korrektur ──────────────────────────────────────────
 * Der eigentliche Grund, warum 19 Groessen wie 19 GEWICHTE aussehen:
 * lucide zeichnet auf einem 24er-Raster mit `stroke-width="2"` und skaliert
 * das Ganze auf `size`. Die gesehene Strichstaerke ist damit
 *
 *     2 * size / 24
 *
 * also 0,67px bei size=8 und 1,67px bei size=20 — ein Faktor 2,5 zwischen
 * zwei Icons, die nebeneinander in derselben Zeile stehen. Das kleine
 * verblasst, das grosse wirkt fett, und keines der beiden liegt auf einem
 * Geraetepixel (1,33px bei size=16 sind 2,67 Geraetepixel bei 2x — der
 * Strich wird ueber drei Pixelreihen verschmiert).
 *
 * Die Korrektur ist deshalb keine Geschmacksfrage, sondern Arithmetik:
 * die gesehene Strichstaerke wird KONSTANT gehalten, und zwar auf
 * `ICON_STROKE_PX` = 1 CSS-Pixel. 1px ist bei 1x genau ein Geraetepixel und
 * bei 2x genau zwei — der einzige Wert unter 2px, der auf BEIDEN Dichten
 * scharf liegt. Nebenbei ist es fast genau das, was die haeufigsten
 * Groessen der App heute schon zeigen (size=11 → 0,92px, size=12 → 1,00px);
 * korrigiert werden also vor allem die Ausreisser nach oben und unten.
 *
 * Umgesetzt wird das NICHT hier und nicht an 668 Call-Sites, sondern einmal
 * an der App-Wurzel: `layout/AppShell.tsx` haengt einen `<LucideProvider
 * absoluteStrokeWidth strokeWidth={ICON_STROKE_PX}>` um den Baum. lucide
 * rechnet daraus pro Icon `strokeWidth * 24 / size` und trifft damit exakt
 * die konstante gesehene Staerke. Ein Rezept an der Wurzel, kein Prop an
 * jedem Icon — dasselbe Muster wie `.lu-control` fuer die Controls.
 *
 * Diese Datei ist deshalb bewusst klein: sie ist die LEITER (drei Zahlen,
 * die Call-Sites benutzen) plus die eine Zahl, aus der die Korrektur
 * ausgerechnet wird. Wer eine vierte Stufe braucht, nimmt eine dieser drei.
 */

/** Icon neben Text: Chips, Listenzeilen, Badges, Statuspunkte. */
export const ICON_SM = 12

/** Icon in einem eigenen Control: Composer, Kopfzeile, Menuezeile. */
export const ICON_MD = 16

/** Icon als Flaechenmarke: Empty-State, Dialogkopf, Bereichsmarke. */
export const ICON_LG = 20

/**
 * Die gesehene Strichstaerke in CSS-Pixeln, gleich auf jeder Stufe.
 * Wird von `AppShell` an `LucideProvider` weitergereicht; lucide macht mit
 * `absoluteStrokeWidth` daraus pro Icon `ICON_STROKE_PX * 24 / size`.
 */
export const ICON_STROKE_PX = 1

/**
 * Die EINE erlaubte Abweichung von der Hausstaerke: Flaechenmarken.
 *
 * Ein Icon, das als Marke eine leere Flaeche traegt (Empty-State, Buehne,
 * Ablegefeld — 26 bis 36px), zerfaellt bei 1px zur Haarlinie: bei gleicher
 * Strichstaerke sinkt das Verhaeltnis Strich zu Flaeche mit der Groesse, und
 * ab etwa dem Doppelten der groessten Leiterstufe sieht man das. Doppelte
 * Hausstaerke, nicht mehr — vorher standen an diesen Stellen 1.625, 1.875
 * und 2.25px nebeneinander, drei handgesetzte Werte fuer dieselbe Aussage.
 */
export const ICON_STROKE_MARK = ICON_STROKE_PX * 2

/** Die Leiter als Liste — fuer Tests und fuer `iconStrokeAttr` unten. */
export const ICON_LADDER = [ICON_SM, ICON_MD, ICON_LG] as const

/**
 * Der `stroke-width`-Wert, den lucide fuer eine Groesse setzt, wenn die
 * optische Korrektur greift. Steht hier, damit die Rechnung nachpruefbar
 * ist, ohne lucide zu rendern — der Test rechnet gegen diese Funktion und
 * gegen die Formel aus dem lucide-Quelltext, nicht gegen eine Tabelle.
 *
 *   iconStrokeAttr(12) = 2.0   → gesehen 2.0 * 12/24 = 1px
 *   iconStrokeAttr(16) = 1.5   → gesehen 1.5 * 16/24 = 1px
 *   iconStrokeAttr(20) = 1.2   → gesehen 1.2 * 20/24 = 1px
 */
export function iconStrokeAttr(size: number): number {
  return (ICON_STROKE_PX * 24) / size
}

/** Die tatsaechlich gesehene Strichstaerke in CSS-px fuer eine Groesse. */
export function seenStrokePx(size: number, strokeAttr: number): number {
  return (strokeAttr * size) / 24
}
