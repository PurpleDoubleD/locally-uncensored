import { useId, useState, type ReactNode } from 'react'
import { useDismissOnEscape } from '../../hooks/useDismissOnEscape'
import { ChevronDown, Check, Loader2, AlertTriangle } from 'lucide-react'
import { useModelStore } from '../../stores/modelStore'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { getProviderIdFromModel, displayModelName } from '../../api/providers'
import { getModelContextCached, warmupOllamaContext } from '../../api/ollama'
import { loadLmStudioModel } from '../../api/lmstudio'
import { bundledEngineStatus, swapBundledModel } from '../../api/engine'
import { effectiveContextWindow } from '../../lib/context-window'
import { useActiveContextWindow } from '../../hooks/useActiveContextWindow'
import { formatContextWindow } from '../../lib/formatters'
import { ENGINE_DEFAULT_CTX } from '../../lib/builtin-ctx'

const PRESETS = [4096, 8192, 16384, 32768, 65536, 131072]

// Eine Schreibweise fuer alle Kontextfenster, in lib/formatters. Vorher stand
// hier eine eigene Rechnung und im Fuellstand daneben eine zweite, und beide
// zeigten denselben Wert verschieden (Gegenprobe G2, 04.09.2026).
const fmt = formatContextWindow

/**
 * Context-window picker for the active LOCAL model. Sets `contextWindowOverride`
 * and AUTO-RELOADS the model so the change takes effect immediately:
 *   - Ollama:    warm the model with the new num_ctx (Ollama reloads its runner).
 *   - LM Studio: `lms load -c <N>` (unload + reload, context is load-time there).
 *   - Built-in:  ctx lives in settings.builtinEngine (expert tuning), the
 *                engine relaunches with the new -c via swapBundledModel.
 * Hidden for cloud models (their context is fixed and not adjustable here).
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
  const [busy, setBusy] = useState(false)
  // Reload failure, surfaced instead of swallowed: the engine's start error
  // (out of memory for the new ctx, port held by a stranger) is actionable,
  // and a silent catch here would bury exactly the honest message the Rust
  // side now produces. Cleared on the next attempt or by clicking it away.
  const [applyError, setApplyError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const ctx = useActiveContextWindow(tick)
  const builtinCtx = useSettingsStore((s) => s.settings.builtinEngine.ctx)
  // The check-mark anchor: built-in reads its own tuning field, not the
  // Ollama/LM Studio override.
  const selected = ctx.provider === 'builtin' ? builtinCtx : override
  // Gibt es ueberhaupt einen Fuellstand zu zeigen? Genau die Bedingung, unter
  // der `TokenCounter` `null` zurueckgibt. Bewusst ein BOOLEAN als Selektor:
  // ein Abo auf `s.conversations` wuerde diesen Knopf bei jedem Streaming-Flush
  // neu rendern (T-45), ein Boolean wechselt einmal pro Chat.
  const hasFill = useChatStore(
    (s) => (s.conversations.find((c) => c.id === s.activeConversationId)?.messages.length ?? 0) > 0,
  )

  // Nicht verstellbar (Cloud): kein Regler, aber der Fuellstand bleibt stehen.
  if (!activeModel || !ctx.adjustable) return <>{children}</>

  const max = ctx.modelMax > 0 ? ctx.modelMax : 131072
  const options = PRESETS.filter((p) => p <= Math.max(max, 4096))
  const showMax = ctx.modelMax > 0 && !options.includes(ctx.modelMax) && ctx.modelMax > (options[options.length - 1] || 0)

  const apply = async (value: number) => {
    setOpen(false)
    // Built-in engine: ctx lives in the expert tuning, NOT contextWindowOverride
    // (that's the Ollama num_ctx lever). Persist, then relaunch the running
    // engine so the new -c is live immediately; a stopped engine simply picks
    // the value up on its next start.
    if (ctx.provider === 'builtin') {
      const tuning = useSettingsStore.getState().settings.builtinEngine
      if (value === tuning.ctx) return
      setBusy(true)
      setApplyError(null)
      updateSettings({ builtinEngine: { ...tuning, ctx: value } })
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
    if (value === override) return
    setBusy(true)
    setApplyError(null)
    updateSettings({ contextWindowOverride: value }) // 0 = Auto
    try {
      const providerId = getProviderIdFromModel(activeModel)
      if (providerId === 'ollama') {
        const target = value > 0
          ? value
          : effectiveContextWindow(await getModelContextCached(activeModel).catch(() => 0), 0)
        await warmupOllamaContext(activeModel, target)
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
        title={`Context window: ${ctx.provider === 'lmstudio' ? "LM Studio's loaded context" : ctx.provider === 'builtin' ? "the LU Engine's loaded context" : 'Ollama num_ctx'}. Changing it reloads the model so it takes effect now.`}
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
        {/* Der Fuellstand IST die Beschriftung. Nur wenn es keinen gibt (leerer
            Chat), steht hier wieder das Fenster allein. */}
        <span id={valueId}>
          {hasFill ? children : <span>ctx {fmt(ctx.contextWindow)}</span>}
        </span>
        <ChevronDown size={8} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {applyError && !open && (
        <div
          onClick={() => setApplyError(null)}
          title="Click to dismiss"
          className="absolute right-0 top-full mt-1 z-50 w-64 p-2 rounded-md border border-red-500/25 bg-white dark:bg-lu-overlay shadow-xl cursor-pointer"
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
          <div className="absolute right-0 top-full mt-1 z-50 min-w-[140px] rounded-lg lu-elevated p-1 flex flex-col gap-0.5">
            <button onClick={() => apply(0)} className={rowCls(selected === 0)}>
              <span>Auto{ctx.provider === 'ollama' ? ` · ${fmt(effectiveContextWindow(ctx.modelMax, 0))}` : ctx.provider === 'builtin' ? ` · ${fmt(ENGINE_DEFAULT_CTX)}` : ''}</span>
              {selected === 0 && <Check size={10} />}
            </button>
            {options.map((p) => (
              <button key={p} onClick={() => apply(p)} className={rowCls(selected === p)}>
                <span>{fmt(p)}</span>
                {selected === p && <Check size={10} />}
              </button>
            ))}
            {showMax && (
              <button onClick={() => apply(ctx.modelMax)} className={rowCls(selected === ctx.modelMax)}>
                <span>{fmt(ctx.modelMax)} · max</span>
                {selected === ctx.modelMax && <Check size={10} />}
              </button>
            )}
            <div className="mt-0.5 px-2 pt-1 border-t border-gray-100 dark:border-white/[0.06] text-[0.5rem] text-gray-400 leading-snug">
              Reloads the model on change.
            </div>
          </div>
        </>
      )}
    </div>
  )
}
