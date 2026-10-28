import { lazy, Suspense, useRef, useState } from 'react'
import { usePopoverPlatz } from '../../hooks/usePopoverPlatz'
import { useDismissOnEscape } from '../../hooks/useDismissOnEscape'
import { Plug, ChevronDown, Bone, User, Users, Sparkles, X } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { GROUP_CHAT_MAX, isGroupChat, groupChatRows } from '../../lib/group-chat'
import { resolveChatPersona } from '../../lib/chat-persona'
import type { CavemanMode } from '../../types/settings'
import { displayModelName } from '../../api/providers/registry'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { BetaMark } from '../ui/BetaMark'
import { isTauri } from '../../api/backend'
import { createChatLive, createInChatOf, createSupport, servedWindowOf } from '../../lib/create/chat-switch'
import { useCreateChatReleased } from '../../lib/create/chat-release'

/** Whether the Plugins menu carries REA: desktop app, Agent or Code only. */
export function reaInPlugins(desktop: boolean, agentTools: boolean): boolean {
  return desktop && agentTools
}

/** The line next to the greyed Create switch in a group chat. */
export const CREATE_GROUP_REASON = 'Not available in a group chat.'

// REA's row loads in the desktop app only, in a chunk of its own: its name
// and texts stay out of every bundle a browser opens.
const ReaPluginRow = lazy(() => import('./ReaPluginRow').then((m) => ({ default: m.ReaPluginRow })))

const CAVEMAN_MODES: { value: CavemanMode; label: string; desc: string }[] = [
  { value: 'off', label: 'Off', desc: 'Normal responses' },
  { value: 'lite', label: 'Lite', desc: 'Slightly shorter' },
  { value: 'full', label: 'Full', desc: 'Very terse' },
  { value: 'ultra', label: 'Ultra', desc: 'Maximum brevity' },
]

// `openUpward` opens the panel above the trigger — used when Plugins sits in
// the composer action bar (bottom of the screen) instead of the top toolbar.
//
// `iconOnly` is the Code header form (2026-08-22: "das promptfenster ist
// ueberfuellt"). Same dropdown, same behaviour, but the trigger is a bare icon
// with the name in the tooltip, so it costs one constant-width slot in the
// toolbar and nothing in the composer. The active-plugin signal moves from the
// dot row onto the icon colour, because a row of dots that appears and
// disappears is exactly the kind of width jump the composer was cured of.
//
// `agentTools` says the surface runs the agent loop: Agent on in Chat, or
// Code. REA's tools reach only those two, so its row, its dot and its line
// stay out of plain chat (3.0.8, A6).
export function PluginsDropdown({
  openUpward = false,
  iconOnly = false,
  agentTools = false,
}: { openUpward?: boolean; iconOnly?: boolean; agentTools?: boolean } = {}) {
  const [open, setOpen] = useState(false)
  useDismissOnEscape(open, () => setOpen(false))
  const menuRef = useRef<HTMLDivElement>(null)
  const menu = usePopoverPlatz(menuRef, open, { bevorzugt: openUpward ? 'oben' : 'unten' })
  const [cavemanOpen, setCavemanOpen] = useState(false)
  const [personaOpen, setPersonaOpen] = useState(false)
  const [groupOpen, setGroupOpen] = useState(false)
  // Which participant's persona list is open, by model name.
  const [personaFor, setPersonaFor] = useState<string | null>(null)
  const setActivePersona = useSettingsStore((s) => s.setActivePersona)
  const activePersonaId = useSettingsStore((s) => s.activePersonaId)
  const allPersonas = useSettingsStore((s) => s.personas)
  const cavemanMode = useSettingsStore((s) => s.settings.cavemanMode)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  // Create in chat: its own switch, global, remembered, off by default. Only
  // in Cloud mode, and only for an account the server has released; without
  // both this menu is the one that shipped before. A model the server does
  // not release for it, or whose window does not carry the tools, shows the
  // switch off and greyed, with the reason.
  const cloudMode = useSettingsStore((s) => s.settings.appMode === 'cloud')
  const createReleased = useCreateChatReleased()
  const createSetting = useSettingsStore((s) => s.settings.createEnabled === true)
  const activeChatModel = useModelStore((s) => s.activeModel)
  const servedWindow = useModelStore((s) => servedWindowOf(s.activeModel, s.models))
  const modelReleased = useModelStore((s) => createInChatOf(s.activeModel, s.models))
  const modelRows = useModelStore((s) => s.models)
  // The Code header carries this menu too (`iconOnly`); the coding agent has
  // no orders, so the switch is not offered there.
  const createBase = createSupport(activeChatModel, createChatLive(cloudMode, createReleased) && !iconOnly, servedWindow, modelReleased, modelRows)

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
  const setConversationPersona = useChatStore((s) => s.setConversationPersona)
  // GH #170: the persona named here is the one THIS chat sends, read through
  // the same function the send path uses. Without an open chat it is the app
  // wide pick, which is what the next new chat starts with.
  const chatPersona = activeConv
    ? resolveChatPersona(activeConv, allPersonas, activePersonaId)
    : { persona: allPersonas.find((p) => p.id === activePersonaId), prompt: '' }
  const activePersona = chatPersona.persona
  const personaLabel = activePersona?.name ?? (chatPersona.prompt.trim() ? 'Saved prompt' : 'Unrestricted')
  // Default OFF: persona only counts as "active on this chat" when the
  // user has explicitly flipped it on via the toggle below. Undefined or
  // missing flag → OFF. Fixes the "Devil's Advocate hijacks every new
  // chat" bug the owner flagged.
  const personaEnabledOnChat = activeConv?.personaEnabled === true

  // Group chat v1 (a user): the selection lives on the conversation,
  // exactly like the persona flag, so every chat keeps its own line-up.
  const setGroupModels = useChatStore((s) => s.setGroupModels)
  const setGroupPersona = useChatStore((s) => s.setGroupPersona)
  const groupPersonas = activeConv?.groupPersonas
  const models = useModelStore((s) => s.models)
  const inventoryLoaded = useModelStore((s) => s.inventoryLoaded)
  const groupModels = activeConv?.groupModels ?? []
  const isGroupActive = isGroupChat(activeConv?.groupModels)
  // GH #165: members whose model left the model list stay visible here,
  // marked unavailable, and are counted apart from the ones that answer.
  const groupRows = groupChatRows(models, groupModels, inventoryLoaded)
  const unavailableCount = groupRows.filter((r) => r.unavailable).length
  const answering = groupModels.length - unavailableCount
  // A group round is a conversation between models and never carries the
  // Create tools (hooks/useChat.ts).
  const create = createBase.shown && isGroupActive
    ? { shown: true, available: false, reason: CREATE_GROUP_REASON }
    : createBase
  const createOn = create.available && createSetting

  const isCavemanActive = cavemanMode && cavemanMode !== 'off'
  const isPersonaActive = personaEnabledOnChat &&
    (activePersona ? activePersona.id !== 'unrestricted' : chatPersona.prompt.trim() !== '')
  const currentCaveman = CAVEMAN_MODES.find((m) => m.value === (cavemanMode || 'off'))

  // REA (lib/plugins/rea.ts): a local process, so the desktop app only, and
  // only where its tools go: Agent and Code.
  const reaShown = reaInPlugins(isTauri(), agentTools)
  const reaOn = useSettingsStore((s) => s.settings.reaPluginEnabled === true) && reaShown
  const anyPluginActive = !!(isCavemanActive || isPersonaActive || isGroupActive || createOn || reaOn)

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
          <span className="@max-[26rem]:sr-only">Plugins</span>
          {anyPluginActive && (
            <div className="flex gap-0.5">
              {createOn && <div data-testid="plugins-dot-create" className="w-1 h-1 rounded-full bg-lu-accent" />}
              {reaOn && <div data-testid="plugins-dot-rea" className="w-1 h-1 rounded-full bg-teal-400" />}
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
          <div ref={menuRef} style={menu.style} className={`absolute right-0 z-50 w-56 rounded-lg lu-elevated py-1.5 overflow-y-auto scrollbar-thin ${menu.nachOben ? 'bottom-full mb-1' : 'top-full mt-1'}`}>

            {/* Chat Tools are always on since 3.0.7 (lib/chat-tools-reach.ts):
                no switch here any more. */}
            <div className="px-2.5">
              {/* ── Create toggle ───────────────────────────── */}
              {create.shown && (
                <>
                  <div className="w-full flex items-center justify-between py-1.5 gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Sparkles size={10} className={`shrink-0 ${createOn ? 'text-lu-accent' : 'text-gray-400'}`} />
                      <span className="shrink-0 t-micro font-medium text-gray-600 dark:text-gray-300">Create</span>
                      <BetaMark feature="create-in-chat" />
                      <span className="t-micro text-gray-400 truncate">image · video · music · voice</span>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); if (create.available) updateSettings({ createEnabled: !createSetting }) }}
                      disabled={!create.available}
                      aria-pressed={createOn}
                      aria-label="Create"
                      data-testid="plugins-create-switch"
                      title={!create.available ? create.reason : createOn ? 'Turn off Create in chat' : 'Images, video, music and voice in chat'}
                      className={
                        'shrink-0 flex items-center w-7 h-3.5 rounded-full transition-colors ' +
                        (!create.available
                          ? 'bg-gray-300/20 dark:bg-white/5 cursor-default justify-start'
                          : createOn
                            ? 'bg-lu-accent/45 hover:bg-lu-accent/60 justify-end'
                            : 'bg-gray-300/30 dark:bg-white/10 hover:bg-gray-300/45 dark:hover:bg-white/15 justify-start')
                      }
                    >
                      <span className={`w-3 h-3 rounded-full shadow-sm mx-px ${create.available ? 'bg-white' : 'bg-white/40'}`} />
                    </button>
                  </div>
                  {!create.available && (
                    // A reason, not an error: the calm grey of lib/hinweis.ts,
                    // like the line under Chat Tools.
                    <div data-testid="plugins-create-reason" className={`pb-1.5 t-micro leading-snug ${HINWEIS_TEXT.ruhig}`}>
                      {create.reason}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* ── REA, reverse engineering for the agents ────── */}
            {reaShown && <Suspense fallback={null}><ReaPluginRow /></Suspense>}

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
                    {personaLabel}
                  </span>
                  <ChevronDown size={9} className={`text-gray-500 transition-transform ${personaOpen ? 'rotate-180' : ''}`} />
                </button>
                {/* On/off toggle for THIS chat — Remote already had this
                    via `personaEnabled`; now Chat / Code / Agent match.
                    Always shown when a chat is open (the owner: "personas hat im
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
                        onClick={() => {
                          // The app wide pick stays the start of every new
                          // chat; the open chat takes the persona for itself.
                          setActivePersona(p.id)
                          if (activeConvId) setConversationPersona(activeConvId, p)
                          setPersonaOpen(false)
                        }}
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
                  <span data-testid="group-chat-count" className={`text-[0.55rem] ${isGroupActive ? 'text-purple-400' : 'text-gray-500'}`}>
                    {isGroupActive
                      ? `${answering} ${answering === 1 ? 'model' : 'models'}${unavailableCount > 0 ? `, ${unavailableCount} unavailable` : ''}`
                      : 'Off'}
                  </span>
                </div>
                <ChevronDown size={9} className={`text-gray-500 transition-transform ${groupOpen ? 'rotate-180' : ''}`} />
              </button>

              {groupOpen && (activeConvId ? (
                <div className="pb-1.5 space-y-0.5 max-h-[220px] overflow-y-auto scrollbar-thin">
                  <p className="px-2 pb-0.5 text-[0.5rem] leading-snug text-gray-400">
                    Pick 2 to {GROUP_CHAT_MAX} models. They answer in turn on every message, and each sees what the others said. Each one can speak as its own persona.
                  </p>
                  {groupRows.map((m) => {
                    const on = groupModels.includes(m.name)
                    const full = !on && groupModels.length >= GROUP_CHAT_MAX
                    // The persona THIS participant speaks as. None picked (or a
                    // persona that was deleted since) means it follows the
                    // chat's own persona setting, as every group did before.
                    const ownPersona = allPersonas.find((p) => p.id === groupPersonas?.[m.name])
                    const listOpen = on && personaFor === m.name
                    return (
                      <div key={m.name} data-testid="group-participant" data-model={m.name} data-unavailable={m.unavailable || undefined}>
                        <div
                          className={`flex items-center rounded transition-colors ${
                            m.unavailable
                              ? 'bg-gray-500/10 text-gray-400'
                              : on ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400' : ''
                          }`}
                        >
                          <button
                            disabled={full}
                            onClick={() => {
                              if (on) setPersonaFor(null)
                              setGroupModels(
                                activeConvId,
                                on ? groupModels.filter((x) => x !== m.name) : [...groupModels, m.name],
                              )
                            }}
                            className={`flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1 rounded text-left transition-colors ${
                              on
                                ? ''
                                : full
                                  ? 'text-gray-400/50 cursor-default'
                                  : 'text-gray-500 hover:bg-gray-50 dark:hover:bg-white/[0.04] hover:text-gray-700 dark:hover:text-gray-300'
                            }`}
                          >
                            {on && <div className={`w-1 h-1 rounded-full shrink-0 ${m.unavailable ? 'bg-gray-400' : 'bg-purple-400'}`} />}
                            <span
                              className={`text-[0.55rem] font-medium truncate ${m.unavailable ? 'line-through' : ''}`}
                              title={m.unavailable
                                ? `${displayModelName(m.name)} is not in the model list right now. It sits out until its model is back.`
                                : displayModelName(m.name)}
                            >
                              {displayModelName(m.name)}
                            </span>
                            {/* GitHub #173: a model of an additional backend
                                names that backend, so the same model on two
                                servers is two choices the user can tell apart. */}
                            {m.providerEntry && (
                              <span data-testid="group-participant-backend" className="t-micro text-gray-400 truncate shrink-0 max-w-[40%]">{m.providerName}</span>
                            )}
                          </button>
                          {on && (
                            <button
                              onClick={() => setPersonaFor(listOpen ? null : m.name)}
                              aria-expanded={listOpen}
                              aria-label={`Persona for ${displayModelName(m.name)}`}
                              title="The persona this model speaks as in this chat"
                              data-testid="group-persona-trigger"
                              className="shrink-0 max-w-[45%] flex items-center gap-0.5 px-1.5 py-1 rounded t-micro hover:bg-purple-500/15 transition-colors"
                            >
                              <User size={8} className="shrink-0" />
                              <span className="truncate">{ownPersona?.name ?? 'Chat persona'}</span>
                              <ChevronDown size={8} className={`shrink-0 transition-transform ${listOpen ? 'rotate-180' : ''}`} />
                            </button>
                          )}
                          {m.unavailable && (
                            // Out of the group in one click, without bringing
                            // the model back first (GH #165).
                            <button
                              onClick={() => {
                                if (personaFor === m.name) setPersonaFor(null)
                                setGroupModels(activeConvId, groupModels.filter((x) => x !== m.name))
                              }}
                              aria-label={`Remove ${displayModelName(m.name)} from the group`}
                              title="Remove from the group"
                              data-testid="group-participant-remove"
                              className="shrink-0 p-1 rounded text-gray-400 hover:bg-gray-500/15 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
                            >
                              <X size={9} />
                            </button>
                          )}
                        </div>
                        {m.unavailable && (
                          <p data-testid="group-participant-unavailable" className="px-2 pb-0.5 text-[0.5rem] leading-snug text-gray-400">
                            Not in the model list right now, so it sits out.
                          </p>
                        )}
                        {listOpen && (
                          <div data-testid="group-persona-list" className="ml-3 my-0.5 pl-1.5 border-l border-purple-400/30 space-y-0.5">
                            {[{ id: null, name: 'Chat persona' }, ...allPersonas].map((p) => {
                              const picked = (ownPersona?.id ?? null) === p.id
                              return (
                                <button
                                  key={p.id ?? 'chat-persona'}
                                  onClick={() => { setGroupPersona(activeConvId, m.name, p.id); setPersonaFor(null) }}
                                  aria-pressed={picked}
                                  title={p.id === null ? 'Follow the persona setting of this chat' : undefined}
                                  className={`w-full flex items-center gap-1.5 px-1.5 py-0.5 rounded text-left transition-colors ${
                                    picked
                                      ? 'text-purple-600 dark:text-purple-400'
                                      : 'text-gray-500 hover:bg-gray-50 dark:hover:bg-white/[0.04] hover:text-gray-700 dark:hover:text-gray-300'
                                  }`}
                                >
                                  {picked && <div className="w-1 h-1 rounded-full bg-purple-400 shrink-0" />}
                                  <span className="t-micro truncate">{p.name}</span>
                                </button>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {groupModels.length === 1 && (
                    <p className="px-2 text-[0.5rem] text-gray-400">One more model turns this into a group.</p>
                  )}
                  {groupModels.length > 0 && (
                    <button
                      onClick={() => { setPersonaFor(null); setGroupModels(activeConvId, []) }}
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
