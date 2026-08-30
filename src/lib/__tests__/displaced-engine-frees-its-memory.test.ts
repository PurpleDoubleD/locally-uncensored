/**
 * Nebenbefund 2 of the R12/R13 re-measure on the real 2.6.7 Windows build
 * (2026-08-30, ergebnis-r1213-nachmessung.md):
 *
 *   "Der eingebaute Motor laeuft weiter, waehrend ein fremder Anbieter den
 *    Slot haelt. Nach dem Anlegen von Jan blieb lu-llama-server.exe PID 7516
 *    am Leben, samt geladenem Modell im Speicher. Erst ein App-Neustart
 *    raeumt ihn weg: nach dem Neustart mit Jan im Slot startete gar kein
 *    lu-llama-server mehr. Kein Fehler, aber RAM und VRAM bleiben bis zum
 *    Neustart belegt, obwohl der Motor nichts mehr zu tun hat."
 *
 * The app already agreed the engine was finished: it does not start one at all
 * when Jan holds the slot at launch. Only the running one was never told.
 *
 * Round 7 answered the same question for the window's X (the model stayed in
 * VRAM after the window went to the tray) by routing the hide through
 * `offload_local_models`, the call the switch into Cloud mode makes, after a
 * grace period. This is that answer applied one door further along, with the
 * same call and the same grace period.
 *
 * Run: npx vitest run src/lib/__tests__/displaced-engine-frees-its-memory.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const backendCall = vi.fn(async (..._args: unknown[]) => ({}))
vi.mock('../../api/backend', () => ({
  backendCall: (...a: unknown[]) => backendCall(...a),
  isTauri: () => true,
}))

import {
  builtinHoldsLocalSlot,
  builtinSlotOffloadDecision,
  onLocalSlotChanged,
  __resetBuiltinSlotOffloadForTests,
  BUILTIN_SLOT_OFFLOAD_GRACE_MS,
} from '../builtin-slot-eviction'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const read = (rel: string) => readFileSync(resolve(repo, rel), 'utf8')

/** The shipped state: the app's own engine serving the shared local slot. */
const BUILTIN = { enabled: true, managed: true }
/** What Add Provider, entry Jan, writes over it. */
const JAN = { enabled: true, managed: false }

beforeEach(() => {
  vi.useFakeTimers()
  backendCall.mockClear()
  __resetBuiltinSlotOffloadForTests()
})
afterEach(() => {
  __resetBuiltinSlotOffloadForTests()
  vi.useRealTimers()
})

describe('THE FIX: the engine that loses the slot lets go of its model', () => {
  it('the measured press releases it instead of holding it until a restart', () => {
    onLocalSlotChanged(BUILTIN, JAN)
    expect(backendCall).not.toHaveBeenCalled() // grace period first
    vi.advanceTimersByTime(BUILTIN_SLOT_OFFLOAD_GRACE_MS)
    expect(backendCall).toHaveBeenCalledWith('offload_local_models', { includeComfyui: false })
  })

  it('it is the call the cloud switch makes, not a second mechanism', () => {
    const shell = read('src/components/layout/AppShell.tsx')
    expect(shell).toMatch(/backendCall\('offload_local_models'\)/)
    const evict = read('src/lib/builtin-slot-eviction.ts')
    expect(evict).toMatch(/backendCall\('offload_local_models', \{ includeComfyui: false \}\)/)
    // and it does NOT reach for a private unload path of its own
    expect(evict).not.toMatch(/stop_bundled_engine/)
  })

  it('the ComfyUI checkpoint is left alone, a chat slot is none of its business', () => {
    onLocalSlotChanged(BUILTIN, JAN)
    vi.advanceTimersByTime(BUILTIN_SLOT_OFFLOAD_GRACE_MS)
    expect(backendCall.mock.calls[0][1]).toEqual({ includeComfyui: false })
  })

  it('a user who swaps straight back pays nothing, the same grace round 7 built', () => {
    onLocalSlotChanged(BUILTIN, JAN)
    vi.advanceTimersByTime(BUILTIN_SLOT_OFFLOAD_GRACE_MS / 2)
    onLocalSlotChanged(JAN, BUILTIN) // Enable on the standby card
    vi.advanceTimersByTime(BUILTIN_SLOT_OFFLOAD_GRACE_MS * 2)
    expect(backendCall).not.toHaveBeenCalled()
  })

  it('and a second change cannot let an older timer fire under it', () => {
    onLocalSlotChanged(BUILTIN, JAN)
    vi.advanceTimersByTime(BUILTIN_SLOT_OFFLOAD_GRACE_MS - 1)
    onLocalSlotChanged(JAN, BUILTIN)
    onLocalSlotChanged(BUILTIN, JAN)
    vi.advanceTimersByTime(2) // the FIRST timer's moment has come and gone
    expect(backendCall).not.toHaveBeenCalled()
    vi.advanceTimersByTime(BUILTIN_SLOT_OFFLOAD_GRACE_MS)
    expect(backendCall).toHaveBeenCalledTimes(1)
  })

  it('Disable on the engine itself frees it too, it is the same loss of the slot', () => {
    onLocalSlotChanged(BUILTIN, { enabled: false, managed: true })
    vi.advanceTimersByTime(BUILTIN_SLOT_OFFLOAD_GRACE_MS)
    expect(backendCall).toHaveBeenCalledWith('offload_local_models', { includeComfyui: false })
  })

  it('the wiring: every write to the shared slot asks the question, once', () => {
    const store = read('src/stores/providerStore.ts')
    expect(store).toMatch(/import \{ onLocalSlotChanged \} from '\.\.\/lib\/builtin-slot-eviction'/)
    expect(store).toMatch(/if \(id === 'openai'\) onLocalSlotChanged\(before, get\(\)\.providers\.openai\)/)
    // resetProvidersToDefaults writes the slot without going through setProviderConfig
    expect(store).toMatch(/onLocalSlotChanged\(before, get\(\)\.providers\.openai\)\n\s*\},/)
  })
})

describe('NEGATIVE CONTROL: nobody else loses their model over this', () => {
  it('a takeover between two FOREIGN backends frees nothing', () => {
    // Jan replaced by LM Studio: no lu-llama-server was running, and evicting
    // the user's Ollama residents for it would be a fresh bug, not a fix.
    onLocalSlotChanged(JAN, { enabled: true, managed: false })
    vi.advanceTimersByTime(BUILTIN_SLOT_OFFLOAD_GRACE_MS * 2)
    expect(backendCall).not.toHaveBeenCalled()
  })

  it('an unrelated edit on the slot the engine still holds frees nothing', () => {
    // Endpoint typed, API key saved, Test pressed: the engine keeps the slot.
    onLocalSlotChanged(BUILTIN, BUILTIN)
    vi.advanceTimersByTime(BUILTIN_SLOT_OFFLOAD_GRACE_MS * 2)
    expect(backendCall).not.toHaveBeenCalled()
  })

  it('handing the slot BACK to the engine never unloads it', () => {
    onLocalSlotChanged(JAN, BUILTIN)
    vi.advanceTimersByTime(BUILTIN_SLOT_OFFLOAD_GRACE_MS * 2)
    expect(backendCall).not.toHaveBeenCalled()
  })

  it('the rule itself, read without a timer', () => {
    expect(builtinHoldsLocalSlot(BUILTIN)).toBe(true)
    expect(builtinHoldsLocalSlot(JAN)).toBe(false)
    expect(builtinHoldsLocalSlot({ enabled: false, managed: true })).toBe(false)
    expect(builtinHoldsLocalSlot(null)).toBe(false)

    expect(builtinSlotOffloadDecision(BUILTIN, JAN)).toBe('schedule')
    expect(builtinSlotOffloadDecision(JAN, BUILTIN)).toBe('cancel')
    expect(builtinSlotOffloadDecision(BUILTIN, BUILTIN)).toBe('cancel')
    expect(builtinSlotOffloadDecision(JAN, JAN)).toBe('none')
  })

  it('the grace period is a real wait and not a coffee break', () => {
    // Same bracket round 7 put on HIDE_OFFLOAD_GRACE: a zero would unload on
    // every stray click, a very long one would keep the finding alive.
    expect(BUILTIN_SLOT_OFFLOAD_GRACE_MS).toBeGreaterThanOrEqual(5_000)
    expect(BUILTIN_SLOT_OFFLOAD_GRACE_MS).toBeLessThanOrEqual(120_000)
  })

  it('the engine still comes back by itself, so nothing was thrown away', () => {
    // The lazy reload this leans on is the one a Create render already leans
    // on, and it predates this change.
    const ensure = read('src/api/builtin-ensure.ts')
    expect(ensure).toMatch(/offload_local_models/)
    expect(ensure).toMatch(/export async function ensureBuiltinEngineAlive/)
  })

  it('round 7 keeps its own wiring on the window X', () => {
    const main = read('src-tauri/src/main.rs')
    expect(main).toMatch(/offload_local_models_blocking\(&state, Some\(true\)\)/)
    expect(main).toMatch(/should_offload_after_hide/)
  })

  it('no em dash in the new copy', () => {
    expect(read('src/lib/builtin-slot-eviction.ts')).not.toMatch(/[–—]/)
  })
})
