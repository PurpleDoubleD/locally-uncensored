import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, X, History, SlidersHorizontal, Square, Workflow } from 'lucide-react'
import { useCreateStore, MODEL_TYPE_DEFAULTS } from '../../../stores/createStore'
import { classifyModel } from '../../../api/comfyui'
import { useCreateExp } from './CreateContext'
import { intentToJob } from '../../../lib/render/cloud-jobs'
import { meterState } from '../../../lib/render/credits-meter'
import {
  cloudModelById,
  defaultCloudModel,
  defaultEditModel,
  isEditCapable,
  modelForOp,
  runCredits,
} from '../../../stores/cloudCatalogStore'
import { INTENT_MAP } from './intents'
import { subscribeInstallRuns, getInstallRun } from '../../../lib/model-install-runs'
import { useWorkflowStore, shouldShowManagerNotice } from '../../../stores/workflowStore'
import { noPromptHint, shouldShowLaneHint } from './laneHint'
import { ModelChip } from './ModelChip'
import { SpecialControls } from './SpecialIntentControls'
import { CreditsMeter } from './CreditsMeter'
import { Button } from '../ui/Button'
import { PromptField } from '../ui/PromptField'
import { Segmented } from '../ui/Segmented'
import { Slider } from '../ui/Slider'
import { Tooltip } from '../ui/Tooltip'
import { cn } from '../ui/cn'
import { useClickAway } from '../ui/useClickAway'

interface Props {
  onOpenAdvanced: () => void
  onOpenWorkflows: () => void
}

export function Composer({ onOpenAdvanced, onOpenWorkflows }: Props) {
  const intent = useCreateStore((s) => s.intent())
  const meta = INTENT_MAP[intent]
  const prompt = useCreateStore((s) => s.prompt)
  const setPrompt = useCreateStore((s) => s.setPrompt)
  const negativePrompt = useCreateStore((s) => s.negativePrompt)
  const setNegativePrompt = useCreateStore((s) => s.setNegativePrompt)
  const showNegative = useCreateStore((s) => s.showNegative)
  const toggleNegative = useCreateStore((s) => s.toggleNegative)
  const source = useCreateStore((s) => s.source)
  const isGenerating = useCreateStore((s) => s.isGenerating)
  const backend = useCreateStore((s) => s.backend)
  const targetResolution = useCreateStore((s) => s.targetResolution)
  const setTargetResolution = useCreateStore((s) => s.setTargetResolution)
  const cloudImageModel = useCreateStore((s) => s.cloudImageModel)
  const cloudVideoModel = useCreateStore((s) => s.cloudVideoModel)
  const cloudOpModel = useCreateStore((s) => s.cloudOpModel)
  const frames = useCreateStore((s) => s.frames)
  const fps = useCreateStore((s) => s.fps)
  // 2.5.8 specialized-intent inputs (readiness for the Create button).
  const characterTab = useCreateStore((s) => s.characterTab)
  const trainImages = useCreateStore((s) => s.trainImages)
  const selectedCharacter = useCreateStore((s) => s.selectedCharacter)
  const audioInput = useCreateStore((s) => s.audioInput)
  const voiceFromJob = useCreateStore((s) => s.voiceFromJob)
  const videoInput = useCreateStore((s) => s.videoInput)
  const extendSource = useCreateStore((s) => s.extendSource)
  const musicDuration = useCreateStore((s) => s.musicDuration)
  const managerNoticeSeen = useWorkflowStore((s) => s.managerNoticeSeen)
  const { generate, cancel, quota } = useCreateExp()

  // The Create button turns into Cancel in place — a double-click's second
  // press would instantly cancel the run it just started. Ignore cancel
  // presses in the first 400ms after starting.
  const startedAt = useRef(0)
  const guardedGenerate = useCallback(() => {
    startedAt.current = Date.now()
    generate()
  }, [generate])
  const guardedCancel = useCallback(() => {
    if (Date.now() - startedAt.current < 400) return
    cancel()
  }, [cancel])

  // Single-purpose endpoints (cutout/upscale/eraser): no prompt, no
  // generation knobs, no model choice — just the input (+ mask/resolution).
  const isUtility = meta.id === 'removebg' || meta.id === 'upscale' || meta.id === 'eraser'
  // 2.5.8 categories with their own composer surfaces + input contracts.
  const special =
    intent === 'character' || intent === 'lipsync' || intent === 'music' ||
    intent === 'extend' || intent === 'motion'
  const characterUse = intent === 'character' && characterTab === 'use'
  let { kind: intentKind, op: intentOp } = intentToJob(intent)
  if (characterUse) {
    // The use-surface is a plain image generate with the character attached.
    intentKind = 'image'
    intentOp = 'generate'
  }
  // The prompt field shows wherever the run consumes one — that's the meta
  // flag, plus Character-Studio's use-surface (train has no prompt).
  const needPrompt = meta.needsPrompt || characterUse
  // Gate on the exact run's cost (model + op + clip length), the same figure
  // the CreditsMeter shows — quota.costs[kind] is only the tier's
  // representative per-kind number and would mis-gate utility ops / pricier
  // models.
  const pickedModel = characterUse
    ? 'flux-schnell-lora'
    : special
      ? cloudOpModel
      : (intentKind === 'video' ? cloudVideoModel : cloudImageModel) ||
        defaultCloudModel(intentKind)?.id || ''
  const runSeconds =
    intentOp === 'music'
      ? musicDuration
      : intentKind === 'video' && (intentOp === 'generate' || intentOp === 'animate') && fps > 0
        ? frames / fps
        : undefined
  const costFallback = quota?.costs[intentKind === 'audio' ? 'image' : intentKind] ?? 0
  // The exact rule the meter chip renders, so the button can never invite a run
  // the chip is already refusing. Credits alone were not enough: a user out of
  // monthly character trainings kept an enabled Create button and got a 429.
  const creditsOk =
    backend !== 'cloud' ||
    (quota != null &&
      meterState(
        quota,
        runCredits(intentKind, intentOp, pickedModel, runSeconds, costFallback, targetResolution),
        intentKind,
        intentOp,
      ).kind === 'ok')
  // Match useCloudCreate's submit-time edit fallback so the Neg gate reflects
  // the model the run actually uses, not a t2i model still in the picker.
  const runModel =
    intentOp === 'edit' && !isEditCapable(pickedModel) ? (defaultEditModel()?.id ?? pickedModel) : pickedModel
  // The hosted endpoints only honour negative_prompt for a few families —
  // hide the toggle (and the collapsed field) where it would be silently
  // dropped, like the other dead knobs on cloud.
  const negSupported = backend !== 'cloud' || cloudModelById(runModel)?.negative_prompt === true
  // Per-intent readiness for the 2.5.8 categories (mirrors the submit-time
  // checks of BOTH lanes so the button never invites a doomed run). The
  // local lanes always speak from a portrait (no hosted resync endpoints)
  // and extend continues from the picked clip's extracted last frame, which
  // lives in `source`.
  const lipsyncNeedsClip =
    backend === 'cloud' &&
    intent === 'lipsync' &&
    cloudModelById(modelForOp('video', 'lipsync', cloudOpModel))?.lipsync_source === 'video'
  const specialReady =
    intent === 'character'
      ? (characterUse ? !!selectedCharacter : trainImages.length >= 4)
      : intent === 'lipsync'
        ? (!!audioInput || (backend === 'cloud' && !!voiceFromJob)) && (lipsyncNeedsClip ? !!videoInput : !!source)
        : intent === 'extend'
          ? (backend === 'cloud' ? !!extendSource : !!source)
          : intent === 'motion'
            ? !!source && !!videoInput
            : true
  // A half-installed bundle is pickable long before it is usable: the lane
  // list refills as soon as the diffusion model lands, while the VAE it needs
  // is still coming down. Measured on the box 2026-08-15 at 88 percent of the
  // Wan 2.2 bundle. Submitting there buys a ComfyUI error about a file that is
  // already on its way, so the button waits for the run that is filling this
  // lane. Local only: a cloud render needs nothing from that download.
  const installing = useSyncExternalStore(
    subscribeInstallRuns,
    () => (backend === 'local' && meta.requiresModels ? getInstallRun(meta.requiresModels).running : false),
  )
  const canGenerate =
    (!needPrompt || prompt.trim().length > 0) &&
    (!meta.needsSource || !!source) &&
    specialReady &&
    creditsOk &&
    !installing
  const showNoPromptHint = shouldShowLaneHint({ needPrompt, isGenerating, intent, specialReady })

  return (
    // A stable min-height (bottom-anchored) so the prompt window occupies the
    // same vertical space on every tab — utility modes (no LaneControls / no
    // prompt) don't shrink it. That keeps the viewer + gallery row above it the
    // exact SAME height across all tabs, not just within one.
    <div className="shrink-0 px-4 pb-4 pt-2 min-h-[192px] flex flex-col justify-end">
      {/* 660, nicht 760: dieselbe Spalte wie im Chat, und dieselbe Rechnung.
          Die 760 waren hier als KOPIE von --lu-measure eingetippt; seit die
          App eine --ui-scale hat, wird die Zahl mitskaliert, 760 ergaebe also
          874 gerenderte px. 660 × 1.15 = 759 — die Breite, die diese Spalte
          vor der Umstellung hatte. Siehe --lu-measure in index.css; dass die
          Zahl hier doppelt steht statt den Token zu lesen, ist ein eigener
          Befund und hier nicht behoben. */}
      <div className="mx-auto w-full max-w-[660px] space-y-2.5">
        {special && <SpecialControls intent={intent} />}
        {!isUtility && <LaneControls />}

        <div className="rounded-[var(--radius-panel)] bg-white/[0.03] border border-white/[0.06] focus-within:border-white/15 transition-colors">
          {needPrompt && (
            <div className="px-3.5 pt-3">
              <PromptField
                value={prompt}
                onChange={setPrompt}
                placeholder={characterUse ? 'Describe the scene for your character…' : meta.placeholder}
                onSubmit={() => canGenerate && !isGenerating && guardedGenerate()}
              />
            </div>
          )}

          {/* Das Negativfeld sieht aus wie ein Feld.
              Bis 2.6.7 war es eine randlose Zeile unter einer 1px-Trennlinie,
              in derselben Schriftgroesse (13px) und auf derselben Kante
              (x=282,2 gemessen) wie der Prompt darueber — nichts an ihm sagte
              „hier faengt eine zweite Eingabe an". Der Wert stand zudem in
              `text-gray-400`, waehrend die globale Platzhalterregel gray-200
              malte: 6,78:1 fuer das Getippte gegen 13,91:1 fuer den
              Platzhalter (WCAG 2.1 auf #1b1b1b, gemessen 01.09.2026). Das Feld
              war leer auffaelliger als gefuellt.
              Jetzt: eigene Flaeche + eigener Rand (dasselbe Rezept wie das
              Panel drumherum, eine Stufe schwaecher), und der eingetippte
              Negativprompt ist ein Wert wie jeder andere — er erbt die
              Textfarbe des Promptfeldes statt gedimmt zu werden. Wie stark
              der Platzhalter dagegen zuruecktritt, entscheidet jetzt
              ausschliesslich die ::placeholder-Regel in index.css. */}
          <AnimatePresence>
            {showNegative && needPrompt && negSupported && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div
                  id="negative-prompt-field"
                  className="mx-3.5 mt-2.5 px-2.5 py-2 rounded-[var(--radius-control)] bg-white/[0.03] border border-white/[0.08] focus-within:border-white/20 transition-colors"
                >
                  <span className="t-label text-gray-500 block pb-1">Negative prompt</span>
                  <PromptField
                    value={negativePrompt}
                    onChange={setNegativePrompt}
                    placeholder="What to avoid…"
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {showNoPromptHint && (
            <div className="px-3.5 py-3 t-body text-gray-500">
              {noPromptHint(meta.id)}
            </div>
          )}

          {/* Action bar */}
          <div className="flex items-center gap-1.5 px-2.5 py-2 border-t border-white/[0.05]">
            {/* Ein Schalter, der sagt, dass er einer ist. „Neg" war eine
                Abkuerzung, deren Aufloesung nur im Hover-`title` stand, und
                der Knopf meldete seinen Zustand an nichts ausser der
                Hintergrundfarbe: kein `aria-pressed`, kein `aria-expanded`,
                also fuer einen Screenreader ein gewoehnlicher Knopf ohne
                Zustand. Beides steht jetzt da, und `aria-controls` zeigt auf
                das Feld, das er aufklappt. */}
            {needPrompt && negSupported && (
              <button
                onClick={toggleNegative}
                aria-pressed={showNegative}
                aria-expanded={showNegative}
                aria-controls="negative-prompt-field"
                className={cn('t-control px-2 h-[var(--control-h-sm)] rounded-md transition-colors', showNegative ? 'bg-white/10 text-gray-200' : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.05]')}
                title="Say what the render should avoid"
              >
                Negative
              </button>
            )}
            {needPrompt && <PromptHistory onPick={setPrompt} />}
            <div className="flex-1" />
            {/* The backend axis moved to the global header switch (2.5.7) —
                the Composer just reflects it via the CreditsMeter. */}
            {backend === 'cloud' && <CreditsMeter />}
            {meta.id === 'upscale' && (
              <Tooltip content="Target resolution for the upscale pass.">
                <div>
                  <Segmented
                    size="sm"
                    layoutId="upscale-res"
                    value={targetResolution}
                    onChange={(v) => setTargetResolution(v as '2k' | '4k' | '8k')}
                    options={[{ value: '2k', label: '2K' }, { value: '4k', label: '4K' }, { value: '8k', label: '8K' }]}
                  />
                </div>
              </Tooltip>
            )}
            {/* Custom ComfyUI graphs only run on the local backend, so the
                manager only shows where it can do something. Until the button
                was clicked once, a small dot marks it as new (David
                2026-08-02: no banner line, just a minimal marker that goes
                away on click). */}
            {backend === 'local' && (
              <Tooltip content="Your own ComfyUI workflows, and the tags that pair them with models.">
                <div className="relative">
                  <Button variant="ghost" size="sm" icon={Workflow} iconOnly onClick={onOpenWorkflows} title="Workflows and tags" />
                  {shouldShowManagerNotice(backend, managerNoticeSeen) && (
                    <span
                      aria-hidden
                      className="absolute top-0 right-0 w-1.5 h-1.5 rounded-full bg-lu-accent pointer-events-none"
                    />
                  )}
                </div>
              </Tooltip>
            )}
            {!isUtility && (
              <>
                <ModelChip />
                <Tooltip content="All advanced settings. Sampler, seed, LoRA, VAE and more.">
                  <Button variant="ghost" size="sm" icon={SlidersHorizontal} iconOnly onClick={onOpenAdvanced} title="Advanced settings" />
                </Tooltip>
              </>
            )}
            {isGenerating ? (
              <Button variant="danger" size="md" icon={X} onClick={guardedCancel}>Cancel</Button>
            ) : (
              <Button variant="primary" size="lg" icon={Sparkles} disabled={!canGenerate} onClick={guardedGenerate}>Create</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Die Reglerzeile steht auf DERSELBEN Kante wie der Prompttext darunter.
 *
 * Bis 2.6.7 stand auf allen vier Rueckgaben von LaneControls
 * `justify-center` — die Knoepfe schwebten mittig ueber einem linksbuendigen
 * Prompt. Gemessen am 01.09.2026 (Chromium 149, 1280x800, gerenderte Pixel):
 * der Composer-Block beginnt bei x=265,1, der Prompttext bei x=282,2, die
 * Quality-Gruppe aber bei x=424,7 — 142,5 px weiter rechts, ohne dass
 * irgendetwas an dieser Kante haengt. Zwei Kanten, wo eine gehoert.
 *
 * (Der zweite Teil des alten Befundes, `transform: scale(0.7)` auf derselben
 * Zeile, ist mit c7076fca weg und wird von ein-massstab.test.ts bewacht —
 * hier steht nur noch die Ausrichtung.)
 *
 * Die 15px sind kein gewaehlter Wert: das Promptfeld sitzt in einem Panel mit
 * 1px Rand und `px-3.5` = 14px Innenabstand, sein Text beginnt also 15px
 * hinter der Panelkante. Die Reglerzeile ist ein Geschwister dieses Panels mit
 * derselben linken Kante, hat aber selbst keinen Rand — 15px linkes Padding
 * setzt sie exakt auf x=282,2. Beides sind CSS-Pixel unter demselben
 * `--ui-scale`-zoom, die Kanten koennen also nicht auseinanderlaufen.
 */
const LANE_ROW = 'flex items-center flex-wrap justify-start pl-[15px]'

// Quality (proxy over steps) + Aspect (image) + Edit strength (edit).
// The tuning row above the prompt. It renders exactly the knobs the lane's
// submit path actually consumes, so nothing on screen is a dead control:
//   • image (generate / edit / character-use): quality + aspect (+ edit str)
//   • video LOCAL (any lane): steps + size + frames (frames follow the voice
//     on lipsync, so it's hidden there — useCreate derives it from the audio)
//   • video CLOUD regular (video / animate): same, cloud honours w/h/steps/frames
//   • video CLOUD specialized (lipsync / extend / motion): hidden — those ops
//     submit "bare" (fixed server-side), so the sliders would do nothing
//   • audio LOCAL (music): steps (Length lives in MusicControls)
//   • audio CLOUD (music): hidden — bare submit carries only duration + lyrics
function LaneControls() {
  const intent = useCreateStore((s) => s.intent())
  const meta = INTENT_MAP[intent]
  const backend = useCreateStore((s) => s.backend)
  const characterTab = useCreateStore((s) => s.characterTab)
  const steps = useCreateStore((s) => s.steps)
  const setSteps = useCreateStore((s) => s.setSteps)
  const denoise = useCreateStore((s) => s.denoise)
  const setDenoise = useCreateStore((s) => s.setDenoise)
  const imageModelType = useCreateStore((s) => s.imageModelType)
  const width = useCreateStore((s) => s.width)
  const height = useCreateStore((s) => s.height)
  const setSize = useCreateStore((s) => s.setSize)
  const frames = useCreateStore((s) => s.frames)
  const setFrames = useCreateStore((s) => s.setFrames)
  const fps = useCreateStore((s) => s.fps)
  const videoModel = useCreateStore((s) => s.videoModel)

  const base = MODEL_TYPE_DEFAULTS[imageModelType]?.steps ?? 25
  const qSteps = { Draft: Math.round(base * 0.6), Standard: base, High: Math.round(base * 1.5) }
  const activeQ = nearestKey(qSteps, steps)

  // Character-Studio forks: the Train surface owns its own step control
  // (trainSteps in SpecialControls); Use is a plain image generate with the
  // trained LoRA attached, so it takes the image knobs below.
  const characterTrain = intent === 'character' && characterTab === 'train'
  const characterUse = intent === 'character' && characterTab === 'use'
  if (characterTrain) return null

  // The 2.5.8 specialized ops that submit "bare" on cloud (fixed server-side)
  // but consume the sliders locally — mirrors useCloudCreate's specialOp set.
  const specialOp = intent === 'lipsync' || intent === 'music' || intent === 'extend' || intent === 'motion'
  const kind: 'image' | 'video' | 'audio' =
    characterUse ? 'image' : intent === 'music' ? 'audio' : meta.isVideo ? 'video' : 'image'

  // ── Image lanes: quality + aspect (+ edit strength) ──
  if (kind === 'image') {
    return (
      <div className={cn(LANE_ROW, 'gap-3')}>
        {/* Bis 2.6.7 stand hier `transform: scale(0.7)` — die vierte
            Skalierungsschicht der App. Sie schrumpfte nur das Bild: die Zeile
            belegte weiter ihre volle Layoutbreite, und die 1px-Kanten der
            Segmented-Pillen wurden auf 0,7px gemalt. Die 0,7 stehen jetzt in
            den Tokens, die Segmented und LabeledControl ohnehin lesen — als
            Zielgroessen, nicht als Faktor: 26px Control -> 18px, 12px
            Controltext -> 8px, 10px Label -> 7px, 8px Radius -> 6px. */}
        <div className="flex items-center gap-1.5 [--control-h-sm:18px] [--text-control:8px] [--text-label:7px] [--radius-control:6px]">
          <LabeledControl label="Quality">
            <Segmented
              size="sm"
              layoutId="quality"
              value={activeQ}
              onChange={(k) => setSteps(qSteps[k as keyof typeof qSteps])}
              options={[{ value: 'Draft', label: 'Draft' }, { value: 'Standard', label: 'Standard' }, { value: 'High', label: 'High' }]}
            />
          </LabeledControl>

          {/* Aspect only where the output size is actually user-chosen — a pure
              from-scratch image. Edit/mask ops force the output to the source
              image's dimensions (useCloudCreate overrides w/h from the source),
              so the control was dead there. */}
          {!meta.needsSource && (
            <LabeledControl label="Aspect">
              <Segmented
                size="sm"
                layoutId="aspect"
                value={aspectKey(width, height)}
                onChange={(k) => { const p = aspectPresets(imageModelType)[k as AspectKey]; setSize(p.w, p.h) }}
                options={[
                  { value: '1:1', label: '1:1', icon: Square },
                  { value: '3:4', label: '3:4' },
                  { value: '4:3', label: '4:3' },
                  { value: '16:9', label: '16:9' },
                ]}
              />
            </LabeledControl>
          )}
        </div>

        {meta.id === 'edit' && (
          <div className="w-44">
            <Slider label="Edit strength" min={0.05} max={1} step={0.05} value={denoise} onChange={setDenoise} format={(v) => v.toFixed(2)} />
          </div>
        )}
      </div>
    )
  }

  // Below here it's video/audio. The sliders only drive a render where the
  // submit path reads them — hide the whole row on the cloud specialized ops.
  const knobsLive = backend !== 'cloud' || !specialOp
  if (!knobsLive) return null

  // ── Audio (music) LOCAL: steps only — Length lives in MusicControls. ──
  if (kind === 'audio') {
    return (
      <div className={LANE_ROW}>
        <div className="w-56">
          <Slider label="Quality (steps)" min={1} max={Math.max(60, base)} step={1} value={steps} onChange={setSteps} format={(v) => `${v}`} />
        </div>
      </div>
    )
  }

  // ── Video: steps + size + frames. Anchor the Size tiers + step ceiling to
  //    the lane's ACTUAL video-model type — imageModelType doesn't track the
  //    video model (setVideoModel/setIntent set width/height but leave it), so
  //    keying off it would show image-centric sizes (1024p) on a 480p video
  //    graph. Mirror the store's per-intent typing (setIntent). ──
  const laneType = intent === 'lipsync' ? 'wans2v' : intent === 'motion' ? 'wananimate' : classifyModel(videoModel)
  const vdef = MODEL_TYPE_DEFAULTS[laneType] ?? MODEL_TYPE_DEFAULTS.unknown
  const nativeShort = Math.min(vdef.width, vdef.height) || 480
  const nativeLong = Math.max(vdef.width, vdef.height) || 832
  const scale = Math.min(width, height) / nativeShort
  const resTiers = [0.66, 1, 1.5]
  const activeRes = String(resTiers.reduce((b, m) => Math.abs(m - scale) < Math.abs(b - scale) ? m : b, 1))
  const applyRes = (mult: number) => {
    const landscape = vdef.width >= vdef.height
    const short = snap16(nativeShort * mult)
    const long = snap16(nativeLong * mult)
    setSize(landscape ? long : short, landscape ? short : long)
  }
  const stepMax = Math.max(40, Math.round((vdef.steps ?? 25) * 1.5))
  const showFrames = intent !== 'lipsync' // lipsync frames follow the voice length

  return (
    <div className={cn(LANE_ROW, 'gap-4')}>
      <div className="w-40">
        <Slider label="Quality (steps)" min={1} max={stepMax} step={1} value={steps} onChange={setSteps} format={(v) => `${v}`} />
      </div>
      <LabeledControl label="Size">
        <Segmented
          size="sm"
          layoutId="lane-res"
          value={activeRes}
          onChange={(k) => applyRes(Number(k))}
          options={resTiers.map((m) => ({ value: String(m), label: `${snap16(nativeShort * m)}p` }))}
        />
      </LabeledControl>
      {showFrames ? (
        <div className="w-44">
          <Slider label="Frames" min={9} max={121} step={4} value={frames} onChange={setFrames} format={(v) => `${v}f · ${(v / (fps || 16)).toFixed(1)}s`} />
        </div>
      ) : (
        <span className="t-label text-gray-600">clip length follows your voice</span>
      )}
    </div>
  )
}

function LabeledControl({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // gap-1 statt gap-1.5: 0,375rem × 0,7 ≈ 0,26rem, gerundet auf die
    // 4px-Stufe des 16px-Rasters. Siehe die Reglerzeile oben.
    <div className="flex items-center gap-1">
      <span className="t-label text-gray-600">{label}</span>
      {children}
    </div>
  )
}

function PromptHistory({ onPick }: { onPick: (p: string) => void }) {
  const history = useCreateStore((s) => s.promptHistory)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => setOpen(false), open)
  if (history.length === 0) return null
  return (
    <div ref={ref} className="relative">
      <Button variant="ghost" size="sm" icon={History} iconOnly title="Prompt history" onClick={() => setOpen((o) => !o)} />
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.12 }}
            className="lu-elevated absolute bottom-full mb-1.5 left-0 z-50 w-72 rounded-lg p-1 max-h-64 overflow-y-auto scrollbar-thin"
          >
            {history.map((h, i) => (
              <button key={i} onClick={() => { onPick(h); setOpen(false) }} className="w-full text-left t-control text-gray-300 px-2.5 py-1.5 rounded-md hover:bg-white/[0.06] truncate">{h}</button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── aspect helpers ──
type AspectKey = '1:1' | '3:4' | '4:3' | '16:9'
const RATIO: Record<AspectKey, number> = { '1:1': 1, '3:4': 3 / 4, '4:3': 4 / 3, '16:9': 16 / 9 }

function snap64(n: number): number { return Math.max(64, Math.round(n / 64) * 64) }
// Video dims want a multiple of 16 (the VAE/latent grid of the WAN/S2V/VACE
// families) — snap the resolution tiers to it so the graph never rejects them.
function snap16(n: number): number { return Math.max(128, Math.round(n / 16) * 16) }

function aspectPresets(modelType: string): Record<AspectKey, { w: number; h: number }> {
  const def = MODEL_TYPE_DEFAULTS[modelType as keyof typeof MODEL_TYPE_DEFAULTS] ?? MODEL_TYPE_DEFAULTS.sdxl
  const baseLong = Math.max(def.width, def.height)
  const out = {} as Record<AspectKey, { w: number; h: number }>
  for (const k of Object.keys(RATIO) as AspectKey[]) {
    const r = RATIO[k]
    out[k] = r >= 1 ? { w: baseLong, h: snap64(baseLong / r) } : { w: snap64(baseLong * r), h: baseLong }
  }
  return out
}

function aspectKey(w: number, h: number): AspectKey {
  const r = w / h
  let best: AspectKey = '1:1'; let bestD = Infinity
  for (const k of Object.keys(RATIO) as AspectKey[]) {
    const d = Math.abs(RATIO[k] - r)
    if (d < bestD) { bestD = d; best = k }
  }
  return best
}

function nearestKey(map: Record<string, number>, val: number): string {
  let best = Object.keys(map)[0]; let bestD = Infinity
  for (const [k, v] of Object.entries(map)) { const d = Math.abs(v - val); if (d < bestD) { bestD = d; best = k } }
  return best
}
