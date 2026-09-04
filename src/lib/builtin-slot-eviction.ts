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
 * `config.managed === true`, und managed ist jetzt false. Also raeumt dieses
 * Modul die Wahl, der Waehler sagt wieder "Select Model", und wer den Wechsel
 * nicht selbst im Waehler ausgeloest hat, liest eine Zeile darueber.
 */

import { backendCall, isTauri } from '../api/backend'
import { isBuiltinEngineEntry, type InstalledModelLike } from './lmstudio-match'
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
 * Steckplatz zurueck, ist die Wahl genau das Modell, das `bringEngineBack`
 * gleich laedt, und wer sie dort raeumt, laesst die zurueckgeholte Engine
 * ohne Modell stehen.
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
      void bringEngineBack()
    }
    return
  }
  if (builtinSlotHandedToForeignBackend(before, after)) void dropDisplacedEnginePick(after?.name)
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
    const { ensureBuiltinEngineAlive, builtinSlotSwitchedOff } = await import('../api/builtin-ensure')
    // Der Nutzer hat die Engine in den Einstellungen ausgeschaltet. Der
    // Steckplatz gehoert ihr wieder, aber niemand hat sie zurueckgebeten.
    if (builtinSlotSwitchedOff()) return
    await ensureBuiltinEngineAlive(gewaehlt)
    log.info('[builtin-slot] engine has the local slot again, brought it back')
  } catch (e) {
    // Kein Grund, den Steckplatzwechsel scheitern zu lassen. Der Absendeweg
    // versucht dasselbe noch einmal, sobald jemand etwas schreibt.
    log.warn('[builtin-slot] could not bring the engine back', { err: e })
  }
}

/**
 * Die Wahl faellt mit dem Steckplatz, und der Nutzer erfaehrt es.
 *
 * Der Chip im Chat nennt nach der Uebergabe weiter das GGUF, das auf 8127
 * lag. Auf dem Port liegt nichts mehr, und die Selbstheilung des Absendewegs
 * haengt hinter `config.managed === true`, das jetzt false ist. Bleibt die
 * Wahl stehen, ist die einzige Antwort auf ein Absenden eine Fremdmeldung
 * ueber eine unbekannte Modell-Kennung. Steht sie nicht mehr, sagt der Waehler
 * wieder "Select Model".
 *
 * Entschieden wird nach der ZEILE, nicht nach dem Steckplatz, und gelesen wird
 * sie erst hinter dem ersten `await import(...)`, also mindestens eine
 * Mikrotask nach dem Steckplatzwechsel. Das deckt genau EINEN der beiden
 * Klickwege ab, nicht den Aufrufer im Allgemeinen:
 * `useModels.activateModel` gibt den Steckplatz ab und setzt die Zeile des
 * uebernehmenden Backends ohne `await` unmittelbar danach, dort findet diese
 * Funktion also eine fremde Zeile vor, die sie nichts angeht. Der zweite Weg,
 * die Auto-Ladung im Waehler, laedt das Modell erst in LM Studio und setzt die
 * Wahl erst hinterher, auf der Box 12,4 s spaeter. Dort faellt die Wahl also
 * wirklich, und der Waehler steht bis zum Ende der Ladung auf "Select Model".
 * Das ist richtig so: bis dahin bedient wirklich niemand das GGUF.
 *
 * GESAGT wird es aber nur auf dem einen Weg. Wer in den Einstellungen Enable
 * auf der Standby-Karte drueckt, sieht seinen Chip wechseln, ohne den Waehler
 * angefasst zu haben, und bekam bisher kein Wort dazu: `activeModel` ist nach
 * dem Raeumen null, und `replacedBehindTheUsersBack` (lib/active-model-mode)
 * verlangt einen vorherigen Namen, den es dann nicht mehr gibt. Wer dagegen
 * selbst eine Zeile des wartenden Backends angeklickt hat, liest die
 * Wechselzeile ueber genau diesen Vorgang schon; ein zweiter Satz wuerde sie
 * nur verdraengen. `handbackAwaitsTheUsersPick` trennt die beiden.
 *
 * Der dynamische Import ist derselbe Ladekreis-Schutz, den auch
 * `bringEngineBack` braucht: der providerStore zeigt auf dieses Modul.
 *
 * Geraeumt wird mit `setState`, NICHT ueber `setActiveModel`: an dessen Weg
 * weg von einer Engine-Zeile haengt ein sofortiges `stop_bundled_engine`, und
 * das wuerde die Nachsicht ueberholen, die dieses Modul selbst verwaltet.
 */
async function dropDisplacedEnginePick(uebernehmer: string | undefined): Promise<void> {
  try {
    const { useModelStore } = await import('../stores/modelStore')
    const gewaehlt = useModelStore.getState().activeModel
    if (!gewaehlt) return
    const zeile = useModelStore.getState().models.find((m) => m.name === gewaehlt)
    if (!isBuiltinEngineEntry(zeile as unknown as InstalledModelLike | undefined)) return
    // Zuerst raeumen, dann reden. Die Ansage haengt an einem zweiten
    // dynamischen Import, und was danach kommt, darf das Raeumen weder
    // verzoegern noch mit sich reissen, wenn es scheitert.
    useModelStore.setState({ activeModel: null })
    log.info('[builtin-slot] engine lost the local slot, dropped the pick it was serving')
    void sagenDassDieWahlFiel(gewaehlt, uebernehmer)
  } catch (e) {
    // Wie beim Rueckweg: der Steckplatzwechsel selbst darf daran nicht
    // scheitern. Die naechste Modelliste prueft die Wahl ohnehin erneut.
    log.warn('[builtin-slot] could not drop the pick of the displaced engine', { err: e })
  }
}

/**
 * Die Zeile ueber die gefallene Wahl, aber nur an den, der sie nicht selbst
 * ausgeloest hat.
 *
 * `handbackAwaitsTheUsersPick` ist wahr, solange der Steckplatz noch auf die
 * Zeile wartet, die der Nutzer im Waehler angeklickt hat. Dann steht die
 * Wechselzeile ueber genau diesen Vorgang schon auf dem Schirm, und ein
 * zweiter Satz wuerde sie loeschen statt ergaenzen.
 */
async function sagenDassDieWahlFiel(gewaehlt: string, uebernehmer: string | undefined): Promise<void> {
  try {
    const { announceChatModelLostItsEngine, handbackAwaitsTheUsersPick } =
      await import('../api/lu-engine-switch')
    if (handbackAwaitsTheUsersPick()) return
    announceChatModelLostItsEngine(gewaehlt, uebernehmer)
  } catch (e) {
    log.warn('[builtin-slot] could not say that the pick fell with the slot', { err: e })
  }
}

/** Test-only: forget a pending unload so tests stay isolated. */
export function __resetBuiltinSlotOffloadForTests(): void {
  cancelPending()
  entladen = false
}
