/**
 * Wie breit das Promptfenster ist, an EINER Stelle.
 *
 * David, 03.09.2026, am echten Windows-Build: "prompt fenster auf windows im
 * chat bzw coding bereich ist mir etwas zu gross, lieber so gross wie im
 * create tab, eventuell minimal groesser, so dass jedes UI Button platz
 * dafuer hat."
 *
 * Nachgemessen im laufenden Release-Build (1920x1040): das Fenster war
 * 1258 px breit, weil hier eine Prozentbreite stand, 70 Prozent der Spalte.
 * Der Create-Tab hat stattdessen eine feste Zahl, 760 px, und genau deshalb
 * sieht er ruhiger aus.
 *
 * Die beiden alten Werte stehen hier ausgeschrieben und absichtlich nicht als
 * Klassennamen: Tailwind 4 liest diese Datei als Text und macht aus jedem
 * Wort, das wie eine Utility aussieht, eine CSS-Regel, auch aus einem
 * Kommentar. Backticks helfen nicht, der Scanner liest sie mit. Damit stuenden
 * zwei Breiten im ausgelieferten CSS, die niemand aufruft; bewacht wird das
 * von __tests__/keine-klasse-aus-prosa.test.ts.
 *
 * Die Zahl unten ist Creates Breite plus 53, gerendert also plus 60: minimal
 * groesser, wie erbeten. Der Grund fuer das Plus steht in derselben Messung:
 * die Aktionsleiste hier traegt mehr Bedienelemente als die in Create und
 * braucht im Ruhezustand mindestens 532 gerenderte px (Klammer, Mikrofon,
 * Think, Werkzeuge, Modellwaehler, Senden, plus Abstaende und Innenrand). In
 * den Rest passen der Effort-Regler und der Stop-Knopf, die erst waehrend
 * eines Laufs dazukommen, und ein langer Modellname. Die Leiste bricht deshalb
 * nicht um, und genau das war Davids Bedingung.
 *
 * ACHTUNG, 713 ist kein Tippfehler, und 820 waere heute falsch. Seit dem
 * Massstabwechsel steht das Wurzelmass auf 16 px und die App-Wurzel traegt die
 * 15 Prozent genau einmal als zoom (siehe --ui-scale in index.css). Jede
 * px-Zahl der App wird seither MITSKALIERT: 820 ergaebe 943 gerenderte px, das
 * Fenster waere also gewachsen statt zu schrumpfen. 713 x 1,15 = 820
 * gerenderte px, und das ist genau die Breite, die am Windows-Build gemessen
 * und fuer richtig befunden wurde. Dieselbe Rechnung steht am Create-Composer
 * (dort wurden aus 760 eben 660) und an --lu-measure. Wer die Zahl
 * "korrigiert", weil sie zu schmal aussieht, macht das Fenster um 15 Prozent
 * breiter, nicht die Zahl richtig.
 *
 * OFFEN, und ausdruecklich nicht hier entschieden: das Transkript darueber
 * laeuft auf --lu-measure (759 gerenderte px), dieses Fenster auf 820. Die
 * 61 px sind Davids "eventuell minimal groesser" und keine Panne. Der
 * Token-Kommentar in index.css beschreibt --lu-measure aber als EINE Spalte
 * fuer Transkript, Fenster und Statusanker. Welche der beiden Aussagen gilt,
 * ist eine Designentscheidung und braucht eine Messung am laufenden Fenster,
 * nicht einen Test.
 *
 * Warum als Konstante und nicht viermal im JSX: direkt UEBER dem Fenster
 * sitzen drei weitere Leisten (LoopBar, GoalBar, GroupCostHint), die genau so
 * breit sein muessen. Vier Zahlen an vier Stellen heisst, dass eine geaendert
 * wird und drei driften, und dann stehen die Leisten breiter als das Fenster,
 * unter dem sie kleben. Das ist das teuerste Muster im Haus, zwei Pfade und
 * einer gepflegt, hier viermal.
 */
export const COMPOSER_MAX_W = 'max-w-[713px]'

/**
 * Das Innenpolster des Fensterrahmens, `px-3` links wie rechts.
 *
 * COMPOSER_MAX_W deckelt den RAHMEN um das Fenster, nicht das Fenster. Wer
 * die sichtbare Kante der Promptbox braucht, muss diese 24 abziehen; am
 * laufenden Windows-Bau (1296x808, --ui-scale 1.15) sind das 819,9 gerenderte
 * px fuer den Rahmen und 792,3 fuer die Box darin.
 */
const COMPOSER_PAD_PX = 24

/** Die sichtbare Breite der Promptbox, in Entwurfspixeln. */
export const COMPOSER_BOX_PX =
  Number(COMPOSER_MAX_W.match(/(\d+)/)![1]) - COMPOSER_PAD_PX

/**
 * Wie breit das Transkript ist, abgeleitet und nicht daneben gestellt.
 *
 * David, 05.09.2026: das Transkript stand exakt auf `--lu-measure` (759
 * gerenderte px) und war damit sogar schmaler als die Promptbox darunter
 * (792,3). Er will es links und rechts um je rund 20 Prozent ueber die Box
 * hinausragen sehen, also die 1,4-fache Breite bei gleicher Mitte.
 *
 * Die Zahl steht deshalb NICHT als zweite Konstante daneben, sondern faellt
 * aus der Breite der Promptbox: 689 x 1,4 = 964,6, gerundet 965. Wer oben die
 * 713 aendert, aendert diese Zahl mit; eine Drift zwischen beiden ist nicht
 * moeglich.
 *
 * Als Zahl und nicht als Tailwind-Klasse: Tailwind SCANNT Klassennamen aus
 * dem Quelltext und kann nichts rechnen, eine zusammengesetzte Breitenklasse
 * erzeugt also gar keine Regel. Und eine ausgeschriebene zweite Pixelzahl
 * waere genau die Doppelung, die der Kopf dieser Datei fuer die vier Leisten
 * beschreibt. Die Zahl geht deshalb als `style` an das Transkript.
 */
export const TRANSCRIPT_MAX_PX = Math.round(COMPOSER_BOX_PX * 1.4)
