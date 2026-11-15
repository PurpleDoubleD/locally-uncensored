import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useDismissOnEscape } from '../../hooks/useDismissOnEscape'
import { ChevronDown, Check, Loader2, AlertTriangle } from 'lucide-react'
import { useModelStore } from '../../stores/modelStore'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { getProviderIdFromModel, displayModelName } from '../../api/providers'
import { readLoadedModels, reloadOllamaWithWindow } from '../../api/ollama'
import { loadedOnCpuSentence } from '../../lib/ollama-window-fit'
import { loadLmStudioModel } from '../../api/lmstudio'
import { bundledEngineStatus, swapBundledModel } from '../../api/engine'
import { ollamaWindowFor } from '../../lib/context-window'
import { useActiveContextWindow, useActiveWindowUse } from '../../hooks/useActiveContextWindow'
// Eine Schreibweise fuer alle Kontextfenster, in lib/formatters. Vorher stand
// hier eine eigene Rechnung und im Fuellstand daneben eine zweite, und beide
// zeigten denselben Wert verschieden (Gegenprobe G2, 04.09.2026).
import { formatContextWindow } from '../../lib/formatters'
import { DEFAULT_SEND_WINDOW_TOKENS } from '../../lib/send-window'
import { ENGINE_DEFAULT_CTX } from '../../lib/builtin-ctx'
import { SOURCE_LABEL, withStoredWindow } from '../../lib/context-source'
import { savedLmStudioContext, withLmStudioPick } from '../../lib/lmstudio-context-pick'
import { usePopoverPlatz } from '../../hooks/usePopoverPlatz'
import { smallWindowNote } from '../../lib/context-breakdown'
import { ContextBreakdownPanel } from './ContextBreakdownPanel'

const PRESETS = [4096, 8192, 16384, 32768, 65536, 131072]
/** C77: what a hosted model's own window commonly is. */
const MODEL_WINDOW_PRESETS = [8192, 16384, 32768, 65536, 131072, 262144, 1048576]

/**
 * Context-window picker for the active LOCAL model. Sets `contextWindowOverride`
 * and AUTO-RELOADS the model so the change takes effect immediately:
 *   - Ollama:    warm the model with the new num_ctx (Ollama reloads its runner).
 *   - LM Studio: `lms load -c <N>` (unload + reload, context is load-time there).
 *   - Built-in:  ctx lives in settings.builtinEngine (expert tuning), the
 *                engine relaunches with the new -c via swapBundledModel.
 * Cloud models: their own window is fixed, so the pick there is the send
 * window per model (settings.cloudSendWindowByModel), saved without a reload.
 *
 * D-S06, „Zwei Kontextanzeigen 24px nebeneinander in verschiedener Notation:
 * ‚32/8.2k' und ‚ctx 8K' → eine."
 *
 * Beide zeigten DIESELBE Zahl: der Nenner des Fuellstands und die Beschriftung
 * dieses Knopfes sind dasselbe Kontextfenster, einmal als „8.2k" (Tausender)
 * und einmal als „8K" (Kibi). Wer den Unterschied las, suchte einen, den es
 * nicht gibt.
 *
 * Aufgeloest wird das nicht dadurch, dass eine der beiden verschwindet, denn der
 * Fuellstand ist die einzige Stelle, die den VERBRAUCH zeigt, und dieser Knopf
 * ist die einzige Stelle, die das Fenster AENDERT. Aufgeloest wird es dadurch,
 * dass der Fuellstand die Beschriftung DIESES Knopfes wird: ein Element, eine
 * Zahl, und der Messwert sitzt auf dem Regler, der ihn bewegt.
 *
 * Die Ausweichfaelle, beide bewusst:
 *   - Kein Fuellstand (leerer Chat, `TokenCounter` gibt dort `null` zurueck,
 *     und das ist in `token-usage.test.ts` festgenagelt): der Knopf traegt
 *     wieder das Fenster allein. Beide Schreibweisen sind dann nie gleichzeitig
 *     zu sehen, also gibt es auch nichts zu vergleichen.
 *   - Nicht verstellbar (Cloud-Modelle): der Knopf verschwindet, aber der
 *     Fuellstand bleibt, er wird dann OHNE Rahmen ausgegeben. Ohne diesen
 *     Zweig haette das Zusammenlegen den Fuellstand auf Cloud-Modellen mit
 *     entfernt, wo er vorher stand.
 */
export function ContextDropdown({ children }: { children?: ReactNode }) {
  // `useId` und keine Modulkonstante: die Kopfzeile kann diesen Knopf mehr als
  // einmal rendern (Vergleichsmodus), und doppelte `id`s machen aus
  // `aria-labelledby` einen Zeiger auf den erstbesten Treffer im Dokument.
  const uid = useId()
  const labelId = `${uid}-ctx-label`
  const valueId = `${uid}-ctx-value`
  const activeModel = useModelStore((s) => s.activeModel)
  const override = useSettingsStore((s) => s.settings.contextWindowOverride)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [open, setOpen] = useState(false)
  useDismissOnEscape(open, () => setOpen(false))
  /* Wohin die Liste aufgeht, gemessen statt angenommen.
   *
   * Der Befund vom 07.09.2026: die Liste ging fest nach unten auf, und ihr
   * Ausloeser ist mit dem 2.6.8-Umbau der Eingabezeile an den unteren Rand
   * gewandert. Gemessen bei 1280x800 hing sie 74 px unter dem Fensterrand und
   * wurde vom `overflow-hidden` der Pane schon 9 px frueher abgeschnitten: von
   * 188 px waren 105 zu sehen.
   *
   * Fest nach oben zu kippen waere der falsche Ausgang. Derselbe Knopf steht
   * im Code-Bereich (`CodexView`) in einer Kopfzeile, dort ist oben kein Platz
   * und unten reichlich. Deshalb wird gemessen, und zwar gegen die Flaeche,
   * die tatsaechlich schneidet. Seit GitHub #149 misst das nicht mehr dieses
   * Bauteil selbst, sondern `usePopoverPlatz`, derselbe Haken wie fuer jedes
   * andere Aufklappmenue der App.
   */
  const listeRef = useRef<HTMLDivElement>(null)
  const platz = usePopoverPlatz(listeRef, open, { breiteDeckeln: true })
  const [busy, setBusy] = useState(false)
  // Reload failure, surfaced instead of swallowed: the engine's start error
  // (out of memory for the new ctx, port held by a stranger) is actionable,
  // and a silent catch here would bury exactly the honest message the Rust
  // side now produces. Cleared on the next attempt or by clicking it away.
  const [applyError, setApplyError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const ctx = useActiveContextWindow(tick)
  const windowUse = useActiveWindowUse()
  // What Ollama reports about the model as it is loaded right now, read when
  // the list opens and again after a change of the window has reloaded the
  // model. Said in the list, below the choices: this is where the window is
  // set, so this is where its price is shown. Never in or above the composer.
  const [cpuNote, setCpuNote] = useState<{ model: string; text: string } | null>(null)
  const ollamaModel = open && activeModel && ctx.provider === 'ollama' ? activeModel : null
  useEffect(() => {
    if (!ollamaModel) return
    let cancelled = false
    readLoadedModels()
      .then((loaded) => {
        if (cancelled) return
        const text = loadedOnCpuSentence(loaded.find((m) => m.name === ollamaModel))
        setCpuNote(text ? { model: ollamaModel, text } : null)
      })
      // Ollama did not answer: nothing is known, so nothing is said.
      .catch(() => { if (!cancelled) setCpuNote(null) })
    return () => { cancelled = true }
  }, [ollamaModel, tick])
  const builtinCtx = useSettingsStore((s) => s.settings.builtinEngine.ctx)
  // The check-mark anchor: built-in reads its own tuning field, not the
  // Ollama/LM Studio override.
  // GH #129: ein eigener OpenAI-kompatibler Server hat weder Ollamas num_ctx
  // noch die Expertenwerte des Motors. Seine Wahl liegt je Endpunkt und Modell
  // in `contextWindowByModel`, im SELBEN Speicher wie die beiden anderen
  // (settingsStore), nur unter einem Schluessel statt in einem festen Feld.
  const byModel = useSettingsStore((s) => s.settings.contextWindowByModel)
  const cloudPicks = useSettingsStore((s) => s.settings.cloudSendWindowByModel)
  const globalSendWindow = useSettingsStore((s) => s.settings.codexSendWindowTokens)
  const cloud = ctx.provider === 'cloud'
  const selected = ctx.provider === 'builtin'
    ? builtinCtx
    : ctx.provider === 'custom'
      ? (ctx.windowKey ? byModel?.[ctx.windowKey] ?? 0 : 0)
      : cloud
        ? (ctx.windowKey ? cloudPicks?.[ctx.windowKey] ?? 0 : 0)
        // GH #168: LM Studio's pick is saved per model, see
        // lib/lmstudio-context-pick. Ollama keeps the one shared num_ctx.
        : ctx.provider === 'lmstudio'
          ? (activeModel ? savedLmStudioContext({ contextWindowByModel: byModel }, activeModel) : 0)
          : override
  // Gibt es ueberhaupt einen Fuellstand zu zeigen? Genau die Bedingung, unter
  // der `TokenCounter` `null` zurueckgibt. Bewusst ein BOOLEAN als Selektor:
  // ein Abo auf `s.conversations` wuerde diesen Knopf bei jedem Streaming-Flush
  // neu rendern (T-45), ein Boolean wechselt einmal pro Chat.
  // C77: the model window the user gave a hosted API that names none.
  const modelWindowPick = ctx.modelWindowKey ? byModel?.[ctx.modelWindowKey] ?? 0 : 0
  const hasFill = useChatStore(
    (s) => (s.conversations.find((c) => c.id === s.activeConversationId)?.messages.length ?? 0) > 0,
  )

  // Nicht verstellbar (Cloud): kein Regler, aber der Fuellstand bleibt stehen.
  if (!activeModel || !ctx.adjustable) return <>{children}</>

  // Hinweis erst, wenn der Nutzer ueber den Standard gegangen ist, vorher
  // nicht (30.09.2026). Grau, kein Gelb (Regel vom 04.09.).
  const raised = cloud && ctx.sendWindow > DEFAULT_SEND_WINDOW_TOKENS

  // U5: a local model whose agent window is below 16K. Calm, grey, one line,
  // and one click to 32K through `apply`, the same lever as the list below.
  const smallNote = smallWindowNote({
    provider: ctx.provider,
    window: ctx.contextWindow,
    modelMax: ctx.modelMax,
    use: windowUse,
  })
  const meterWindow = ctx.sendWindow > 0 ? ctx.sendWindow : ctx.contextWindow

  /*
   * Die Liste endet an der Decke, und die Decke ist der groesste Eintrag.
   *
   * Vorher hiess der oberste Eintrag nur dann `· max`, wenn die Decke keine
   * der Voreinstellungen war. Bei einem Server, der mit 16384 laeuft, stand
   * deshalb ein schlichtes `16K` ganz oben, und darueber (vor dem Fix vom
   * 11.09.2026) noch `32K` und `40K · max`, die dieser Server gar nicht kann.
   * Jetzt fuehrt die Decke die Liste immer sichtbar an, und die
   * Voreinstellungen darueber fallen weg.
   */
  const cap = ctx.modelMax > 0 ? Math.max(ctx.modelMax, 4096) : 0
  // A cloud step carries the system prompt and the tool catalogue before any
  // history (about 5k to 8k tokens), so the two smallest rungs could not hold
  // a single turn there.
  const presets = PRESETS.filter((p) => (cap > 0 ? p < cap : true) && (!cloud || p >= 16384))
  /*
   * GH #166: no source named this Ollama model's maximum, so the list has no
   * ceiling and no `· max`. A value set in Settings that is none of the
   * presets (262144 for a KoboldCpp started that large) still gets its own
   * row, or the check mark would sit on nothing.
   */
  const unknownMax = ctx.provider === 'ollama' && ctx.maxUnknown === true
  const options = unknownMax && selected > 0 && !presets.includes(selected)
    ? [...presets, selected].sort((a, b) => a - b)
    : presets
  const showMax = cap > 0
  /*
   * Der Haken sitzt auf dem, was WIRKLICH gilt. Eine gespeicherte Wahl ueber
   * dem Fenster des Servers ist auf das Fenster geklemmt, und ein Haken auf
   * einer Zahl, die nirgends mehr in der Liste steht, waere unsichtbar.
   */
  const selectedNow = (ctx.clampedFrom ?? 0) > 0 ? ctx.contextWindow : selected

  /*
   * C77: the hosted API named no window, so this is what the model has, said
   * by the user. Saved per endpoint and model; the provider's cascade reads
   * it for the counter, the send window and the request budget. 0 = Auto.
   */
  const applyModelWindow = (value: number) => {
    setOpen(false)
    if (!ctx.modelWindowKey) return
    const current = useSettingsStore.getState().settings.contextWindowByModel
    updateSettings({ contextWindowByModel: withStoredWindow(current, ctx.modelWindowKey, value) })
    setTick((t) => t + 1)
    window.dispatchEvent(new Event('lu-context-reloaded'))
  }

  const apply = async (value: number) => {
    setOpen(false)
    /*
     * Cloud model: its own window is fixed, the pick is how much of the chat
     * each step SENDS (and pays for), saved per model. Nothing to reload, the
     * next request reads it through sendWindowFor. 0 = Auto (the default).
     */
    if (cloud) {
      if (!ctx.windowKey) return
      const next = { ...(useSettingsStore.getState().settings.cloudSendWindowByModel ?? {}) }
      if (value > 0) next[ctx.windowKey] = value
      else delete next[ctx.windowKey]
      updateSettings({ cloudSendWindowByModel: next })
      window.dispatchEvent(new Event('lu-context-reloaded'))
      return
    }
    /*
     * Eigener OpenAI-kompatibler Server: die Zahl ist eine Angabe DARUEBER,
     * was der Server geladen hat, kein Befehl AN ihn. Sein `-c` steht in
     * seiner eigenen Kommandozeile, LU kann es nicht setzen, also wird hier
     * auch nichts neu geladen. Gespeichert wird je Endpunkt und Modell; 0
     * loescht den Eintrag und die Abfrage entscheidet wieder.
     */
    if (ctx.provider === 'custom') {
      if (!ctx.windowKey) return
      const current = useSettingsStore.getState().settings.contextWindowByModel
      updateSettings({ contextWindowByModel: withStoredWindow(current, ctx.windowKey, value) })
      setTick((t) => t + 1)
      window.dispatchEvent(new Event('lu-context-reloaded'))
      return
    }
    // Built-in engine: ctx lives in the expert tuning, NOT contextWindowOverride
    // (that's the Ollama num_ctx lever). Persist, then relaunch the running
    // engine so the new -c is live immediately; a stopped engine simply picks
    // the value up on its next start.
    if (ctx.provider === 'builtin') {
      const tuning = useSettingsStore.getState().settings.builtinEngine
      if (value === tuning.ctx && (value > 0) === (tuning.ctxChosen === true)) return
      setBusy(true)
      setApplyError(null)
      // GH #129: die Wahl wird mitgeschrieben, nicht nur die Zahl. Sonst ist
      // ein ausdrueckliches 8K von der Voreinstellung 8192 nicht zu
      // unterscheiden, und der Agentendeckel hebt den Motor trotzdem an.
      // Auto (0) nimmt die Marke wieder zurueck.
      updateSettings({ builtinEngine: { ...tuning, ctx: value, ctxChosen: value > 0 } })
      try {
        const status = await bundledEngineStatus()
        if (status?.running && status.model_path) await swapBundledModel(status.model_path)
      } catch (e) {
        // The setting is saved (the next start uses it), but the immediate
        // relaunch failed and the engine is now stopped; say so.
        setApplyError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
        setTick((t) => t + 1)
        window.dispatchEvent(new Event('lu-context-reloaded'))
      }
      return
    }
    if (value === selected) return
    setBusy(true)
    setApplyError(null)
    if (ctx.provider === 'lmstudio') {
      // Saved for this model only (GH #168): the next load LU starts on its
      // own, after a switch away and back, asks for the same size.
      const current = useSettingsStore.getState().settings.contextWindowByModel
      updateSettings({ contextWindowByModel: withLmStudioPick(current, activeModel, value) })
    } else {
      updateSettings({ contextWindowOverride: value }) // 0 = Auto
    }
    try {
      const providerId = getProviderIdFromModel(activeModel)
      if (providerId === 'ollama') {
        // The setting is saved above, so this loads the model with exactly
        // the window the next message on this surface sends.
        await reloadOllamaWithWindow(activeModel, windowUse)
      } else if (ctx.provider === 'lmstudio') {
        // value 0 (Auto) -> reload without -c so LM Studio picks its default.
        await loadLmStudioModel(displayModelName(activeModel), value > 0 ? value : undefined)
      }
    } catch (e) {
      // Reload failed, the counter keeps its prior value; tell the user why.
      setApplyError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setTick((t) => t + 1) // re-read the model's real loaded context
      // Tell the token counter (and any other consumer) to re-read too.
      window.dispatchEvent(new Event('lu-context-reloaded'))
    }
  }

  const rowCls = (selected: boolean) =>
    `flex items-center justify-between gap-3 text-left px-2 py-1 rounded-md t-micro transition-colors ${
      selected
        ? 'bg-gray-100 dark:bg-white/[0.08] text-gray-900 dark:text-white font-medium'
        : 'text-gray-500 hover:bg-gray-50 dark:hover:bg-white/[0.04] hover:text-gray-700 dark:hover:text-gray-200'
    }`

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        title={
          cloud
            ? `Context sent per step: how much of this chat the model sees on every step. More remembers more and costs more per step.${ctx.modelWindow ? ` Model context window: ${formatContextWindow(ctx.modelWindow)}, ${SOURCE_LABEL[ctx.modelWindowSource ?? ctx.source]}.` : ''}`
            : ctx.provider === 'custom'
            ? `Context window: ${SOURCE_LABEL[ctx.source]}. This server decides its own context; pick the value it actually runs with so the counter and the request budget match it.`
            : `Context window: ${ctx.provider === 'lmstudio' ? "LM Studio's loaded context" : ctx.provider === 'builtin' ? "the LU Engine's loaded context" : 'Ollama num_ctx'}. Changing it reloads the model so it takes effect now.`
        }
        /* KF-9: der Knopf verdeckte seinen eigenen Messwert.
         *
         * Hier stand `aria-label="Context window"`. Ein `aria-label` ERSETZT
         * den Namen aus dem Inhalt; sichtbar steht im Knopf aber „117/16.4k".
         * Damit war der Name genau das, was WCAG 2.5.3 (Label in Name)
         * verbietet: er enthielt die sichtbare Beschriftung nicht. Und seit
         * D-S06 die zwei Anzeigen zusammengelegt hat, ist dieser Knopf die
         * EINZIGE Stelle, an der die Zahl ueberhaupt noch steht, ein
         * Screenreader-Nutzer bekam sie nirgends mehr.
         *
         * `aria-labelledby` statt eines zusammengebauten `aria-label`-Strings:
         * der Name zeigt damit auf den GERENDERTEN Knoten und kann nicht von
         * ihm abweichen. Ein `aria-label={`Context window ${…}`}` waere eine
         * zweite Ableitung derselben Zahl, also genau der zweite Pflegeweg,
         * den D-S06 gerade weggenommen hat.
         *
         * Der Name lautet jetzt „Context window 117/16.4k" bzw. „Context
         * window ctx 8K": das unsichtbare Wort zuerst (es sagt, WAS der Knopf
         * ist), der sichtbare Text danach (er ist die Beschriftung). Der Name
         * bleibt damit ueber ein STABILES Praefix greifbar, obwohl er sich
         * mitbewegt, siehe die Anpassung in e2e/builtin-ctx.spec.ts.
         */
        aria-labelledby={`${labelId} ${valueId}`}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-gray-200 dark:border-white/[0.06] hover:border-gray-400 dark:hover:border-white/15 text-gray-500 transition-colors text-[0.55rem] lu-hud-num disabled:opacity-60"
      >
        <span id={labelId} className="sr-only">Context window</span>
        {busy ? <Loader2 size={9} className="animate-spin" /> : null}
        {applyError && !busy ? <AlertTriangle size={9} className="text-red-400" /> : null}
        {raised && !applyError && !busy ? <AlertTriangle size={9} className="text-gray-400" aria-label="Larger context costs more" /> : null}
        {smallNote && !raised && !applyError && !busy ? (
          <span data-testid="context-small-window-mark" title={smallNote.text} className="w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-gray-500" />
        ) : null}
        {/* Der Fuellstand IST die Beschriftung. Nur wenn es keinen gibt (leerer
            Chat), steht hier wieder das Fenster allein. */}
        <span id={valueId}>
          {hasFill ? children : <span>ctx {formatContextWindow(cloud ? ctx.sendWindow : ctx.contextWindow)}</span>}
        </span>
        <ChevronDown size={8} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {applyError && !open && (
        <div
          onClick={() => setApplyError(null)}
          title="Click to dismiss"
          className="absolute right-0 top-full mt-1 z-50 w-64 p-2 rounded-md border border-red-500/25 bg-white dark:bg-lu-sheet shadow-xl cursor-pointer"
        >
          <div className="flex items-start gap-1.5 text-red-500 dark:text-red-300">
            <AlertTriangle size={10} className="mt-0.5 shrink-0" />
            <span className="text-[0.55rem] leading-snug break-words">
              Couldn&apos;t reload with the new context: {applyError}
            </span>
          </div>
        </div>
      )}
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          {/* Die Hoehe ist der zweite Teil derselben Zusage: kippen allein
              reicht nicht, wenn auch oben zu wenig Platz ist (flaches Fenster).
              Ueber dem Deckel scrollt die Liste, statt aus ihrer Flaeche zu
              laufen. */}
          <div
            ref={listeRef}
            style={platz.style}
            className={`absolute right-0 z-50 min-w-[140px] rounded-lg lu-elevated p-1 flex flex-col gap-0.5 overflow-y-auto scrollbar-thin ${
              platz.nachOben ? 'bottom-full mb-1' : 'top-full mt-1'
            }`}
          >
            {smallNote && (
              <div
                data-testid="context-small-window"
                className="w-60 max-w-full mt-0.5 mb-0.5 px-2 py-1.5 rounded-md bg-gray-50 dark:bg-white/[0.04] t-micro text-gray-600 dark:text-gray-300 leading-snug flex flex-col gap-1"
              >
                <span className="flex items-start gap-1.5">
                  <AlertTriangle size={10} className="shrink-0 mt-px text-gray-400" />
                  <span>{smallNote.text}{smallNote.hint ? ` ${smallNote.hint}` : ''}</span>
                </span>
                {smallNote.fix !== null && (
                  <button
                    type="button"
                    onClick={() => apply(smallNote.fix as number)}
                    className="self-start ml-4 px-2 py-0.5 rounded border border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/[0.08] t-micro font-medium transition-colors"
                  >
                    Use {formatContextWindow(smallNote.fix)}
                  </button>
                )}
              </div>
            )}
            <ContextBreakdownPanel window={meterWindow} modelWindow={ctx.contextWindow} agent={windowUse === 'agent'} />
            <div className="mx-1 border-t border-gray-100 dark:border-white/[0.06]" />
            {!cloud && <div className="px-2 pt-1 t-label text-gray-400">Context window</div>}
            {(!cloud || ctx.sendAdjustable !== false) && (<>
            {cloud && ctx.modelWindowSettable && (
              <div className="px-2 pt-0.5 t-micro uppercase tracking-wide text-gray-400">Sent per message</div>
            )}
            <button onClick={() => apply(0)} className={rowCls(selectedNow === 0)}>
              <span>Auto{ctx.provider === 'ollama' ? ` · ${formatContextWindow(ctx.autoWindow ?? ollamaWindowFor(windowUse, ctx.modelMax))}` : ctx.provider === 'builtin' ? ` · ${formatContextWindow(ENGINE_DEFAULT_CTX)}` : ctx.provider === 'custom' && ctx.source !== 'user' ? ` · ${formatContextWindow(ctx.contextWindow)}` : cloud ? ` · ${formatContextWindow(globalSendWindow)}` : ''}</span>
              {selectedNow === 0 && <Check size={10} />}
            </button>
            {options.map((p) => (
              <button key={p} onClick={() => apply(p)} className={rowCls(selectedNow === p)}>
                <span>{formatContextWindow(p)}</span>
                {selectedNow === p && <Check size={10} />}
              </button>
            ))}
            {showMax && (
              <button onClick={() => apply(ctx.modelMax)} className={rowCls(selectedNow === ctx.modelMax)}>
                <span>{formatContextWindow(ctx.modelMax)} · max</span>
                {selectedNow === ctx.modelMax && <Check size={10} />}
              </button>
            )}
            </>)}
            {cloud && ctx.modelWindowSettable && (
              <div data-testid="context-model-window" className="flex flex-col gap-0.5">
                <div className={`px-2 pt-1 ${ctx.sendAdjustable !== false ? 'mt-0.5 border-t border-gray-100 dark:border-white/[0.06]' : ''} t-micro uppercase tracking-wide text-gray-400`}>Model context window</div>
                <button onClick={() => applyModelWindow(0)} className={rowCls(modelWindowPick === 0)}>
                  <span>Auto{modelWindowPick === 0 && ctx.modelWindow ? ` · ${formatContextWindow(ctx.modelWindow)}` : ''}</span>
                  {modelWindowPick === 0 && <Check size={10} />}
                </button>
                {[...new Set([...MODEL_WINDOW_PRESETS, ...(modelWindowPick > 0 ? [modelWindowPick] : [])])].sort((a, b) => a - b).map((p) => (
                  <button key={`m${p}`} onClick={() => applyModelWindow(p)} className={rowCls(modelWindowPick === p)}>
                    <span>{formatContextWindow(p)}</span>
                    {modelWindowPick === p && <Check size={10} />}
                  </button>
                ))}
                <div className="px-2 pt-0.5 t-micro text-gray-400 leading-snug max-w-[220px]">
                  {`Now ${formatContextWindow(ctx.modelWindow ?? 0)}, ${SOURCE_LABEL[ctx.modelWindowSource ?? 'guess']}. This API does not report the model's context window, so LU cannot check it. Pick the window its documentation names. Saved for this model.`}
                </div>
              </div>
            )}
            {cpuNote && cpuNote.model === ollamaModel && (
              <div
                data-testid="context-cpu-note"
                className="mt-0.5 px-2 pt-1 border-t border-gray-100 dark:border-white/[0.06] text-[0.5rem] text-gray-500 dark:text-gray-300 leading-snug flex items-start gap-1 max-w-[220px]"
              >
                <AlertTriangle size={9} className="shrink-0 mt-px text-gray-400" />
                <span>{cpuNote.text}</span>
              </div>
            )}
            {!(cloud && ctx.sendAdjustable === false) && <div className="mt-0.5 px-2 pt-1 border-t border-gray-100 dark:border-white/[0.06] text-[0.5rem] text-gray-400 leading-snug">
              {raised
                ? <span className="flex items-start gap-1"><AlertTriangle size={9} className="shrink-0 mt-px" />Once the chat is longer than {formatContextWindow(DEFAULT_SEND_WINDOW_TOKENS)}, every message sends more and costs more credits.</span>
                : cloud
                ? `How much of the chat each message sends. Saved for this model.${ctx.modelWindow && !ctx.modelWindowSettable ? ` Model window ${formatContextWindow(ctx.modelWindow)}, ${SOURCE_LABEL[ctx.modelWindowSource ?? ctx.source]}.` : ''}`
                : unknownMax
                ? "This server did not report the model's context length, so LU cannot check these sizes. Pick the size the server runs with. Reloads the model on change."
                : ctx.provider !== 'custom'
                ? 'Reloads the model on change.'
                : (ctx.clampedFrom ?? 0) > 0
                  ? `Your saved ${formatContextWindow(ctx.clampedFrom ?? 0)} is more than this server runs, so ${formatContextWindow(ctx.contextWindow)} is used. Start the server larger to use it.`
                  : `Current value ${SOURCE_LABEL[ctx.source]}. Your pick is saved for this model on this server.`}
            </div>}
          </div>
        </>
      )}
    </div>
  )
}
