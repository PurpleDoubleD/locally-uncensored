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
  it('nennt die Zahl UND dass nichts mehr laeuft', () => {
    expect(planStoppedLabel(3, 4)).toBe('the run ended here, 3 of 4 steps done, 1 still open')
  })

  it('zaehlt die offenen Schritte im Plural richtig', () => {
    expect(planStoppedLabel(1, 31)).toBe('the run ended here, 1 of 31 steps done, 30 still open')
  })

  it('behauptet nie ein Ende, das die Leiste gar nicht zeigt', () => {
    // Ein fertiger Plan geht durch `planDoneLabel`, nicht hier durch. Die
    // Zeile darf trotzdem keine negative Restzahl bilden koennen.
    expect(planStoppedLabel(4, 4)).toContain('0 still open')
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
    expect(src).toMatch(/runStatusFrom\(generating, threadStatus, isRunStopped\(activeConversationId\), isRunQueued\(activeConversationId\)\)/)
    expect(src).toMatch(/const stoppedShort = !allDone && !runActive/)
  })

  it('sagt es zugeklappt wie aufgeklappt, wie die Zeile fuer den fertigen Plan', () => {
    // Nur zugeklappt haette es im Code-Panel versteckt, das aufgeklappt
    // startet. Es ist derselbe Fehler, den die Morgan-Zeile schon einmal hatte.
    expect(src).toMatch(/\{stoppedShort && \(/)
    expect(src).toMatch(/testid="plan-run-stopped"/)
    // Und sie teilt sich die Zeile mit der Morgan-Zeile, statt sie
    // abzuschreiben. Zwei Abschriften laufen auseinander, die Typo-Klinke
    // in `die-typo-leiter-und-ihre-umgehung.test.ts` hat genau das schon
    // einmal aufgefangen.
    expect(src).toMatch(/testid="plan-all-done"/)
    expect(src.match(/function Schlusszeile\(/g) ?? []).toHaveLength(1)
  })

  it('der Kreisel dreht nur, solange wirklich etwas laeuft', () => {
    expect(src).toMatch(/runActive \? 'text-blue-400 animate-spin' : 'text-amber-400'/)
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
