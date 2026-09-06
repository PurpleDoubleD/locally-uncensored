import { useState } from 'react'
import { useDismissOnEscape } from '../../hooks/useDismissOnEscape'
import { ChevronDown, ShieldCheck, Zap, ClipboardList } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useCodexStore } from '../../stores/codexStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useGenerationStore } from '../../stores/generationStore'
import { HINWEIS_TEXT, PUNKT_FARBE } from '../../lib/hinweis'
import {
  CODEX_MODES, CODEX_MODE_LABELS, CODEX_MODE_SHORT, CODEX_MODE_DESCRIPTIONS,
  resolveCodexMode, type CodexMode,
} from '../../lib/codex-mode'

/**
 * Ask / Bypass / Plan for the Coding Agent (plan 2.6.6, C1).
 *
 * Lives in the CODE composer only, hooked in through ChatInput's
 * `composerActions` so ChatInput itself stays surface-neutral and the Chat tab
 * inherits nothing. The mode is remembered per conversation, with
 * settings.codexDefaultMode as the fallback; picking one here NEVER writes the
 * global settings, so another conversation and the Agent surface are untouched.
 *
 * A switch takes effect from the NEXT send. While a run is in flight the
 * trigger says so and the pick is parked, because the running turn resolved its
 * knobs when it started and quietly changing them mid-run is how a read-only
 * guarantee gets lost.
 */
const MODE_ICON: Record<CodexMode, typeof ShieldCheck> = {
  ask: ShieldCheck,
  bypass: Zap,
  plan: ClipboardList,
}

/**
 * Die drei Modi sind eine Kategorie, keine Ampel: eine Farbe pro Modus, damit
 * man den aktiven am Ausloeser erkennt, ohne ihn zu lesen.
 *
 * Bypass stand in Gelb und sah damit aus wie eine Dauerwarnung, obwohl im
 * Betrieb nichts falsch ist, wenn er an ist. Neu ist Blaugruen, und zwar
 * gegen die drei Farben geprueft, die in dieser Datei sonst noch vorkommen:
 * Blau gehoert Ask, Violett gehoert Plan, und das Gruen von `PUNKT_FARBE.an`
 * gehoert dem Punkt, der sagt, dass gerade ein Lauf laeuft.
 */
const MODE_ACCENT: Record<CodexMode, string> = {
  ask: 'text-blue-400',
  bypass: 'text-teal-400',
  plan: 'text-purple-400',
}

const MODE_ACTIVE_ROW: Record<CodexMode, string> = {
  ask: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  bypass: 'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  plan: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
}

export function CodexModeDropdown({ openUpward = false }: { openUpward?: boolean } = {}) {
  const [open, setOpen] = useState(false)
  useDismissOnEscape(open, () => setOpen(false))
  const activeConvId = useChatStore((s) => s.activeConversationId)
  const defaultMode = useSettingsStore((s) => s.settings.codexDefaultMode)
  const modeByConversation = useCodexStore((s) => s.modeByConversation)
  const parkedByConversation = useCodexStore((s) => s.parkedModeByConversation)
  const chooseCodexMode = useCodexStore((s) => s.chooseCodexMode)
  const generating = useGenerationStore((s) => s.generating)

  const runActive = !!activeConvId && generating[activeConvId] === true
  const current = resolveCodexMode(
    activeConvId ? modeByConversation[activeConvId] : undefined,
    defaultMode,
  )
  const parked = activeConvId ? parkedByConversation[activeConvId] : undefined
  // Only worth showing while a run holds the change back. Once it is applied,
  // parked and current are the same value.
  const pending = runActive && parked && parked !== current ? parked : null

  const CurrentIcon = MODE_ICON[current]

  const pick = (mode: CodexMode) => {
    if (!activeConvId) return
    chooseCodexMode(activeConvId, mode, runActive)
    setOpen(false)
  }

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen(!open)}
        title={
          runActive
            ? 'A run is in flight. A change here applies to the next message.'
            : CODEX_MODE_DESCRIPTIONS[current]
        }
        // whitespace-nowrap: this trigger grows when a run starts (the dot, or
        // a parked "then bypass"), and it sits in the composer row. Letting its
        // label break would put a second line inside the prompt window, which
        // is the thing the row was fixed for.
        className="flex items-center gap-1 whitespace-nowrap px-2 py-0.5 rounded border border-gray-200 dark:border-white/[0.06] hover:border-gray-400 dark:hover:border-white/15 text-gray-500 transition-colors text-[0.55rem]"
      >
        <CurrentIcon size={10} className={`shrink-0 ${MODE_ACCENT[current]}`} />
        <span className={MODE_ACCENT[current]}>{CODEX_MODE_SHORT[current]}</span>
        {pending ? (
          // Der geparkte Modus steht in SEINER Farbe, nicht in einer eigenen:
          // "then plan" in Violett sagt schon, worauf es hinausgeht. Vorher war
          // dieses Stueck gelb und behauptete damit einen dritten Zustand.
          <span className={`text-[0.5rem] ${MODE_ACCENT[pending]}`}>
            {`then ${CODEX_MODE_SHORT[pending]}`}
          </span>
        ) : runActive ? (
          // A run is in flight and nothing is parked yet. Say it on the
          // trigger, not only in the panel, so "applies to the next message" is
          // visible before the user clicks. Der Punkt sagt "laeuft", also die
          // gruene Stufe der Ampel aus `lib/hinweis.ts`; gelb hiess hier frueher
          // weder an noch aus.
          <span className={`w-1 h-1 shrink-0 rounded-full ${PUNKT_FARBE.an}`} />
        ) : null}
        <ChevronDown size={8} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className={`absolute right-0 z-50 w-60 rounded-lg lu-elevated py-1.5 ${openUpward ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
            {!activeConvId ? (
              <p className="px-3 py-1.5 text-[0.5rem] text-gray-400">
                Open a coding chat first, the mode lives on the conversation.
              </p>
            ) : (
              <>
                {runActive && (
                  // Auskunft, kein Alarm: die Wahl geht nicht verloren, sie
                  // wirkt nur spaeter. Ruhiger Ton aus `lib/hinweis.ts`.
                  <p className={`px-3 pb-1 text-[0.5rem] leading-snug ${HINWEIS_TEXT.ruhig}`}>
                    A run is in flight. Your pick applies from the next message.
                  </p>
                )}
                <div className="px-1.5 space-y-0.5">
                  {CODEX_MODES.map((mode) => {
                    const Icon = MODE_ICON[mode]
                    const isActive = mode === current
                    const isPending = mode === pending
                    return (
                      <button
                        key={mode}
                        onClick={() => pick(mode)}
                        className={`w-full flex items-start gap-1.5 px-2 py-1 rounded text-left transition-colors ${
                          isActive
                            ? MODE_ACTIVE_ROW[mode]
                            : 'text-gray-500 hover:bg-gray-50 dark:hover:bg-white/[0.04] hover:text-gray-700 dark:hover:text-gray-300'
                        }`}
                      >
                        <Icon size={10} className={`mt-px shrink-0 ${isActive ? '' : 'text-gray-400'}`} />
                        <span className="min-w-0">
                          <span className="flex items-center gap-1">
                            <span className="text-[0.55rem] font-medium">{CODEX_MODE_LABELS[mode]}</span>
                            {isActive && <span className="text-[0.45rem] text-gray-400">active</span>}
                            {isPending && (
                              // Wie am Ausloeser: in der Farbe des Modus, um
                              // den es geht, nicht in einer Warnfarbe.
                              <span className={`text-[0.45rem] ${MODE_ACCENT[mode]}`}>next</span>
                            )}
                          </span>
                          <span className="block text-[0.5rem] leading-snug text-gray-400">
                            {CODEX_MODE_DESCRIPTIONS[mode]}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
