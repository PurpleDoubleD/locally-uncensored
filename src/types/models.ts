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
}


export type ModelCategory = 'all' | 'text' | 'image' | 'video'


/**
 * Classify model by type
 */
export function classifyModel(model: AIModel): ModelCategory {
  return model.type
}
