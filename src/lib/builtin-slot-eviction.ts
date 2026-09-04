/**
 * What happens to the built-in engine's RAM and VRAM when it loses the shared
 * local slot.
 *
 * Nebenbefund 2 of the R12/R13 re-measure on the real 2.6.7 Windows build
 * (2026-08-30, ergebnis-r1213-nachmessung.md):
 *
 *   "Der eingebaute Motor laeuft weiter, waehrend ein fremder Anbieter den
 *    Slot haelt. Nach dem Anlegen von Jan blieb lu-llama-server.exe PID 7516
 *    am Leben, samt geladenem Modell im Speicher. Erst ein App-Neustart
 *    raeumt ihn weg: nach dem Neustart mit Jan im Slot startete gar kein
 *    lu-llama-server mehr."
 *
 * The same shape as round 7's close-to-tray finding, one door further along:
 * the app agrees the engine has nothing left to do, and the model sits in
 * memory anyway until the process is restarted. A short grace period so a
 * mis-click costs nothing, then the engine lets its model go.
 *
 * The trigger is narrow on purpose. Only a slot the app's OWN engine was
 * holding can leave a `lu-llama-server` behind, so only that transition fires:
 * LM Studio replacing Jan frees nothing of ours and must not evict anybody's
 * Ollama residents for nothing.
 *
 * WAS FREIGEGEBEN WIRD, ist seit der Gegenprobe G2 (04.09.2026) genau eine
 * Sache: die Chat-Engine. Vorher lief das ueber `offload_local_models`, die
 * Rundum-Freigabe, die auch der Wechsel in den Cloud-Modus benutzt, und die
 * raeumt Whisper, den Einbettungsserver auf 8128 und die geladenen
 * Ollama-Modelle gleich mit weg. Der Tester hat gemessen, was das heisst:
 * LM Studio als Provider hinzufuegen, und zwanzig Sekunden spaeter ist der
 * Einbettungsserver tot, der mit dem Chat-Steckplatz nichts zu tun hat, und
 * Document Chat arbeitet stumm nicht mehr. Der Steckplatzwechsel ist nicht
 * "die App hat nichts mehr zu tun", sondern "die Chat-Engine hat nichts mehr
 * zu tun", und `stop_bundled_engine` ist genau das.
 *
 * UND ZURUECK. Nimmt unsere Engine den Steckplatz wieder, kommt die Chat-
 * Engine wieder. Vorher hiess 'cancel' nur "eine noch nicht ausgefuehrte
 * Freigabe faellt aus"; war die Frist schon abgelaufen, geschah nichts, und
 * derselbe Tester stand nach Enable und Remove ohne Engine da, auch nach
 * dreimaligem Ansichtswechsel. Der Weg zurueck ist derselbe, den der
 * Absendeweg geht.
 */

import { backendCall, isTauri } from '../api/backend'
import { log } from './logger'

/** The part of the `openai` slot this decision reads. */
export interface BuiltinSlotView {
  enabled: boolean
  /** True only for the app's own bundled llama.cpp engine. */
  managed?: boolean
}

/**
 * Mis-click insurance, same idea and same length as round 7's
 * `HIDE_OFFLOAD_GRACE`: swap the slot away and straight back and nothing was
 * ever unloaded.
 */
export const BUILTIN_SLOT_OFFLOAD_GRACE_MS = 30_000

/** Is the app's own engine the backend serving the shared local slot. */
export function builtinHoldsLocalSlot(slot: BuiltinSlotView | null | undefined): boolean {
  return !!slot && slot.enabled === true && slot.managed === true
}

/**
 * What the slot change means for the engine's memory.
 *
 *  'schedule' the engine just lost the slot, start the grace timer
 *  'cancel'   it holds the slot again, a pending unload is void
 *  'none'     nothing about our engine changed
 *
 * Pure, so the rule can be read without a timer or a backend.
 */
export function builtinSlotOffloadDecision(
  before: BuiltinSlotView | null | undefined,
  after: BuiltinSlotView | null | undefined,
): 'schedule' | 'cancel' | 'none' {
  const had = builtinHoldsLocalSlot(before)
  const has = builtinHoldsLocalSlot(after)
  if (has) return 'cancel'
  return had ? 'schedule' : 'none'
}

// The pending unload. A generation counter rather than a bare handle for the
// same reason the Rust side keeps one: a timer whose grace period belongs to an
// older change must not fire under a newer one.
let pending: ReturnType<typeof setTimeout> | null = null
let generation = 0

/** Drop a pending unload without performing it. */
function cancelPending(): void {
  generation++
  if (pending !== null) {
    clearTimeout(pending)
    pending = null
  }
}

/**
 * Ist die Freigabe wirklich gelaufen, oder stand sie nur an.
 *
 * Der Unterschied entscheidet, was beim Zurueckgeben des Steckplatzes zu tun
 * ist: eine abgesagte Freigabe hinterlaesst eine laufende Engine, eine
 * ausgefuehrte hinterlaesst nichts.
 */
let entladen = false

/**
 * Wire the decision to the call. Safe to invoke on every write to the `openai`
 * slot: it does nothing unless the app's own engine actually lost the slot, and
 * nothing at all outside the desktop build.
 */
export function onLocalSlotChanged(
  before: BuiltinSlotView | null | undefined,
  after: BuiltinSlotView | null | undefined,
): void {
  const decision = builtinSlotOffloadDecision(before, after)
  if (decision === 'none') return
  if (decision === 'cancel') {
    cancelPending()
    if (entladen) {
      entladen = false
      void bringEngineBack()
    }
    return
  }
  if (!isTauri()) return
  cancelPending()
  const mine = generation
  pending = setTimeout(() => {
    if (mine !== generation) return
    pending = null
    backendCall('stop_bundled_engine')
      .then(() => {
        entladen = true
        log.info('[builtin-slot] engine lost the local slot, released its model')
      })
      .catch((e) => log.warn('[builtin-slot] could not release the displaced engine', { err: e }))
  }, BUILTIN_SLOT_OFFLOAD_GRACE_MS)
}

/**
 * Die Chat-Engine zurueckholen, nachdem der Steckplatz wieder unserer ist.
 *
 * Der Aufruf kommt spaet und dynamisch, weil `builtin-ensure` ueber den
 * providerStore auf dieses Modul zurueckzeigt. Ein fest verdrahteter Import
 * waere ein Ladekreis. `ensureBuiltinEngineAlive` ist genau der Weg, den auch
 * das Absenden einer Nachricht geht: Zustand fragen, Datei suchen, mit der
 * Feineinstellung des Nutzers starten.
 */
async function bringEngineBack(): Promise<void> {
  if (!isTauri()) return
  try {
    const { useModelStore } = await import('../stores/modelStore')
    const gewaehlt = useModelStore.getState().activeModel
    if (!gewaehlt) return
    const { ensureBuiltinEngineAlive } = await import('../api/builtin-ensure')
    await ensureBuiltinEngineAlive(gewaehlt)
    log.info('[builtin-slot] engine has the local slot again, brought it back')
  } catch (e) {
    // Kein Grund, den Steckplatzwechsel scheitern zu lassen. Der Absendeweg
    // versucht dasselbe noch einmal, sobald jemand etwas schreibt.
    log.warn('[builtin-slot] could not bring the engine back', { err: e })
  }
}

/** Test-only: forget a pending unload so tests stay isolated. */
export function __resetBuiltinSlotOffloadForTests(): void {
  cancelPending()
  entladen = false
}
