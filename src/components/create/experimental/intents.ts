import {
  Image as ImageIcon, Wand2, Scissors, Video, Film, Maximize2, Eraser,
  UserRound, Mic, Music, FastForward, PersonStanding, Box,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CreateBackend, CreateIntent, ThreeDWay } from '../../../stores/createStore'
import { THREE_D_TEXT } from '../../../lib/three/three-d-text'
import { MUSIC_PLACEHOLDER } from '../../../lib/render/music-ui'

export interface IntentMeta {
  id: CreateIntent
  label: string
  short: string
  icon: LucideIcon
  placeholder: string
  needsSource: boolean
  needsPrompt: boolean
  /** A prompt the local lanes read when one is typed and run without:
   *  the field shows there, and Create does not wait for it. */
  localPrompt?: true
  allowsMask: boolean
  isVideo: boolean
  /** Capability id (node probe) this intent depends on, if any. */
  capability?: 'rmbg' | 'inpaint-nodes' | 'dwpose'
  /** Categories with a hosted endpoint (cloud clip/teaser exists). */
  cloudOnly?: true
  /** 2.5.8: cloudOnly categories that ALSO run on the local ComfyUI backend
   *  (mirrors createStore's LOCAL_LANE_OPS and LOCAL_UTILITY_OPS). The
   *  IntentBar unlocks these in local mode; the cloud glyph becomes a
   *  "Try cloud" affordance. */
  hasLocalLane?: true
  /** Local model files this intent needs (gates the Download & install card). */
  requiresModels?: 'image' | 'video' | 'audio' | 'lipsync' | 'motion' | 'upscale'
  examples: string[]
}

export const INTENTS: IntentMeta[] = [
  {
    id: 'image', label: 'Image', short: 'Image', icon: ImageIcon,
    placeholder: 'Describe your image…',
    needsSource: false, needsPrompt: true, allowsMask: false, isVideo: false,
    requiresModels: 'image',
    examples: [
      'a lighthouse at dusk, dramatic storm clouds, cinematic',
      'a neon alley in the rain, reflections, moody',
      'a cozy reading nook by a window, warm morning light',
    ],
  },
  {
    // This IS the image-to-image tab. Source + empty mask restyles the WHOLE
    // image (VAEEncode at denoise 0.7, dynamic-workflow isI2I); painting a mask
    // switches to inpaint (VAEEncodeForInpaint / InpaintModelConditioning) on
    // the SDXL/SD1.5 checkpoint path. Cloud keeps its hosted edit endpoint; both
    // share the MaskEditor. Renamed 2.5.9: "Edit" alone hid the i2i entry for
    // the r/SD crowd who search for "image to image" (GH D#86 jendrelele /
    // A user / a user; the owner committed to making it clearer).
    id: 'edit', label: 'Edit / Image to Image', short: 'Edit', icon: Wand2,
    placeholder: 'Describe the new look. Leave the mask empty to restyle the whole image, or paint an area to change just that…',
    needsSource: true, needsPrompt: true, allowsMask: true, isVideo: false,
    capability: 'inpaint-nodes', requiresModels: 'image',
    examples: ['turn this photo into a watercolor painting', 'make it a snowy winter scene', 'repaint it in a neon cyberpunk style'],
  },
  {
    id: 'removebg', label: 'Remove Background', short: 'Cutout', icon: Scissors,
    placeholder: '',
    needsSource: true, needsPrompt: false, allowsMask: false, isVideo: false,
    capability: 'rmbg',
    examples: [],
  },
  {
    // R5-67: label/short renamed to match the web app
    // ("Enhance Image" / "Enhance"). The id stays
    // 'upscale' on purpose, a saved gallery result or a stored createStore
    // state references intents by id, and renaming that too would strand
    // them. Web's separate 'video_upscale' intent is a feature decision for
    // The owner (does the Desktop get video upscaling at all), not a text fix,
    // and is out of scope here.
    //
    // 3.0.7 (Discord wish D10): a local lane on Windows and Linux, ComfyUI's
    // core upscale nodes over a file in models/upscale_models
    // (lib/local-upscale.ts). The Stage offers that file when none is there.
    // A Mac has no ComfyUI and keeps this a cloud tool.
    id: 'upscale', label: 'Enhance Image', short: 'Enhance', icon: Maximize2,
    placeholder: '',
    needsSource: true, needsPrompt: false, allowsMask: false, isVideo: false,
    cloudOnly: true, hasLocalLane: true, requiresModels: 'upscale',
    examples: [],
  },
  {
    id: 'eraser', label: 'Erase Object', short: 'Erase', icon: Eraser,
    placeholder: '',
    needsSource: true, needsPrompt: false, allowsMask: true, isVideo: false,
    cloudOnly: true,
    examples: [],
  },
  {
    id: 'video', label: 'Video', short: 'Video', icon: Video,
    placeholder: 'Describe the motion and the scene…',
    needsSource: false, needsPrompt: true, allowsMask: false, isVideo: true,
    requiresModels: 'video',
    examples: ['a wave breaking on rocks in slow motion, cinematic', 'timelapse of clouds over a mountain range'],
  },
  {
    // Local lane restored 2026-07-17: the lu-labs port had marked
    // animate cloudOnly, which silently dropped the local I2V the old Create
    // tab always had. Local builds route through buildDynamicWorkflow's
    // family-specific I2V wiring (WAN/WAN2.2/Hunyuan/LTX/Cosmos/SVD/FramePack);
    // the model picker only offers i2v-capable models here.
    id: 'animate', label: 'Animate Image', short: 'Animate', icon: Film,
    placeholder: 'Describe how the image should move…',
    needsSource: true, needsPrompt: true, allowsMask: false, isVideo: true,
    requiresModels: 'video',
    examples: ['slow zoom in, subtle parallax', 'hair and clothes moving in the wind'],
  },

  // ── 2.5.8 specialized categories (2026-07-17). All have hosted
  // endpoints (cloudOnly = cloud clip/teaser exists); music, lipsync, extend
  // and motion ALSO run locally (hasLocalLane) on core ComfyUI node families
  // (ACE audio, Wan S2V, I2V last-frame chain, Wan VACE/Animate). Their
  // composer surfaces own the extra inputs (training set, audio, driving
  // video, extend pick), so needsSource / needsPrompt describe only the
  // shared composer scaffolding. ──
  {
    // 2.6.0 ships the local trainer runtime (trainer.rs installs the pinned
    // musubi-tuner venv, the Z-Image bases ride the regular download
    // pipeline), so the local lane is real now. Without hasLocalLane the bar
    // rendered the finished feature as a locked cloud teaser and a local
    // user could never reach LocalTrainControls at all (found 2026-08-01 on
    // the real Windows bundle). No requiresModels here: the lane runs its
    // own three gates (trainer env, base files, photos).
    id: 'character', label: 'Character Studio', short: 'Character', icon: UserRound,
    placeholder: 'Describe the scene for your character…',
    needsSource: false, needsPrompt: false, allowsMask: false, isVideo: false,
    cloudOnly: true, hasLocalLane: true,
    examples: [],
  },
  {
    // Inputs (portrait or base clip + speech audio) are composer chips, not
    // the Stage source slot — which input the model needs depends on the
    // picked endpoint (photo-avatar vs re-sync).
    id: 'lipsync', label: 'Talking Character', short: 'Lipsync', icon: Mic,
    placeholder: '',
    needsSource: false, needsPrompt: false, allowsMask: false, isVideo: true,
    cloudOnly: true, hasLocalLane: true, requiresModels: 'lipsync',
    examples: [],
  },
  {
    id: 'music', label: 'Music', short: 'Music', icon: Music,
    placeholder: MUSIC_PLACEHOLDER.style,
    needsSource: false, needsPrompt: true, allowsMask: false, isVideo: false,
    cloudOnly: true, hasLocalLane: true, requiresModels: 'audio',
    examples: [
      'dreamy lofi hip hop, vinyl crackle, mellow keys',
      'epic orchestral trailer, driving percussion',
      'upbeat synthwave, retro 80s arps',
    ],
  },
  {
    // Local lane: the picked clip's LAST FRAME becomes the I2V start image,
    // so it gates on the regular video models like animate does.
    id: 'extend', label: 'Extend Video', short: 'Extend', icon: FastForward,
    placeholder: 'Describe how the clip should continue…',
    needsSource: false, needsPrompt: true, allowsMask: false, isVideo: true,
    cloudOnly: true, hasLocalLane: true, requiresModels: 'video',
    examples: [],
  },
  {
    // Local lane on Wan VACE/Animate + DWPose (comfyui_controlnet_aux).
    // DWPose imports fine on Windows (falls back to OpenCV on CPU when
    // onnxruntime-gpu is absent — slower, not broken); the pack only shows
    // up after a ComfyUI restart, which installCapability performs.
    id: 'motion', label: 'Motion Control', short: 'Motion', icon: PersonStanding,
    // The local lanes read a prompt and run without one: the ComfyUI graph
    // falls back to its own scene line (dynamic-workflow buildMotionWorkflow),
    // the Mac to MLX_MOTION_PROMPT. The cloud model takes none.
    placeholder: 'Optional: describe the scene or the style…',
    needsSource: false, needsPrompt: false, localPrompt: true, allowsMask: false, isVideo: true,
    capability: 'dwpose',
    cloudOnly: true, hasLocalLane: true, requiresModels: 'motion',
    examples: [],
  },
  {
    // 3.1.0 (C3D-PLAN): a 3D model from words, a picture or a video. The
    // thirteenth pill, at the far right, so no tool moves. Which inputs it
    // takes depends on the way (intentNeedsSource / intentTakesPrompt), so
    // the two flags here stay false. Local: TripoSR on a Mac (its own
    // engine, commands/mesh3d.rs), TRELLIS.2 in ComfyUI on Windows and Linux.
    // The Stage gates the local tab on its own setup card, not on
    // requiresModels.
    id: '3d', label: '3D Model', short: '3D', icon: Box,
    placeholder: THREE_D_TEXT.prompt,
    needsSource: false, needsPrompt: false, allowsMask: false, isVideo: false,
    cloudOnly: true, hasLocalLane: true,
    examples: THREE_D_TEXT.examples,
  },
]

export const INTENT_MAP: Record<CreateIntent, IntentMeta> =
  Object.fromEntries(INTENTS.map((i) => [i.id, i])) as Record<CreateIntent, IntentMeta>

/** Does the view on screen show a prompt field? Composer draws the field under
 *  this rule and both starts (cloud and local) send a prompt under the same
 *  one: a view without the field must never send the text left over from
 *  another tab. Character Studio's use surface is a plain image generate and
 *  has one. */
export function intentTakesPrompt(intent: CreateIntent, characterUse = false, threeDWay: ThreeDWay = 'image'): boolean {
  if (intent === '3d') return threeDWay === 'text'
  return INTENT_MAP[intent].needsPrompt || characterUse
}

/** Does the view need a picture on the Stage before it can start? 3D needs
 *  one from a picture and from a video (the first still frame stands there). */
export function intentNeedsSource(intent: CreateIntent, threeDWay: ThreeDWay = 'image'): boolean {
  if (intent === '3d') return threeDWay !== 'text'
  return INTENT_MAP[intent].needsSource
}

/** Does the view on `backend` show a prompt field that may stay empty?
 *  Motion Control on the local lanes. The start sends what is typed there,
 *  and Create does not wait for it. */
export function intentTakesOptionalPrompt(intent: CreateIntent, backend: CreateBackend): boolean {
  return backend === 'local' && !!INTENT_MAP[intent].localPrompt
}

/**
 * The intents that have a REAL local pipeline on an MLX host (Apple Silicon
 * Mac). Every local lane above is a ComfyUI graph, and the Mac has no ComfyUI
 * at all — its local media is the in-process MLX path (api/mlx-image.ts,
 * api/mlx-video.ts). MLX generate accepts prompt / steps / seed / size /
 * negative and nothing else, and there is no ComfyUI /upload/image to stage a
 * source through, so plain text-to-image and text-to-video always run.
 *
 * Animate Image is the one lane with a source that MLX serves too: some video
 * models start from an image (the catalogue in commands/video.rs says which),
 * and the image is staged on disk instead of in ComfyUI (loadImageRef). It is
 * a local tab only while such a model is installed, which is what the
 * `mlxAnimate` argument below carries (api/mlx-video mlxTakesStartImage).
 *
 * Extend Video rides on the same models (14.10.2026): as on Windows, the last
 * frame of the picked clip becomes the start image of an image to video run
 * (LocalExtendControls, lib/video-frames lastFrame). So it is a local tab
 * exactly while Animate is one. The engine's own `extend` mode, which carries
 * the clip on in latent space, is a beta of ltx-2-mlx and needs the dev
 * transformer the distilled packs leave out; it is not used.
 *
 * Remove Background runs on every Mac: the subject mask comes from the Vision
 * framework of macOS (commands/mlx_cutout.rs), with no model to install and
 * no ComfyUI node, so the tab needs neither.
 *
 * Everything else must NOT look like a working local tab — see visibleIntents
 * / isIntentLocked below.
 */
// Remove Background runs on Vision in macOS (commands/mlx_cutout.rs).
// Character Studio: "Use character" runs a character's LoRA from the Mac's
// LoRA folder on the second image engine (mflux `--lora`), the way Windows
// runs it in ComfyUI. Training stays off on the Mac (LocalTrainControls is a
// ComfyUI/CUDA trainer); the tab says where to train instead.
// 3D (3.1.0) is a local tab on every Mac: without the engine the Stage shows
// its one-time setup card (commands/mesh3d.rs, TripoSR).
const MLX_LOCAL_INTENTS: ReadonlySet<CreateIntent> = new Set<CreateIntent>(['image', 'video', 'removebg', 'character', '3d'])

/**
 * Edit is the second lane with a source that the Mac serves: Qwen-Image 2.1
 * on the second image engine edits one image or several from a prompt, as it
 * does on Windows (commands/image_mflux.rs). It is a local tab only while such
 * a model is installed, which is what `mlxEdit` carries (lib/image-engines
 * mlxTakesEditImage). A mask painted over the first image limits the edit to
 * that area (mflux 0.22.0 `--mask-image`); without one the prompt edits the
 * whole image.
 *
 * Enhance Image is a local tab on the Mac while an upscaler is installed:
 * SeedVR2 on the second engine makes the picture on the Stage two or four
 * times larger (commands/mlx.rs mlx_upscale). That is what `mlxUpscale`
 * carries (api/mlx-image mlxUpscalerInstalled). Without one it stays locked,
 * as it is everywhere else in local mode.
 *
 * Music too: ACE-Step 1.5 runs as a process of its own on the Mac
 * (commands/music.rs), and the Music tab is a local tab while its engine and
 * model are installed, which is what `mlxMusic` carries (api/mlx-music
 * mlxMakesMusic). Without it the tab stays locked, as before.
 *
 * Motion Control (3.0.8): an LTX-2.3 pack of the second video engine with
 * the IC-LoRA Union Control follows the motion of a video from a start image
 * (commands/video_motion.rs). The tab is local while such a pack is
 * installed, which is what `mlxMotion` carries (api/mlx-video
 * mlxFollowsMotion). The LoRA itself comes with the tab's install card.
 *
 * Talking Character too (3.0.8): LTX-2.3 4-bit turns a portrait and a voice
 * into a clip whose lips follow the speech (the engine's `a2v`,
 * commands/video_ltx2mlx.rs). The tab is a local tab while such a model is
 * installed, which is what `mlxTalk` carries (api/mlx-video mlxTalking); the
 * extra download the run reads is offered on the tab itself.
 */
function runsOnMlx(id: CreateIntent, mlxAnimate: boolean, mlxEdit: boolean, mlxUpscale: boolean, mlxMusic: boolean, mlxMotion: boolean, mlxTalk: boolean): boolean {
  return MLX_LOCAL_INTENTS.has(id) || ((id === 'animate' || id === 'extend') && mlxAnimate) || (id === 'edit' && mlxEdit)
    || (id === 'upscale' && mlxUpscale) || (id === 'music' && mlxMusic) || (id === 'motion' && mlxMotion) || (id === 'lipsync' && mlxTalk)
}

/**
 * The intents to surface for a given backend + host. Pure so the rule is unit
 * tested instead of buried in the IntentBar's JSX.
 *
 * Cloud shows everything. Local (ComfyUI, Windows/Linux) also shows
 * everything — the hosted-only tools render as locked cloud teasers rather
 * than disappearing. Local on an MLX Mac hides the intents that have neither a
 * local MLX path nor a hosted teaser sheet (edit while no installed model
 * takes an image, and animate while none starts from one): they need a ComfyUI node or a
 * model that is not there, so leaving them selectable is a dead affordance
 * that either errors on submit or, worse and the MLX case, silently drops the
 * source and returns an unrelated fresh image.
 *
 * `cloudFeatures` is the setting "Show Cloud features in Local mode". Off, the
 * local bar carries no cloud teaser at all: a tool that cannot run on this
 * machine is left out, the same way the Mac leaves out what MLX cannot do.
 * Until 3.0.5 the switch only took the LU Cloud rows out of the model
 * pickers, and Enhance and Erase kept their cloud tag and kept opening the
 * Cloud sheet (the box, 04.10.2026).
 */
export function visibleIntents(backend: CreateBackend, mlxHost: boolean, cloudFeatures: boolean, mlxAnimate = false, mlxEdit = false, mlxUpscale = false, mlxMusic = false, mlxMotion = false, mlxTalk = false): IntentMeta[] {
  if (backend === 'cloud') return INTENTS
  const shown = mlxHost ? INTENTS.filter((m) => runsOnMlx(m.id, mlxAnimate, mlxEdit, mlxUpscale, mlxMusic, mlxMotion, mlxTalk) || m.cloudOnly === true) : INTENTS
  return cloudFeatures ? shown : shown.filter((m) => !isIntentLocked(m, backend, mlxHost, mlxAnimate, mlxEdit, mlxUpscale, mlxMusic, mlxMotion, mlxTalk))
}

/**
 * Whether an intent renders as a locked cloud teaser instead of a selectable
 * local tab. Cloud never locks. On local ComfyUI hosts only the genuinely
 * hosted-only tools lock (the 2.5.8 lanes with hasLocalLane are real local
 * tabs). On an MLX Mac every non-MLX intent that survives visibleIntents locks
 * — those lanes' "local" implementation is a ComfyUI graph this host does not
 * have, so the honest state is the cloud teaser, not a working-looking pill.
 */
export function isIntentLocked(meta: IntentMeta, backend: CreateBackend, mlxHost: boolean, mlxAnimate = false, mlxEdit = false, mlxUpscale = false, mlxMusic = false, mlxMotion = false, mlxTalk = false): boolean {
  if (backend === 'cloud') return false
  if (mlxHost) return !runsOnMlx(meta.id, mlxAnimate, mlxEdit, mlxUpscale, mlxMusic, mlxMotion, mlxTalk)
  return meta.cloudOnly === true && !meta.hasLocalLane
}

/**
 * Whether an intent is reachable as a working tab (shown AND not a locked
 * teaser) for this backend + host. Same rule as the IntentBar, exposed for the
 * result actions that FORCE-switch to an intent — "Edit with mask" on a
 * finished image used to set 'edit' even where that lane cannot run.
 */
export function isIntentAvailable(id: CreateIntent, backend: CreateBackend, mlxHost: boolean, mlxAnimate = false, mlxEdit = false, mlxUpscale = false, mlxMusic = false, mlxMotion = false, mlxTalk = false): boolean {
  const meta = INTENT_MAP[id]
  return visibleIntents(backend, mlxHost, true, mlxAnimate, mlxEdit, mlxUpscale, mlxMusic, mlxMotion, mlxTalk).includes(meta)
    && !isIntentLocked(meta, backend, mlxHost, mlxAnimate, mlxEdit, mlxUpscale, mlxMusic, mlxMotion, mlxTalk)
}
