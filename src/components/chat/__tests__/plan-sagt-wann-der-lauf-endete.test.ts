/**
 * Eine Planleiste, die nach dem Lauf weiterzaehlt, als liefe er noch.
 *
 * Persona-Befund vom 03.09.2026, nachgemessen mit echten Klicks im laufenden
 * Build: ein Agentenlauf mit vier Schritten endete, drei davon abgehakt. Das
 * Modell schrieb "fertig, alles erledigt". Danach stand die Leiste auf
 *
 *   PLAN 3/4 | Schritt vier
 *
 * und aufgeklappt drehte sich der Kreisel am vierten Punkt weiter, obwohl
 * nichts mehr lief (kein Stop-Knopf, `generating` leer). Nirgends ein Wort
 * darueber, dass der Lauf vorbei ist.
 *
 * Die Zahl war richtig. Der Aufraeum-Steer in `plan-reconcile.ts` hat ein
 * Budget von zwei, danach endet der Lauf mit offenem Plan, so gewollt. Was
 * fehlte, war die Aussage. `turn-summary.ts` kann sie schreiben ("The run
 * stopped with the plan unfinished"), aber nur, wenn das Modell selbst nichts
 * geschrieben hat; sagt es "alles erledigt", faellt sie weg. Zwei Pfade, einer
 * gepflegt, und der ungepflegte ist der gefaehrliche.
 *
 * Run: npx vitest run src/components/chat/__tests__/plan-sagt-wann-der-lauf-endete.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { planStoppedLabel } from '../PlanBar'
import { runStatusFrom } from '../../../lib/run-idle'
import { isActiveCodexStatus } from '../../../types/codex'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')

describe('planStoppedLabel', () => {
  it('sagt, dass nichts mehr laeuft, ohne Zahlen', () => {
    // Bis 14.11.2026 "the run ended here, 3 of 4 steps done, 1 still open".
    // David: kein Zaehler, weder waehrend der Arbeit noch am Ende; welche
    // Schritte offen sind, zeigt die Liste selbst.
    expect(planStoppedLabel()).toBe('the run ended before every step was done')
    expect(planStoppedLabel()).not.toMatch(/\d/)
  })
})

describe('die Leiste fragt beide Laufquellen, nicht nur eine', () => {
  const src = read('../PlanBar.tsx')

  it('abonniert generationStore UND codexStore', () => {
    // `generating` allein ist die Haelfte, die der Stop des Coding-Agenten
    // zuerst loescht (AS-08). Wer nur die liest, meldet "Lauf vorbei", waehrend
    // der Lauf sich noch abwickelt.
    expect(src).toMatch(/useGenerationStore\(/)
    expect(src).toMatch(/useCodexStore\(/)
  })

  it('holt das Urteil aus run-idle statt sich ein zweites zu bauen', () => {
    expect(src).toMatch(/runStatusFrom\(generating, threadStatus, isRunStopped\(conversationId\), isRunQueued\(conversationId\)\)/)
    expect(src).toMatch(/const stoppedShort = !allDone && !runActive/)
  })

  it('sagt es zugeklappt wie aufgeklappt, wie die Zeile fuer den fertigen Plan', () => {
    // Nur zugeklappt haette es versteckt, solange die Liste offen ist. Es ist
    // derselbe Fehler, den die Morgan-Zeile schon einmal hatte. Seit CA
    // (13.11.2026) haengt der Abschlusskasten an keinem Klappzustand.
    expect(src).toMatch(/\{stoppedShort && \(/)
    expect(src).toMatch(/testid="plan-run-stopped"/)
    // Und sie teilt sich die Zeile mit der Morgan-Zeile, statt sie
    // abzuschreiben. Zwei Abschriften laufen auseinander, die Typo-Klinke
    // in `die-typo-leiter-und-ihre-umgehung.test.ts` hat genau das schon
    // einmal aufgefangen.
    expect(src).toMatch(/testid="plan-changes-waiting"/)
    expect(src.match(/function Abschluss\(/g) ?? []).toHaveLength(1)
  })

  it('der Kreisel dreht nur, solange wirklich etwas laeuft', () => {
    // Diese Zeile hat frueher die gelbe Fassung des Stillstands festgenagelt:
    // stand der Lauf, wurde der Kreisel bernsteinfarben, und genau das stand
    // hier als Muster. Die Regel hat sich am 04.09.2026 geaendert:
    // Der Inhaber hat jedes Gelb aus der Oberflaeche geworfen, seitdem gibt es zwei
    // Toene und keinen dritten (`lib/hinweis.ts`), und ein Schritt, an dem
    // nichts mehr laeuft, ist kein halber Fehler, sondern ruhig. Die Aussage
    // des Tests ist dieselbe geblieben und haengt jetzt an der Bewegung
    // statt an der Farbe: es dreht sich nur, was wirklich laeuft.
    // Seit CA (13.11.2026) entscheidet `planRowStates`: 'running' gibt es nur
    // bei laufendem Lauf, und nur fuer EINEN Schritt (Verhalten in
    // plan-pinned-under-the-newest-message.test.tsx). Ein angehaltener
    // Schritt ist ein ruhiger Kreis.
    expect(src).toMatch(/t\.status === 'in_progress' && runActive && !running/)
    expect(src).toMatch(/state === 'running' \? \(\s*<Loader2[^>]*animate-spin/)
    expect(src).toMatch(/halted \? HINWEIS_TEXT\.ruhig/)
    // Zwei Drehungen in der Datei, beide an einem laufenden Schritt: die Zeile
    // in der Liste und, seit 14.11.2026, die eingeklappte Kopfzeile. Die
    // zweite steht nur, solange ein Schritt 'running' ist (runningIdx >= 0),
    // und das gibt es nur bei laufendem Lauf.
    expect(src.match(/animate-spin/g) ?? []).toHaveLength(2)
    expect(src).toMatch(/\{collapsed && runningIdx >= 0 && \(/)
  })

  it('die Schlusszeile hat einen Ton, den ruhigen', () => {
    // Der dritte hiess `warnung` und war bernsteinfarben. Weder ein Lauf, der
    // endet, noch eine Aenderung, die auf Freigabe wartet, ist ein Fehler;
    // beides ist ruhig. Das Gruen fuer "fertig" ist seit 14.11.2026 weg
    // (David: kein Haken, kein "every step done").
    expect(src).toMatch(/HINWEIS_TEXT\.ruhig/)
    expect(src).not.toMatch(/(?:amber|yellow|emerald)-/)
  })
})

describe('ein eingereihter Lauf sagt das auch', () => {
  // Beim Zusammenfuehren zweier Zweige stiessen hier zwei Umbauten aufeinander:
  // der eine machte die Funktion rein, der andere ergaenzte die Warteschlange.
  // Kein einziger Test deckte den Warteschlangenzweig ab, er haette also
  // stillschweigend verlorengehen koennen. Genau dagegen steht dieser Waechter.
  it('wartend heisst queued und nicht idle', () => {
    expect(runStatusFrom(false, undefined, false, true)).toBe('queued')
  })

  it('ein laufender Lauf bleibt laufend, auch wenn anderswo etwas wartet', () => {
    expect(runStatusFrom(true, undefined, false, true)).toBe('running')
  })

  it('ohne Warteschlange bleibt es idle', () => {
    expect(runStatusFrom(false, undefined, false, false)).toBe('idle')
  })

  it('ein Fehler im Faden schlaegt die Warteschlange nicht weg', () => {
    expect(runStatusFrom(false, 'error', false, true)).toBe('queued')
  })
})

describe('runStatusFrom ist derselbe Spruch wie runStatusOf', () => {
  it('ohne Lauf und ohne Faden: leer', () => {
    expect(runStatusFrom(false, undefined, false, false)).toBe('idle')
    expect(isActiveCodexStatus(runStatusFrom(false, undefined, false, false))).toBe(false)
  })

  it('ein wartender Faden zaehlt als laufend, auch wenn generating schon weg ist', () => {
    // Genau das Fenster aus AS-08: `stopCodex` loescht `generating` sofort,
    // der Faden wickelt sich noch ab.
    expect(runStatusFrom(false, 'awaiting_approval', false, false)).toBe('awaiting_approval')
    expect(isActiveCodexStatus(runStatusFrom(false, 'applying', false, false))).toBe(true)
  })

  it('Stop gedrueckt heisst cancelling, nicht idle', () => {
    expect(runStatusFrom(true, undefined, true, false)).toBe('cancelling')
  })

  it('ein Faden im Fehler ist kein laufender Faden', () => {
    expect(runStatusFrom(false, 'error', false, false)).toBe('error')
    expect(isActiveCodexStatus(runStatusFrom(false, 'error', false, false))).toBe(false)
  })

  it('runStatusOf ist nur noch die Fassung, die selbst nachschlaegt', () => {
    const lib = readFileSync(resolve(here, '../../../lib/run-idle.ts'), 'utf8')
    expect(lib).toMatch(/return runStatusFrom\(/)
    // Kein zweiter Spruch daneben: die Reihenfolge der Faelle steht genau
    // einmal im Haus.
    expect(lib.match(/if \(stopped\) return 'cancelling'|isRunStopped\(conversationId\)\) return 'cancelling'/g) ?? [])
      .toHaveLength(1)
  })
})
