import { useEffect, useRef } from 'react'
import { useAgentTaskStore } from '../stores/agentTaskStore'
import { useGenerationStore } from '../stores/generationStore'
import { useModelStore } from '../stores/modelStore'
import { createWakeWatcher } from '../lib/agent-wake'

/**
 * Holt den Hauptagenten zurueck, wenn ein Hintergrundagent fertig ist.
 *
 * ── WARUM ES DAS GIBT ──────────────────────────────────────────────────────
 *
 * Das Ergebnis erreicht das Modell ueber `appendTaskReport`, und der steht
 * oben in der ReAct-Schleife. Endet eine Hintergrundaufgabe nach dem Zug — der
 * Normalfall, sie laeuft ja laenger —, gibt es keine Schleife, die sie abholt.
 * Wer drei Recherchen bestellt und dann wartet, wartet fuer immer.
 *
 * ── WAS HIER STEHT UND WAS NICHT ───────────────────────────────────────────
 *
 * Nur die Verdrahtung: Stores hinein, Sendeweg hinein, Abonnement auf und
 * wieder zu. Die Regeln — Sammelfrist, "laeuft schon", "ein Weckzug zur Zeit" —
 * stehen in lib/agent-wake.ts, weil vitest hier nur `.test.ts` einsammelt und
 * die Regeln genau die Art sind, die beim naechsten Umbau still verlorengeht.
 *
 * ── WARUM ALS ABONNEMENT UND NICHT IM STORE ────────────────────────────────
 *
 * Der Aufgaben-Store weiss nichts von Zuegen, und das soll so bleiben: er ist
 * die Buchhaltung, nicht der Antrieb. Einen Zug aus einem Zustand-Setter
 * heraus zu starten waere ausserdem ein Seiteneffekt mitten in einer
 * Store-Aktualisierung.
 */
export function useBackgroundAgentWake(
  conversationId: string | null | undefined,
  senden: (text: string, images?: undefined, opts?: { hiddenUser?: boolean }) => Promise<unknown>,
): void {
  // In Refs, damit das Abonnement NICHT bei jedem Render neu aufgebaut wird:
  // `senden` ist in beiden Hooks ein useCallback, dessen Identitaet sich mit
  // jedem Zustandswechsel aendern kann, und ein Abonnement, das dabei
  // abreisst, verpasst genau den Abschluss, auf den es wartet.
  //
  // Nachgefuehrt in einem Effekt und NICHT im Render: React 19 verbietet das
  // Schreiben eines Refs waehrend des Renders (`react-hooks/refs`), weil ein
  // verworfener Render sonst einen Wert hinterliesse, den es nie gab.
  const sendenRef = useRef(senden)
  const convRef = useRef(conversationId)
  useEffect(() => {
    sendenRef.current = senden
    convRef.current = conversationId
  })

  useEffect(() => {
    const watcher = createWakeWatcher({
      conversationId: () => convRef.current,
      tasks: (id) => useAgentTaskStore.getState().forConv(id),
      isRunning: (id) => !!useGenerationStore.getState().generating[id],
      activeModel: () => useModelStore.getState().activeModel,
      // `hiddenUser`: der Satz erreicht das Modell, nicht das Auge. Sichtbar
      // stuende im Verlauf eine Nutzernachricht, die der Mensch nie
      // geschrieben hat. Was er sieht, ist die Notiz des fertigen Agenten und
      // danach die Antwort darauf.
      send: (text) => sendenRef.current(text, undefined, { hiddenUser: true }),
    })

    // ZWEI Quellen, und die zweite ist die, an der die erste Fassung scheiterte.
    //
    // Am 02.09.2026 im laufenden Fenster nachgemessen: der Sub-Agent scheiterte
    // sofort (falsche Modellkennung), war also fertig, WAEHREND der Elternzug
    // noch lief. `check` sah "laeuft schon" und stieg aus — richtig. Dann
    // endete der Zug, und der Aufgaben-Store aenderte sich nie wieder. Es sah
    // also nie wieder jemand hin, und das Ergebnis blieb liegen, bis der
    // Mensch von sich aus etwas schrieb: genau das Loch, das dieser Hook
    // schliessen sollte.
    //
    // Der Generierungs-Store ist die fehlende Kante: sein Umschalten auf
    // "fertig" ist der Moment, in dem aus "darf nicht" ein "darf" wird.
    const abAufgaben = useAgentTaskStore.subscribe(watcher.check)
    const abLauf = useGenerationStore.subscribe(watcher.check)
    // Einmal beim Aufsetzen: eine Aufgabe kann fertig geworden sein, waehrend
    // dieser Hook nicht montiert war — beim Wechsel in ein anderes Gespraech
    // und wieder zurueck etwa.
    watcher.check()
    return () => {
      abAufgaben()
      abLauf()
      watcher.dispose()
    }
  }, [])
}
