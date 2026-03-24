
// Text model (Ollama)
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
}

// Generic model type
export type AIModel = OllamaModel | ImageModel | VideoModel;

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
