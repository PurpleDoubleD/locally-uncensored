// GH #235: one setting frees the memory of a chat model nobody uses, on the
// LU Engine, Ollama and LM Studio alike. It used to sit in the LU Engine
// section, which only shows when LU runs its own engine.
import { useSettingsStore } from '../../stores/settingsStore'
import { ENGINE_IDLE_UNLOAD_CHOICES, idleUnloadLabel, idleUnloadMinutes } from '../../lib/engine-idle-unload'

const selectCls =
  'px-1.5 py-0.5 rounded bg-transparent border border-gray-300 dark:border-white/8 text-[0.65rem] text-gray-700 dark:text-gray-300 focus:outline-none focus:border-white/20 [&>option]:bg-gray-900'

/** The note under the choice, so it says what Never means on each backend. */
export const IDLE_UNLOAD_NOTE =
  'LU Engine, Ollama and LM Studio keep a model in memory so answers start at once. With a time set, each frees that memory after the model went unused that long; the next message loads it again, which takes a moment. With Never, the LU Engine and LM Studio keep the model and Ollama frees it after 30 minutes.'

export function IdleUnloadSetting() {
  const idleMinutes = useSettingsStore((s) => idleUnloadMinutes(s.settings.engineIdleUnloadMinutes))
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="t-micro text-gray-700 dark:text-gray-400">Unload the chat model when unused</span>
        <select
          value={idleMinutes}
          onChange={(e) => updateSettings({ engineIdleUnloadMinutes: Number(e.target.value) })}
          className={selectCls}
          data-testid="engine-idle-unload"
        >
          {ENGINE_IDLE_UNLOAD_CHOICES.map((m) => (
            <option key={m} value={m}>{idleUnloadLabel(m)}</option>
          ))}
        </select>
      </div>
      <div className="t-micro text-gray-500 leading-relaxed">{IDLE_UNLOAD_NOTE}</div>
    </div>
  )
}
