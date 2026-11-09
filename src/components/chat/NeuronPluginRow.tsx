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

/** Why the switch is grey in Cloud mode. */
export const NEURONS_CLOUD_REASON = 'Cloud models take no sliders. Neurons steers models the LU Engine runs on this computer.'

/** The line under the switch while Neurons is on. */
export const NEURONS_ON_LINE = 'Your sliders steer the LU Engine model in Chat, Code and Agent. Tools work as before.'

export function NeuronPluginRow({ onOpenWindow }: { onOpenWindow?: () => void }) {
  const enabled = useSettingsStore((s) => s.settings.neuronsPluginEnabled === true)
  const cloud = useSettingsStore((s) => s.settings.appMode === 'cloud')
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const show = useNeuronWindow((s) => s.show)
  const hide = useNeuronWindow((s) => s.hide)
  const available = !cloud
  const on = enabled && available
  const open = () => { show(); onOpenWindow?.() }
  return (
    <div className="px-2.5" data-testid="plugins-neurons">
      <div className="w-full flex items-center justify-between py-1.5 gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <AudioLines size={10} className={`shrink-0 ${on ? 'text-sky-400' : 'text-gray-400'}`} />
          <span className="shrink-0 t-micro font-medium text-gray-600 dark:text-gray-300">Neurons</span>
          <span className="t-micro text-gray-400 truncate">steer your local model</span>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation()
            if (!available) return
            updateSettings({ neuronsPluginEnabled: !enabled })
            if (enabled) hide()
            else open()
          }}
          disabled={!available}
          aria-pressed={on}
          aria-label="Neurons"
          data-testid="plugins-neurons-switch"
          title={!available ? NEURONS_CLOUD_REASON : on ? 'Turn off Neurons: the engine runs without sliders' : 'Neurons: turn traits of your local model up or down'}
          className={
            'shrink-0 flex items-center w-7 h-3.5 rounded-full transition-colors '
            + (!available
              ? 'bg-gray-300/20 dark:bg-white/5 cursor-default justify-start'
              : on
                ? 'bg-sky-500/40 hover:bg-sky-500/55 justify-end'
                : 'bg-gray-300/30 dark:bg-white/10 hover:bg-gray-300/45 dark:hover:bg-white/15 justify-start')
          }
        >
          <span className={`w-3 h-3 rounded-full shadow-sm mx-px ${available ? 'bg-white' : 'bg-white/40'}`} />
        </button>
      </div>
      {!available && (
        <div data-testid="plugins-neurons-reason" className={`pb-1.5 t-micro leading-snug ${HINWEIS_TEXT.ruhig}`}>
          {NEURONS_CLOUD_REASON}
        </div>
      )}
      {on && (
        <div className="pb-1.5 flex items-start justify-between gap-2">
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
      )}
    </div>
  )
}
