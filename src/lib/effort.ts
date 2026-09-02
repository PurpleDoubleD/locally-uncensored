/**
 * The reasoning-effort ladder: one place that decides which rung a request
 * actually asks for.
 *
 * Why a ladder per model instead of one fixed scale. Measured against the live
 * DeepInfra API on 2026-09-02 (ops/wissen/deepinfra-modellmatrix-2026-09-02.md):
 * most reasoners take low, medium and high, GLM 5.3 adds max, and
 * Qwen/Qwen3.8-27B answers 400 to BOTH high and max, naming low and medium as
 * the only rungs it has. A composer that sends one fixed scale to every model
 * breaks every single request on that last one.
 *
 * So the server declares the rungs per model (`reasoning_effort_levels` on
 * /api/inference/v1/models) and everything here clamps the user's wish onto
 * them. An older server sends no field, the ladder is empty, and an empty
 * ladder has to mean "exactly like before": 'high' while thinking is on, and
 * no effort control in the composer at all.
 *
 * 'none' is deliberately NOT a rung here. It is the off switch, the Think
 * button already says that, and on GLM 5.3 it is worse than useless: the model
 * keeps thinking and only stops separating the thought, so the monologue lands
 * in the customer's chat window and costs more tokens than sending nothing.
 */

/**
 * Ascending, cheapest first, and it holds the rungs and NOTHING else.
 *
 * 'none' and 'minimal' are both ways of saying off, not quiet rungs at the
 * bottom. They are filtered out of a declared ladder on the way in, so a server
 * that lists them cannot make the composer offer an off switch that contradicts
 * the Think button, and clamping can never answer with one either. That is the
 * difference between "think a little" and "do not think", and on GLM 5.3 the
 * second one costs MORE than sending no parameter at all.
 */
const RANK: Record<string, number> = { low: 0, medium: 1, high: 2, max: 3 }

/**
 * The rungs the composer offers, which is every rung there is: two controls
 * that both claim to turn thinking off is how a user ends up disbelieving both.
 */
export const EFFORT_STEPS = ['low', 'medium', 'high', 'max'] as const

export type EffortLevel = (typeof EFFORT_STEPS)[number]

/**
 * What we ask for when nothing else is known. It is 'high' because that is
 * what the client has always sent for thinking ON, and a release that quietly
 * changes the rung changes every existing customer's bill without asking.
 */
export const DEFAULT_EFFORT: EffortLevel = 'high'

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_STEPS as readonly string[]).includes(value)
}

/** The declared rungs we understand, ascending. Unknown words are dropped. */
function known(levels: readonly string[] | undefined): string[] {
  return (levels ?? []).filter((l) => l in RANK).sort((a, b) => RANK[a] - RANK[b])
}

/** Does this model declare any rung we understand? */
export function hasEffortLadder(levels: readonly string[] | undefined): boolean {
  return known(levels).length > 0
}

/** The rungs to show in the composer, in ladder order. Empty = show nothing. */
export function effortChoices(levels: readonly string[] | undefined): EffortLevel[] {
  const ladder = known(levels)
  return EFFORT_STEPS.filter((step) => ladder.includes(step))
}

/**
 * The wish, clamped onto the rungs this model really has.
 *
 * Down before up: a wish above the model's top rung becomes that top rung
 * (asking Qwen3.8 27B for 'max' would 400), and only a wish below the cheapest
 * rung is rounded up. No ladder at all returns DEFAULT_EFFORT, which is what
 * the client sent before any of this existed.
 */
export function clampEffort(levels: readonly string[] | undefined, wanted: string): string {
  const ladder = known(levels)
  if (ladder.length === 0) return DEFAULT_EFFORT
  if (ladder.includes(wanted)) return wanted
  const rank = RANK[wanted]
  // A word we do not know is treated as the default wish, never as "the most
  // the model can do": on GLM 5.3 an invalid value silently means max, and
  // guessing upward is the one guess the customer pays for.
  if (rank === undefined) return clampEffort(ladder, DEFAULT_EFFORT)
  const below = ladder.filter((l) => RANK[l] < rank).pop()
  return below ?? ladder[0]
}

/** The next rung for the cycling button, wrapping at the top of the ladder. */
export function nextEffort(
  levels: readonly string[] | undefined,
  current: string,
): EffortLevel {
  const choices = effortChoices(levels)
  if (choices.length === 0) return DEFAULT_EFFORT
  const at = choices.indexOf(clampEffort(choices, current) as EffortLevel)
  return choices[(at + 1) % choices.length]
}

/** Short label for the composer button. */
export function effortLabel(level: string): string {
  return level.charAt(0).toUpperCase() + level.slice(1)
}
