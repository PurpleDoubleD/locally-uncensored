/**
 * The one rule behind the arm-then-confirm reset button, as a plain function.
 *
 * "Reset <tab> to defaults" needs two clicks: the first arms, the second
 * fires. An arm that survives a tab switch would be a trap — a click armed on
 * General would confirm-fire on Agent. So an arm is only ever live on the tab
 * it was made on.
 *
 * This used to be an effect (`useEffect(() => setArmed(null), [tab])`), which
 * meant the disarm happened one render LATE: the render right after a tab
 * switch still saw the old tab as armed. Recording the tab alongside the arm
 * and comparing at render time removes both the effect and that one-frame
 * window.
 */

/** Which reset the armed click would fire. */
export type ResetArmScope = 'section' | 'all'

/** An arm remembers what it would do AND where it was made. */
export type ResetArm<Tab extends string = string> = { scope: ResetArmScope; tab: Tab } | null

/**
 * The scope the button is armed for on `tab` — `null` on every other tab.
 *
 * Pure: given the same arm and tab it always answers the same, which is what
 * lets the component derive `armed` while rendering instead of syncing it.
 */
export function armedScopeFor<Tab extends string>(arm: ResetArm<Tab>, tab: Tab): ResetArmScope | null {
  return arm && arm.tab === tab ? arm.scope : null
}
