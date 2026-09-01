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
 * NACHTRAG 01.09.2026: die drei Zahlen oben sind richtig gerechnet, aber sie
 * ueberzeichnen die sichtbare Wirkung — und das gehoert dazugeschrieben, sonst
 * steht hier eine Begruendung, die staerker klingt als das, was man sieht.
 * Beide Fassungen wurden in Chromium auf jede Groesse gezeichnet, die die App
 * benutzt, und der Alphakanal ausgezaehlt (voll deckende Pixel · Anteil nur
 * teildeckender Pixel):
 *
 *   Groesse (Geraete-Px)   PNG            SVG
 *   10 px @1x  ( 10)       0 · 100 %      0 ·  100 %   beide unter der Schwelle
 *   18 px @1x  ( 18)       2 ·  98 %      3 ·  97 %    praktisch gleich
 *   20 px @1x  ( 20)       1 ·  99 %     14 ·  90 %    sichtbar besser
 *   56 px @2x  (112)    1290 ·  50 %   1571 ·  30 %    der groesste Abstand
 *   80 px @2x  (160)    3284 ·  28 %   3396 ·  25 %
 *
 * Der Gewinn waechst also MIT der Groesse: Chromium skaliert die Bitmap mit
 * einem ordentlichen Filter herunter, kein Nearest-Neighbour. Wo das Zeichen
 * gross steht (die beiden 56px-Stellen, der 80px-Splash), ist der Unterschied
 * deutlich; bei 18px ist er innerhalb des Rauschens.
 *
 * Und die unbequeme Zeile: bei 10 px (`chat/ChatInput.tsx`, Cloud-Chip) und
 * 12 px (`cloud/CloudSwitch.tsx`, `auth/AccountPanel.tsx`) hat KEINE der
 * beiden Fassungen auch nur EIN voll deckendes Pixel — Spitzenalpha 222 (PNG)
 * bzw. 193 (SVG). Das Zeichen ist dort unterhalb seiner eigenen Lesbarkeits-
 * grenze, und das Dateiformat aendert daran nichts. Es ist an allen drei
 * Stellen tragbar, weil das Wort „Cloud" direkt danebensteht und die Aussage
 * traegt; das Zeichen ist dort Aufzaehlungspunkt, nicht Bezeichner. Wer es
 * eines Tages OHNE Text an einer 10px-Stelle einsetzt, hat kein Format-,
 * sondern ein Groessenproblem.
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
 * NACHTRAG 01.09.2026 (D-W3-7). Hier stand: „Die Titlebar traegt ihre eigene
 * Kopie der Konstante, weil `titlebar-monogramm.test.ts` den Literalpfad DORT
 * festnagelt." Das war richtig beschrieben und ist jetzt aufgeloest — der Test
 * nagelt den Import fest statt des Literals, die Doppelung ist weg. Sie war
 * eine echte: zwei Stellen, an denen derselbe Pfad haette veralten koennen.
 *
 * Ausserdem waren es NICHT zehn Einbindungen, sondern zwoelf. Die zwoelfte —
 * `create/experimental/Stage.tsx`, 56px — hing an derselben Bitmap unter
 * ihrem zweiten Dateinamen (die `-white`-Fassung ist byteidentisch mit der
 * `-bw`-Fassung, derselbe MD5) und ist deshalb durch die Wache gefallen, die
 * einen NAMEN kannte statt eines Musters. Die neue Wache
 * (`__tests__/kein-raster-als-hauszeichen.test.ts`) sucht das Muster.
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
