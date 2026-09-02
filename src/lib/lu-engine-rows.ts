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

import { isSameGgufFile, isLmStudioEntry, isBuiltinEngineEntry, type InstalledModelLike } from './lmstudio-match'

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
 * A14 review: this asks `isSameGgufFile`, not the Discover badge's matcher.
 * That one answers a catalogue question and treats a name without a quant as
 * "any quant will do", so a quant-less GGUF in the LU Engine folder would have
 * been swallowed by whatever quant LM Studio happened to hold. The two files
 * differ; only one of them is on the user's disk twice. No quant on either
 * side means no match here, so the row stays.
 */
export function dropDuplicateLuEngineRows<T extends InstalledModelLike>(
  bundled: T[],
  alreadyListed: InstalledModelLike[],
): T[] {
  if (bundled.length === 0) return bundled
  const lmStudio = alreadyListed.filter(isLmStudioEntry)
  if (lmStudio.length === 0) return bundled
  return bundled.filter((row) => !lmStudio.some((other) => sameFile(row, other)))
}

/** Every id a row can be recognised by. LM Studio reports its own key, our own
 *  rows carry the file stem, and both may carry a full path. */
function idsOf(m: InstalledModelLike): string[] {
  const raw = m as InstalledModelLike & { path?: unknown }
  return [m.model, m.name, m.lmsKey, typeof raw.path === 'string' ? raw.path : undefined]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
}

/** Two rows pointing at one file on disk. */
function sameFile(a: InstalledModelLike, b: InstalledModelLike): boolean {
  const idsA = idsOf(a)
  const idsB = idsOf(b)
  // The same path is the same file, whatever the two sides call the model.
  for (const x of idsA) {
    for (const y of idsB) {
      if (x === y) return true
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
