/**
 * Der Satz ueber den Providerwechsel darf nicht genau dann verschwinden, wenn
 * er wahr wird.
 *
 * Gegenprobe G1, 04.09.2026, gemessen im echten Windows-Build. Klick auf eine
 * LM-Studio-Zeile, waehrend die LU Engine mit Phi-4 bedient:
 *
 *     0,17 s   "Switched your chat provider to LM Studio for this model."
 *              Knopf zeigt weiter Phi-4, Port 8127 bedient weiter Phi-4
 *    12,04 s   Satz noch da
 *    12,44 s   Satz weg, Knopf springt auf qwen2.5-0.5b, Port 8127 zu
 *
 * "Er steht also ausschliesslich waehrend der Zeit auf dem Schirm, in der er
 * noch nicht stimmt." Ursache war die gewoehnliche Zwoelf-Sekunden-Uhr auf
 * einem Vorgang, der laenger dauert als sie.
 *
 * Run: npx vitest run src/api/__tests__/die-wechselzeile-steht-bis-sie-stimmt.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  announceChatProviderSwitch, chatProviderSwitchNote, CHAT_PROVIDER_SWITCH_HOLD_MS,
} from '../lu-engine-switch'
import { useLuEngineSwitchStore, LU_ENGINE_SWITCH_NOTE_MS } from '../../stores/luEngineSwitchStore'
import { useModelStore } from '../../stores/modelStore'

const ZIEL = 'qwen2.5-0.5b'
const VORHER = 'Phi-4-mini-instruct-Q4_K_M'

describe('die Wechselzeile', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useLuEngineSwitchStore.getState().dismiss()
    useModelStore.setState({ activeModel: VORHER })
  })
  afterEach(() => { vi.useRealTimers() })

  it('steht sofort da, denn der Steckplatz ist sofort umgehaengt', () => {
    announceChatProviderSwitch('LM Studio', ZIEL)
    expect(useLuEngineSwitchStore.getState().note).toBe(chatProviderSwitchNote('LM Studio'))
  })

  it('steht bei 12,44 s noch, wo sie frueher weg war', () => {
    announceChatProviderSwitch('LM Studio', ZIEL)
    vi.advanceTimersByTime(12_440)
    expect(useLuEngineSwitchStore.getState().note).not.toBeNull()
  })

  it('und laeuft erst ab, nachdem die Wahl angekommen ist', () => {
    announceChatProviderSwitch('LM Studio', ZIEL)
    vi.advanceTimersByTime(12_440)
    // Jetzt springt der Knopf, so wie auf der Box bei 12,44 s.
    useModelStore.setState({ activeModel: ZIEL })
    // Der Halt wird im Takt der Uhr geprueft, nicht in dem Augenblick, in dem
    // die Wahl ankommt. Der Nutzer bekommt also den Rest des laufenden Taktes,
    // hier 11,56 s, in denen die Zeile zutrifft und zu lesen ist. Frueher
    // waren es null.
    vi.advanceTimersByTime(10_000)
    expect(useLuEngineSwitchStore.getState().note).not.toBeNull()
    vi.advanceTimersByTime(2 * LU_ENGINE_SWITCH_NOTE_MS)
    expect(useLuEngineSwitchStore.getState().note).toBeNull()
  })

  it('bleibt nicht ewig stehen, wenn die Wahl nie ankommt', () => {
    announceChatProviderSwitch('LM Studio', ZIEL)
    vi.advanceTimersByTime(CHAT_PROVIDER_SWITCH_HOLD_MS + 3 * LU_ENGINE_SWITCH_NOTE_MS)
    expect(useLuEngineSwitchStore.getState().note).toBeNull()
  })

  // Negativkontrolle: genau die alte Ansage, an genau diesem Ablauf.
  it('die alte Ansage ohne Halt waere bei 12,44 s weg gewesen', () => {
    useLuEngineSwitchStore.getState().announce(chatProviderSwitchNote('LM Studio'))
    vi.advanceTimersByTime(12_440)
    expect(useLuEngineSwitchStore.getState().note).toBeNull()
  })
})

describe('verdrahtet', () => {
  const lies = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8')

  it('beide Tueren sagen es ueber dieselbe Stelle an', () => {
    expect(lies('components/models/ModelSelector.tsx'))
      .toContain('announceChatProviderSwitch(handedBackTo, model.name)')
    expect(lies('hooks/useModels.ts'))
      .toContain('announceChatProviderSwitch(handedBackTo, name)')
  })

  it('und keine von beiden ruft die nackte Ansage mehr', () => {
    for (const f of ['components/models/ModelSelector.tsx', 'hooks/useModels.ts']) {
      expect(lies(f)).not.toContain('announce(chatProviderSwitchNote(')
    }
  })
})
