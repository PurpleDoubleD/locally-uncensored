// The REA row under Plugins (lib/plugins/rea.ts): a switch that starts and
// stops its local MCP server, the step a start is at, and what it can read
// without extra programs. In the desktop app only; the browser build has no
// process to start.

import { Microscope } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useReaRuntime } from '../../lib/plugins/rea-runtime'
import { REA_PLUGIN, REA_TOOLS_NOTE, reaGhidraLine } from '../../lib/plugins/rea'
import { HINWEIS_TEXT } from '../../lib/hinweis'

/** The line under the switch for the step a start is at. */
export function reaPhaseLine(phase: string, tools: number, error: string | null): string | null {
  switch (phase) {
    case 'fetching': return `Getting the official REA ${REA_PLUGIN.version} package…`
    case 'starting': return 'Starting REA…'
    case 'on': return `${tools} reverse engineering tools for Agent and Code. ${REA_TOOLS_NOTE}`
    case 'error': return error
    default: return null
  }
}

export function ReaPluginRow() {
  const enabled = useSettingsStore((s) => s.settings.reaPluginEnabled === true)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const { phase, tools, error, ghidra } = useReaRuntime()
  const line = enabled ? reaPhaseLine(phase, tools, error) : null
  // Only once REA runs: before that the row has its own step to tell.
  const ghidraLine = enabled && phase === 'on' ? reaGhidraLine(ghidra) : null
  return (
    <div className="px-2.5" data-testid="plugins-rea">
      <div className="w-full flex items-center justify-between py-1.5 gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Microscope size={10} className={`shrink-0 ${enabled ? 'text-teal-400' : 'text-gray-400'}`} />
          <span className="shrink-0 t-micro font-medium text-gray-600 dark:text-gray-300">{REA_PLUGIN.name}</span>
          <span className="t-micro text-gray-400 truncate">reverse engineering</span>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); updateSettings({ reaPluginEnabled: !enabled }) }}
          aria-pressed={enabled}
          aria-label={REA_PLUGIN.title}
          data-testid="plugins-rea-switch"
          title={enabled ? 'Stop REA' : `${REA_PLUGIN.title}: tools for Agent and Code that take apart apps and files (${REA_PLUGIN.license})`}
          className={
            'shrink-0 flex items-center w-7 h-3.5 rounded-full transition-colors '
            + (enabled
              ? 'bg-teal-500/40 hover:bg-teal-500/55 justify-end'
              : 'bg-gray-300/30 dark:bg-white/10 hover:bg-gray-300/45 dark:hover:bg-white/15 justify-start')
          }
        >
          <span className="w-3 h-3 rounded-full shadow-sm mx-px bg-white" />
        </button>
      </div>
      {line && (
        <div
          data-testid="plugins-rea-line"
          className={`pb-1.5 t-micro leading-snug ${phase === 'error' ? 'text-red-400' : HINWEIS_TEXT.ruhig}`}
        >
          {line}
        </div>
      )}
      {ghidraLine && (
        <div
          data-testid="plugins-rea-ghidra"
          className={`pb-1.5 t-micro leading-snug break-words ${ghidra?.needsNatives ? HINWEIS_TEXT.fehler : HINWEIS_TEXT.ruhig}`}
        >
          {ghidraLine}
        </div>
      )}
    </div>
  )
}
