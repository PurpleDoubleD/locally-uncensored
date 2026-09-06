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
}

// Cloud text model (OpenAI-compat or Anthropic) — lighter than OllamaModel
export interface CloudModel {
  name: string
  model: string
  size: number
  type: 'text'
  provider: ProviderId
  providerName: string
  contextLength?: number
  supportsTools?: boolean
  supportsVision?: boolean
  thinkMode?: 'toggle' | 'always' | 'never'
  /** The reasoning rungs this model accepts, ascending, and the rung it
   *  defaults to (LU Cloud /models). Absent = no effort control and the old
   *  fixed behaviour. See lib/effort.ts. */
  effortLevels?: string[]
  effortDefault?: string
  /** Friendly picker label when the server provides one (LU Cloud /models
   *  `name`) — pickers fall back to the raw id otherwise. */
  displayName?: string
  /** Where the file lies, for a row that IS a file: the LU Engine's GGUFs.
   *  Absent for everything served over a network API. Two rows naming one
   *  path are one model however differently the two backends spell its name,
   *  which is what the Installed list uses to stop showing it twice. */
  path?: string
}

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
  // of falsely completing (adhney).
  error?: string
}


export type ModelCategory = 'all' | 'text' | 'image' | 'video'


/**
 * Classify model by type
 */
export function classifyModel(model: AIModel): ModelCategory {
  return model.type
}
