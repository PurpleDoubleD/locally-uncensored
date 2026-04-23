import { backendCall, fetchExternal } from "./backend"
import { getCheckpoints, getDiffusionModels, getVAEModels, getCLIPModels } from "./comfyui"
import type { ProviderId } from "./providers/types"

export interface DiscoverModel {
  name: string
  description: string
  pulls: string
  tags: string[]
  updated: string
  url?: string
  // For direct download
  downloadUrl?: string
  filename?: string
  subfolder?: string  // ComfyUI models subfolder: checkpoints, diffusion_models, vae, text_encoders
  sizeGB?: number
  // Discovery flags
  hot?: boolean       // Featured/trending model
  agent?: boolean     // Supports Agent Mode tool calling
  released?: string   // Release date YYYY-MM for sorting (newest first)
  // Multi-provider
  provider?: ProviderId   // Which provider this model belongs to
  providerName?: string   // Display name of the provider
  canPull?: boolean       // false = no download/pull capability (cloud/external)
  ollamaModel?: string    // Ollama model tag for `ollama pull` (e.g. 'qwen3.6')
}

export interface DownloadProgress {
  progress: number
  total: number
  speed: number
  filename: string
  status: 'connecting' | 'downloading' | 'pausing' | 'paused' | 'complete' | 'error'
  error?: string
}

// ─── Download API ───

export async function startModelDownload(url: string, subfolder: string, filename: string, expectedBytes?: number): Promise<{ status: string; id: string; error?: string }> {
  return backendCall("download_model", { url, subfolder, filename, expectedBytes: expectedBytes ?? null })
}

export async function getDownloadProgress(): Promise<Record<string, DownloadProgress>> {
  try {
    return await backendCall("download_progress")
  } catch {
    return {}
  }
}

export async function pauseDownload(id: string): Promise<void> {
  await backendCall("pause_download", { id })
}

export async function cancelDownload(id: string): Promise<void> {
  await backendCall("cancel_download", { id })
}

export async function resumeDownload(id: string, url: string, subfolder: string): Promise<void> {
  await backendCall("resume_download", { id, url, subfolder })
}

// ─── Custom Node Installation ───

/** Check if ALL files in a bundle are completely downloaded (size validated) */
export async function checkBundleInstalled(bundle: ModelBundle): Promise<boolean> {
  try {
    const files = bundle.files
      .filter(f => f.subfolder && f.filename)
      .map(f => ({
        subfolder: f.subfolder!,
        filename: f.filename!,
        expectedBytes: f.sizeGB ? Math.round(f.sizeGB * 1_073_741_824) : 0,
      }))
    if (files.length === 0) return false
    const results: Array<{ filename: string; exists: boolean; actualBytes: number; complete: boolean }> =
      await backendCall('check_model_sizes', { files })
    return results.every(r => r.complete)
  } catch {
    return false
  }
}

/** Check multiple bundles at once, returns map of bundle name → installed status */
export async function checkBundlesInstalled(bundles: ModelBundle[]): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {}
  // Collect ALL files from ALL bundles into a single batch request
  const allFiles: Array<{ subfolder: string; filename: string; expectedBytes: number; bundleName: string }> = []
  for (const bundle of bundles) {
    for (const f of bundle.files) {
      if (!f.subfolder || !f.filename) continue
      allFiles.push({
        subfolder: f.subfolder,
        filename: f.filename,
        expectedBytes: f.sizeGB ? Math.round(f.sizeGB * 1_073_741_824) : 0,
        bundleName: bundle.name,
      })
    }
  }
  if (allFiles.length === 0) return result

  try {
    const checkFiles = allFiles.map(f => ({ subfolder: f.subfolder, filename: f.filename, expectedBytes: f.expectedBytes }))
    const results: Array<{ filename: string; exists: boolean; actualBytes: number; complete: boolean }> =
      await backendCall('check_model_sizes', { files: checkFiles })

    // Map results back to bundles
    const fileStatus = new Map(results.map(r => [r.filename, r.complete]))
    for (const bundle of bundles) {
      const bundleFiles = bundle.files.filter(f => f.filename)
      result[bundle.name] = bundleFiles.length > 0 && bundleFiles.every(f => fileStatus.get(f.filename!) === true)
    }
  } catch {
    // If check fails (e.g. no ComfyUI), all bundles are not installed
    for (const b of bundles) result[b.name] = false
  }

  // Fallback: for bundles not detected by exact filename, check ComfyUI's model lists
  // This catches variant files (e.g. fp8 version of a model with different filename)
  // STRICT: only exact base-name match — no substring matching (caused false positives
  // where z_image_turbo matched z_image_base, or gemma-4-31b matched gemma-4-e4b)
  const undetected = bundles.filter(b => !result[b.name])
  if (undetected.length > 0) {
    try {
      const [checkpoints, diffModels, vaes, clips] = await Promise.all([
        getCheckpoints(), getDiffusionModels(), getVAEModels(), getCLIPModels(),
      ])
      const modelsBySubfolder: Record<string, string[]> = {
        checkpoints, diffusion_models: diffModels, vae: vaes, text_encoders: clips,
      }
      for (const bundle of undetected) {
        const allFound = bundle.files.every(f => {
          if (!f.filename || !f.subfolder) return true
          const models = modelsBySubfolder[f.subfolder] || []
          // Strip extension and common quant suffixes for fuzzy matching
          const base = f.filename.replace(/\.[^.]+$/, '').toLowerCase()
            .replace(/[-_](fp4|fp8|fp16|bf16|e4m3fn|scaled|fp8_e4m3fn_scaled)$/g, '')
          return models.some(m => {
            const mBase = m.replace(/\.[^.]+$/, '').toLowerCase()
              .replace(/[-_](fp4|fp8|fp16|bf16|e4m3fn|scaled|fp8_e4m3fn_scaled)$/g, '')
            return mBase === base
          })
        })
        if (allFound) result[bundle.name] = true
      }
    } catch {
      // ComfyUI not reachable — keep exact-match results
    }
  }

  return result
}

export async function installCustomNodes(nodeKeys: string[]): Promise<void> {
  for (const key of nodeKeys) {
    const entry = CUSTOM_NODE_REGISTRY[key]
    if (!entry) {
      console.warn(`[discover] Unknown custom node key: ${key}`)
      continue
    }
    try {
      await backendCall('install_custom_node', { repoUrl: entry.repo, nodeName: entry.name })
      console.log(`[discover] Installed custom node: ${entry.name}`)
    } catch (err) {
      console.error(`[discover] Failed to install ${entry.name}:`, err)
      throw new Error(`Failed to install ${entry.name}: ${err}`)
    }
  }
}

export async function installBundleComplete(bundle: ModelBundle): Promise<void> {
  const errors: string[] = []

  // Pre-check: which files already exist on disk (skip re-downloading them)
  let installedFiles = new Set<string>()
  try {
    const checkFiles = bundle.files
      .filter(f => f.subfolder && f.filename)
      .map(f => ({ subfolder: f.subfolder!, filename: f.filename!, expectedBytes: f.sizeGB ? Math.round(f.sizeGB * 1_073_741_824) : 0 }))
    if (checkFiles.length > 0) {
      const results: Array<{ filename: string; exists: boolean; complete: boolean }> =
        await backendCall('check_model_sizes', { files: checkFiles })
      for (const r of results) {
        if (r.complete) installedFiles.add(r.filename)
      }
    }
  } catch { /* can't check — download everything */ }

  // Step 1: Start downloads only for files NOT already installed
  for (const file of bundle.files) {
    if (!file.downloadUrl || !file.filename || !file.subfolder) continue
    if (installedFiles.has(file.filename)) {
      console.log(`[discover] Skipping ${file.filename} — already installed`)
      window.dispatchEvent(new CustomEvent('comfyui-download-exists', { detail: { filename: file.filename } }))
      continue
    }
    try {
      const expectedBytes = file.sizeGB ? Math.round(file.sizeGB * 1_073_741_824) : undefined
      const result = await startModelDownload(file.downloadUrl, file.subfolder, file.filename, expectedBytes)
      if (result.status === 'exists') {
        // File already on disk — emit synthetic 'complete' so UI reflects it
        window.dispatchEvent(new CustomEvent('comfyui-download-exists', { detail: { filename: file.filename } }))
      }
    } catch (err) {
      console.error(`[discover] Download failed for ${file.filename}:`, err)
      errors.push(`${file.filename}: ${err}`)
    }
  }

  // Step 2: Install custom nodes in BACKGROUND (fire-and-forget, non-blocking)
  // This runs git clone + pip install which can take minutes — never block downloads
  if (bundle.customNodes && bundle.customNodes.length > 0) {
    const nodeKeys = [...bundle.customNodes]
    void (async () => {
      for (const key of nodeKeys) {
        try {
          const entry = CUSTOM_NODE_REGISTRY[key]
          if (!entry) continue
          await backendCall('install_custom_node', { repoUrl: entry.repo, nodeName: entry.name })
          console.log(`[discover] Installed custom node: ${entry.name}`)
        } catch (err) {
          console.warn('[discover] Custom node install failed:', err)
        }
      }
      // Restart ComfyUI after custom nodes are done (needed for node registration)
      try {
        await backendCall('stop_comfyui')
        await new Promise(resolve => setTimeout(resolve, 2000))
        await backendCall('start_comfyui')
        console.log('[discover] ComfyUI restarted after custom node install')
      } catch (err) {
        console.warn('[discover] ComfyUI restart after custom node install failed:', err)
      }
    })()
  }

  // Force ComfyUI to re-scan model directories so new files appear in /object_info.
  // Without this, ComfyUI's cached model list stays stale on Windows.
  try {
    const { refreshComfyModels } = await import('./comfyui')
    await refreshComfyModels()
  } catch { /* non-fatal — fetchModels also calls refresh */ }

  // Dispatch event so CreateView refreshes model list
  window.dispatchEvent(new CustomEvent('comfyui-model-downloaded'))

  if (errors.length > 0) {
    throw new Error(`Bundle install had ${errors.length} issue(s): ${errors.join('; ')}`)
  }
}

// ─── Component Registry: What each model type needs to work ───

import type { ModelType } from './comfyui'

export interface ComponentSpec {
  patterns: string[]
  downloadName: string
  downloadUrl: string
  subfolder: string
}

export interface ComponentRequirements {
  loader: 'UNETLoader' | 'CheckpointLoaderSimple'
  vae?: ComponentSpec
  clip?: ComponentSpec
  clipSecondary?: ComponentSpec
  needsSeparateVAE: boolean
  needsSeparateCLIP: boolean
}

export const COMPONENT_REGISTRY: Record<string, ComponentRequirements> = {
  sd15: { loader: 'CheckpointLoaderSimple', needsSeparateVAE: false, needsSeparateCLIP: false },
  sdxl: { loader: 'CheckpointLoaderSimple', needsSeparateVAE: false, needsSeparateCLIP: false },
  flux: {
    loader: 'UNETLoader',
    vae: { patterns: ['ae', 'flux'], downloadName: 'flux2-vae.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/resolve/main/split_files/vae/flux2-vae.safetensors', subfolder: 'vae' },
    clip: { patterns: ['t5xxl', 't5-xxl', 't5_xxl'], downloadName: 't5xxl_fp8_e4m3fn.safetensors', downloadUrl: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors', subfolder: 'text_encoders' },
    clipSecondary: { patterns: ['clip_l'], downloadName: 'clip_l.safetensors', downloadUrl: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  flux2: {
    loader: 'UNETLoader',
    vae: { patterns: ['flux2', 'flux'], downloadName: 'flux2-vae.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/resolve/main/split_files/vae/flux2-vae.safetensors', subfolder: 'vae' },
    clip: { patterns: ['qwen', 'mistral'], downloadName: 'qwen_3_4b_fp4_flux2.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/resolve/main/split_files/text_encoders/qwen_3_4b_fp4_flux2.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  zimage: {
    loader: 'UNETLoader',
    vae: { patterns: ['ae', 'flux'], downloadName: 'ae.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors', subfolder: 'vae' },
    clip: { patterns: ['qwen_3_4b', 'qwen3'], downloadName: 'qwen_3_4b.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  ernie_image: {
    loader: 'UNETLoader',
    vae: { patterns: ['flux2-vae', 'flux2', 'flux'], downloadName: 'flux2-vae.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/vae/flux2-vae.safetensors', subfolder: 'vae' },
    clip: { patterns: ['ministral-3-3b', 'ministral', 'ernie-image-prompt-enhancer'], downloadName: 'ministral-3-3b.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/text_encoders/ministral-3-3b.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  wan: {
    loader: 'UNETLoader',
    vae: { patterns: ['wan'], downloadName: 'wan_2.1_vae.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors', subfolder: 'vae' },
    clip: { patterns: ['umt5', 'wan'], downloadName: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  hunyuan: {
    loader: 'UNETLoader',
    vae: { patterns: ['hunyuanvideo', 'hunyuan'], downloadName: 'hunyuanvideo15_vae_fp16.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/vae/hunyuanvideo15_vae_fp16.safetensors', subfolder: 'vae' },
    clip: { patterns: ['qwen', 'llava'], downloadName: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  ltx: {
    loader: 'UNETLoader',
    clip: { patterns: ['gemma'], downloadName: 'gemma_3_12B_it_fp8_scaled.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/ltx-2/resolve/main/split_files/text_encoders/gemma_3_12B_it_fp8_scaled.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: false, needsSeparateCLIP: true,
  },
  mochi: {
    loader: 'UNETLoader',
    vae: { patterns: ['mochi'], downloadName: 'mochi_vae.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/mochi_preview_repackaged/resolve/main/split_files/vae/mochi_vae.safetensors', subfolder: 'vae' },
    clip: { patterns: ['t5'], downloadName: 't5xxl_fp16.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/mochi_preview_repackaged/resolve/main/split_files/text_encoders/t5xxl_fp16.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  cosmos: {
    loader: 'UNETLoader',
    vae: { patterns: ['cosmos'], downloadName: 'cosmos_cv8x8x8_1.0.safetensors', downloadUrl: 'https://huggingface.co/comfyanonymous/cosmos_1.0_text_encoder_and_VAE_ComfyUI/resolve/main/vae/cosmos_cv8x8x8_1.0.safetensors', subfolder: 'vae' },
    clip: { patterns: ['oldt5'], downloadName: 'oldt5_xxl_fp8_e4m3fn_scaled.safetensors', downloadUrl: 'https://huggingface.co/comfyanonymous/cosmos_1.0_text_encoder_and_VAE_ComfyUI/resolve/main/text_encoders/oldt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  cogvideo: {
    loader: 'UNETLoader',
    vae: { patterns: ['cogvideox', 'cogvideo'], downloadName: 'cogvideox_vae_bf16.safetensors', downloadUrl: 'https://huggingface.co/Kijai/CogVideoX-comfy/resolve/main/cogvideox_vae_bf16.safetensors', subfolder: 'vae' },
    clip: { patterns: ['t5'], downloadName: 't5xxl_fp16.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/mochi_preview_repackaged/resolve/main/split_files/text_encoders/t5xxl_fp16.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  svd: { loader: 'ImageOnlyCheckpointLoader', needsSeparateVAE: false, needsSeparateCLIP: false },
  framepack: {
    loader: 'UNETLoader',
    vae: { patterns: ['hunyuan', 'wan'], downloadName: 'hunyuanvideo15_vae_fp16.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/vae/hunyuanvideo15_vae_fp16.safetensors', subfolder: 'vae' },
    clip: { patterns: ['llava', 'qwen'], downloadName: 'llava_llama3_fp8_scaled.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/resolve/main/split_files/text_encoders/llava_llama3_fp8_scaled.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  pyramidflow: {
    loader: 'UNETLoader',
    vae: { patterns: ['pyramid'], downloadName: 'pyramid_flow_vae_bf16.safetensors', downloadUrl: 'https://huggingface.co/Kijai/pyramid-flow-comfy/resolve/main/pyramid_flow_vae_bf16.safetensors', subfolder: 'vae' },
    needsSeparateVAE: true, needsSeparateCLIP: false,
  },
  allegro: { loader: 'UNETLoader', needsSeparateVAE: false, needsSeparateCLIP: false },
  unknown: { loader: 'CheckpointLoaderSimple', needsSeparateVAE: false, needsSeparateCLIP: false },
}

// ─── Text Models (HuggingFace GGUF — unified source for all providers) ───

const HF = (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${file}`

/** Sort models by release date, newest first */
function sortByRelease(models: DiscoverModel[]): DiscoverModel[] {
  return models.sort((a, b) => (b.released ?? '').localeCompare(a.released ?? ''))
}

/** Uncensored / abliterated GGUF models — the core of LU. One entry per size variant. */
export function getUncensoredTextModels(): DiscoverModel[] {
  return sortByRelease([
    // ── HOT: Hermes 3 ──
    { name: 'Hermes 3 Llama 3.2 3B', description: 'NousResearch Hermes 3 — uncensored + native tool calling. Lightweight.', pulls: '500K+', tags: ['3B', 'Q4_K_M', '2 GB'], updated: 'Hot', agent: true, released: '2024-08', downloadUrl: HF('bartowski/Hermes-3-Llama-3.2-3B-GGUF', 'Hermes-3-Llama-3.2-3B-Q4_K_M.gguf'), filename: 'Hermes-3-Llama-3.2-3B-Q4_K_M.gguf', sizeGB: 2 },
    { name: 'Hermes 3 Llama 3.1 8B', description: 'NousResearch Hermes 3 — uncensored + native tool calling. THE agent model.', pulls: '500K+', tags: ['8B', 'Q4_K_M', '5 GB'], updated: 'Hot', agent: true, released: '2024-08', downloadUrl: HF('bartowski/Hermes-3-Llama-3.1-8B-GGUF', 'Hermes-3-Llama-3.1-8B-Q4_K_M.gguf'), filename: 'Hermes-3-Llama-3.1-8B-Q4_K_M.gguf', sizeGB: 5 },
    { name: 'Hermes 3 Llama 3.1 70B', description: 'NousResearch Hermes 3 70B — maximum intelligence, uncensored.', pulls: '500K+', tags: ['70B', 'Q4_K_M', '42 GB'], updated: 'Hot', agent: true, released: '2024-08', downloadUrl: HF('bartowski/Hermes-3-Llama-3.1-70B-GGUF', 'Hermes-3-Llama-3.1-70B-Q4_K_M.gguf'), filename: 'Hermes-3-Llama-3.1-70B-Q4_K_M.gguf', sizeGB: 42 },
    // ── HOT: Dolphin 3 ──
    { name: 'Dolphin 3 Llama 3.1 8B', description: 'Dolphin 3 — uncensored from training. Coding, math, general purpose.', pulls: '3.7M', tags: ['8B', 'Q4_K_M', '5 GB'], updated: 'Hot', released: '2024-12', downloadUrl: HF('bartowski/dolphin-2.9.4-llama3.1-8b-GGUF', 'dolphin-2.9.4-llama3.1-8b-Q4_K_M.gguf'), filename: 'dolphin-2.9.4-llama3.1-8b-Q4_K_M.gguf', sizeGB: 5 },
    // ── HOT: Qwen 3.5 Abliterated ──
    { name: 'Qwen 3.5 9B Abliterated', description: 'Qwen 3.5 abliterated — newest, strongest reasoning + coding.', pulls: '10K+', tags: ['9B', 'Q4_K_M', '6 GB'], updated: 'Hot', agent: true, released: '2026-03', downloadUrl: HF('mradermacher/Qwen3.5-9B-abliterated-GGUF', 'Qwen3.5-9B-abliterated.Q4_K_M.gguf'), filename: 'Qwen3.5-9B-abliterated.Q4_K_M.gguf', sizeGB: 5 },
    // ── HOT: GPT-OSS Abliterated ──
    { name: 'GPT-OSS 20B Abliterated', description: 'OpenAI GPT-OSS — abliterated open-source GPT model.', pulls: '15K+', tags: ['20B', 'Q4_K_M', '13 GB'], updated: 'Hot', agent: true, released: '2026-03', downloadUrl: HF('bartowski/huihui-ai_Huihui-gpt-oss-20b-BF16-abliterated-GGUF', 'huihui-ai_Huihui-gpt-oss-20b-BF16-abliterated-Q4_K_M.gguf'), filename: 'huihui-ai_Huihui-gpt-oss-20b-BF16-abliterated-Q4_K_M.gguf', sizeGB: 13 },
    // ── HOT: Qwen 3.6 Uncensored (April 2026) ──
    { name: 'Qwen 3.6 27B Samantha Uncensored', description: 'Qwen 3.6 27B dense — Samantha personality, uncensored finetune. Released April 22 2026. Needs GGUF conversion (see HF).', pulls: 'New', tags: ['27B', 'Vision', 'Uncensored', '50 GB'], updated: 'Hot', agent: true, released: '2026-04', url: 'https://huggingface.co/cloudbjorn/Qwen3.6-27B_Samantha-Uncensored', canPull: false, sizeGB: 50 },
    { name: 'Qwen 3.6 35B MoE Abliterated', description: 'Qwen 3.6 35B MoE abliterated — brand new uncensored. 3B active, vision + agentic coding + thinking. 256K context.', pulls: '1K+', tags: ['35B MoE', 'Vision', 'Q4_K_M', '24 GB'], updated: 'Hot', agent: true, released: '2026-04', ollamaModel: 'huihui_ai/Qwen3.6-abliterated:35b', sizeGB: 24 },
    // ── HOT: Qwen 3.5 Abliterated (larger variants) ──
    { name: 'Qwen 3.5 27B Abliterated', description: 'Qwen 3.5 27B abliterated — Claude Opus-style, strongest reasoning.', pulls: '20K+', tags: ['27B', 'Q4_K_M', '16 GB'], updated: 'Hot', agent: true, released: '2026-03', downloadUrl: HF('mradermacher/Huihui-Qwen3.5-27B-Claude-4.6-Opus-abliterated-GGUF', 'Huihui-Qwen3.5-27B-Claude-4.6-Opus-abliterated.Q4_K_M.gguf'), filename: 'Huihui-Qwen3.5-27B-Claude-4.6-Opus-abliterated.Q4_K_M.gguf', sizeGB: 16 },
    { name: 'Qwen 3.5 35B MoE Abliterated', description: 'Qwen 3.5 35B MoE abliterated — best agentic, 256K context.', pulls: '26K+', tags: ['35B MoE', 'Q4_K_M', '22 GB'], updated: 'Hot', agent: true, released: '2026-03', downloadUrl: HF('mradermacher/Huihui-Qwen3.5-35B-A3B-abliterated-i1-GGUF', 'Huihui-Qwen3.5-35B-A3B-abliterated.i1-Q4_K_M.gguf'), filename: 'Huihui-Qwen3.5-35B-A3B-abliterated.i1-Q4_K_M.gguf', sizeGB: 22 },
    // ── HOT: Qwen3-Coder Abliterated ──
    { name: 'Qwen3-Coder 30B Abliterated', description: 'Qwen3-Coder abliterated — 30B MoE (3B active), built for code agents. 256K context.', pulls: '10K+', tags: ['30B MoE', 'Q4_K_M', '19 GB'], updated: 'Hot', agent: true, released: '2026-02', downloadUrl: HF('mradermacher/Huihui-Qwen3-Coder-30B-A3B-Instruct-abliterated-i1-GGUF', 'Huihui-Qwen3-Coder-30B-A3B-Instruct-abliterated.i1-Q4_K_M.gguf'), filename: 'Huihui-Qwen3-Coder-30B-A3B-Instruct-abliterated.i1-Q4_K_M.gguf', sizeGB: 19 },
    // ── HOT: Gemma 4 Uncensored Variants ──
    { name: 'Gemma 4 31B Uncensored', description: 'Gemma 4 31B uncensored — frontier dense model, native tool calling + vision. 256K context.', pulls: '400+', tags: ['31B', 'Q4_K_M', '17 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('TrevorJS/gemma-4-31B-it-uncensored-GGUF', 'gemma-4-31B-it-uncensored-Q4_K_M.gguf'), filename: 'gemma-4-31B-it-uncensored-Q4_K_M.gguf', sizeGB: 17 },
    { name: 'Gemma 4 26B MoE Heretic', description: 'Gemma 4 26B MoE HERETIC — 26B brain, 4B active. Uncensored + tools + vision.', pulls: '43K+', tags: ['26B MoE', 'Q4_K_M', '16 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('nohurry/gemma-4-26B-A4B-it-heretic-GUFF', 'gemma-4-26b-a4b-it-heretic.q4_k_m.gguf'), filename: 'gemma-4-26b-a4b-it-heretic.q4_k_m.gguf', sizeGB: 16 },
    { name: 'Gemma 4 31B Heretic', description: 'Gemma 4 31B HERETIC — full uncensor, native tool calling, 256K context.', pulls: '32K+', tags: ['31B', 'Q4_K_M', '17 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('Stabhappy/gemma-4-31B-it-heretic-Gguf', 'coder3101_gemma_4_31b_it_heretic-Q4_K_M.gguf'), filename: 'coder3101_gemma_4_31b_it_heretic-Q4_K_M.gguf', sizeGB: 17 },
    { name: 'Gemma 4 31B Abliterated', description: 'Gemma 4 31B abliterated — strong reasoning, Apache 2.0.', pulls: '7K+', tags: ['31B', 'Q4_K_M', '17 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('LiconStudio/Gemma-4-31B-it-abliterated-GGUF', 'gemma-4-31B-it-abliterated-Q4_K_M.gguf'), filename: 'gemma-4-31B-it-abliterated-Q4_K_M.gguf', sizeGB: 17 },
    // ── Popular: Qwen3 Abliterated ──
    { name: 'Qwen3 8B Abliterated', description: 'Qwen3 abliterated — best overall. Exceptional reasoning, coding, multilingual.', pulls: '30K+', tags: ['8B', 'Q4_K_M', '5 GB'], updated: 'Popular', agent: true, released: '2025-05', downloadUrl: HF('mradermacher/Qwen3-8B-abliterated-GGUF', 'Qwen3-8B-abliterated.Q4_K_M.gguf'), filename: 'Qwen3-8B-abliterated.Q4_K_M.gguf', sizeGB: 5 },
    { name: 'Qwen3 30B MoE Abliterated', description: 'Qwen3 30B MoE abliterated — powerful, runs like 3B active.', pulls: '30K+', tags: ['30B MoE', 'Q4_K_M', '19 GB'], updated: 'Popular', agent: true, released: '2025-05', downloadUrl: HF('mradermacher/Qwen3-30B-A3B-abliterated-GGUF', 'Qwen3-30B-A3B-abliterated.Q4_K_M.gguf'), filename: 'Qwen3-30B-A3B-abliterated.Q4_K_M.gguf', sizeGB: 19 },
    // ── Popular: Llama 3.1 8B Abliterated (two quants) ──
    { name: 'Llama 3.1 8B Abliterated Q5', description: 'Llama 3.1 8B abliterated — fast, reliable, great entry point. Higher quality quant.', pulls: '200K+', tags: ['8B', 'Q5_K_M', '6 GB'], updated: 'Popular', agent: true, released: '2024-07', downloadUrl: HF('bartowski/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF', 'Meta-Llama-3.1-8B-Instruct-abliterated-Q5_K_M.gguf'), filename: 'Meta-Llama-3.1-8B-Instruct-abliterated-Q5_K_M.gguf', sizeGB: 6 },
    { name: 'Llama 3.1 8B Abliterated Q4', description: 'Llama 3.1 8B abliterated — fast, reliable, great entry point. Smaller quant.', pulls: '200K+', tags: ['8B', 'Q4_K_M', '5 GB'], updated: 'Popular', agent: true, released: '2024-07', downloadUrl: HF('bartowski/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF', 'Meta-Llama-3.1-8B-Instruct-abliterated-Q4_K_M.gguf'), filename: 'Meta-Llama-3.1-8B-Instruct-abliterated-Q4_K_M.gguf', sizeGB: 5 },
    // ── Popular: DeepSeek R1 Abliterated ──
    { name: 'DeepSeek R1 8B Abliterated', description: 'DeepSeek R1 abliterated 8B — chain-of-thought reasoning.', pulls: '40K+', tags: ['8B', 'Q4_K_M', '5 GB'], updated: 'Popular', released: '2025-01', downloadUrl: HF('mradermacher/DeepSeek-R1-Distill-Qwen-7B-abliterated-v2-GGUF', 'DeepSeek-R1-Distill-Qwen-7B-abliterated-v2.Q4_K_M.gguf'), filename: 'DeepSeek-R1-Distill-Qwen-7B-abliterated-v2.Q4_K_M.gguf', sizeGB: 5 },
    { name: 'DeepSeek R1 14B Abliterated', description: 'DeepSeek R1 abliterated 14B — stronger reasoning.', pulls: '40K+', tags: ['14B', 'Q4_K_M', '9 GB'], updated: 'Popular', released: '2025-01', downloadUrl: HF('QuantFactory/DeepSeek-R1-Distill-Qwen-14B-abliterated-v2-GGUF', 'DeepSeek-R1-Distill-Qwen-14B-abliterated-v2.Q4_K_M.gguf'), filename: 'DeepSeek-R1-Distill-Qwen-14B-abliterated-v2.Q4_K_M.gguf', sizeGB: 9 },
    { name: 'DeepSeek R1 32B Abliterated', description: 'DeepSeek R1 abliterated 32B — powerful reasoning.', pulls: '40K+', tags: ['32B', 'Q4_K_M', '19 GB'], updated: 'Popular', released: '2025-01', downloadUrl: HF('bartowski/DeepSeek-R1-Distill-Qwen-32B-abliterated-GGUF', 'DeepSeek-R1-Distill-Qwen-32B-abliterated-Q4_K_M.gguf'), filename: 'DeepSeek-R1-Distill-Qwen-32B-abliterated-Q4_K_M.gguf', sizeGB: 19 },
    { name: 'DeepSeek R1 70B Abliterated', description: 'DeepSeek R1 abliterated 70B — maximum reasoning for high-VRAM setups.', pulls: '40K+', tags: ['70B', 'Q4_K_M', '42 GB'], updated: 'Popular', released: '2025-01', downloadUrl: HF('bartowski/huihui-ai_DeepSeek-R1-Distill-Llama-70B-abliterated-GGUF', 'huihui-ai_DeepSeek-R1-Distill-Llama-70B-abliterated-Q4_K_M.gguf'), filename: 'huihui-ai_DeepSeek-R1-Distill-Llama-70B-abliterated-Q4_K_M.gguf', sizeGB: 42 },
    // ── HOT: GLM 4.7 Flash Uncensored Heretic ──
    { name: 'GLM 4.7 Flash Heretic IQ2', description: 'GLM 4.7 Flash HERETIC — 30B uncensored, fits 12GB VRAM. Strongest 30B class.', pulls: '5K+', tags: ['30B', 'IQ2_M', '10 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('DavidAU/GLM-4.7-Flash-Uncensored-Heretic-NEO-CODE-Imatrix-MAX-GGUF', 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-IQ2_M.gguf'), filename: 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-IQ2_M.gguf', sizeGB: 10 },
    { name: 'GLM 4.7 Flash Heretic Q4', description: 'GLM 4.7 Flash HERETIC — 30B uncensored, best quality/size balance.', pulls: '5K+', tags: ['30B', 'Q4_K_M', '19 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('DavidAU/GLM-4.7-Flash-Uncensored-Heretic-NEO-CODE-Imatrix-MAX-GGUF', 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-Q4_K_M.gguf'), filename: 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-Q4_K_M.gguf', sizeGB: 19 },
    { name: 'GLM 4.7 Flash Heretic Q6', description: 'GLM 4.7 Flash HERETIC — 30B uncensored, high quality quant.', pulls: '5K+', tags: ['30B', 'Q6_K', '25 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('DavidAU/GLM-4.7-Flash-Uncensored-Heretic-NEO-CODE-Imatrix-MAX-GGUF', 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-Q6_K.gguf'), filename: 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-Q6_K.gguf', sizeGB: 25 },
    { name: 'GLM 4.7 Flash Heretic Q8', description: 'GLM 4.7 Flash HERETIC — 30B uncensored, near-lossless quality.', pulls: '5K+', tags: ['30B', 'Q8_0', '32 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('DavidAU/GLM-4.7-Flash-Uncensored-Heretic-NEO-CODE-Imatrix-MAX-GGUF', 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-Q8_0.gguf'), filename: 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-Q8_0.gguf', sizeGB: 32 },
    // ── Popular: GLM 4.6 Abliterated ──
    { name: 'GLM 4 9B Abliterated', description: 'GLM 4 9B abliterated — strong coding and reasoning.', pulls: '5K+', tags: ['9B', 'Q4_K_M', '5 GB'], updated: 'New', agent: true, released: '2026-03', downloadUrl: HF('bartowski/glm-4-9b-chat-abliterated-GGUF', 'glm-4-9b-chat-abliterated-Q4_K_M.gguf'), filename: 'glm-4-9b-chat-abliterated-Q4_K_M.gguf', sizeGB: 5 },
    // ── Popular: Gemma 3 Abliterated ──
    { name: 'Gemma 3 4B Abliterated', description: 'Google Gemma 3 4B abliterated — lightweight, vision support.', pulls: '20K+', tags: ['4B', 'Q4_K_M', '2.3 GB'], updated: 'Popular', released: '2025-03', downloadUrl: HF('bartowski/mlabonne_gemma-3-4b-it-abliterated-GGUF', 'mlabonne_gemma-3-4b-it-abliterated-Q4_K_M.gguf'), filename: 'mlabonne_gemma-3-4b-it-abliterated-Q4_K_M.gguf', sizeGB: 2.3 },
    { name: 'Gemma 3 12B Abliterated', description: 'Google Gemma 3 12B abliterated — vision support, great quality.', pulls: '20K+', tags: ['12B', 'Q4_K_M', '8 GB'], updated: 'Popular', released: '2025-03', downloadUrl: HF('bartowski/mlabonne_gemma-3-12b-it-abliterated-GGUF', 'mlabonne_gemma-3-12b-it-abliterated-Q4_K_M.gguf'), filename: 'mlabonne_gemma-3-12b-it-abliterated-Q4_K_M.gguf', sizeGB: 8 },
    { name: 'Gemma 3 27B Abliterated', description: 'Google Gemma 3 27B abliterated — strong reasoning + vision.', pulls: '20K+', tags: ['27B', 'Q4_K_M', '17 GB'], updated: 'Popular', released: '2025-03', downloadUrl: HF('bartowski/mlabonne_gemma-3-27b-it-abliterated-GGUF', 'mlabonne_gemma-3-27b-it-abliterated-Q4_K_M.gguf'), filename: 'mlabonne_gemma-3-27b-it-abliterated-Q4_K_M.gguf', sizeGB: 17 },
    // ── Popular: Qwen3 14B Abliterated (two quants) ──
    { name: 'Qwen3 14B Abliterated Q4', description: 'Qwen3 14B abliterated — sweet spot of speed and intelligence.', pulls: '4K+', tags: ['14B', 'Q4_K_M', '9 GB'], updated: 'Recent', agent: true, released: '2025-05', downloadUrl: HF('bartowski/huihui-ai_Qwen3-14B-abliterated-GGUF', 'huihui-ai_Qwen3-14B-abliterated-Q4_K_M.gguf'), filename: 'huihui-ai_Qwen3-14B-abliterated-Q4_K_M.gguf', sizeGB: 9 },
    { name: 'Qwen3 14B Abliterated Q5', description: 'Qwen3 14B abliterated — higher quality quant.', pulls: '4K+', tags: ['14B', 'Q5_K_M', '10 GB'], updated: 'Recent', agent: true, released: '2025-05', downloadUrl: HF('bartowski/huihui-ai_Qwen3-14B-abliterated-GGUF', 'huihui-ai_Qwen3-14B-abliterated-Q5_K_M.gguf'), filename: 'huihui-ai_Qwen3-14B-abliterated-Q5_K_M.gguf', sizeGB: 10 },
    // ── Popular: Qwen 2.5 Abliterated ──
    { name: 'Qwen 2.5 7B Abliterated', description: 'Qwen 2.5 7B abliterated — proven and reliable.', pulls: '50K+', tags: ['7B', 'Q4_K_M', '5 GB'], updated: 'Popular', agent: true, released: '2024-09', downloadUrl: HF('QuantFactory/Qwen2.5-7B-Instruct-abliterated-v2-GGUF', 'Qwen2.5-7B-Instruct-abliterated-v2.Q4_K_M.gguf'), filename: 'Qwen2.5-7B-Instruct-abliterated-v2.Q4_K_M.gguf', sizeGB: 5 },
    { name: 'Qwen 2.5 14B Abliterated', description: 'Qwen 2.5 14B abliterated — stronger reasoning.', pulls: '50K+', tags: ['14B', 'Q4_K_M', '9 GB'], updated: 'Popular', agent: true, released: '2024-09', downloadUrl: HF('mradermacher/Qwen2.5-14B-Instruct-abliterated-GGUF', 'Qwen2.5-14B-Instruct-abliterated.Q4_K_M.gguf'), filename: 'Qwen2.5-14B-Instruct-abliterated.Q4_K_M.gguf', sizeGB: 9 },
    { name: 'Qwen 2.5 32B Abliterated', description: 'Qwen 2.5 32B abliterated — powerful.', pulls: '50K+', tags: ['32B', 'Q4_K_M', '19 GB'], updated: 'Popular', agent: true, released: '2024-09', downloadUrl: HF('RichardErkhov/huihui-ai_-_Qwen2.5-32B-Instruct-abliterated-gguf', 'Qwen2.5-32B-Instruct-abliterated.Q4_K_M.gguf'), filename: 'Qwen2.5-32B-Instruct-abliterated.Q4_K_M.gguf', sizeGB: 19 },
    // ── Popular: Single-size uncensored ──
    { name: 'Llama 3.3 70B Abliterated', description: 'Llama 3.3 70B abliterated — maximum intelligence for high-VRAM setups.', pulls: '15K+', tags: ['70B', 'Q4_K_M', '42 GB'], updated: 'Popular', agent: true, released: '2024-12', downloadUrl: HF('bartowski/Llama-3.3-70B-Instruct-abliterated-GGUF', 'Llama-3.3-70B-Instruct-abliterated-Q4_K_M.gguf'), filename: 'Llama-3.3-70B-Instruct-abliterated-Q4_K_M.gguf', sizeGB: 42 },
    { name: 'Mistral Small 24B Abliterated', description: 'Mistral Small 24B abliterated — powerful, strong multilingual.', pulls: '10K+', tags: ['24B', 'Q4_K_M', '14 GB'], updated: 'Recent', agent: true, released: '2024-09', downloadUrl: HF('bartowski/huihui-ai_Mistral-Small-24B-Instruct-2501-abliterated-GGUF', 'huihui-ai_Mistral-Small-24B-Instruct-2501-abliterated-Q4_K_M.gguf'), filename: 'huihui-ai_Mistral-Small-24B-Instruct-2501-abliterated-Q4_K_M.gguf', sizeGB: 14 },
    { name: 'Phi-4 14B Abliterated', description: 'Microsoft Phi-4 abliterated — excellent at math, logic, structured tasks.', pulls: '8K+', tags: ['14B', 'Q4_K_M', '8 GB'], updated: 'Recent', agent: true, released: '2024-12', downloadUrl: HF('mradermacher/phi-4-abliterated-GGUF', 'phi-4-abliterated.Q4_K_M.gguf'), filename: 'phi-4-abliterated.Q4_K_M.gguf', sizeGB: 8 },
    { name: 'Mistral Nemo 12B Abliterated', description: 'Mistral Nemo 12B abliterated — multilingual powerhouse.', pulls: '5K+', tags: ['12B', 'Q4_K_M', '7 GB'], updated: 'Popular', released: '2024-07', downloadUrl: HF('QuantFactory/Mistral-Nemo-Instruct-2407-abliterated-GGUF', 'Mistral-Nemo-Instruct-2407-abliterated.Q4_K_M.gguf'), filename: 'Mistral-Nemo-Instruct-2407-abliterated.Q4_K_M.gguf', sizeGB: 7 },
  ])
}

/** Mainstream GGUF models — not uncensored but excellent for specific tasks. All URLs verified. */
export function getMainstreamTextModels(): DiscoverModel[] {
  return sortByRelease([
    // ── Gemma 4 (April 2026) ──
    { name: 'Gemma 4 31B', description: 'Google Gemma 4 31B — frontier dense model, native tools + vision. 256K context.', pulls: '100K+', tags: ['31B', 'Q4_K_M', '17 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('unsloth/gemma-4-31B-it-GGUF', 'gemma-4-31B-it-Q4_K_M.gguf'), filename: 'gemma-4-31B-it-Q4_K_M.gguf', sizeGB: 17 },
    { name: 'Gemma 4 26B MoE', description: 'Gemma 4 26B MoE — 26B brain, runs like 4B. Tools + vision. Apache 2.0.', pulls: '100K+', tags: ['26B', 'Q4_K_XL', '16 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('unsloth/gemma-4-26B-A4B-it-GGUF', 'gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf'), filename: 'gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf', sizeGB: 16 },
    { name: 'Gemma 4 E4B', description: 'Gemma 4 E4B — lightweight 4.5B, great for small GPUs.', pulls: '100K+', tags: ['4.5B', 'Q4_K_M', '5 GB'], updated: 'Hot', released: '2026-04', downloadUrl: HF('unsloth/gemma-4-E4B-it-GGUF', 'gemma-4-E4B-it-Q4_K_M.gguf'), filename: 'gemma-4-E4B-it-Q4_K_M.gguf', sizeGB: 5 },
    { name: 'Gemma 4 E2B', description: 'Gemma 4 E2B — ultra-light 2.3B, runs on anything.', pulls: '100K+', tags: ['2.3B', 'Q4_K_M', '3 GB'], updated: 'New', released: '2026-04', downloadUrl: HF('unsloth/gemma-4-E2B-it-GGUF', 'gemma-4-E2B-it-Q4_K_M.gguf'), filename: 'gemma-4-E2B-it-Q4_K_M.gguf', sizeGB: 3 },
    // ── Qwen 3.6 27B DENSE (April 21, 2026 — new release) ──
    { name: 'Qwen 3.6 27B', description: 'Qwen 3.6 27B dense — vision + agentic coding + thinking preservation. 256K context. Recommended default.', pulls: 'New', tags: ['27B', 'Vision', 'Q4_K_M', '16 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('unsloth/Qwen3.6-27B-GGUF', 'Qwen3.6-27B-Q4_K_M.gguf'), filename: 'Qwen3.6-27B-Q4_K_M.gguf', sizeGB: 16 },
    { name: 'Qwen 3.6 27B Q3_K_M', description: 'Qwen 3.6 27B — Q3 quant, fits 12GB VRAM completely. For GPU-only inference.', pulls: 'New', tags: ['27B', 'Vision', 'Q3_K_M', '13 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('unsloth/Qwen3.6-27B-GGUF', 'Qwen3.6-27B-Q3_K_M.gguf'), filename: 'Qwen3.6-27B-Q3_K_M.gguf', sizeGB: 13 },
    { name: 'Qwen 3.6 27B UD-Q4_K_XL', description: 'Qwen 3.6 27B — Unsloth Dynamic 2.0 quant. Better quality per GB than Q4_K_M.', pulls: 'New', tags: ['27B', 'Vision', 'UD-Q4_K_XL', '16 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('unsloth/Qwen3.6-27B-GGUF', 'Qwen3.6-27B-UD-Q4_K_XL.gguf'), filename: 'Qwen3.6-27B-UD-Q4_K_XL.gguf', sizeGB: 16 },
    { name: 'Qwen 3.6 27B UD-IQ2_XXS', description: 'Qwen 3.6 27B — smallest quant (8.7 GB). Runs on 8GB VRAM.', pulls: 'New', tags: ['27B', 'Vision', 'UD-IQ2_XXS', '9 GB'], updated: 'New', released: '2026-04', downloadUrl: HF('unsloth/Qwen3.6-27B-GGUF', 'Qwen3.6-27B-UD-IQ2_XXS.gguf'), filename: 'Qwen3.6-27B-UD-IQ2_XXS.gguf', sizeGB: 9 },
    { name: 'Qwen 3.6 27B Q5_K_M', description: 'Qwen 3.6 27B — Q5 quant, higher quality. For 24GB+ VRAM.', pulls: 'New', tags: ['27B', 'Vision', 'Q5_K_M', '18 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('unsloth/Qwen3.6-27B-GGUF', 'Qwen3.6-27B-Q5_K_M.gguf'), filename: 'Qwen3.6-27B-Q5_K_M.gguf', sizeGB: 18 },
    { name: 'Qwen 3.6 27B Q6_K', description: 'Qwen 3.6 27B — Q6 quant, near-lossless. For high-VRAM setups.', pulls: 'New', tags: ['27B', 'Vision', 'Q6_K', '21 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('unsloth/Qwen3.6-27B-GGUF', 'Qwen3.6-27B-Q6_K.gguf'), filename: 'Qwen3.6-27B-Q6_K.gguf', sizeGB: 21 },
    { name: 'Qwen 3.6 27B Q8_0', description: 'Qwen 3.6 27B — Q8 quant, full quality. 24GB+ VRAM / CPU-friendly.', pulls: 'New', tags: ['27B', 'Vision', 'Q8_0', '27 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('unsloth/Qwen3.6-27B-GGUF', 'Qwen3.6-27B-Q8_0.gguf'), filename: 'Qwen3.6-27B-Q8_0.gguf', sizeGB: 27 },
    // ── Qwen 3.6 35B MoE (April 2026) — power user MoE variants ──
    { name: 'Qwen 3.6 35B MoE', description: 'Qwen 3.6 — 35B MoE (3B active), vision + agentic coding + thinking preservation. 256K context. Power users.', pulls: 'New', tags: ['35B MoE', 'Vision', 'Q4_K_M', '24 GB'], updated: 'Hot', agent: true, released: '2026-04', ollamaModel: 'qwen3.6', sizeGB: 24 },
    { name: 'Qwen 3.6 35B MoE NVFP4', description: 'Qwen 3.6 35B MoE — NVFP4 quant, smallest size. Best for RTX 40-series / Blackwell.', pulls: 'New', tags: ['35B MoE', 'Vision', 'NVFP4', '22 GB'], updated: 'Hot', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-nvfp4', sizeGB: 22 },
    { name: 'Qwen 3.6 35B MoE Coding NVFP4', description: 'Qwen 3.6 coding-specialized — NVFP4 quant, smaller. Best coding benchmarks per GB.', pulls: 'New', tags: ['35B MoE', 'Coding', 'NVFP4', '22 GB'], updated: 'Hot', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-coding-nvfp4', sizeGB: 22 },
    { name: 'Qwen 3.6 35B MoE Q8_0', description: 'Qwen 3.6 35B MoE — Q8 quant, near-lossless quality. For high-VRAM setups.', pulls: 'New', tags: ['35B MoE', 'Vision', 'Q8_0', '39 GB'], updated: 'New', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-q8_0', sizeGB: 39 },
    { name: 'Qwen 3.6 35B MoE MXFP8', description: 'Qwen 3.6 35B MoE — MXFP8 (MicroScaling FP8). Best precision on H100/MI300X.', pulls: 'New', tags: ['35B MoE', 'MXFP8', '38 GB'], updated: 'New', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-mxfp8', sizeGB: 38 },
    { name: 'Qwen 3.6 35B MoE Coding MXFP8', description: 'Qwen 3.6 coding + MXFP8. Highest coding quality on datacenter GPUs.', pulls: 'New', tags: ['35B MoE', 'Coding', 'MXFP8', '38 GB'], updated: 'New', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-coding-mxfp8', sizeGB: 38 },
    { name: 'Qwen 3.6 35B MoE BF16', description: 'Qwen 3.6 35B MoE — BF16 full precision. Reference quality, big VRAM only.', pulls: 'New', tags: ['35B MoE', 'Vision', 'BF16', '71 GB'], updated: 'New', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-bf16', sizeGB: 71 },
    { name: 'Qwen 3.6 35B MoE Coding BF16', description: 'Qwen 3.6 coding specialist — BF16 full precision. Reference coding quality.', pulls: 'New', tags: ['35B MoE', 'Coding', 'BF16', '70 GB'], updated: 'New', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-coding-bf16', sizeGB: 70 },
    { name: 'Qwen 3.6 35B MoE MLX BF16', description: 'Qwen 3.6 35B MoE — MLX BF16. Optimized for Apple Silicon (M2/M3/M4).', pulls: 'New', tags: ['35B MoE', 'MLX', 'BF16', '70 GB'], updated: 'New', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-mlx-bf16', sizeGB: 70 },
    // ── Qwen 3.5 (March 2026) ──
    { name: 'Qwen 3.5 35B MoE', description: 'Qwen 3.5 35B MoE — best agentic, 256K context. SWE-bench leader.', pulls: '100K+', tags: ['35B', 'Q4_K_M', '21 GB'], updated: 'Hot', agent: true, released: '2026-03', downloadUrl: HF('unsloth/Qwen3.5-35B-A3B-GGUF', 'Qwen3.5-35B-A3B-Q4_K_M.gguf'), filename: 'Qwen3.5-35B-A3B-Q4_K_M.gguf', sizeGB: 21 },
    { name: 'Qwen 3.5 27B', description: 'Qwen 3.5 27B dense — strongest reasoning + coding.', pulls: '100K+', tags: ['27B', 'Q4_K_M', '16 GB'], updated: 'Hot', agent: true, released: '2026-03', downloadUrl: HF('unsloth/Qwen3.5-27B-GGUF', 'Qwen3.5-27B-Q4_K_M.gguf'), filename: 'Qwen3.5-27B-Q4_K_M.gguf', sizeGB: 16 },
    { name: 'Qwen 3.5 9B', description: 'Qwen 3.5 9B — excellent balance of speed and quality.', pulls: '100K+', tags: ['9B', 'Q4_K_M', '5 GB'], updated: 'New', agent: true, released: '2026-03', downloadUrl: HF('unsloth/Qwen3.5-9B-GGUF', 'Qwen3.5-9B-Q4_K_M.gguf'), filename: 'Qwen3.5-9B-Q4_K_M.gguf', sizeGB: 5 },
    // ── GPT-OSS (March 2026) ──
    { name: 'GPT-OSS 20B', description: 'OpenAI GPT-OSS — open-source GPT model, strong all-rounder.', pulls: '100K+', tags: ['20B', 'Q4_K_M', '11 GB'], updated: 'Hot', agent: true, released: '2026-03', downloadUrl: HF('unsloth/gpt-oss-20b-GGUF', 'gpt-oss-20b-Q4_K_M.gguf'), filename: 'gpt-oss-20b-Q4_K_M.gguf', sizeGB: 11 },
    // ── Qwen3-Coder (Feb-March 2026) ──
    { name: 'Qwen3-Coder 30B', description: 'Qwen3-Coder — 30B MoE coding agent (3B active). Native tool calling, 256K context.', pulls: '100K+', tags: ['30B MoE', 'Q4_K_M', '17 GB'], updated: 'New', agent: true, released: '2026-02', downloadUrl: HF('unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF', 'Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf'), filename: 'Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf', sizeGB: 17 },
    { name: 'Qwen3-Coder-Next', description: 'Qwen3-Coder-Next — 80B MoE, optimized for agentic coding.', pulls: '10K+', tags: ['80B MoE', 'Q4_K_M', '45 GB'], updated: 'Hot', agent: true, released: '2026-03', downloadUrl: HF('unsloth/Qwen3-Coder-Next-GGUF', 'Qwen3-Coder-Next-Q4_K_M.gguf'), filename: 'Qwen3-Coder-Next-Q4_K_M.gguf', sizeGB: 45 },
    // ── GLM 4.7 Flash (April 2026) ──
    { name: 'GLM 4.7 Flash IQ2', description: 'ZhipuAI GLM 4.7 Flash — strongest 30B class model. Fits 12GB VRAM. 198K context.', pulls: '50K+', tags: ['30B', 'IQ2_M', '10 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('bartowski/zai-org_GLM-4.7-Flash-GGUF', 'zai-org_GLM-4.7-Flash-IQ2_M.gguf'), filename: 'zai-org_GLM-4.7-Flash-IQ2_M.gguf', sizeGB: 10 },
    { name: 'GLM 4.7 Flash Q2', description: 'ZhipuAI GLM 4.7 Flash — 30B, low VRAM quant. 198K context.', pulls: '50K+', tags: ['30B', 'Q2_K_L', '11 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('bartowski/zai-org_GLM-4.7-Flash-GGUF', 'zai-org_GLM-4.7-Flash-Q2_K_L.gguf'), filename: 'zai-org_GLM-4.7-Flash-Q2_K_L.gguf', sizeGB: 11 },
    { name: 'GLM 4.7 Flash Q3', description: 'ZhipuAI GLM 4.7 Flash — 30B, balanced quality. 198K context.', pulls: '50K+', tags: ['30B', 'Q3_K_M', '14 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('bartowski/zai-org_GLM-4.7-Flash-GGUF', 'zai-org_GLM-4.7-Flash-Q3_K_M.gguf'), filename: 'zai-org_GLM-4.7-Flash-Q3_K_M.gguf', sizeGB: 14 },
    { name: 'GLM 4.7 Flash Q4', description: 'ZhipuAI GLM 4.7 Flash — 30B, recommended quality. 198K context.', pulls: '50K+', tags: ['30B', 'Q4_K_M', '18 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('bartowski/zai-org_GLM-4.7-Flash-GGUF', 'zai-org_GLM-4.7-Flash-Q4_K_M.gguf'), filename: 'zai-org_GLM-4.7-Flash-Q4_K_M.gguf', sizeGB: 18 },
    { name: 'GLM 4.7 Flash Q5', description: 'ZhipuAI GLM 4.7 Flash — 30B, high quality. 198K context.', pulls: '50K+', tags: ['30B', 'Q5_K_M', '22 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('bartowski/zai-org_GLM-4.7-Flash-GGUF', 'zai-org_GLM-4.7-Flash-Q5_K_M.gguf'), filename: 'zai-org_GLM-4.7-Flash-Q5_K_M.gguf', sizeGB: 22 },
    { name: 'GLM 4.7 Flash Q6', description: 'ZhipuAI GLM 4.7 Flash — 30B, near-lossless. 198K context.', pulls: '50K+', tags: ['30B', 'Q6_K', '25 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('bartowski/zai-org_GLM-4.7-Flash-GGUF', 'zai-org_GLM-4.7-Flash-Q6_K.gguf'), filename: 'zai-org_GLM-4.7-Flash-Q6_K.gguf', sizeGB: 25 },
    { name: 'GLM 4.7 Flash Q8', description: 'ZhipuAI GLM 4.7 Flash — 30B, maximum quality. 198K context.', pulls: '50K+', tags: ['30B', 'Q8_0', '32 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('bartowski/zai-org_GLM-4.7-Flash-GGUF', 'zai-org_GLM-4.7-Flash-Q8_0.gguf'), filename: 'zai-org_GLM-4.7-Flash-Q8_0.gguf', sizeGB: 32 },
    // ── GLM 5.1 (April 2026) ──
    { name: 'GLM 5.1 754B MoE', description: 'ZhipuAI GLM 5.1 — 754B MoE (40B active). Frontier agentic engineering model. MIT license. Needs multi-file download via CLI.', pulls: '50K+', tags: ['754B MoE', 'IQ2_M', '236 GB'], updated: 'Hot', agent: true, released: '2026-04', url: 'https://huggingface.co/unsloth/GLM-5.1-GGUF', canPull: false, sizeGB: 236 },
    // ── DeepSeek R1 (Jan-Jun 2025) ──
    { name: 'DeepSeek R1 Qwen3 8B', description: 'DeepSeek R1 distilled into Qwen3 8B — chain-of-thought reasoning.', pulls: '2M+', tags: ['8B', 'Q4_K_M', '5 GB'], updated: 'Popular', released: '2025-06', downloadUrl: HF('unsloth/DeepSeek-R1-0528-Qwen3-8B-GGUF', 'DeepSeek-R1-0528-Qwen3-8B-Q4_K_M.gguf'), filename: 'DeepSeek-R1-0528-Qwen3-8B-Q4_K_M.gguf', sizeGB: 5 },
    { name: 'DeepSeek R1 Qwen 14B', description: 'DeepSeek R1 distilled into Qwen 14B — stronger reasoning.', pulls: '2M+', tags: ['14B', 'Q4_K_M', '9 GB'], updated: 'Popular', released: '2025-01', downloadUrl: HF('unsloth/DeepSeek-R1-Distill-Qwen-14B-GGUF', 'DeepSeek-R1-Distill-Qwen-14B-Q4_K_M.gguf'), filename: 'DeepSeek-R1-Distill-Qwen-14B-Q4_K_M.gguf', sizeGB: 9 },
    { name: 'DeepSeek R1 Qwen 32B', description: 'DeepSeek R1 distilled into Qwen 32B — powerful reasoning.', pulls: '2M+', tags: ['32B', 'Q4_K_M', '19 GB'], updated: 'Popular', released: '2025-01', downloadUrl: HF('unsloth/DeepSeek-R1-Distill-Qwen-32B-GGUF', 'DeepSeek-R1-Distill-Qwen-32B-Q4_K_M.gguf'), filename: 'DeepSeek-R1-Distill-Qwen-32B-Q4_K_M.gguf', sizeGB: 19 },
    { name: 'DeepSeek R1 Llama 70B', description: 'DeepSeek R1 distilled into Llama 70B — maximum reasoning.', pulls: '2M+', tags: ['70B', 'Q4_K_M', '42 GB'], updated: 'Popular', released: '2025-01', downloadUrl: HF('unsloth/DeepSeek-R1-Distill-Llama-70B-GGUF', 'DeepSeek-R1-Distill-Llama-70B-Q4_K_M.gguf'), filename: 'DeepSeek-R1-Distill-Llama-70B-Q4_K_M.gguf', sizeGB: 42 },
    // ── Qwen 3 (May 2025) ──
    { name: 'Qwen 3 4B', description: 'Qwen 3 4B — fast, lightweight, solid for small GPUs.', pulls: '5M+', tags: ['4B', 'Q4_K_M', '2.3 GB'], updated: 'Popular', released: '2025-05', downloadUrl: HF('unsloth/Qwen3-4B-GGUF', 'Qwen3-4B-Q4_K_M.gguf'), filename: 'Qwen3-4B-Q4_K_M.gguf', sizeGB: 2.3 },
    { name: 'Qwen 3 8B', description: 'Qwen 3 8B — top-tier reasoning and coding. Thinking mode.', pulls: '5M+', tags: ['8B', 'Q4_K_M', '5 GB'], updated: 'Popular', agent: true, released: '2025-05', downloadUrl: HF('unsloth/Qwen3-8B-GGUF', 'Qwen3-8B-Q4_K_M.gguf'), filename: 'Qwen3-8B-Q4_K_M.gguf', sizeGB: 5 },
    { name: 'Qwen 3 14B', description: 'Qwen 3 14B — sweet spot of speed and quality.', pulls: '5M+', tags: ['14B', 'Q4_K_M', '9 GB'], updated: 'Popular', agent: true, released: '2025-05', downloadUrl: HF('unsloth/Qwen3-14B-GGUF', 'Qwen3-14B-Q4_K_M.gguf'), filename: 'Qwen3-14B-Q4_K_M.gguf', sizeGB: 9 },
    { name: 'Qwen 3 32B', description: 'Qwen 3 32B — powerful reasoning and coding.', pulls: '5M+', tags: ['32B', 'Q4_K_XL', '20 GB'], updated: 'Popular', agent: true, released: '2025-05', downloadUrl: HF('unsloth/Qwen3-32B-GGUF', 'Qwen3-32B-UD-Q4_K_XL.gguf'), filename: 'Qwen3-32B-UD-Q4_K_XL.gguf', sizeGB: 20 },
    // ── Llama 4 (April 2025) ──
    { name: 'Llama 4 Scout', description: 'Meta Llama 4 Scout — 16x17B MoE. Massive context window.', pulls: '1M+', tags: ['Scout', 'Q2_K_XL', '40 GB'], updated: 'New', agent: true, released: '2025-04', downloadUrl: HF('unsloth/Llama-4-Scout-17B-16E-Instruct-GGUF', 'Llama-4-Scout-17B-16E-Instruct-UD-Q2_K_XL.gguf'), filename: 'Llama-4-Scout-17B-16E-Instruct-UD-Q2_K_XL.gguf', sizeGB: 40 },
    // ── Gemma 3 (March 2025) ──
    { name: 'Gemma 3 12B', description: 'Google Gemma 3 12B — vision support, great quality.', pulls: '100K+', tags: ['12B', 'Q4_K_M', '8 GB'], updated: 'Popular', released: '2025-03', downloadUrl: HF('unsloth/gemma-3-12b-it-GGUF', 'gemma-3-12b-it-Q4_K_M.gguf'), filename: 'gemma-3-12b-it-Q4_K_M.gguf', sizeGB: 8 },
    { name: 'Gemma 3 27B', description: 'Google Gemma 3 27B — strong reasoning + vision.', pulls: '100K+', tags: ['27B', 'Q4_K_M', '17 GB'], updated: 'Popular', released: '2025-03', downloadUrl: HF('unsloth/gemma-3-27b-it-GGUF', 'gemma-3-27b-it-Q4_K_M.gguf'), filename: 'gemma-3-27b-it-Q4_K_M.gguf', sizeGB: 17 },
    // ── Phi 4 (Dec 2024) ──
    { name: 'Phi-4 14B', description: 'Microsoft Phi-4 — excellent at math, logic, structured tasks.', pulls: '500K+', tags: ['14B', 'Q4_K_M', '9 GB'], updated: 'Popular', agent: true, released: '2024-12', downloadUrl: HF('bartowski/phi-4-GGUF', 'phi-4-Q4_K_M.gguf'), filename: 'phi-4-Q4_K_M.gguf', sizeGB: 9 },
    // ── Llama 3.3 / 3.1 ──
    { name: 'Llama 3.3 70B', description: 'Meta Llama 3.3 70B — maximum intelligence for high-end setups.', pulls: '1M+', tags: ['70B', 'Q4_K_M', '42 GB'], updated: 'Popular', agent: true, released: '2024-12', downloadUrl: HF('bartowski/Llama-3.3-70B-Instruct-GGUF', 'Llama-3.3-70B-Instruct-Q4_K_M.gguf'), filename: 'Llama-3.3-70B-Instruct-Q4_K_M.gguf', sizeGB: 42 },
    { name: 'Llama 3.1 8B', description: 'Meta Llama 3.1 8B — fast, reliable, great entry point.', pulls: '1M+', tags: ['8B', 'Q4_K_M', '5 GB'], updated: 'Popular', agent: true, released: '2024-07', downloadUrl: HF('bartowski/Meta-Llama-3.1-8B-Instruct-GGUF', 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf'), filename: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf', sizeGB: 5 },
    // ── Mistral ──
    { name: 'Mistral Small 24B', description: 'Mistral Small — fast, multilingual, native tool calling.', pulls: '300K+', tags: ['24B', 'Q4_K_M', '14 GB'], updated: 'Popular', agent: true, released: '2024-09', downloadUrl: HF('bartowski/Mistral-Small-24B-Instruct-2501-GGUF', 'Mistral-Small-24B-Instruct-2501-Q4_K_M.gguf'), filename: 'Mistral-Small-24B-Instruct-2501-Q4_K_M.gguf', sizeGB: 14 },
    { name: 'Mistral Nemo 12B', description: 'Mistral Nemo 12B — multilingual powerhouse.', pulls: '300K+', tags: ['12B', 'Q4_K_M', '7 GB'], updated: 'Popular', released: '2024-07', downloadUrl: HF('bartowski/Mistral-Nemo-Instruct-2407-GGUF', 'Mistral-Nemo-Instruct-2407-Q4_K_M.gguf'), filename: 'Mistral-Nemo-Instruct-2407-Q4_K_M.gguf', sizeGB: 7 },
    // ── Qwen 2.5 ──
    { name: 'Qwen 2.5 7B', description: 'Qwen 2.5 7B — proven and reliable all-rounder.', pulls: '100K+', tags: ['7B', 'Q4_K_M', '5 GB'], updated: 'Popular', agent: true, released: '2024-09', downloadUrl: HF('bartowski/Qwen2.5-7B-Instruct-GGUF', 'Qwen2.5-7B-Instruct-Q4_K_M.gguf'), filename: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf', sizeGB: 5 },
  ])
}

// ─── Multi-Provider Discovery ───

/** Fetch models from an OpenAI-compatible provider */
export async function getOpenAIProviderModels(providerName: string): Promise<DiscoverModel[]> {
  try {
    const { getProvider } = await import('./providers/registry')
    const provider = getProvider('openai')
    const models = await provider.listModels()
    return models.map(m => ({
      name: m.id,
      description: m.name !== m.id ? m.name : '',
      pulls: '',
      tags: m.contextLength ? [`${Math.round(m.contextLength / 1024)}K ctx`] : [],
      updated: '',
      provider: 'openai' as ProviderId,
      providerName,
      canPull: false,
      agent: m.supportsTools,
    }))
  } catch {
    return []
  }
}

/** Fetch Anthropic Claude models */
export async function getAnthropicModels(): Promise<DiscoverModel[]> {
  try {
    const { getProvider } = await import('./providers/registry')
    const provider = getProvider('anthropic')
    const models = await provider.listModels()
    return models.map(m => ({
      name: m.id,
      description: m.name,
      pulls: '',
      tags: [
        m.contextLength ? `${Math.round(m.contextLength / 1000)}K ctx` : '',
        m.supportsTools ? 'Tools' : '',
        m.supportsVision ? 'Vision' : '',
      ].filter(Boolean),
      updated: '',
      provider: 'anthropic' as ProviderId,
      providerName: 'Anthropic',
      canPull: false,
      agent: m.supportsTools,
    }))
  } catch {
    return []
  }
}

/** Search HuggingFace for GGUF models */
/**
 * Derive the guessed Q4_K_M filename for a HuggingFace repo name like
 * "TinyLlama-1.1B-Chat-v1.0-Q4_K_M-GGUF" → "TinyLlama-1.1B-Chat-v1.0-Q4_K_M.gguf".
 *
 * Heuristic:
 *   - strip a trailing "-GGUF" / "-gguf"
 *   - if the base already ends with a quant suffix (Q4_K_M, UD-IQ2_XXS, …),
 *     keep it and just append ".gguf" — otherwise HF returns 404 because the
 *     actual file is "basename.gguf", not "basename-Q4_K_M.gguf"
 *   - else default to "{basename}-Q4_K_M.gguf"
 *
 * Exported so the E2E regression test can exercise the edge cases without
 * hitting the live HF API.
 */
export function deriveQ4FilenameFromRepo(repoName: string): string {
  const baseName = repoName.replace(/-GGUF$/i, '').replace(/-gguf$/i, '')
  const QUANT_SUFFIX = /-(Q[0-9]+_K_[MSL]|Q[0-9]_[0-9]+|IQ[0-9]_[A-Z]+(?:_[A-Z]+)?|UD-Q[0-9A-Z_]+|UD-IQ[0-9A-Z_]+|BF16|FP16|F16|F32)$/i
  return QUANT_SUFFIX.test(baseName) ? `${baseName}.gguf` : `${baseName}-Q4_K_M.gguf`
}

export async function searchHuggingFaceModels(query: string): Promise<DiscoverModel[]> {
  try {
    const searchQuery = query.includes('gguf') ? query : `${query} gguf`
    const url = `https://huggingface.co/api/models?search=${encodeURIComponent(searchQuery)}&filter=gguf&sort=downloads&direction=-1&limit=20`

    let json: string
    const { isTauri, fetchExternal } = await import('./backend')
    if (isTauri()) {
      json = await fetchExternal(url)
    } else {
      const res = await fetch(url)
      json = await res.text()
    }

    const repos: Array<{ id: string; downloads?: number; modelId?: string }> = JSON.parse(json)

    const models: DiscoverModel[] = []
    for (const repo of repos) {
      const repoName = repo.id.split('/').pop() || ''
      const q4File = deriveQ4FilenameFromRepo(repoName)
      const downloadUrl = `https://huggingface.co/${repo.id}/resolve/main/${q4File}`

      const downloads = repo.downloads || 0
      const pullsStr = downloads > 1000000 ? `${(downloads / 1000000).toFixed(1)}M` :
        downloads > 1000 ? `${Math.round(downloads / 1000)}K` : `${downloads}`

      models.push({
        name: baseName,
        description: repo.id,
        pulls: pullsStr,
        tags: ['Q4_K_M', 'GGUF'],
        updated: '',
        downloadUrl,
        filename: q4File,
        url: `https://huggingface.co/${repo.id}`,
      })
    }
    return models
  } catch {
    return []
  }
}

/** Detect the model directory for the active local provider */
export async function detectProviderModelPath(providerName: string): Promise<string | null> {
  try {
    return await backendCall('detect_model_path', { provider: providerName })
  } catch {
    return null
  }
}

/** Download a GGUF model to a specific directory (for non-Ollama providers) */
export async function startModelDownloadToPath(url: string, destDir: string, filename: string, expectedBytes?: number): Promise<{ status: string; id: string; error?: string }> {
  return backendCall('download_model_to_path', { url, destDir, filename, expectedBytes: expectedBytes ?? null })
}

/** Look up download URL + subfolder for a file by filename — searches all bundles + text models */
export function lookupFileMeta(filename: string): { url: string; subfolder: string } | null {
  // Search image + video bundles
  for (const bundle of [...getImageBundles(), ...getVideoBundles()]) {
    for (const f of bundle.files) {
      if (f.filename === filename && f.downloadUrl && f.subfolder) {
        return { url: f.downloadUrl, subfolder: f.subfolder }
      }
    }
  }
  // Search text models
  for (const m of [...getUncensoredTextModels(), ...getMainstreamTextModels()]) {
    if (m.filename === filename && m.downloadUrl && m.subfolder) {
      return { url: m.downloadUrl, subfolder: m.subfolder }
    }
  }
  return null
}

// ─── Image Model Bundles ───

export function getImageBundles(): ModelBundle[] {
  return [
    {
      name: 'Juggernaut XL V9 (Photorealistic)',
      description: 'Best photorealistic SDXL checkpoint. All-in-one — just install and generate.',
      tags: ['SDXL', 'Photorealistic', '1024px'],
      uncensored: true,
      verified: true,
      totalSizeGB: 6.5,
      vramRequired: '6-8 GB',
      workflow: 'sdxl',
      url: 'https://huggingface.co/RunDiffusion/Juggernaut-XL-v9',
      files: [
        {
          name: 'Juggernaut XL V9 Photo v2',
          description: 'SDXL checkpoint — includes VAE and CLIP.',
          pulls: '', tags: ['Checkpoint', '6.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/RunDiffusion/Juggernaut-XL-v9/resolve/main/Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors',
          filename: 'Juggernaut-XL_v9.safetensors', subfolder: 'checkpoints', sizeGB: 6.5,
        },
      ],
    },
    {
      name: 'RealVisXL V5 (Photorealistic)',
      description: 'Great for portraits, landscapes, and product photos. Ready to use.',
      tags: ['SDXL', 'Photorealistic', '1024px'],
      uncensored: true,
      verified: true,
      totalSizeGB: 6.5,
      vramRequired: '6-8 GB',
      workflow: 'sdxl',
      url: 'https://huggingface.co/SG161222/RealVisXL_V5.0',
      files: [
        {
          name: 'RealVisXL V5 FP16',
          description: 'SDXL checkpoint — includes VAE and CLIP.',
          pulls: '', tags: ['Checkpoint', '6.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/SG161222/RealVisXL_V5.0/resolve/main/RealVisXL_V5.0_fp16.safetensors',
          filename: 'RealVisXL_V5.safetensors', subfolder: 'checkpoints', sizeGB: 6.5,
        },
      ],
    },
    {
      name: 'FLUX.1 [schnell] FP8 (Fast & Modern)',
      description: 'State-of-the-art image gen. 1-4 steps for fast results. Complete package with all required encoders.',
      tags: ['FLUX', 'Fast', 'FP8', '1024px'],
      verified: true,
      totalSizeGB: 21,
      vramRequired: '8-10 GB',
      workflow: 'flux',
      url: 'https://huggingface.co/Comfy-Org/flux1-schnell',
      files: [
        {
          name: 'FLUX.1 schnell FP8',
          description: 'The main FLUX diffusion model (quantized).',
          pulls: '', tags: ['Model', '16 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/flux1-schnell/resolve/main/flux1-schnell-fp8.safetensors',
          filename: 'flux1-schnell-fp8.safetensors', subfolder: 'diffusion_models', sizeGB: 16.1,
        },
        {
          name: 'FLUX VAE',
          description: 'Required autoencoder for FLUX.',
          pulls: '', tags: ['VAE', '335 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/resolve/main/split_files/vae/flux2-vae.safetensors',
          filename: 'flux2-vae.safetensors', subfolder: 'vae', sizeGB: 0.3,
        },
        {
          name: 'T5-XXL Text Encoder (FP8)',
          description: 'Required text encoder for FLUX prompt understanding.',
          pulls: '', tags: ['Text Encoder', '3.9 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors',
          filename: 't5xxl_fp8_e4m3fn.safetensors', subfolder: 'text_encoders', sizeGB: 3.9,
        },
        {
          name: 'CLIP-L Text Encoder',
          description: 'Required secondary text encoder for FLUX.',
          pulls: '', tags: ['Text Encoder', '240 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors',
          filename: 'clip_l.safetensors', subfolder: 'text_encoders', sizeGB: 0.2,
        },
      ],
    },
    {
      name: 'FLUX.1 [dev] FP8 (High Quality)',
      description: 'Highest quality FLUX. More steps but better results. Complete package with all required encoders.',
      tags: ['FLUX', 'Quality', 'FP8', '1024px'],
      verified: true,
      totalSizeGB: 21,
      vramRequired: '8-10 GB',
      workflow: 'flux',
      url: 'https://huggingface.co/Comfy-Org/flux1-dev',
      files: [
        {
          name: 'FLUX.1 dev FP8',
          description: 'The main FLUX diffusion model (dev, quantized).',
          pulls: '', tags: ['Model', '16 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/flux1-dev/resolve/main/flux1-dev-fp8.safetensors',
          filename: 'flux1-dev-fp8.safetensors', subfolder: 'diffusion_models', sizeGB: 16.1,
        },
        {
          name: 'FLUX VAE',
          description: 'Required autoencoder for FLUX.',
          pulls: '', tags: ['VAE', '335 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/resolve/main/split_files/vae/flux2-vae.safetensors',
          filename: 'flux2-vae.safetensors', subfolder: 'vae', sizeGB: 0.3,
        },
        {
          name: 'T5-XXL Text Encoder (FP8)',
          description: 'Required text encoder for FLUX prompt understanding.',
          pulls: '', tags: ['Text Encoder', '3.9 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors',
          filename: 't5xxl_fp8_e4m3fn.safetensors', subfolder: 'text_encoders', sizeGB: 3.9,
        },
        {
          name: 'CLIP-L Text Encoder',
          description: 'Required secondary text encoder for FLUX.',
          pulls: '', tags: ['Text Encoder', '240 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors',
          filename: 'clip_l.safetensors', subfolder: 'text_encoders', sizeGB: 0.2,
        },
      ],
    },
    {
      name: 'FLUX 2 Klein 4B (Next-Gen)',
      description: 'Latest FLUX architecture. Fastest FLUX model with stunning quality. Includes Qwen 3 text encoder.',
      tags: ['FLUX 2', 'Fast', '1024px'],
      verified: true,
      totalSizeGB: 11.1,
      vramRequired: '8-10 GB',
      workflow: 'flux2',
      url: 'https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b',
      files: [
        {
          name: 'FLUX 2 Klein Base 4B',
          description: 'FLUX 2 Klein diffusion model — next-gen image generation.',
          pulls: '', tags: ['Diffusion Model', '7.2 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/resolve/main/split_files/diffusion_models/flux-2-klein-base-4b.safetensors',
          filename: 'flux-2-klein-base-4b.safetensors', subfolder: 'diffusion_models', sizeGB: 7.2,
        },
        {
          name: 'FLUX 2 VAE',
          description: 'Required autoencoder for FLUX 2.',
          pulls: '', tags: ['VAE', '335 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/resolve/main/split_files/vae/flux2-vae.safetensors',
          filename: 'flux2-vae.safetensors', subfolder: 'vae', sizeGB: 0.3,
        },
        {
          name: 'Qwen 3 4B Text Encoder (FP4)',
          description: 'Required text encoder for FLUX 2 Klein prompt understanding.',
          pulls: '', tags: ['Text Encoder', '~3.5 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/resolve/main/split_files/text_encoders/qwen_3_4b_fp4_flux2.safetensors',
          filename: 'qwen_3_4b_fp4_flux2.safetensors', subfolder: 'text_encoders', sizeGB: 3.5,
        },
      ],
    },
    {
      name: 'Z-Image Turbo (Uncensored, Fast)',
      description: 'Explicitly uncensored image model. 8-15 seconds per image. No safety filters. Text-to-Image and Image-to-Image.',
      tags: ['Z-Image', 'Uncensored', 'Fast', '1024px'],
      uncensored: true,
      verified: true,
      totalSizeGB: 19.3,
      vramRequired: '10-16 GB',
      workflow: 'zimage',
      url: 'https://huggingface.co/Comfy-Org/z_image_turbo',
      files: [
        {
          name: 'Z-Image Turbo BF16',
          description: 'Uncensored diffusion model — no safety filters, fast generation.',
          pulls: '', tags: ['Diffusion Model', '11.5 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors',
          filename: 'z_image_turbo_bf16.safetensors', subfolder: 'diffusion_models', sizeGB: 11.5,
        },
        {
          name: 'Z-Image VAE',
          description: 'Required autoencoder for Z-Image Turbo.',
          pulls: '', tags: ['VAE', '335 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors',
          filename: 'ae.safetensors', subfolder: 'vae', sizeGB: 0.3,
        },
        {
          name: 'Qwen 3 4B Text Encoder',
          description: 'Required text encoder for Z-Image Turbo prompt understanding.',
          pulls: '', tags: ['Text Encoder', '7.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors',
          filename: 'qwen_3_4b.safetensors', subfolder: 'text_encoders', sizeGB: 7.5,
        },
      ],
    },
    {
      name: 'Z-Image Base (Uncensored, Quality)',
      description: 'Highest quality uncensored model. 30-50 steps for maximum detail and composition diversity. Shares VAE/CLIP with Z-Image Turbo.',
      tags: ['Z-Image', 'Uncensored', 'Quality', '1024px'],
      uncensored: true,
      verified: true,
      totalSizeGB: 19.3,
      vramRequired: '10-16 GB',
      workflow: 'zimage',
      url: 'https://huggingface.co/Comfy-Org/z_image',
      files: [
        {
          name: 'Z-Image Base BF16',
          description: 'Uncensored diffusion model — maximum quality, more compositional diversity.',
          pulls: '', tags: ['Diffusion Model', '11.5 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/diffusion_models/z_image_bf16.safetensors',
          filename: 'z_image_bf16.safetensors', subfolder: 'diffusion_models', sizeGB: 11.5,
        },
        {
          name: 'Z-Image VAE',
          description: 'Required autoencoder — shared with Z-Image Turbo.',
          pulls: '', tags: ['VAE', '335 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/vae/ae.safetensors',
          filename: 'ae.safetensors', subfolder: 'vae', sizeGB: 0.3,
        },
        {
          name: 'Qwen 3 4B Text Encoder',
          description: 'Required text encoder — shared with Z-Image Turbo.',
          pulls: '', tags: ['Text Encoder', '7.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors',
          filename: 'qwen_3_4b.safetensors', subfolder: 'text_encoders', sizeGB: 7.5,
        },
      ],
    },
    {
      name: 'DreamShaper XL Turbo V2 (Anime/Stylized)',
      description: 'Fast anime and stylized art. Turbo mode for 4-step generation. Great for creative work.',
      tags: ['SDXL', 'Anime', 'Stylized', 'Turbo', '1024px'],
      uncensored: true,
      verified: true,
      totalSizeGB: 6.5,
      vramRequired: '6-8 GB',
      workflow: 'sdxl',
      url: 'https://huggingface.co/Lykon/dreamshaper-xl-v2-turbo',
      files: [
        {
          name: 'DreamShaper XL Turbo V2',
          description: 'SDXL checkpoint — anime and stylized art, turbo mode.',
          pulls: '', tags: ['Checkpoint', '6.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Lykon/dreamshaper-xl-v2-turbo/resolve/main/DreamShaperXL_Turbo_V2-SFW.safetensors',
          filename: 'DreamShaperXL_Turbo_V2.safetensors', subfolder: 'checkpoints', sizeGB: 6.5,
        },
      ],
    },
    {
      name: 'ERNIE-Image Turbo',
      description: 'Baidu ERNIE-Image Turbo — 8B DiT, 8 steps, 1024x1024. Fastest ERNIE variant with Ministral-3B encoder + Prompt Enhancer.',
      tags: ['ernie_image', 'Image', '1024x1024'],
      uncensored: false,
      verified: true,
      totalSizeGB: 28.9,
      vramRequired: '24 GB',
      workflow: 'ernie_image',
      url: 'https://huggingface.co/Comfy-Org/ERNIE-Image',
      files: [
        {
          name: 'ERNIE-Image Turbo (DiT 8B)',
          description: 'Baidu ERNIE-Image Turbo diffusion model. 8 steps, fast inference.',
          pulls: '', tags: ['Diffusion Model', '15.0 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/diffusion_models/ernie-image-turbo.safetensors',
          filename: 'ernie-image-turbo.safetensors', subfolder: 'diffusion_models', sizeGB: 15.0,
        },
        {
          name: 'Ministral-3-3B Text Encoder',
          description: 'Main text encoder (Ministral-3B) for ERNIE-Image prompt understanding.',
          pulls: '', tags: ['Text Encoder', '7.2 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/text_encoders/ministral-3-3b.safetensors',
          filename: 'ministral-3-3b.safetensors', subfolder: 'text_encoders', sizeGB: 7.2,
        },
        {
          name: 'ERNIE Prompt Enhancer',
          description: 'Optional prompt enhancer that expands short prompts into richer descriptions.',
          pulls: '', tags: ['Text Encoder', '6.4 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/text_encoders/ernie-image-prompt-enhancer.safetensors',
          filename: 'ernie-image-prompt-enhancer.safetensors', subfolder: 'text_encoders', sizeGB: 6.4,
        },
        {
          name: 'FLUX 2 VAE',
          description: 'Required autoencoder — shared with FLUX 2.',
          pulls: '', tags: ['VAE', '335 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/vae/flux2-vae.safetensors',
          filename: 'flux2-vae.safetensors', subfolder: 'vae', sizeGB: 0.3,
        },
      ],
    },
    {
      name: 'ERNIE-Image Base',
      description: 'Baidu ERNIE-Image Base — 8B DiT, 50 steps, 1024x1024. Highest quality ERNIE variant.',
      tags: ['ernie_image', 'Image', '1024x1024'],
      uncensored: false,
      verified: true,
      totalSizeGB: 28.9,
      vramRequired: '24 GB',
      workflow: 'ernie_image',
      url: 'https://huggingface.co/Comfy-Org/ERNIE-Image',
      files: [
        {
          name: 'ERNIE-Image Base (DiT 8B)',
          description: 'Baidu ERNIE-Image Base diffusion model. 50 steps, highest quality.',
          pulls: '', tags: ['Diffusion Model', '15.0 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/diffusion_models/ernie-image.safetensors',
          filename: 'ernie-image.safetensors', subfolder: 'diffusion_models', sizeGB: 15.0,
        },
        {
          name: 'Ministral-3-3B Text Encoder',
          description: 'Main text encoder (Ministral-3B) for ERNIE-Image prompt understanding.',
          pulls: '', tags: ['Text Encoder', '7.2 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/text_encoders/ministral-3-3b.safetensors',
          filename: 'ministral-3-3b.safetensors', subfolder: 'text_encoders', sizeGB: 7.2,
        },
        {
          name: 'ERNIE Prompt Enhancer',
          description: 'Optional prompt enhancer that expands short prompts into richer descriptions.',
          pulls: '', tags: ['Text Encoder', '6.4 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/text_encoders/ernie-image-prompt-enhancer.safetensors',
          filename: 'ernie-image-prompt-enhancer.safetensors', subfolder: 'text_encoders', sizeGB: 6.4,
        },
        {
          name: 'FLUX 2 VAE',
          description: 'Required autoencoder — shared with FLUX 2.',
          pulls: '', tags: ['VAE', '335 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/vae/flux2-vae.safetensors',
          filename: 'flux2-vae.safetensors', subfolder: 'vae', sizeGB: 0.3,
        },
      ],
    },
  ]
}

// Flat list for backwards compat
export function getImageModelsDiscover(): DiscoverModel[] {
  const bundles = getImageBundles()
  const files: DiscoverModel[] = []
  for (const b of bundles) files.push(...b.files)
  const seen = new Set<string>()
  return files.filter(f => {
    if (!f.filename || seen.has(f.filename)) return false
    seen.add(f.filename)
    return true
  })
}

// ─── Video Model Bundles ───
// Each bundle contains ALL files needed for a working video workflow.
// "Install All" downloads model + VAE + CLIP together.

export interface CustomNodeDef {
  key: string
  repo: string
  name: string
}

export const CUSTOM_NODE_REGISTRY: Record<string, { repo: string; name: string; requiredNodes: string[] }> = {
  'animatediff-evolved': {
    repo: 'https://github.com/Kosinkadink/ComfyUI-AnimateDiff-Evolved',
    name: 'ComfyUI-AnimateDiff-Evolved',
    requiredNodes: ['ADE_LoadAnimateDiffModel', 'ADE_ApplyAnimateDiffModelSimple', 'ADE_UseEvolvedSampling'],
  },
  'cogvideox-wrapper': {
    repo: 'https://github.com/kijai/ComfyUI-CogVideoXWrapper',
    name: 'ComfyUI-CogVideoXWrapper',
    requiredNodes: ['CogVideoXModelLoader', 'CogVideoXCLIPLoader', 'CogVideoXTextEncode', 'CogVideoXEmptyLatents', 'CogVideoXSampler', 'CogVideoXVAEDecode'],
  },
  'framepack-wrapper': {
    repo: 'https://github.com/kijai/ComfyUI-FramePackWrapper',
    name: 'ComfyUI-FramePackWrapper',
    requiredNodes: ['LoadFramePackModel', 'FramePackSampler'],
  },
  'pyramidflow-wrapper': {
    repo: 'https://github.com/kijai/ComfyUI-PyramidFlowWrapper',
    name: 'ComfyUI-PyramidFlowWrapper',
    requiredNodes: ['PyramidFlowModelLoader', 'PyramidFlowVAELoader', 'PyramidFlowTextEncode', 'PyramidFlowSampler', 'PyramidFlowDecode'],
  },
  'allegro': {
    repo: 'https://github.com/bombax-xiaoice/ComfyUI-Allegro',
    name: 'ComfyUI-Allegro',
    requiredNodes: ['AllegroModelLoader', 'AllegroTextEncode', 'AllegroSampler', 'AllegroDecoder'],
  },
}

export interface ModelBundle {
  name: string
  description: string
  tags: string[]
  totalSizeGB: number
  vramRequired: string
  workflow: string
  files: DiscoverModel[]
  url?: string
  hot?: boolean
  uncensored?: boolean
  customNodes?: string[]  // keys into CUSTOM_NODE_REGISTRY
  i2v?: boolean           // Image-to-Video model
  verified?: boolean      // E2E tested and confirmed working
}

export function getVideoBundles(): ModelBundle[] {
  return [
    {
      name: 'Wan 2.1 — 1.3B (Lightweight)',
      description: 'Best for 8-10 GB VRAM GPUs. Generates 480p video. Fast and lightweight.',
      tags: ['Wan 2.1', '480p', 'Fast'],
      uncensored: true,
      verified: true,
      totalSizeGB: 9.2,
      vramRequired: '8-10 GB',
      workflow: 'wan',
      url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged',
      files: [
        {
          name: 'Wan 2.1 T2V 1.3B Model',
          description: 'The main video generation model.',
          pulls: '', tags: ['Model', '2.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/diffusion_models/wan2.1_t2v_1.3B_bf16.safetensors',
          filename: 'wan2.1_t2v_1.3B_bf16.safetensors', subfolder: 'diffusion_models', sizeGB: 2.5,
        },
        {
          name: 'Wan 2.1 VAE',
          description: 'Required video encoder/decoder.',
          pulls: '', tags: ['VAE', '200 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors',
          filename: 'wan_2.1_vae.safetensors', subfolder: 'vae', sizeGB: 0.2,
        },
        {
          name: 'Wan 2.1 CLIP (UMT5-XXL FP8)',
          description: 'Required text encoder.',
          pulls: '', tags: ['CLIP', '4.9 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
          filename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 6.3,
        },
      ],
    },
    {
      name: 'Wan 2.1 — 14B FP8 (High Quality)',
      description: 'Best quality for 12+ GB VRAM. Generates up to 720p. Slower but much better results.',
      tags: ['Wan 2.1', '720p', 'Quality'],
      uncensored: true,
      verified: true,
      totalSizeGB: 20.5,
      vramRequired: '12+ GB',
      workflow: 'wan',
      url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged',
      files: [
        {
          name: 'Wan 2.1 T2V 14B (FP8)',
          description: 'The main video generation model (quantized).',
          pulls: '', tags: ['Model', '14 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/diffusion_models/wan2.1_t2v_14B_fp8_e4m3fn.safetensors',
          filename: 'wan2.1_t2v_14B_fp8.safetensors', subfolder: 'diffusion_models', sizeGB: 14.0,
        },
        {
          name: 'Wan 2.1 VAE',
          description: 'Required video encoder/decoder.',
          pulls: '', tags: ['VAE', '200 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors',
          filename: 'wan_2.1_vae.safetensors', subfolder: 'vae', sizeGB: 0.2,
        },
        {
          name: 'Wan 2.1 CLIP (UMT5-XXL FP8)',
          description: 'Required text encoder.',
          pulls: '', tags: ['CLIP', '4.9 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
          filename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 6.3,
        },
      ],
    },
    {
      name: 'HunyuanVideo 1.5 T2V FP8 (High Quality)',
      description: 'Tencent HunyuanVideo 1.5 — excellent temporal consistency and visual quality. 480p text-to-video with CFG distillation.',
      tags: ['HunyuanVideo 1.5', '480p', 'Quality'],
      uncensored: true,
      verified: true,
      totalSizeGB: 18.8,
      vramRequired: '12+ GB',
      workflow: 'hunyuan',
      url: 'https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged',
      files: [
        {
          name: 'HunyuanVideo 1.5 T2V FP8',
          description: 'The main video generation model (480p, CFG distilled, quantized).',
          pulls: '', tags: ['Model', '7.8 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/diffusion_models/hunyuanvideo1.5_480p_t2v_cfg_distilled_fp8_scaled.safetensors',
          filename: 'hunyuanvideo1.5_480p_t2v_fp8.safetensors', subfolder: 'diffusion_models', sizeGB: 7.8,
        },
        {
          name: 'HunyuanVideo 1.5 VAE',
          description: 'Required video encoder/decoder.',
          pulls: '', tags: ['VAE', '2.3 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/vae/hunyuanvideo15_vae_fp16.safetensors',
          filename: 'hunyuanvideo15_vae_fp16.safetensors', subfolder: 'vae', sizeGB: 2.3,
        },
        {
          name: 'Qwen 2.5 VL 7B Text Encoder (FP8)',
          description: 'Required text encoder for HunyuanVideo 1.5.',
          pulls: '', tags: ['Text Encoder', '7.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors',
          filename: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 7.5,
        },
        {
          name: 'CLIP-L Text Encoder',
          description: 'Required secondary text encoder.',
          pulls: '', tags: ['Text Encoder', '240 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/resolve/main/split_files/text_encoders/clip_l.safetensors',
          filename: 'clip_l.safetensors', subfolder: 'text_encoders', sizeGB: 0.2,
        },
      ],
    },
    {
      name: 'LTX Video 2.3 — 22B FP8 (Latest)',
      description: 'Lightricks LTX Video 2.3 — fast inference, high quality. Uses Gemma 3 12B text encoder. Distilled for speed.',
      tags: ['LTX 2.3', '22B', 'Quality'],
      verified: true,
      totalSizeGB: 40,
      vramRequired: '16+ GB',
      workflow: 'ltx',
      url: 'https://huggingface.co/Lightricks/LTX-2.3-fp8',
      files: [
        {
          name: 'LTX 2.3 22B Distilled FP8',
          description: 'Main video model — distilled for fast inference.',
          pulls: '', tags: ['Model', '~22 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Lightricks/LTX-2.3-fp8/resolve/main/ltx-2.3-22b-distilled-fp8.safetensors',
          filename: 'ltx-2.3-22b-distilled-fp8.safetensors', subfolder: 'diffusion_models', sizeGB: 27.5,
        },
        {
          name: 'Gemma 3 12B Text Encoder (FP8)',
          description: 'Required text encoder for LTX Video 2.x.',
          pulls: '', tags: ['Text Encoder', '~12 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ltx-2/resolve/main/split_files/text_encoders/gemma_3_12B_it_fp8_scaled.safetensors',
          filename: 'gemma_3_12B_it_fp8_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 12,
        },
      ],
    },
    // ─── NEW VIDEO BUNDLES ───
    {
      name: 'AnimateDiff Lightning',
      description: 'Ultra-fast 4-step animation on any SD1.5 checkpoint. Great for quick iterations. Needs an SD1.5 base model.',
      tags: ['AnimateDiff', '512x512', 'Lightning'],
      verified: true,
      totalSizeGB: 2.8,
      vramRequired: '6-8 GB',
      workflow: 'animatediff',
      customNodes: ['animatediff-evolved'],
      url: 'https://huggingface.co/ByteDance/AnimateDiff-Lightning',
      files: [
        {
          name: 'AnimateDiff Lightning Motion Model (4-step)',
          description: 'Lightning-fast motion model — only 4 sampling steps needed.',
          pulls: '', tags: ['Motion', '800 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/ByteDance/AnimateDiff-Lightning/resolve/main/animatediff_lightning_4step_comfyui.safetensors',
          filename: 'animatediff_lightning_4step_comfyui.safetensors', subfolder: 'custom_nodes/ComfyUI-AnimateDiff-Evolved/models', sizeGB: 0.8,
        },
        {
          name: 'Realistic Vision V6 (SD1.5 Base)',
          description: 'Recommended SD1.5 base checkpoint for realistic animations.',
          pulls: '', tags: ['Checkpoint', '~2 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/SG161222/Realistic_Vision_V6.0_B1_noVAE/resolve/main/Realistic_Vision_V6.0_NV_B1_fp16.safetensors',
          filename: 'Realistic_Vision_V6.0_NV_B1_fp16.safetensors', subfolder: 'checkpoints', sizeGB: 2.0,
        },
      ],
    },
    {
      name: 'AnimateDiff v3',
      description: 'Classic AnimateDiff with more frames and better quality than Lightning. Slower but more detailed.',
      tags: ['AnimateDiff', '512x768', 'Quality'],
      totalSizeGB: 3.6,
      vramRequired: '6-8 GB',
      workflow: 'animatediff',
      customNodes: ['animatediff-evolved'],
      url: 'https://huggingface.co/guoyww/animatediff',
      files: [
        {
          name: 'AnimateDiff v3 Motion Adapter',
          description: 'Standard motion model — 20 steps, good quality.',
          pulls: '', tags: ['Motion', '1.6 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/guoyww/animatediff/resolve/main/v3_sd15_mm.ckpt',
          filename: 'v3_sd15_mm.ckpt', subfolder: 'custom_nodes/ComfyUI-AnimateDiff-Evolved/models', sizeGB: 1.6,
        },
        {
          name: 'Realistic Vision V6 (SD1.5 Base)',
          description: 'Recommended SD1.5 base checkpoint.',
          pulls: '', tags: ['Checkpoint', '~2 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/SG161222/Realistic_Vision_V6.0_B1_noVAE/resolve/main/Realistic_Vision_V6.0_NV_B1_fp16.safetensors',
          filename: 'Realistic_Vision_V6.0_NV_B1_fp16.safetensors', subfolder: 'checkpoints', sizeGB: 2.0,
        },
      ],
    },
    {
      name: 'CogVideoX 5B I2V',
      description: 'CogVideoX 5B Image-to-Video by Tsinghua. Upload an image, get video. Needs 12+ GB VRAM.',
      tags: ['CogVideoX', 'I2V', 'Quality'],
      uncensored: true,
      verified: true,
      i2v: true,
      totalSizeGB: 21.2,
      vramRequired: '12+ GB',
      workflow: 'cogvideo',
      customNodes: ['cogvideox-wrapper'],
      url: 'https://huggingface.co/Kijai/CogVideoX-comfy',
      files: [
        {
          name: 'CogVideoX 5B I2V Model',
          description: 'Main image-to-video generation model.',
          pulls: '', tags: ['Model', '11.3 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Kijai/CogVideoX-comfy/resolve/main/CogVideoX_1_0_5b_I2V_bf16.safetensors',
          filename: 'CogVideoX_1_0_5b_I2V_bf16.safetensors', subfolder: 'diffusion_models', sizeGB: 11.3,
        },
        {
          name: 'CogVideoX VAE',
          description: 'Required video encoder/decoder.',
          pulls: '', tags: ['VAE', '430 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Kijai/CogVideoX-comfy/resolve/main/cogvideox_vae_bf16.safetensors',
          filename: 'cogvideox_vae_bf16.safetensors', subfolder: 'vae', sizeGB: 0.4,
        },
        {
          name: 'T5-XXL Text Encoder (FP16)',
          description: 'Required text encoder (shared with other models).',
          pulls: '', tags: ['Text Encoder', '9.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/mochi_preview_repackaged/resolve/main/split_files/text_encoders/t5xxl_fp16.safetensors',
          filename: 't5xxl_fp16.safetensors', subfolder: 'text_encoders', sizeGB: 9.5,
        },
      ],
    },
    {
      name: 'CogVideoX 1.5 5B',
      description: 'Larger CogVideoX with 1360x768 output. Better quality, needs 16 GB VRAM.',
      tags: ['CogVideoX 1.5', '1360x768', 'Quality'],
      uncensored: true,
      verified: true,
      totalSizeGB: 20.9,
      vramRequired: '16+ GB',
      workflow: 'cogvideo',
      customNodes: ['cogvideox-wrapper'],
      url: 'https://huggingface.co/Kijai/CogVideoX-comfy',
      files: [
        {
          name: 'CogVideoX 1.5 5B Model',
          description: 'Higher quality video model with wider resolution.',
          pulls: '', tags: ['Model', '11.1 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Kijai/CogVideoX-comfy/resolve/main/CogVideoX_1_5_5b_T2V_bf16.safetensors',
          filename: 'CogVideoX_1_5_5b_T2V_bf16.safetensors', subfolder: 'diffusion_models', sizeGB: 11.1,
        },
        {
          name: 'CogVideoX VAE',
          description: 'Required video encoder/decoder.',
          pulls: '', tags: ['VAE', '430 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Kijai/CogVideoX-comfy/resolve/main/cogvideox_vae_bf16.safetensors',
          filename: 'cogvideox_vae_bf16.safetensors', subfolder: 'vae', sizeGB: 0.4,
        },
        {
          name: 'T5-XXL Text Encoder (FP16)',
          description: 'Required text encoder (shared with other models).',
          pulls: '', tags: ['Text Encoder', '9.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/mochi_preview_repackaged/resolve/main/split_files/text_encoders/t5xxl_fp16.safetensors',
          filename: 't5xxl_fp16.safetensors', subfolder: 'text_encoders', sizeGB: 9.5,
        },
      ],
    },
    {
      name: 'FramePack F1 (Image-to-Video)',
      description: 'Revolutionary I2V: runs on 6 GB VRAM via next-frame prediction. Upload an image, get a video. Uses HunyuanVideo backbone.',
      tags: ['FramePack', 'I2V', 'Low VRAM'],
      uncensored: true,
      verified: true,
      totalSizeGB: 27.0,
      vramRequired: '6-8 GB',
      workflow: 'framepack',
      i2v: true,
      customNodes: ['framepack-wrapper'],
      url: 'https://huggingface.co/lllyasviel/FramePack_F1_I2V_HY_20250503',
      files: [
        {
          name: 'FramePack F1 I2V Model (FP8)',
          description: 'Main I2V model — generates video from a single image.',
          pulls: '', tags: ['Model', '13 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Kijai/HunyuanVideo_comfy/resolve/main/FramePackI2V_HY_fp8_e4m3fn.safetensors',
          filename: 'FramePackI2V_HY_fp8_e4m3fn.safetensors', subfolder: 'diffusion_models', sizeGB: 13,
        },
        {
          name: 'SigCLIP Vision Encoder',
          description: 'Required vision encoder for image understanding.',
          pulls: '', tags: ['CLIP Vision', '900 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/sigclip_vision_384/resolve/main/sigclip_vision_patch14_384.safetensors',
          filename: 'sigclip_vision_patch14_384.safetensors', subfolder: 'clip_vision', sizeGB: 0.9,
        },
        {
          name: 'HunyuanVideo VAE',
          description: 'Required video encoder/decoder (shared with HunyuanVideo).',
          pulls: '', tags: ['VAE', '2.3 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/vae/hunyuanvideo15_vae_fp16.safetensors',
          filename: 'hunyuanvideo15_vae_fp16.safetensors', subfolder: 'vae', sizeGB: 2.3,
        },
        {
          name: 'CLIP-L Text Encoder',
          description: 'Required text encoder (shared).',
          pulls: '', tags: ['Text Encoder', '240 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/resolve/main/split_files/text_encoders/clip_l.safetensors',
          filename: 'clip_l.safetensors', subfolder: 'text_encoders', sizeGB: 0.2,
        },
        {
          name: 'LLaVA LLaMA3 Text Encoder (FP8)',
          description: 'Required text encoder for FramePack.',
          pulls: '', tags: ['Text Encoder', '8.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/resolve/main/split_files/text_encoders/llava_llama3_fp8_scaled.safetensors',
          filename: 'llava_llama3_fp8_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 8.5,
        },
      ],
    },
    {
      name: 'SVD-XT 1.1 (Image-to-Video)',
      description: 'Stable Video Diffusion by Stability AI. Upload an image, get 25 frames of smooth video. Native ComfyUI support.',
      tags: ['SVD', 'I2V', 'Native'],
      verified: true,
      totalSizeGB: 4.8,
      vramRequired: '12+ GB',
      workflow: 'svd',
      i2v: true,
      url: 'https://huggingface.co/stabilityai/stable-video-diffusion-img2vid-xt-1-1',
      files: [
        {
          name: 'SVD-XT 1.1 Checkpoint',
          description: 'Complete I2V model — no additional downloads needed.',
          pulls: '', tags: ['Checkpoint', '4.8 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/vdo/stable-video-diffusion-img2vid-xt-1-1/resolve/main/svd_xt_1_1.safetensors',
          filename: 'svd_xt_1_1.safetensors', subfolder: 'checkpoints', sizeGB: 4.8,
        },
      ],
    },
    {
      name: 'Mochi 1 Preview (FP8)',
      description: 'Genmo Mochi — 848x480 video at 24 FPS. Good motion and temporal consistency. Native ComfyUI support.',
      tags: ['Mochi', '848x480', 'Native'],
      totalSizeGB: 20.4,
      vramRequired: '16+ GB',
      workflow: 'mochi',
      url: 'https://huggingface.co/Comfy-Org/mochi_preview_repackaged',
      files: [
        {
          name: 'Mochi 1 Preview (FP8)',
          description: 'Main video model (quantized for lower VRAM).',
          pulls: '', tags: ['Model', '10 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/mochi_preview_repackaged/resolve/main/split_files/diffusion_models/mochi_preview_fp8_scaled.safetensors',
          filename: 'mochi_preview_fp8_scaled.safetensors', subfolder: 'diffusion_models', sizeGB: 10,
        },
        {
          name: 'Mochi VAE',
          description: 'Required video encoder/decoder.',
          pulls: '', tags: ['VAE', '0.9 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/mochi_preview_repackaged/resolve/main/split_files/vae/mochi_vae.safetensors',
          filename: 'mochi_vae.safetensors', subfolder: 'vae', sizeGB: 0.9,
        },
        {
          name: 'T5-XXL Text Encoder (FP16)',
          description: 'Required text encoder for Mochi.',
          pulls: '', tags: ['Text Encoder', '9.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/mochi_preview_repackaged/resolve/main/split_files/text_encoders/t5xxl_fp16.safetensors',
          filename: 't5xxl_fp16.safetensors', subfolder: 'text_encoders', sizeGB: 9.5,
        },
      ],
    },
    {
      name: 'Pyramid Flow MiniFlux v2',
      description: 'Pyramid-style temporal generation based on SD3. 768x1280 output. Experimental but interesting results.',
      tags: ['Pyramid Flow', '768x1280', 'Experimental'],
      totalSizeGB: 4.6,
      vramRequired: '16+ GB',
      workflow: 'pyramidflow',
      customNodes: ['pyramidflow-wrapper'],
      url: 'https://huggingface.co/Kijai/pyramid-flow-comfy',
      files: [
        {
          name: 'Pyramid Flow MiniFlux v2',
          description: 'Main video generation model.',
          pulls: '', tags: ['Model', '3.9 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Kijai/pyramid-flow-comfy/resolve/main/pyramid_flow_miniflux_bf16_v2.safetensors',
          filename: 'pyramid_flow_miniflux_bf16_v2.safetensors', subfolder: 'diffusion_models', sizeGB: 3.9,
        },
        {
          name: 'Pyramid Flow VAE',
          description: 'Required video encoder/decoder.',
          pulls: '', tags: ['VAE', '670 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Kijai/pyramid-flow-comfy/resolve/main/pyramid_flow_vae_bf16.safetensors',
          filename: 'pyramid_flow_vae_bf16.safetensors', subfolder: 'vae', sizeGB: 0.7,
        },
      ],
    },
    // Allegro removed — diffusers format only, no single-file safetensors available for one-click install
    {
      name: 'NVIDIA Cosmos 7B',
      description: 'NVIDIA Cosmos Diffusion 7B Text-to-World. 1024x1024 output at 24 FPS. Native ComfyUI support. Uses oldt5 text encoder (NOT t5xxl).',
      tags: ['Cosmos', '1024x1024', 'NVIDIA'],
      totalSizeGB: 19.2,
      vramRequired: '24+ GB',
      workflow: 'cosmos',
      url: 'https://huggingface.co/mcmonkey/cosmos-1.0',
      files: [
        {
          name: 'Cosmos 7B Text2World',
          description: 'Main video generation model by NVIDIA.',
          pulls: '', tags: ['Model', '14 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/mcmonkey/cosmos-1.0/resolve/main/Cosmos-1_0-Diffusion-7B-Text2World.safetensors',
          filename: 'Cosmos-1_0-Diffusion-7B-Text2World.safetensors', subfolder: 'diffusion_models', sizeGB: 14,
        },
        {
          name: 'OldT5-XXL Text Encoder (FP8)',
          description: 'Required text encoder — NOT the same as regular T5-XXL!',
          pulls: '', tags: ['Text Encoder', '4.9 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/comfyanonymous/cosmos_1.0_text_encoder_and_VAE_ComfyUI/resolve/main/text_encoders/oldt5_xxl_fp8_e4m3fn_scaled.safetensors',
          filename: 'oldt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 4.9,
        },
        {
          name: 'Cosmos VAE',
          description: 'Required video encoder/decoder.',
          pulls: '', tags: ['VAE', '300 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/comfyanonymous/cosmos_1.0_text_encoder_and_VAE_ComfyUI/resolve/main/vae/cosmos_cv8x8x8_1.0.safetensors',
          filename: 'cosmos_cv8x8x8_1.0.safetensors', subfolder: 'vae', sizeGB: 0.2,
        },
      ],
    },
  ]
}

// ─── CivitAI Model Search ───

export interface CivitAIModelResult {
  id: number
  name: string
  description: string
  type: string
  thumbnailUrl?: string
  downloadUrl?: string
  filename?: string
  subfolder?: string
  sizeGB?: number
  stats?: { downloads: number; likes: number }
  creator?: string
  sourceUrl: string
}

export async function searchCivitaiModels(
  query: string,
  type: 'Checkpoint' | 'LORA' | 'VAE' | 'TextualInversion' = 'Checkpoint'
): Promise<CivitAIModelResult[]> {
  try {
    const params = new URLSearchParams({
      query,
      types: type,
      limit: '20',
      sort: 'Most Downloaded',
    })
    const text = await fetchExternal(`https://civitai.com/api/v1/models?${params}`)
    const data = JSON.parse(text)
    const items: any[] = data.items ?? []

    return items.map((item) => {
      const version = item.modelVersions?.[0]
      const file = version?.files?.[0]
      const thumb = version?.images?.[0]?.url
      const downloadUrl = version?.downloadUrl ?? file?.downloadUrl
      const sizeKB = file?.sizeKB ?? 0

      // Determine subfolder based on model type
      let subfolder = 'checkpoints'
      if (type === 'LORA') subfolder = 'loras'
      else if (type === 'VAE') subfolder = 'vae'
      else if (type === 'TextualInversion') subfolder = 'embeddings'
      // Check if it's a diffusion model (FLUX, Wan, etc.)
      const name = item.name?.toLowerCase() || ''
      if (name.includes('flux') || name.includes('wan') || name.includes('hunyuan')) {
        subfolder = 'diffusion_models'
      }

      const filename = file?.name || `${item.name?.replace(/[^a-zA-Z0-9._-]/g, '_')}.safetensors`

      const descParts: string[] = []
      const rawDesc = (item.description ?? '').replace(/<[^>]*>/g, '').trim()
      if (rawDesc) descParts.push(rawDesc.slice(0, 120))
      if (item.stats?.downloadCount) descParts.push(`${item.stats.downloadCount.toLocaleString()} downloads`)
      if (item.creator?.username) descParts.push(`by ${item.creator.username}`)

      return {
        id: item.id,
        name: item.name || `Model #${item.id}`,
        description: descParts.join(' — '),
        type: type,
        thumbnailUrl: thumb,
        downloadUrl,
        filename,
        subfolder,
        sizeGB: sizeKB > 0 ? Math.round(sizeKB / 1024 / 1024 * 10) / 10 : undefined,
        stats: item.stats ? { downloads: item.stats.downloadCount || 0, likes: item.stats.thumbsUpCount || 0 } : undefined,
        creator: item.creator?.username,
        sourceUrl: `https://civitai.com/models/${item.id}`,
      }
    })
  } catch (err) {
    console.warn('[discover] CivitAI model search failed:', err)
    return []
  }
}

// Flat list for backwards compatibility (individual files)
export function getVideoModelsDiscover(): DiscoverModel[] {
  const bundles = getVideoBundles()
  const files: DiscoverModel[] = []
  for (const b of bundles) {
    files.push(...b.files)
  }
  // Deduplicate by filename
  const seen = new Set<string>()
  return files.filter(f => {
    if (!f.filename || seen.has(f.filename)) return false
    seen.add(f.filename)
    return true
  })
}
