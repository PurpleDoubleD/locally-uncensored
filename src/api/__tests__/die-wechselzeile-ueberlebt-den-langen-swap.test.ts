/**
 * Nachpruefung G3, 04.09.2026, Build 5, zweimal am echten Windows-Build
 * gemessen: der Satz "Switched your chat provider to the LU Engine for this
 * model." erschien nach 15 bzw. 18 ms, verschwand nach 12,3 s, und wahr wurde
 * er erst nach 16,4 bzw. 16,8 s. Er war also rund vier Sekunden VOR seiner
 * eigenen Wahrheit weg.
 *
 * Derselbe Fehler war auf dem anderen Weg (zurueck zu LM Studio) schon einmal
 * gefixt worden, mit `holdWhile` gegen die Wahl im Store. Hier taugt die Wahl
 * nicht als Zeuge: sie steht schon nach Millisekunden, absichtlich, damit die
 * Modelliste beim Steckplatzwechsel nicht auf den Listenkopf zurueckfaellt.
 * Wer hier die Wahrheit kennt, ist der Riegel um den Swap.
 *
 * Lauf: npx vitest run src/api/__tests__/die-wechselzeile-ueberlebt-den-langen-swap.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  announceLuEngineSwitch,
  LU_ENGINE_SWITCH_NOTE,
  CHAT_PROVIDER_SWITCH_HOLD_MS,
} from '../lu-engine-switch'
import { useLuEngineSwitchStore, LU_ENGINE_SWITCH_NOTE_MS } from '../../stores/luEngineSwitchStore'
import { tryAcquireLuEngineSwap, releaseLuEngineSwap, luEngineSwapInFlight } from '../lu-engine-swap-lock'

/** So lange braucht der Swap auf der Box wirklich. */
const SWAP_MS = 16_400

beforeEach(() => {
  vi.useFakeTimers()
  useLuEngineSwitchStore.setState({ note: null, tone: 'info' })
  if (luEngineSwapInFlight()) releaseLuEngineSwap()
})

afterEach(() => {
  if (luEngineSwapInFlight()) releaseLuEngineSwap()
  vi.useRealTimers()
})

describe('announceLuEngineSwitch', () => {
  it('steht noch, wenn der Swap laenger dauert als die gewoehnliche Uhr', () => {
    expect(tryAcquireLuEngineSwap()).toBe(true)
    announceLuEngineSwitch()
    expect(useLuEngineSwitchStore.getState().note).toBe(LU_ENGINE_SWITCH_NOTE)

    // Genau der Moment, in dem die Zeile frueher verschwand.
    vi.advanceTimersByTime(LU_ENGINE_SWITCH_NOTE_MS + 500)
    expect(useLuEngineSwitchStore.getState().note).toBe(LU_ENGINE_SWITCH_NOTE)

    // Und bis der Swap wirklich durch ist.
    vi.advanceTimersByTime(SWAP_MS - LU_ENGINE_SWITCH_NOTE_MS)
    expect(useLuEngineSwitchStore.getState().note).toBe(LU_ENGINE_SWITCH_NOTE)
  })

  it('gibt dem Nutzer NACH dem Wechsel noch Lesezeit', () => {
    expect(tryAcquireLuEngineSwap()).toBe(true)
    announceLuEngineSwitch()
    vi.advanceTimersByTime(SWAP_MS)
    releaseLuEngineSwap()

    // Der Riegel ist weg, jetzt laeuft die gewoehnliche Uhr AB HIER.
    vi.advanceTimersByTime(LU_ENGINE_SWITCH_NOTE_MS - 1_000)
    expect(useLuEngineSwitchStore.getState().note).toBe(LU_ENGINE_SWITCH_NOTE)
    vi.advanceTimersByTime(2_000)
    expect(useLuEngineSwitchStore.getState().note).toBeNull()
  })

  it('bleibt bei einem haengenden Swap nicht ewig stehen', () => {
    expect(tryAcquireLuEngineSwap()).toBe(true)
    announceLuEngineSwitch()
    // Der Riegel wird nie freigegeben. Nach der Frist raeumt die Zeile trotzdem.
    vi.advanceTimersByTime(CHAT_PROVIDER_SWITCH_HOLD_MS + LU_ENGINE_SWITCH_NOTE_MS + 2_000)
    expect(useLuEngineSwitchStore.getState().note).toBeNull()
  })

  it('ist ohne laufenden Swap eine gewoehnliche Zeile auf der gewoehnlichen Uhr', () => {
    announceLuEngineSwitch()
    expect(useLuEngineSwitchStore.getState().note).toBe(LU_ENGINE_SWITCH_NOTE)
    vi.advanceTimersByTime(LU_ENGINE_SWITCH_NOTE_MS + 1_000)
    expect(useLuEngineSwitchStore.getState().note).toBeNull()
  })
})
