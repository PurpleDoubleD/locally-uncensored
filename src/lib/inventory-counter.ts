/**
 * What a model counter is allowed to show while the inventory is still being
 * read.
 *
 * Befund 2 of the abnahme counter-check on the 2.6.7 Windows build
 * (2026-08-29): opening the Models page showed "Installed 0" next to three
 * cards that read Installed, and the rail carried no Image and no Video badge
 * at all. At 1.2 seconds the badges were still missing, at 5.2 seconds they
 * were right. Nothing was ever wrong for long, but for those seconds the page
 * stated a number it had not counted, and a stated zero is a claim: you own
 * none of these.
 *
 * A counter may only show a number it has counted. Until then it shows that
 * it is counting. The rail keeps hiding a settled zero, as it always did.
 */
export type CounterView =
  /** Nothing has been counted yet. Show a loading mark, never a number. */
  | { kind: 'loading' }
  /** Counted. `value` may be 0, and then it is the truth. */
  | { kind: 'count'; value: number }

export interface InventoryState {
  /** Has a model list ever landed in the store. */
  loaded: boolean
  /** Is a refresh running right now. A second pass is what brings the ComfyUI
   *  lanes in: the engine is often not up yet on the first one. */
  refreshing: boolean
}

/**
 * A count is shown as soon as there is something to show. A zero is only ever
 * shown once no refresh can still turn it into something else.
 */
export function counterView(count: number, state: InventoryState): CounterView {
  if (count > 0) return { kind: 'count', value: count }
  if (!state.loaded || state.refreshing) return { kind: 'loading' }
  return { kind: 'count', value: 0 }
}
