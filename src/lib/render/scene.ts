// Scene to Video (web 16.11.2026, desktop 3.1.3): a grey 3D blockout with a
// camera move becomes a finished clip. The customer uploads the scene video (from Blender or any
// other 3D tool), may design the first frame with an image editor, and a video
// editing model renders the look while layout, camera and timing come from
// the video.
//
// The models and their order live in ONE place: the role `scene` in
// preset-models.ts (SCENE_ROLE_MODELS). This file holds the rules over them, for
// the browser and for the server alike: how long a clip may be, which fields
// the run sets itself, which words go to which model, and the first frame
// step. No React and no store here.
//
// Desktop: the cloud part is the web's file as it stands on the live web
// (8c6c76de), so both clients send the same run. The local part at the end
// (Wan 2.1 VACE in ComfyUI) is the desktop's own.

import { STUDIO_MODELS, studioFields, studioPreviewCredits } from './studio-contract'
import { SCENE_ROLE_MODELS } from './preset-models'
import { formatBytes } from '../formatters'

/** The tab, as the bar and the gallery name it. */
export const SCENE_NAME = 'Scene to Video'

/** The models of the role, recommended first. The list itself stands in the
 *  role (preset-models.ts, SCENE_ROLE_MODELS): order and default are kept
 *  there and nowhere else. */
export const SCENE_MODELS: readonly string[] = SCENE_ROLE_MODELS

/** The model a new Scene to Video run starts on. */
export const SCENE_DEFAULT_MODEL = SCENE_MODELS[0]

export function isSceneModel(id: string | null | undefined): boolean {
  return !!id && SCENE_MODELS.includes(id)
}

const VACE = 'wan-2.1-vace'
const ALEPH = 'aleph-2'
const FLUX = 'flux-3-video-edit'

// ── Length, size and format ──────────────────────────────────────────────
// A scene runs 2 to 10 seconds. A longer clip is cut to its first 10 seconds
// on the server (studio-prepare.ts), a shorter one is refused before anything
// is booked. The browser shows the same rule before the start.

export const SCENE_MIN_SECONDS = 2
export const SCENE_MAX_SECONDS = 10

/** The largest scene video a model takes, in bytes, where it is below the
 *  20 MB every upload may have. Aleph 2 takes less than 16 MB (its schema). */
export function sceneMaxBytes(model: string): number | undefined {
  return model === ALEPH ? 16 * 1024 * 1024 : undefined
}

/** The seconds that run: the clip up to 10 seconds. */
export function sceneClipSeconds(seconds: number): number {
  return Math.min(seconds, SCENE_MAX_SECONDS)
}

/** What is wrong with the length of this clip, or null. The same sentence in
 *  the browser and on the server. */
export function sceneLengthProblem(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return null
  if (seconds < SCENE_MIN_SECONDS) return `Your scene video is ${seconds.toFixed(1)} seconds long. Use a clip of 2 to 10 seconds.`
  return null
}

/** The sentence for a scene video over the size a model takes, or null. */
export function sceneSizeProblem(model: string, bytes: number): string | null {
  const max = sceneMaxBytes(model)
  if (!max || bytes < max) return null
  // Desktop: the size in words comes from formatters.ts, the one place that
  // turns bytes into text (lib/__tests__/eine-regel-fuer-bytes.test.ts). The
  // sentence is the web's.
  return `This model takes scene videos under ${formatBytes(max).replace('.0 ', ' ')}. Yours is ${formatBytes(bytes)}. Shorten or compress it, or pick another model.`
}

/** The sentence for a file type a model does not read, or null. FLUX 3 Video
 *  Edit reads MP4 only (its schema). `name` is the file name or the path. */
export function sceneFormatProblem(model: string, name: string): string | null {
  if (model !== FLUX || /\.mp4$/i.test(name)) return null
  return 'This model reads MP4 only. Export the scene as MP4 or pick another model.'
}

/** Does this model read a first frame at all? */
export function sceneReadsFrame(model: string): boolean {
  return Object.values(STUDIO_MODELS[model]?.inputs ?? {}).some((key) => key === 'source_path' || key === 'image_paths')
}

// ── Fields the run sets itself ───────────────────────────────────────────

/** The output length a model with a length field gets for a clip of this many
 *  seconds, as close to the clip as the model allows (VACE: 5 to 10 whole
 *  seconds). Every other scene model follows the input by itself. */
export function sceneOutputSeconds(model: string, seconds: number): number | undefined {
  const m = STUDIO_MODELS[model]
  if (!m || m.price.mode !== 'output') return undefined
  const field = studioFields(model)[m.price.durationField ?? 'duration']
  if (!field) return undefined
  const want = Math.round(sceneClipSeconds(seconds))
  if (field.enum) {
    const choices = field.enum.filter((v): v is number => typeof v === 'number').sort((a, b) => a - b)
    if (!choices.length) return undefined
    // The longest choice that does not run past the clip, else the shortest.
    return [...choices].reverse().find((v) => v <= want) ?? choices[0]
  }
  const lo = field.minimum ?? 1, hi = field.maximum ?? SCENE_MAX_SECONDS
  return Math.min(hi, Math.max(lo, want))
}

/** The VACE size for a clip of this shape: 720p, upright or wide like the
 *  clip. A square clip renders wide. */
export function sceneVaceSize(width?: number, height?: number): string {
  return width && height && height > width ? '720*1280' : '1280*720'
}

export interface SceneClip { seconds?: number; width?: number; height?: number }

/** The options a scene run sets itself, from the clip and whether a first
 *  frame goes along. They win over the customer's own settings, which is why
 *  the settings do not show them (scenePanelFields). */
export function sceneFixedOptions(model: string, clip: SceneClip, withFrame: boolean): Record<string, unknown> {
  if (!isSceneModel(model)) return {}
  const out: Record<string, unknown> = {}
  const m = STUDIO_MODELS[model]
  if (clip.seconds !== undefined && Number.isFinite(clip.seconds) && clip.seconds > 0) {
    const duration = sceneOutputSeconds(model, clip.seconds)
    if (duration !== undefined) out[m?.price.durationField ?? 'duration'] = duration
  }
  if (model === VACE && clip.width && clip.height) out.size = sceneVaceSize(clip.width, clip.height)
  // Aleph 2: one position per keyframe picture; the first frame sits first.
  if (model === ALEPH) out.keyframe_positions = withFrame ? ['first'] : []
  return out
}

/** Fields the scene run owns and the settings leave out. */
export function scenePanelFields(model: string): string[] {
  return isSceneModel(model) ? ['duration', 'size', 'keyframe_positions'] : []
}

// ── Structure control: what a template sets ──────────────────────────────

export type SceneControl = 'depth' | 'pose'

/** A template's control and strength, written into the fields of this
 *  model. Only VACE has such fields (task, context_scale); the video editors
 *  keep the structure on their own. */
export function sceneControlOptions(model: string, control: SceneControl, strength: number): Record<string, unknown> {
  if (model !== VACE) return {}
  const scale = studioFields(model).context_scale
  return {
    task: control,
    ...(scale ? { context_scale: Math.min(scale.maximum ?? strength, Math.max(scale.minimum ?? strength, strength)) } : {}),
  }
}

// ── Words ─────────────────────────────────────────────────────────────────

/** The sentence every video editor gets after the look. */
const KEEP_MOTION = 'Keep the camera movement, the timing, the framing and the position of every object from the video.'

/** The prompt of a scene run on this model. The look is the customer's own
 *  text; a video editor is told to keep the camera, and one that gets the
 *  first frame as a reference picture is told what it is. VACE holds the
 *  structure through depth and reads the look alone. */
export function scenePrompt(model: string, look: string, withFrame: boolean): string {
  const own = look.trim()
  if (!isSceneModel(model) || model === VACE) return look
  return [own, withFrame && model !== ALEPH ? 'The reference image shows the first frame.' : '', KEEP_MOTION].filter(Boolean).join(' ')
}

// ── The first frame (optional, off unless the customer starts it) ───────
// Test runs of 16.11.2026: a reference image that is not exactly the clip's
// real first frame makes every model start from the image and then jump to
// the layout. So no picture goes along unless the customer sets his own
// first frame on the stage: generated from the real first frame with the
// prompt, or uploaded; it stands in the slot of the taken frame, where he
// sees it next to the scene.

// "Generate from prompt" must keep the layout of the grey frame: the same
// wall, the same perspective. The editor and the fixed restyle addition are
// the two values that decide it, and they stand here and nowhere else. The
// prompt is the customer's words plus the addition. (The live mode of the
// local stack reads SCENE_FRAME_MODEL from this line by its plain form.)

/** The editor the first frame step runs on. GPT Image 2 Edit won the test of
 *  16.11.2026 on the grey wall frame against Nano Banana Pro, Seedream 5,
 *  Qwen 3 and FLUX.2 Max: it kept the wall, the perspective and the floor
 *  line and had the look; Nano Banana Pro drifted the most. */
export const SCENE_FRAME_MODEL = 'gpt-image-2-edit'

/** Fixed after the customer's words, whatever they say. */
export const SCENE_FRAME_SUFFIX = 'Restyle this exact frame. Keep the composition, camera, perspective and every object position exactly as they are. Only change materials, lighting and style. Do not add, remove or move anything.'

/** The prompt of the first frame step: the customer's words plus the fixed
 *  restyle addition. */
export function sceneFramePrompt(look: string): string {
  const own = look.trim().replace(/[.\s]+$/, '')
  return `${own}. ${SCENE_FRAME_SUFFIX}`
}

const ASPECTS = (model: string): string[] => {
  const field = studioFields(model).aspect_ratio
  return (field?.enum ?? []).filter((a): a is string => typeof a === 'string' && /^\d+:\d+$/.test(a))
}

function nearestAspect(list: readonly string[], width: number, height: number): string | undefined {
  if (!list.length) return undefined
  if (!(width > 0) || !(height > 0)) return list.includes('16:9') ? '16:9' : list[0]
  const want = Math.log(width / height)
  let best = list[0], gap = Infinity
  for (const a of list) {
    const [w, h] = a.split(':').map(Number)
    const d = Math.abs(Math.log(w / h) - want)
    if (d < gap - 1e-9) { best = a; gap = d }
  }
  return best
}

/** The options of the first frame step on this editor, only with fields its
 *  schema knows: the clip's shape, 2k where it costs the same as 1k, else 1k,
 *  medium quality where the editor has a quality (GPT Image 2: about 0.07 $),
 *  and JPEG. */
export function sceneFrameOptions(model: string, width: number, height: number): Record<string, unknown> {
  const fields = studioFields(model)
  const out: Record<string, unknown> = {}
  const aspect = nearestAspect(ASPECTS(model), width, height)
  if (aspect) out.aspect_ratio = aspect
  const resolutions = fields.resolution?.enum?.map(String) ?? []
  if (resolutions.length) {
    const rates = STUDIO_MODELS[model].price.rates
    const sameAs1k = resolutions.includes('2k') && rates['2k'] !== undefined && rates['2k'] === rates['1k']
    out.resolution = sameAs1k ? '2k' : resolutions.includes('1k') ? '1k' : resolutions[0]
  }
  if (fields.quality?.enum?.includes('medium')) out.quality = 'medium'
  if (fields.output_format?.enum?.includes('jpeg')) out.output_format = 'jpeg'
  return out
}

/** What the first frame step costs on this editor, or null. */
export function sceneFrameCredits(model: string, width: number, height: number): number | null {
  return studioPreviewCredits(model, sceneFrameOptions(model, width, height), undefined, 1)
}

// ── Looks and styles ─────────────────────────────────────────────────────
// Two lists at the end of the settings (David 18.11.2026): the look says what
// the scene shows, the style how it is drawn or filmed. Each is a dropdown;
// picking one writes the prompt from both, which the customer may then edit.

export interface SceneTemplate {
  id: string
  /** The name in the list and one word for what it shows; the summary is the
   *  line under the list. */
  title: string
  summary: string
  word: string
  prompt: string
  model: string
  control: SceneControl
  strength: number
}

export const SCENE_TEMPLATES: readonly SceneTemplate[] = [
  {
    id: 'trend', title: 'Trend clip', summary: 'A vertical clip with a glossy city look.', word: 'City',
    prompt: 'A stylish city street at golden hour, wet asphalt with neon reflections, shallow depth of field, crisp detail',
    model: SCENE_DEFAULT_MODEL, control: 'depth', strength: 1,
  },
  {
    id: 'product', title: 'Product shot', summary: 'Clean studio light, every shape held exactly.', word: 'Studio',
    prompt: 'Glossy amber glass bottle with a gold cap on a marble pedestal, soft studio light, reflections, premium ad look',
    model: SCENE_DEFAULT_MODEL, control: 'depth', strength: 1,
  },
  {
    id: 'character', title: 'Character', summary: 'Your stand-in becomes a person.', word: 'Person',
    prompt: 'A young woman in a yellow raincoat walking through a rainy side street at night, neon signs, wet pavement',
    model: SCENE_DEFAULT_MODEL, control: 'depth', strength: 1,
  },
  {
    id: 'interior', title: 'Interior', summary: 'A lived-in room with soft window light.', word: 'Room',
    prompt: 'A cozy modern living room with wooden floors, a linen sofa and plants, soft window light',
    model: SCENE_DEFAULT_MODEL, control: 'depth', strength: 1,
  },
  {
    id: 'landscape', title: 'Landscape', summary: 'Open nature around the camera move.', word: 'Nature',
    prompt: 'A wide mountain valley with a river, pine forests and drifting clouds, early morning light',
    model: SCENE_DEFAULT_MODEL, control: 'depth', strength: 1,
  },
  {
    id: 'scifi', title: 'Sci-fi', summary: 'A spaceship or future city on your layout.', word: 'Future',
    prompt: 'A clean futuristic spaceship corridor with glowing panels, brushed metal and soft blue light',
    model: SCENE_DEFAULT_MODEL, control: 'depth', strength: 1,
  },
]

export interface SceneStyleDef { id: string; label: string; text: string }

/** Common, plainly named styles, the way people search for them. */
export const SCENE_STYLES: readonly SceneStyleDef[] = [
  { id: 'photoreal', label: 'Photoreal', text: 'photorealistic, natural light, realistic materials and textures' },
  { id: 'cinematic', label: 'Cinematic', text: 'cinematic film look, anamorphic lens, dramatic lighting, color graded' },
  { id: 'film', label: '35mm film', text: '35mm film still, fine grain, natural colors' },
  { id: 'bw', label: 'Black and white', text: 'black and white photography, rich contrast, fine grain' },
  { id: 'noir', label: 'Film noir', text: 'film noir, hard shadows, high contrast black and white, 1940s mood' },
  { id: 'vintage', label: 'Vintage', text: 'vintage 1970s film look, warm faded colors, soft grain' },
  { id: 'documentary', label: 'Documentary', text: 'documentary look, handheld feel, available light, true to life' },
  { id: 'anime', label: 'Anime', text: 'hand-drawn anime style, clean line art, cel shading, vivid colors, painted backgrounds' },
  { id: 'cartoon', label: 'Cartoon', text: '2D cartoon style, bold outlines, flat bright colors' },
  { id: '3d-animation', label: '3D animation', text: 'stylized 3D animated film look, soft shading, expressive shapes, bright colors' },
  { id: 'claymation', label: 'Claymation', text: 'claymation, handmade clay models, stop-motion look, soft daylight' },
  { id: 'comic', label: 'Comic book', text: 'comic book style, inked outlines, halftone shading, bold colors' },
  { id: 'watercolor', label: 'Watercolor', text: 'watercolor painting, soft washes, visible paper texture' },
  { id: 'oil', label: 'Oil painting', text: 'oil painting, visible brush strokes, rich colors' },
  { id: 'sketch', label: 'Pencil sketch', text: 'pencil sketch, graphite lines, cross hatching on paper' },
  { id: 'pixel', label: 'Pixel art', text: 'pixel art, limited palette, crisp square pixels' },
  { id: 'low-poly', label: 'Low poly', text: 'low poly 3D look, flat shaded facets, clean colors' },
  { id: 'cyberpunk', label: 'Cyberpunk', text: 'cyberpunk look, neon lights, rain, high contrast night colors' },
]

/** The prompt of a look and a style; either may be left out. */
export function sceneLookPrompt(lookId: string | null, styleId: string | null): string {
  const look = SCENE_TEMPLATES.find((t) => t.id === lookId)
  const style = SCENE_STYLES.find((s) => s.id === styleId)
  return [look?.prompt, style?.text].filter(Boolean).join(', ')
}

// ── Before the start ─────────────────────────────────────────────────────

export interface SceneCheck {
  model: string
  prompt: string
  hasVideo: boolean
  seconds?: number
  bytes?: number
  /** The file name of the scene video. */
  name?: string
}

/** What stops this scene run before anything is uploaded, or null. */
export function sceneProblem(c: SceneCheck): string | null {
  if (!c.hasVideo) return 'Add your scene video first.'
  const length = sceneLengthProblem(c.seconds)
  if (length) return length
  if (c.name !== undefined) {
    const format = sceneFormatProblem(c.model, c.name)
    if (format) return format
  }
  if (c.bytes !== undefined) {
    const size = sceneSizeProblem(c.model, c.bytes)
    if (size) return size
  }
  if (!c.prompt.trim()) return 'Describe the look of your scene.'
  return null
}

// ── The local lane (desktop 3.1.3) ───────────────────────────────────────
// On Windows and Linux the scene runs in the customer's own ComfyUI: Wan 2.1
// VACE, the model the cloud list carries as "Wan 2.1 VACE" and whose
// strength is holding every shape through depth. The app draws a depth video
// of the scene (Depth Anything V2 Small, comfyui_controlnet_aux) and VACE
// paints the look over it; an own first frame goes in as the opening frame
// of the control video (buildSceneWorkflow, api/dynamic-workflow.ts).
//
// Why VACE and not Wan 2.2 Animate: Animate moves a character after a pose
// skeleton, it has no input for the depth of a room. VACE was trained on
// depth from Depth Anything, so a depth video of a grey blockout is exactly
// what it reads. The 1.3B file runs from 8 GB VRAM and is the one Motion
// Control already installs. A Mac has no ComfyUI: there the tab runs on LU
// Cloud (intents.ts).

/** VACE renders at 16 frames a second. */
export const SCENE_LOCAL_FPS = 16

/** The longest stretch of the scene a local run renders, in seconds: 81
 *  frames, what Wan 2.1 VACE was trained on. A longer clip renders its first
 *  five seconds, and the stage says so before the start. */
export const SCENE_LOCAL_MAX_SECONDS = 5

/** The frame count of a local run for a clip of this many seconds: a Wan
 *  length (4n+1), at most 81 and never more than the clip has. */
export function sceneLocalFrames(seconds: number | undefined): number {
  const s = seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? seconds : SCENE_LOCAL_MAX_SECONDS
  // Down to the grid, never past the end of the clip: a control video shorter
  // than the run is padded with grey frames, and VACE paints grey there.
  const want = Math.min(s * SCENE_LOCAL_FPS, 81)
  const n = Math.floor((want - 1) / 4) * 4 + 1
  return Math.min(81, Math.max(17, n))
}

/** The size of a local run: VACE 1.3B is a 480p model. Wide clips render at
 *  832x480, upright ones at 480x832, square ones at 624x624. */
export function sceneLocalSize(width?: number, height?: number): { width: number; height: number } {
  if (!width || !height) return { width: 832, height: 480 }
  const r = width / height
  if (r > 1.15) return { width: 832, height: 480 }
  if (r < 1 / 1.15) return { width: 480, height: 832 }
  return { width: 624, height: 624 }
}

/** The line under the scene when a local run renders less than the clip. */
export function sceneLocalTrimNote(seconds: number | undefined): string | null {
  if (seconds === undefined || !(seconds > SCENE_LOCAL_MAX_SECONDS + 0.05)) return null
  return `Longer than ${SCENE_LOCAL_MAX_SECONDS} s: your PC renders the first ${SCENE_LOCAL_MAX_SECONDS} s.`
}

/** What stops a local scene run before anything is uploaded, or null. */
export function sceneLocalProblem(c: { hasVideo: boolean; seconds?: number; prompt: string }): string | null {
  if (!c.hasVideo) return 'Add your scene video first.'
  const length = sceneLengthProblem(c.seconds)
  if (length) return length
  if (!c.prompt.trim()) return 'Describe the look of your scene.'
  return null
}
