import type { ProviderId } from '../api/providers/types'

// Text model (Ollama or cloud provider)
export interface OllamaModel {
  name: string
  model: string
  size: number
  digest: string
  modified_at: string
  details: {
    parent_model: string
    format: string
    family: string
    families: string[]
    parameter_size: string
    quantization_level: string
  }
  type: 'text'
  provider?: ProviderId       // 'ollama' | 'openai' | 'anthropic'
  providerName?: string       // Display: "Ollama", "OpenRouter", "Anthropic"
  contextLength?: number      // Known context window size
  supportsTools?: boolean     // Native tool calling support
  supportsVision?: boolean    // Ollama's "vision" capability (projector loaded)
}

// Cloud text model (OpenAI-compat or Anthropic) — lighter than OllamaModel
export interface CloudModel {
  flash?: import('../lib/flash-ui').FlashPolicy
  /** Gemessenes Inhaltsverhalten aus dem Server-Katalog (LU Cloud /models
   *  `unfiltered`), nie aus dem Modellnamen geraten. 'full' = das Modell
   *  antwortet ohne Ablehnung. Fehlt das Feld, ist nichts gemessen und nichts
   *  versprochen. */
  unfiltered?: 'full' | 'partial'
  /** Aus dem Server-Katalog (LU Cloud /models `unrestricted`): vom Hersteller
   *  ohne Ablehnungsschicht herausgegeben, nur von einer festen Gegenstelle
   *  ausgeliefert. Traegt die zweite Marke der Zeile (lib/unfiltered-mark). */
  unrestricted?: boolean
  /** The name the catalogue route itself gives the model, where the app shows
   *  another one (ProviderModel.catalogName). Read by the phone's store build. */
  catalogName?: string

  name: string
  model: string
  size: number
  type: 'text'
  provider: ProviderId
  providerName: string
  /** GitHub #173: the additional OpenAI-compatible entry serving this row,
   *  absent for the original slot. The `name` carries it too. */
  providerEntry?: string
  contextLength?: number
  supportsTools?: boolean
  supportsVision?: boolean
  /** From the server catalogue (LU Cloud /models `create_in_chat`): may the
   *  two Create tools of the chat go to this model? */
  createInChat?: boolean
  /** From the server catalogue (LU Cloud /models `limited_capacity`): little
   *  room for all customers together, the picker notes it. */
  limitedCapacity?: boolean
  /** LU Engine rows only: the model's image part lies next to its GGUF. With
   *  `supportsVision` false this is a model loaded without its part; absent
   *  or false with a known source, the part can be added (lib/image-part). */
  imagePartInstalled?: boolean
  /** LU Engine rows only: LU's refusal-removal tool made this file. */
  refusalsRemoved?: boolean
  /** LU Engine rows only: the Hugging Face repo of the original weights,
   *  when the file names one. The refusal-removal button needs it. */
  sourceRepo?: string
  thinkMode?: 'toggle' | 'always' | 'never'
  /** The reasoning rungs this model accepts, ascending, and the rung it
   *  defaults to (LU Cloud /models). Absent = no effort control and the old
   *  fixed behaviour. See lib/effort.ts. */
  effortLevels?: string[]
  effortDefault?: string
  /** Local models without rungs (issue 176): why the effort control is
   *  greyed out. Absent = nothing to say, and no control. */
  effortNote?: string
  /** The rungs come from the local server itself, not from a catalogue
   *  (issue 176). Until the user picks one the composer shows Default and the
   *  request stays as it was before 3.0.7 (settings.localEffortChosen). */
  effortLocal?: boolean
  /** The context window the server stated in its listing. Absent when it
   *  stated none; `contextLength` may then hold a table value or a guess,
   *  which is fine for a budget and wrong for a printed figure. */
  declaredContext?: number
  /** Credits per one million tokens, input and output apart, as LU Cloud
   *  states them. Shown in the picker's rate popover and nowhere else. */
  creditRates?: import('../api/providers/types').CreditRates
  /** Friendly picker label when the server provides one (LU Cloud /models
   *  `name`) — pickers fall back to the raw id otherwise. */
  displayName?: string
  /** A quiet line the picker prints after the name, no mark (the gate
   *  pop-up: a model too big to run on this machine). */
  quietNote?: string
  /** Where the file lies, for a row that IS a file: the LU Engine's GGUFs.
   *  Absent for everything served over a network API. Two rows naming one
   *  path are one model however differently the two backends spell its name,
   *  which is what the Installed list uses to stop showing it twice. */
  path?: string
}

/**
 * Which ComfyUI models folder a listed file was enumerated out of.
 *
 * THE definition of that set, and it lives here rather than in `api/comfyui`
 * because the inventory rows carry it all the way into the views: a LoRA and a
 * checkpoint are both files under `ComfyUI/models`, they are both `type:
 * 'image'`, and only this field tells them apart. It used to be dropped the
 * moment the inventory became `AIModel`, which is why LoRAs sat nameless
 * between the checkpoints in the Image tab and could be clicked as if one of
 * them were a main model.
 *
 * `api/comfyui` narrows this to its addon half (`AddonSource`) instead of
 * spelling the names a second time.
 */
export type ComfyModelSource =
  | 'checkpoint' | 'diffusion_model' | 'motion_module'
  | 'lora' | 'vae' | 'text_encoder'
  | 'clip_vision' | 'controlnet' | 'upscale_model' | 'embedding' | 'style_model'

// Image model (e.g. Stable Diffusion, SDXL, Fooocus, ComfyUI)
export interface ImageModel {
  name: string
  model: string
  size: number
  format: string
  architecture: string
  previewUrl?: string
  tags?: string[]
  license?: string
  updated_at?: string
  compatibleWith?: string[]
  type: 'image'
  provider?: ProviderId
  providerName?: string
  /** Set for rows the ComfyUI inventory produced, absent for everything else. */
  source?: ComfyModelSource
}

// Video model (e.g. SVD, AnimateDiff, VideoCrafter, ComfyUI)
export interface VideoModel {
  name: string
  model: string
  size: number
  format: string
  architecture: string
  previewUrl?: string
  tags?: string[]
  license?: string
  updated_at?: string
  compatibleWith?: string[]
  type: 'video'
  provider?: ProviderId
  providerName?: string
  /** Set for rows the ComfyUI inventory produced, absent for everything else. */
  source?: ComfyModelSource
}

// Generic model type
export type AIModel = OllamaModel | CloudModel | ImageModel | VideoModel;

export interface PullProgress {
  status: string
  digest?: string
  total?: number
  completed?: number
  // Ollama can stream an `{"error": "..."}` line mid-pull (e.g. HTTP 400 on an
  // incompatible repo). Surfaced so the pull card shows why it failed instead
  // of falsely completing.
  error?: string
}


export type ModelCategory = 'all' | 'text' | 'image' | 'video'


/**
 * Classify model by type
 */
export function classifyModel(model: AIModel): ModelCategory {
  return model.type
}
