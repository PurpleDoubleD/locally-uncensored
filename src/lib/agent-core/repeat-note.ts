/**
 * Calls the Agent tab did not run again, said to the model (CA, cloud loops,
 * 13.11.2026).
 *
 * The Agent loop drops a call that exactly repeats one already run this turn.
 * When EVERY call of a step was a repeat it said so, but when only some were,
 * the model got results for the others and nothing about the rest: it asked
 * for X and Y, saw Y, and asked for X again on the next step. Now the dropped
 * ones are named after the results.
 *
 * The comparison is on canonical arguments (keys sorted, strings trimmed), so
 * `{"path":"a","limit":5}` and `{"limit":5, "path":"a "}` are one call. A
 * byte-exact key let a cloud model's re-ordered arguments slip past.
 */

/** Arguments as one stable string: keys sorted at every depth, strings trimmed. */
export function canonicalArgs(value: unknown): string {
  return JSON.stringify(canon(value ?? {}))
}

function canon(v: unknown): unknown {
  if (typeof v === 'string') return v.trim()
  if (Array.isArray(v)) return v.map(canon)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = canon((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

/** One short label per skipped call, for the note. */
export function repeatLabel(name: string, args: unknown): string {
  const a = canonicalArgs(args)
  return `${name} ${a.length > 120 ? a.slice(0, 117) + '...' : a}`
}

/** The note after the results, or null when nothing was skipped. */
export function skippedRepeatsNote(labels: string[]): string | null {
  if (labels.length === 0) return null
  const list = labels.map((l) => `- ${l}`).join('\n')
  return `Not run again, because each already ran this turn with the same arguments and its result is above, unchanged:\n${list}\nUse those results. Call a tool again only with different arguments.`
}
