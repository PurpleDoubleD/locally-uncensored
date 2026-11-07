// Which models a preset step may run on.
//
// A preset names one model per step, but the step is a job, not a model: any
// endpoint that eats the same inputs and returns the same kind does that job.
// 19.09.2026, Entscheid des Inhabers: the customer picks. So every step carries a
// role, and the role, not the preset, decides the choices.
//
// The lists below are declared, not guessed. A role is only useful when every
// member really runs: same inputs, same output kind, a price on both sides.
// The contract test walks each one and refuses a member that cannot.

import { STUDIO_MODELS, studioSchema, type ModelTier, type ModelWeights } from './studio-contract'
import { cloudModelById, cloudModelsFor, i2vModels, runCredits, studioEntries, t2vModels } from '../../stores/cloudCatalogStore'
import {
  STUDIO_EDIT_MODELS, studioImageToVideo, studioReferenceVideo, studioTextToVideo,
} from './studio-roles'
import type { RenderKind, RenderOp } from './cloud-jobs'
import { SWAP_MODELS } from './swap'

export type StepRole =
  | 'image' | 'animate' | 'soundtrack' | 'speech' | 'music' | 'talking' | 'presenter'
  | 'duo' | 'extend' | 'motion' | 'restyle' | 'angles' | 'edit' | 'upscale'
  // 02.10.2026: Text zu Video, Referenz zu Video.
  | 'video' | 'reference'
  // 07.11.2026: Swap Character (lib/render/swap.ts).
  | 'swap-character'

export interface PresetModel {
  id: string
  label: string
  kind: RenderKind
  op: RenderOp
  adult: boolean
  /** Stufe und Herkunft aus dem Katalog des Servers. Ein aelterer Server liefert
   *  sie nicht: dann bleiben beide leer und der Waehler stellt das Modell
   *  neutral dar (model-tier.ts). */
  tier?: ModelTier
  weights?: ModelWeights
}

/** The op a NON-studio member of this role runs under. Studio members always
 *  run under 'studio' and carry their own schema. */
const ROLE_OP: Record<StepRole, RenderOp> = {
  image: 'generate', animate: 'animate', soundtrack: 'studio', speech: 'tts',
  music: 'music', talking: 'lipsync', presenter: 'studio', duo: 'studio',
  extend: 'extend', motion: 'motion', restyle: 'studio', angles: 'studio',
  edit: 'edit', upscale: 'upscale',
  video: 'generate', reference: 'studio',
  'swap-character': 'studio',
}

/** The staged inputs a NON-studio member consumes, as provider field -> job
 *  param. Studio members bring their own map in the registry. */
export const ROLE_INPUTS: Record<StepRole, Record<string, string>> = {
  image: {}, speech: {}, music: {}, extend: {}, soundtrack: {}, duo: {},
  presenter: {}, restyle: {}, angles: {},
  animate: { image: 'source_path' },
  talking: { image: 'source_path', audio: 'audio_path' },
  motion: { image: 'source_path', video: 'video_path' },
  edit: { image: 'source_path' },
  upscale: { video: 'video_path' },
  video: {}, reference: {},
  'swap-character': {},
}

function studioIds(match: (id: string) => boolean): string[] {
  return Object.keys(STUDIO_MODELS).filter(match)
}

const ROLE_MEMBERS: Record<StepRole, () => string[]> = {
  // Text to image: everything in the Image picker, plus the three studio
  // twins of the open bases, which price live instead of from our table.
  image: () => [
    ...studioIds((id) => STUDIO_MODELS[id].kind === 'image' && !Object.keys(STUDIO_MODELS[id].inputs).length),
    ...cloudModelsFor('image').map((m) => m.id),
  ],
  // Image to video: a still goes in, a clip comes out. Nothing else required.
  animate: () => [
    ...studioImageToVideo(),
    ...i2vModels().map((m) => m.id),
  ],
  // Text to video: words in, a clip out. Nothing to upload.
  video: () => [
    ...studioTextToVideo(),
    ...t2vModels().map((m) => m.id),
  ],
  // Reference to video: one or more pictures say who is in the clip.
  reference: () => studioReferenceVideo(),
  // A clip goes in, the same clip with sound comes out.
  soundtrack: () => ['mmaudio-v2', 'hunyuan-video-foley'],
  // Text to speech. Clone adds a reference recording, design a description.
  speech: () => [
    'preset-qwen3-tts', 'qwen3-tts', 'qwen3-tts-clone', 'qwen3-tts-design',
    'seed-speech-tts', 'minimax-speech-turbo', 'minimax-speech-hd', 'inworld-tts',
    'eleven-v3', 'chatterbox-tts',
  ],
  // Words in, a finished track out. ACE-Step is ours and cheap, the three new
  // ones are what a released song sounds like.
  music: () => ['ace-step', 'ace-step-1.5', 'sonilo-music', 'minimax-music', 'mureka-song', 'eleven-music'],
  // A portrait plus one voice track becomes a speaking clip. The re-sync
  // models (latentsync, lipsync-2) need an existing clip and are a different
  // job, so they are not interchangeable here.
  talking: () => [
    'infinitetalk', 'infinitetalk-fast', 'p-video-avatar',
    'longcat-avatar', 'lipsync-3-avatar', 'seedance-2.5-avatar',
  ],
  // No portrait of your own: the provider's own presenter reads the track.
  presenter: () => ['heygen-twin'],
  // Two voice tracks on one image. Only one endpoint does this.
  duo: () => ['infinitetalk-multi', 'longcat-avatar-multi'],
  extend: () => [
    'preset-wan-2.2-spicy-extend', 'wan-2.2-spicy-extend', 'ltx-2-extend', 'pixverse-extend',
    'wan-3.0-extend', 'seedance-2.5-extend',
  ],
  // Movement from a driving clip onto a character image.
  motion: () => ['scail-2', 'wan-2.2-animate-2', 'wan-2.2-animate', 'steady-dancer', 'p-video-animate', 'dreamactor-v2'],
  // A clip goes in, the same clip comes back changed. Wan DITTO picks a style
  // from a list, MiniMax H3 follows a sentence.
  restyle: () => ['wan-ditto', 'minimax-h3-video-edit'],
  angles: () => ['qwen-image-angles'],
  // Instruction edits, no mask. flux-dev is excluded: it demands one.
  edit: () => [...STUDIO_EDIT_MODELS, 'qwen-image-edit'],
  // A finished clip goes in, the same clip at more pixels comes out.
  upscale: () => ['video-upscaler', 'flashvsr', 'video-upscaler-pro', 'ultimate-video-upscaler', 'crystal-upscaler', 'flux-3-upscale'],
  // A real video stays, its people become the customer's (lib/render/swap.ts).
  // The one role that shares a model with another (SCAIL 2, see SWAP_ROLES).
  'swap-character': () => [...SWAP_MODELS],
}

/** Classic ids that a studio entry already covers on the same endpoint. The
 *  studio twin wins: it validates against the provider schema and books a
 *  price the provider confirmed. The customer keeps seeing the catalog name. */
const SUPERSEDED = new Map<string, string>(
  Object.entries(STUDIO_MODELS)
    .filter(([, m]) => m.sourceModel)
    .map(([id, m]) => [m.sourceModel as string, id]),
)

/** Fuehrt der lebende Katalog dieses Modell als Studio-Eintrag? */
function studioKnown(id: string): boolean {
  return studioEntries([id]).length > 0
}

function entry(id: string, role: StepRole): PresetModel | null {
  const studio = STUDIO_MODELS[id]
  const catalog = cloudModelById(studio?.sourceModel ?? id)
  const kind = studio?.kind ?? catalog?.kind
  if (!kind) return null
  // Stufe und Herkunft stammen aus dem Katalog des Servers, bei einem Zwilling
  // zuerst von seinem eigenen Eintrag, dann vom klassischen Bruder. Fehlen sie
  // (aelterer Server), bleibt das Modell neutral.
  const own = studio ? cloudModelById(id) : catalog
  return {
    id,
    // The name the customer already knows from the Create picker.
    label: catalog?.label ?? studio?.label ?? id,
    kind,
    op: studio ? 'studio' : ROLE_OP[role],
    adult: (studio?.adult ?? catalog?.adult) === true,
    tier: own?.tier ?? catalog?.tier,
    weights: own?.weights ?? catalog?.weights,
  }
}

/** Every model this step can run on, the preset's own first.
 *
 *  `openOnly` is what an adult preset asks for. A Horror or a Spicy workflow
 *  on a filtered endpoint returns a refusal or a softened frame, which costs
 *  the customer credits for nothing. Where the role HAS open members, they are
 *  the whole list. Where it has none, the role is not about refusals at all
 *  (adding sound, driving a mouth) and the full list stands, because an empty
 *  picker would take the step away entirely. */
export function presetModels(role: StepRole, openOnly = false): PresetModel[] {
  const all = allPresetModels(role)
  if (!openOnly) return all
  const open = all.filter((m) => m.adult)
  return open.length ? open : all
}

function allPresetModels(role: StepRole): PresetModel[] {
  // A caller with an unknown role gets nothing instead of a crashed workspace.
  const ids = ROLE_MEMBERS[role]?.() ?? []
  const out: PresetModel[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) continue
    // Ein Studio-Mitglied erscheint NUR, wenn der lebende Katalog genau dieses
    // Modell als Studio-Eintrag fuehrt (`studioKnown`). Das Web fuehrt den
    // Katalog im selben Repo, der Desktop liest ihn vom Server: ein aelterer
    // Server (oder der Notvorrat vor dem ersten Abruf) kennt die neueren
    // Modelle nicht, und ein Start dort wuerde abgelehnt. Frueher stand hier
    // eine einzige Probe fuer den ganzen Katalog (catalogHasStudio), die auch
    // ein Modell durchliess, das dieser Server gar nicht hat.
    if (STUDIO_MODELS[id] && !studioKnown(id)) continue
    // A classic id the studio registry already serves is dropped, not listed
    // twice under the same name, ONLY when the server really lists that studio
    // twin. Review B1 (Runde 2): sonst verdraengte die Zwillingsregel das
    // klassische Mitglied, waehrend der Zwilling selbst entfiel, und Extend/
    // Motion hatten auf einem aelteren Server KEINES von beiden.
    const twin = SUPERSEDED.get(id)
    if (twin && ids.includes(twin) && studioKnown(twin)) continue
    const e = entry(id, role)
    if (!e) continue
    seen.add(id)
    out.push(e)
  }
  return out
}

/** A step always resolves the model it names, even when the picker narrows the
 *  list around it. The preset's own choice is never taken away from it. */
/** Was ein Modell vom Prompt erwartet.
 *
 *  19.09.2026: ein Satz auf Prefect Pony brachte das Haus und nicht die Figur.
 *  Das ist kein Fehler des Modells. Pony-Finetunes lesen kommagetrennte Tags
 *  mit score_-Praefix, Chroma liest Saetze. Wer das nicht weiss, haelt das
 *  Ergebnis fuer schlechte Qualitaet und zahlt zweimal. Also steht es dran. */
const HINTS: Record<string, string> = {
  'preset-chroma': 'Reads full sentences. Can do photoreal and illustration. For photos, write it: start the prompt with "photorealistic" and describe the camera, the light and the lens.',
  chroma: 'Reads full sentences. Can do photoreal and illustration. For photos, write it: start the prompt with "photorealistic" and describe the camera, the light and the lens.',
  'preset-prefect-pony': 'Reads comma separated tags, not sentences. Start with score_9, score_8_up. Illustration, not photo.',
  'prefect-pony': 'Reads comma separated tags, not sentences. Start with score_9, score_8_up. Illustration, not photo.',
  'preset-neta-lumina': 'Anime and illustration. Short comma separated tags work better than long sentences.',
  'neta-lumina': 'Anime and illustration. Short comma separated tags work better than long sentences.',
  // Die vier offenen Bildmodelle, die eine Horrorszene wirklich stellen.
  // Geprueft am 19.09.2026 an einem identischen Prompt mit gleichem Seed.
  'z-image': 'Reads full sentences and holds a photoreal scene. Name the room, the light and the lens.',
  'nucleus-image': 'Reads full sentences. Has a negative prompt: write there what must not appear.',
  'jib-mix-qwen': 'Reads full sentences. Warm, filmic skin. Name the light source and the camera.',
  'wan-2.2-realism': 'Reads full sentences. The most cinematic of the four. Describe the shot like a film still.',
  // Bewegung, nicht Stimmung. Siehe prompt-ideas.ts, MOTION.
  'open-video': 'Describe the movement, not the mood. Say what moves and how.',
  'open-video-lora': 'Describe the movement, not the mood. Say what moves and how.',
  'preset-wan-2.2-spicy': 'Describe the movement, not the mood. Say what moves and how.',
  'preset-wan-2.7-spicy': 'Describe the movement, not the mood. Say what moves and how.',
  'wan-3.0': 'Describe the movement, not the mood. Say what moves and how.',
  'wan-3.0-spicy': 'Describe the movement, not the mood. Say what moves and how.',
  'wan-3.0-prime': 'Describe the movement, not the mood. Say what moves and how.',
  'wan-3.0-prime-spicy': 'Describe the movement, not the mood. Say what moves and how.',
  'seedance-2.5-turbo': 'Describe the movement, not the mood. Say what moves and how.',

  // 19.09.2026: die neuen Endpunkte. Jeder Satz sagt, wofuer man ihn nimmt und
  // was er kostet, wenn der Preis der Grund fuer die Wahl ist.
  'longcat-avatar': 'A good talking head at a low price. Start here.',
  'lipsync-3-avatar': 'Sharp lip sync that keeps the rest of the photo still.',
  'seedance-2.5-avatar': 'The most lifelike talking head we have, and by far the dearest.',
  'heygen-twin': 'No photo of your own. Pick a presenter, they read your track.',
  'infinitetalk-multi': 'One picture, two voices. Left speaks first unless you say otherwise.',
  'longcat-avatar-multi': 'One picture, two voices, at a quarter of the InfiniteTalk price.',

  'seed-speech-tts': 'Forty voices across ten languages. Natural, and cheap.',
  'minimax-speech-turbo': 'Fast and emotional. Voices: Wise_Woman, Friendly_Person, Deep_Voice_Man, Calm_Woman.',
  'minimax-speech-hd': 'The Turbo voices at higher fidelity, for twice the price.',
  'eleven-v3': 'The most expressive English voice. Costs the most per word.',
  'inworld-tts': 'Sixty named voices, many languages, pick one from the list.',
  'chatterbox-tts': 'Add a short recording and it speaks in that voice.',

  'minimax-music': 'A whole song with vocals from one description.',
  'mureka-song': 'You write the lyrics, it writes and sings the song.',
  'eleven-music': 'Studio quality music. Billed per started minute, not per second.',

  'wan-2.2-animate-2': 'Copies the movement of your clip onto your picture.',
  'wan-3.0-extend': 'Continues your clip. You pay only for the added seconds.',
  'seedance-2.5-extend': 'Continues your clip. You pay for the whole result, not just the new part.',

  'seedream-5-edit': 'Say what to change in plain words. No mask needed.',
  'qwen-image-3-edit': 'Say what to change in plain words. The cheapest of the three.',

  'video-upscaler': 'The basic one and the cheapest. Reaches 4K.',
  'flashvsr': 'Sharper than the basic one and still cheap. Reaches 4K.',
  'video-upscaler-pro': 'Sharper than FlashVSR on soft or noisy footage. Reaches 4K.',
  'ultimate-video-upscaler': 'A heavier rebuild for really rough footage. Reaches 4K.',
  'crystal-upscaler': 'The only one that reaches 8K. Set 33 megapixels for 8K.',
  'flux-3-upscale': 'Multiplies the size instead of aiming at a target. No fixed 4K.',

  // 02.10.2026: die Modelle aus offenen Familien. Jeder Satz sagt nur, was der
  // Anbieter selbst zum Endpunkt schreibt.
  'ltx-2.5-t2v': 'Makes a clip with sound. Longer clips and higher resolutions cost more.',
  'ltx-2.5-i2v': 'Makes a clip with sound. Longer clips and higher resolutions cost more.',
  'minimax-h3-video-edit': 'Say what to change. The clip keeps its movement and timing.',
  'minimax-h3-ref': 'Your picture sets who is in the clip. Describe what they do.',
  'wan-3.0-ref': 'Your picture sets who is in the clip. Describe what they do.',
}

export function modelHint(id: string): string | undefined {
  return HINTS[id]
}

export function presetModel(role: StepRole, id: string): PresetModel | undefined {
  return allPresetModels(role).find((m) => m.id === id)
}

/** The inputs a NON-studio member stages. Voice cloning is the one member
 *  that needs a file where the rest of its role needs none. */
export function classicInputs(role: StepRole, id: string): Record<string, string> {
  if (role === 'speech') return id === 'qwen3-tts-clone' ? { audio: 'audio_path' } : {}
  return ROLE_INPUTS[role]
}

/** The inputs a member of this role stages, as provider field -> job param. */
export function roleInputs(role: StepRole, id: string): Record<string, string> {
  return STUDIO_MODELS[id] ? STUDIO_MODELS[id].inputs : classicInputs(role, id)
}

/** The inputs a member cannot start without. */
export function requiredRoleInputs(role: StepRole, id: string): string[] {
  const studio = STUDIO_MODELS[id]
  if (!studio) return Object.values(classicInputs(role, id))
  const required = studioSchema(id).required ?? []
  return Object.entries(studio.inputs).filter(([f]) => required.includes(f)).map(([, key]) => key)
}

/** Roles whose NON-studio members need words before they can start. */
const CLASSIC_PROMPT: Record<StepRole, boolean> = {
  image: true, animate: true, speech: true, music: true, extend: true, edit: true, restyle: true,
  video: true, reference: true,
  talking: false, presenter: false, motion: false, soundtrack: false, duo: false,
  angles: false, upscale: false,
  'swap-character': false,
}

export function rolePrompts(role: StepRole): boolean {
  return CLASSIC_PROMPT[role]
}

/** Roles with a single member show no picker: there is nothing to pick. */
export function roleHasChoice(role: StepRole, openOnly = false): boolean {
  return presetModels(role, openOnly).length > 1
}

export const ALL_ROLES = Object.keys(ROLE_MEMBERS) as StepRole[]

/** Roles that share models with another role on purpose (as on the web).
 *  The rule "every studio model in exactly one role" holds for all others. */
export const SWAP_ROLES: readonly StepRole[] = ['swap-character']

/** The role a model plays. Every studio model belongs to exactly one, which a
 *  contract test holds true; the ad-hoc single-model workspace needs it to
 *  know what its one step is. */
export function roleForModel(id: string): StepRole | undefined {
  return ALL_ROLES.find((role) => ROLE_MEMBERS[role]().includes(id))
}

/** What a NON-studio member costs.
 *
 *  This is the submit route's own call, with the route's own argument mapping:
 *  a clip is priced from frames/fps and NEVER from `duration`, a track from
 *  `duration`, a still from neither. The workshop prices with this function,
 *  fed the very params it is about to send, so the number on the button and
 *  the number that gets booked cannot drift apart.
 *
 *  Desktop port (P2): the web prices this from its own table
 *  (the server's price table), which the desktop does not have
 *  (portplan Abschnitt 2.1: "Desktop hat keine eigene Preistabelle, Preise
 *  kommen aus /api/jobs/catalog"). Here the same number comes from the live
 *  catalog via cloudCatalogStore's runCredits (read-only import, that store
 *  belongs to P3). `null` when the catalog carries no price for this model
 *  (seed without a rate, or before the first catalog refresh): never an
 *  invented number. */
export function classicCredits(
  kind: RenderKind,
  model: string,
  op: RenderOp,
  p: { frames?: number; fps?: number; duration?: number; target_resolution?: string },
): number | null {
  const seconds = kind === 'video'
    ? (typeof p.frames === 'number' && typeof p.fps === 'number' && p.fps > 0 ? p.frames / p.fps : undefined)
    : kind === 'audio' ? p.duration : undefined
  const priced = runCredits(kind, op, model, seconds, Number.NaN, p.target_resolution)
  return Number.isFinite(priced) ? priced : null
}

/** The customer-facing name of a model id, whichever registry carries it.
 *  A studio twin answers under the catalog name the customer already knows. */
export function modelLabel(id: string): string {
  const studio = STUDIO_MODELS[id]
  return cloudModelById(studio?.sourceModel ?? id)?.label ?? studio?.label ?? id
}
