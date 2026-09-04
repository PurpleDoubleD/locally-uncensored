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
 *
 * UND DIE WAHL FAELLT MIT. Der Speicher war nur die eine Haelfte: nach der
 * Uebergabe an ein fremdes Backend steht der Chip im Chat weiter auf dem
 * GGUF, das auf 8127 lag, und behauptet damit, ein Modell werde antworten,
 * das nichts mehr bedient. Ausgerechnet hier faellt auch die Selbstheilung
 * des Absendewegs aus: der ruft `ensureBuiltinEngineAlive` nur hinter
 * `config.managed === true`, und managed ist jetzt false. Also faellt die Wahl,
 * der Waehler sagt wieder "Select Model", und wer den Wechsel nicht selbst im
 * Waehler ausgeloest hat, liest eine Zeile darueber.
 *
 * GETAN wird das alles nicht hier. Dieses Modul kennt den Steckplatz und sonst
 * nichts; es sagt an, und wer reagieren muss, hat sich angemeldet. Die Leitung
 * steht in lib/builtin-slot-handover.ts, samt der Messung, die sie erzwungen
 * hat: die drei `await import(...)`, die hier standen, waren alle fuenf Kreise,
 * die `npm run cycles` gemeldet hat.
 */

import { backendCall, isTauri } from '../api/backend'
import {
  announceBuiltinSlotLostToForeignBackend,
  announceBuiltinSlotRegained,
} from './builtin-slot-handover'
import { log } from './logger'

/** The part of the `openai` slot this decision reads. */
export interface BuiltinSlotView {
  enabled: boolean
  /** True only for the app's own bundled llama.cpp engine. */
  managed?: boolean
  /** Der Anzeigename des Backends, das den Steckplatz haelt. Fuer die
   *  Entscheidung selbst bedeutungslos, aber die Zeile, die der Nutzer danach
   *  liest, nennt den, der uebernommen hat. */
  name?: string
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

/**
 * Hat unsere Engine den Steckplatz an ein EINGESCHALTETES fremdes Backend
 * abgegeben.
 *
 * Enger als 'schedule', und die Enge ist der Punkt. Das schlichte Disable auf
 * der eigenen Engine bleibt draussen (`managed` bleibt true): dafuer gibt es
 * die Ein-Aus-Invariante im providerStore und den ehrlichen Satz aus
 * `builtin-ensure`. Und die Gegenrichtung ist strukturell ausgeschlossen,
 * weil sie 'cancel' ist und diesen Zweig nie erreicht: nimmt die Engine den
 * Steckplatz zurueck, ist die Wahl genau das Modell, das der Rueckweg im
 * Modell-Store gleich laedt, und wer sie dort raeumt, laesst die
 * zurueckgeholte Engine ohne Modell stehen.
 *
 * Pur, damit die Regel ohne Zeitgeber und ohne Store zu lesen ist.
 */
export function builtinSlotHandedToForeignBackend(
  before: BuiltinSlotView | null | undefined,
  after: BuiltinSlotView | null | undefined,
): boolean {
  if (!builtinHoldsLocalSlot(before)) return false
  return !!after && after.enabled === true && after.managed !== true
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
      // Ausserhalb des Desktop-Builds gibt es keine Engine zurueckzuholen. Die
      // Pruefung stand vorher im Rumpf des Rueckwegs; sie gehoert hierher, weil
      // der Zuhoerer im Modell-Store nicht wissen muss, auf welcher Plattform
      // er laeuft.
      if (isTauri()) announceBuiltinSlotRegained()
    }
    return
  }
  if (builtinSlotHandedToForeignBackend(before, after)) {
    announceBuiltinSlotLostToForeignBackend(after?.name)
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

/** Test-only: forget a pending unload so tests stay isolated. */
export function __resetBuiltinSlotOffloadForTests(): void {
  cancelPending()
  entladen = false
}
