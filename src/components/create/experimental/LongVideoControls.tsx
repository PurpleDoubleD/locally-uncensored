// Speed, length in seconds and the cost line for a local video run (B18,
// 3.0.9). Lives under the Frames slider on ComfyUI hosts.
//
//   Speed   Fast (lightx2v 4 steps) or Quality, for the Wan 14B models that
//           have the speed LoRAs (lib/wan-speed). Hidden for every other model.
//   Length  Seconds up to 30 for the families that can continue a clip
//           (lib/long-video): Wan, Wan 2.2 5B, LTX 2.5. Up to the native
//           length it is one run; past it the clip is made in sections, and
//           the line says how many. On Extend Video it is the time to add.
//   How     Sections (default) or one pass with context windows.
//   Cost    The estimate before the run (lib/video-estimate), with the card
//           it is measured on, and what goes to system memory when it does
//           not fit.
import { useMemo } from 'react'
import { useCreateStore } from '../../../stores/createStore'
import { classifyModel } from '../../../api/comfyui'
import { getVideoBundles } from '../../../api/model-bundles'
import { useGraphicsCardGb } from '../../../hooks/useGraphicsMemory'
import { hasWanFastMode, type VideoSpeed } from '../../../lib/wan-speed'
import { MAX_LONG_SECONDS, planLongVideo, sectionSpec, secondsOf, type LongVideoMode } from '../../../lib/long-video'
import { planExtension } from '../../../lib/long-video-run'
import { estimateVideoRun } from '../../../lib/video-estimate'
import { Slider } from '../ui/Slider'
import { cn } from '../ui/cn'

let weightTable: Map<string, number> | null = null
/** The largest file of the bundle a model file belongs to, in GB. */
function weightGbOf(model: string): number | null {
  if (!weightTable) {
    weightTable = new Map()
    for (const b of getVideoBundles()) {
      for (const f of b.files) if (f.filename && f.sizeGB && f.subfolder === 'diffusion_models') weightTable.set(f.filename, f.sizeGB)
    }
  }
  return weightTable.get(model) ?? null
}

function Choice<T extends string>({ label, value, options, onChange }: {
  label: string
  value: T
  options: { id: T; label: string; title?: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      <span className="w-full t-label text-gray-500">{label}</span>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          title={o.title}
          onClick={() => onChange(o.id)}
          className={cn(
            'rounded-md border px-2 py-1 t-control transition-colors',
            o.id === value ? 'border-white/20 bg-white/[0.07] text-gray-200' : 'border-white/[0.07] text-gray-500 hover:text-gray-300',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function LongVideoControls({ model, intent }: { model: string; intent: string }) {
  const s = useCreateStore()
  const cardGb = useGraphicsCardGb()
  const type = s.videoModelList.find((m) => m.name === model)?.type ?? classifyModel(model)
  const spec = sectionSpec(type)
  const fast = hasWanFastMode(model)
  const extend = intent === 'extend'
  const nativeSeconds = spec ? Math.round((spec.native / spec.fps) * 10) / 10 : 0
  const seconds = s.longVideoSeconds
  const long = !!spec && (extend ? !!s.extendClip : seconds * (s.fps || spec.fps) > spec.native)

  const plan = useMemo(() => {
    if (!spec) return null
    if (extend) return planExtension(type, seconds > 0 ? seconds : (spec.native - spec.overlap) / spec.fps, s.fps)
    return seconds > 0 ? planLongVideo(type, seconds, s.fps) : null
  }, [spec, extend, type, seconds, s.fps])

  const estimate = useMemo(() => estimateVideoRun({
    type, model,
    width: s.width, height: s.height,
    frames: s.frames, steps: s.steps, cfgScale: s.cfgScale,
    ...(long && plan ? { seconds: extend ? plan.seconds + nativeSeconds : plan.seconds, fps: plan.fps } : {}),
    weightGb: weightGbOf(model),
    cardGb,
  }), [type, model, s.width, s.height, s.frames, s.steps, s.cfgScale, long, plan, extend, nativeSeconds, cardGb])

  return (
    <div className="space-y-2" data-testid="long-video-controls">
      {fast && (
        <Choice<VideoSpeed>
          label="Speed"
          value={s.steps <= 8 && s.cfgScale <= 1.5 ? 'fast' : 'quality'}
          onChange={s.setVideoSpeed}
          options={[
            { id: 'fast', label: 'Fast · 4 steps', title: 'lightx2v speed LoRAs: 4 steps at cfg 1. Motion can come out a little calmer.' },
            { id: 'quality', label: 'Quality', title: 'The official template without speed LoRAs. About 10 times slower.' },
          ]}
        />
      )}
      {spec && (
        <Slider
          label={extend ? 'Add' : 'Length'}
          min={0}
          max={MAX_LONG_SECONDS}
          step={1}
          value={Math.min(MAX_LONG_SECONDS, Math.max(0, seconds))}
          onChange={s.setLongVideoSeconds}
          format={(v) => {
            if (extend) {
              const p = planExtension(type, v > 0 ? v : (spec.native - spec.overlap) / spec.fps, s.fps)
              return p ? `+${p.seconds.toFixed(1)} s · ${p.sections.length} section${p.sections.length > 1 ? 's' : ''}` : '—'
            }
            if (v === 0) return `Frames slider (${secondsOf(s.frames, s.fps)} s)`
            const p = planLongVideo(type, v, s.fps)
            return p && p.sections.length > 1 ? `${p.seconds.toFixed(1)} s · ${p.sections.length} sections` : `${v} s · one run`
          }}
        />
      )}
      {spec && !extend && long && (
        <Choice<LongVideoMode>
          label="Made as"
          value={s.longVideoMode}
          onChange={s.setLongVideoMode}
          options={[
            { id: 'sections', label: 'Sections', title: `Each ${nativeSeconds} s section continues from the last frames of the one before. Best for action.` },
            { id: 'one-pass', label: 'One pass', title: 'One run with sliding context windows. Even, but tends to repeat itself.' },
          ]}
        />
      )}
      {spec && long && (
        <p className="t-micro text-gray-500" data-testid="long-video-note">
          {extend
            ? 'Continues from the last frames of the clip, the result is the whole clip, longer.'
            : s.longVideoMode === 'one-pass'
              ? 'One run past the native length. Keeps the scene even; motion may repeat.'
              : `Past ${nativeSeconds} s the clip is made in sections. Each one continues from the last frames, colours are matched at every seam.`}
        </p>
      )}
      {estimate && (
        <p className="t-micro text-gray-500" data-testid="video-estimate">{estimate.line}</p>
      )}
    </div>
  )
}
