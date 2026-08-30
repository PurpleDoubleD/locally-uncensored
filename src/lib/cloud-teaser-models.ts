/**
 * Which hosted models the LU Cloud strip in the chat picker shows, and in what
 * order.
 *
 * Nebenbefund 3 of the R9 re-measure on the 2.6.7 Windows build (2026-08-30):
 * in five looks at the picker, the LU CLOUD group showed five different groups
 * of five, once "DeepSeek V4 Flash 0731, Qwen3 VL 30B, DeepSeek R1, Qwen 3.5
 * 397B A17B, Kimi K3", shortly after "gpt-oss 120B, GLM 5, Hermes 3 405B, Qwen
 * 3.6 27B, Qwen 3.6 35B A3B". It reads like a deliberately rotating taster.
 *
 * It is not one. Nothing in the app rotates, samples or shuffles that list:
 * the strip took `.slice(0, 5)` off the models exactly as `/v1/models` handed
 * them over, and that payload carries no rank, no "featured" flag and no
 * stable order, so which five reach the screen is decided by whatever order
 * the last answer happened to arrive in. The strip also never said the list
 * was longer than five, so a model seen once looked simply gone.
 *
 * The answer is the smallest honest one: sort by the label the user reads, so
 * the same five stand there every time, and name the number that did not fit.
 */

export const CLOUD_TEASER_LIMIT = 5

export interface TeaserModel {
  name: string
  displayName?: string
}

/** Deterministic, locale-independent: case-folded label, `name` breaks ties. */
function byLabel<T extends TeaserModel>(labelOf: (m: T) => string) {
  return (a: T, b: T): number => {
    const la = labelOf(a).toLowerCase()
    const lb = labelOf(b).toLowerCase()
    if (la !== lb) return la < lb ? -1 : 1
    if (a.name !== b.name) return a.name < b.name ? -1 : 1
    return 0
  }
}

/**
 * The rows the strip draws, and how many hosted models it left out.
 * `models` is not mutated.
 */
export function cloudTeaserModels<T extends TeaserModel>(
  models: T[],
  labelOf: (m: T) => string = (m) => m.displayName ?? m.name,
  limit: number = CLOUD_TEASER_LIMIT,
): { shown: T[]; more: number } {
  const sorted = [...models].sort(byLabel(labelOf))
  return {
    shown: sorted.slice(0, limit),
    more: Math.max(0, sorted.length - limit),
  }
}
