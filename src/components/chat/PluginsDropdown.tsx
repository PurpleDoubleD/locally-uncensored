import { useState } from 'react'
import { Plug, ChevronDown, Bone, User } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useChatStore } from '../../stores/chatStore'
import type { CavemanMode } from '../../types/settings'

const CAVEMAN_MODES: { value: CavemanMode; label: string; desc: string }[] = [
  { value: 'off', label: 'Off', desc: 'Normal responses' },
  { value: 'lite', label: 'Lite', desc: 'Slightly shorter' },
  { value: 'full', label: 'Full', desc: 'Very terse' },
  { value: 'ultra', label: 'Ultra', desc: 'Maximum brevity' },
]

export function PluginsDropdown() {
  const [open, setOpen] = useState(false)
  const [cavemanOpen, setCavemanOpen] = useState(false)
  const [personaOpen, setPersonaOpen] = useState(false)
  const { getActivePersona, setActivePersona } = useSettingsStore()
  const activePersona = getActivePersona()
  const allPersonas = useSettingsStore((s) => s.personas)
  const cavemanMode = useSettingsStore((s) => s.settings.cavemanMode)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  // Per-chat persona enable/disable (mirrors mobile). Defaults to true
  // for legacy chats where the flag is absent. The toggle in the
  // dropdown flips this on the active conversation only — other chats
  // keep their own state. Hooks (useChat, useAgentChat, useCodex) read
  // the flag and skip the persona's systemPrompt when it's false.
  const activeConvId = useChatStore((s) => s.activeConversationId)
  const activeConv = useChatStore((s) =>
    activeConvId ? s.conversations.find((c) => c.id === activeConvId) : null
  )
  const setConversationPersonaEnabled = useChatStore((s) => s.setConversationPersonaEnabled)
  // Default OFF: persona only counts as "active on this chat" when the
  // user has explicitly flipped it on via the toggle below. Undefined or
  // missing flag → OFF. Fixes the "Devil's Advocate hijacks every new
  // chat" bug David flagged.
  const personaEnabledOnChat = activeConv?.personaEnabled === true

  const isCavemanActive = cavemanMode && cavemanMode !== 'off'
  const isPersonaActive = activePersona && activePersona.id !== 'unrestricted' && personaEnabledOnChat
  const currentCaveman = CAVEMAN_MODES.find((m) => m.value === (cavemanMode || 'off'))

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
          <div className="absolute right-0 top-full mt-1 z-50 w-56 rounded-lg bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/10 shadow-xl py-1.5">

            {/* ── Caveman Mode Dropdown ───────────────────── */}
            <div className="px-2.5">
              <button
                onClick={() => { setCavemanOpen(!cavemanOpen); setPersonaOpen(false) }}
                className="w-full flex items-center justify-between py-1.5 group"
              >
                <div className="flex items-center gap-1.5">
                  <Bone size={10} className={isCavemanActive ? 'text-amber-400' : 'text-gray-400'} />
                  <span className="text-[0.6rem] font-medium text-gray-600 dark:text-gray-300">Caveman Mode</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className={`text-[0.55rem] ${isCavemanActive ? 'text-amber-400' : 'text-gray-500'}`}>
                    {currentCaveman?.label || 'Off'}
                  </span>
                  <ChevronDown size={9} className={`text-gray-500 transition-transform ${cavemanOpen ? 'rotate-180' : ''}`} />
                </div>
              </button>

              {cavemanOpen && (
                <div className="pb-1.5 space-y-0.5">
                  {CAVEMAN_MODES.map((mode) => {
                    const isActive = (cavemanMode || 'off') === mode.value
                    return (
                      <button
                        key={mode.value}
                        onClick={() => { updateSettings({ cavemanMode: mode.value }); setCavemanOpen(false) }}
                        className={`w-full flex items-center justify-between px-2 py-1 rounded text-left transition-colors ${
                          isActive
                            ? mode.value === 'off'
                              ? 'bg-gray-100 dark:bg-white/[0.06] text-gray-700 dark:text-gray-200'
                              : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                            : 'text-gray-500 hover:bg-gray-50 dark:hover:bg-white/[0.04] hover:text-gray-700 dark:hover:text-gray-300'
                        }`}
                      >
                        <div className="flex items-center gap-1.5">
                          {isActive && <div className={`w-1 h-1 rounded-full shrink-0 ${mode.value === 'off' ? 'bg-gray-400' : 'bg-amber-400'}`} />}
                          <span className="text-[0.55rem] font-medium">{mode.label}</span>
                        </div>
                        <span className="text-[0.5rem] text-gray-400">{mode.desc}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="border-t border-gray-200 dark:border-white/[0.06] my-1" />

            {/* ── Personas Dropdown ───────────────────────── */}
            <div className="px-2.5">
              <div className="w-full flex items-center justify-between py-1.5 gap-2">
                <button
                  onClick={() => { setPersonaOpen(!personaOpen); setCavemanOpen(false) }}
                  className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
                >
                  <User size={10} className={isPersonaActive ? 'text-green-400' : 'text-gray-400'} />
                  <span className="text-[0.6rem] font-medium text-gray-600 dark:text-gray-300">Persona</span>
                  <span className={`text-[0.55rem] truncate ${isPersonaActive ? 'text-green-400' : 'text-gray-500'}`}>
                    {activePersona?.name || 'Unrestricted'}
                  </span>
                  <ChevronDown size={9} className={`text-gray-500 transition-transform ${personaOpen ? 'rotate-180' : ''}`} />
                </button>
                {/* On/off toggle for THIS chat — Remote already had this
                    via `personaEnabled`; now Chat / Code / Agent match. */}
                {activeConvId && activePersona && activePersona.id !== 'unrestricted' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setConversationPersonaEnabled(activeConvId, !personaEnabledOnChat)
                    }}
                    title={personaEnabledOnChat ? 'Disable persona for this chat' : 'Enable persona for this chat'}
                    className={
                      'shrink-0 flex items-center w-7 h-3.5 rounded-full transition-colors ' +
                      (personaEnabledOnChat
                        ? 'bg-green-500/40 hover:bg-green-500/55 justify-end'
                        : 'bg-gray-300/30 dark:bg-white/10 hover:bg-gray-300/45 dark:hover:bg-white/15 justify-start')
                    }
                  >
                    <span className="w-3 h-3 rounded-full bg-white shadow-sm mx-px" />
                  </button>
                )}
              </div>

              {personaOpen && (
                <div className="pb-1.5 space-y-0.5 max-h-[180px] overflow-y-auto scrollbar-thin">
                  {allPersonas.map((p) => {
                    const isActive = p.id === activePersona?.id
                    return (
                      <button
                        key={p.id}
                        onClick={() => { setActivePersona(p.id); setPersonaOpen(false) }}
                        className={`w-full flex items-center gap-1.5 px-2 py-1 rounded text-left transition-colors ${
                          isActive
                            ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                            : 'text-gray-500 hover:bg-gray-50 dark:hover:bg-white/[0.04] hover:text-gray-700 dark:hover:text-gray-300'
                        }`}
                      >
                        {isActive && <div className="w-1 h-1 rounded-full bg-green-400 shrink-0" />}
                        <span className="text-[0.55rem] font-medium">{p.name}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

          </div>
        </>
      )}
    </div>
  )
}
