/**
 * Das Hauszeichen — EIN Pfad, EIN Invertierungsrezept.
 *
 * Der Design-Audit (§3, Signal 9) hat zehn Einbindungen des Monogramms
 * gezaehlt, alle auf `LU-monogram-bw.png` = 512x512 Pixel, und daneben ein
 * `public/LU-monogram.svg` mit null Verwendungen. Die Titlebar hat die
 * Vektorfassung mit `c77682a2` als erste bekommen; die uebrigen neun standen
 * bis hierher weiter auf dem Raster.
 *
 * Warum das zaehlt — nachgerechnet, nicht behauptet:
 *
 *   512 auf 18 px  →  (512/18)^2 ≈ 809 Quellpixel pro Zielpixel
 *   512 auf 20 px  →  (512/20)^2 ≈ 655
 *   512 auf 24 px  →  (512/24)^2 ≈ 455
 *
 * Jedes Zielpixel ist also der Mittelwert von Hunderten Quellpixeln. Was
 * herauskommt, ist eine weiche graue Wolke ohne die Kanten, die das Zeichen
 * ausmachen — und weil beide Modi zusaetzlich `invert` darueberlegen, wird
 * der Matsch auch noch umgedreht. Das SVG rastert bei JEDER Kantenlaenge und
 * jeder Geraetedichte auf die echte Zielgroesse.
 *
 * Was das AUSDRUECKLICH NICHT tut: Platz sparen. Beide Dateien liegen in
 * `public/` und werden von Vite unveraendert kopiert, nie gebuendelt — im JS
 * steht in beiden Faellen nur der Pfad als String. Gemessen wurde ein
 * Unterschied von DREI Byte im Boot-Chunk, und die drei Byte sind die Laenge
 * des kuerzeren Pfads. Das SVG ist mit 11.179 Byte sogar groesser als das PNG
 * mit 3.219 Byte. Der Gewinn ist die Rasterung, sonst nichts. Wer diese
 * Begruendung eines Tages zu „spart Platz" verkuerzt, faellt in
 * `src/components/layout/__tests__/das-zeichen-ist-vektor.test.ts` durch.
 *
 * Warum der Pfad hier und nicht in `components/ui/` liegt: `ui/` gehoert in
 * diesem Durchgang einem anderen Agenten. `layout/` hat mit `sidebar-rows.ts`
 * bereits eine Nicht-Komponenten-Datei und ist von `chat/`, `auth/` und
 * `cloud/` aus genauso erreichbar.
 *
 * Die Titlebar traegt ihre eigene Kopie der Konstante, weil
 * `titlebar-monogramm.test.ts:41` den Literalpfad DORT festnagelt
 * (`const MONOGRAM = '/LU-monogram.svg'`). Ein Import haette diesen Test
 * rot gemacht; ihn umzuschreiben waere Entschaerfen gewesen.
 */

/** Die Vektorfassung des Monogramms. Liegt in `public/`, wird nie gebuendelt. */
export const MONOGRAM = '/LU-monogram.svg'

/**
 * Das Zeichen ist weiss gezeichnet (`fill="#ffffff"` im SVG). Im Dunkelmodus
 * bleibt es weiss, im Hellmodus wird es invertiert, also schwarz. Groesse und
 * Deckkraft bleiben bei der Call-Site — das ist das, was sich pro Ort
 * tatsaechlich unterscheidet.
 */
export const MONOGRAM_INVERT = 'dark:invert-0 invert'
