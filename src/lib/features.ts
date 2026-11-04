import type { View } from '../stores/uiStore'

/**
 * Neurons (the Neuron tweaker, P11) is hidden in 3.0.9 (David, 04.11.2026):
 * the tool gets reworked for 3.1.0. This one switch hides every way in
 * (header tab, command palette, hints in Models and Discover, how-to lines,
 * release notes, the introduction) and keeps persona sliders from steering
 * the engine unseen. Backend, engine and saved sliders stay as they are.
 */
export const NEURONS_ENABLED = false

/** The view to show for `view`: a hidden view falls back to Chat, so a
 *  stale button, link or saved state never lands on a page that is off. */
export function visibleView(view: View): View {
  return view === 'neuron' && !NEURONS_ENABLED ? 'chat' : view
}
