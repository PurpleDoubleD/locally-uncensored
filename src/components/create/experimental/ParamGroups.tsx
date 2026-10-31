import { useCallback, useRef, useState } from 'react'
import { Gauge, Boxes, FlaskConical, RotateCcw, HelpCircle, RectangleHorizontal, RectangleVertical, X, FolderOpen, Search, Copy, Check } from 'lucide-react'
import { VIDEO_RES_PRESETS, ASPECT_RATIOS, applyAspect, presetForOrientation, matchesPreset } from '../../../lib/create-resolution'
import { useCreateStore } from '../../../stores/createStore'
import { useCreateExp } from './CreateContext'
import { cloudModelById, defaultCloudModel } from '../../../stores/cloudCatalogStore'
import { classifyModel } from '../../../api/comfyui'
import { editIgnoresStrength } from '../../../lib/edit-references'
import { latentDownscale, nativeHiresFinalSize, type HiresUpscaleMethod } from '../../../api/hires-fix'
import { isMlxImageHost } from '../../../api/mlx-image'
import { macHiresPass } from '../../../lib/mac-hires'
import { editHiresBase } from '../../../lib/edit-hires'
import { MAC_EDIT_DEAD_SIDE, editCanvas, laneImageModel, macEditSide, runsAtOwnSampling, takesMlxLoras } from '../../../lib/image-engines'
import { qwenEditResolution } from '../../../api/dynamic-workflow'
import { openMlxLoraFolder, mlxLoraAlphaNote, mlxLoraRefusal } from '../../../api/mlx-loras'
import { MLX_VIDEO_MIN_FRAMES, mlxFramesOnGrid, mlxVideoLaneEntry, mlxVideoMaxFrames, mlxVideoRunSize } from '../../../api/mlx-video'
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
import { filterLoraRows, loraCopyText, lorasForRun, loraRows } from '../../../lib/lora-stack'
import { loraStackView, setLoraStackQuery, setLoraStackScroll } from './loraStackView'
import { LoraStrength } from './LoraStrength'
import { cfgHint, loraStrengthHint } from '../../../lib/param-hints'
import { MOTION_OWN_WORKFLOW_NOTE, useMotionOwnWorkflow } from './motionWorkflow'
import { supportsTransparent } from '../../../lib/transparent-image'
import { isQwenImage21Turbo } from '../../../lib/render/qwen21-turbo'
import { QWEN_ENCODER_HELP, pickQwenEncoder, qwenEncoderOptions, type QwenEncoderVariant } from '../../../lib/render/qwen-text-encoder'
import { MAX_SHOTS, MAX_SHOT_CHARS, supportsMultishot } from '../../../lib/ltx-multishot'
import { frameRangeFor, framesOnRange, lengthHint } from '../../../lib/video-length'
import { LongVideoControls } from './LongVideoControls'
import { useMacMemoryGb } from '../../../lib/mac-memory'

// Video families whose dynamic-workflow strategy actually wires a LoRA node:
// the generic UNET path (wan/hunyuan/ltx/mochi/cosmos) plus Wan 2.2's dedicated
// builder (LoraLoaderModelOnly insert). The remaining families (cogvideo/svd/
// framepack/pyramidflow/allegro) use wrapper nodes with no LoRA seam, so we hide
// the stack for them rather than offer a control that silently does nothing.
const VIDEO_LORA_FAMILIES = new Set(['wan', 'wan22', 'hunyuan', 'ltx', 'mochi', 'cosmos', 'minimaxh3'])

// The full param surface, reorganized into 3 frequency-ranked Sections.
// Sampler/scheduler/LoRA/VAE lists come live from ComfyUI via CreateContext,
// falling back to the standard node names until they load.
export function ParamGroups() {
  const s = useCreateStore()
  const { samplerList, schedulerList, loraList, loraKeys, loraAlpha, vaeList, refreshModelLists } = useCreateExp()
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
  // R2-28, Entscheid vom 12.09.2026: auf der LOKALEN Musikbahn waren fuenf
  // Expert-Regler sichtbar und alle fuenf tot. `dynamic-workflow.ts` nagelt
  // sampler_name, scheduler und denoise fuer Audio fest, `LocalOpParams`
  // traegt weder `loras` noch `selectedVae` noch `clipSkip`, und VAEDecodeAudio
  // nimmt den VAE des Checkpoints. Es ist dieselbe Begruendung, die eine Zeile
  // hoeher fuer den MLX-Mac steht; sie war nur nie auf diese Bahn angewandt.
  // Die Wolken-Musikbahn bleibt unberuehrt.
  const isLocalAudio = isAudio && !isCloud
  // The Mac's video model this lane runs: the stored pick where the lane can
  // run it, else the first one it can (api/mlx-video mlxVideoLaneEntry).
  const macVideo = isMlxLocal && isVideo
  const macVideoEntry = macVideo ? mlxVideoLaneEntry(s.videoModelList, s.videoModel, meta.id) : undefined
  const macClip = macVideoEntry?.mlxVideo
  // The long LTX clip goes by the Mac's memory (api/mlx-video
  // mlxVideoMaxFrames); Motion Control has not run so long.
  const macMemoryGb = useMacMemoryGb(macVideo)
  const macLengthGb = meta.id === 'motion' ? null : macMemoryGb
  // The model the tab runs: on the Mac, Edit lists the models that take an
  // image and a video lane runs the entry above; on a ComfyUI host this is
  // the stored pick, as before.
  const laneModel = isVideo ? (macVideoEntry?.name ?? s.videoModel) : laneImageModel(s.imageModelList, s.imageModel, meta.id)
  // The one Expert control the Mac has: the LoRA stack, for a model of its
  // second image engine (mflux takes `--lora`), in Image and in Edit, and
  // for a video model whose engine takes `--lora` (the quantized LTX packs
  // and Wan, `loras` of its entry). The first image engine (diffusers) and
  // the first engine's LTX have no place for a LoRA, so there the section
  // stays away as before.
  const macLoras = isMlxLocal && (
    ((meta.id === 'image' || meta.id === 'edit') && takesMlxLoras(s.imageModelList, laneModel))
    || (macClip?.loras === true)
  )
  // The Mac's Edit has two more: how far the run starts from noise, and the
  // soft edge of a painted mask (mflux `--strength` and `--mask-image`).
  const macEdit = isMlxLocal && isEdit
  const showExpert = (!isMlxLocal || macLoras || macEdit) && !isLocalAudio && (!isCloud || isEdit)
  // LoRA is a local-only knob; for video it's offered only on families whose
  // builder actually applies it (see VIDEO_LORA_FAMILIES). Image always qualifies.
  // Motion Control and Talking Character build their own graphs from
  // LocalOpParams, which carries no LoRA (api/dynamic-workflow.ts), so the
  // stack set nothing there; and VIDEO_LORA_FAMILIES was asked about the
  // Video tab's model, not the lane's.
  const laneWithoutLoras = meta.id === 'motion' || meta.id === 'lipsync'
  const loraSupported = isMlxLocal
    ? macLoras
    : !isCloud && !laneWithoutLoras && (!isVideo || VIDEO_LORA_FAMILIES.has(classifyModel(s.videoModel)))
  // GH #146: the count is what a run sends, the same rule useCreate applies.
  const laneType = (isVideo ? s.videoModelList : s.imageModelList).find((m) => m.name === laneModel)?.type ?? classifyModel(laneModel)
  const activeLoras = lorasForRun(s.selectedLoras, loraList, laneType).use.length
  const stackRows = loraRows(loraList, s.selectedLoras, laneType)
  // The search and the scroll position outlive the drawer (loraStackView.ts).
  const [loraQuery, setLoraQuery] = useState(() => loraStackView().query)
  const shownRows = filterLoraRows(stackRows, loraQuery)
  const loraListRef = useRef<HTMLDivElement | null>(null)
  // A callback ref: the list mounts later than the drawer when the Expert
  // section is opened after it, and it is put back where it was left then.
  const restoreLoraScroll = useCallback((el: HTMLDivElement | null) => {
    loraListRef.current = el
    if (el) el.scrollTop = loraStackView().scrollTop
  }, [])
  const [copiedLora, setCopiedLora] = useState<string | null>(null)
  const copyLoraName = (name: string) => {
    void navigator.clipboard?.writeText(loraCopyText(name))?.catch(() => null)
    setCopiedLora(name)
    setTimeout(() => setCopiedLora((c) => (c === name ? null : c)), 2000)
  }
  // Which naming the Mac's video engine reads (api/mlx-loras mlxLoraRefusal).
  const macVideoEngine = macClip ? (laneType === 'wan' ? 'wan' as const : 'ltx' as const) : undefined

  // On cloud the worker only honours steps for images and guidance_scale for
  // the flux family — hide the sliders elsewhere rather than show a dead
  // control. Sampler/scheduler/LoRA/VAE/clip-skip/batch have no cloud path at
  // all (useCloudCreate never sends them), so they're local-only knobs.
  const cloudModelId =
    (isVideo ? s.cloudVideoModel : s.cloudImageModel) || defaultCloudModel(isVideo ? 'video' : 'image')?.id || ''
  // A pack of the Mac's second image engine that is tuned to one count (a
  // distilled model, Qwen-Image 2.1 with its Turbo adapter) runs at its own
  // steps and guidance. Neither slider reaches it, so neither is shown.
  const ownSampling = isMlxLocal && !isVideo && runsAtOwnSampling(s.imageModelList, laneModel)
  // D4: each local video family has its own clip length (lib/video-length).
  const frameRange = frameRangeFor(laneType)
  // Past the length a family holds steady, a line under the slider says so.
  const framesHint = lengthHint(laneType, framesOnRange(s.frames, frameRange))
  // The Mac's video engines take a length, and where the model's entry says
  // so a size on its grid and a step count (api/mlx-video.ts): the quantized
  // LTX packs and Wan take a size, Wan takes steps. Guidance is the model's
  // own and its rate is fixed. So the Mac's video lane shows the length and
  // what the entry offers, and none of the sliders that set nothing. Without
  // an installed model not even that: the values would belong to no model.
  const macSize = !!macClip?.sizeGrid
  const macSteps = !!macClip?.steps
  const macRunSize = macClip ? mlxVideoRunSize(s.width, s.height, macClip) : null
  // The Mac's Edit scales its images to the pixel budget of the canvas, and
  // never to 1024: the model does not edit there, so the run takes 1056
  // (lib/image-engines). Where the canvas works out to 1024, the settings
  // say which size runs.
  const macEditRuns = isMlxLocal && meta.id === 'edit' && qwenEditResolution(s.width, s.height) === MAC_EDIT_DEAD_SIDE
    ? macEditSide(MAC_EDIT_DEAD_SIDE)
    : null
  // The Mac's music engine takes the style, the lyrics, the length and the
  // seed. Its turbo model runs at its own steps and guidance (music.rs), so
  // the seed is all that is left here.
  const macMusic = isMlxLocal && isAudio
  const showSteps = !(isCloud && isVideo) && !ownSampling && (!macVideo || macSteps) && !macMusic
  const showSize = !isAudio && (!macVideo || macSize)
  const showCfg = isCloud ? cloudModelById(cloudModelId)?.cfg === true : !ownSampling && !macVideo && !macMusic
  // Qwen-Image 2.1 Turbo on ComfyUI runs the eight step schedule of its
  // official template (lib/render/qwen21-turbo): a line says which sliders
  // reach it. The Mac's Turbo pack is another model and hides the sliders.
  const qwenTurbo = !isCloud && !isVideo && !isMlxLocal && isQwenImage21Turbo(laneModel)
  // Native HiRes rewrites the local ComfyUI image graph: text to image, and
  // since 3.0.8 Edit too (Discord feature request 21.10.2026). It has no
  // cloud or video path, so keep the control honest and scoped to the lanes
  // that can execute it. On the Mac that is a model that edits
  // (Qwen-Image 2.1): its second pass is an edit of the finished picture at
  // the larger size (lib/mac-hires).
  const hiresLane = meta.id === 'image' || isEdit
  const macHires = isMlxLocal && hiresLane
    && (s.imageModelList.find((m) => m.name === laneModel)?.editImages ?? 0) > 0
  const showHiresFix = !isCloud && !isVideo && hiresLane && (!isMlxLocal || macHires)
  // In Edit the picture comes out in the shape of the source, not of the
  // sliders (lib/edit-hires). Without a source there is nothing to name yet.
  const hiresBase = isEdit && !macHires
    ? editHiresBase({ source: s.source, width: s.width, height: s.height, modelType: laneType, modelName: laneModel })
    : isEdit && macHires
      // The Mac's edit comes back in the shape of the source, on the canvas
      // the engine runs (1056 where the sliders say 1024, lib/image-engines).
      ? (s.source ? editCanvas(macEditSide(qwenEditResolution(s.width, s.height)), s.source) : null)
      : { width: s.width, height: s.height }
  // The grid a typed width or height is rounded to: the local model's latent
  // cell. The cloud keeps the 64 its providers were checked against.
  const sizeGrid = isCloud ? 64 : latentDownscale(laneType)
  let hiresFinal: { width: number; height: number } | null = null
  let hiresSizeError: string | null = null
  if (showHiresFix && s.hiresFixEnabled && isEdit && !macHires && s.mask) {
    // ComfyUI's masked edit is an inpaint latent; api/hires-fix refuses it.
    hiresSizeError = 'Native HiRes runs on edits of the whole picture. Clear the mask to use it.'
  } else if (showHiresFix && s.hiresFixEnabled && !hiresBase) {
    hiresSizeError = 'Add the picture to edit, then the final size shows here.'
  } else if (showHiresFix && s.hiresFixEnabled && hiresBase && macHires) {
    // The Mac's second pass lands on the engine's grid and limit.
    const pass = macHiresPass(hiresBase.width, hiresBase.height, { scale: s.hiresScale, steps: s.hiresSteps, denoise: s.hiresDenoise })
    if (pass) hiresFinal = { width: pass.width, height: pass.height }
    else hiresSizeError = 'This size is already as large as the engine makes it.'
  } else if (showHiresFix && s.hiresFixEnabled && hiresBase) {
    try {
      hiresFinal = nativeHiresFinalSize(hiresBase.width, hiresBase.height, s.hiresScale, latentDownscale(laneType))
    } catch (error) {
      hiresSizeError = error instanceof Error ? error.message : String(error)
    }
  }

  // Transparent background: local Qwen-Image 2.1 text-to-image only, the one
  // model family whose VAE writes an alpha channel (lib/transparent-image.ts).
  // On the Mac too: the second image engine keeps the alpha channel, and the
  // switch is the same prompt wrapper (hooks/useCreate.ts).
  const showTransparent = !isCloud && !isVideo && meta.id === 'image' && supportsTransparent(laneType)

  // Text encoder: a local Qwen-Image 2.1 with both editions of its encoder
  // installed, the official one and the one without refusals. Here, in the
  // Expert section, the user says which one reads the prompt. With one
  // edition installed there is nothing to choose and no row.
  const encoderOptions = !isCloud && !isVideo && !isMlxLocal && laneType === 'qwenimage' ? qwenEncoderOptions(s.textEncoderList) : []
  const activeEncoder = pickQwenEncoder(s.textEncoderList, s.qwenTextEncoder)?.variant

  // Shots: LTX 2.5 can cut between several shots in one run, with the same
  // figure (lib/ltx-multishot.ts). Local text-to-video on that model only; on
  // a Mac the LTX-2.5 packs, which the video catalogue names (`multishot`).
  const showShots = !isCloud && meta.id === 'video' && (isMlxLocal ? macClip?.multishot === true : supportsMultishot(laneType))

  // Motion Control with a workflow of the user's own: steps, guidance, size,
  // length, sampler and scheduler are the workflow's (injectLaneParameters),
  // its LoRAs too. The real values are in Workflow parameters below.
  const motionWorkflow = useMotionOwnWorkflow() !== null

  const cfgNote = cfgHint(laneType, s.cfgScale)

  const samplers = samplerList.length ? samplerList : SAMPLERS_FALLBACK
  const schedulers = schedulerList.length ? schedulerList : SCHEDULERS_FALLBACK
  const vaes = vaeList.length ? vaeList : ['auto']

  return (
    <div className="py-1">
      {/* QUALITY */}
      {motionWorkflow && (
        <p className="px-1 pb-2 t-body text-gray-500" data-testid="motion-own-workflow-note">{MOTION_OWN_WORKFLOW_NOTE}</p>
      )}
      {(!macVideo || macSize || macSteps) && !macMusic && !motionWorkflow && (
      <Section title="Quality" icon={Gauge} defaultOpen
        right={<Button variant="ghost" size="sm" icon={RotateCcw} iconOnly title="Reset to model defaults" onClick={s.resetParamsToModelDefaults} />}
      >
        {showSteps && <Slider label="Steps" min={1} max={macVideo ? (macClip?.maxSteps ?? 60) : 60} step={1} value={s.steps} onChange={s.setSteps} />}
        {showCfg && <Slider label={isVideo ? 'Guidance' : 'CFG scale'} min={0} max={30} step={0.5} value={s.cfgScale} onChange={s.setCfgScale} format={(v) => v.toFixed(1)} />}
        {qwenTurbo && (
          <p className="t-micro text-gray-500" data-testid="qwen21-turbo-hint">
            Turbo runs its own 8-step schedule at CFG 1. Steps, sampler and scheduler are not used.
            {s.cfgScale > 1 && ` CFG ${s.cfgScale.toFixed(1)} is above the 1 Turbo is made for and can overcook it.`}
          </p>
        )}
        {/* B50: far above what the model takes, a note with the range that works. It never blocks. */}
        {showCfg && !isVideo && cfgNote && <p className={`t-micro ${HINWEIS_TEXT.ruhig}`} data-testid="cfg-hint">{cfgNote}</p>}
        {showSize && (macSize && macClip ? (
          // The Mac: the model's grid and bounds. What runs is said below.
          <div className="grid grid-cols-2 gap-2">
            <NumberField label="Width" value={s.width} min={macClip.minSide} max={macClip.maxSide} step={macClip.sizeGrid} mono onChange={(v) => s.setSize(v, s.height)} suffix="px" />
            <NumberField label="Height" value={s.height} min={macClip.minSide} max={macClip.maxSide} step={macClip.sizeGrid} mono onChange={(v) => s.setSize(s.width, v)} suffix="px" />
          </div>
        ) : (
        // A typed size lands on the model's own grid (16 for Qwen-Image 2.1,
        // so 1360 stays 1360); the arrows still move by 64.
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="Width" value={s.width} min={64} max={4096} step={64} grid={sizeGrid} mono onChange={(v) => s.setSize(v, s.height)} suffix="px" />
          <NumberField label="Height" value={s.height} min={64} max={4096} step={64} grid={sizeGrid} mono onChange={(v) => s.setSize(s.width, v)} suffix="px" />
        </div>
        ))}
        {macSize && macClip && macRunSize && (
          // The size the run makes: the fields on the model's grid and inside
          // its own pixels (api/mlx-video mlxVideoRunSize, run_size in Rust).
          <p className="t-micro text-gray-500" data-testid="mac-video-size">
            Runs at <span className="t-mono">{macRunSize.width}×{macRunSize.height}</span> px. This model takes sizes in steps of {macClip.sizeGrid} px, up to the pixels of its own <span className="t-mono">{macClip.width}×{macClip.height}</span>.
          </p>
        )}
        {macEditRuns && (
          <p className="t-micro text-gray-500" data-testid="mac-edit-runs-at">
            This edit runs at {macEditRuns} px, not {MAC_EDIT_DEAD_SIDE}: the model does not edit on a {MAC_EDIT_DEAD_SIDE} px canvas.
          </p>
        )}
        {/* D#93 (stasicby): Wan's native sizes as one-click chips, an
            orientation flip, and ratio chips that respend the current pixel
            budget. Everything just writes the same width/height fields. */}
        {showSize && (
        <div className="flex flex-wrap items-center gap-1 pt-1">
          {/* Wan's 720p is more than most Mac models' own size: the Mac
              offers the flip and the ratios, which keep the pixels. */}
          {isVideo && !macVideo && VIDEO_RES_PRESETS.map((p) => (
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
                <span className="block text-[11px] leading-4 text-gray-600">{isEdit ? 'A second pass over the edited picture at a larger size' : macHires ? 'A second pass over the picture at a larger size' : 'Latent upscale plus a native refinement pass'}</span>
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
                      <span className="t-mono text-gray-400">{hiresBase?.width ?? s.width}×{hiresBase?.height ?? s.height}</span>
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
                {!macHires && <Field label="Latent upscale method" help="Nearest-exact is the default and preserves hard edges. Bicubic and bilinear provide smoother interpolation; bislerp gives softer latent blending.">
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
                </Field>}
              </div>
            )}
          </div>
        )}
      </Section>
      )}

      {/* OUTPUT */}
      <Section title="Output" icon={Boxes} defaultOpen>
        <NumberField label="Seed (−1 = random)" value={s.seed} step={1} mono onRandomize={() => s.setSeed(-1)} onChange={s.setSeed} />
        {showTransparent && (
          <button
            type="button"
            role="switch"
            aria-checked={s.transparentBackground}
            onClick={() => s.setTransparentBackground(!s.transparentBackground)}
            className={cn(
              'flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors',
              s.transparentBackground ? 'border-white/15 bg-white/[0.05]' : 'border-white/[0.07]',
            )}
          >
            <span>
              <span className="block t-control text-gray-300">Transparent background</span>
              <span className="block t-micro text-gray-600">Saves a PNG with a see-through background</span>
            </span>
            <span className={cn('t-mono text-xs', s.transparentBackground ? 'text-emerald-400' : 'text-gray-600')}>
              {s.transparentBackground ? 'on' : 'off'}
            </span>
          </button>
        )}
        {!isVideo && !isCloud && !macMusic && <Slider label="Batch size" min={1} max={8} step={1} value={s.batchSize} onChange={s.setBatchSize} />}
        {showShots && (
          <div className="space-y-2">
            <Slider label="Shots" min={1} max={MAX_SHOTS} step={1} value={1 + s.videoShots.length} onChange={s.setVideoShotCount} />
            {s.videoShots.map((text, i) => (
              <label key={i} className="block space-y-1">
                <span className="t-control text-gray-400">Shot {i + 2}</span>
                <textarea
                  rows={2}
                  maxLength={MAX_SHOT_CHARS}
                  value={text}
                  onChange={(e) => s.setVideoShot(i, e.target.value)}
                  placeholder="Describe the next shot…"
                  className="w-full resize-none rounded-[var(--radius-control)] border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 t-control text-gray-200 outline-none transition-colors placeholder:text-gray-600 focus:border-white/25"
                />
              </label>
            ))}
            <p className="t-micro text-gray-600">
              {s.videoShots.length === 0
                ? 'One shot. Add more to cut between shots in one clip.'
                : 'Shot 1 is your prompt. Describe the same person the same way in every shot. More shots need a longer clip.'}
            </p>
          </div>
        )}
        {isVideo && !macVideo && !motionWorkflow && (
          <div className="grid grid-cols-2 gap-2">
            <Slider
              label="Frames"
              min={frameRange.min}
              max={frameRange.max}
              step={frameRange.step}
              value={framesOnRange(s.frames, frameRange)}
              onChange={s.setFrames}
            />
            <Slider label="FPS" min={1} max={60} step={1} value={s.fps} onChange={s.setFps} />
            {framesHint && (
              <p className="col-span-2 t-micro text-gray-500" data-testid="video-length-hint">{framesHint}</p>
            )}
            {!isCloud && (
              <div className="col-span-2">
                <LongVideoControls model={laneModel} intent={meta.id} />
              </div>
            )}
          </div>
        )}
        {macClip && (
          <Slider
            label="Length"
            min={MLX_VIDEO_MIN_FRAMES}
            max={mlxVideoMaxFrames(macClip.frameStep, macLengthGb)}
            step={macClip.frameStep}
            value={mlxFramesOnGrid(s.frames, macClip.frameStep, macLengthGb)}
            onChange={s.setFrames}
            format={(v) => `${v} frames · ${(v / macClip.fps).toFixed(1)}s at ${macClip.fps} fps`}
          />
        )}
        {macClip && !macSize && (
          // The size is the model's own: the engine takes none from Create.
          <p className="t-micro text-gray-500" data-testid="mac-video-size">
            <span className="t-mono">{macClip.width}×{macClip.height}</span> px, the size this model runs at.
          </p>
        )}
      </Section>

      {/* Only render a section with controls the selected backend can use. */}
      {showExpert && !motionWorkflow && (
      <Section title="Expert" icon={FlaskConical} open={s.expertOpen} onOpenChange={s.setExpertOpen}>
        {/* Sampler/Scheduler are ComfyUI-only knobs — the hosted
            endpoints don't accept them, so hide them on the cloud backend
            rather than let the user tune a control that's silently dropped. */}
        {!isCloud && !isMlxLocal && (
          <>
            <Field label="Sampler" help="The algorithm that turns noise into your image. dpmpp_2m / euler are safe all-rounders.">
              <Select size="sm" options={samplers.map((x) => ({ value: x, label: x }))} value={s.sampler} onChange={s.setSampler} />
            </Field>
            <Field label="Scheduler" help="How the denoise steps are spaced. karras is a good default for SDXL; simple for FLUX.">
              <Select size="sm" options={schedulers.map((x) => ({ value: x, label: x }))} value={s.scheduler} onChange={s.setScheduler} />
            </Field>
          </>
        )}

        {isEdit && !isMlxLocal && !(!isCloud && editIgnoresStrength(laneType, laneModel)) && (
          <Slider label="Denoise (raw)" min={0.05} max={1} step={0.05} value={s.denoise} onChange={s.setDenoise} format={(v) => v.toFixed(2)} />
        )}
        {macEdit && (
          // 1.00 is the edit from the prompt alone, as before. Lower starts
          // from the image and keeps more of it.
          <Slider label="Edit strength" min={0.05} max={1} step={0.05} value={s.editStrength} onChange={s.setEditStrength} format={(v) => v.toFixed(2)} />
        )}
        {meta.allowsMask && !isCloud && (
          <Slider label="Mask edge feather" min={0} max={64} step={1} value={s.growMaskBy} onChange={s.setGrowMaskBy} unit="px" />
        )}

        {loraSupported && (
          <div className="space-y-1.5">
            {/* The Mac has a third action, Open folder. In the drawer's width
                the title and the three did not fit on one line: "4 active"
                and "Open folder" each broke in two. There the actions take
                the next line when they have to, and no label breaks. */}
            <div className={cn('flex items-center justify-between', isMlxLocal && 'flex-wrap gap-x-3 gap-y-1 [&_button]:whitespace-nowrap')}>
              <div className={cn('t-control text-gray-400', isMlxLocal && 'whitespace-nowrap')}>LoRA stack {activeLoras > 0 && <span className="t-mono text-gray-600">· {activeLoras} active</span>}</div>
              <div className="flex items-center gap-3">
              {s.selectedLoras.length > 0 && (
                <button onClick={s.clearLoras} title="Turn every LoRA off" className="t-control text-gray-500 hover:text-gray-300 inline-flex items-center gap-1">
                  <X className="w-3 h-3" /> Clear
                </button>
              )}
              {/* GH #109: the list loads once per connect, so a file dropped
                  into models/loras later never appeared — and with an empty
                  list the whole section was invisible, which read as "no LoRA
                  support at all". Always show it, let the user re-scan. */}
              {/* The Mac's LoRAs are files in a folder of the app. The way
                  to put one there is the folder itself. */}
              {isMlxLocal && (
                <button onClick={() => { void openMlxLoraFolder().catch(() => null) }} title="Show the LoRA folder in Finder" className="t-control text-gray-500 hover:text-gray-300 inline-flex items-center gap-1">
                  <FolderOpen className="w-3 h-3" /> Open folder
                </button>
              )}
              <button onClick={() => { void refreshModelLists() }} title={isMlxLocal ? 'Read the LoRA folder again' : "Re-scan ComfyUI's models/loras folder"} className="t-control text-gray-500 hover:text-gray-300 inline-flex items-center gap-1">
                <RotateCcw className="w-3 h-3" /> Rescan
              </button>
              </div>
            </div>
            {loraList.length === 0 ? (
              isMlxLocal
                ? <div className="t-control text-gray-600">No LoRAs found yet. Put .safetensors files into the LoRA folder (Open folder) and hit Rescan, or get one under Models, LoRAs.</div>
                : <div className="t-control text-gray-600">No LoRAs found yet. Drop .safetensors files into ComfyUI&apos;s models/loras folder and hit Rescan. Characters trained in Character Studio land there automatically.</div>
            ) : stackRows.length === 0 ? (
              <div className="t-control text-gray-600">The LoRAs in {isMlxLocal ? 'the LoRA folder' : 'models/loras'} are made for other models. Pick the model they belong to, or drop in a LoRA for this one and hit Rescan.</div>
            ) : (
            <>
            {/* A text field in the role of a search box: type="search" empties
                itself on Escape, and Escape also closes the drawer, so the
                search was gone with the drawer it was meant to outlive. */}
            <div className="relative">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-600 pointer-events-none" />
              <input
                type="text"
                role="searchbox"
                value={loraQuery}
                onChange={(e) => {
                  setLoraQuery(e.target.value)
                  setLoraStackQuery(e.target.value)
                  if (loraListRef.current) loraListRef.current.scrollTop = 0
                }}
                placeholder="Search LoRAs"
                aria-label="Search LoRAs"
                autoComplete="off"
                spellCheck={false}
                className="w-full h-7 pl-7 pr-2 rounded-[var(--radius-control)] bg-white/[0.04] border border-white/[0.08] focus:border-white/20 outline-none t-control text-gray-200 placeholder:text-gray-600"
              />
            </div>
            {shownRows.length === 0 ? (
              <div className="t-control text-gray-600">No LoRA matches &quot;{loraQuery.trim()}&quot;.</div>
            ) : (
            <div ref={restoreLoraScroll} onScroll={(e) => setLoraStackScroll(e.currentTarget.scrollTop)} data-testid="lora-stack-list" className="space-y-1 max-h-44 overflow-y-auto scrollbar-thin">
              {/* Gegenprobe 8 (02.10.): "Z-Image only" showed only after a
                  click, and the strength had no number next to it.
                  03.10.: the H3 turbo LoRA was offered on an image model, and
                  its file name was cut off. A LoRA from the catalogue is
                  listed where its family runs, under its catalogue name, with
                  the file name as the tooltip (lib/lora-stack.ts).
                  GitHub discussion #150: a long name was cut off at the
                  drawer's width, so two LoRAs that start alike read the
                  same. A name takes as many lines as it needs. */}
              {shownRows.map(({ name, label, file, fits, familyLabel }) => {
                const active = s.selectedLoras.find((l) => l.name === name)
                // The Mac knows from the folder listing what the run would
                // refuse after the click (a Kohya file on Qwen-Image 2.1, a
                // file that is no safetensors). Such a row says so and cannot
                // be turned on; one that is still on can be turned off, and
                // reads in the error tone, because its run will fail.
                const refused = isMlxLocal ? mlxLoraRefusal(loraKeys?.[name], !isVideo && laneType === 'qwenimage', macVideoEngine) : null
                if (refused) {
                  return (
                    <div key={name} data-testid="lora-stack-refused" className={cn('rounded-md border transition-colors', active ? 'border-white/15 bg-white/[0.06]' : 'border-white/[0.06]')}>
                      <div className="flex items-stretch">
                        <button
                          onClick={() => { if (active) s.toggleLora(name) }}
                          aria-disabled={!active}
                          title={active ? `${refused.title} Click to turn it off.` : refused.title}
                          className={cn('flex-1 min-w-0 flex items-center justify-between gap-2 pl-2.5 pr-1 py-1.5 t-control text-left', active ? 'text-gray-300' : 'text-gray-500 cursor-default')}
                        >
                          <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
                          <span className={cn('t-mono shrink-0', active ? HINWEIS_TEXT.fehler : 'text-gray-600')}>{active ? `on, ${refused.label}` : refused.label}</span>
                        </button>
                        <CopyLoraName name={name} copied={copiedLora === name} onCopy={copyLoraName} />
                      </div>
                    </div>
                  )
                }
                // The Mac: a file whose layers carry different alphas runs at
                // the strength set here on Qwen-Image 2.1, and says so where
                // the strength is set.
                const alphaNote = isMlxLocal && laneType === 'qwenimage' ? mlxLoraAlphaNote(loraAlpha?.[name]) : null
                const strengthNote = active ? loraStrengthHint(file, active.strength) : null
                return (
                  <div key={name} className={cn('rounded-md border transition-colors', active ? 'border-white/15 bg-white/[0.06]' : 'border-white/[0.06]')}>
                    <div className="flex items-stretch">
                      <button onClick={() => s.toggleLora(name)} title={file} className="flex-1 min-w-0 flex items-center justify-between gap-2 pl-2.5 pr-1 py-1.5 t-control text-left text-gray-300">
                        <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
                        <span className={cn('t-mono shrink-0', active && fits ? (isMlxLocal ? 'text-emerald-600 dark:text-emerald-400' : 'text-emerald-400') : 'text-gray-600')}>{fits ? (active ? 'on' : 'off') : `${familyLabel} only`}</span>
                      </button>
                      <CopyLoraName name={name} copied={copiedLora === name} onCopy={copyLoraName} />
                    </div>
                    {active && fits && (
                      <div className="px-2.5 pb-2">
                        <LoraStrength name={label} value={active.strength} onChange={(v) => s.setLoraStrengthFor(name, v)} />
                        {alphaNote && <p className="mt-1.5 t-micro text-gray-500" data-testid="lora-alpha-note">{alphaNote}</p>}
                        {strengthNote && <p className={`mt-1.5 t-micro ${HINWEIS_TEXT.ruhig}`} data-testid="lora-strength-hint">{strengthNote}</p>}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            )}
            </>
            )}
          </div>
        )}

        {!isCloud && !isVideo && !isMlxLocal && (
          <Field label="VAE" help="Override the checkpoint's built-in VAE. 'auto' lets the checkpoint decide.">
            <Select size="sm" options={vaes.map((v) => ({ value: v, label: v }))} value={s.selectedVae} onChange={s.setSelectedVae} />
          </Field>
        )}
        {encoderOptions.length > 0 && activeEncoder && (
          <Field label="Text encoder" help={QWEN_ENCODER_HELP}>
            <Select size="sm" ariaLabel="Text encoder" options={encoderOptions.map((o) => ({ value: o.id, label: o.label }))} value={activeEncoder} onChange={(v) => s.setQwenTextEncoder(v as QwenEncoderVariant)} />
          </Field>
        )}
        {!isCloud && !isVideo && !isMlxLocal && (
          <Slider label="Skip CLIP layers" min={0} max={12} step={1} value={s.clipSkip} onChange={s.setClipSkip} />
        )}
      </Section>
      )}
    </div>
  )
}

/** Copies the file name of a row (Discord 2026-10-23: trigger words are kept
 *  in the file name). Beside the row's own button, since a button cannot hold
 *  another one. Its accessible name leaves the LoRA out, so a search for a
 *  row by its name still finds the row alone. */
function CopyLoraName({ name, copied, onCopy }: { name: string; copied: boolean; onCopy: (name: string) => void }) {
  return (
    <button
      onClick={() => onCopy(name)}
      title={copied ? 'Copied' : `Copy "${loraCopyText(name)}"`}
      aria-label={copied ? 'Copied' : 'Copy file name'}
      className="shrink-0 px-2 text-gray-600 hover:text-gray-300 transition-colors"
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
    </button>
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
