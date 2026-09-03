/**
 * Wie breit das Promptfenster ist, an EINER Stelle.
 *
 * David, 03.09.2026, am echten Windows-Build: "prompt fenster auf windows im
 * chat bzw coding bereich ist mir etwas zu gross, lieber so gross wie im
 * create tab, eventuell minimal groesser, so dass jedes UI Button platz
 * dafuer hat."
 *
 * Nachgemessen im laufenden Release-Build (1920x1040): das Fenster war
 * 1258 px breit, weil hier `max-w-[70%]` stand. Der Create-Tab hat eine feste
 * Zahl, `max-w-[760px]`, und genau deshalb sieht er ruhiger aus.
 *
 * Die Zahl unten ist Creates 760 plus 60, also minimal groesser, wie erbeten.
 * Der Grund fuer das Plus steht in derselben Messung: die Aktionsleiste hier
 * traegt mehr Bedienelemente als die in Create und braucht im Ruhezustand
 * mindestens 532 px (Klammer, Mikrofon, Think, Werkzeuge, Modellwaehler,
 * Senden, plus Abstaende und Innenrand). In die restlichen 288 px passen der
 * Effort-Regler und der Stop-Knopf, die erst waehrend eines Laufs dazukommen,
 * und ein langer Modellname. Die Leiste bricht deshalb nicht um, und genau das
 * war Davids Bedingung.
 *
 * Warum als Konstante und nicht viermal im JSX: direkt UEBER dem Fenster
 * sitzen drei weitere Leisten (LoopBar, GoalBar, GroupCostHint), die genau so
 * breit sein muessen. Vier Zahlen an vier Stellen heisst, dass eine geaendert
 * wird und drei driften, und dann stehen die Leisten breiter als das Fenster,
 * unter dem sie kleben. Das ist das teuerste Muster im Haus, zwei Pfade und
 * einer gepflegt, hier viermal.
 */
export const COMPOSER_MAX_W = 'max-w-[820px]'
