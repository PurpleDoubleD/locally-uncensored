// B24 (3.0.9, Discord .molot 28.10.2026): the LoRA picks belong to the task and
// the model they were made for. One list for every tab kept a video LoRA
// switched on after the change to Image, where it rode along into the run of
// another model. Each task + model now keeps its own picks: leaving it puts
// them aside, coming back brings them back, a lane never visited starts empty.

export type LoraPick = { name: string; strength: number }

/** How many lanes are remembered. The oldest one goes first. */
export const LORA_LANES_MAX = 40

/** The lane a store state is on: its task and the local model that runs it.
 *  Null while that model is not known yet (lists still loading), so a start
 *  of the app never files the saved picks under an empty name. */
export function loraLaneKey(intent: string, model: string): string | null {
  return model ? `${intent}|${model}` : null
}

/** The picks to put aside and the ones to bring back when the lane changes.
 *  Null when nothing changes: same lane, or a side that is not known yet.
 *  `explicit` is true when the change itself chose the picks (a trained
 *  style switched on with its tab), then those stay. */
export function switchLoraLane(
  before: { key: string | null; picks: LoraPick[] },
  after: { key: string | null; picks: LoraPick[] },
  lanes: Record<string, LoraPick[]>,
  explicit: boolean,
): { selectedLoras: LoraPick[]; loraLanes: Record<string, LoraPick[]> } | null {
  if (!before.key || !after.key || before.key === after.key) return null
  const { [before.key]: _old, ...rest } = lanes
  const own = before.picks.filter((p) => !isCharacterLoraName(p.name))
  const kept = own.length ? { ...rest, [before.key]: own } : rest
  const keys = Object.keys(kept)
  const trimmed = keys.length > LORA_LANES_MAX
    ? Object.fromEntries(keys.slice(keys.length - LORA_LANES_MAX).map((k) => [k, kept[k]]))
    : kept
  if (explicit) return { selectedLoras: after.picks, loraLanes: trimmed }
  // A character's LoRA goes along with the character: its chip stands on
  // every tab, and picking one may switch the model before or after its
  // LoRA is ticked.
  const character = after.picks.filter((p) => isCharacterLoraName(p.name))
  const back = (lanes[after.key] ?? []).filter((p) => !isCharacterLoraName(p.name))
  return { selectedLoras: [...back, ...character], loraLanes: trimmed }
}

/** A trained character's LoRA (`char_<name>_zimage.safetensors`, the trainer's
 *  own naming, api/trainer parseLocalCharacterLora). It belongs to the picked
 *  character, not to a lane. */
export function isCharacterLoraName(name: string): boolean {
  return /(?:^|[\\/])char_.+\.safetensors$/i.test(name.trim())
}

/** A persisted map, checked: anything that is not a list of picks is dropped. */
export function sanitizeLoraLanes(v: unknown): Record<string, LoraPick[]> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, LoraPick[]> = {}
  for (const [k, list] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue
    const picks = list.filter((p): p is LoraPick =>
      !!p && typeof p === 'object' && typeof (p as LoraPick).name === 'string' && Number.isFinite((p as LoraPick).strength))
    if (picks.length) out[k] = picks
  }
  return out
}
