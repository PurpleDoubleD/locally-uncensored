// The Neurons row under Plugins (3.1.0). Neurons used to be a page of its
// own in the header; David, 08.11.2026: it belongs in the plugin section,
// on and off like the others, and it runs in one window with pop-ups. On
// opens that window right away; "Open" brings it back later. The sliders act
// inside the LU Engine itself, so Chat, Code and Agent and all their tools
// run as before, only with the model steered: nothing goes through MCP.

import { AudioLines, PanelRightOpen } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useNeuronWindow } from '../../stores/neuronWindowStore'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { NEURONS_HINT_LABEL, useNeuronsHint } from '../../lib/neurons-hint'
import { HintDot, PluginRow } from './PluginRow'

/** Why the switch is grey in Cloud mode. */
export const NEURONS_CLOUD_REASON = 'Cloud models take no sliders. Neurons steers models the LU Engine runs on this computer.'

/** The line under the switch while Neurons is on. */
export const NEURONS_ON_LINE = 'Your sliders steer the LU Engine model in Chat, Code and Agent. Tools work as before.'

export function NeuronPluginRow({ onOpenWindow, hint = false }: { onOpenWindow?: () => void; hint?: boolean }) {
  const enabled = useSettingsStore((s) => s.settings.neuronsPluginEnabled === true)
  const cloud = useSettingsStore((s) => s.settings.appMode === 'cloud')
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const show = useNeuronWindow((s) => s.show)
  const hide = useNeuronWindow((s) => s.hide)
  const noteNeuronsOn = useNeuronsHint((s) => s.noteNeuronsOn)
  const available = !cloud
  const on = enabled && available
  const open = () => { show(); onOpenWindow?.() }
  return (
    <PluginRow
      testId="plugins-neurons"
      icon={AudioLines}
      onColor="text-sky-400"
      name="Neurons"
      line="steer your local model"
      hint={hint ? <HintDot testId="plugins-neurons-hint" label={NEURONS_HINT_LABEL} /> : null}
      on={on}
      available={available}
      reason={NEURONS_CLOUD_REASON}
      onToggle={() => {
        updateSettings({ neuronsPluginEnabled: !enabled })
        if (enabled) hide()
        else { noteNeuronsOn(); open() }
      }}
      switchLabel="Neurons"
      switchTestId="plugins-neurons-switch"
      switchTitle={on ? 'Turn off Neurons: the engine runs without sliders' : 'Neurons: turn traits of your local model up or down'}
    >
      <div className="flex items-start justify-between gap-2">
        <span data-testid="plugins-neurons-line" className={`t-micro leading-snug ${HINWEIS_TEXT.ruhig}`}>{NEURONS_ON_LINE}</span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); open() }}
          data-testid="plugins-neurons-open"
          className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded t-micro text-sky-600 dark:text-sky-400 hover:bg-sky-500/10"
        >
          <PanelRightOpen size={9} /> Open
        </button>
      </div>
    </PluginRow>
  )
}
