import { useState } from 'react'
import { useDismissOnEscape } from '../../hooks/useDismissOnEscape'
import { Plug, ChevronDown, Bone, User, Users, Wrench } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useToolSupport } from '../../hooks/useToolSupport'
import { GROUP_CHAT_MAX, isGroupChat, groupChatCandidates } from '../../lib/group-chat'
import type { CavemanMode } from '../../types/settings'
import { displayModelName } from '../../api/providers/registry'
import { HINWEIS_TEXT } from '../../lib/hinweis'

const CAVEMAN_MODES: { value: CavemanMode; label: string; desc: string }[] = [
  { value: 'off', label: 'Off', desc: 'Normal responses' },
  { value: 'lite', label: 'Lite', desc: 'Slightly shorter' },
  { value: 'full', label: 'Full', desc: 'Very terse' },
  { value: 'ultra', label: 'Ultra', desc: 'Maximum brevity' },
]

// `openUpward` opens the panel above the trigger — used when Plugins sits in
// the composer action bar (bottom of the screen) instead of the top toolbar.
//
// `iconOnly` is the Code header form (David, 2026-08-22: "das promptfenster ist
// ueberfuellt"). Same dropdown, same behaviour, but the trigger is a bare icon
// with the name in the tooltip, so it costs one constant-width slot in the
// toolbar and nothing in the composer. The active-plugin signal moves from the
// dot row onto the icon colour, because a row of dots that appears and
// disappears is exactly the kind of width jump the composer was cured of.
export function PluginsDropdown({
  openUpward = false,
  iconOnly = false,
}: { openUpward?: boolean; iconOnly?: boolean } = {}) {
  const [open, setOpen] = useState(false)
  useDismissOnEscape(open, () => setOpen(false))
  const [cavemanOpen, setCavemanOpen] = useState(false)
  const [personaOpen, setPersonaOpen] = useState(false)
  const [groupOpen, setGroupOpen] = useState(false)
  const { getActivePersona, setActivePersona } = useSettingsStore()
  const activePersona = getActivePersona()
  const allPersonas = useSettingsStore((s) => s.personas)
  const cavemanMode = useSettingsStore((s) => s.settings.cavemanMode)
  // Chat-Tools (v2.5.3) — curated web/file/image/video tools in plain chat.
  // Default ON (undefined → on) so the feature works out of the box; the
  // toggle lets a user fall back to pure-text chat.
  const chatToolsEnabledSetting = useSettingsStore((s) => s.settings.chatToolsEnabled !== false)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  // A model with no tool channel cannot run Chat Tools no matter what the
  // switch says, so show it off and disabled rather than on and broken.
  const { canUseTools, reason } = useToolSupport()
  const chatToolsEnabled = chatToolsEnabledSetting && canUseTools

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

  // Group chat v1 (Nurse KillJoy): the selection lives on the conversation,
  // exactly like the persona flag, so every chat keeps its own line-up.
  const setGroupModels = useChatStore((s) => s.setGroupModels)
  const models = useModelStore((s) => s.models)
  const groupModels = activeConv?.groupModels ?? []
  const isGroupActive = isGroupChat(activeConv?.groupModels)

  const isCavemanActive = cavemanMode && cavemanMode !== 'off'
  const isPersonaActive = activePersona && activePersona.id !== 'unrestricted' && personaEnabledOnChat
  const currentCaveman = CAVEMAN_MODES.find((m) => m.value === (cavemanMode || 'off'))

  const anyPluginActive = !!(isCavemanActive || isPersonaActive || chatToolsEnabled || isGroupActive)

  return (
    <div className="relative">
      {iconOnly ? (
        <button
          onClick={() => setOpen(!open)}
          title={anyPluginActive ? 'Plugins (active)' : 'Plugins'}
          aria-label="Plugins"
          data-testid="plugins-trigger-icon"
          // Nur `aria-expanded`, KEIN `aria-haspopup`: das Menue selbst
          // traegt (noch) kein `role="menu"`, und eine Rolle zu behaupten,
          // die drunter nicht steht, ist schlechter als sie wegzulassen.
          aria-expanded={open}
          // Aktiv war `text-blue-400` — dieselbe Farbe wie der Fokusring.
          // Jetzt der Behaelter des neutralen Rezepts, gelesen aus
          // `data-active`, weil „ein Plugin laeuft" kein Auf-/Zu-Zustand
          // des Menues ist und deshalb nicht in `aria-expanded` gehoert.
          data-active={anyPluginActive || undefined}
          className="lu-control lu-control--icon"
        >
          <Plug size={11} />
        </button>
      ) : (
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          data-active={anyPluginActive || undefined}
          className="lu-control"
        >
          <Plug size={10} />
          <span>Plugins</span>
          {anyPluginActive && (
            <div className="flex gap-0.5">
              {chatToolsEnabled && <div className="w-1 h-1 rounded-full bg-blue-400" />}
              {/* Rosa, nicht mehr Bernstein: die vier Punkte sind Kategorien,
                  keine Zustaende, und Gelb hat hier nie eine Warnung gemeint.
                  Blau, Gruen und Violett waren schon vergeben, Rot gehoert
                  Fehlern. */}
              {isCavemanActive && <div className="w-1 h-1 rounded-full bg-pink-400" />}
              {isPersonaActive && <div className="w-1 h-1 rounded-full bg-green-400" />}
              {isGroupActive && <div className="w-1 h-1 rounded-full bg-purple-400" />}
            </div>
          )}
          <ChevronDown size={8} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      )}

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className={`absolute right-0 z-50 w-56 rounded-lg lu-elevated py-1.5 ${openUpward ? 'bottom-full mb-1' : 'top-full mt-1'}`}>

            {/* ── Chat Tools toggle (v2.5.3) ──────────────── */}
            <div className="px-2.5">
              <div className="w-full flex items-center justify-between py-1.5 gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Wrench size={10} className={chatToolsEnabled ? 'text-blue-400' : 'text-gray-400'} />
                  <span className="t-micro font-medium text-gray-600 dark:text-gray-300">Chat Tools</span>
                  <span className="text-[0.5rem] text-gray-400 truncate">web · file · image · video</span>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); if (canUseTools) updateSettings({ chatToolsEnabled: !chatToolsEnabledSetting }) }}
                  disabled={!canUseTools}
                  title={!canUseTools ? reason : chatToolsEnabled ? 'Disable tools in plain chat' : 'Enable web/file/image/video tools in plain chat'}
                  className={
                    'shrink-0 flex items-center w-7 h-3.5 rounded-full transition-colors ' +
                    (!canUseTools
                      ? 'bg-gray-300/20 dark:bg-white/5 cursor-default justify-start'
                      : chatToolsEnabled
                        ? 'bg-blue-500/40 hover:bg-blue-500/55 justify-end'
                        : 'bg-gray-300/30 dark:bg-white/10 hover:bg-gray-300/45 dark:hover:bg-white/15 justify-start')
                  }
                >
                  <span className={`w-3 h-3 rounded-full shadow-sm mx-px ${canUseTools ? 'bg-white' : 'bg-white/40'}`} />
                </button>
              </div>
              {!canUseTools && (
                // Kein Fehler, nur ein Grund: dieses Modell hat keinen
                // Werkzeugkanal. Ruhiges Grau aus `lib/hinweis.ts` statt des
                // alten Gelbs, das aussah, als sei etwas schiefgegangen.
                <div className={`pb-1.5 text-[0.5rem] leading-snug ${HINWEIS_TEXT.ruhig}`}>
                  {reason}
                </div>
              )}
            </div>

            <div className="border-t border-gray-200 dark:border-white/[0.06] my-1" />

            {/* ── Caveman Mode Dropdown ───────────────────── */}
            <div className="px-2.5">
              <button
                onClick={() => { setCavemanOpen(!cavemanOpen); setPersonaOpen(false) }}
                className="w-full flex items-center justify-between py-1.5 group"
              >
                <div className="flex items-center gap-1.5">
                  <Bone size={10} className={isCavemanActive ? 'text-pink-400' : 'text-gray-400'} />
                  <span className="t-micro font-medium text-gray-600 dark:text-gray-300">Caveman Mode</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className={`text-[0.55rem] ${isCavemanActive ? 'text-pink-400' : 'text-gray-500'}`}>
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
                              : 'bg-pink-500/10 text-pink-600 dark:text-pink-400'
                            : 'text-gray-500 hover:bg-gray-50 dark:hover:bg-white/[0.04] hover:text-gray-700 dark:hover:text-gray-300'
                        }`}
                      >
                        <div className="flex items-center gap-1.5">
                          {isActive && <div className={`w-1 h-1 rounded-full shrink-0 ${mode.value === 'off' ? 'bg-gray-400' : 'bg-pink-400'}`} />}
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
                  <span className="t-micro font-medium text-gray-600 dark:text-gray-300">Persona</span>
                  <span className={`text-[0.55rem] truncate ${isPersonaActive ? 'text-green-400' : 'text-gray-500'}`}>
                    {activePersona?.name || 'Unrestricted'}
                  </span>
                  <ChevronDown size={9} className={`text-gray-500 transition-transform ${personaOpen ? 'rotate-180' : ''}`} />
                </button>
                {/* On/off toggle for THIS chat — Remote already had this
                    via `personaEnabled`; now Chat / Code / Agent match.
                    Always shown when a chat is open (David: "personas hat im
                    chat noch kein an/aus toggle" — it was hidden for the
                    default Unrestricted persona). */}
                {activeConvId && (
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

            <div className="border-t border-gray-200 dark:border-white/[0.06] my-1" />

            {/* ── Group chat (v1) ─────────────────────────── */}
            <div className="px-2.5">
              <button
                onClick={() => { setGroupOpen(!groupOpen); setCavemanOpen(false); setPersonaOpen(false) }}
                className="w-full flex items-center justify-between py-1.5"
              >
                <div className="flex items-center gap-1.5">
                  <Users size={10} className={isGroupActive ? 'text-purple-400' : 'text-gray-400'} />
                  <span className="t-micro font-medium text-gray-600 dark:text-gray-300">Group chat</span>
                  <span className={`text-[0.55rem] ${isGroupActive ? 'text-purple-400' : 'text-gray-500'}`}>
                    {isGroupActive ? `${groupModels.length} models` : 'Off'}
                  </span>
                </div>
                <ChevronDown size={9} className={`text-gray-500 transition-transform ${groupOpen ? 'rotate-180' : ''}`} />
              </button>

              {groupOpen && (activeConvId ? (
                <div className="pb-1.5 space-y-0.5 max-h-[180px] overflow-y-auto scrollbar-thin">
                  <p className="px-2 pb-0.5 text-[0.5rem] leading-snug text-gray-400">
                    Pick 2 to {GROUP_CHAT_MAX} models. They answer in turn on every message, and each sees what the others said.
                  </p>
                  {groupChatCandidates(models, groupModels).map((m) => {
                    const on = groupModels.includes(m.name)
                    const full = !on && groupModels.length >= GROUP_CHAT_MAX
                    return (
                      <button
                        key={m.name}
                        disabled={full}
                        onClick={() =>
                          setGroupModels(
                            activeConvId,
                            on ? groupModels.filter((x) => x !== m.name) : [...groupModels, m.name],
                          )
                        }
                        className={`w-full flex items-center gap-1.5 px-2 py-1 rounded text-left transition-colors ${
                          on
                            ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400'
                            : full
                              ? 'text-gray-400/50 cursor-default'
                              : 'text-gray-500 hover:bg-gray-50 dark:hover:bg-white/[0.04] hover:text-gray-700 dark:hover:text-gray-300'
                        }`}
                      >
                        {on && <div className="w-1 h-1 rounded-full bg-purple-400 shrink-0" />}
                        <span className="text-[0.55rem] font-medium truncate" title={displayModelName(m.name)}>{displayModelName(m.name)}</span>
                      </button>
                    )
                  })}
                  {groupModels.length === 1 && (
                    <p className="px-2 text-[0.5rem] text-gray-400">One more model turns this into a group.</p>
                  )}
                  {groupModels.length > 0 && (
                    <button
                      onClick={() => setGroupModels(activeConvId, [])}
                      className="w-full px-2 py-1 rounded text-left text-[0.55rem] text-gray-500 hover:bg-gray-50 dark:hover:bg-white/[0.04] hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                    >
                      Turn off
                    </button>
                  )}
                </div>
              ) : (
                <p className="pb-1.5 px-2 text-[0.5rem] text-gray-400">Open a chat first, the group lives on the conversation.</p>
              ))}
            </div>

          </div>
        </>
      )}
    </div>
  )
}
