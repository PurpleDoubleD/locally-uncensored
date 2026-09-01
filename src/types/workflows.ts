import type { ModelType } from '../api/comfyui'
import type { ComfyApiGraph } from './comfy-graph'

export type WorkflowSource = 'civitai' | 'manual'

export interface WorkflowTag {
  id: string
  name: string
  createdAt: number
}

export interface ParameterMapping {
  nodeId: string
  inputKey: string
}

export interface ModelParameterMapping extends ParameterMapping {
  loaderType: 'checkpoint' | 'unet'
}

export interface ParameterMap {
  model?: ModelParameterMapping
  positivePrompt?: ParameterMapping
  negativePrompt?: ParameterMapping
  seed?: ParameterMapping
  steps?: ParameterMapping
  cfgScale?: ParameterMapping
  width?: ParameterMapping
  height?: ParameterMapping
  batchSize?: ParameterMapping
  sampler?: ParameterMapping
  scheduler?: ParameterMapping

  // I2I / I2V source image
  inputImage?: ParameterMapping

  // Video-specific
  frames?: ParameterMapping
  fps?: ParameterMapping
}

export interface WorkflowTemplate {
  id: string
  name: string
  description: string
  source: WorkflowSource
  sourceUrl?: string
  modelTypes: ModelType[]
  mode: 'image' | 'video' | 'both'
  workflow: ComfyApiGraph
  parameterMap: ParameterMap
  installedAt: number
  thumbnailUrl?: string
}

export interface WorkflowSearchResult {
  name: string
  description: string
  source: WorkflowSource
  sourceUrl: string
  thumbnailUrl?: string
  modelTypes: ModelType[]
  mode: 'image' | 'video' | 'both'
  downloadUrl?: string
  rawWorkflow?: ComfyApiGraph
}
