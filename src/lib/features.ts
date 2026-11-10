/**
 * Neurons (the neuron tweaker, P11) was hidden in 3.0.9 (David, 04.11.2026)
 * and comes back in 3.1.0 as a plugin (David, 08.11.2026): switched on under
 * Plugins, it works in one window over Chat, Code and Agent. It has no page
 * and no header tab any more; `NEURONS_ENABLED` says only that the feature
 * exists, so texts (Discover, how-to) may name it. Whether it steers is the
 * user's switch (settings.neuronsPluginEnabled, Rust's `plugin-on`).
 */
export const NEURONS_ENABLED = true

/** The view to show for `view`. Neurons has no page any more: an old button,
 *  link or saved state that asks for it lands on Chat, where its window
 *  lives. Generic over the view name instead of importing `View`: uiStore
 *  imports this file, and the type import back made an import cycle
 *  (`npm run cycles`). */
export function visibleView<V extends string>(view: V): V | 'chat' {
  return view === 'neuron' ? 'chat' : view
}
