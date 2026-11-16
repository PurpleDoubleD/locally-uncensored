// The REA row under Plugins (lib/plugins/rea.ts): a switch that starts and
// stops its local MCP server, the step a start is at, and what it can read
// without extra programs. In the desktop app only; the browser build has no
// process to start.

import { Microscope } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useReaRuntime } from '../../lib/plugins/rea-runtime'
import { REA_PLUGIN, REA_TOOLS_NOTE, reaGhidraLine } from '../../lib/plugins/rea'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { PluginRow } from './PluginRow'

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
    <PluginRow
      testId="plugins-rea"
      icon={Microscope}
      onColor="text-teal-400"
      name={REA_PLUGIN.name}
      line="reverse engineering"
      on={enabled}
      onToggle={() => updateSettings({ reaPluginEnabled: !enabled })}
      switchLabel={REA_PLUGIN.title}
      switchTestId="plugins-rea-switch"
      switchTitle={enabled ? 'Stop REA' : `${REA_PLUGIN.title}: tools for Agent and Code that take apart apps and files (${REA_PLUGIN.license})`}
    >
      {line || ghidraLine ? (
        <>
          {line && (
            <div
              data-testid="plugins-rea-line"
              className={`t-micro leading-snug ${phase === 'error' ? 'text-red-400' : HINWEIS_TEXT.ruhig}`}
            >
              {line}
            </div>
          )}
          {ghidraLine && (
            <div
              data-testid="plugins-rea-ghidra"
              className={`${line ? 'pt-1.5 ' : ''}t-micro leading-snug break-words ${ghidra?.needsNatives ? HINWEIS_TEXT.fehler : HINWEIS_TEXT.ruhig}`}
            >
              {ghidraLine}
            </div>
          )}
        </>
      ) : null}
    </PluginRow>
  )
}
