// ENG-2 (2.6.0) — expert tuning for the bundled llama-server. Values persist
// in settings.builtinEngine (store v18); api/engine.ts injects them into
// every start/swap, so this panel is the only UI that has to know they exist.
// "Apply & Restart" relaunches the running engine through swapBundledModel
// (same path the model picker uses); when stopped, the next start picks the
// values up automatically.

import { useRef, useState } from 'react'
import { Loader2, AlertTriangle, Check, Zap } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { Hinweis } from '../ui/Hinweis'
import { bundledEngineStatus, swapBundledModel, ENGINE_PORT } from '../../api/engine'
import { useBuiltinEngineStatus } from '../../hooks/useBuiltinEngineStatus'
import { enginePortLine } from '../../lib/engine-port'
import type { BuiltinEngineTuning } from '../../types/settings'

type KvType = BuiltinEngineTuning['cacheTypeK']

const KV_OPTIONS: { id: KvType; label: string }[] = [
  { id: 'f16', label: 'f16 — full precision (default)' },
  { id: 'bf16', label: 'bf16 — full size, wider range' },
  { id: 'q8_0', label: 'q8_0 — ~½ memory, near-lossless' },
  { id: 'q4_0', label: 'q4_0 — ~¼ memory, visible quality loss' },
]

const numberInputCls =
  'w-20 px-1.5 py-0.5 rounded bg-transparent border border-white/8 text-[0.65rem] text-right text-gray-300 font-mono focus:outline-none focus:border-white/20'
const selectCls =
  'px-1.5 py-0.5 rounded bg-transparent border border-white/8 text-[0.65rem] text-gray-300 focus:outline-none focus:border-white/20 [&>option]:bg-gray-900'

function modelNameFromPath(path: string | null): string | null {
  if (!path) return null
  return path.split(/[\\/]/).pop()?.replace(/\.gguf$/i, '') ?? null
}

/**
 * The Rust event a sidecar's death raises (commands/engine.rs).
 *
 * A16, Windows counter-check 02.09.: the panel read the engine status exactly
 * once, on mount. Kill lu-llama-server with the section standing open and the
 * line said "Engine running · Port: 8127" for the full thirty seconds the
 * counter-check watched, and only folding the section and unfolding it put it
 * right, because that mounted the panel again and asked again. A display that
 * is wrong about a process that is gone is worse than no display: it is the
 * answer to "why does chat not work" and it is the wrong answer.
 */
export function BuiltinEngineSettings() {
  const tuning = useSettingsStore((s) => s.settings.builtinEngine)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [applied, setApplied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A restart this panel started reads the status itself when it is done, and
  // a poll landing in the middle of it would show the gap as "not running".
  // Die Schleife selbst steht in hooks/useBuiltinEngineStatus, weil die
  // Models-Seite dieselbe Frage stellen muss (Persona P2, 04.09.2026).
  const busyRef = useRef(false)
  busyRef.current = busy
  const { status, setStatus } = useBuiltinEngineStatus(() => busyRef.current)

  const patch = (p: Partial<BuiltinEngineTuning>) => {
    updateSettings({ builtinEngine: { ...tuning, ...p } })
    setDirty(true)
    setApplied(false)
  }

  // llama.cpp constraint: a quantized V-cache requires flash attention, the
  // server refuses to start otherwise. Say so instead of breaking silently.
  const vQuantNeedsFa = tuning.cacheTypeV !== 'f16' && tuning.flashAttn === 'off'

  const running = !!status?.running && !!status.model_path
  const loadedModel = modelNameFromPath(status?.model_path ?? null)

  const apply = async () => {
    if (!status?.model_path) return
    setBusy(true)
    setError(null)
    try {
      // Tuning is injected from settings inside swapBundledModel.
      await swapBundledModel(status.model_path)
      setStatus(await bundledEngineStatus())
      setDirty(false)
      setApplied(true)
      // Token counter + context dropdown re-read the live ctx.
      window.dispatchEvent(new Event('lu-context-reloaded'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      {/* Der klotzigste Fall im ganzen Baum: ein Satz, der nur erklaert, wofuer
          die Werte hier gut sind, stand in einem gelben Rahmen mit gelber
          Fuellung und fetter Ueberschrift und sah damit aus wie ein Absturz.
          Jetzt eine Zeile im ruhigen Ton. Regel: lib/hinweis.ts. */}
      <Hinweis icon={<Zap size={11} className="shrink-0 mt-[3px]" />}>
        Expert settings for the LU Engine. The defaults match what LU shipped with and are right for most machines. Every start of the engine uses these values; a running engine needs Apply &amp; Restart below.
      </Hinweis>

      {/* Live status */}
      <div className="text-[0.6rem] text-gray-500">
        {running ? (
          <>
            Engine running{loadedModel ? <> · <span className="text-gray-300">{loadedModel}</span></> : null}
            {/* Roh, ohne Tausendertrennung, weil das Eingabefeld drei Zeilen
                tiefer 8192 zeigt und der Hilfetext daneben von 16384 und 32768
                spricht. Gegenprobe G2, 04.09.2026: dieselbe Zahl stand hier
                als `ctx 8,192` und dort als `8192`, keine drei Zeilen
                auseinander. `String` und nicht `toLocaleString`, sonst waere
                der deutsche Punkt aus dem P2-Befund wieder da. */}
            {typeof status?.ctx === 'number' ? <> · ctx {String(status.ctx)}</> : null}
          </>
        ) : (
          'Engine not running, settings apply automatically on the next start.'
        )}
      </div>
      {/* A13: which port the engine really holds. It starts its walk at 8127
          and takes the next free one when that is held, and until now the only
          place that said so was the log. */}
      <div className="t-micro text-gray-500" data-testid="builtin-engine-port">
        {enginePortLine(status, ENGINE_PORT)}
      </div>

      {/* Context length */}
      <div className="flex items-center justify-between">
        <span className="text-[0.7rem] text-gray-700 dark:text-gray-400" title="Total context in tokens, shared dynamically across the server's parallel slots (unified KV cache). Bigger = more memory.">Context length (tokens)</span>
        <input
          type="number"
          value={tuning.ctx}
          onChange={(e) => patch({ ctx: Math.max(0, parseInt(e.target.value) || 0) })}
          min={0}
          step={1024}
          placeholder="8192"
          className={numberInputCls}
        />
      </div>
      <div className="text-[0.6rem] text-gray-500 leading-relaxed">
        0 = default (8192). Raise to 16384 / 32768 for long chats and RAG if you have the memory; KV-cache size grows linearly with it.
      </div>

      {/* Flash attention */}
      <div className="flex items-center justify-between">
        <span className="text-[0.7rem] text-gray-700 dark:text-gray-400" title="Faster attention kernel with lower memory use. Auto lets llama.cpp decide per model/GPU.">Flash attention</span>
        <div className="flex gap-1 p-0.5 rounded-lg bg-gray-100 dark:bg-white/5">
          {(['auto', 'on', 'off'] as const).map((v) => (
            <button
              key={v}
              onClick={() => patch({ flashAttn: v })}
              className={`px-2 py-1 rounded text-[0.65rem] transition-colors ${
                tuning.flashAttn === v
                  ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* KV cache quantization */}
      <div className="flex items-center justify-between">
        <span className="text-[0.7rem] text-gray-700 dark:text-gray-400" title="Precision of the K cache. Quantizing trades a little quality for a lot of memory — q8_0 is usually indistinguishable.">KV cache — K type</span>
        <select value={tuning.cacheTypeK} onChange={(e) => patch({ cacheTypeK: e.target.value as KvType })} className={selectCls}>
          {KV_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[0.7rem] text-gray-700 dark:text-gray-400" title="Precision of the V cache. Quantized V requires flash attention.">KV cache — V type</span>
        <select value={tuning.cacheTypeV} onChange={(e) => patch({ cacheTypeV: e.target.value as KvType })} className={selectCls}>
          {KV_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
      </div>
      <div className="text-[0.6rem] text-gray-500 leading-relaxed">
        Memory vs. quality: q8_0 on K+V roughly halves KV-cache memory at near-identical output; q4_0 quarters it but can degrade long-context answers.
      </div>
      {vQuantNeedsFa && (
        <Hinweis ton="fehler" icon={<AlertTriangle size={11} className="shrink-0 mt-[3px]" />}>
          A quantized V cache requires flash attention. With it off the engine refuses to start, so switch flash attention to auto or on.
        </Hinweis>
      )}

      {/* Threads */}
      <div className="flex items-center justify-between">
        <span className="text-[0.7rem] text-gray-700 dark:text-gray-400" title="CPU threads for generation. -1 = auto (llama.cpp picks).">CPU threads</span>
        <input
          type="number"
          value={tuning.threads}
          onChange={(e) => { const n = parseInt(e.target.value); patch({ threads: Number.isNaN(n) ? -1 : Math.max(-1, n) }) }}
          min={-1}
          placeholder="-1"
          className={numberInputCls}
        />
      </div>

      {/* GPU layers */}
      <div className="flex items-center justify-between">
        <span className="text-[0.7rem] text-gray-700 dark:text-gray-400" title="-1 = offload every layer to the GPU (default). 0 = CPU only. N = offload the first N layers — use when the model + KV cache doesn't fit your VRAM.">GPU layers</span>
        <input
          type="number"
          value={tuning.gpuLayers}
          onChange={(e) => { const n = parseInt(e.target.value); patch({ gpuLayers: Number.isNaN(n) ? -1 : Math.max(-1, n) }) }}
          min={-1}
          placeholder="-1"
          className={numberInputCls}
        />
      </div>
      <div className="text-[0.6rem] text-gray-500 leading-relaxed">
        -1 = all layers on GPU · 0 = CPU only · N = partial offload for models bigger than your VRAM.
      </div>

      {/* mlock / mmap */}
      <label className="flex items-start gap-2 cursor-pointer">
        <input type="checkbox" checked={tuning.mlock} onChange={(e) => patch({ mlock: e.target.checked })} className="mt-0.5" />
        <div>
          <div className="text-[0.65rem] text-gray-300">Lock model in RAM (mlock)</div>
          <div className="text-[0.55rem] text-gray-500 leading-relaxed">Prevents the OS from swapping the model out. Needs enough free RAM for the whole model.</div>
        </div>
      </label>
      <label className="flex items-start gap-2 cursor-pointer">
        <input type="checkbox" checked={tuning.noMmap} onChange={(e) => patch({ noMmap: e.target.checked })} className="mt-0.5" />
        <div>
          <div className="text-[0.65rem] text-gray-300">Load fully into RAM (disable mmap)</div>
          <div className="text-[0.55rem] text-gray-500 leading-relaxed">Slower start, but can smooth out generation on slow disks / network drives.</div>
        </div>
      </label>

      {/* Apply */}
      <div className="pt-2 border-t border-white/[0.06] space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[0.6rem] text-gray-500 leading-relaxed">
            {running
              ? dirty
                ? 'Changes are not live yet — restart the engine to apply them.'
                : 'Engine is running with the settings above.'
              : 'No restart needed — the next engine start uses these settings.'}
          </div>
          <button
            onClick={apply}
            disabled={!running || busy || vQuantNeedsFa}
            className="shrink-0 px-2.5 py-1 rounded-md text-[0.6rem] font-medium bg-white dark:bg-white/10 text-gray-800 dark:text-white hover:bg-gray-100 dark:hover:bg-white/15 border border-gray-200 dark:border-white/15 transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
          >
            {busy ? <Loader2 size={10} className="animate-spin" /> : applied ? <Check size={10} className="text-emerald-400" /> : null}
            {busy ? 'Restarting…' : 'Apply & Restart Engine'}
          </button>
        </div>
        {error && (
          <Hinweis ton="fehler" className="break-all" icon={<AlertTriangle size={11} className="shrink-0 mt-[3px]" />}>
            {error}
          </Hinweis>
        )}
      </div>
    </div>
  )
}
