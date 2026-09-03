/**
 * AS-08 — "läuft gerade etwas?" hat zwei unabhängige Quellen.
 *
 * Zwei Dinge werden hier festgenagelt, und beide sind das Muster M1
 * (zwei Pfade, einer gepflegt):
 *
 *  1. Die Zustandsunion bildet ab, was der Lauf wirklich tut. Vorher war sie
 *     `'idle' | 'running' | 'error'`, und `awaiting_approval`, `applying`,
 *     `cancelling` — drei Zustände, in denen die App wirklich steht — fielen
 *     an jeder Verzweigung in ein stilles `else`.
 *  2. Die Frage wird an EINER Stelle beantwortet. `run-idle.ts` versöhnt
 *     `generationStore.generating` und `codexStore.threads[].status`; niemand
 *     sonst darf die eine Hälfte für die Wahrheit halten.
 *
 * Lauf: npx vitest run src/lib/__tests__/eine-wahrheit-fuer-laeuft-etwas.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'

import {
  anyRunActive,
  runsActive,
  runStatusOf,
  isRunActive,
  whenRunsIdle,
} from '../run-idle'
import {
  CODEX_THREAD_STATUSES,
  isActiveCodexStatus,
  type CodexThreadStatus,
} from '../../types/codex'
import { beginRun, stopRun, __resetRunStopsForTests } from '../run-stop'
import { admit, release, __resetRunLanesForTests } from '../run-lanes'
import { useGenerationStore } from '../../stores/generationStore'
import { useCodexStore } from '../../stores/codexStore'

beforeEach(() => {
  useGenerationStore.setState({ generating: {}, aborters: {} })
  useCodexStore.setState({ threads: {} })
  __resetRunStopsForTests()
  __resetRunLanesForTests()
})

describe('die Zustandsunion bildet den echten Lauf ab', () => {
  it('kennt die drei Zustände, die die App hat und der Typ nicht hatte', () => {
    // Nicht geraten: jeder dieser drei hat eine Fundstelle im Produktivcode,
    // sie steht im Kopf von types/codex.ts.
    expect(CODEX_THREAD_STATUSES).toContain('awaiting_approval')
    expect(CODEX_THREAD_STATUSES).toContain('applying')
    expect(CODEX_THREAD_STATUSES).toContain('cancelling')
  })

  it('jeder Zustand hat ein Urteil — kein stilles else', () => {
    // Die Urteilstabelle ist die Quelle der Liste. Ein weiterer Zustand ohne
    // Eintrag ist ein Compilerfehler, kein `false`.
    for (const status of CODEX_THREAD_STATUSES) {
      expect(typeof isActiveCodexStatus(status)).toBe('boolean')
    }
    // Die Zahl ist eine Momentaufnahme, keine Regel. Sie stand auf 6, bis
    // `queued` dazukam (die Spurwarteschlange, lib/run-lanes.ts). Sie bleibt
    // trotzdem stehen: sie faengt einen Zustand, der still danebengelegt wird,
    // ohne dass jemand hier vorbeikommt und ihn einordnet.
    expect(CODEX_THREAD_STATUSES).toHaveLength(7)
  })

  it('warten auf Freigabe, Schreiben auf Platte und Abbrechen zählen als aktiv', () => {
    expect(isActiveCodexStatus('awaiting_approval')).toBe(true)
    expect(isActiveCodexStatus('applying')).toBe(true)
    expect(isActiveCodexStatus('cancelling')).toBe(true)
  })

  it('GEGENPROBE: idle und error sind es nicht', () => {
    expect(isActiveCodexStatus('idle')).toBe(false)
    expect(isActiveCodexStatus('error')).toBe(false)
  })
})

describe('anyRunActive über die volle Union', () => {
  const active: CodexThreadStatus[] = ['running', 'awaiting_approval', 'applying', 'cancelling']

  for (const status of active) {
    it(`ein Thread in '${status}' blockt`, () => {
      expect(anyRunActive({}, { 'conv-1': { status } })).toBe(true)
    })
  }

  it('GEGENPROBE: idle und error blocken nicht, ein generierender Chat schon', () => {
    expect(anyRunActive({}, { a: { status: 'idle' }, b: { status: 'error' } })).toBe(false)
    expect(anyRunActive({ 'conv-1': true }, {})).toBe(true)
  })
})

describe('eine Stelle beantwortet die Frage — für eine Konversation', () => {
  it('der Freigabedialog hält den Lauf am Leben, statt ihn als beendet zu melden', () => {
    useCodexStore.getState().initThread('conv-c', '/tmp')
    useCodexStore.getState().setThreadStatus('conv-c', 'awaiting_approval')
    // generationStore weiß davon nichts — genau die halbe Wahrheit, die
    // CodexModeDropdown und PlanApprovalBar heute allein lesen.
    expect(useGenerationStore.getState().generating['conv-c']).toBeUndefined()
    expect(runStatusOf('conv-c')).toBe('awaiting_approval')
    expect(isRunActive('conv-c')).toBe(true)
    expect(runsActive()).toBe(true)
  })

  it('ein Chat ohne Coding-Thread wird über die andere Quelle beantwortet', () => {
    useGenerationStore.getState().setGenerating('conv-chat', true)
    expect(useCodexStore.getState().threads['conv-chat']).toBeUndefined()
    expect(runStatusOf('conv-chat')).toBe('running')
    expect(isRunActive('conv-chat')).toBe(true)
  })

  it('Stop gedrückt, Lauf läuft noch aus: das heißt cancelling, nicht idle', () => {
    // Der Zustand, in dem die beiden Quellen sich heute widersprechen:
    // stopCodex löscht generating[convId] sofort, der Thread steht bis zum
    // finally des abbrechenden Laufs weiter auf 'running'.
    useCodexStore.getState().initThread('conv-c', '/tmp')
    useCodexStore.getState().setThreadStatus('conv-c', 'running')
    useGenerationStore.getState().setGenerating('conv-c', true)
    beginRun('conv-c')

    stopRun('conv-c')
    useGenerationStore.getState().abortConversation('conv-c')

    expect(useGenerationStore.getState().generating['conv-c']).toBeUndefined()
    expect(runStatusOf('conv-c')).toBe('cancelling')
    expect(isRunActive('conv-c')).toBe(true)
  })

  it('GEGENPROBE: der klebrige Stop-Merker allein macht keinen Lauf', () => {
    // run-stop bleibt bis zur nächsten Anweisung gesetzt. Ohne aktiven Lauf
    // darf daraus kein 'cancelling' werden, sonst stünde die Frage danach
    // für immer auf "läuft".
    stopRun('conv-c')
    expect(runStatusOf('conv-c')).toBe('idle')
    expect(isRunActive('conv-c')).toBe(false)
    expect(runsActive()).toBe(false)
  })

  it('GEGENPROBE: ein fehlgeschlagener Thread ist beendet, nicht beschäftigt', () => {
    useCodexStore.getState().initThread('conv-c', '/tmp')
    useCodexStore.getState().setThreadStatus('conv-c', 'error')
    expect(runStatusOf('conv-c')).toBe('error')
    expect(isRunActive('conv-c')).toBe(false)
  })

  it('GEGENPROBE: ohne Konversation gibt es nichts zu beantworten', () => {
    expect(runStatusOf(null)).toBe('idle')
    expect(isRunActive(undefined)).toBe(false)
  })
})

describe('der eingereihte Lauf ist die dritte Quelle', () => {
  it('wer auf die lokale Spur wartet, ist nicht idle, sonst zeigt der Chat "Senden"', () => {
    // Der Fall in einem Satz: ein lokaler Lauf haelt die Karte, der zweite
    // Chat hat schon gesendet und wartet. Er steht in KEINEM der beiden
    // Speicher, also kein generating und kein Thread, weil noch nichts
    // angefangen hat, was etwas setzen koennte.
    admit('local', 'conv-a', () => {})
    expect(admit('local', 'conv-b', () => {})).toBe('queued')

    expect(useGenerationStore.getState().generating['conv-b']).toBeUndefined()
    expect(useCodexStore.getState().threads['conv-b']).toBeUndefined()

    expect(runStatusOf('conv-b')).toBe('queued')
    expect(isRunActive('conv-b')).toBe(true)
    expect(runsActive()).toBe(true)
  })

  it('der Wartende geht vor einem alten Fehler, der gilt einem beendeten Lauf', () => {
    // Ohne die Reihenfolge stuende an einem Gespraech, dessen naechster Lauf
    // schon gebucht ist, das Urteil des vorletzten.
    useCodexStore.getState().initThread('conv-b', '/tmp')
    useCodexStore.getState().setThreadStatus('conv-b', 'error')
    expect(runStatusOf('conv-b')).toBe('error')

    admit('local', 'conv-a', () => {})
    admit('local', 'conv-b', () => {})
    expect(runStatusOf('conv-b')).toBe('queued')
  })

  it('drankommen loescht das Warten: der Nachrueckende ist nicht mehr eingereiht', () => {
    admit('local', 'conv-a', () => {})
    admit('local', 'conv-b', () => {})
    expect(runStatusOf('conv-b')).toBe('queued')

    release('conv-a')
    // conv-b haelt jetzt die Spur. Es wartet nicht mehr, und weil sein Lauf
    // im selben Zug generating setzt, ist es 'running' statt 'idle'.
    expect(runStatusOf('conv-b')).toBe('idle')
    useGenerationStore.getState().setGenerating('conv-b', true)
    expect(runStatusOf('conv-b')).toBe('running')
  })

  it('GEGENPROBE: der Halter selbst gilt nicht als eingereiht', () => {
    // Er rechnet ja. Stuende er als 'queued' da, waere die Anzeige genau
    // falsch herum: der laufende wartet, der wartende laeuft.
    expect(admit('local', 'conv-a', () => {})).toBe('started')
    expect(runStatusOf('conv-a')).toBe('idle')
    expect(runsActive()).toBe(false)
  })

  it('GEGENPROBE: eine Cloud-Spur reiht nie ein', () => {
    admit('cloud', 'conv-a', () => {})
    admit('cloud', 'conv-b', () => {})
    expect(runStatusOf('conv-b')).toBe('idle')
    expect(runsActive()).toBe(false)
  })
})

describe('der aufgeschobene Dialog erbt die volle Union', () => {
  it('ein Lauf, der auf die Freigabe wartet, hält den Backend-Wähler zu', () => {
    // Vor AS-08 öffnete der Wähler hier: `status === 'running'` war falsch,
    // also galt der Lauf als beendet — und der Modal stand über dem
    // Freigabedialog, den der Nutzer gerade lesen soll.
    useCodexStore.getState().initThread('conv-c', '/tmp')
    useCodexStore.getState().setThreadStatus('conv-c', 'awaiting_approval')
    let shown = 0
    whenRunsIdle(() => shown++)
    expect(shown).toBe(0)
    useCodexStore.getState().setThreadStatus('conv-c', 'idle')
    expect(shown).toBe(1)
  })

  it('ein Thread, der seine Änderungen schreibt, ebenso', () => {
    useCodexStore.getState().initThread('conv-c', '/tmp')
    useCodexStore.getState().setThreadStatus('conv-c', 'applying')
    let shown = 0
    whenRunsIdle(() => shown++)
    expect(shown).toBe(0)
    useCodexStore.getState().setThreadStatus('conv-c', 'idle')
    expect(shown).toBe(1)
  })
})
