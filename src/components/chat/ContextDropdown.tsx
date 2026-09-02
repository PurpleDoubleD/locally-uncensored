import { useState } from 'react'
import { ChevronDown, Check, Loader2, AlertTriangle } from 'lucide-react'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { getProviderIdFromModel, displayModelName } from '../../api/providers'
import { getModelContextCached, warmupOllamaContext } from '../../api/ollama'
import { loadLmStudioModel } from '../../api/lmstudio'
import { bundledEngineStatus, swapBundledModel } from '../../api/engine'
import { effectiveContextWindow } from '../../lib/context-window'
import { useActiveContextWindow } from '../../hooks/useActiveContextWindow'

const PRESETS = [4096, 8192, 16384, 32768, 65536, 131072]

const fmt = (n: number) =>
  n <= 0 ? 'Auto'
    : n % 1024 === 0 ? `${n / 1024}K`
      : n >= 1000 ? `${Math.round(n / 1000)}K`
        : String(n)

/**
 * Context-window picker for the active LOCAL model. Sets `contextWindowOverride`
 * and AUTO-RELOADS the model so the change takes effect immediately:
 *   - Ollama:    warm the model with the new num_ctx (Ollama reloads its runner).
 *   - LM Studio: `lms load -c <N>` (unload + reload — context is load-time there).
 *   - Built-in:  ctx lives in settings.builtinEngine (expert tuning), the
 *                engine relaunches with the new -c via swapBundledModel.
 * Hidden for cloud models (their context is fixed and not adjustable here).
 */
export function ContextDropdown() {
  const activeModel = useModelStore((s) => s.activeModel)
  const override = useSettingsStore((s) => s.settings.contextWindowOverride)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [open, setOpen] = useState(false)
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

  if (!activeModel || !ctx.adjustable) return null

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
        // The setting is saved (the next start uses it) — but the immediate
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
      // Reload failed — the counter keeps its prior value; tell the user why.
      setApplyError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setTick((t) => t + 1) // re-read the model's real loaded context
      // Tell the token counter (and any other consumer) to re-read too.
      window.dispatchEvent(new Event('lu-context-reloaded'))
    }
  }

  const rowCls = (selected: boolean) =>
    `flex items-center justify-between gap-3 text-left px-2 py-1 rounded-md text-[0.6rem] transition-colors ${
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
        className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-gray-200 dark:border-white/[0.06] hover:border-gray-400 dark:hover:border-white/15 text-gray-500 transition-colors text-[0.55rem] font-mono tabular-nums disabled:opacity-60"
      >
        {busy ? <Loader2 size={9} className="animate-spin" /> : null}
        {applyError && !busy ? <AlertTriangle size={9} className="text-red-400" /> : null}
        <span>ctx {fmt(ctx.contextWindow)}</span>
        <ChevronDown size={8} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {applyError && !open && (
        <div
          onClick={() => setApplyError(null)}
          title="Click to dismiss"
          className="absolute right-0 top-full mt-1 z-50 w-64 p-2 rounded-md border border-red-500/25 bg-white dark:bg-[#1a1a1a] shadow-xl cursor-pointer"
        >
          <div className="flex items-start gap-1.5 text-red-500 dark:text-red-300">
            <AlertTriangle size={10} className="mt-0.5 shrink-0" />
            <span className="text-[0.55rem] leading-snug break-words">
              Couldn&apos;t reload with the new context — {applyError}
            </span>
          </div>
        </div>
      )}
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 min-w-[140px] rounded-lg bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/10 shadow-xl p-1 flex flex-col gap-0.5">
            <button onClick={() => apply(0)} className={rowCls(selected === 0)}>
              <span>Auto{ctx.provider === 'ollama' ? ` · ${fmt(effectiveContextWindow(ctx.modelMax, 0))}` : ctx.provider === 'builtin' ? ' · 8K' : ''}</span>
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
