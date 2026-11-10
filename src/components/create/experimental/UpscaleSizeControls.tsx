import { useState } from 'react'
import { useCreateStore } from '../../../stores/createStore'
import {
  UPSCALE_FACTORS, UPSCALE_FACTOR_MAX, UPSCALE_FACTOR_MIN, UPSCALE_LONG_SIDES, UPSCALE_MAX_SIDE,
  nativeUpscaleScale, normalizeUpscaleFactor, pickUpscaleModel, upscaleToolLabel,
} from '../../../lib/local-upscale'
import { commitNumber } from '../ui/NumberField'
import { Select, type SelectOption } from '../ui/Select'
import { Tooltip } from '../ui/Tooltip'

const CUSTOM_FACTOR = 'custom-factor'
const CUSTOM_LONG = 'custom-long'
const AUTO = 'auto'
const longLabel = (px: number) => px === 3840 ? '3840 px (4K)' : px === 7680 ? '7680 px (8K)' : px === 2048 ? '2048 px (2K)' : `${px} px`

/**
 * Enhance Image on local ComfyUI: the size of the result and the model that
 * makes it. Discord 08.11.2026: "only x2 and x4, no advanced
 * settings". The size is a factor from 1x to 8x or a target long side in
 * pixels, the model any file in models/upscale_models. Above the model's own
 * scale the rest is a plain resize (buildUpscaleWorkflow), and the menu says
 * the model's scale so that is no surprise.
 */
export function UpscaleSizeControls() {
  const factor = useCreateStore((s) => s.upscaleFactor)
  const longSide = useCreateStore((s) => s.upscaleLongSide)
  const setFactor = useCreateStore((s) => s.setUpscaleFactor)
  const setLongSide = useCreateStore((s) => s.setUpscaleLongSide)
  const models = useCreateStore((s) => s.upscaleModelList)
  const picked = useCreateStore((s) => s.upscaleModelPick)
  const setPicked = useCreateStore((s) => s.setUpscaleModelPick)
  const [custom, setCustom] = useState<null | 'factor' | 'long'>(null)

  const f = normalizeUpscaleFactor(factor)
  const sizeValue = custom === 'factor' ? CUSTOM_FACTOR
    : custom === 'long' ? CUSTOM_LONG
    : longSide ? (UPSCALE_LONG_SIDES.includes(longSide) ? `long:${longSide}` : CUSTOM_LONG)
    : UPSCALE_FACTORS.includes(f) ? `x:${f}` : CUSTOM_FACTOR
  const sizeOptions: SelectOption[] = [
    ...UPSCALE_FACTORS.map((x) => ({ value: `x:${x}`, label: `${x}x`, group: 'Factor' })),
    { value: CUSTOM_FACTOR, label: sizeValue === CUSTOM_FACTOR && !custom ? `${f}x` : 'Other factor…', group: 'Factor' },
    ...UPSCALE_LONG_SIDES.map((px) => ({ value: `long:${px}`, label: longLabel(px), group: 'Long side' })),
    { value: CUSTOM_LONG, label: sizeValue === CUSTOM_LONG && !custom && longSide ? `${longSide} px` : 'Other long side…', group: 'Long side' },
  ]
  const onSize = (v: string) => {
    if (v === CUSTOM_FACTOR) { setCustom('factor'); return }
    if (v === CUSTOM_LONG) { setCustom('long'); if (!longSide) setLongSide(3840); return }
    setCustom(null)
    if (v.startsWith('x:')) setFactor(Number(v.slice(2)))
    else setLongSide(Number(v.slice(5)))
  }

  const inUse = pickUpscaleModel(models, picked)
  const modelOptions: SelectOption[] = [
    { value: AUTO, label: inUse ? `Auto: ${upscaleToolLabel(inUse)}` : 'Auto' },
    ...models.map((m) => {
      const native = nativeUpscaleScale(m)
      return { value: m, label: upscaleToolLabel(m), title: m, ...(native ? { tags: [{ label: `${native}x`, tone: 'quiet' as const }] } : {}) }
    }),
  ]

  return (
    <>
      <Tooltip content="How large the result is: a factor per side, or the length of its longest side. Past the model's own scale (its 2x or 4x) the rest is a plain resize.">
        <div className="w-28">
          <Select size="sm" ariaLabel="Upscale size" options={sizeOptions} value={sizeValue} onChange={onSize} />
        </div>
      </Tooltip>
      {(custom === 'factor' || (sizeValue === CUSTOM_FACTOR && !custom)) && (
        <InlineNumber
          ariaLabel="Upscale factor" suffix="x" value={f} min={UPSCALE_FACTOR_MIN} max={UPSCALE_FACTOR_MAX} step={0.05}
          onCommit={(v) => { setFactor(v); setCustom(null) }}
        />
      )}
      {(custom === 'long' || (sizeValue === CUSTOM_LONG && !custom)) && (
        <InlineNumber
          ariaLabel="Upscale long side" suffix="px" value={longSide ?? 3840} min={256} max={UPSCALE_MAX_SIDE} step={1}
          onCommit={(v) => { setLongSide(v); setCustom(null) }}
        />
      )}
      {models.length > 1 && (
        <Tooltip content="The upscale model from ComfyUI's models/upscale_models. Auto takes RealESRGAN x4plus when it is there.">
          <div className="w-40">
            <Select
              size="sm" ariaLabel="Upscale model" align="right" options={modelOptions}
              value={picked && models.includes(picked) ? picked : AUTO}
              onChange={(v) => setPicked(v === AUTO ? null : v)}
            />
          </div>
        </Tooltip>
      )}
    </>
  )
}

/** A small number box for the toolbar: what is typed is applied on Enter or
 *  when the box is left, inside its bounds. */
function InlineNumber({ ariaLabel, suffix, value, min, max, step, onCommit }: {
  ariaLabel: string; suffix: string; value: number; min: number; max: number; step: number; onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const v = parseFloat(draft.replace(',', '.'))
    setDraft(null)
    if (!Number.isNaN(v)) onCommit(commitNumber(v, min, max, step))
  }
  return (
    <div className="flex items-center h-7 px-2 rounded-[var(--radius-control)] bg-white/[0.04] border border-white/[0.08] focus-within:border-white/20">
      <input
        type="text" inputMode="decimal" aria-label={ariaLabel}
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
        className="bg-transparent outline-none w-14 t-control text-gray-200 lu-hud-num text-right"
      />
      <span className="t-mono text-gray-600 pl-1">{suffix}</span>
    </div>
  )
}
