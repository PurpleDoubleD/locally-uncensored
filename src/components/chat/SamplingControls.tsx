import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { usePopoverPlatz } from '../../hooks/usePopoverPlatz'
import { X, SlidersHorizontal } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useChatStore } from '../../stores/chatStore'
import { useAgentModeStore } from '../../stores/agentModeStore'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { useDismissOnEscape } from '../../hooks/useDismissOnEscape'
import { SAMPLING_DEFAULTS, TEMPERATURE_MAX, AGENT_TEMPERATURE_MAX, TEMPERATURE_HELP, TEMPERATURE_HELP_LABEL, effectiveSampling, samplingIsChanged, hasOwnSampling, isHighTemperature } from '../../lib/sampling'
import { resetTemperatureToDefault } from '../../lib/temperature-reset'
import { HighTemperatureWarning } from './HighTemperatureWarning'
import { HelpMark } from '../ui/HelpMark'
import { CustomParamsEditor, CUSTOM_PARAMS_LABEL } from './CustomParamsEditor'
import type { SamplingOverrides } from '../../lib/sampling'
import { isGroupChat } from '../../lib/group-chat'
import { speakerSamplingLines, type SpeakerSamplingLine } from '../../lib/speaker-sampling-lines'
import { useModelStore } from '../../stores/modelStore'
import { useProviderStore } from '../../stores/providerStore'
import { getProviderIdFromModel, isOpenAISlotModel } from '../../api/providers/model-name'
import { samplerTargetOfModel } from '../../lib/lan-openai-slot'
import {
  THINK_BUDGET_STEP, normalizeThinkBudget, thinkBudgetHint, thinkBudgetSupport,
} from '../../lib/think-budget'

/**
 * Sampling controls next to the composer, scoped to ONE conversation.
 *
 * R5-10/R5-11 (3.0.1-Liste): until 18.09.2026 this panel read and wrote the
 * global Settings page, so every open chat shared one temperature and a
 * slider moved in chat A also moved chat B's next request. Two earlier
 * bauers left the rewrite as "braucht Entscheid" (bau/w2ui.md); the values
 * now live on the CONVERSATION (`Conversation.sampling`, src/lib/sampling.ts):
 * a moved slider applies to this chat only, and a chat that never moved a
 * given slider keeps following the Settings page for that field, exactly as
 * every chat did before this change.
 *
 * Every catalogue model accepts these parameters (measured 2026-09-10, no
 * request was rejected for one). Reasoning models accept them and react less,
 * which the help line says instead of hiding the control.
 *
 * ## Why this is a popup and not an inline panel
 *
 * 2026-09-11: "der sample anklickbar im prompt fenster muss ein pop up
 * sein, und nicht das prompt fenster veraendern. mit einem sauberen x zum
 * wegklicken und nicht einfach wieder auf den text klicken zum entfernen, soll
 * windows mac und webapp ueberall gleich sein."
 *
 * The first version rendered the fields as a sibling below the trigger, inside
 * the composer's flow. Opening them therefore grew the whole prompt window by
 * the height of the panel and pushed the text field down under the cursor,
 * which is the one thing the prompt window may not do. The panel is now taken
 * out of the flow (absolute, anchored to the top edge of the trigger, the same
 * placement the model picker next to it uses), so the row it hangs off keeps
 * its size and position to the pixel.
 *
 * Three rules follow from the same sentence, and the web app implements them
 * word for word:
 *   - closing is the X, or Escape, or a press outside. SAMPLING_CLOSE_LABEL is
 *     the accessible name of that button in BOTH apps.
 *   - the trigger opens and only opens. A second click on it used to make the
 *     panel vanish under the pointer, which is what "nicht einfach wieder auf
 *     den text klicken zum entfernen" asks to stop.
 *   - the keyboard goes into the popup when it opens and back to the trigger
 *     when it closes.
 */
/**
 * ## Why Top K is not in this list
 *
 * It used to be, and it moved nothing on the paid default path: the
 * OpenAI-compatible body has no field for it, and `openai-provider.ts` never
 * reads `options.topK` at all, so on LU Cloud and on this app's own engine the
 * slider was a dead control with no feedback. The same value also had two
 * scales, `0..200` here against `1..100` on the settings page, so this popup
 * could write a 150 that the other control cannot even display.
 *
 * Top K stays on the settings page, where Ollama and Anthropic read it
 * (`ollama-provider.ts:150`, `anthropic-provider.ts:320`). That is the same
 * arrangement the web app describes in the web app.
 */
const FIELDS = [
  { key: 'temperature', label: 'Temperature', min: 0, max: TEMPERATURE_MAX, step: 0.05 },
  { key: 'topP', label: 'Top P', min: 0, max: 1, step: 0.01 },
] as const

/**
 * Why "Max tokens" carries a draft string instead of the plain number.
 *
 * React keeps a controlled `<input type="number">` in step with a LOOSE
 * comparison (`node.value != value`). With a number on the prop side that
 * comparison coerces, so "0512" and 512 count as equal and the DOM keeps the
 * string it already had. Typing 512 into a field showing 0 therefore left
 * `0512` on screen forever, and the field looked like it appended instead of
 * replacing (measured on the box, T1 nebenfund 5). Handing React a STRING
 * turns the same comparison into a string comparison, so the normalised text
 * really lands in the DOM. The draft covers the other half: while the field is
 * focused an empty box must stay empty, otherwise nobody can clear it to type
 * a new number.
 */
export function normalizeMaxTokens(raw: string): number {
  if (raw.trim() === '') return SAMPLING_DEFAULTS.maxTokens
  return Math.max(0, Math.trunc(Number(raw)) || 0)
}

/** The close button's accessible name. Word for word the same string as in the
 *  web app (the web app), which a parity test there re-reads from
 *  this file: one close button on Windows, Mac and the web app. */
export const SAMPLING_CLOSE_LABEL = 'Close sampling settings'

/** What the popup is called for a screen reader. Same string in both apps. */
export const SAMPLING_DIALOG_LABEL = 'Sampling settings'

/** Panel width, in the same 248 px the web app gives it. */
const PANEL_WIDTH = 248

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Accessible name of the think budget field, shared with its tests. */
export const THINK_BUDGET_LABEL = 'Think budget'

/**
 * Think budget row (D12). Global like the Think button beside the popup, so
 * it does not follow this chat's Reset and says so in its title.
 *
 * Shown for every model, and disabled with a plain sentence where the backend
 * has no budget field: a field that takes a number and then does nothing
 * would be a control that lies (lib/think-budget.ts lists who takes what).
 */
function ThinkBudgetRow() {
  const [draft, setDraft] = useState<string | null>(null)
  const budget = useSettingsStore((s) => normalizeThinkBudget(s.settings.thinkingBudget))
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const activeModel = useModelStore((s) => s.activeModel)
  const managedEngine = useProviderStore((s) => s.providers.openai?.managed === true)
  // Only the slot itself can be our engine, never an additional entry (#173).
  const support = thinkBudgetSupport(getProviderIdFromModel(activeModel ?? ''), managedEngine && isOpenAISlotModel(activeModel ?? ''))
  const supported = support !== 'none'
  return (
    <div className="space-y-0.5" data-testid="think-budget-row">
      <label className="flex items-center gap-2">
        <span className="w-20 shrink-0 text-gray-400">{THINK_BUDGET_LABEL}</span>
        <input
          type="number"
          className="min-w-0 flex-1 rounded border border-gray-700 bg-transparent px-1 py-0.5 disabled:opacity-40"
          min={0}
          step={THINK_BUDGET_STEP}
          disabled={!supported}
          value={draft ?? String(budget)}
          aria-label={THINK_BUDGET_LABEL}
          title="Most tokens the model may spend thinking while Think is on. 0 = auto. Applies to every chat."
          onChange={(e) => {
            const raw = e.target.value
            const next = raw.trim() === '' ? 0 : normalizeThinkBudget(Number(raw))
            setDraft(raw.trim() === '' ? raw : String(next))
            updateSettings({ thinkingBudget: next })
          }}
          onBlur={() => setDraft(null)}
        />
        <span className="w-10 shrink-0 text-right text-gray-500">{supported && budget === 0 ? 'auto' : ''}</span>
      </label>
      <p className="text-gray-500" data-testid="think-budget-hint">{thinkBudgetHint(support, budget)}</p>
    </div>
  )
}

export function SamplingControls() {
  const [open, setOpen] = useState(false)
  const [tempHelp, setTempHelp] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const lage = usePopoverPlatz(panelRef, open, { bevorzugt: 'oben', abstand: 6, breiteDeckeln: true })
  const panelId = useId()
  const settings = useSettingsStore((s) => s.settings)
  const activeId = useChatStore((s) => s.activeConversationId)
  // Only re-renders when THIS chat's own sampling changes, not on every
  // message or on a different chat's edit.
  const overrides = useChatStore((s) =>
    s.activeConversationId
      ? s.conversations.find((c) => c.id === s.activeConversationId)?.sampling
      : undefined
  )
  const setSampling = useChatStore((s) => s.setConversationSampling)
  // GH #198: this chat's own custom rows.
  const customRows = useChatStore((s) =>
    s.activeConversationId
      ? s.conversations.find((c) => c.id === s.activeConversationId)?.customParams
      : undefined
  )
  const setCustomRows = useChatStore((s) => s.setConversationCustomParams)
  const agentMode = useAgentModeStore((s) => (activeId ? s.agentModeActive[activeId] === true : false))
  const resetSampling = useChatStore((s) => s.resetConversationSampling)
  // GH #175: who speaks in this chat, and which persona preset holds for
  // each. Only the fields the lines read, so a streaming answer does not
  // re-render the popup.
  const personaId = useChatStore((s) => s.conversations.find((c) => c.id === s.activeConversationId)?.personaId)
  const keptPrompt = useChatStore((s) => s.conversations.find((c) => c.id === s.activeConversationId)?.systemPrompt)
  const personaEnabled = useChatStore((s) => s.conversations.find((c) => c.id === s.activeConversationId)?.personaEnabled)
  const groupModels = useChatStore((s) => s.conversations.find((c) => c.id === s.activeConversationId)?.groupModels)
  const groupPersonas = useChatStore((s) => s.conversations.find((c) => c.id === s.activeConversationId)?.groupPersonas)
  const personas = useSettingsStore((s) => s.personas)
  const activePersonaId = useSettingsStore((s) => s.activePersonaId)
  const activeModel = useModelStore((s) => s.activeModel)
  const providers = useProviderStore((s) => s.providers)
  // Read so the lines follow an entry switched on, off or moved (#173).
  useProviderStore((s) => s.openaiEntries)
  const lines: SpeakerSamplingLine[] = speakerSamplingLines({
    settings,
    conv: { personaId, systemPrompt: keptPrompt, personaEnabled, groupModels, groupPersonas, sampling: overrides, customParams: customRows },
    activeModel,
    personas,
    activePersonaId,
    providers,
    // GitHub #173: a speaker on an additional entry answers for its own server.
    targetOf: samplerTargetOfModel,
  })
  // The sliders write THIS chat's own value. In a plain chat they show what
  // holds for its one speaker, the persona preset included. In a group the
  // moved value holds for every member, so they show the chat's own value or
  // the Settings page, and the lines below say what each member runs on.
  const sliderPreset = isGroupChat(groupModels) ? undefined : lines[0]?.preset

  const value = effectiveSampling(settings, overrides, sliderPreset)
  const changed = samplingIsChanged(settings, overrides, sliderPreset) || (customRows?.length ?? 0) > 0
  // F1 (review-w2ui.md, 18.09.2026): Reset only deletes THIS chat's own
  // override, so it must go by whether one exists, not by whether the
  // EFFECTIVE value differs from the shipped default (`changed` above): that
  // is also true when only the Settings page moved and this chat never
  // touched its own slider, and Reset then has nothing to delete.
  const ownSampling = hasOwnSampling(overrides) || (customRows?.length ?? 0) > 0
  const write = (patch: SamplingOverrides) => {
    if (activeId) setSampling(activeId, patch)
  }

  /** Give the keyboard back to the trigger, but only while it is still in the
   *  popup: on an outside press the browser is already moving it somewhere the
   *  user chose, and taking it back from them is worse than a lost menu.
   *
   *  The draft is dropped here as well, and that line is not redundant with the
   *  field's own onBlur. Measured 2026-09-11 against this component: an emptied
   *  Max tokens box survived every close path unless something moved the focus
   *  off the input first, because onBlur was the ONLY thing that cleared it.
   *  Today the focus move above happens to do that, so a real user never saw
   *  the stale box. That is luck, not a rule: whoever changes the focus rule
   *  next reopens the popup on an empty field while the store holds 0. The
   *  onBlur stays, because it covers the other half, leaving the field with the
   *  popup still open (Tab to Reset, grab a slider). */
  const close = useCallback(() => {
    const panel = panelRef.current
    if (panel && panel.contains(document.activeElement)) {
      wrapRef.current?.querySelector('button')?.focus()
    }
    setDraft(null)
    setOpen(false)
  }, [])

  const onEscape = useCallback(() => {
    close()
    wrapRef.current?.querySelector('button')?.focus()
  }, [close])
  useDismissOnEscape(open, onEscape)

  // pointerdown, not mousedown or click: a touch screen never sends mousedown
  // before the tap completes. The panel lives inside the wrapper, so one
  // containment test covers the trigger and the popup together.
  useEffect(() => {
    if (!open) return
    const aus = (e: Event) => {
      const target = e.target as Node | null
      if (!target) return
      if (wrapRef.current?.contains(target)) return
      close()
    }
    document.addEventListener('pointerdown', aus)
    return () => document.removeEventListener('pointerdown', aus)
  }, [open, close])

  // The keyboard follows the popup. The X is the first control in it, which is
  // where a dialog's focus conventionally lands and, more to the point, is the
  // way out for someone who never reaches for Escape.
  useEffect(() => {
    if (!open) return
    panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
  }, [open])

  // ChatInput only mounts the composer once a conversation exists (the
  // launcher shows instead), so this is "mounted without a chat", not a state
  // a user can actually reach. Nothing to write to means nothing to show.
  if (!activeId) return null

  return (
    <div className="relative text-xs" ref={wrapRef} data-testid="sampling-controls">
      <button
        type="button"
        // The composer row's own recipe, like Think and Docs beside it. It
        // was plain text-xs (12px) in a row of 9.6px controls.
        className="lu-control"
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="sampling-trigger"
        // Word for word the web app's trigger (the web app),
        // so the button has one name on Windows,
        // Mac and the web app instead of being read out as a bare number.
        title="Sampling for this chat"
        aria-label={`Sampling: temperature ${value.temperature}`}
        // Opens, never closes. A trigger that also closed made the panel
        // disappear under the pointer on the second click.
        onClick={() => setOpen(true)}
      >
        {/* In a narrow composer (the row is the @container, ChatInput.tsx)
            an icon stands in for the word; title and aria-label keep it. */}
        <SlidersHorizontal size={10} className="hidden @max-[30rem]:inline-block mr-1 -mt-px" />
        <span className="@max-[30rem]:hidden">Sampling: </span>
        {value.temperature.toFixed(2)}
        {/* Ein geaenderter Regler ist kein Zwischenfall, also traegt der
            Stern den ruhigen Ton und keine eigene Warnfarbe. */}
        {/* A temperature that makes noise is a problem, not a preference, so
            from TEMPERATURE_WARN up the star takes the warning colour (A33). */}
        {changed && (
          <span
            className={`ml-1 ${isHighTemperature(value.temperature) ? HINWEIS_TEXT.fehler : HINWEIS_TEXT.ruhig}`}
            title={isHighTemperature(value.temperature) ? 'Temperature is high, answers may be random text' : 'Changed from the defaults'}
            data-testid="sampling-changed-marker"
          >
            {isHighTemperature(value.temperature) ? '!' : '*'}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={SAMPLING_DIALOG_LABEL}
          data-testid="sampling-panel"
          // Placed with an inline style rather than utility classes, for the
          // same reason the web app does: `position` is then a fact a test can
          // read, instead of a class name a test would have to believe.
          // Above the trigger while it fits there; in a short window it takes
          // the side with room and scrolls instead of leaving the window.
          style={{
            position: 'absolute',
            right: 0,
            ...(lage.nachOben ? { bottom: '100%', marginBottom: 6 } : { top: '100%', marginTop: 6 }),
            width: PANEL_WIDTH,
            overflowY: 'auto',
            ...lage.style,
          }}
          className="z-50 space-y-2 rounded-lg p-2.5 lu-elevated scrollbar-thin"
        >
          <div className="flex justify-end">
            <button
              type="button"
              aria-label={SAMPLING_CLOSE_LABEL}
              title={SAMPLING_CLOSE_LABEL}
              data-testid="sampling-close"
              className="rounded p-0.5 text-gray-500 hover:text-gray-300"
              onClick={close}
            >
              <X size={11} />
            </button>
          </div>

          {FIELDS.map((f) => (
            <div key={f.key}>
            <label className="flex items-center gap-2">
              <span className="w-20 shrink-0 flex items-center gap-1 text-gray-400">
                {f.label}
                {f.key === 'temperature' && (
                  <HelpMark
                    text={TEMPERATURE_HELP}
                    label={TEMPERATURE_HELP_LABEL}
                    open={tempHelp}
                    onToggle={() => setTempHelp((v) => !v)}
                    testId="temperature-help"
                  />
                )}
              </span>
              <input
                type="range"
                className="min-w-0 flex-1"
                min={f.min}
                max={f.max}
                step={f.step}
                value={value[f.key]}
                aria-label={f.label}
                onChange={(e) => write({ [f.key]: Number(e.target.value) })}
              />
              <span className="w-10 shrink-0 text-right tabular-nums text-gray-300">{value[f.key]}</span>
            </label>
            {f.key === 'temperature' && tempHelp && (
              <p className="mt-1 leading-relaxed text-gray-500" data-testid="temperature-help-text">{TEMPERATURE_HELP}</p>
            )}
            </div>
          ))}

          <HighTemperatureWarning
            temperature={value.temperature}
            onReset={() => {
              setDraft(null)
              resetTemperatureToDefault(activeId)
            }}
          />
          {agentMode && value.temperature > AGENT_TEMPERATURE_MAX && (
            <p className="text-gray-500" data-testid="agent-temperature-hint">
              Agent turns use at most {AGENT_TEMPERATURE_MAX.toFixed(1)}, so tool calls stay valid.
            </p>
          )}

          <label className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-gray-400">Max tokens</span>
            <input
              type="number"
              className="min-w-0 flex-1 rounded border border-gray-700 bg-transparent px-1 py-0.5"
              min={0}
              step={128}
              value={draft ?? String(value.maxTokens)}
              aria-label="Max tokens"
              onChange={(e) => {
                const raw = e.target.value
                const next = normalizeMaxTokens(raw)
                setDraft(raw.trim() === '' ? raw : String(next))
                write({ maxTokens: next })
              }}
              onBlur={() => setDraft(null)}
            />
            <span className="w-10 shrink-0 text-right text-gray-500">{value.maxTokens === 0 ? 'auto' : ''}</span>
          </label>

          <ThinkBudgetRow />

          <div className="space-y-1 border-t border-gray-700/50 pt-1.5">
            <div className="text-gray-400">{CUSTOM_PARAMS_LABEL}</div>
            <CustomParamsEditor
              rows={customRows ?? []}
              onChange={(rows) => { if (activeId) setCustomRows(activeId, rows) }}
              inherited={!isGroupChat(groupModels) && lines[0]?.personaCustom?.length
                ? { source: lines[0].source.replace(/^Persona /, 'persona '), rows: lines[0].personaCustom }
                : undefined}
            />
          </div>

          {lines.length > 0 && (
            <div data-testid="sampling-speakers" className="space-y-1 border-t border-gray-700/50 pt-1.5">
              {lines.map((line) => (
                <div key={line.model} data-testid="sampling-speaker" data-model={line.model} className="space-y-0.5">
                  <div className="text-gray-300">
                    {line.label}: <span className="text-gray-400">{line.source}</span>
                  </div>
                  <div className="text-gray-500 break-words">
                    {line.values.map((v, i) => (
                      <span key={v.label} title={v.sent ? undefined : 'This backend does not read this value, it is not sent.'}>
                        {i > 0 && ' · '}
                        <span>{v.label} {v.text}{v.sent ? '' : ' (not sent)'}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between pt-1">
            <span className="text-gray-500">Reasoning models accept these and react less to them.</span>
            <button
              type="button"
              className="text-gray-400 underline disabled:opacity-40"
              disabled={!ownSampling}
              title={
                ownSampling
                  ? undefined
                  : 'This chat has no values of its own yet, it already follows the Settings page.'
              }
              onClick={() => {
                setDraft(null)
                // Deletes this chat's own values (the orchestrator's
                // decision, R5-10/R5-11, F2): the chat goes back to following
                // the Settings page, rather than pinning today's defaults
                // into it forever the way a plain "write the defaults" reset
                // would.
                if (activeId) resetSampling(activeId)
              }}
            >
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
