import { useState } from 'react'
import { Plug, ChevronDown, Bone, User } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import type { CavemanMode } from '../../types/settings'

const CAVEMAN_MODES: { value: CavemanMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'lite', label: 'Lite' },
  { value: 'full', label: 'Full' },
  { value: 'ultra', label: 'Ultra' },
]

export function PluginsDropdown() {
  const [open, setOpen] = useState(false)
  const { getActivePersona, setActivePersona } = useSettingsStore()
  const activePersona = getActivePersona()
  const allPersonas = useSettingsStore((s) => s.personas)
  const cavemanMode = useSettingsStore((s) => s.settings.cavemanMode)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const isCavemanActive = cavemanMode && cavemanMode !== 'off'
  const isPersonaActive = activePersona && activePersona.id !== 'unrestricted'

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2 py-0.5 rounded border border-gray-200 dark:border-white/[0.06] hover:border-gray-400 dark:hover:border-white/15 text-gray-500 transition-colors text-[0.55rem]"
      >
        <Plug size={10} />
        <span>Plugins</span>
        {(isCavemanActive || isPersonaActive) && (
          <div className="flex gap-0.5">
            {isCavemanActive && <div className="w-1 h-1 rounded-full bg-amber-400" />}
            {isPersonaActive && <div className="w-1 h-1 rounded-full bg-green-400" />}
          </div>
        )}
        <ChevronDown size={8} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 w-48 max-h-[300px] overflow-y-auto scrollbar-thin rounded-lg bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/10 shadow-xl py-1">

            {/* Caveman Mode */}
            <div className="px-2 py-1">
              <div className="flex items-center gap-1 text-[0.5rem] text-gray-500 font-medium uppercase tracking-wider mb-1">
                <Bone size={8} />
                Caveman Mode
              </div>
              <div className="flex gap-0.5">
                {CAVEMAN_MODES.map((mode) => (
                  <button
                    key={mode.value}
                    onClick={() => updateSettings({ cavemanMode: mode.value })}
                    className={`flex-1 text-center py-0.5 rounded text-[0.5rem] font-medium transition-colors ${
                      (cavemanMode || 'off') === mode.value
                        ? mode.value === 'off'
                          ? 'bg-white/10 text-gray-300'
                          : 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                        : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
                    }`}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="border-t border-gray-200 dark:border-white/[0.06] my-1" />

            {/* Personas */}
            <div className="px-2 py-0.5">
              <div className="flex items-center gap-1 text-[0.5rem] text-gray-500 font-medium uppercase tracking-wider mb-1">
                <User size={8} />
                Personas
              </div>
            </div>
            {allPersonas.map((p) => (
              <button
                key={p.id}
                onClick={() => { setActivePersona(p.id); setOpen(false) }}
                className={`w-full text-left px-3 py-1 text-[0.55rem] transition-colors flex items-center gap-1.5 ${
                  p.id === activePersona?.id
                    ? 'text-white bg-white/[0.04]'
                    : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
                }`}
              >
                {p.id === activePersona?.id && (
                  <div className="w-1 h-1 rounded-full bg-green-400 shrink-0" />
                )}
                {p.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
