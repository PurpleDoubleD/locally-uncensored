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

  // Motion Control: the driving clip (LoadVideo or VHS_LoadVideo)
  inputVideo?: ParameterMapping

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
  /** Where a workflow installed from the chat came from and what its check
   *  said (C60-S5). A later update compares `sha256`. */
  provenance?: WorkflowProvenance
}

export interface WorkflowProvenance {
  source: 'lu' | 'comfy-template' | 'civitai' | 'github' | 'user-link' | 'user-file'
  url?: string
  /** SHA-256 of the workflow JSON as it was read. */
  sha256: string
  checkedAt: number
  light: 'green' | 'yellow' | 'red'
  /** The check's findings, LU's own sentences. */
  findings: string[]
}
