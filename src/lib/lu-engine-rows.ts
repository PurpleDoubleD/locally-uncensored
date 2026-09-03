/**
 * The GGUFs in the LU Engine folder as rows in the model list.
 *
 * A14 (2.6.8), David, seen on a Mac with Ollama as the chat backend and
 * ~/lu-e2e-models holding Qwen2.5-0.5B-Instruct-Q8_0.gguf: Model Storage
 * promises "LU downloads GGUFs here and reads every .gguf in it", and the file
 * never appeared anywhere. `useModels` asked `list_bundled_models` only while
 * the LU Engine was the active provider, so on that machine the promise was
 * true about the disk and false about the screen.
 *
 * The listing is unconditional now, which raises two questions this module
 * answers, both without a browser:
 *
 *  1. the same file can be known twice. Set the LU Engine folder to
 *     ~/.lmstudio/models and LM Studio lists the model over its own API while
 *     the folder walk finds the file. One model, two rows, two different ways
 *     to run it, and no way for the user to tell which is which.
 *  2. picking an LU Engine row while another backend holds the chat has a
 *     consequence, so those rows are set apart under their own heading instead
 *     of blending into the list.
 */

import {
  isSameGgufFile, isLmStudioEntry, isBuiltinEngineEntry, isRowOfBackend, modelIdentity,
  extractQuant, type InstalledModelLike,
} from './lmstudio-match'

/** The heading LU Engine rows sit under, in Installed and in the picker. */
export const LU_ENGINE_GROUP = 'LU Engine'

/**
 * LU Engine rows the active provider already lists, removed.
 *
 * Precedence goes to the provider that is actually serving the chat, for the
 * plain reason that its row is the one that works right now: picking it starts
 * nothing and switches nothing. The LU Engine row for the same file would take
 * the chat away from the active backend to reach a model the user can already
 * have, which is a trade nobody asked for.
 *
 * Only LM Studio can collide. Ollama keeps its models in its own blob store
 * under its own names, so an Ollama row and a GGUF on disk are two copies of
 * the model and not two views of one file, and collapsing them would hide a
 * real second copy.
 *
 * A14 review: this does NOT ask the Discover badge's matcher. That one answers
 * a catalogue question and treats a name without a quant as "any quant will
 * do", so a quant-less GGUF in the LU Engine folder would have been swallowed
 * by whatever quant LM Studio happened to hold. Two files, one of them hidden.
 *
 * A14 second review: the strict rule alone was too strict for the commonest
 * case. LM Studio reports a COLLAPSED id with no quant at all
 * ("qwen/qwen2.5-0.5b-instruct") whenever it holds exactly one quant of a
 * model, which is most of the time, and that met neither half of the strict
 * rule. So there are three ways in, in falling order of certainty:
 *
 *   1. the same path. Same file, whatever the two sides call it.
 *   2. our file lies inside LM Studio's own store, which is what happens the
 *      moment the folder is pointed at ~/.lmstudio/models. Then it IS LM
 *      Studio's file and the model identity is enough.
 *   3. NEITHER side names a quant and we hold exactly ONE file of that
 *      identity. One nameless file and one nameless row can only be each
 *      other. Two files of the same identity and a nameless row cannot be told
 *      apart, so nothing is dropped and the user keeps both.
 *
 * A14 third review: route 3 used to ask only whether LM STUDIO named a quant,
 * so a Q8_0 of our own went away behind a collapsed row that may well have
 * been a Q4_K_M somewhere else entirely. That is the "two files, one of them
 * hidden" the paragraph above forbids, arrived at from the other side, and it
 * hit the exact machine this change is about: ~/lu-e2e-models holding
 * Qwen2.5-0.5B-Instruct-Q8_0.gguf. Our own quant is knowledge, and a route
 * that throws knowledge away to reach a guess is not a route. The case where
 * the collapsed row really is our file is covered by route 2, which proves it
 * from the path instead of guessing it from the name.
 *
 * A14 fourth review, how far route 2 reaches: it recognises LM Studio's store
 * by the two folders LM Studio itself ships with, ~/.lmstudio/models and
 * ~/.cache/lm-studio/models (see livesInLmStudioStore below). A user who moved
 * his LM Studio library somewhere else and then pointed the LU Engine folder
 * at that same place gets neither route 1 (LM Studio's API reports its own key
 * and no path) nor route 2, so the file stands twice in the list. That is the
 * accepted outcome and not an oversight: a visible duplicate costs the user
 * one confused look, while widening the rule to catch it would mean guessing
 * from names again, and a wrong guess hides a file he owns. Visible duplicate
 * beats hidden file.
 */
export function dropDuplicateLuEngineRows<T extends InstalledModelLike>(
  bundled: T[],
  alreadyListed: InstalledModelLike[],
): T[] {
  if (bundled.length === 0) return bundled
  const lmStudio = alreadyListed.filter(isLmStudioEntry)
  if (lmStudio.length === 0) return bundled
  // How many of OUR files share each identity. Route 3 only applies where the
  // answer is exactly one.
  const ownByIdentity = new Map<string, number>()
  for (const row of bundled) {
    const id = identityOf(row)
    if (id) ownByIdentity.set(id, (ownByIdentity.get(id) ?? 0) + 1)
  }
  return bundled.filter((row) => !lmStudio.some((other) => sameFile(row, other, ownByIdentity)))
}

/**
 * The other direction: standby rows the LU Engine is already serving, removed.
 *
 * A16 counter-check 02.09.: the standby listing (`listStandbyBackendModels`)
 * pushed LM Studio's rows into the same array that is then handed to
 * `dropDuplicateLuEngineRows` as "already listed". So the row that IS serving
 * the chat was measured against a row that is merely waiting beside the slot,
 * and lost: bundled `Qwen2.5-0.5B-Instruct-Q4_K_M` against standby
 * `qwen2.5-0.5b-instruct@q4_k_m` left zero rows. What stayed on screen was the
 * standby row, whose click hands the slot away and stops the engine that was
 * answering a second ago.
 *
 * The rule at the top of this file is unchanged and this is it, applied the
 * right way round: precedence goes to the provider that holds the slot. While
 * the LU Engine holds it, its row is the one that works right now, so the
 * standby twin is the one that goes. Same identity logic, same three routes,
 * only the roles swapped, which is why it reads the same `sameFile` and not a
 * second copy of it.
 *
 * `alreadyListed` is the whole list; the LU Engine rows are picked out of it
 * here, exactly as `dropDuplicateLuEngineRows` picks out the LM Studio ones.
 *
 * A17 counter-check 03.09., the asymmetry route 3 has and did not use: the
 * three routes were the same in both directions, and route 3 asked that
 * NEITHER side name a quant. On the Windows box that left
 *
 *     mlabonne_gemma-3-4b-it-abliterated-Q4_K_M   LU Engine
 *     mlabonne_gemma-3-4b-it-abliterated          LM Studio, standby, OFF
 *
 * standing side by side, one file of 2 489 894 304 bytes under two names. The
 * Qwen pair beside it collapsed only because LM Studio happened to spell
 * "@q4_k_m" there.
 *
 * "Our own quant is evidence" was written for the other direction, where the
 * row that goes is OUR row and its file would then be reachable nowhere. Here
 * the row that goes is a standby row: it hides no file, LM Studio stays
 * reachable through every other row it has, and the backend holding the slot
 * is the one whose row works right now. So in this direction route 3 asks only
 * what it can actually answer, the count. One file of that identity on our
 * side and one nameless row on the other can only be each other. Two quants of
 * ours and a nameless row cannot be told apart, and then the standby row
 * stays, exactly as before.
 *
 * A fourth route on file size was considered and left out rather than written
 * blind. A standby row is built by `cloudModelRow` out of a `ProviderModel`,
 * and neither carries a size: every one of them is `size: 0`. A byte
 * comparison would therefore never fire on a real pair, and worse, "same size"
 * would be true of every standby row against every other, because they all
 * carry the same zero. The day the standby listing learns a real size is the
 * day that route is worth writing.
 */
export function dropStandbyRowsServedByLuEngine<T extends InstalledModelLike>(
  standby: T[],
  alreadyListed: InstalledModelLike[],
): T[] {
  if (standby.length === 0) return standby
  const luEngine = alreadyListed.filter(isBuiltinEngineEntry)
  if (luEngine.length === 0) return standby
  // How many of OUR files share each identity, counted over the LU Engine rows
  // because those are "ours" in this direction. Route 3 only applies at one.
  const ownByIdentity = new Map<string, number>()
  for (const row of luEngine) {
    const id = identityOf(row)
    if (id) ownByIdentity.set(id, (ownByIdentity.get(id) ?? 0) + 1)
  }
  return standby.filter((row) => !luEngine.some((ours) => sameFile(ours, row, ownByIdentity, true)))
}

/** Every id a row can be recognised by. LM Studio reports its own key, our own
 *  rows carry the file stem, and ours also carry the path. */
function idsOf(m: InstalledModelLike): string[] {
  const raw = m as InstalledModelLike & { path?: unknown }
  return [m.model, m.name, m.lmsKey, typeof raw.path === 'string' ? raw.path : undefined]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
}

/** The path a row names, or ''. */
function pathOf(m: InstalledModelLike): string {
  const raw = m as InstalledModelLike & { path?: unknown }
  return typeof raw.path === 'string' ? raw.path : ''
}

/** Trailing separators and the Windows/POSIX split are not a different file. */
function normalisePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** The model identity a row is about, from whichever id carries one. */
function identityOf(m: InstalledModelLike): string {
  for (const id of idsOf(m)) {
    const identity = modelIdentity(id)
    if (identity && identity.length >= 5) return identity
  }
  return ''
}

/** Does this row's file lie inside LM Studio's own model store.
 *
 *  The two default locations only. A relocated library is not recognised here
 *  and is not meant to be: see the fourth-review paragraph on the function
 *  above for why a duplicate row is the better half of that trade. */
function livesInLmStudioStore(m: InstalledModelLike): boolean {
  const p = normalisePath(pathOf(m))
  if (!p) return false
  return p.includes('/.lmstudio/models/') || p.includes('/.cache/lm-studio/models/')
}

/** Does any of this row's ids name a quant. */
function namesAQuant(m: InstalledModelLike): boolean {
  return idsOf(m).some((id) => extractQuant(id) !== null)
}

/**
 * Two rows pointing at one file on disk.
 *
 * `otherHidesNoFile` is the one asymmetry between the two directions, and it
 * only touches route 3. See the paragraph on
 * `dropStandbyRowsServedByLuEngine` for why the same evidence is worth
 * different things depending on which row would disappear.
 */
function sameFile(
  ours: InstalledModelLike,
  other: InstalledModelLike,
  ownByIdentity: Map<string, number>,
  otherHidesNoFile = false,
): boolean {
  // Route 1: the same path, spelled either way round.
  const ourPath = normalisePath(pathOf(ours))
  const otherPath = normalisePath(pathOf(other))
  if (ourPath && ourPath === otherPath) return true

  const ourIdentity = identityOf(ours)
  const otherIdentity = identityOf(other)
  const sameModel = !!ourIdentity && ourIdentity === otherIdentity

  // Route 2: our file IS in LM Studio's store, so the identity settles it.
  if (sameModel && livesInLmStudioStore(ours)) return true

  // Route 3: the other side names no quant and we hold exactly one file of
  // that identity.
  //
  // Whether OUR quant has to be missing too is the asymmetry. Where dropping
  // the row would hide a file (the LU Engine direction), our own quant is
  // evidence and not noise: a collapsed LM Studio row could be any quant at
  // any path, so it cannot be shown to be our Q8_0, and route 2 is the honest
  // way that case is settled. Where dropping the row hides nothing (the
  // standby direction), the count is the whole question: one file of that
  // identity on our side and one nameless row on the other can only be each
  // other, and our quant says nothing against it.
  if (sameModel && !namesAQuant(other) && (otherHidesNoFile || !namesAQuant(ours))
      && ownByIdentity.get(ourIdentity) === 1) return true

  // Otherwise the strict rule: same filename, or the same quant named on both
  // sides. A missing quant on either side is not evidence.
  for (const x of idsOf(ours)) {
    for (const y of idsOf(other)) {
      if (isSameGgufFile(x, y)) return true
    }
  }
  return false
}

/**
 * Die Zeilen, deren Wahl das lokale Chat-Backend WECHSELT, und der Rest.
 *
 * Es ist immer genau eine Sorte, und welche, haengt daran, wer den Steckplatz
 * gerade haelt:
 *
 *  - Ein fremdes Backend bedient den Chat: dann sind es unsere eigenen
 *    GGUF-Zeilen. Ein Klick darauf holt den Chat zur LU Engine.
 *  - Die LU Engine bedient den Chat: dann sind es die Zeilen des Backends, das
 *    daneben wartet. Ein Klick darauf gibt ihm den Steckplatz zurueck.
 *
 * Bis 2.6.8 stand hier nur die erste Haelfte, und die zweite fehlte still: die
 * Release-Notiz versprach „a running LM Studio ... its models keep their own
 * heading in the list", die Kommentare in api/lu-engine-switch.ts beschrieben
 * denselben Weg zurueck, und im Waehler standen die LM-Studio-Zeilen ohne
 * Ueberschrift zwischen den Modellfamilien (Persona 2 am 03.09.2026, Punkt 9).
 * Die Ueberschrift ist keine Zierde, sie ist die Warnung vor der Folge, und
 * die Folge gibt es in beide Richtungen.
 *
 * `standbyName` ist der Anzeigename des wartenden Backends oder null. Die
 * Reihenfolge innerhalb beider Haelften bleibt, wie sie ankam: das ist eine
 * Teilung, keine Sortierung.
 */
export function splitBackendSwitchRows<T extends InstalledModelLike>(
  models: T[],
  luEngineHoldsChat: boolean,
  standbyName: string | null,
  /**
   * Der Name des fremden lokalen Backends, das den Steckplatz gerade HAELT,
   * oder null, wenn unsere Engine ihn haelt.
   *
   * Persona P5, 03./04.09.2026: solange LM Studio den Chat bediente,
   * verteilten sich seine sieben Zeilen auf QWEN und OTHER und waren nur noch
   * am kleinen Abzeichen am Zeilenende zu unterscheiden. Genau in dem Moment,
   * in dem jemand IN LM Studio arbeitet, war das die unbrauchbarste
   * Sortierung.
   *
   * Familien sind eine Ordnung fuer UNSERE Dateien: sie kommen aus unserer
   * Benennung. Die Kennungen eines fremden Backends (`qwen/qwen3-4b`,
   * `qwen2.5-0.5b-instruct@q4_k_m`) tragen keine, und sie danach zu sortieren
   * ist Raten, das ein Backend ueber mehrere Ueberschriften streut. Also
   * behaelt ein fremdes Backend seinen Namen, egal auf welcher Seite des
   * Steckplatzes es gerade steht.
   */
  holderName: string | null = null,
): { label: string | null; switching: T[]; holderLabel: string | null; holding: T[]; rest: T[] } {
  const label = luEngineHoldsChat ? standbyName : LU_ENGINE_GROUP
  const gehoertDazu = luEngineHoldsChat
    ? (m: T) => isRowOfBackend(m, standbyName)
    : (m: T) => isBuiltinEngineEntry(m)
  // Der Halter bekommt nur dann eine eigene Ueberschrift, wenn er fremd ist.
  // Haelt unsere Engine den Platz, bleiben ihre GGUFs bei den Familien, denn
  // dort sagt die Ueberschrift etwas ueber die Datei.
  const halter = !luEngineHoldsChat && holderName ? holderName : null
  const holding: T[] = []
  const switching: T[] = []
  const rest: T[] = []
  for (const m of models) {
    if (label && gehoertDazu(m)) switching.push(m)
    else if (halter && isRowOfBackend(m, halter)) holding.push(m)
    else rest.push(m)
  }
  return { label: label ?? null, switching, holderLabel: halter, holding, rest }
}

/** One heading and the rows under it. */
export interface ProviderGroup<T> {
  label: string
  models: T[]
}

/**
 * Muss die Wechsel-Ueberschrift gezeichnet werden, obwohl es nur eine Gruppe
 * gibt. `switchLabel` ist die Ueberschrift der Zeilen, deren Wahl das Backend
 * wechselt, oder null, wenn es solche Zeilen gerade nicht gibt.
 *
 * A14 review 7: the render dropped every heading at one group, which is right
 * for a plain Ollama box and wrong for the exact machine this whole change is
 * about. Takes bare labels rather than groups so the Installed list and the
 * composer's picker, which group by different things, can ask the one rule
 * instead of each keeping a copy of it (second review). A user whose only local models are GGUFs in the LU Engine folder,
 * with Ollama or LM Studio in front and nothing of their own installed, saw
 * one unlabelled list and a click that moved his chat backend without a word
 * of warning. The heading is the warning, so it is drawn whenever a foreign
 * backend holds the chat, group count be damned.
 */
export function needsBackendSwitchHeading(labels: string[], switchLabel: string | null): boolean {
  if (labels.length > 1) return true
  return switchLabel !== null && labels.includes(switchLabel)
}

/**
 * Installed rows grouped by the backend that serves them, LU Engine first.
 *
 * First because it is the group whose rows carry a consequence: on a machine
 * where another backend holds the chat, using one of them moves the chat. A
 * heading the user reads before he clicks is the cheapest way to say that.
 *
 * Everything else keeps the order it arrived in. A row with no provider name
 * at all lands under "Other", which is better than an empty heading and better
 * than dropping the row.
 */
export function groupInstalledByProvider<T extends InstalledModelLike>(models: T[]): ProviderGroup<T>[] {
  const groups = new Map<string, T[]>()
  for (const m of models) {
    const label = isBuiltinEngineEntry(m) ? LU_ENGINE_GROUP : (m.providerName || '').trim() || 'Other'
    const bucket = groups.get(label)
    if (bucket) bucket.push(m)
    else groups.set(label, [m])
  }
  const out: ProviderGroup<T>[] = []
  const lu = groups.get(LU_ENGINE_GROUP)
  if (lu) out.push({ label: LU_ENGINE_GROUP, models: lu })
  for (const [label, rows] of groups) {
    if (label !== LU_ENGINE_GROUP) out.push({ label, models: rows })
  }
  return out
}
