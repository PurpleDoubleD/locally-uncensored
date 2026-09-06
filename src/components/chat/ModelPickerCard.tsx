import { useEffect, useRef, useState } from 'react'
import { Save, Check, Loader2, Settings2, X } from 'lucide-react'
import { useModelPickStore, MODEL_PICK_TIMEOUT_MS, type ModelPickKind, type ModelPickRequest } from '../../stores/modelPickStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { getImageModels, getVideoModels, isI2VModel, isT2VCapable } from '../../api/comfyui'
import type { AgentToolCall } from '../../types/agent-mode'
import type { ToolArgs } from '../../api/mcp/types'
import { Hinweis } from '../ui/Hinweis'

/**
 * Model-Picker UI (v2.5.3, David 2026-06-10). Two faces of one feature:
 *
 *   <ModelPickerCard/>   — the BLOCKING pick rendered inside a running
 *     image_generate / video_generate tool call BEFORE the VRAM swap. LU
 *     (not the LLM) lists the installed ComfyUI models; Continue resolves
 *     the executor's promise; the save icon persists the choice for future
 *     prompts. A live countdown auto-continues with the on-screen selection
 *     so an AFK user still gets their generation (pre-picker behaviour).
 *
 *   <ChangeModelInline/> — the mini "Change model" affordance shown on
 *     generation tool calls once a preference is saved. Opens the same
 *     list; a click rewrites the saved preference (applies from the next
 *     generation on).
 */

export const PICK_KIND_LABEL: Record<ModelPickKind, string> = {
  image: 'image model',
  'video-t2v': 'video model · text-to-video',
  'video-i2v': 'video model · image-to-video',
}

export const PICK_PREF_KEY: Record<ModelPickKind, 'preferredImageModel' | 'preferredVideoT2VModel' | 'preferredVideoI2VModel'> = {
  image: 'preferredImageModel',
  'video-t2v': 'preferredVideoT2VModel',
  'video-i2v': 'preferredVideoI2VModel',
}

/** Which pick-kind a generation tool call belongs to (null = not a gen tool).
 *  Mirrors the executor's alias normalization so the card and the gate
 *  classify identically. Exported for tests. */
export function pickKindForToolCall(toolCall: Pick<AgentToolCall, 'toolName' | 'args'>): ModelPickKind | null {
  if (toolCall.toolName === 'image_generate') return 'image'
  if (toolCall.toolName !== 'video_generate') return null
  // `AgentToolCall['args']` ist bereits `ToolArgs` (types/agent-mode.ts:91), es
  // braucht also gar keine Zusicherung. `s` verengt `unknown` mit derselben
  // Pruefung wie vorher — nur dass das Ergebnis jetzt auch `unknown` ist und die
  // `typeof inputImage === 'string'`-Pruefung unten wirklich etwas tut, statt
  // eine schon durchgewinkte Zusage zu wiederholen.
  const a: ToolArgs = toolCall.args ?? {}
  const s: ToolArgs = a.settings && typeof a.settings === 'object' ? (a.settings as ToolArgs) : {}
  const inputImage = a.inputImage ?? a.input_image ?? a.image ?? s.inputImage ?? s.input_image ?? s.image
  return typeof inputImage === 'string' && inputImage ? 'video-i2v' : 'video-t2v'
}

/** Strip the extension for compact display ("Juggernaut-XL_v9"). */
const shortName = (n: string) => n.replace(/\.(safetensors|ckpt|pt|gguf|bin)$/i, '')

function ModelList({ models, selected, onPick }: { models: string[]; selected: string; onPick: (m: string) => void }) {
  return (
    <div className="space-y-0.5 max-h-40 overflow-y-auto scrollbar-thin pr-0.5">
      {models.map((m) => (
        <button
          key={m}
          type="button"
          onClick={(e) => { e.stopPropagation(); onPick(m) }}
          className={`w-full text-left px-2 py-1 rounded border t-micro transition-colors truncate ${
            m === selected
              ? 'border-blue-400/40 bg-blue-500/10 text-gray-900 dark:text-gray-100'
              : 'border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.03] text-gray-600 dark:text-gray-400 hover:border-gray-300 dark:hover:border-white/20'
          }`}
          title={m}
        >
          {m === selected ? '● ' : ''}{shortName(m)}
        </button>
      ))}
    </div>
  )
}

// ── Blocking pick (pre-VRAM-swap) ─────────────────────────────────

export function ModelPickerCard({ request }: { request: ModelPickRequest }) {
  const choose = useModelPickStore((s) => s.choose)
  const [selected, setSelected] = useState(request.current)
  const [save, setSave] = useState(false)
  // Auto-continue 5s before the store's headless fallback so the countdown
  // resolves with the user's ON-SCREEN selection, not just the default.
  const [secondsLeft, setSecondsLeft] = useState(Math.max(5, Math.floor((MODEL_PICK_TIMEOUT_MS - 5000) / 1000)))
  // Refreshed from an effect, not from the render body: a ref written while
  // rendering is a mutation React may discard or replay (React 19 `refs`). The
  // only reader is the interval below, which first fires a full second after
  // the effects of the render it was started in, so it still reads the pick
  // that is on screen.
  const stateRef = useRef({ selected, save })
  useEffect(() => { stateRef.current = { selected, save } })

  useEffect(() => {
    const t = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(t)
          choose({ model: stateRef.current.selected, save: stateRef.current.save })
          return 0
        }
        return s - 1
      })
    }, 1000)
    return () => clearInterval(t)
  }, [choose, request.id])

  return (
    <div className="mt-1 ml-5 rounded-md border border-blue-400/25 bg-blue-500/[0.04] px-2.5 py-2 space-y-1.5" data-testid="model-picker-card">
      <div className="t-micro font-medium text-gray-700 dark:text-gray-300">
        Pick the {PICK_KIND_LABEL[request.kind]}
        <span className="ml-1 font-normal text-gray-500 dark:text-gray-500">runs before the VRAM swap</span>
      </div>
      <ModelList models={request.models} selected={selected} onPick={setSelected} />
      <div className="flex items-center gap-2 pt-0.5">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); choose({ model: selected, save }) }}
          className="flex items-center gap-1 px-2.5 py-1 rounded t-micro font-medium text-blue-700 dark:text-blue-300 bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/25 transition-colors"
        >
          <Check size={10} /> Continue
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setSave(!save) }}
          title="Remember this model for future prompts"
          className={`flex items-center gap-1 px-2 py-1 rounded text-[0.55rem] border transition-colors ${
            save
              ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 border-emerald-500/25'
              : 'text-gray-500 dark:text-gray-500 border-gray-200 dark:border-white/10 hover:border-gray-300 dark:hover:border-white/20'
          }`}
        >
          <Save size={10} /> {save ? 'Will remember' : 'Remember'}
        </button>
        <span className="ml-auto text-[0.5rem] text-gray-400 dark:text-gray-600">
          auto-continues with {shortName(selected)} in {secondsLeft}s
        </span>
      </div>
    </div>
  )
}

// ── "Change model" mini affordance (saved preference active) ──────

export function ChangeModelInline({ kind }: { kind: ModelPickKind }) {
  const prefKey = PICK_PREF_KEY[kind]
  const preferred = useSettingsStore((s) => s.settings[prefKey])
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<string[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  useEffect(() => {
    if (!open || models !== null) return
    let cancelled = false
    ;(async () => {
      try {
        const all = kind === 'image' ? await getImageModels() : await getVideoModels()
        // T2V uses isT2VCapable, NOT !isI2VModel — dual-capable checkpoints
        // (Wan 2.2 TI2V, LTX) belong in BOTH lists (mirrors model-pick.ts).
        const eligible = kind === 'image'
          ? all
          : all.filter((m) => (kind === 'video-i2v' ? isI2VModel(m.name) : isT2VCapable(m.name)))
        if (!cancelled) setModels(eligible.map((m) => m.name))
      } catch {
        if (!cancelled) { setLoadError(true); setModels([]) }
      }
    })()
    return () => { cancelled = true }
  }, [open, models, kind])

  if (!preferred) return null

  return (
    <div className="ml-5 mt-0.5" data-testid="change-model-inline">
      {!open ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setOpen(true) }}
          className="flex items-center gap-1 text-[0.5rem] text-gray-400 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400 transition-colors"
          title={`Saved model: ${preferred}`}
        >
          <Settings2 size={8} /> {shortName(preferred)} · Change model
        </button>
      ) : (
        <div className="rounded-md border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.03] px-2.5 py-2 space-y-1.5 max-w-sm">
          <div className="flex items-center justify-between">
            <span className="text-[0.55rem] font-medium text-gray-600 dark:text-gray-400">
              Saved {PICK_KIND_LABEL[kind]}, applies from the next generation
            </span>
            <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(false) }} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
              <X size={9} />
            </button>
          </div>
          {models === null && (
            <div className="flex items-center gap-1 text-[0.55rem] text-gray-500"><Loader2 size={9} className="animate-spin" /> loading models…</div>
          )}
          {loadError && (
            // Roter Ton, weil hier wirklich etwas fehlgeschlagen ist: ohne
            // Liste kann niemand waehlen. Gelb hat den Unterschied zwischen
            // „laedt noch" und „ging schief" eingeebnet (`lib/hinweis.ts`).
            <Hinweis ton="fehler">Could not reach ComfyUI, so the model list is unavailable.</Hinweis>
          )}
          {models !== null && models.length > 0 && (
            <ModelList
              models={models}
              selected={preferred}
              onPick={(m) => {
                updateSettings({ [prefKey]: m })
                setSavedFlash(true)
                setTimeout(() => { setSavedFlash(false); setOpen(false) }, 1200)
              }}
            />
          )}
          {savedFlash && (
            <div className="flex items-center gap-1 text-[0.55rem] text-emerald-500"><Check size={9} /> Saved, the next generation uses it.</div>
          )}
        </div>
      )}
    </div>
  )
}
