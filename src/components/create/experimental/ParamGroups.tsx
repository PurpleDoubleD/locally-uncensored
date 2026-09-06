import { Gauge, Boxes, FlaskConical, RotateCcw, HelpCircle, RectangleHorizontal, RectangleVertical } from 'lucide-react'
import { VIDEO_RES_PRESETS, ASPECT_RATIOS, applyAspect, presetForOrientation, matchesPreset } from '../../../lib/create-resolution'
import { useCreateStore } from '../../../stores/createStore'
import { useCreateExp } from './CreateContext'
import { cloudModelById, defaultCloudModel } from '../../../stores/cloudCatalogStore'
import { classifyModel } from '../../../api/comfyui'
import { nativeHiresFinalSize, type HiresUpscaleMethod } from '../../../api/hires-fix'
import { isMlxImageHost } from '../../../api/mlx-image'
import { INTENT_MAP } from './intents'
import { SAMPLERS as SAMPLERS_FALLBACK, SCHEDULERS as SCHEDULERS_FALLBACK } from './badges'
import { Section } from '../ui/Section'
import { Slider } from '../ui/Slider'
import { Select } from '../ui/Select'
import { NumberField } from '../ui/NumberField'
import { Button } from '../ui/Button'
import { Tooltip } from '../ui/Tooltip'
import { cn } from '../ui/cn'
import { HINWEIS_TEXT } from '../../../lib/hinweis'

// Video families whose dynamic-workflow strategy actually wires a LoRA node:
// the generic UNET path (wan/hunyuan/ltx/mochi/cosmos) plus Wan 2.2's dedicated
// builder (LoraLoaderModelOnly insert). The remaining families (cogvideo/svd/
// framepack/pyramidflow/allegro) use wrapper nodes with no LoRA seam, so we hide
// the stack for them rather than offer a control that silently does nothing.
const VIDEO_LORA_FAMILIES = new Set(['wan', 'wan22', 'hunyuan', 'ltx', 'mochi', 'cosmos'])

// The full param surface, reorganized into 3 frequency-ranked Sections.
// Sampler/scheduler/LoRA/VAE lists come live from ComfyUI via CreateContext,
// falling back to the standard node names until they load.
export function ParamGroups() {
  const s = useCreateStore()
  const { samplerList, schedulerList, loraList, vaeList, refreshModelLists } = useCreateExp()
  const meta = INTENT_MAP[s.intent()]
  const isVideo = meta.isVideo
  const isEdit = meta.id === 'edit'
  const isCloud = s.backend === 'cloud'
  // Music has no canvas. The size fields, the resolution chips and the
  // orientation flip all sat on the Music tab doing nothing, which is the first
  // oddity in #108 ("width and height options which make no sense for audio").
  // Length lives on the Music controls, where it belongs.
  const isAudio = meta.id === 'music'
  // The Mac's MLX pipeline only honours prompt/steps/seed/size/negative — every
  // Expert knob (sampler, scheduler, VAE, clip-skip; LoRA has no list without
  // ComfyUI, and denoise/mask belong to intents that aren't local there) is
  // silently dropped, so the whole Expert section is dead on the local Mac.
  // Keep it on Mac-cloud and on the ComfyUI hosts (Windows/Linux).
  const isMlxLocal = !isCloud && isMlxImageHost()
  // LoRA is a local-only knob; for video it's offered only on families whose
  // builder actually applies it (see VIDEO_LORA_FAMILIES). Image always qualifies.
  const loraSupported = !isCloud && (!isVideo || VIDEO_LORA_FAMILIES.has(classifyModel(s.videoModel)))

  // On cloud the worker only honours steps for images and guidance_scale for
  // the flux family — hide the sliders elsewhere rather than show a dead
  // control. Sampler/scheduler/LoRA/VAE/clip-skip/batch have no cloud path at
  // all (useCloudCreate never sends them), so they're local-only knobs.
  const cloudModelId =
    (isVideo ? s.cloudVideoModel : s.cloudImageModel) || defaultCloudModel(isVideo ? 'video' : 'image')?.id || ''
  const showSteps = !(isCloud && isVideo)
  const showCfg = isCloud ? cloudModelById(cloudModelId)?.cfg === true : true
  // Native HiRes rewrites the local ComfyUI text-to-image graph. It has no
  // cloud, video, Edit or MLX path, so keep the control honest and scoped to
  // the one lane that can execute it.
  const showHiresFix = !isCloud && !isVideo && meta.id === 'image' && !isMlxLocal
  let hiresFinal: { width: number; height: number } | null = null
  let hiresSizeError: string | null = null
  if (showHiresFix && s.hiresFixEnabled) {
    try {
      hiresFinal = nativeHiresFinalSize(s.width, s.height, s.hiresScale)
    } catch (error) {
      hiresSizeError = error instanceof Error ? error.message : String(error)
    }
  }

  const samplers = samplerList.length ? samplerList : SAMPLERS_FALLBACK
  const schedulers = schedulerList.length ? schedulerList : SCHEDULERS_FALLBACK
  const vaes = vaeList.length ? vaeList : ['auto']

  return (
    <div className="py-1">
      {/* QUALITY */}
      <Section title="Quality" icon={Gauge} defaultOpen
        right={<Button variant="ghost" size="sm" icon={RotateCcw} iconOnly title="Reset to model defaults" onClick={s.resetParamsToModelDefaults} />}
      >
        {showSteps && <Slider label="Steps" min={1} max={60} step={1} value={s.steps} onChange={s.setSteps} />}
        {showCfg && <Slider label={isVideo ? 'Guidance' : 'CFG scale'} min={0} max={30} step={0.5} value={s.cfgScale} onChange={s.setCfgScale} format={(v) => v.toFixed(1)} />}
        {!isAudio && (
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="Width" value={s.width} min={64} max={4096} step={64} mono onChange={(v) => s.setSize(v, s.height)} suffix="px" />
          <NumberField label="Height" value={s.height} min={64} max={4096} step={64} mono onChange={(v) => s.setSize(s.width, v)} suffix="px" />
        </div>
        )}
        {/* D#93 (stasicby): Wan's native sizes as one-click chips, an
            orientation flip, and ratio chips that respend the current pixel
            budget. Everything just writes the same width/height fields. */}
        {!isAudio && (
        <div className="flex flex-wrap items-center gap-1 pt-1">
          {isVideo && VIDEO_RES_PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => { const d = presetForOrientation(p, s.height > s.width); s.setSize(d.width, d.height) }}
              className={cn(
                'px-1.5 py-0.5 rounded border t-control transition-colors',
                matchesPreset(s.width, s.height, p)
                  ? 'border-white/20 bg-white/[0.08] text-gray-200'
                  : 'border-white/[0.08] text-gray-400 hover:text-gray-200 hover:bg-white/[0.06]',
              )}
            >{p.label}</button>
          ))}
          <button
            aria-label="Swap orientation"
            title="Swap portrait and landscape"
            onClick={() => s.setSize(s.height, s.width)}
            className="px-1.5 py-0.5 rounded border border-white/[0.08] t-control text-gray-400 hover:text-gray-200 hover:bg-white/[0.06] transition-colors inline-flex items-center gap-1"
          >
            {s.height > s.width ? <RectangleVertical size={10} /> : <RectangleHorizontal size={10} />}
            flip
          </button>
          {ASPECT_RATIOS.map((r) => (
            <button
              key={r.label}
              onClick={() => { const d = applyAspect(s.width, s.height, r.w, r.h); s.setSize(d.width, d.height) }}
              className="px-1.5 py-0.5 rounded border border-white/[0.08] t-control text-gray-400 hover:text-gray-200 hover:bg-white/[0.06] transition-colors"
            >{r.label}</button>
          ))}
        </div>
        )}
        {showHiresFix && (
          <div className={cn(
            'overflow-hidden rounded-lg border transition-colors',
            s.hiresFixEnabled ? 'border-white/15 bg-white/[0.05]' : 'border-white/[0.07]',
          )}>
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-2 text-left"
              onClick={() => s.setHiresFixEnabled(!s.hiresFixEnabled)}
              aria-pressed={s.hiresFixEnabled}
            >
              <span>
                <span className="block t-control text-gray-300">Native HiRes</span>
                <span className="block text-[11px] leading-4 text-gray-600">Latent upscale plus a native refinement pass</span>
              </span>
              <span className={cn('t-mono text-xs', s.hiresFixEnabled ? 'text-emerald-400' : 'text-gray-600')}>
                {s.hiresFixEnabled ? 'on' : 'off'}
              </span>
            </button>

            {s.hiresFixEnabled && (
              <div className="space-y-3 border-t border-white/[0.07] px-3 pb-3 pt-2.5">
                <div className="rounded-md bg-black/20 px-2.5 py-2 text-[11px] text-gray-500">
                  {hiresFinal ? (
                    <>
                      <span className="t-mono text-gray-400">{s.width}×{s.height}</span>
                      <span className="px-1.5 text-gray-700">→</span>
                      <span className="t-mono text-gray-200">{hiresFinal.width}×{hiresFinal.height}</span>
                    </>
                  ) : (
                    // Rot, nicht gelb: solange hier ein Satz steht, kommt aus
                    // dieser Zeile keine Zielgroesse und der Lauf startet nicht.
                    // Zwei Toene, kein dritter, siehe lib/hinweis.ts.
                    <span className={HINWEIS_TEXT.fehler}>{hiresSizeError}</span>
                  )}
                </div>
                <Slider label="Upscale" min={1.1} max={3} step={0.1} value={s.hiresScale} onChange={s.setHiresScale} format={(v) => `${v.toFixed(1)}×`} />
                <Slider label="HiRes steps" min={1} max={40} step={1} value={s.hiresSteps} onChange={s.setHiresSteps} />
                <Slider label="HiRes denoise" min={0.05} max={1} step={0.05} value={s.hiresDenoise} onChange={s.setHiresDenoise} format={(v) => v.toFixed(2)} />
                <Field label="Latent upscale method" help="Nearest-exact is the default and preserves hard edges. Bicubic and bilinear provide smoother interpolation; bislerp gives softer latent blending.">
                  <Select
                    size="sm"
                    options={[
                      { value: 'nearest-exact', label: 'nearest-exact' },
                      { value: 'bislerp', label: 'bislerp' },
                      { value: 'bicubic', label: 'bicubic' },
                      { value: 'bilinear', label: 'bilinear' },
                      { value: 'area', label: 'area' },
                    ]}
                    value={s.hiresUpscaleMethod}
                    onChange={(value) => s.setHiresUpscaleMethod(value as HiresUpscaleMethod)}
                  />
                </Field>
              </div>
            )}
          </div>
        )}
      </Section>

      {/* OUTPUT */}
      <Section title="Output" icon={Boxes} defaultOpen>
        <NumberField label="Seed (−1 = random)" value={s.seed} step={1} mono onRandomize={() => s.setSeed(-1)} onChange={s.setSeed} />
        {/* Batch size has no cloud path — CloudJobParams carries no batch
            field and useCloudCreate always stamps 1. */}
        {!isVideo && !isCloud && <Slider label="Batch size" min={1} max={8} step={1} value={s.batchSize} onChange={s.setBatchSize} />}
        {isVideo && (
          <div className="grid grid-cols-2 gap-2">
            <Slider label="Frames" min={1} max={120} step={1} value={s.frames} onChange={s.setFrames} />
            <Slider label="FPS" min={1} max={60} step={1} value={s.fps} onChange={s.setFps} />
          </div>
        )}
      </Section>

      {/* EXPERT — every control in here is dropped by the Mac MLX pipeline, so
          the whole section is hidden on the local Mac (kept on cloud + ComfyUI). */}
      {!isMlxLocal && (
      <Section title="Expert" icon={FlaskConical} defaultOpen={false}>
        {/* Sampler/Scheduler are ComfyUI-only knobs — the hosted WaveSpeed
            endpoints don't accept them, so hide them on the cloud backend
            rather than let the user tune a control that's silently dropped. */}
        {!isCloud && (
          <>
            <Field label="Sampler" help="The algorithm that turns noise into your image. dpmpp_2m / euler are safe all-rounders.">
              <Select size="sm" options={samplers.map((x) => ({ value: x, label: x }))} value={s.sampler} onChange={s.setSampler} />
            </Field>
            <Field label="Scheduler" help="How the denoise steps are spaced. karras is a good default for SDXL; simple for FLUX.">
              <Select size="sm" options={schedulers.map((x) => ({ value: x, label: x }))} value={s.scheduler} onChange={s.setScheduler} />
            </Field>
          </>
        )}

        {isEdit && (
          <Slider label="Denoise (raw)" min={0.05} max={1} step={0.05} value={s.denoise} onChange={s.setDenoise} format={(v) => v.toFixed(2)} />
        )}
        {meta.allowsMask && (
          <Slider label="Mask edge feather" min={0} max={64} step={1} value={s.growMaskBy} onChange={s.setGrowMaskBy} unit="px" />
        )}

        {loraSupported && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <div className="t-control text-gray-400">LoRA stack {s.selectedLoras.length > 0 && <span className="t-mono text-gray-600">· {s.selectedLoras.length} active</span>}</div>
              {/* GH #109: the list loads once per connect, so a file dropped
                  into models/loras later never appeared — and with an empty
                  list the whole section was invisible, which read as "no LoRA
                  support at all". Always show it, let the user re-scan. */}
              <button onClick={() => { void refreshModelLists() }} title="Re-scan ComfyUI's models/loras folder" className="t-control text-gray-500 hover:text-gray-300 inline-flex items-center gap-1">
                <RotateCcw className="w-3 h-3" /> Rescan
              </button>
            </div>
            {loraList.length === 0 ? (
              <div className="t-control text-gray-600">No LoRAs found yet. Drop .safetensors files into ComfyUI&apos;s models/loras folder and hit Rescan. Characters trained in Character Studio land there automatically.</div>
            ) : (
            <div className="space-y-1 max-h-44 overflow-y-auto scrollbar-thin">
              {loraList.map((name) => {
                const active = s.selectedLoras.find((l) => l.name === name)
                return (
                  <div key={name} className={cn('rounded-md border transition-colors', active ? 'border-white/15 bg-white/[0.06]' : 'border-white/[0.06]')}>
                    <button onClick={() => s.toggleLora(name)} className="w-full flex items-center justify-between px-2.5 py-1.5 t-control text-left text-gray-300">
                      <span className="truncate">{name.replace(/\.safetensors$/, '')}</span>
                      <span className={cn('t-mono', active ? 'text-emerald-400' : 'text-gray-600')}>{active ? 'on' : 'off'}</span>
                    </button>
                    {active && (
                      <div className="px-2.5 pb-2">
                        <Slider min={0} max={2} step={0.05} value={active.strength} onChange={(v) => s.setLoraStrengthFor(name, v)} format={(v) => v.toFixed(2)} />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            )}
          </div>
        )}

        {!isCloud && !isVideo && (
          <Field label="VAE" help="Override the checkpoint's built-in VAE. 'auto' lets the checkpoint decide.">
            <Select size="sm" options={vaes.map((v) => ({ value: v, label: v }))} value={s.selectedVae} onChange={s.setSelectedVae} />
          </Field>
        )}
        {!isCloud && !isVideo && (
          <Slider label="Skip CLIP layers" min={0} max={12} step={1} value={s.clipSkip} onChange={s.setClipSkip} />
        )}
      </Section>
      )}
    </div>
  )
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className="t-control text-gray-400">{label}</span>
        {help && <HelpDot help={help} />}
      </div>
      {children}
    </div>
  )
}

function HelpDot({ help }: { help: string }) {
  return (
    <Tooltip content={help} side="bottom">
      <HelpCircle size={12} className="text-gray-600 hover:text-gray-400" />
    </Tooltip>
  )
}
