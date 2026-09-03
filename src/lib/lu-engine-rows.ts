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
  isSameGgufFile, isLmStudioEntry, isBuiltinEngineEntry, modelIdentity, extractQuant,
  type InstalledModelLike,
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
  return standby.filter((row) => !luEngine.some((ours) => sameFile(ours, row, ownByIdentity)))
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

/** Two rows pointing at one file on disk. */
function sameFile(
  ours: InstalledModelLike,
  other: InstalledModelLike,
  ownByIdentity: Map<string, number>,
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

  // Route 3: neither side names a quant and we hold exactly one such file.
  // Our own quant, where we have one, is evidence and not noise: a collapsed
  // LM Studio row could be any quant at any path, so it cannot be shown to be
  // our Q8_0. Route 2 above is the way that case is settled honestly.
  if (sameModel && !namesAQuant(other) && !namesAQuant(ours) && ownByIdentity.get(ourIdentity) === 1) return true

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
 * The LU Engine rows and everything else, kept apart.
 *
 * Order within each half is left exactly as it came in: the list is built in a
 * deliberate order upstream and this is a split, not a sort.
 */
export function splitLuEngineRows<T extends InstalledModelLike>(models: T[]): { luEngine: T[]; rest: T[] } {
  const luEngine: T[] = []
  const rest: T[] = []
  for (const m of models) (isBuiltinEngineEntry(m) ? luEngine : rest).push(m)
  return { luEngine, rest }
}

/** One heading and the rows under it. */
export interface ProviderGroup<T> {
  label: string
  models: T[]
}

/**
 * Must the LU Engine heading be drawn even though there is only one group.
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
export function needsLuEngineHeading(labels: string[], luEngineHoldsChat: boolean): boolean {
  if (labels.length > 1) return true
  return !luEngineHoldsChat && labels.includes(LU_ENGINE_GROUP)
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
