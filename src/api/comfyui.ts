import { comfyuiUrl, localFetch, fetchLocalhostBytes, isTauri, backendCall, isMacOS } from "./backend"
import { log } from "../lib/logger"
import { LU_CLIENT_PREFIX } from "./comfyui-ws"
import { nodeComboOptions } from "./comfyui-enum"
import { resolveRunSeed } from '../lib/run-seed'
import { blobFromUrl } from '../lib/render/data-url'
// Audit W-T2: videoDecodeNode/promptFilenamePrefix kamen hier bis eben per
// `await import('./dynamic-workflow')` mitten in den Buildern herein — ein
// dynamischer Import, der nur den Zyklus comfyui ↔ dynamic-workflow
// verdeckt hat. Beide sind reine Graph-Bausteine und wohnen jetzt in
// comfyui-graph.ts, das nichts importiert.
import { videoDecodeNode, promptFilenamePrefix, tagOutputPrefixes, newRunTag, addVideoSave } from './comfyui-graph'
import type { ComfyApiGraph, ComfyApiNode, ComfyHistoryEntry } from '../types/comfy-graph'
import type { ComfyModelSource } from '../types/models'
import { isRecord, asString, asRecordArray } from '../types/json-guards'
// Audit W-T2: der Katalog kam bis eben per `await import('./discover')` in
// getKnownFileSizes() herein, „to break the cycle at runtime". Die
// Bundle-Daten gehören weder hierher noch nach discover.ts — sie liegen
// jetzt in model-bundles.ts, das beide Seiten statisch lesen.
import { getImageBundles, getVideoBundles } from './model-bundles'
import { isQwenEnhancerFile } from '../lib/render/qwen-enhancer'
import { pickQwenEncoder, qwenEncoderFile, type QwenEncoderChoice } from '../lib/render/qwen-text-encoder'
import { COMPONENT_REGISTRY, type ComponentSpec } from './component-registry'

// ─── Control-plane fetch timeouts ───
//
// These ComfyUI endpoints enqueue / list / poll / free and MUST answer in well
// under a few seconds on localhost: ComfyUI serves them on its asyncio event
// loop while the actual generation runs on a SEPARATE worker thread, so HTTP
// stays responsive even mid-render. A generation's real compute time is observed
// by repeatedly polling /history (each poll quick), NOT by any single long-lived
// fetch. Without an explicit cap every call below inherits the Rust proxy's
// 300 s default — and ONE wedged control call (e.g. /object_info right after a
// ComfyUI restart, or a /prompt POST that never returns) froze the whole image-
// MCP VRAM hand-off for minutes with the text model left unloaded (chat-agent
// hang, 2026-06-03). Bounding each call converts that infinite stall into a fast,
// clean error so the hand-off's `finally` can always free VRAM + reload the model.
const COMFY_LIST_TIMEOUT_MS = 15_000    // /object_info/<Node> single-node listings
const COMFY_SUBMIT_TIMEOUT_MS = 30_000  // POST /prompt — validates + enqueues, returns prompt_id only
const COMFY_POLL_TIMEOUT_MS = 15_000    // GET /history/<id> per status poll
const COMFY_STATS_TIMEOUT_MS = 10_000   // /system_stats, /api/refresh, /interrupt
const COMFY_FREE_TIMEOUT_MS = 20_000    // POST /free — VRAM release

// ─── Types ───

export interface GenerateParams {
  prompt: string
  negativePrompt: string
  model: string
  sampler: string
  scheduler: string
  steps: number
  cfgScale: number
  width: number
  height: number
  seed: number
  batchSize: number
  inputImage?: string   // I2I source image filename (uploaded to ComfyUI)
  /** Edit: further reference images (ComfyUI upload names) after the source,
   *  for the families lib/edit-references names. GH #144. */
  referenceImages?: string[]
  /** What the model file carries besides the diffusion model (header sniff).
   *  Lets an all-in-one file in models/checkpoints use its own encoder/VAE. */
  modelParts?: { textEncoder: boolean; vae: boolean }
  denoise?: number      // I2I denoise strength (0.0–1.0, default 1.0 = full txt2img)
  removebg?: boolean    // Background removal: LoadImage → RMBG → SaveImage cutout (no diffusion)
  /** Qwen-Image 2.1 text-to-image only: ask for an RGBA picture with a
   *  transparent background (lib/transparent-image.ts). Ignored elsewhere. */
  transparent?: boolean
  /** Qwen-Image 2.1 only: which installed text encoder reads the prompt, the
   *  official one or the edition without refusals
   *  (lib/render/qwen-text-encoder.ts). Ignored elsewhere. */
  qwenTextEncoder?: QwenEncoderChoice
  // Local Edit (mask inpaint): ComfyUI /upload/image filename of the painted
  // mask (white = repaint). With inputImage set this selects the inpaint
  // pipeline (VAEEncodeForInpaint / InpaintModelConditioning) on the
  // SDXL/SD1.5 checkpoint path — same contract as the web app's builder.
  maskImage?: string
  growMaskBy?: number   // Mask edge feather in pixels (VAEEncodeForInpaint grow_mask_by, default 6)
  // F2 (GH#4), extended for multi-LoRA (a user 2026-06-09:
  // "agent cannot load multiple loras"): one filename or an ordered list.
  // Multiple LoRAs are CHAINED — LoraLoader N feeds (model, clip) into
  // LoraLoader N+1, exactly like stacking them in the ComfyUI graph editor.
  // `loraStrength` mirrors LoraLoader's `strength_model` (0..2 typical):
  // a single number applies to every LoRA, an array maps per-LoRA by index.
  lora?: string | string[]
  loraStrength?: number | number[]
  // F3 (GH#4): override the checkpoint's bundled VAE with an
  // explicit VAELoader. 'auto' / undefined / empty = keep the
  // checkpoint VAE.
  vae?: string
  // F3: optional CLIPSetLastLayer injection. 0 = no skip (the
  // checkpoint default). Common values: 1 for SD1.5/SDXL,
  // 2 for some abliterated finetunes.
  clipSkip?: number
}

export interface VideoParams extends GenerateParams {
  frames: number
  fps: number
  inputImage?: string  // Uploaded image filename for I2V models (SVD, FramePack)
  // SVD motion strength (motion_bucket_id, 1–255). Lower = more faithful to the
  // source still / calmer motion; 127 (SVD default) drifts hard. We default ~90
  // for I2V fidelity (2026-06-11). Honoured only by the SVD path.
  motionBucketId?: number
  /** A later section of a long clip (B18): the clip so far in ComfyUI's input
   *  folder and how many of its last frames this section repeats. The graph
   *  starts on those frames and outputs the whole clip (api/video-continue). */
  continueFrom?: { video: string; overlap: number }
  /** One pass with sliding context windows instead of sections (B18). */
  contextWindows?: boolean
}

export interface ComfyUIOutput {
  filename: string
  subfolder: string
  type: string
}

/**
 * Bug R (v2.4.7 — GH Discussion #6, 2026-05-20).
 *
 * Pre-v2.4.7 LU only scraped `images` / `gifs` / `videos` from a ComfyUI
 * history `outputs[nodeId]` payload. That worked for the canonical SaveImage
 * / SaveAnimatedWEBP / VHS_VideoCombine nodes, but plenty of custom save
 * nodes (community workflows from CivitAI, SaveImageWithMetadata,
 * SaveImageHTML, audio save nodes, etc.) post under different keys —
 * `audio`, `result`, `files`, `latents`, `meshes`, model-specific keys.
 * The file lands in ComfyUI's `output/` folder but never makes it into LU's
 * gallery, exactly the symptom a user reported.
 *
 * Generic extractor: scan every key on the node output, collect any array
 * whose entries look like `{ filename, subfolder?, type? }`. Defaults fill
 * in subfolder='' and type='output' so the gallery + comfyImageUrl can build
 * a working URL even when a custom save node omits them.
 */
export function extractComfyOutputFiles(nodeOutput: unknown): ComfyUIOutput[] {
  if (!nodeOutput || typeof nodeOutput !== 'object') return []
  const found: ComfyUIOutput[] = []
  for (const value of Object.values(nodeOutput as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    for (const item of value) {
      if (
        item &&
        typeof item === 'object' &&
        'filename' in item &&
        typeof (item as { filename: unknown }).filename === 'string'
      ) {
        const it = item as { filename: string; subfolder?: unknown; type?: unknown }
        // A file of ComfyUI's INPUT folder is never a result. Core LoadVideo
        // reports a preview of the video it loaded under that type (B18 box
        // run, 27.10.2026: every continued section of a long clip listed the
        // clip so far next to its own output, and the chain took the input
        // for the new section). Motion Control's driving video is the same.
        if (it.type === 'input') continue
        found.push({
          filename: it.filename,
          subfolder: typeof it.subfolder === 'string' ? it.subfolder : '',
          type: typeof it.type === 'string' ? it.type : 'output',
        })
      }
    }
  }
  return found
}

/** Gallery media type for a finished output file. The render mode alone
 *  mistagged audio outputs (SaveAudio & friends post .flac/.mp3/.wav) as
 *  image/video, so their tiles rendered as broken <img>/<video>. Only the
 *  audio axis is decided by extension — everything else keeps the mode, so
 *  the long-standing image/video tagging (incl. the animated-webp fallback)
 *  is untouched. */
const AUDIO_OUTPUT_EXTS = new Set(['mp3', 'wav', 'flac', 'ogg', 'opus', 'm4a'])
export function galleryTypeForFile(
  filename: string,
  mode: 'image' | 'video',
): 'image' | 'video' | 'audio' {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  return AUDIO_OUTPUT_EXTS.has(ext) ? 'audio' : mode
}

// 2.5.8: ace / wans2v / wananimate / wanvace are the specialized local-lane
// architectures (music, talking character, motion control). They are neither
// image nor video picker material — each lane has its own model list.
export type ModelType = 'flux' | 'flux2' | 'krea2' | 'zimage' | 'ernie_image' | 'qwenimage' | 'qwenimage1' | 'chroma' | 'hidream' | 'sd3' | 'lumina2' | 'sdxl' | 'sd15' | 'wan' | 'wan22' | 'hunyuan' | 'ltx' | 'ltx25' | 'mochi' | 'cosmos' | 'cogvideo' | 'svd' | 'framepack' | 'pyramidflow' | 'allegro' | 'ace' | 'yue2' | 'wans2v' | 'wananimate' | 'wanvace' | 'animatediff' | 'minimaxh3' | 'unknown'
export type VideoBackend = 'wan' | 'animatediff' | 'none'

export interface ClassifiedModel {
  name: string
  type: ModelType
  /** Which ComfyUI enum listed this file. `motion_module` is the AnimateDiff
   *  one, and it lives outside ComfyUI\models entirely (see getMotionModels).
   *  The rest are the addon folders: files that are not a model on their own,
   *  take up real disk, and used to appear in no list and no counter at all
   *  (counter-check 2026-08-29, and five more folders in the R5 re-measure
   *  the day after). */
  source: ComfyModelSource
  /** What the file carries besides the diffusion model, read from its header
   *  (commands/model_sniff.rs). Absent when the header was not readable. */
  parts?: { textEncoder: boolean; vae: boolean }
  /** Whether a video model starts from an image, where a catalogue says so
   *  (the Mac's MLX catalogue, api/mlx-video.ts). Absent on a ComfyUI file,
   *  whose name is all there is to go by (isI2VModel, isT2VCapable). */
  startImage?: 'none' | 'optional' | 'required'
  /** How many images an edit with this model takes in all, where a catalogue
   *  says so (the Mac's MLX catalogue, api/mlx-image.ts). 0: it makes images
   *  from text alone. Absent on a ComfyUI file, where the family decides
   *  (lib/edit-references). */
  editImages?: number
  /** The size of the model's weights in GB, where the Mac's MLX catalogue
   *  says so. An edit on the Mac counts it into the memory the run takes
   *  (lib/mac-edit-memory). Absent on a ComfyUI file. */
  packGb?: number
  /** The model runs at its own steps and guidance, and Create's sliders do not
   *  reach it (a pack of the Mac's second image engine that is tuned to one
   *  count, lib/image-engines). Absent everywhere else. */
  ownSampling?: boolean
  /** A run with this model takes the LoRA stack from the Mac's LoRA folder
   *  (a pack of the Mac's second image engine, lib/image-engines). Absent
   *  everywhere else: on a ComfyUI host the stack is ComfyUI's. */
  mlxLoras?: boolean
  /** What a clip of this model is, where the Mac's video catalogue says so
   *  (api/mlx-video.ts): how many frames it has by default, the rate it plays
   *  at, the grid its frame count sits on, the size it is made at and whether
   *  the model reads a negative prompt. The Mac's video engines take a length
   *  and, where the entry says so, a negative prompt, another size on
   *  `sizeGrid` up to `maxPixels`, and a step count from 1 to `maxSteps`
   *  around `steps`, so this is all Create has to set for them. Absent on a
   *  ComfyUI file, where the family's defaults stand. */
  mlxVideo?: {
    frames: number; fps: number; frameStep: number; width: number; height: number; negativePrompt: boolean
    loras?: boolean; recommendedRamGB?: number; measuredRunSecondsPerClipSecond?: number
    sizeGrid?: number; maxPixels?: number; minSide?: number; maxSide?: number
    steps?: number; maxSteps?: number
    /** The shot list reaches the model (LTX-2.5, lib/ltx-multishot). */
    multishot?: boolean
    /** A run can follow a motion video (Motion Control on the Mac). */
    motion?: boolean
    /** Talking Character on a Mac (api/mlx-video `mlxTalking`): the model
     *  runs it once its own download is on disk ('ready'), and not before
     *  ('missing'). Absent for a model that does not talk. */
    talking?: 'ready' | 'missing'
    /** The size of that download, in decimal GB. */
    talkingGB?: number
  }
}

/** The ComfyUI\models folders that hold files a user installs, none of which
 *  is a main model. One name per folder, and INSTALLED_ADDON_LANES below is
 *  the single place that says which loader enumerates it.
 *
 *  Carved out of `ComfyModelSource` (types/models.ts) rather than spelled out
 *  a second time: the inventory rows carry that field into the views, and two
 *  hand-written copies of one folder list is exactly the drift
 *  COMFY_MODEL_FOLDERS below exists to stop. */
export type AddonSource =
  Exclude<ComfyModelSource, 'checkpoint' | 'diffusion_model' | 'motion_module'>

/** Where a listed file actually sits, by the enum that listed it. The disk
 *  probe needs the folder, and the delete command resolves the same set.
 *
 *  The motion-module folder comes from ANIMATEDIFF_SUBFOLDER below rather than
 *  being spelled out a second time: it used to live in discover.ts, which
 *  imports back into this module, and the duplicate was held together by a unit
 *  test instead of by there being only one of it. */
export function subfolderForSource(source: ClassifiedModel['source']): string {
  switch (source) {
    case 'checkpoint': return 'checkpoints'
    case 'diffusion_model': return 'diffusion_models'
    case 'motion_module': return ANIMATEDIFF_SUBFOLDER
    case 'lora': return 'loras'
    case 'vae': return 'vae'
    case 'text_encoder': return 'text_encoders'
    case 'clip_vision': return 'clip_vision'
    case 'controlnet': return 'controlnet'
    case 'upscale_model': return 'upscale_models'
    case 'embedding': return 'embeddings'
    case 'style_model': return 'style_models'
  }
}

// ─── Model Classification ───

// Known community models → pre-classified for reliability
const KNOWN_MODELS: Record<string, ModelType> = {
  juggernaut: 'sdxl',
  realvis: 'sdxl',
  animagine: 'sdxl',
  pony: 'sdxl',
  illustrious: 'sdxl',
  noobai: 'sdxl',
  proteus: 'sdxl',
  copax: 'sdxl',
  zavychroma: 'sdxl',
  epicrealism: 'sdxl',
  realisticvision: 'sd15',
  deliberate: 'sd15',
  revanimated: 'sd15',
  dreamshaper: 'sd15', // dreamshaper XL handled by 'xl' check first
  absolutereality: 'sd15',
}

/** FastVideo's distilled MiniMax H3 (fastvideo_fasth3_8step_v2_*). A full
 *  checkpoint, not a LoRA, and it only does text to video: the model card says
 *  the first/last frame and reference tasks were not distilled. */
export function isFastH3(name: string): boolean {
  return name.toLowerCase().includes('fasth3')
}

/** Wan 2.2 A14B: the i2v/t2v pair in its high noise and low noise halves,
 *  any quant (Comfy-Org fp8/fp16, QuantStack GGUF, Kijai). Wan 2.1
 *  architecture under a 2.2 tag: WanImageToVideo and the 16-channel
 *  wan_2.1_vae. Only the TI2V-5B uses the 48-channel wan2.2_vae (GH #193). A
 *  2.2 name that says neither 14B nor high/low noise nor i2v/t2v stays on the
 *  5B path it always took. */
export function isWan22A14B(name: string): boolean {
  const lower = name.toLowerCase()
  if (!/wan[._-]?2[._-]?2/.test(lower)) return false
  if (lower.includes('ti2v') || /(^|[^0-9])5b/.test(lower)) return false
  return /(^|[^0-9])a?14b/.test(lower)
    || /(high|low)[._-]?noise/.test(lower)
    || /(^|[^a-z])[it]2v([^a-z]|$)/.test(lower)
}

/** The low noise half that finishes what this high noise A14B file starts,
 *  from the names the loader lists, or null. Same name with the one "high"
 *  turned into "low": high_noise → low_noise (Comfy-Org), HighNoise →
 *  LowNoise (QuantStack GGUF), HIGH → LOW (Kijai). */
export function wan22LowNoisePartner(name: string, listed: string[]): string | null {
  if (!isWan22A14B(name)) return null
  const lower = name.toLowerCase()
  const at = lower.search(/high(?=[._-]?noise|[._-])/)
  if (at < 0) return null
  const want = lower.slice(0, at) + 'low' + lower.slice(at + 4)
  return listed.find((n) => n.toLowerCase() === want) ?? null
}

export function classifyModel(name: string | null | undefined): ModelType {
  // Defensive: treat empty/missing names as unknown. Older installs can persist
  // stale model strings that no longer exist; callers should not crash on those.
  if (!name || typeof name !== 'string') return 'unknown'
  const lower = name.toLowerCase()

  // 2.5.8 specialized lanes — must beat the generic wan/ace substrings below.
  // 'vace' before 'ace' (contains it), s2v/animate before the wan2.2 match
  // (wan2.2_s2v / wan2.2_animate carry the wan2.2 tag too).
  if (lower.includes('vace')) return 'wanvace'
  if (lower.includes('s2v')) return 'wans2v'
  if (lower.includes('animate') && lower.includes('wan') && !lower.includes('animatediff')) return 'wananimate'
  // A motion module is neither an image nor a standalone video model: it is the
  // second half of the AnimateDiff lane, which also needs an SD checkpoint. Its
  // own type keeps it out of isImageModelType (which lets 'unknown' through and
  // would otherwise offer a motion module in the image picker).
  if (lower.includes('animatediff')) return 'animatediff'
  if (lower.includes('ace_step') || lower.includes('ace-step') || lower.includes('acestep')) return 'ace'
  // YuE2 (Comfy-Org/YuE2, ComfyUI 0.36.0): an all in one music checkpoint
  // that lives in models/checkpoints next to ACE Step, so it needs its own
  // type or it would land in the image picker as 'unknown'.
  if (/(^|[^a-z0-9])yue[._-]?2/.test(lower)) return 'yue2'
  // Merged 14B "rapid AIO" builds (e.g. wan2.2-i2v-rapid-aio) are Wan 14B
  // architecture: classic WanImageToVideo graph + wan_2.1_vae — NOT the
  // TI2V-5B path the wan2.2 tag would otherwise route them onto.
  if (lower.includes('rapid') && lower.includes('aio')) return 'wan'
  // The Wan 2.2 A14B pair is the same architecture (GH #193, see isWan22A14B).
  if (isWan22A14B(lower)) return 'wan'

  // MiniMax H3 (Comfy-Org/MiniMax-H3): video with its own sound track, from
  // text, a first/last frame (fl2va) or references (ref2va). Before every
  // generic tag: its CivitAI repacks carry anything in their names.
  // FastH3 (FastVideo's 8 step distillation of H3) is the same architecture
  // under a file name that never says "minimax": fastvideo_fasth3_8step_v2_*.
  if (lower.includes('minimax_h3') || lower.includes('minimaxh3') || lower.includes('minimax-h3') || isFastH3(lower)) return 'minimaxh3'

  // Video models — most specific first (order matters: specific before generic)
  if (lower.includes('cogvideo')) return 'cogvideo'
  if (lower.includes('framepack')) return 'framepack'
  if (lower.includes('mochi')) return 'mochi'
  if (lower.includes('cosmos')) return 'cosmos'
  if (lower.includes('allegro')) return 'allegro'
  if (lower.includes('svd') || lower.includes('stable-video-diffusion')) return 'svd'
  if (lower.includes('pyramid') && (lower.includes('flow') || lower.includes('dit'))) return 'pyramidflow'
  // Wan 2.2 TI2V-5B — unified text+image-to-video. Detect BEFORE the generic Wan
  // match: it needs its own latent node (Wan22ImageToVideoLatent), the Wan 2.2 VAE
  // and the dual T2V/I2V path, none of which the Wan 2.1 'unet_video' strategy has.
  if (lower.includes('ti2v') || lower.includes('wan2.2') || lower.includes('wan2_2') || lower.includes('wan22')) return 'wan22'
  if (lower.includes('wan')) return 'wan'
  if (lower.includes('hunyuan')) return 'hunyuan'
  // LTX 2.5 (Lightricks, Aug 2026) has its own two pass graph with sound, so
  // it must beat the generic LTX match below, which is the 2.3 pipeline.
  if (/ltx[._\- ]?2[._\- ]?5/.test(lower)) return 'ltx25'
  if (lower.includes('ltx')) return 'ltx'

  // ERNIE-Image (Baidu, uses flux2 CLIP type + ConditioningZeroOut for negative)
  if (lower.includes('ernie-image') || lower.includes('ernie_image')) return 'ernie_image'

  // Qwen-Image 2.1 (Comfy-Org repack, September 2026): ONE model for both
  // generating and editing, on UNETLoader + CLIPLoader(qwen_image) + its own
  // 64-channel VAE, encoded through TextEncodeQwenImage21.
  //
  // Version-bound on purpose. The older Qwen-Image (2508) and Qwen-Image-Edit
  // (2509/2511) files carry the same `qwen_image` stem but need a different
  // text-encode node, so a bare stem match would route them onto the 2.1
  // pipeline and ComfyUI would reject the graph. They keep falling through to
  // 'unknown', which refuses honestly with "LU could not determine this
  // model's architecture" instead of guessing.
  //
  // Deliberately NOT caught here: the 2.1 text encoder itself
  // (qwen3vl_8b_int8_convrot) and Z-Image's qwen_3_4b carry no `qwen_image`
  // stem, and Krea 2's companion qwen_image_vae carries no 2.1 tag. This
  // function also sees VAE and text-encoder filenames (addonLane), so a match
  // that was any wider would mislabel a companion file as a main model.
  // Before the 'krea' check and the 'xl' suffix scan below, so no later tag
  // can take a 2.1 file first.
  if (/qwen[._-]?image/.test(lower) && /2[._-]?1/.test(lower)) return 'qwenimage'
  // Noct Q (Noctaluna, September 2026): a Qwen-Image 2.1 finetune whose file
  // names say neither "qwen" nor "2.1" (NoctQ_V4_int8_convrot.safetensors on
  // Hugging Face, the CivitAI spelling noctQ_v4). Its header carries the
  // tensor names and shapes of the official file, so it runs on the same lane.
  if (/(^|[^a-z0-9])noct[._ -]?q(?![a-z])/.test(lower)) return 'qwenimage'
  // Qwen-Image 1 (2508, 2512) and Qwen-Image-Edit (2509, 2511, FireRed):
  // Qwen2.5-VL 7B encoder, qwen_image_vae, and for the edit files
  // TextEncodeQwenImageEditPlus (Discord 2026-09-28: "every model except
  // Juggernaut" — these used to fall through to 'unknown' and the checkpoint
  // loader). Never the VAE that carries the same stem.
  if ((/qwen[._-]?image/.test(lower) || lower.includes('firered_image_edit')) && !/[._-]vae/.test(lower)) return 'qwenimage1'

  // Families that used to fall through to 'unknown' and the checkpoint loader.
  // The header sniff (commands/model_sniff.rs) finds them under any name; the
  // names here cover a ComfyUI on another machine, where no header is readable.
  // Word start only: zavychromaXL is an SDXL checkpoint.
  if (/(^|[^a-z])chroma/.test(lower)) return 'chroma'
  if (lower.includes('hidream')) return 'hidream'
  if (/(^|[^a-z0-9])sd[._-]?3|stable[._-]?diffusion[._-]?3/.test(lower)) return 'sd3'
  if (lower.includes('lumina') || lower.includes('netayume')) return 'lumina2'

  // Z-Image (uses qwen_image CLIP type, NOT flux2 — different embedding dimensions)
  if (lower.includes('z_image') || lower.includes('z-image') || lower.includes('zimage')) return 'zimage'
  if (lower.includes('flux-2') || lower.includes('flux2')) return 'flux2'
  if (lower.includes('flux')) return 'flux'

  // Krea 2 (K9, GH #136): CivitAI ships these as a single checkpoint
  // file, but the base model is a decoupled UNETLoader + CLIPLoader(type=
  // "krea2") + VAE pipeline, NOT a self-contained CheckpointLoaderSimple
  // graph. Before this check the name fell through to 'unknown', which
  // CLASSIFIED it as an ordinary checkpoint and loaded it with
  // CheckpointLoaderSimple, and the file has no embedded CLIP, so ComfyUI
  // answered "clip input is invalid: None". Detect before the 'xl' suffix
  // scan below: CivitAI filenames commonly end "...Krea2_fp8.safetensors",
  // which would otherwise never reach it anyway, but keep the ordering
  // explicit so a future tag never sneaks in ahead of it.
  if (lower.includes('krea')) return 'krea2'

  // Explicit architecture tags
  if (lower.includes('sdxl') || lower.includes('sd_xl')) return 'sdxl'
  if (lower.includes('sd15') || lower.includes('sd_1') || lower.includes('v1-5') || lower.includes('sd1.5')) return 'sd15'

  // "xl" suffix/tag (but not "xxl" which is a text encoder)
  if (/[_\-.]xl[_\-.]|[_\-.]xl$|_xl_/i.test(name)) return 'sdxl'

  // Known community model names
  for (const [keyword, type] of Object.entries(KNOWN_MODELS)) {
    if (lower.includes(keyword)) return type
  }

  // SD 1.5 patterns
  if (lower.includes('1.5') || lower.includes('v1_5')) return 'sd15'

  return 'unknown'
}

/** HiDream I1 ships as fast, dev and full, three different samplers
 *  (hidream_i1_fast / _dev / _full templates). Fast is the type default. */
export function hidreamSampling(model: string): { steps: number; cfg: number; sampler: string; scheduler: string } {
  const lower = model.toLowerCase()
  if (lower.includes('full')) return { steps: 50, cfg: 5.0, sampler: 'uni_pc', scheduler: 'simple' }
  if (lower.includes('dev')) return { steps: 28, cfg: 1.0, sampler: 'lcm', scheduler: 'normal' }
  const d = MODEL_TYPE_DEFAULTS.hidream
  return { steps: d.steps, cfg: d.cfg, sampler: d.sampler, scheduler: d.scheduler }
}

export function isImageModelType(type: ModelType): boolean {
  return type === 'flux' || type === 'flux2' || type === 'krea2' || type === 'zimage' || type === 'ernie_image' || type === 'qwenimage'
    || type === 'qwenimage1' || type === 'chroma' || type === 'hidream' || type === 'sd3' || type === 'lumina2'
    || type === 'sdxl' || type === 'sd15' || type === 'unknown'
}

export function isVideoModelType(type: ModelType): boolean {
  return type === 'wan' || type === 'wan22' || type === 'hunyuan' || type === 'ltx' || type === 'ltx25' || type === 'mochi' || type === 'cosmos'
    || type === 'cogvideo' || type === 'svd' || type === 'framepack' || type === 'pyramidflow' || type === 'allegro'
    || type === 'minimaxh3'
}

/**
 * Can this model accept a source still (image-to-video)? True for explicit i2v
 * tags, SVD, FramePack, Wan 2.2 TI2V (dual T2V/I2V), LTX-Video (its base
 * checkpoints drive both graphs via LTXVImgToVideo), and Cosmos Video2World.
 * Used to build the Animate picker list and to route an inputImage to the I2V
 * branch (local lane restored 2026-07-17).
 */
export function isI2VModel(name: string): boolean {
  const lower = name.toLowerCase()
  // FastH3 is text to video only (see isFastH3), whatever its H3 family says.
  if (isFastH3(lower)) return false
  // An A14B half is one or the other, never both like the TI2V-5B.
  if (isWan22A14B(lower)) return lower.includes('i2v') || !lower.includes('t2v')
  return lower.includes('i2v') || lower.includes('svd') || lower.includes('framepack')
    || lower.includes('ti2v') || lower.includes('wan2.2') || lower.includes('wan2_2') || lower.includes('wan22')
    || lower.includes('ltx') || lower.includes('video2world') || classifyModel(name) === 'minimaxh3'
}

/**
 * Can this model do TEXT-to-video (no source image required)? Everything EXCEPT
 * the I2V-ONLY checkpoints: SVD and FramePack load via image-only/wrapper loaders,
 * a CogVideoX *I2V* checkpoint needs a still, and Cosmos Video2World is the
 * conditioned variant (Text2World is its t2v sibling) — none can run a T2V graph.
 * Wan 2.2 TI2V is dual-capable, so it stays in the T2V list too (the
 * `ti2v`/`wan2.2` guard wins over the generic `i2v` substring), and LTX base
 * checkpoints stay because they run both graphs.
 */
export function isT2VCapable(name: string): boolean {
  const lower = name.toLowerCase()
  // Merged i2v-only builds (rapid AIO) carry the wan2.2 tag but cannot run a
  // T2V graph — check before the generic wan2.2 pass-through.
  if (lower.includes('rapid') && lower.includes('i2v')) return false
  if (isWan22A14B(lower)) return !lower.includes('i2v')
  if (lower.includes('ti2v') || lower.includes('wan2.2') || lower.includes('wan2_2') || lower.includes('wan22')) return true
  if (lower.includes('svd') || lower.includes('framepack')) return false
  if (lower.includes('video2world')) return false
  if (lower.includes('i2v')) return false
  return true
}

/**
 * Reference to video (Ref2V, D24): models that take the user's picture as a
 * REFERENCE for who or what is in the clip, not as its first frame. Animate
 * offers them next to the i2v models. MiniMax H3 (ref2va) is not here: it is
 * an i2v family of its own and its builder already takes the reference.
 *
 *  vace     Wan 2.1 VACE, WanVaceToVideo with only a reference_image
 *  phantom  Phantom Wan (subject references)
 *  magref   Wan 2.1 MAGREF (masked multi references)
 *  r2v      any other file whose name says r2v / ref2v
 */
export type Ref2VFamily = 'vace' | 'phantom' | 'magref' | 'r2v'

export function ref2vFamily(name: string | null | undefined): Ref2VFamily | null {
  if (!name) return null
  const lower = name.toLowerCase()
  if (classifyModel(name) === 'minimaxh3') return null
  if (lower.includes('vace')) return 'vace'
  if (lower.includes('phantom')) return 'phantom'
  if (lower.includes('magref')) return 'magref'
  if (/(^|[^a-z0-9])(ref2v|r2v)([^a-z0-9]|$)/.test(lower)) return 'r2v'
  return null
}

/**
 * Why Animate cannot run this reference model, or null when it can. LU builds
 * the reference graph for one family only (Wan 2.1 VACE, the same
 * WanVaceToVideo node the Motion tab already drives). The others need a graph
 * LU does not have, and a guess would end in a ComfyUI error at best and a
 * clip that silently ignores the picture at worst.
 */
export function ref2vRefusal(name: string | null | undefined): string | null {
  const family = ref2vFamily(name)
  if (!family) return null
  const lower = (name ?? '').toLowerCase()
  switch (family) {
    case 'vace':
      if (lower.includes('module')) {
        return 'This file is a VACE add-on module for the WanVideoWrapper nodes, not a full model. Animate runs full Wan 2.1 VACE models such as wan2.1_vace_14B_fp16.'
      }
      if (/wan[._-]?2[._-]?2|(^|[^a-z])fun([^a-z]|$)|high[._-]?noise|low[._-]?noise/.test(lower)) {
        return 'Wan 2.2 VACE Fun needs its own VAE and, for the 14B, a high noise and a low noise model run one after the other. LU builds neither yet. Animate runs Wan 2.1 VACE models.'
      }
      return null
    case 'phantom':
      return 'Phantom needs its own subject reference workflow, which LU does not build yet. Animate runs Wan 2.1 VACE as a reference model.'
    case 'magref':
      return 'MAGREF needs its own masked reference workflow, which LU does not build yet. Animate runs Wan 2.1 VACE as a reference model.'
    case 'r2v':
      return 'LU cannot tell from this file name which reference workflow the model needs. Animate runs Wan 2.1 VACE as a reference model.'
  }
}

/** Can Animate run this model with the picture as a reference? */
export function isRunnableRef2V(name: string | null | undefined): boolean {
  return ref2vFamily(name) !== null && ref2vRefusal(name) === null
}

/** The second line of a reference model's row in the Animate picker: what
 *  the picture becomes, or that the model cannot run here (Create then says
 *  why in full). Nothing on the other tabs or for any other model. */
export function ref2vRowNote(name: string, intent: string): string | undefined {
  if (intent !== 'animate' || !ref2vFamily(name)) return undefined
  return ref2vRefusal(name) ? 'Reference model, not supported yet' : 'Uses your image as a reference'
}

/** The Animate list of a ComfyUI host takes the reference models of the
 *  Motion lane (VACE sits there, not on the video list) next to the video
 *  models. A name on both lists is kept once. */
export function withReferenceModels(video: ClassifiedModel[], motion: ClassifiedModel[]): ClassifiedModel[] {
  const seen = new Set(video.map((m) => m.name))
  return [...video, ...motion.filter((m) => m.type === 'wanvace' && !seen.has(m.name))]
}

/** Can this model run the given video intent? Animate/Extend feed a start
 *  image (i2v), everything else on the video lane is a text-to-video run.
 *  ONE rule for the picker, the starter-bundle gate and submit: whenever two
 *  of them disagreed a real user hit a wall. SVD-only boxes showed
 *  "No matches" yet never offered the starter bundle, and a fresh boot
 *  submitted a persisted SVD pick into the T2V lane, which builds SVD's
 *  LoadImage graph and dies on "Custom validation failed" (2026-08-01). */
export function canRunVideoIntent(name: string, intent: string): boolean {
  return intent === 'animate' || intent === 'extend' ? isI2VModel(name) : isT2VCapable(name)
}

/** Can this model run the given video intent? The catalogue's own word
 *  where the entry carries one, the name otherwise (canRunVideoIntent). An MLX
 *  display name is not a file name: "MLX LTX-2.3 Dev" reads as image to video
 *  by name and fails on a start image in the engine. */
export function canRunVideoLane(m: ClassifiedModel, intent: string): boolean {
  if (!m.startImage) {
    // A reference model is offered on Animate only: it does not continue a
    // clip (Extend), and VACE without a reference has no graph on Video.
    // One it cannot run stays listed, so its row and Create say why.
    if (intent === 'animate' && ref2vFamily(m.name)) return true
    if (m.type === 'wanvace' || ref2vFamily(m.name) === 'vace') return false
    return canRunVideoIntent(m.name, intent)
  }
  return intent === 'animate' || intent === 'extend' ? m.startImage !== 'none' : m.startImage !== 'required'
}

/** The video models the CURRENT intent can actually run (see canRunVideoLane).
 *  On Animate a reference model LU cannot run goes to the end, so it is never
 *  the pick a fresh lane falls back to. */
export function videoLaneModels(list: ClassifiedModel[], intent: string): ClassifiedModel[] {
  const lane = list.filter((m) => canRunVideoLane(m, intent))
  if (intent !== 'animate') return lane
  return [...lane.filter((m) => !ref2vRefusal(m.name)), ...lane.filter((m) => ref2vRefusal(m.name))]
}

/** The video models a run of `intent` can really use: videoLaneModels without
 *  the reference models Animate lists only to say why they cannot run. The
 *  "nothing installed" gates count these, so a lone Phantom file does not hide
 *  the starter download. */
export function runnableVideoLaneModels(list: ClassifiedModel[], intent: string): ClassifiedModel[] {
  return videoLaneModels(list, intent).filter((m) => !ref2vRefusal(m.name))
}

/** Where a bundle keeps the thing that actually generates. The rest of a
 *  bundle is VAE and text encoder, and those names say nothing about i2v. */
const BUNDLE_MODEL_SUBFOLDERS = new Set(['diffusion_models', 'checkpoints', 'unet'])

/**
 * The starter bundle whose MODEL this lane can actually run.
 *
 * Third place that has to obey canRunVideoIntent, and the one that did not.
 * Stage decides "this lane has no models" through that rule, while the
 * installer always took the first video bundle, a Wan 2.1 **T2V**. On Extend
 * Video and Animate Image, which are i2v lanes, that bundle can never satisfy
 * the gate: the card offers a 9.2 GB download, the download succeeds, ComfyUI
 * lists every file, and the card comes back unchanged. Pressing the button
 * again does exactly the same thing, forever.
 *
 * Measured on the box 2026-08-15 on Extend Video, and it is the other half of
 * what Two users reported on 2026-08-13. The C8 fix cured
 * the frozen status line; this cures the reason the card stayed at all.
 *
 * The other lanes need no such pick: their gate is a plain length check on
 * their own list, and their single bundle always lands in it.
 */
export function bundleForVideoIntent<B extends { files: Array<{ filename?: string; subfolder?: string }> }>(
  bundles: B[],
  intent: string,
): B | undefined {
  return bundles.find((b) =>
    b.files.some((f) =>
      !!f.filename &&
      BUNDLE_MODEL_SUBFOLDERS.has(f.subfolder ?? '') &&
      canRunVideoIntent(f.filename, intent)),
  )
}

// ─── Default generation parameters per model type ───

export interface ModelTypeDefaults {
  steps: number
  cfg: number
  sampler: string
  scheduler: string
  width: number
  height: number
  frames: number
  fps: number
}

export const MODEL_TYPE_DEFAULTS: Record<string, ModelTypeDefaults> = {
  // ── Image (frames/fps = 1; per-architecture so the chat-gen image path stops
  //    using a single hardcoded cfg 7 for everything — Flux/Z-Image are distilled
  //    and need a LOW cfg, SD1.5 must default to 512 not 1024). Values mirror the
  //    Create-tab MODEL_TYPE_DEFAULTS (createStore.ts) so both surfaces agree. ──
  sd15:   { steps: 25, cfg: 7.0, sampler: 'euler_ancestral', scheduler: 'normal', width: 512,  height: 512,  frames: 1, fps: 1 },
  sdxl:   { steps: 25, cfg: 7.0, sampler: 'dpmpp_2m',        scheduler: 'karras', width: 1024, height: 1024, frames: 1, fps: 1 },
  flux:   { steps: 20, cfg: 1.0, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 1024, frames: 1, fps: 1 },
  flux2:  { steps: 20, cfg: 1.0, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 1024, frames: 1, fps: 1 },
  // Krea 2 (GH #136, corrected Runde 3): the issue documents two author
  // recipes that share nothing but euler / CFG 1 / 8 steps / 1024x1024 -
  // FinePorn v4 NVFP4 (the reporter's only PROVEN successful run) uses
  // scheduler 'beta' and no extra sampling node; LUSTIFY! v10 Krea2 uses
  // 'simple' plus ModelSamplingAuraFlow shift 4 (see buildDynamicWorkflow's
  // unet_krea2 comment). classifyModel cannot tell the two apart, so this
  // default follows the one run the issue actually confirms working rather
  // than guessing at the other.
  krea2:  { steps: 8,  cfg: 1.0, sampler: 'euler',           scheduler: 'beta',   width: 1024, height: 1024, frames: 1, fps: 1 },
  zimage: { steps: 12, cfg: 3.5, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 1024, frames: 1, fps: 1 },
  // Qwen-Image 2.1: every number is the one the official Comfy-Org templates
  // ship (image_qwen_image_2_1_t2i.json and image_qwen_image_2_1_image_edit.json,
  // KSampler widgets: 25 steps, cfg 1, euler, simple; canvas 1024x1024 at
  // 1 megapixel). Native 2K is available by raising width/height.
  qwenimage: { steps: 25, cfg: 1.0, sampler: 'euler',        scheduler: 'simple', width: 1024, height: 1024, frames: 1, fps: 1 },
  // Numbers from the official Comfy-Org templates (image_qwen_image, image_qwen_image_edit_2509,
  // image_chroma_text_to_image, hidream_i1_fast, sd3.5_simple_example) and nodes_lumina2.
  qwenimage1: { steps: 20, cfg: 4.0, sampler: 'euler',       scheduler: 'simple', width: 1328, height: 1328, frames: 1, fps: 1 },
  chroma:     { steps: 26, cfg: 3.5, sampler: 'euler',       scheduler: 'beta',   width: 1024, height: 1024, frames: 1, fps: 1 },
  hidream:    { steps: 16, cfg: 1.0, sampler: 'lcm',         scheduler: 'normal', width: 1024, height: 1024, frames: 1, fps: 1 },
  sd3:        { steps: 20, cfg: 4.0, sampler: 'euler',       scheduler: 'sgm_uniform', width: 1024, height: 1024, frames: 1, fps: 1 },
  lumina2:    { steps: 25, cfg: 4.0, sampler: 'res_multistep', scheduler: 'simple', width: 1024, height: 1024, frames: 1, fps: 1 },
  unknown:{ steps: 25, cfg: 7.0, sampler: 'euler',           scheduler: 'normal', width: 1024, height: 1024, frames: 1, fps: 1 },
  // ── Video ──
  wan: { steps: 30, cfg: 6.0, sampler: 'euler', scheduler: 'normal', width: 832, height: 480, frames: 81, fps: 16 },
  // Wan 2.2 TI2V-5B — native 1280×704 @ 24 fps, unified T2V/I2V. Default to a
  // VRAM-/speed-friendly 1024×576 16:9 on 12 GB cards (native res is still available
  // by setting width/height); 49 frames ≈ 2 s, the duration matrix runs up to ~7 s.
  wan22: { steps: 30, cfg: 5.0, sampler: 'euler', scheduler: 'simple', width: 1024, height: 576, frames: 49, fps: 24 },
  hunyuan: { steps: 30, cfg: 6.0, sampler: 'euler', scheduler: 'normal', width: 848, height: 480, frames: 45, fps: 24 },
  ltx: { steps: 20, cfg: 3.0, sampler: 'euler', scheduler: 'normal', width: 768, height: 512, frames: 97, fps: 24 },
  // LTX 2.5 (official Comfy-Org templates video_ltx2_5_t2v / _i2v, read
  // 2026-10-02): the distilled model runs two fixed sigma passes (8 steps, then
  // 3) on euler_ancestral at CFG 1, so steps and sampler here are only what the
  // sliders show. 1280x704 is the template's 16:9 canvas on the 64 pixel grid
  // the half size first pass needs; 121 frames at 24 fps is its 5 second default.
  ltx25: { steps: 8, cfg: 1.0, sampler: 'euler_ancestral', scheduler: 'simple', width: 1280, height: 704, frames: 121, fps: 24 },
  // Official templates video_minimax_h3_t2v / _i2v (Comfy-Org/workflow_templates,
  // read 2026-10-01): res_multistep / simple, 20 steps, BasicGuider (no CFG),
  // 1344x768 native canvas, 24 fps, 124 frames is the node's ~5 s default.
  minimaxh3: { steps: 20, cfg: 1.0, sampler: 'res_multistep', scheduler: 'simple', width: 1344, height: 768, frames: 124, fps: 24 },
  mochi: { steps: 30, cfg: 4.5, sampler: 'euler', scheduler: 'normal', width: 848, height: 480, frames: 84, fps: 24 },
  cosmos: { steps: 35, cfg: 7.0, sampler: 'euler', scheduler: 'normal', width: 1024, height: 1024, frames: 121, fps: 24 },
  cogvideo: { steps: 50, cfg: 6.0, sampler: 'euler_ancestral', scheduler: 'normal', width: 480, height: 480, frames: 49, fps: 8 },
  svd: { steps: 20, cfg: 2.5, sampler: 'euler', scheduler: 'karras', width: 576, height: 1024, frames: 25, fps: 6 },
  framepack: { steps: 25, cfg: 7.0, sampler: 'euler', scheduler: 'normal', width: 640, height: 480, frames: 49, fps: 24 },
  pyramidflow: { steps: 20, cfg: 7.0, sampler: 'euler', scheduler: 'normal', width: 768, height: 1280, frames: 16, fps: 8 },
  allegro: { steps: 100, cfg: 7.5, sampler: 'euler', scheduler: 'normal', width: 720, height: 1280, frames: 88, fps: 15 },
  animatediff: { steps: 20, cfg: 7.5, sampler: 'euler_ancestral', scheduler: 'normal', width: 512, height: 512, frames: 16, fps: 8 },
  // AnimateDiff Lightning override (4 steps only)
  animatediff_lightning: { steps: 4, cfg: 1.0, sampler: 'euler', scheduler: 'sgm_uniform', width: 512, height: 512, frames: 16, fps: 8 },
  // ERNIE-Image Turbo (Baidu 8B DiT)
  ernie_image: { steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple', width: 1024, height: 1024, frames: 1, fps: 1 },
  // ── 2.5.8 specialized local lanes (core-node defaults, July 2026) ──
  // ACE-Step music: width/height are unused by the audio graph but keep the
  // shared param scaffolding happy; track length lives in musicDuration.
  ace: { steps: 50, cfg: 5.0, sampler: 'euler', scheduler: 'simple', width: 1024, height: 1024, frames: 1, fps: 1 },
  // YuE2 (official template audio_yue2_text2music): KSampler 32 steps, cfg 1,
  // dpm_2 on sgm_uniform. The audio graph reads none of it from the sliders but
  // the scaffold wants the fields.
  yue2: { steps: 32, cfg: 1.0, sampler: 'dpm_2', scheduler: 'sgm_uniform', width: 1024, height: 1024, frames: 1, fps: 1 },
  // Wan 2.2 S2V — node defaults 832×480, length 77 @ 16 fps.
  wans2v: { steps: 20, cfg: 6.0, sampler: 'euler', scheduler: 'simple', width: 832, height: 480, frames: 77, fps: 16 },
  // Wan 2.2 Animate — node defaults 832×480, length 77 @ 16 fps.
  wananimate: { steps: 20, cfg: 5.0, sampler: 'euler', scheduler: 'simple', width: 832, height: 480, frames: 77, fps: 16 },
  // Wan 2.1 VACE — node defaults 832×480, length 81 @ 16 fps.
  wanvace: { steps: 25, cfg: 5.0, sampler: 'euler', scheduler: 'simple', width: 832, height: 480, frames: 81, fps: 16 },
}

// ─── Component Requirements per model type ───

// K9 (GH #136): the registry used to be declared here AND, separately, in
// discover.ts, two copies of the same per-model-type data that both had to
// be remembered on every new architecture. Krea 2 only reached one of them.
// Canonical data now lives in component-registry.ts (Audit W-T2 pattern,
// same fix as pulling the bundle catalog into model-bundles.ts); both
// comfyui.ts and discover.ts import it and neither has to import the other.
export type { ComponentSpec, ComponentRequirements } from './component-registry'
export { COMPONENT_REGISTRY } from './component-registry'

// ─── Connection & Info ───

export async function checkComfyConnection(): Promise<boolean> {
  try {
    const res = await localFetch(comfyuiUrl('/system_stats'))
    return res.ok
  } catch {
    return false
  }
}

/**
 * Force ComfyUI to re-scan model directories. Works on ComfyUI 2024+ with
 * /api/refresh.
 *
 * Retries on transient failures because in production we hit two real-world
 * race conditions:
 *  1. ComfyUI is mid-startup and `/api/refresh` 404s briefly (Discord report
 *     from a user: logs show repeated localhost:8188 connect errors after a
 *     fresh download lands).
 *  2. ComfyUI is busy executing a workflow and accepts the refresh but doesn't
 *     finish the directory scan before we query `/object_info`.
 *
 * For both cases a single attempt silently returned `false` and the caller
 * never knew the cache stayed stale.
 */
export async function refreshComfyModels(maxAttempts = 3): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await localFetch(comfyuiUrl('/api/refresh'), { method: 'POST', timeoutMs: COMFY_STATS_TIMEOUT_MS })
      if (res.ok) return true
    } catch { /* network blip — retry */ }
    if (attempt < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
    }
  }
  return false // Older ComfyUI versions without /api/refresh — non-fatal
}

// ─── System VRAM Detection ───

let cachedVRAM: number | null = null

/**
 * Is this /system_stats entry ComfyUI's CPU pseudo-device?
 *
 * When torch has no usable GPU backend ComfyUI still reports one device, and
 * for that one `vram_total` is `psutil.virtual_memory().total`. It is system
 * RAM wearing a VRAM field's name.
 */
function isCpuDevice(dev: unknown): boolean {
  const d = (dev ?? {}) as { type?: unknown; name?: unknown }
  const type = String(d.type ?? '').trim().toLowerCase()
  const name = String(d.name ?? '').trim().toLowerCase()
  return type === 'cpu' || name === 'cpu' || name.startsWith('cpu:') || name.startsWith('cpu ')
}

/**
 * The largest real VRAM figure in a /system_stats payload, in bytes, or null.
 *
 * GitHub #123: the Model Manager fit check showed "62 GB GPU · 62 GB
 * RAM" on a box with a 16 GB RX 9070 XT and 64 GB of RAM, the same number
 * twice, while the Settings page a tab away had the correct 16 GB. This is
 * where the 62 came from. ROCm was not detected, so his ComfyUI ran on the
 * processor, so /system_stats carried exactly one device, the CPU one, whose
 * `vram_total` is the machine's RAM. The old reader took `devices[0]` whatever
 * it was, and DiscoverModels then kept the LARGER of that and the honest 16 GB
 * from detect_gpus.
 *
 * Two rules, and the second matters as much as the first:
 *  - CPU entries are not a GPU and never contribute a size.
 *  - When nothing else is left the answer is null, which the UI renders as
 *    "unknown". A fit check that says nothing is a fit check a user can still
 *    trust; one that says 62 GB sends him to download a model that cannot run.
 *
 * Apple's `mps` device is NOT excluded. Unified memory really is the VRAM
 * there, so the number is right for the machine it comes from.
 *
 * `unifiedMemory` is the same point one step further, and it is the reason
 * macOS passes true. `detect_macos` reports no size at all, so /system_stats is
 * the ONLY VRAM source on a Mac, and a ComfyUI started with --cpu reports a cpu
 * device there. Dropping it would have turned the fit check on every such Mac
 * into "GPU unknown" and taken the "Fits my PC" filter with it. On a machine
 * where the graphics unit and the processor share one pool, the pool is the
 * honest answer for both, which is exactly what makes the Windows case wrong:
 * there the card has its own memory and the CPU figure is a different number
 * about a different thing.
 *
 * Pure and exported so the case above can be a test instead of a screenshot.
 */
export function pickDeviceVramBytes(
  devices: unknown,
  opts: { unifiedMemory?: boolean } = {},
): number | null {
  if (!Array.isArray(devices)) return null
  let best = 0
  for (const dev of devices) {
    if (!opts.unifiedMemory && isCpuDevice(dev)) continue
    const bytes = (dev as { vram_total?: unknown } | null)?.vram_total
    if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes > best) best = bytes
  }
  return best > 0 ? best : null
}

export async function getSystemVRAM(): Promise<number | null> {
  if (cachedVRAM !== null) return cachedVRAM
  try {
    const res = await localFetch(comfyuiUrl('/system_stats'), { timeoutMs: COMFY_STATS_TIMEOUT_MS })
    if (!res.ok) return null
    const data = await res.json()
    // ComfyUI returns top-level devices[].vram_total in bytes
    const vramBytes = pickDeviceVramBytes(data?.devices, { unifiedMemory: isMacOS() })
    if (vramBytes !== null) {
      cachedVRAM = Math.round(vramBytes / (1024 * 1024 * 1024)) // bytes → GB
      return cachedVRAM
    }
  } catch { /* ComfyUI not running */ }
  return null
}

/**
 * The running ComfyUI's own version string, or null if it does not say.
 *
 * /system_stats carries `system.comfyui_version` on every current build; very
 * old ones simply have no such field, and that is an answer too (the caller
 * maps it to the `unknown` placeholder). Used by the Create tab's cross-origin
 * notice to tell "the same ComfyUI as when you dismissed this" from "a
 * different one", see lib/comfy-cors-notice.ts. Not cached: a restart under
 * LU's management, or a user update, is exactly the change worth noticing.
 */
export async function getComfyVersion(): Promise<string | null> {
  try {
    const res = await localFetch(comfyuiUrl('/system_stats'), { timeoutMs: COMFY_STATS_TIMEOUT_MS })
    if (!res.ok) return null
    const data = await res.json()
    const v = data?.system?.comfyui_version
    return typeof v === 'string' && v.trim() ? v.trim() : null
  } catch {
    return null
  }
}

// Check if a specific node exists in ComfyUI (lightweight, single node check)
async function nodeExists(nodeName: string): Promise<boolean> {
  try {
    const res = await localFetch(comfyuiUrl(`/object_info/${nodeName}`), { timeoutMs: COMFY_LIST_TIMEOUT_MS })
    if (!res.ok) return false
    const data = await res.json()
    return !!(data && data[nodeName])
  } catch {
    return false
  }
}

/** Which of the video save nodes this ComfyUI has, as the sync check
 *  addVideoSave wants (A19). */
async function videoSaverPresence(): Promise<(classType: string) => boolean> {
  const names = ['CreateVideo', 'SaveVideo', 'VHS_VideoCombine', 'SaveAnimatedWEBP']
  const present = await Promise.all(names.map((name) => nodeExists(name)))
  const have = new Set(names.filter((_, i) => present[i]))
  return (classType) => have.has(classType)
}

/** One /object_info call for one node, read through the shared combo reader.
 *
 *  `strict` is for the two loaders whose absence means ComfyUI itself is not
 *  answering: those still throw on an HTTP error so the caller can tell "no
 *  models installed" apart from "no engine". Everything else soft-fails to an
 *  empty list, because an optional pack that is not installed is not an error.
 *
 *  Nothing here reads the spec by hand any more. The AnimateDiff node answers
 *  in the newer COMBO schema while the stock loaders answer in the legacy one
 *  (proven on the box, see comfyui-enum.ts), and one hand-read spec was enough
 *  to take the whole video discovery down. */
async function fetchNodeOptions(
  node: string,
  field: string,
  opts: { strict?: boolean } = {},
): Promise<string[]> {
  const res = await localFetch(comfyuiUrl(`/object_info/${node}`), { timeoutMs: COMFY_LIST_TIMEOUT_MS })
  if (!res.ok) {
    if (opts.strict) throw new Error(`ComfyUI /object_info/${node} failed (HTTP ${res.status})`)
    return []
  }
  const data = await res.json()
  return nodeComboOptions(data, node, field)
}

export async function getCheckpoints(): Promise<string[]> {
  return fetchNodeOptions('CheckpointLoaderSimple', 'ckpt_name', { strict: true })
}

export async function getDiffusionModels(): Promise<string[]> {
  return fetchNodeOptions('UNETLoader', 'unet_name', { strict: true })
}

/**
 * One optional loader, with "the node is not registered here" told apart from
 * "the node is registered and lists nothing".
 *
 * The difference decides whether a file may be called invisible. A loader that
 * is simply absent (a ComfyUI older than the node, a distro that ships without
 * it) has said nothing about the folder, and treating its silence as "ComfyUI
 * cannot see your file" would send a perfectly installed bundle back to the
 * download button. `null` is that silence; the folder is then left out of the
 * lists below and nothing judges a file in it.
 */
async function nodeOptionsOrNull(node: string, field: string): Promise<string[] | null> {
  try {
    const res = await localFetch(comfyuiUrl(`/object_info/${node}`), { timeoutMs: COMFY_LIST_TIMEOUT_MS })
    if (!res.ok) return null
    const data = await res.json()
    // ComfyUI answers 200 with `{}` for a class it does not know.
    if (!data || typeof data !== 'object' || !(node in (data as Record<string, unknown>))) return null
    return nodeComboOptions(data, node, field)
  } catch (err) {
    log.warn('comfyui.fetch_folder_failed', { node, err })
    return null
  }
}

/** The loader for one folder of COMFY_MODEL_FOLDERS, by subfolder. The node and
 *  field of a folder are spelled ONCE, in that table. */
async function folderOptions(subfolder: string): Promise<string[] | null> {
  const entry = COMFY_MODEL_FOLDERS.find((f) => f.subfolder === subfolder)
  return entry ? entry.read() : null
}

export async function getVAEModels(): Promise<string[]> {
  return (await folderOptions('vae')) ?? []
}

export async function getCLIPModels(): Promise<string[]> {
  return (await folderOptions('text_encoders')) ?? []
}

/**
 * F2 (GH#4): list LoRA files ComfyUI knows about. Pulls the same
 * enum LoraLoader's `lora_name` dropdown shows, which is anything the user
 * dropped into `<comfyui>/models/loras/`.
 */
export async function getLoraModels(): Promise<string[]> {
  return (await listedLoras()) ?? []
}

/** The same list, or null when ComfyUI could not be asked. Only a real list
 *  may prune the LoRA stack (GH #146). */
export async function listedLoras(): Promise<string[] | null> {
  return folderOptions('loras')
}

/** The five folders the R5 re-measure (2026-08-30) found missing entirely.
 *
 *  A dummy .safetensors was dropped into ten ComfyUI model folders. ComfyUI
 *  listed all ten at once; the app showed five of them and never mentioned the
 *  other five. Two real files were invisible with them, an 817 MB CLIP-Vision
 *  encoder and, once the partial filter below was fixed, a 2.4 GB text
 *  encoder. */
export async function getCLIPVisionModels(): Promise<string[]> {
  return (await folderOptions('clip_vision')) ?? []
}

/** The audio encoders the Talking Character lane needs (Wav2Vec2). Our catalog
 *  has written into `models\audio_encoders` since the 2.5.8 lanes and nothing
 *  read it back, so the file could be neither confirmed after its download nor
 *  listed among the things taking up the disk. */
export async function getAudioEncoderModels(): Promise<string[]> {
  return (await folderOptions('audio_encoders')) ?? []
}

export async function getControlNetModels(): Promise<string[]> {
  return (await folderOptions('controlnet')) ?? []
}

export async function getUpscaleModels(): Promise<string[]> {
  return (await folderOptions('upscale_models')) ?? []
}

export async function getStyleModels(): Promise<string[]> {
  return (await folderOptions('style_models')) ?? []
}

/** Embeddings are the one folder no loader node enumerates: ComfyUI serves
 *  them from its own /embeddings route instead, and that route hands back
 *  BASE NAMES with the extension stripped. So this list alone cannot be shown
 *  as installed files, and resolveEmbeddingFiles below puts the extension
 *  back before anything reaches the inventory. */
export async function getEmbeddingNames(): Promise<string[]> {
  try {
    const res = await localFetch(comfyuiUrl('/embeddings'), { timeoutMs: COMFY_LIST_TIMEOUT_MS })
    if (!res.ok) return []
    const data = await res.json()
    if (!Array.isArray(data)) return []
    return data.filter((n): n is string => typeof n === 'string' && n.length > 0)
  } catch (err) {
    log.warn('comfyui.fetch_embeddings_failed', { err })
    return []
  }
}

export async function getSamplers(): Promise<string[]> {
  try {
    const list = await fetchNodeOptions('KSampler', 'sampler_name')
    if (list.length === 0) throw new Error('KSampler listed no samplers')
    return list
  } catch {
    return ['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_sde', 'uni_pc', 'ddim']
  }
}

export async function getSchedulers(): Promise<string[]> {
  try {
    const list = await fetchNodeOptions('KSampler', 'scheduler')
    if (list.length === 0) throw new Error('KSampler listed no schedulers')
    return list
  } catch {
    return ['normal', 'karras', 'simple', 'exponential', 'sgm_uniform']
  }
}

/** Motion modules the AnimateDiff-Evolved pack enumerates. These files do NOT
 *  live under ComfyUI\models: the pack keeps them in
 *  custom_nodes/ComfyUI-AnimateDiff-Evolved/models, which is why the four
 *  ComfyUI\models loaders cannot see them and why every surface that only read
 *  those four reported an installed AnimateDiff bundle as nothing at all.
 *
 *  This is also the node that answers in the newer COMBO schema on a real box,
 *  so it is the one that used to hand a bare "COMBO" string to callers. */
export async function getAnimateDiffModels(): Promise<string[]> {
  return (await folderOptions('custom_nodes/ComfyUI-AnimateDiff-Evolved/models')) ?? []
}

// ─── Partial Download Filter ───
// Filters out files that exist on disk but are incomplete (< 90% of expected size).
// Uses known bundle file sizes from model-bundles.ts. Unknown files pass through.

let _knownFileSizes: Map<string, { subfolder: string; expectedBytes: number }> | null = null

async function getKnownFileSizes(): Promise<Map<string, { subfolder: string; expectedBytes: number }>> {
  if (_knownFileSizes) return _knownFileSizes
  _knownFileSizes = new Map()
  for (const bundle of [...getImageBundles(), ...getVideoBundles()]) {
    for (const f of bundle.files) {
      if (f.filename && f.sizeGB && f.subfolder) {
        _knownFileSizes.set(f.filename, {
          subfolder: f.subfolder,
          expectedBytes: Math.round(f.sizeGB * 1_073_741_824),
        })
      }
    }
  }
  return _knownFileSizes
}

/** Filter out partially downloaded files. Returns only filenames that are complete. */
export async function filterPartialFiles(filenames: string[]): Promise<Set<string>> {
  const known = await getKnownFileSizes()
  const filesToCheck = filenames
    .filter(name => known.has(name))
    .map(name => {
      const info = known.get(name)!
      return { subfolder: info.subfolder, filename: name, expectedBytes: info.expectedBytes }
    })

  if (filesToCheck.length === 0) return new Set(filenames) // nothing to check → all pass

  try {
    const { backendCall } = await import('./backend')
    const results: Array<{ filename: string; exists?: boolean; complete: boolean }> =
      await backendCall('check_model_sizes', { files: filesToCheck })
    // Only hide a model when it is CONFIRMED partial: present on disk but too
    // small (exists === true && !complete). A bare `!complete` also dropped
    // files the size-checker simply couldn't locate (exists === false) — which
    // happens whenever the checker looks at the wrong ComfyUI path (the dev
    // server's hardcoded path guesses, a custom/remote comfy host, etc.). But
    // these filenames came FROM ComfyUI's own /object_info enums, so ComfyUI
    // can load them — never hide a model ComfyUI vouches for just because a
    // secondary size probe missed it (a user 2026-06-07: "no image model"
    // even though ComfyUI had Juggernaut/RealVis installed).
    const incomplete = new Set(results.filter(r => r.exists === true && !r.complete).map(r => r.filename))
    if (incomplete.size > 0) {
      log.info('comfyui.filtered_partial_downloads', { count: incomplete.size, files: [...incomplete] })
    }
    return new Set(filenames.filter(name => !incomplete.has(name)))
  } catch {
    return new Set(filenames) // if check fails, show all (backward compat)
  }
}

// ─── Classified Model Lists ───

/**
 * The main-model folders (checkpoints\, diffusion_models\, and the GGUF unets
 * beside them), classified and narrowed to one lane.
 *
 * `hidePartialDownloads` is the entire difference between the two kinds of
 * caller, and it is the R7 re-measure (2026-08-30) written down as a switch:
 *
 *  - A PICKER asks "what can I render with", so a file that is confirmed too
 *    small for the catalogue entry of the same name is worth hiding: picking it
 *    would only hand the user a broken graph.
 *  - The INVENTORY asks "what is lying on my disk", and for that question a
 *    catalogue size is meaningless. It is a claim about the file WE ship, never
 *    about the file the user has.
 *
 * On the box a 13 MB `diffusion_models\flux1-dev-fp8.safetensors` was invisible
 * in the whole app while a byte-identical copy named
 * `flux1-dev-fp8-r67.safetensors` in the SAME folder listed fine: the catalogue
 * ships FLUX.1 [dev] FP8 under the first name at 16.1 GB, so the size probe
 * called the file partial and getImageModels dropped it, and the inventory read
 * getImageModels. The user had a file on the disk he could neither see, nor
 * measure, nor delete. Same shape as the R5 re-measure that took the filter out
 * of the addon lanes, one folder further in.
 *
 * The catalogue card keeps its own verdict (discover.ts filters there) and goes
 * on saying honestly that the package is not fully downloaded.
 */
/** A VAE that landed in a main model folder (Discord 2026-09-26: a CivitAI
 *  download of minimax_h3_video_vae_fp16 showed up as an IMAGE model). It can
 *  never run as one, so the picker leaves it out. Deliberately narrow: only a
 *  name that ENDS in vae (plus a precision tag). */
export function isStrayAddonFile(name: string): boolean {
  const base = name.split(/[\\/]/).pop()!.toLowerCase()
  // "bakedvae", "realvisxl_v40_vae": checkpoints that carry their VAE.
  if (base.includes('baked') || /v\d+[a-z0-9]*[._-]vae/.test(base)) return false
  return /[._-]vae([._-](fp16|fp32|bf16|fp8[a-z0-9_]*))?\.(safetensors|sft|pt|pth|ckpt|bin|gguf)$/.test(base)
}

/** Header families that map straight onto a ModelType. */
const SNIFF_TYPES: Record<string, ModelType> = {
  flux: 'flux', flux2: 'flux2', krea2: 'krea2', zimage: 'zimage', ernie_image: 'ernie_image',
  qwenimage: 'qwenimage', qwenimage1: 'qwenimage1', chroma: 'chroma', hidream: 'hidream',
  sd3: 'sd3', lumina2: 'lumina2', sdxl: 'sdxl', sd15: 'sd15', wan: 'wan', minimaxh3: 'minimaxh3',
}

/** Name types the header may overrule: the image families and 'unknown'. A
 *  video or lane name keeps its name type, because Wan 2.1 and 2.2 (and S2V,
 *  Animate, VACE) share one tensor layout and only the name tells them apart. */
const SNIFF_OVERRULES = (t: ModelType) => isImageModelType(t)

/**
 * Discord 2026-09-26..28: a CivitAI name
 * says nothing reliable about the architecture, and every name LU could not
 * place went to the checkpoint loader ("Node 1 (CheckpointLoaderSimple):
 * Value not in list"). The file header does say it. Rewrites `type` in place
 * from the header, drops files that are a bare VAE or text encoder, and
 * records which parts an all-in-one file carries. Best effort: a ComfyUI on
 * another machine, a GGUF, or a browser build keeps the name-based answer.
 */
export async function applyHeaderSniff(models: ClassifiedModel[]): Promise<void> {
  const ask = models.filter((m) => SNIFF_OVERRULES(m.type) && !m.name.toLowerCase().endsWith('.gguf'))
  if (ask.length === 0) return
  let answers: Array<{ folder: string; name: string; arch?: string | null; hasTextEncoder?: boolean; hasVae?: boolean }>
  try {
    const { backendCall, isTauri } = await import('./backend')
    if (!isTauri()) return
    answers = await backendCall('sniff_model_files', {
      files: ask.map((m) => ({ folder: m.source === 'checkpoint' ? 'checkpoints' : 'diffusion_models', name: m.name })),
    })
  } catch (err) {
    log.warn('comfyui.header_sniff_failed', { err })
    return
  }
  const byKey = new Map(answers.map((a) => [`${a.folder}|${a.name}`, a]))
  const drop = new Set<ClassifiedModel>()
  for (const m of ask) {
    const a = byKey.get(`${m.source === 'checkpoint' ? 'checkpoints' : 'diffusion_models'}|${m.name}`)
    if (!a?.arch) continue
    if (a.arch === 'vae' || a.arch === 'text_encoder') { drop.add(m); continue }
    const type = SNIFF_TYPES[a.arch]
    if (type && type !== m.type) {
      log.info('comfyui.header_sniff_retyped', { name: m.name, from: m.type, to: type })
      m.type = type
    }
    m.parts = { textEncoder: !!a.hasTextEncoder, vae: !!a.hasVae }
  }
  if (drop.size > 0) {
    const kept = models.filter((m) => !drop.has(m))
    models.splice(0, models.length, ...kept)
  }
}

async function mainModelLane(
  keep: (type: ModelType) => boolean,
  hidePartialDownloads: boolean,
): Promise<ClassifiedModel[]> {
  // GGUF quants are listed by ComfyUI-GGUF's own loader, NOT by UNETLoader
  // (which only enumerates .safetensors/.sft). Leaving them out meant a user
  // could install a GGUF bundle straight from our own Model Manager and then be
  // told "No image model installed" by the image tool. Empty when the pack is
  // absent, so this is free for everyone else.
  const [checkpoints, diffModels, ggufModels] = await Promise.all([
    getCheckpoints(),
    getDiffusionModels(),
    getGgufUnetModels(),
  ])
  const unets = [...new Set([...diffModels, ...ggufModels])]
  const complete = hidePartialDownloads
    ? await filterPartialFiles([...checkpoints, ...unets])
    : null
  const result: ClassifiedModel[] = []

  const candidates: ClassifiedModel[] = []
  for (const name of checkpoints) {
    if (complete && !complete.has(name)) continue
    if (isStrayAddonFile(name)) continue
    candidates.push({ name, type: classifyModel(name), source: 'checkpoint' })
  }
  for (const name of unets) {
    if (complete && !complete.has(name)) continue
    if (isStrayAddonFile(name)) continue
    candidates.push({ name, type: classifyModel(name), source: 'diffusion_model' })
  }
  await applyHeaderSniff(candidates)

  // One predicate for both folders. isImageModelType lets 'unknown' through,
  // so a file neither the name nor the header can place is still offered,
  // while the video types (SVD) and the lane architectures (ACE audio, Wan
  // S2V/Animate/VACE) stay in their own pickers. The old branch renamed
  // anything unmatched to sdxl instead of skipping it, which put an ACE-Step
  // music checkpoint at the top of the image picker on a real box.
  for (const m of candidates) {
    if (keep(m.type)) result.push(m)
  }

  return result
}

/** The Create image picker and model-pick: main models that are usable. */
export async function getImageModels(): Promise<ClassifiedModel[]> {
  return mainModelLane(isImageModelType, true)
}

/** The Create video picker and detectVideoBackend: same deal one lane over.
 *  Our own catalogue ships Wan video models as GGUF quants, and UNETLoader does
 *  not list those, so downloading one from the Model Manager used to leave the
 *  video tool insisting nothing was installed. */
export async function getVideoModels(): Promise<ClassifiedModel[]> {
  return mainModelLane(isVideoModelType, true)
}

/** The main image folders for the INVENTORY surfaces: everything on the disk,
 *  no catalogue-size verdict. See mainModelLane for why the switch exists. */
export async function getInstalledMainImageModels(): Promise<ClassifiedModel[]> {
  return mainModelLane(isImageModelType, false)
}

/** What the video INVENTORY counts: every video architecture, including the
 *  three Wan lanes that isVideoModelType leaves out so the plain Video picker
 *  never offers them (S2V for Talking Character, Animate and VACE for Motion
 *  Control). The picker rule is the wrong rule for "what is on the disk".
 *
 *  Discord, thread "I can't launch Wan2.2" (15.10.2026): the catalogue's
 *  Wan2.2-Animate-14B-Q4_K_M.gguf card said Installed and the Installed tab
 *  did not list it, because this inventory borrowed the picker rule. Renamed
 *  to Wan2.1.gguf it showed up (plain Wan class), and Create then ran an
 *  Animate model through the plain Wan graph. */
export function isInstalledVideoType(type: ModelType): boolean {
  return isVideoModelType(type) || type === 'wans2v' || type === 'wananimate' || type === 'wanvace'
}

/** The main video folders for the INVENTORY surfaces. Video twin of
 *  getInstalledMainImageModels. */
export async function getInstalledMainVideoModels(): Promise<ClassifiedModel[]> {
  return mainModelLane(isInstalledVideoType, false)
}

/** The AnimateDiff motion modules, as classified models. (getMotionModels,
 *  without the prefix, is the Wan Animate/VACE lane and a different thing.)
 *
 *  Kept separate from getVideoModels on purpose: the Create video picker asks
 *  that one for a MAIN model, and a motion module is never that. It is half of
 *  a pair (SD checkpoint + motion module) that the animatediff strategy puts
 *  together itself via findAnimateDiffModel. */
export async function getAnimateDiffMotionModels(): Promise<ClassifiedModel[]> {
  const names = await getAnimateDiffModels()
  return names.map((name) => ({ name, type: 'animatediff' as ModelType, source: 'motion_module' as const }))
}

/** One lane of the inventory, read on its own. A lane that fails costs itself
 *  and one log line, never the lanes beside it.
 *
 *  Counter-check on the Windows box, 2026-08-29: the AnimateDiff lane threw
 *  ("(intermediate value).map is not a function", because that node answers in
 *  the newer COMBO schema) and took the ENTIRE video discovery with it. The
 *  Models page then showed a Video tab with no number, Installed 0 and "No
 *  video models installed" while three cards correctly said Installed, and the
 *  whole thing was a warn line nobody saw. The reader below is fixed at the
 *  root, but a single lane must never again be able to empty the page. */
async function inventoryLane(
  lane: string,
  read: () => Promise<ClassifiedModel[]>,
): Promise<ClassifiedModel[]> {
  try {
    return await read()
  } catch (err) {
    log.warn('comfyui.inventory_lane_failed', { lane, err })
    return []
  }
}

/** Everything installed in the video lane, for the INVENTORY surfaces: the
 *  Models rail counter and the Installed tab.
 *
 *  Counter-check on the Windows box, 2026-08-29: two AnimateDiff bundles
 *  installed cleanly, both cards read Installed, and the rail counter and the
 *  Installed list knew neither of them. The cards check their own files, the
 *  counter read the four ComfyUI\models loaders, and AnimateDiff keeps its
 *  motion modules under custom_nodes. Same bug shape as GH #113: card, counter
 *  and list answering from different readers.
 *
 *  Two additions over getVideoModels, both of them things ComfyUI really can
 *  serve as video right now:
 *   - the motion modules themselves, wherever the pack keeps them
 *   - the SD checkpoints the catalogue's AnimateDiff bundles ship, but ONLY
 *     while motion modules exist, which is the same condition selectStrategy uses before it
 *     routes a video request onto the animatediff pipeline. That is the second
 *     file of both AnimateDiff bundles (Realistic Vision), which used to be
 *     counted under Image alone, so a video bundle showed up half in the wrong
 *     lane and half nowhere. It stays in the Image count too, because it is
 *     genuinely an image checkpoint as well.
 *
 *  Not used by detectVideoBackend, the Create picker or model-pick: those ask
 *  for a main model and getVideoModels still answers exactly what it did. */
export async function getInstalledVideoModels(): Promise<ClassifiedModel[]> {
  const [videoModels, motionModels] = await Promise.all([
    inventoryLane('video', getInstalledMainVideoModels),
    inventoryLane('animatediff', getAnimateDiffMotionModels),
  ])
  const out: ClassifiedModel[] = [...videoModels, ...motionModels]
  if (motionModels.length > 0) {
    // Only the checkpoints a video bundle of the catalogue ships, which is
    // what "the second file of both AnimateDiff bundles" always meant. This
    // used to take EVERY image checkpoint once a motion module was on disk,
    // so sd_turbo (an image model no motion module here can drive) stood in
    // the Video list of the box on 03.10.2026.
    const bundled = new Set(getVideoBundles().flatMap((b) => b.files)
      .filter((f) => f.subfolder === 'checkpoints' && f.filename)
      .map((f) => f.filename!.toLowerCase()))
    const imageModels = await inventoryLane('image', getInstalledMainImageModels)
    for (const m of imageModels) {
      if (m.source !== 'checkpoint') continue
      if (!bundled.has((m.name.split(/[\\/]/).pop() ?? m.name).toLowerCase())) continue
      if (out.some((x) => x.name === m.name)) continue
      out.push(m)
    }
  }
  return out
}

/** Extensions a model file on the disk actually carries. Everything ComfyUI
 *  enumerates by filename ends in one of these. */
const MODEL_FILE_EXTENSIONS = [
  '.safetensors', '.sft', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.onnx', '.pkl',
]

/**
 * Is this enum entry a file on the disk at all.
 *
 * R5 re-measure, 2026-08-30: the Installed list under Image carried an entry
 * called `pixel_space`, type safetensors, no size. A search over the whole C:
 * drive found no such file, because there is none. `pixel_space` is ComfyUI's
 * built-in pixel-space pseudo VAE, and VAELoader offers it in the same enum as
 * the real files, exactly like the built-in taesd family beside it. The app
 * read that enum as a list of installed files and invented a model the user
 * neither downloaded nor can delete.
 *
 * The rule is the general one rather than a name list: an inventory entry
 * claims a file occupies the disk, and a name with no file extension is not a
 * file. That covers pixel_space, taesd, taesdxl, taesd3, taef1 and whatever
 * ComfyUI builds in next, without this having to be told about it.
 */
export function isInstalledModelFile(name: string): boolean {
  const lower = name.toLowerCase()
  return MODEL_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** One addon folder, as classified models. These files are not a model on
 *  their own, which is why no picker offers them and why every inventory
 *  surface used to skip them. They still occupy the disk and the user still
 *  has to be able to see and remove them.
 *
 *  No partial filter here any more, and that is the second half of the R5
 *  re-measure (2026-08-30). `text_encoders\llava_llama3_fp8_scaled.safetensors`
 *  weighs 2.4 GB on the box and appeared nowhere, while its three folder
 *  neighbours appeared. The catalogue ships that name at 8.5 GB, the disk
 *  probe called 2.4 GB too small, and filterPartialFiles dropped it. But a
 *  catalogue size is a claim about the file WE ship, never about the file the
 *  user has, and this list answers one question only: what is lying on the
 *  disk. ComfyUI enumerates the file, so ComfyUI can load it; hiding it left
 *  2.4 GB the user could not see and could not delete. The bundle cards and
 *  the Create pickers keep their partial filter, because "is this usable" is
 *  their question and it is a different one. */
async function addonLane(
  read: () => Promise<string[]>,
  source: AddonSource,
): Promise<ClassifiedModel[]> {
  const names = await read()
  return names
    .filter(isInstalledModelFile)
    .map((name) => ({ name, type: classifyModel(name), source }))
}

/**
 * The embeddings folder, as real filenames.
 *
 * ComfyUI has no loader node over embeddings: they are served by the
 * /embeddings route, which strips the extension off every name. A stripped
 * name is not a file, so it fails isInstalledModelFile, cannot be measured and
 * cannot be deleted. So the extension is put back by asking the disk which of
 * the candidates exists, in ONE batched probe for the whole folder.
 *
 * Best effort: a probe that fails costs the embeddings lane and nothing else,
 * which is the same deal every other lane gets.
 */
async function embeddingLane(): Promise<ClassifiedModel[]> {
  const bases = await getEmbeddingNames()
  if (bases.length === 0) return []
  // A name that already carries an extension needs no guessing.
  const ready = bases.filter(isInstalledModelFile)
  const stripped = bases.filter((n) => !isInstalledModelFile(n))
  const found = new Set<string>(ready)
  if (stripped.length > 0) {
    try {
      const files = stripped.flatMap((base) =>
        MODEL_FILE_EXTENSIONS.map((ext) => ({
          subfolder: 'embeddings', filename: `${base}${ext}`, expectedBytes: 0,
        })),
      )
      const results: Array<{ filename: string; exists?: boolean }> =
        await backendCall('check_model_sizes', { files })
      const onDisk = new Set(results.filter((r) => r.exists).map((r) => r.filename))
      for (const base of stripped) {
        const hit = MODEL_FILE_EXTENSIONS.map((ext) => `${base}${ext}`).find((f) => onDisk.has(f))
        if (hit) found.add(hit)
      }
    } catch (err) {
      log.warn('comfyui.embedding_filename_probe_failed', { err })
    }
  }
  return [...found].map((name) => ({ name, type: classifyModel(name), source: 'embedding' as const }))
}

/**
 * Which loader answers for which ComfyUI model folder. ONE table, because the
 * folder list was spread over the readers that happened to need a folder, and
 * a folder nobody happened to need was simply invisible: five of them at the
 * R5 re-measure on 2026-08-30 (clip_vision, controlnet, upscale_models,
 * embeddings, style_models), holding among other things an 817 MB CLIP-Vision
 * encoder that no surface in the app had ever named.
 *
 * The main-model folders (checkpoints, diffusion_models, and the GGUF unets
 * beside them) are not here: those are read by getImageModels, which the
 * pickers share. Everything else a user drops into ComfyUI\models is.
 */
const INSTALLED_ADDON_LANES: Array<{ source: AddonSource; read: () => Promise<ClassifiedModel[]> }> = [
  { source: 'lora', read: () => addonLane(getLoraModels, 'lora') },
  { source: 'vae', read: () => addonLane(getVAEModels, 'vae') },
  { source: 'text_encoder', read: () => addonLane(getCLIPModels, 'text_encoder') },
  { source: 'clip_vision', read: () => addonLane(getCLIPVisionModels, 'clip_vision') },
  { source: 'controlnet', read: () => addonLane(getControlNetModels, 'controlnet') },
  { source: 'upscale_model', read: () => addonLane(getUpscaleModels, 'upscale_model') },
  { source: 'style_model', read: () => addonLane(getStyleModels, 'style_model') },
  { source: 'embedding', read: embeddingLane },
]

/** Every ComfyUI\models folder the inventory reads, by its subfolder name.
 *  Exported so a test can hold it against ComfyUI's own folder truth instead
 *  of against the list that happens to be here. */
export const INSTALLED_ADDON_SUBFOLDERS: string[] =
  INSTALLED_ADDON_LANES.map((lane) => subfolderForSource(lane.source))

/** Where the AnimateDiff-Evolved pack keeps its motion modules. Not under
 *  ComfyUI\models at all, which is exactly why the counter and the Installed
 *  list used to miss a fully installed AnimateDiff bundle while its card said
 *  Installed (counter-check on the Windows box, 2026-08-29). */
export const ANIMATEDIFF_SUBFOLDER = 'custom_nodes/ComfyUI-AnimateDiff-Evolved/models'

/**
 * THE table: every folder the Get button writes into, and the loader that
 * lists it back.
 *
 * A user (Discord help-chat, 2026-09-02): FramePack F1 and Wan 2.1
 * installed through the Get button and appeared in no picker. The folder half
 * of that is fixed where a file is written (src-tauri/.../comfy_folders.rs,
 * which asks the running ComfyUI instead of guessing). This is the other half:
 * until now the folders the catalog WRITES to and the folders the app READS
 * back were two hand-written lists in two files, and they had already drifted.
 *
 * Two Get targets were in no reader at all:
 *   * `clip_vision`, FramePack F1's 900 MB SigCLIP encoder.
 *   * `audio_encoders`, the Wav2Vec2 encoder both Talking Character bundles
 *     need, added with the 2.5.8 lanes and never read back anywhere.
 * A file in either could not be confirmed after its download, and the bundle
 * card's fallback could never call those bundles installed, because it looked
 * up a folder nothing had filled.
 *
 * The guard against the next drift is a test, not a promise:
 * `src/api/__tests__/get-target-is-a-folder-we-read.test.ts` walks every file
 * of every bundle in the catalog and fails on a subfolder that is not in here.
 */
export const COMFY_MODEL_FOLDERS: Array<{
  subfolder: string
  /** The files ComfyUI lists in that folder, or `null` when the loader that
   *  lists it is not registered in this ComfyUI at all. See
   *  `nodeOptionsOrNull` for why the two are not the same answer. */
  read: () => Promise<string[] | null>
}> = [
  // The two main-model loaders are the strict ones: their absence does not mean
  // an empty folder, it means ComfyUI is not answering, and every caller here
  // already treats that as "no verdict about anything".
  { subfolder: 'checkpoints', read: getCheckpoints },
  // Two loaders, one folder: UNETLoader enumerates .safetensors and .sft,
  // ComfyUI-GGUF's own loader the .gguf quants beside them. Our own catalog
  // ships video models both ways, and the pack being absent is normal.
  {
    subfolder: 'diffusion_models',
    read: async () => {
      const [unets, ggufs] = await Promise.all([
        getDiffusionModels(),
        nodeOptionsOrNull('UnetLoaderGGUF', 'unet_name'),
      ])
      return [...unets, ...(ggufs ?? [])]
    },
  },
  { subfolder: 'vae', read: () => nodeOptionsOrNull('VAELoader', 'vae_name') },
  { subfolder: 'text_encoders', read: () => nodeOptionsOrNull('CLIPLoader', 'clip_name') },
  { subfolder: 'clip_vision', read: () => nodeOptionsOrNull('CLIPVisionLoader', 'clip_name') },
  { subfolder: 'audio_encoders', read: () => nodeOptionsOrNull('AudioEncoderLoader', 'audio_encoder_name') },
  { subfolder: 'loras', read: () => nodeOptionsOrNull('LoraLoader', 'lora_name') },
  { subfolder: 'controlnet', read: () => nodeOptionsOrNull('ControlNetLoader', 'control_net_name') },
  { subfolder: 'upscale_models', read: () => nodeOptionsOrNull('UpscaleModelLoader', 'model_name') },
  // The x2 latent upscaler LTX 2.5's second pass needs (a different folder
  // and a different loader from the image upscalers above).
  { subfolder: 'latent_upscale_models', read: () => nodeOptionsOrNull('LatentUpscaleModelLoader', 'model_name') },
  { subfolder: 'style_models', read: () => nodeOptionsOrNull('StyleModelLoader', 'style_model_name') },
  { subfolder: ANIMATEDIFF_SUBFOLDER, read: () => nodeOptionsOrNull('ADE_LoadAnimateDiffModel', 'model_name') },
]

/** Subfolders whose contents ComfyUI enumerates, which is the same thing as
 *  "folders the visibility check can reason about". The table, as a set. */
export const ENUM_SUBFOLDERS = new Set(COMFY_MODEL_FOLDERS.map((f) => f.subfolder))

/** What each folder of the table holds right now, by subfolder. One round trip
 *  per folder, asked once and used by every caller that needs more than one.
 *
 *  A folder whose loader is not registered here is LEFT OUT rather than
 *  reported empty. The keys are therefore also the answer to "which folders can
 *  be judged at all", which is what `judgeableFolders` hands to the callers
 *  that decide whether a file may be called invisible. */
export async function readComfyFolderLists(): Promise<Record<string, string[]>> {
  const entries = await Promise.all(
    COMFY_MODEL_FOLDERS.map(async (f) => [f.subfolder, await f.read()] as const),
  )
  return Object.fromEntries(entries.filter((e): e is readonly [string, string[]] => e[1] !== null))
}


/** Everything installed in the image lane, for the INVENTORY surfaces: the
 *  Models rail counter and the Installed tab. The image twin of
 *  getInstalledVideoModels, and the same bug shape one folder further out.
 *
 *  Counter-check on the Windows box, 2026-08-29: the cards for Pixel Art XL
 *  (163 MB in loras\) and SDXL VAE fp16-fix (319 MB in vae\) both read
 *  Installed, and neither file was in any Installed list or any counter.
 *  Beside them sat two more LoRAs, four text encoders and five more VAEs that
 *  no surface in the app had ever mentioned. The counter and the list read
 *  checkpoints\ and diffusion_models\ and nothing else, so the user could
 *  neither see what those files cost him nor delete one from the list.
 *
 *  Not used by the Create picker or model-pick: those ask for a main model
 *  and getImageModels still answers exactly what it did. A VAE is never a
 *  main model, and this function is the only place that says otherwise. */
export async function getInstalledImageModels(): Promise<ClassifiedModel[]> {
  const [imageModels, ...addons] = await Promise.all([
    inventoryLane('image', getInstalledMainImageModels),
    ...INSTALLED_ADDON_LANES.map((lane) => inventoryLane(lane.source, lane.read)),
  ])
  const out: ClassifiedModel[] = []
  const seen = new Set<string>()
  // First lane wins. A name that two loaders both list (a checkpoint ComfyUI
  // also offers as a VAE) is one file on the disk and belongs in the list
  // once, or the Installed count starts inventing entries.
  for (const m of [imageModels, ...addons].flat()) {
    if (seen.has(m.name)) continue
    seen.add(m.name)
    out.push(m)
  }
  return out
}

/** What each listed file weighs on the disk, by filename.
 *
 *  The inventory used to hand every ComfyUI file a size of 0, which the card
 *  renders as no size at all. That was tolerable while the list held nothing
 *  but big checkpoints the user had just picked himself; it is not once the
 *  list is supposed to answer "what is all this costing me". Best effort
 *  throughout: a probe that fails costs the sizes, never the list. */
export async function readModelDiskSizes(models: ClassifiedModel[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (models.length === 0) return out
  try {
    // expectedBytes 0 on purpose: this asks how big the file IS, and the
    // partial-download verdict is filterPartialFiles' job, not this one's.
    const files = models.map((m) => ({
      subfolder: subfolderForSource(m.source),
      filename: m.name,
      expectedBytes: 0,
    }))
    const results: Array<{ filename: string; exists?: boolean; actualBytes?: number }> =
      await backendCall('check_model_sizes', { files })
    for (const r of results) {
      if (r.exists && typeof r.actualBytes === 'number' && r.actualBytes > 0) {
        out.set(r.filename, r.actualBytes)
      }
    }
  } catch (err) {
    log.warn('comfyui.disk_sizes_failed', { err })
  }
  return out
}

// ── 2.5.8 specialized local-lane model lists ─────────────────────────────────
// Each lane owns its picker: an ACE checkpoint in the Image list (or a 14B S2V
// in the Video list) would build a graph that ComfyUI rejects, so these
// architectures are excluded from isImage/isVideo above and surfaced here.

/** GGUF-quantized UNets (city96 ComfyUI-GGUF pack). Empty when the pack is not
 *  installed — callers merge these into their lane list and the builder swaps
 *  UNETLoader for UnetLoaderGGUF by extension. */
export async function getGgufUnetModels(): Promise<string[]> {
  try {
    return await fetchNodeOptions('UnetLoaderGGUF', 'unet_name')
  } catch (err) {
    log.warn('comfyui.fetch_gguf_failed', { err })
    return []
  }
}

/** The architectures the music lane runs. Both ship as all in one checkpoints. */
export const isMusicModelType = (type: ModelType): boolean => type === 'ace' || type === 'yue2'

/** Music lane: ACE-Step and YuE2 all-in-one checkpoints (model + text encoder + VAE). */
export async function getAudioModels(): Promise<ClassifiedModel[]> {
  const checkpoints = await getCheckpoints()
  const complete = await filterPartialFiles(checkpoints)
  return checkpoints
    .filter((name) => complete.has(name) && isMusicModelType(classifyModel(name)))
    .map((name) => ({ name, type: classifyModel(name), source: 'checkpoint' as const }))
}

/** Talking-character lane: Wan 2.2 S2V UNets (safetensors via UNETLoader,
 *  .gguf via the GGUF pack when installed). */
export async function getLipsyncModels(): Promise<ClassifiedModel[]> {
  const [diffModels, ggufModels] = await Promise.all([getDiffusionModels(), getGgufUnetModels()])
  const complete = await filterPartialFiles(diffModels)
  const fromUnet = diffModels
    .filter((name) => complete.has(name) && classifyModel(name) === 'wans2v')
    .map((name) => ({ name, type: 'wans2v' as ModelType, source: 'diffusion_model' as const }))
  const fromGguf = ggufModels
    .filter((name) => classifyModel(name) === 'wans2v')
    .map((name) => ({ name, type: 'wans2v' as ModelType, source: 'diffusion_model' as const }))
  return [...fromUnet, ...fromGguf]
}

/** One rule for the specialized-lane picker AND submit: a pick that is not on
 *  the lane's list (stale cross-lane selection, deleted file) resolves to the
 *  list's first entry — the same guard the cloud op picker got after the
 *  take-01 wrong-trainer incident. */
export function resolveLocalOpPick(picked: string, list: ClassifiedModel[]): string {
  return list.some((m) => m.name === picked) ? picked : (list[0]?.name ?? '')
}

/** Motion-control lane: Wan 2.2 Animate UNets + Wan VACE UNets. */
export async function getMotionModels(): Promise<ClassifiedModel[]> {
  const [diffModels, ggufModels] = await Promise.all([getDiffusionModels(), getGgufUnetModels()])
  const complete = await filterPartialFiles(diffModels)
  const wanted = (t: ModelType) => t === 'wananimate' || t === 'wanvace'
  const fromUnet = diffModels
    .filter((name) => complete.has(name) && wanted(classifyModel(name)))
    .map((name) => ({ name, type: classifyModel(name), source: 'diffusion_model' as const }))
  const fromGguf = ggufModels
    .filter((name) => wanted(classifyModel(name)))
    .map((name) => ({ name, type: classifyModel(name), source: 'diffusion_model' as const }))
  return [...fromUnet, ...fromGguf]
}

// ─── Detect Video Backend (checks individual nodes + models — no full object_info fetch) ───

export async function detectVideoBackend(): Promise<VideoBackend> {
  try {
    // Check Wan/Hunyuan: need specific nodes AND actual video models
    const [hasWanLatent, hasUNET, hasCLIP, hasVAE, videoModels] = await Promise.all([
      nodeExists('EmptyHunyuanLatentVideo'),
      nodeExists('UNETLoader'),
      nodeExists('CLIPLoader'),
      nodeExists('VAELoader'),
      getVideoModels(),
    ])

    if (hasWanLatent && hasUNET && hasCLIP && hasVAE && videoModels.length > 0) {
      return 'wan'
    }

    // Check AnimateDiff: need custom extension nodes
    const [hasADELoad, hasADESampling] = await Promise.all([
      nodeExists('ADE_LoadAnimateDiffModel'),
      nodeExists('ADE_UseEvolvedSampling'),
    ])
    if (hasADELoad && hasADESampling) return 'animatediff'
  } catch (err) {
    log.warn('comfyui.detect_video_backend_failed', { err })
  }
  return 'none'
}

// ─── Auto-find matching VAE/CLIP for a model ───

/** HunyuanVideo 1.5 VAE (32-channel). FramePack and every other 1.0-era
 *  model must never be handed one. Matches `hunyuanvideo15_vae_fp16` as well
 *  as spaced-out spellings like `hunyuan_video_1.5_vae`. */
function isHunyuan15Vae(name: string): boolean {
  return /hunyuan[._-]?video[._-]?1[._-]?5/.test(name.toLowerCase())
}

/** Qwen-Image 2.1's own autoencoder (64 channels, RGBA, 16x compression).
 *  Krea 2's companion `qwen_image_vae.safetensors` is the older 16-channel
 *  one and shares the stem, so both resolvers have to tell them apart by the
 *  version tag. Same shape of mistake the Wan 2.1 / Wan 2.2 VAE branch below
 *  already guards against: the wrong file loads and the decode fails on the
 *  channel count. */
function isQwenImage21Vae(name: string): boolean {
  return /qwen[._-]?image[._-]?2[._-]?1/.test(name.toLowerCase())
}

/** Qwen-Image 2.1's text encoder tier (Qwen3-VL 8B), official or with the
 *  refusals removed. Krea 2 uses the 4B sibling under a near-identical name,
 *  and the two have different embedding dimensions. */
function isQwen3vl8b(name: string): boolean {
  return qwenEncoderFile(name) !== null
}

/** MiniMax H3's own encoder (qwen3vl_32b_minimax_h3_*). It is a Qwen3-VL file
 *  too, so every family that matches its encoder on a generic qwen / qwen3vl
 *  stem has to step around it, or a box holding both loads a 32B encoder
 *  into a 4B slot. */
function isMinimaxEncoder(name: string): boolean {
  return name.toLowerCase().includes('minimax')
}

/** An empty ComfyUI list still names the file this family needs, so Create
 *  can offer it as a download instead of "a VAE for your model type". */
function nothingInstalled(kind: 'VAE' | 'text encoder', specs: (ComponentSpec | undefined)[]): Error {
  const files = specs.filter((x): x is ComponentSpec => !!x).map((x) => `"${x.downloadFilename}"`)
  if (files.length === 0) return new Error(`No ${kind} models found. Download a ${kind} for your model type from the Model Manager.`)
  return new Error(`No ${kind} models found. Download ${files.join(' and ')} from the Model Manager.`)
}

export async function findMatchingVAE(modelType: ModelType): Promise<string> {
  const vaes = await getVAEModels()
  if (vaes.length === 0) throw nothingInstalled('VAE', [COMPONENT_REGISTRY[modelType]?.vae])
  const lower = (s: string) => s.toLowerCase()

  if (modelType === 'zimage') {
    // Z-Image uses ae.safetensors (same as FLUX but prefer exact match)
    const match = vaes.find(v => lower(v) === 'ae.safetensors')
      || vaes.find(v => lower(v).includes('ae'))
      || vaes.find(v => lower(v).includes('flux'))
    if (match) return match
    throw new Error(`No Z-Image VAE found. Download "ae.safetensors" from the Model Manager.`)
  }
  if (modelType === 'flux') {
    // FLUX.1 uses the 16-channel ae.safetensors autoencoder, NOT the FLUX 2 VAE.
    const match = vaes.find(v => lower(v) === 'ae.safetensors')
      || vaes.find(v => lower(v).includes('ae') && !lower(v).includes('flux2'))
      || vaes.find(v => lower(v).includes('flux') && !lower(v).includes('flux2'))
    if (match) return match
    throw new Error(`No FLUX.1 VAE found. Download "ae.safetensors" from the Model Manager.`)
  }
  if (modelType === 'flux2' || modelType === 'ernie_image') {
    const match = vaes.find(v => lower(v).includes('flux2'))
      || vaes.find(v => lower(v).includes('flux'))
      || vaes.find(v => lower(v).includes('ae'))
    if (match) return match
    throw new Error(`No FLUX 2 VAE found. Download "flux2-vae.safetensors" from the Model Manager.`)
  }
  if (modelType === 'qwenimage') {
    // Qwen-Image 2.1 ships its own autoencoder. Pinned by the version tag so a
    // box that also carries Krea 2's older qwen_image_vae cannot hand that one
    // over: it has 16 channels where this model wants 64.
    const match = vaes.find(v => lower(v) === 'qwen_image_2.1_vae_bf16.safetensors')
      || vaes.find(v => isQwenImage21Vae(v))
    if (match) return match
    throw new Error(`No Qwen-Image 2.1 VAE found. Download "qwen_image_2.1_vae_bf16.safetensors" from the Model Manager.`)
  }
  if (modelType === 'krea2') {
    // Krea 2's companion VAE is not standardized across CivitAI finetunes
    // (GH #136 saw both qwen_image_vae and wan_2.1_vae). Try a Krea-named
    // file first, then the two variants confirmed by the issue reporter.
    // The qwen_image hit excludes the Qwen-Image 2.1 autoencoder: it carries
    // the same stem, sorts next to the file this branch wants, and would
    // decode a Krea 2 latent with the wrong channel count.
    const match = vaes.find(v => lower(v).includes('krea'))
      || vaes.find(v => lower(v).includes('qwen_image') && !isQwenImage21Vae(v))
      || vaes.find(v => /wan[._]?2[._]?1/.test(lower(v)))
    if (match) return match
    throw new Error(`No Krea 2 VAE found. Download "qwen_image_vae.safetensors" (or "wan_2.1_vae.safetensors", depending on the checkpoint) from the Model Manager.`)
  }
  if (modelType === 'hunyuan') {
    // HunyuanVideo has its own VAE — prefer it, fall back to Wan VAE
    const match = vaes.find(v => lower(v).includes('hunyuanvideo'))
      || vaes.find(v => lower(v).includes('hunyuan'))
      || vaes.find(v => lower(v).includes('wan'))
    if (match) return match
    throw new Error(`No HunyuanVideo VAE found. Download "hunyuanvideo15_vae_fp16.safetensors" from the Model Manager.`)
  }
  if (modelType === 'wan') {
    // Wan 2.1 latents are 16-channel; the Wan 2.2 VAE is 48-channel — decoding
    // 2.1 output with it fails ("expected input to have 48 channels, but got
    // 16"). Live regression 2026-06-11: right after the Wan 2.2 bundle install,
    // wan2.2_vae sorted BEFORE wan_2.1_vae in the enum and the first
    // .includes('wan') hit broke every Wan 2.1 generation. Prefer the 2.1 file
    // explicitly and never fall into a 2.2 one.
    const isWan22Vae = (v: string) => /wan[._]?2[._]?2/.test(lower(v))
    // Same reason the HunyuanVideo 1.5 VAE is excluded here: it is 32-channel,
    // so the last-resort hunyuan fallback would trade a missing-file message
    // for the tensor crash FramePack was dying with (D#104).
    const match = vaes.find(v => /wan[._]?2[._]?1/.test(lower(v)))
      || vaes.find(v => lower(v).includes('wan') && !isWan22Vae(v))
      || vaes.find(v => lower(v).includes('hunyuan') && !isHunyuan15Vae(v))
    if (match) return match
    throw new Error(`No Wan VAE found. Download "wan_2.1_vae.safetensors" from the Model Manager.`)
  }
  if (modelType === 'wan22') {
    // Defense in depth — the wan22 builder pins its VAE by name, but if this
    // resolver is ever hit, ONLY the 2.2 VAE is valid (48-channel latents).
    const match = vaes.find(v => /wan[._]?2[._]?2/.test(lower(v)))
    if (match) return match
    throw new Error(`No Wan 2.2 VAE found. Download "wan2.2_vae.safetensors" from the Model Manager.`)
  }
  if (modelType === 'ltx') {
    const match = vaes.find(v => lower(v).includes('ltx') && !isLtx25File(v))
      || vaes.find(v => lower(v).includes('ltx'))
    if (match) return match
    return vaes[0]
  }
  if (modelType === 'ltx25') {
    // The VIDEO autoencoder. The audio one is a second file (findLtx25AudioVAE)
    // and the "-conv" video variant is an alternative the template does not use.
    const match = vaes.find(v => /ltx[._-]?2[._-]?5[._-]video[._-]vae/.test(lower(v)) && !lower(v).includes('conv'))
    if (match) return match
    throw new Error(`No LTX 2.5 video VAE found. Download "ltx-2.5-video-vae-bf16.safetensors" from the Model Manager.`)
  }
  if (modelType === 'minimaxh3') {
    // The VIDEO autoencoder; the audio one is a second file of its own
    // (findMiniMaxAudioVAE), and the two are not interchangeable.
    const match = vaes.find(v => lower(v).includes('minimax_h3_video_vae'))
      || vaes.find(v => lower(v).includes('minimax') && lower(v).includes('video'))
    if (match) return match
    throw new Error(`No MiniMax H3 video VAE found. Download "minimax_h3_video_vae_int8_convrot.safetensors" from the Model Manager.`)
  }
  if (modelType === 'mochi') {
    const match = vaes.find(v => lower(v).includes('mochi'))
    if (match) return match
    throw new Error(`No Mochi VAE found. Download "mochi_vae.safetensors" from the Model Manager.`)
  }
  if (modelType === 'cosmos') {
    const match = vaes.find(v => lower(v).includes('cosmos'))
    if (match) return match
    throw new Error(`No Cosmos VAE found. Download "cosmos_cv8x8x8_1.0.safetensors" from the Model Manager.`)
  }
  if (modelType === 'cogvideo') {
    const match = vaes.find(v => lower(v).includes('cogvideox') || lower(v).includes('cogvideo'))
    if (match) return match
    throw new Error(`No CogVideoX VAE found. Download "cogvideox_vae_bf16.safetensors" from the Model Manager.`)
  }
  if (modelType === 'framepack') {
    // 16-channel latents (HunyuanVideo 1.0). The 1.5 VAE is 32-channel and
    // crashes the sampler, so it is excluded rather than merely deprioritised:
    // on a disk holding both, first-hit order decided which one a run got.
    const match = vaes.find(v => lower(v).includes('hunyuan') && !isHunyuan15Vae(v))
      || vaes.find(v => lower(v).includes('wan'))
    if (match) return match
    throw new Error(`No FramePack VAE found. Download "hunyuan_video_vae_bf16.safetensors" from the Model Manager.`)
  }
  if (modelType === 'pyramidflow') {
    const match = vaes.find(v => lower(v).includes('pyramid'))
    if (match) return match
    throw new Error(`No Pyramid Flow VAE found. Download from the Model Manager.`)
  }
  // SVD / Allegro use checkpoint-embedded VAE, SDXL/SD1.5 too — any VAE works as fallback
  return vaes[0]
}

/**
 * Resolve the FLUX v1 text-encoder PAIR for DualCLIPLoader (C2, a user
 * follow-up): modern ComfyUI removed 'flux' from the single CLIPLoader's type
 * enum, so FLUX v1 conditioning must come from DualCLIPLoader, which needs
 * BOTH encoders — clip_name1 = T5-XXL, clip_name2 = CLIP-L. Throws the same
 * actionable "download <file> from the Model Manager" errors as
 * findMatchingCLIP so buildDynamicWorkflow surfaces a fix path per missing
 * encoder instead of a raw ComfyUI rejection.
 */
export async function findFluxCLIPPair(): Promise<{ t5: string; clipL: string }> {
  const clips = await getCLIPModels()
  if (clips.length === 0) throw nothingInstalled('text encoder', [COMPONENT_REGISTRY.flux?.clip, COMPONENT_REGISTRY.flux?.clipSecondary])
  const lower = (s: string) => s.toLowerCase()
  const t5 = clips.find(c => lower(c).includes('t5') && !lower(c).includes('umt5') && !lower(c).includes('oldt5'))
  const clipL = clips.find(c => lower(c).includes('clip_l'))
  if (!t5) throw new Error(`No FLUX text encoder (T5) found. Download "t5xxl_fp8_e4m3fn.safetensors" from the Model Manager.`)
  if (!clipL) throw new Error(`No FLUX CLIP-L text encoder found. Download "clip_l.safetensors" from the Model Manager.`)
  return { t5, clipL }
}

/**
 * K2 (review-create.md nachbessert, Punkt 2): FramePack's DualCLIPLoader
 * (type "hunyuan_video") wrote `clip_l.safetensors` and
 * `llava_llama3_fp8_scaled.safetensors` straight into the node, same
 * hardcoded-literal failure class the rest of K2 already fixed for VAE/CLIP/
 * audio_encoder/clip_vision in the other builders. Resolved now against the
 * live CLIP enum, same shape as findFluxCLIPPair above, with the same
 * actionable "download <file>" errors on a miss.
 */
export async function findFramePackCLIPPair(): Promise<{ clipL: string; llavaLlama3: string }> {
  const clips = await getCLIPModels()
  if (clips.length === 0) throw nothingInstalled('text encoder', [COMPONENT_REGISTRY.framepack?.clip, COMPONENT_REGISTRY.framepack?.clipSecondary])
  const lower = (s: string) => s.toLowerCase()
  const clipL = clips.find(c => lower(c).includes('clip_l'))
  const llavaLlama3 = clips.find(c => lower(c).includes('llava'))
  if (!clipL) throw new Error(`No FramePack CLIP-L text encoder found. Download "clip_l.safetensors" from the Model Manager.`)
  if (!llavaLlama3) throw new Error(`No FramePack llava_llama3 text encoder found. Download "llava_llama3_fp8_scaled.safetensors" from the Model Manager.`)
  return { clipL, llavaLlama3 }
}

/** A file that says it is an LTX 2.5 one (ltx-2.5-..., gemma4-...-ltx-2.5-...). */
export function isLtx25File(name: string): boolean {
  return /ltx[._\- ]?2[._\- ]?5/.test(name.toLowerCase())
}

/** The sound autoencoder LTX 2.5 decodes its audio with. A second file next to
 *  the video VAE, and the two are not interchangeable. */
export async function findLtx25AudioVAE(): Promise<string> {
  const vaes = await getVAEModels()
  const match = vaes.find(v => isLtx25File(v) && v.toLowerCase().includes('audio'))
  if (match) return match
  throw new Error(`No LTX 2.5 audio VAE found. Download "ltx-2.5-audio-vae-bf16.safetensors" from the Model Manager.`)
}

/** MiniMax H3's audio autoencoder. The model writes picture and sound into
 *  one latent and decodes the sound half with this file. */
export async function findMiniMaxAudioVAE(): Promise<string> {
  const vaes = await getVAEModels()
  const match = vaes.find(v => v.toLowerCase().includes('minimax_h3_audio_vae'))
    || vaes.find(v => v.toLowerCase().includes('minimax') && v.toLowerCase().includes('audio'))
  if (match) return match
  throw new Error(`No MiniMax H3 audio VAE found. Download "minimax_h3_audio_vae_fp32.safetensors" from the Model Manager.`)
}

/**
 * Pick the right text encoder for a model.
 *
 * @param modelType — ModelType from `classifyModel`.
 * @param activeModelName — optional filename of the UNet/checkpoint the
 *   user selected. Enables quantisation-aware pairing: e.g. fp4 FLUX 2
 *   models get the fp4-matched Qwen encoder, fp8/bf16 FLUX 2 models get
 *   the full-precision Qwen encoder. When omitted (legacy callers), we
 *   fall back to the full-precision variant, which is what most users
 *   want.
 * @param qwenTextEncoder Qwen-Image 2.1 only: the edition the user picked in
 *   the advanced settings. Omitted, the official one goes first.
 */
export async function findMatchingCLIP(modelType: ModelType, activeModelName?: string, qwenTextEncoder?: QwenEncoderChoice): Promise<string> {
  // The Qwen-Image 2.1 prompt enhancers sit in the same folder and carry
  // "qwen" in their names, but they are text models, not encoders. Without
  // this they answer the loose "qwen" searches below (HunyuanVideo, FramePack,
  // FLUX 2) before the real encoder does.
  const clips = (await getCLIPModels()).filter((c) => !isQwenEnhancerFile(c))
  if (clips.length === 0) throw nothingInstalled('text encoder', [COMPONENT_REGISTRY[modelType]?.clip])
  const lower = (s: string) => s.toLowerCase()
  const modelLc = activeModelName ? lower(activeModelName) : ''
  const modelIsFp4 = /fp4|nf4/.test(modelLc)

  if (modelType === 'zimage') {
    // Z-Image uses qwen_3_4b.safetensors (NOT the fp4_flux2 variant — different embedding dimensions!)
    const match = clips.find(c => lower(c) === 'qwen_3_4b.safetensors')
      || clips.find(c => lower(c).includes('qwen_3_4b') && !lower(c).includes('fp4') && !lower(c).includes('flux2'))
      || clips.find(c => lower(c).includes('qwen3') && !lower(c).includes('fp4'))
    if (match) return match
    throw new Error(`No Z-Image text encoder found. Download "qwen_3_4b.safetensors" from the Model Manager.`)
  }
  if (modelType === 'flux2') {
    // FLUX 2 uses Qwen 3 4B (NOT T5). The encoder file comes in two
    // quantisation tiers that ARE NOT interchangeable:
    //   - `qwen_3_4b.safetensors`           → normal / bf16 / fp8 models
    //   - `qwen_3_4b_fp4_flux2.safetensors` → fp4 / nf4 quantised models
    // Using the wrong one can work (same embedding dim) but noticeably
    // degrades prompt adherence, so we pair them by inspecting the
    // filename of the active UNet (see `modelIsFp4` above). Fallback
    // order ensures we never hard-fail when the "ideal" encoder isn't
    // installed: we try the paired one first, then the other.
    const qwenFp4  = clips.find(c => lower(c).includes('qwen') && (lower(c).includes('fp4') || lower(c).includes('nf4')) && !lower(c).includes('qwen_2.5_vl') && !isMinimaxEncoder(c))
    const qwenFull = clips.find(c => lower(c).includes('qwen_3_4b') && !lower(c).includes('fp4') && !lower(c).includes('nf4') && !lower(c).includes('vl'))
    const qwenAny  = clips.find(c => lower(c).includes('qwen') && !lower(c).includes('qwen_2.5_vl') && !isMinimaxEncoder(c))
    const mistral  = clips.find(c => lower(c).includes('mistral'))
    const match = modelIsFp4
      ? (qwenFp4 || qwenFull || qwenAny || mistral)
      : (qwenFull || qwenAny || qwenFp4 || mistral)
    if (match) return match
    const wanted = modelIsFp4 ? 'qwen_3_4b_fp4_flux2.safetensors (fp4 FLUX 2)' : 'qwen_3_4b.safetensors (fp8/bf16 FLUX 2)'
    throw new Error(`No FLUX 2 text encoder found. Download "${wanted}" from the Model Manager.`)
  }
  if (modelType === 'ernie_image') {
    // ERNIE-Image uses its own prompt enhancer text encoder
    const match = clips.find(c => lower(c).includes('ernie-image-prompt-enhancer') || lower(c).includes('ernie'))
    if (match) return match
    throw new Error(`No ERNIE-Image text encoder found. Download "ernie-image-prompt-enhancer.safetensors" from the Model Manager.`)
  }
  if (modelType === 'qwenimage') {
    // Qwen-Image 2.1 uses Qwen3-VL 8B (2.0 and older used Qwen2.5-VL). Pinned
    // to the 8B tier with no fallback: Krea 2's 4B sibling sits in the same
    // folder under a near-identical name and has different embedding
    // dimensions, so a fallback would load silently and encode nonsense.
    // Two editions can sit side by side, the official one and the one
    // without refusals; the advanced settings say which one reads the prompt.
    const match = pickQwenEncoder(clips, qwenTextEncoder)
    if (match) return match.file
    throw new Error(`No Qwen-Image 2.1 text encoder found. Download "qwen3vl_8b_int8_convrot.safetensors" from the Model Manager.`)
  }
  if (modelType === 'krea2') {
    // Krea 2 uses Qwen3-VL 4B, shipped under different quant-tier filenames
    // by different finetune authors (GH #136: qwen3vl_4b_int8_convrot vs
    // qwen3vl_4b_fp8_scaled), so match on the qwen3vl family, not one filename.
    // The 8B file is excluded throughout: it belongs to Qwen-Image 2.1, and
    // since that bundle landed in the Model Manager a box can hold both.
    const match = clips.find(c => /qwen3[._-]?vl[._-]?4b/.test(lower(c)))
      || clips.find(c => (lower(c).includes('qwen3vl') || lower(c).includes('qwen3_vl')) && !isQwen3vl8b(c) && !isMinimaxEncoder(c))
      || clips.find(c => lower(c).includes('qwen') && lower(c).includes('vl') && !isQwen3vl8b(c) && !isMinimaxEncoder(c))
    if (match) return match
    throw new Error(`No Krea 2 text encoder found. Download "qwen3vl_4b_fp8_scaled.safetensors" from the Model Manager.`)
  }
  if (modelType === 'flux') {
    const match = clips.find(c => lower(c).includes('t5') && !lower(c).includes('umt5'))
      || clips.find(c => lower(c).includes('clip_l'))
    if (match) return match
    throw new Error(`No FLUX text encoder (T5) found. Download "t5xxl_fp8_e4m3fn.safetensors" from the Model Manager.`)
  }
  if (modelType === 'hunyuan') {
    // HunyuanVideo 1.5 uses Qwen 2.5 VL, older versions use llava_llama3
    const match = clips.find(c => lower(c).includes('qwen') && !isMinimaxEncoder(c))
      || clips.find(c => lower(c).includes('llava'))
      || clips.find(c => lower(c).includes('umt5'))
    if (match) return match
    throw new Error(`No HunyuanVideo text encoder found. Download "qwen_2.5_vl_7b_fp8_scaled.safetensors" from the Model Manager.`)
  }
  if (modelType === 'wan') {
    const match = clips.find(c => lower(c).includes('umt5') || lower(c).includes('wan'))
      || clips.find(c => lower(c).includes('t5'))
    if (match) return match
    throw new Error(`No Wan text encoder found. Download "umt5_xxl_fp8_e4m3fn_scaled.safetensors" from the Model Manager.`)
  }
  if (modelType === 'ltx') {
    // LTX 2.3 reads Gemma 3. The Gemma 4 encoders belong to LTX 2.5 and would
    // be refused by a 2.3 graph.
    const match = clips.find(c => lower(c).includes('gemma') && !lower(c).includes('gemma4'))
    if (match) return match
    throw new Error(`No LTX Video text encoder found. Download "gemma_3_12B_it_fp8_scaled.safetensors" from the Model Manager.`)
  }
  if (modelType === 'ltx25') {
    // Lightricks' own Gemma 4 12B with the projection LTX 2.5 needs. A plain
    // Gemma 4 file (no "ltx") is a different encoder and is not accepted.
    const match = clips.find(c => lower(c).includes('gemma4') && isLtx25File(c))
    if (match) return match
    throw new Error(`No LTX 2.5 text encoder found. Download "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors" from the Model Manager.`)
  }
  if (modelType === 'minimaxh3') {
    // Qwen3-VL 32B, tuned for H3 and shipped only under H3's own names. The
    // nvfp4 tier is the one the official templates load (15.7 GB).
    const match = clips.find(c => isMinimaxEncoder(c) && lower(c).includes('nvfp4'))
      || clips.find(c => isMinimaxEncoder(c))
    if (match) return match
    throw new Error(`No MiniMax H3 text encoder found. Download "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors" from the Model Manager.`)
  }
  if (modelType === 'mochi') {
    const match = clips.find(c => lower(c).includes('t5') && !lower(c).includes('umt5') && !lower(c).includes('oldt5'))
    if (match) return match
    throw new Error(`No Mochi text encoder found. Download "t5xxl_fp16.safetensors" from the Model Manager.`)
  }
  if (modelType === 'cosmos') {
    // Cosmos uses oldt5, NOT regular t5xxl
    const match = clips.find(c => lower(c).includes('oldt5'))
    if (match) return match
    throw new Error(`No Cosmos text encoder found. Download "oldt5_xxl_fp8_e4m3fn_scaled.safetensors" from the Model Manager.`)
  }
  if (modelType === 'cogvideo') {
    const match = clips.find(c => lower(c).includes('t5') && !lower(c).includes('umt5') && !lower(c).includes('oldt5'))
    if (match) return match
    throw new Error(`No CogVideoX text encoder found. Download "t5xxl_fp16.safetensors" from the Model Manager.`)
  }
  if (modelType === 'framepack') {
    const match = clips.find(c => lower(c).includes('llava') || (lower(c).includes('qwen') && !isMinimaxEncoder(c)))
      || clips.find(c => lower(c).includes('umt5'))
    if (match) return match
    throw new Error(`No FramePack text encoder found. Download "llava_llama3_fp8_scaled.safetensors" from the Model Manager.`)
  }
  // SDXL/SD1.5/SVD/Allegro/PyramidFlow checkpoints include CLIP — any works
  return clips[0]
}

/**
 * K2 (a user, Discord "HELP WITH MODELS"/help-18,
 * 2026-09-15/17): the Talking Character (lipsync) and Motion (animate)
 * builders hardcoded `audio_encoder_name: 'wav2vec2_large_english_fp16.
 * safetensors'` straight into AudioEncoderLoader, never checked against
 * ComfyUI's live enum. A box that doesn't have that exact file (a different
 * quant, a subfolder, or simply nothing installed) submitted it verbatim and
 * ComfyUI's /prompt validator rejected the node with "Value not in list",
 * the same failure mode Bug C already fixed for CLIPLoader, just not carried
 * over to the newer local lanes. Same no-silent-fallback rule as
 * findMatchingVAE/findMatchingCLIP: resolve against the live list, throw an
 * actionable "download <file>" message on a miss.
 */
export async function findMatchingAudioEncoder(): Promise<string> {
  const encoders = await getAudioEncoderModels()
  if (encoders.length === 0) {
    throw new Error('No audio encoder models found. Download "wav2vec2_large_english_fp16.safetensors" from the Model Manager.')
  }
  const match = encoders.find((e) => e.toLowerCase().includes('wav2vec2'))
  return match ?? encoders[0]
}

/**
 * Same fix as findMatchingAudioEncoder, for CLIPVisionLoader. FramePack
 * hardcoded `clip_name: 'sigclip_vision_patch14_384.safetensors'` unchecked;
 * resolve against the live list instead.
 */
export async function findMatchingClipVision(): Promise<string> {
  const models = await getCLIPVisionModels()
  if (models.length === 0) {
    throw new Error('No CLIP-Vision models found. Download "sigclip_vision_patch14_384.safetensors" from the Model Manager.')
  }
  const match = models.find((m) => m.toLowerCase().includes('sigclip'))
  return match ?? models[0]
}

async function findAnimateDiffModel(): Promise<string> {
  const models = await getAnimateDiffModels()
  if (models.length === 0) throw new Error('No AnimateDiff motion models found. Install them via ComfyUI Manager.')
  return models[0]
}

// ─── Workflow Submission ───

export async function submitWorkflow(workflow: ComfyApiGraph, clientId?: string): Promise<string> {
  // Every run its own output names (comfyui-graph tagOutputPrefixes).
  const payload: Record<string, unknown> = { prompt: tagOutputPrefixes(workflow, newRunTag()) }
  if (clientId) payload.client_id = clientId
  // Use localFetch (Rust proxy in Tauri, direct fetch in dev). The previous
  // direct-only fetch broke for any ComfyUI not started by LU itself —
  // `--enable-cors-header` is the LU spawn flag, but a user-run ComfyUI
  // Portable / cu126 / AMD build doesn't pass it, so the browser blocks the
  // POST during preflight and the only thing the user sees is the JS error
  // "Failed to fetch". The proxy bypasses the SOP entirely (it's a Rust HTTP
  // call, not a browser one). Bug: GH disc #35, Discord.
  const url = comfyuiUrl('/prompt')
  const res = await localFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    // /prompt only validates + enqueues and returns the prompt_id immediately —
    // it does NOT block on the render. Cap it so a wedged submit can't strand the
    // VRAM hand-off (text model stays unloaded) for the 5-min proxy default.
    timeoutMs: COMFY_SUBMIT_TIMEOUT_MS,
  })
  if (!res.ok) {
    const rawText = await res.text().catch(() => '')
    let errMsg = `HTTP ${res.status}`
    try {
      // ComfyUI's rejection body. Foreign JSON: `error` is a string on some
      // versions and an `{ message }` on others, and `node_errors` is only
      // present for a validation failure — so every read is narrowed.
      const errData: unknown = JSON.parse(rawText)
      const parts: string[] = []
      const rawErr = isRecord(errData) ? errData.error : undefined
      const topLevel = asString(rawErr) ?? (isRecord(rawErr) ? asString(rawErr.message) : undefined)
      if (topLevel) parts.push(topLevel)
      const nodeErrors = isRecord(errData) ? errData.node_errors : undefined
      if (isRecord(nodeErrors)) {
        for (const [nodeId, data] of Object.entries(nodeErrors)) {
          const errs = asRecordArray(isRecord(data) ? data.errors : undefined)
            // "Value not in list" alone names no value; the details say which
            // one ("ckpt_name: 'x.safetensors' not in [...]"). The list itself
            // can be hundreds of file names, so it is cut off.
            .map((e) => {
              const message = asString(e.message) ?? ''
              const details = asString(e.details)?.split(' not in [')[0].slice(0, 200)
              return details && message ? `${message} (${details})` : message || details || ''
            })
            .filter(Boolean)
            .join(', ') || 'unknown'
          const cls = (isRecord(data) ? asString(data.class_type) : undefined) ?? '?'
          parts.push(`Node ${nodeId} (${cls}): ${errs}`)
        }
      }
      if (parts.length > 0) errMsg = parts.join(' | ')
    } catch {
      if (rawText) errMsg = rawText.slice(0, 500)
    }
    log.error('comfyui.workflow_rejected', { errMsg, workflow: JSON.stringify(workflow).slice(0, 2000) })
    throw new Error(`ComfyUI rejected workflow: ${errMsg}`)
  }
  const data: unknown = await res.json()
  const promptId = isRecord(data) ? asString(data.prompt_id) : undefined
  if (!promptId) throw new Error('ComfyUI accepted the workflow but returned no prompt_id.')
  return promptId
}

export async function cancelGeneration(): Promise<void> {
  try {
    await localFetch(comfyuiUrl('/interrupt'), { method: 'POST', timeoutMs: COMFY_STATS_TIMEOUT_MS })
  } catch { /* best effort */ }
}

/**
 * Clear ComfyUI's PENDING queue (2026-06-16). /interrupt only stops the
 * job that is currently executing; anything still queued (e.g. a duplicate that
 * slipped in, or a second gen the model emitted) would start the instant the
 * running one ends. On a user "Stop" we want EVERYTHING gone, so we clear the
 * queue too. Best-effort — a failure here must never block the cancel path.
 */
export async function clearComfyQueue(): Promise<void> {
  try {
    await localFetch(comfyuiUrl('/queue'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear: true }),
      timeoutMs: COMFY_STATS_TIMEOUT_MS,
    })
  } catch { /* best effort */ }
}

/**
 * Abandon ONE prompt without touching anyone else's work (G19-1). A blanket
 * /interrupt kills whatever is CURRENTLY executing, which is the wrong job
 * whenever ours still sits in the pending queue (R32: our render was number 4
 * in line). So: delete ours from pending first, then interrupt only if ours is
 * the one running. Best-effort on every leg.
 */
export async function abandonPrompt(promptId: string): Promise<void> {
  try {
    await localFetch(comfyuiUrl('/queue'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
      timeoutMs: COMFY_STATS_TIMEOUT_MS,
    })
  } catch { /* best effort */ }
  try {
    const res = await localFetch(comfyuiUrl('/queue'), { timeoutMs: COMFY_STATS_TIMEOUT_MS })
    if (!res.ok) return
    const q = await res.json()
    const running = Array.isArray(q.queue_running)
      && q.queue_running.some((e: unknown) => Array.isArray(e) && e[1] === promptId)
    if (running) await cancelGeneration()
  } catch { /* best effort */ }
}

/**
 * Clean up jobs a DEAD LU session left in ComfyUI (G19-3): a killed app cannot
 * cancel its render, so the job keeps burning the GPU with no owner and every
 * new generation queues behind it (R32 sat at queue position 4). Every LU
 * submission carries an `lu-` client id; anything wearing that prefix under a
 * DIFFERENT id than ours belongs to a session that no longer exists. Pending
 * orphans are deleted, a running orphan is interrupted. Foreign clients (a
 * user's own ComfyUI tab) never carry the prefix and are never touched.
 * Returns how many jobs were cleaned, 0 on any error (best effort).
 */
export async function sweepOrphanedLuJobs(currentClientId: string): Promise<number> {
  try {
    const res = await localFetch(comfyuiUrl('/queue'), { timeoutMs: COMFY_STATS_TIMEOUT_MS })
    if (!res.ok) return 0
    const q = await res.json()
    // Queue entries are [number, prompt_id, prompt, extra_data, ...] tuples.
    const staleId = (e: unknown): string | null => {
      if (!Array.isArray(e) || typeof e[1] !== 'string') return null
      const owner = (e[3] as Record<string, unknown> | undefined)?.client_id
      return typeof owner === 'string' && owner.startsWith(LU_CLIENT_PREFIX) && owner !== currentClientId
        ? e[1]
        : null
    }
    const pending = (Array.isArray(q.queue_pending) ? q.queue_pending : [])
      .map(staleId)
      .filter((id: string | null): id is string => id !== null)
    if (pending.length > 0) {
      await localFetch(comfyuiUrl('/queue'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: pending }),
        timeoutMs: COMFY_STATS_TIMEOUT_MS,
      })
    }
    const runningStale = (Array.isArray(q.queue_running) ? q.queue_running : []).some((e: unknown) => staleId(e) !== null)
    if (runningStale) await cancelGeneration()
    const cleaned = pending.length + (runningStale ? 1 : 0)
    if (cleaned > 0) log.info('comfyui.orphan_sweep', { cleaned, pending: pending.length, runningStale })
    return cleaned
  } catch {
    return 0
  }
}

export async function freeMemory(): Promise<void> {
  try {
    await localFetch(comfyuiUrl('/free'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      // Bounded: this runs in the hand-off's `finally` right before reloading the
      // text model. A wedged /free must not delay that reload by 5 min.
      timeoutMs: COMFY_FREE_TIMEOUT_MS,
    })
  } catch { /* best effort */ }
}

export async function getHistory(promptId: string): Promise<ComfyHistoryEntry | null> {
  try {
    // localFetch routes through Rust proxy in Tauri to dodge CORS — same
    // reason as submitWorkflow above. Without this, a user-run ComfyUI
    // Portable would accept the /prompt POST but the polling /history GETs
    // would silently 0-out and the UI hangs in "generating…" forever.
    const res = await localFetch(comfyuiUrl(`/history/${promptId}`), { timeoutMs: COMFY_POLL_TIMEOUT_MS })
    if (!res.ok) return null
    const data: unknown = await res.json()
    const entry = isRecord(data) ? data[promptId] : undefined
    return isRecord(entry) ? entry : null
  } catch {
    return null
  }
}

/** Is this prompt still alive inside ComfyUI (running or pending)? Used by
 *  the generation watchdog: a slow render that is still queued is progress,
 *  not a stall — only silence from BOTH the socket and the queue aborts.
 *  Queue entries are `[number, prompt_id, ...]` tuples. */
export async function isPromptQueued(promptId: string): Promise<boolean> {
  try {
    const res = await localFetch(comfyuiUrl('/queue'), { timeoutMs: COMFY_POLL_TIMEOUT_MS })
    if (!res.ok) return false
    const q = await res.json()
    const inList = (list: unknown) => Array.isArray(list)
      && list.some((e) => Array.isArray(e) && e[1] === promptId)
    return inList(q.queue_running) || inList(q.queue_pending)
  } catch {
    return false
  }
}

// ─── Upload image to ComfyUI (for I2V models like SVD, FramePack) ───

export async function uploadImage(file: File): Promise<string> {
  // Guard: ComfyUI's /upload/image answers an opaque HTTP 400 for an empty or
  // unreadable file. Catch the empty-blob case up front with a clear message
  // (a user 2026-06-14: "Video generation failed: Failed to upload image: HTTP 400").
  if (!file || file.size === 0) {
    throw new Error('Failed to upload image: the source image is empty (0 bytes), it could not be read from ComfyUI.')
  }

  // ComfyUI saves the file under the multipart filename and opens it with PIL by
  // extension, so it 400s on a missing/extension-less/odd name. Send an explicit,
  // sanitised filename with a real image extension rather than trusting file.name
  // (a Blob-derived File can carry "" or an extension-less name).
  const safeName = ensureImageFilename(file.name, file.type)

  // Tauri (packaged): post the multipart from Rust. The raw browser fetch()
  // below was the ONLY non-proxy fetch left in the app, and it 400'd on some
  // WebView2 builds (multipart/boundary/CORS-preflight quirks;
  // 2026-06-14 "Failed to upload image: HTTP 400"). reqwest's multipart is
  // machine-independent and removes WebView2 as a variable — matching the
  // "everything via the Rust proxy" pattern (WebView2-149 finding). Dev/browser
  // keeps the direct fetch (Vite proxy / CORS-enabled ComfyUI).
  if (isTauri()) {
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()))
    let body: string
    try {
      body = await backendCall<string>('comfy_upload_image', {
        url: comfyuiUrl('/upload/image'),
        filename: safeName,
        contentType: file.type || 'image/png',
        fileBytes: bytes,
      })
    } catch (e) {
      // The Rust side rejects with "HTTP <s>: <body>" — surface ComfyUI's
      // actual reason so the dropzone error is self-explanatory.
      throw new Error(`Failed to upload image: ${e instanceof Error ? e.message : String(e)}`)
    }
    const data = JSON.parse(body)
    return data.name // ComfyUI returns { name, subfolder, type }
  }

  const formData = new FormData()
  formData.append('image', file, safeName)
  formData.append('overwrite', 'true')

  // Direct fetch — localFetch only supports string body, not FormData.
  // FormData needs multipart/form-data which fetch() sets automatically. A 400
  // here means the request reached ComfyUI and it rejected the content, so the
  // proxy/CORS is not at fault — surface ComfyUI's actual reason instead of a
  // bare status so the next failure is self-explanatory.
  const res = await fetch(comfyuiUrl('/upload/image'), {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.text()).trim() } catch { /* body empty / already consumed */ }
    throw new Error(`Failed to upload image: HTTP ${res.status}${detail ? `, ${detail.slice(0, 300)}` : ''}`)
  }
  const data = await res.json()
  return data.name // ComfyUI returns { name, subfolder, type }
}

/** Ensure a ComfyUI-friendly image filename: a sane base plus a real image
 *  extension inferred from the MIME type when the name lacks one. ComfyUI's
 *  /upload/image needs a recognisable extension to open the file with PIL. */
export function ensureImageFilename(name: string | undefined, mime: string | undefined): string {
  const base = (name || '').replace(/^.*[\\/]/, '').trim()
  if (base && /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(base)) return base
  const ext = ((m) => {
    switch ((m || '').toLowerCase()) {
      case 'image/jpeg': return 'jpg'
      case 'image/webp': return 'webp'
      case 'image/gif': return 'gif'
      case 'image/bmp': return 'bmp'
      case 'image/tiff': return 'tiff'
      default: return 'png'
    }
  })(mime)
  const stem = (base ? base.replace(/\.[^.]*$/, '') : 'lu_input') || 'lu_input'
  const safeStem = stem.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || 'lu_input'
  return `${safeStem}.${ext}`
}

/** Upload a NON-image media file (speech audio, driving video) into ComfyUI's
 *  input dir. Same /upload/image endpoint — it stores any file; LoadAudio /
 *  LoadVideo then list it by extension. The image uploader forces an image
 *  extension (PIL constraint), which would break these, so this variant keeps
 *  the file's own extension and only sanitizes the stem. */
export async function uploadMediaFile(blob: Blob, name: string): Promise<string> {
  if (!blob || blob.size === 0) {
    throw new Error('Failed to upload media: the file is empty (0 bytes).')
  }
  const base = (name || '').replace(/^.*[\\/]/, '').trim() || 'lu_media'
  const dot = base.lastIndexOf('.')
  const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || 'lu_media'
  const ext = (dot > 0 ? base.slice(dot + 1) : '').replace(/[^A-Za-z0-9]+/g, '').toLowerCase() || 'bin'
  const safeName = `${stem}.${ext}`

  if (isTauri()) {
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()))
    let body: string
    try {
      body = await backendCall<string>('comfy_upload_image', {
        url: comfyuiUrl('/upload/image'),
        filename: safeName,
        contentType: blob.type || 'application/octet-stream',
        fileBytes: bytes,
      })
    } catch (e) {
      throw new Error(`Failed to upload media: ${e instanceof Error ? e.message : String(e)}`)
    }
    const data = JSON.parse(body)
    return data.name
  }

  const formData = new FormData()
  formData.append('image', blob, safeName)
  formData.append('overwrite', 'true')
  const res = await fetch(comfyuiUrl('/upload/image'), { method: 'POST', body: formData })
  if (!res.ok) throw new Error(`Failed to upload media: HTTP ${res.status}`)
  const data = await res.json()
  return data.name
}

export function getImageUrl(filename: string, subfolder: string = '', type: string = 'output', cacheBust?: string | number): string {
  const path = `/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${type}`
  // A cache-buster is appended ONLY when an explicit, STABLE token is supplied
  // (e.g. a gallery item's immutable `createdAt`). We must never mint a fresh
  // `Date.now()` per call: that returned a different URL on every React
  // re-render, forcing the <img>/<video> to refetch mid-render — which is
  // exactly what made the media viewer flicker while zooming/panning/loading.
  // ComfyUI output filenames are unique per generation, so a per-item token is
  // sufficient to defeat any rare filename-reuse cache collision.
  return comfyuiUrl(cacheBust != null ? `${path}&t=${cacheBust}` : path)
}

/**
 * Fetch a ComfyUI /view image URL and return it base64-encoded (no data: prefix)
 * so it can be handed to a vision-capable chat model as an `images` attachment.
 * Used by the chat-agent vision feedback loop: after image_generate, the model
 * SEES the picture it made and can comment on it.
 */
export async function fetchComfyImageBase64(url: string): Promise<string> {
  // Not every generated image is a ComfyUI /view URL any more. The macOS MLX
  // lane hands the chat agent a `blob:` URL (an in-memory PNG, no server), and
  // the localhost proxy below cannot fetch one — it threw, the caller swallowed
  // it, and the vision-feedback step silently gave up. The model then described
  // the picture it had just made from the prompt alone, i.e. hallucinated it:
  // exactly the failure the provider-aware fix cured on Windows.
  if (url.startsWith('blob:') || url.startsWith('data:')) {
    const buf = await (await blobFromUrl(url)).arrayBuffer()
    return bytesToBase64(new Uint8Array(buf))
  }
  return bytesToBase64(await fetchLocalhostBytes(url))
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000 // avoid arg-count limits on String.fromCharCode
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[])
  }
  return btoa(binary)
}

// ─── Validate params ───
//
// LEGACY static bounds (steps 1-200 / frames 1-256). The chat-agent path
// (vram-handoff → buildDynamicWorkflow) now validates against REAL per-model
// limits via getModelCapabilities() in comfyui-nodes.ts and rejects-and-reports
// over-limit requests (decision 2). These hard bounds remain only for the legacy
// static workflow builders below (buildSDXLImgWorkflow / buildFluxImgWorkflow /
// buildWanVideoWorkflow); new validation must use getModelCapabilities.

function validateParams(params: GenerateParams) {
  if (!params.prompt.trim()) throw new Error('Prompt is empty')
  if (!params.model) throw new Error('No model selected')
  if (params.width < 64 || params.width > 4096) throw new Error('Width must be 64-4096')
  if (params.height < 64 || params.height > 4096) throw new Error('Height must be 64-4096')
  if (params.steps < 1 || params.steps > 200) throw new Error('Steps must be 1-200')
}

function validateVideoParams(params: VideoParams) {
  validateParams(params)
  if (params.frames < 1 || params.frames > 256) throw new Error('Frames must be 1-256')
  if (params.fps < 1 || params.fps > 60) throw new Error('FPS must be 1-60')
  // Wan requires width/height to be multiples of 16
  if (params.width % 16 !== 0) throw new Error(`Width must be a multiple of 16 (current: ${params.width})`)
  if (params.height % 16 !== 0) throw new Error(`Height must be a multiple of 16 (current: ${params.height})`)
}

function getSeed(seed: number): number {
  return resolveRunSeed(seed)
}

// ─── Snap video dimensions to valid values ───

export function snapToVideoGrid(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.round(width / 16) * 16,
    height: Math.round(height / 16) * 16,
  }
}

// ─── Image Workflow: SDXL/SD (CheckpointLoaderSimple) ───

export function buildSDXLImgWorkflow(params: GenerateParams): ComfyApiGraph {
  validateParams(params)
  const seed = getSeed(params.seed)
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: params.model } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: params.negativePrompt || '', clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: params.width, height: params.height, batch_size: params.batchSize } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
        seed, steps: params.steps, cfg: params.cfgScale,
        sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0,
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'locally_uncensored' } },
  }
}

// ─── Image Workflow: FLUX (UNETLoader + CLIPLoader + VAELoader) ───

/** UNET loader that understands GGUF quants. Core `UNETLoader` only enumerates
 *  safetensors, so handing it a .gguf gets the workflow rejected with "Value
 *  not in list" (stasicby-max, D#93 — the catalog offers uncensored Wan quants
 *  as GGUF). The city96 pack's `UnetLoaderGGUF` reads them. Same rule as the
 *  dynamic builder's addUnetLoader; this legacy path still carries the VRAM
 *  handoff and the agent's video tool. */
async function unetLoaderNode(model: string): Promise<ComfyApiNode> {
  if (!model.toLowerCase().endsWith('.gguf')) {
    return { class_type: 'UNETLoader', inputs: { unet_name: model, weight_dtype: 'default' } }
  }
  if (!(await nodeExists('UnetLoaderGGUF'))) {
    throw new Error(
      'This model is a GGUF quant, which needs the ComfyUI-GGUF node pack. Install it from the model card, or pick the safetensors variant.',
    )
  }
  return { class_type: 'UnetLoaderGGUF', inputs: { unet_name: model } }
}

export async function buildFluxImgWorkflow(params: GenerateParams): Promise<ComfyApiGraph> {
  validateParams(params)
  const seed = getSeed(params.seed)
  const modelType = classifyModel(params.model)
  const vae = await findMatchingVAE(modelType)
  const clip = await findMatchingCLIP(modelType)
  const clipType = modelType === 'flux2' ? 'flux2' : 'flux'

  const latentNode = modelType === 'flux2' ? 'EmptyFlux2LatentImage' : 'EmptySD3LatentImage'

  return {
    '1': await unetLoaderNode(params.model),
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: clipType, device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: vae } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } },
    '6': { class_type: latentNode, inputs: { width: params.width, height: params.height, batch_size: params.batchSize } },
    '7': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0],
        seed, steps: params.steps, cfg: params.cfgScale,
        sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0,
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'locally_uncensored' } },
  }
}

// ─── Auto-select Image Workflow ───

/** The fixed graphs below know four image families and two video ones. Any
 *  other family handed to them becomes a checkpoint or Wan 2.1 graph that
 *  ComfyUI refuses with "Value not in list" (Discord 2026-10-01, Qwen-Image
 *  2.1 and MiniMax H3), so the caller keeps the builder's own error instead. */
export function legacyBuilderFits(modelType: ModelType, video: boolean): boolean {
  if (video) return modelType === 'wan' || modelType === 'animatediff' || modelType === 'sd15'
  return modelType === 'sd15' || modelType === 'sdxl' || modelType === 'flux' || modelType === 'flux2' || modelType === 'unknown'
}

export async function buildTxt2ImgWorkflow(params: GenerateParams, modelType: ModelType): Promise<ComfyApiGraph> {
  if (modelType === 'flux' || modelType === 'flux2') return buildFluxImgWorkflow(params)
  return buildSDXLImgWorkflow(params)
}

// ─── Video Workflow: Wan 2.1/2.2 (Hunyuan latent space) ───

export async function buildWanVideoWorkflow(params: VideoParams): Promise<ComfyApiGraph> {
  validateVideoParams(params)
  const seed = getSeed(params.seed)

  // Pre-check required nodes
  const hasLatent = await nodeExists('EmptyHunyuanLatentVideo')
  if (!hasLatent) throw new Error('EmptyHunyuanLatentVideo node not found. Update ComfyUI to latest version.')
  const hasSaver = await videoSaverPresence()

  const vae = await findMatchingVAE('wan')
  const clip = await findMatchingCLIP('wan')
  const hasTiledDecode = await nodeExists('VAEDecodeTiled')

  const workflow: ComfyApiGraph = {
    '1': { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: 'wan', device: 'default' } },
    '2': await unetLoaderNode(params.model),
    '3': { class_type: 'VAELoader', inputs: { vae_name: vae } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: ['1', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: params.negativePrompt || 'static, blurred, low quality, worst quality, deformed', clip: ['1', 0] } },
    '6': { class_type: 'EmptyHunyuanLatentVideo', inputs: { width: params.width, height: params.height, length: params.frames, batch_size: 1 } },
    '7': {
      class_type: 'KSampler',
      inputs: {
        model: ['2', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0],
        seed, steps: params.steps, cfg: params.cfgScale,
        sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0,
      },
    },
    '8': videoDecodeNode(['7', 0], ['3', 0], hasTiledDecode),
  }

  // An mp4 the chat player and the gallery can play (A19): this path wrote a
  // fixed SaveAnimatedWEBP, so Wan 2.1 in the chat came back as an animated
  // picture without controls. Prompt-based prefix (2026-06-11) — the dynamic
  // builder got this in c40d13f, this legacy T2V path still wrote
  // locally_uncensored_vid.
  addVideoSave(workflow, 9, ['8', 0], params.fps, promptFilenamePrefix(params.prompt, true), hasSaver)

  return workflow
}

// ─── Video Workflow: AnimateDiff ───

export async function buildAnimateDiffWorkflow(params: VideoParams): Promise<ComfyApiGraph> {
  validateVideoParams(params)
  const seed = getSeed(params.seed)
  const motionModel = await findAnimateDiffModel()

  // AnimateDiff: batch_size=1, motion model handles temporal dimension
  const hasSaver = await videoSaverPresence()
  const hasTiledDecode = await nodeExists('VAEDecodeTiled')

  const workflow: ComfyApiGraph = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: params.model } },
    '2': { class_type: 'ADE_LoadAnimateDiffModel', inputs: { model_name: motionModel } },
    '3': { class_type: 'ADE_ApplyAnimateDiffModelSimple', inputs: { motion_model: ['2', 0] } },
    '4': { class_type: 'ADE_UseEvolvedSampling', inputs: { model: ['1', 0], m_models: ['3', 0], beta_schedule: 'autoselect' } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: ['1', 1] } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: params.negativePrompt || 'low quality, blurry, static', clip: ['1', 1] } },
    '7': { class_type: 'EmptyLatentImage', inputs: { width: params.width, height: params.height, batch_size: params.frames } },
    '8': {
      class_type: 'KSampler',
      inputs: {
        model: ['4', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['7', 0],
        seed, steps: params.steps, cfg: params.cfgScale,
        sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0,
      },
    },
    '9': videoDecodeNode(['8', 0], ['1', 2], hasTiledDecode),
  }

  // Core SaveVideo or VHS (both MP4), otherwise SaveAnimatedWEBP, otherwise SaveImage (A19)
  addVideoSave(workflow, 10, ['9', 0], params.fps, 'locally_uncensored_vid', hasSaver)

  return workflow
}

// ─── Auto-select Video Workflow ───

export async function buildTxt2VidWorkflow(params: VideoParams, backend: VideoBackend): Promise<ComfyApiGraph> {
  switch (backend) {
    case 'wan': return buildWanVideoWorkflow(params)
    case 'animatediff': return buildAnimateDiffWorkflow(params)
    default: throw new Error('No video backend available. Install Wan 2.1 models or AnimateDiff nodes in ComfyUI.')
  }
}
