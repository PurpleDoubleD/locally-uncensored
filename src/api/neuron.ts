// The Neuron tweaker (3.0.9, P11). The work happens in Rust
// (src-tauri/src/commands/neuron); this is the app's side of it.

import { backendCall } from './backend'
import type { BuiltinEngineTuning } from '../types/settings'

export interface NeuronPreset {
  id: string
  left: string
  right: string
}

export interface NeuronVector {
  id: string
  /** preset | own | feature */
  kind: 'preset' | 'own' | 'feature'
  name: string
  left: string
  right: string
  /** The measured scale slider +1 stands for. */
  unit: number
  builtAt: number
  more: string[]
  less: string[]
  feature?: number | null
  sae?: string | null
}

export interface NeuronSae {
  id: string
  title: string
  license: string
  layer: number
  width: number
  bytes: number
  downloaded: boolean
  source: string
  instruct: boolean
}

export interface NeuronInfo {
  facts: { arch: string; nLayer: number; nEmbd: number; template: string; name: string; tweaked: string[]; original: string | null }
  modelKey: string
  generator: boolean
  band: [number, number]
  vectors: NeuronVector[]
  sae: NeuronSae | null
  activeMix: string | null
}

export interface NeuronJob {
  status: 'idle' | 'running' | 'done' | 'failed' | 'cancelled'
  kind: '' | 'build' | 'feature' | 'download'
  title: string
  modelPath: string
  phaseLabel: string
  step: number
  total: number
  bytesDone: number
  bytesTotal: number
  rateBps: number
  etaSecs: number | null
  elapsedSecs: number
  resultId: string | null
  error: string | null
  logs: string[]
}

export interface NeuronEntry {
  id: string
  strength: number
}

export interface FeatureHit {
  feature: number
  label: string
  score: number
}

export interface CompareResult {
  before: string
  after: string
  seed: number
  steered: boolean
  same: boolean
}

export const neuronPresets = () => backendCall<NeuronPreset[]>('neuron_presets')

export const neuronInfo = (modelPath: string) => backendCall<NeuronInfo>('neuron_info', { modelPath })

export const neuronBuildPreset = (modelPath: string, preset: string) =>
  backendCall<{ started: boolean }>('neuron_build', { args: { modelPath, preset } })

export const neuronBuildOwn = (modelPath: string, name: string, more: string[], less: string[], id?: string) =>
  backendCall<{ started: boolean }>('neuron_build', { args: { modelPath, name, more, less, id } })

export const neuronFeatureAdd = (modelPath: string, feature: number, label?: string) =>
  backendCall<{ started: boolean }>('neuron_feature_add', { modelPath, feature, label })

export const neuronDelete = (modelPath: string, id: string) => backendCall<{ deleted: string }>('neuron_delete', { modelPath, id })

export const neuronSaeDownload = (modelPath: string) => backendCall<{ started: boolean }>('neuron_sae_download', { modelPath })

export const neuronSaeSearch = (modelPath: string, query: string) =>
  backendCall<{ hits: FeatureHit[] }>('neuron_sae_search', { modelPath, query })

export const neuronStatus = () => backendCall<NeuronJob>('neuron_status')

export const neuronCancel = () => backendCall<{ cancelling: boolean }>('neuron_cancel')

export const neuronDismiss = () => backendCall<{ ok: boolean }>('neuron_dismiss')

export const neuronApply = (modelPath: string, entries: NeuronEntry[], tuning?: BuiltinEngineTuning) =>
  backendCall<{ mix: string | null; restarted: boolean; load: number; port?: number }>('neuron_apply', { modelPath, entries, tuning })

export const neuronCompare = (modelPath: string, question: string, seed: number, entries: NeuronEntry[], tuning?: BuiltinEngineTuning) =>
  backendCall<CompareResult>('neuron_compare', { modelPath, question, seed, entries, tuning })
