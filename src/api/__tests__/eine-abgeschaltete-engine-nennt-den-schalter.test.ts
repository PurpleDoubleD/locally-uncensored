/**
 * Der Fehlfund aus dem Persona-Lauf P1 am 04.09.2026, Build 4.
 *
 * Der Tester hat die LU Engine in Settings, AI Backends ueber Disable
 * abgeschaltet und danach im Chat etwas abgeschickt. Was er las:
 *
 *   The connection dropped before the model finished its answer.
 *   Check your network and try again.
 *
 * Sein Netz war in Ordnung. Er hatte den Anbieter selbst ausgeschaltet, und
 * der Satz schickte ihn in die falsche Richtung.
 *
 * Zwei Loecher fuehrten dahin, dieses hier ist das obere: `isManagedBuiltinSlot`
 * gibt bei einem abgeschalteten Steckplatz false zurueck, und
 * `ensureBuiltinEngineAlive` ist dann still ausgestiegen. Die Anfrage lief in
 * den toten Port, und was danach passierte, entschied ein Wettlauf im Proxy
 * (siehe `the_marker_ends_an_answer_and_never_hides_a_failure` in proxy.rs).
 *
 * Lauf: npx vitest run src/api/__tests__/eine-abgeschaltete-engine-nennt-den-schalter.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return { ...actual, backendCall: vi.fn() }
})

import {
  BUILTIN_SLOT_OFF_MESSAGE,
  builtinSlotSwitchedOff,
  ensureBuiltinEngineAlive,
  isManagedBuiltinSlot,
} from '../builtin-ensure'
import { backendCall } from '../backend'
import { useProviderStore } from '../../stores/providerStore'

const setzeSteckplatz = (patch: { enabled: boolean; managed: boolean }) => {
  useProviderStore.setState((s) => ({
    providers: {
      ...s.providers,
      openai: { ...s.providers.openai, ...patch, baseUrl: 'http://127.0.0.1:8127/v1' },
    },
  }))
}

beforeEach(() => {
  vi.mocked(backendCall).mockReset()
})

describe('builtinSlotSwitchedOff', () => {
  it('trennt die zwei Faelle, die isManagedBuiltinSlot in einen Topf wirft', () => {
    setzeSteckplatz({ enabled: false, managed: true })
    expect(isManagedBuiltinSlot()).toBe(false)
    expect(builtinSlotSwitchedOff()).toBe(true)

    setzeSteckplatz({ enabled: true, managed: false })
    expect(isManagedBuiltinSlot()).toBe(false)
    expect(builtinSlotSwitchedOff()).toBe(false)
  })

  it('ist falsch, solange die Engine laeuft', () => {
    setzeSteckplatz({ enabled: true, managed: true })
    expect(builtinSlotSwitchedOff()).toBe(false)
  })
})

describe('ensureBuiltinEngineAlive bei abgeschaltetem Steckplatz', () => {
  it('sagt, dass der Schalter aus ist, statt in den toten Port zu senden', async () => {
    setzeSteckplatz({ enabled: false, managed: true })
    await expect(ensureBuiltinEngineAlive('openai::Hermes-3-Llama-3.2-3B.Q4_K_M'))
      .rejects.toThrow(BUILTIN_SLOT_OFF_MESSAGE)
    // Und zwar OHNE das Rust-Backend zu fragen: der Zustand steht schon fest.
    expect(vi.mocked(backendCall)).not.toHaveBeenCalled()
  })

  it('nennt den Weg zurueck und redet nicht vom Netz', async () => {
    setzeSteckplatz({ enabled: false, managed: true })
    const fehler = await ensureBuiltinEngineAlive('openai::egal').then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(fehler).toBeInstanceOf(Error)
    expect(fehler!.message).toMatch(/Settings, AI Backends/)
    expect(fehler!.message).not.toMatch(/network/i)
    expect(fehler!.message).not.toMatch(/connection dropped/i)
  })

  it('laesst einen fremden Steckplatz weiter in Ruhe', async () => {
    setzeSteckplatz({ enabled: true, managed: false })
    await expect(ensureBuiltinEngineAlive('openai::gpt-4o')).resolves.toBeUndefined()
    expect(vi.mocked(backendCall)).not.toHaveBeenCalled()
  })
})
