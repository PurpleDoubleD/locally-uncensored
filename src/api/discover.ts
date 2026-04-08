import { backendCall, fetchExternal } from "./backend"
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

  // Step 1: Start ALL downloads IMMEDIATELY (don't wait for custom nodes)
  for (const file of bundle.files) {
    if (!file.downloadUrl || !file.filename || !file.subfolder) continue
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
    clip: { patterns: ['t5'], downloadName: 't5xxl_fp16.safetensors', downloadUrl: 'https://huggingface.co/Kijai/CogVideoX_comfy/resolve/main/t5xxl_fp16.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  cosmos: {
    loader: 'UNETLoader',
    vae: { patterns: ['cosmos'], downloadName: 'cosmos_cv8x8x8_1.0.safetensors', downloadUrl: 'https://huggingface.co/comfyanonymous/cosmos_1.0_text2world_safetensors/resolve/main/cosmos_cv8x8x8_1.0.safetensors', subfolder: 'vae' },
    clip: { patterns: ['oldt5'], downloadName: 'oldt5_xxl_fp8_e4m3fn_scaled.safetensors', downloadUrl: 'https://huggingface.co/comfyanonymous/cosmos_1.0_text2world_safetensors/resolve/main/oldt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  cogvideo: {
    loader: 'UNETLoader',
    vae: { patterns: ['cogvideox', 'cogvideo'], downloadName: 'cogvideox_vae.safetensors', downloadUrl: 'https://huggingface.co/Kijai/CogVideoX_comfy/resolve/main/cogvideox_vae.safetensors', subfolder: 'vae' },
    clip: { patterns: ['t5'], downloadName: 't5xxl_fp16.safetensors', downloadUrl: 'https://huggingface.co/Kijai/CogVideoX_comfy/resolve/main/t5xxl_fp16.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  svd: { loader: 'CheckpointLoaderSimple', needsSeparateVAE: false, needsSeparateCLIP: false },
  framepack: {
    loader: 'UNETLoader',
    vae: { patterns: ['hunyuan', 'wan'], downloadName: 'hunyuanvideo15_vae_fp16.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/vae/hunyuanvideo15_vae_fp16.safetensors', subfolder: 'vae' },
    clip: { patterns: ['llava', 'qwen'], downloadName: 'llava_llama3_fp8_scaled.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/resolve/main/split_files/text_encoders/llava_llama3_fp8_scaled.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  pyramidflow: {
    loader: 'UNETLoader',
    vae: { patterns: ['pyramid'], downloadName: 'pyramid_flow_vae.safetensors', downloadUrl: 'https://huggingface.co/Kijai/pyramid-flow-comfy/resolve/main/pyramid_flow_vae.safetensors', subfolder: 'vae' },
    needsSeparateVAE: true, needsSeparateCLIP: false,
  },
  allegro: { loader: 'UNETLoader', needsSeparateVAE: false, needsSeparateCLIP: false },
  unknown: { loader: 'CheckpointLoaderSimple', needsSeparateVAE: false, needsSeparateCLIP: false },
}

// ─── Ollama Text Models ───

/** Get featured HOT models (always shown at top of discover) */
export function getHotTextModels(): DiscoverModel[] {
  return getCuratedTextModels().filter(m => m.hot)
}

export async function fetchAbliteratedModels(): Promise<DiscoverModel[]> {
  const hotModels = getHotTextModels()
  const searchResults = await searchOllamaModels('abliterated')
  // Merge: HOT first, then search results (deduplicated)
  const hotNames = new Set(hotModels.map(m => m.name))
  const deduped = searchResults.filter(m => !hotNames.has(m.name))
  return [...hotModels, ...deduped]
}

/** Search Ollama registry — works in both Tauri and dev mode */
export async function searchOllamaModels(query: string): Promise<DiscoverModel[]> {
  try {
    let html: string

    const { isTauri, fetchExternal } = await import("./backend")
    if (isTauri()) {
      // In Tauri: use fetchExternal to bypass CORS
      html = await fetchExternal(`https://ollama.com/search?q=${encodeURIComponent(query)}&p=1`)
    } else {
      // In dev: use proxy
      const res = await fetch(`/ollama-search?q=${encodeURIComponent(query)}&p=1`)
      html = await res.text()
    }

    const models = parseOllamaSearchHTML(html)
    if (models.length === 0) return getCuratedTextModels()
    return models
  } catch {
    return getCuratedTextModels()
  }
}

function parseOllamaSearchHTML(html: string): DiscoverModel[] {
  const models: DiscoverModel[] = []
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')

  const items = doc.querySelectorAll('[x-test-search-response-title]')
  items.forEach((item) => {
    const container = item.closest('a') || item.parentElement?.closest('a')
    const name = item.textContent?.trim() || ''
    const href = container?.getAttribute('href') || ''

    const parent = item.closest('div')?.parentElement
    const spans = parent?.querySelectorAll('span') || []
    let pulls = ''
    let updated = ''

    spans.forEach((span) => {
      const text = span.textContent?.trim() || ''
      if (text.includes('Pull') || text.includes('K') || text.includes('M')) {
        if (!pulls) pulls = text
      }
      if (text.includes('ago') || text.includes('month') || text.includes('week') || text.includes('day')) {
        updated = text
      }
    })

    if (name && href) {
      models.push({
        name: href.startsWith('/') ? href.slice(1) : name,
        description: '',
        pulls,
        tags: [],
        updated,
      })
    }
  })

  return models
}

/** Sort models by release date, newest first */
function sortByRelease(models: DiscoverModel[]): DiscoverModel[] {
  return models.sort((a, b) => (b.released ?? '').localeCompare(a.released ?? ''))
}

/** Uncensored / abliterated models — the core of LU */
export function getUncensoredTextModels(): DiscoverModel[] {
  return sortByRelease([
    // ── HOT: Agent Mode + Uncensored ──
    { name: 'hermes3', description: 'NousResearch Hermes 3 — uncensored + native tool calling. THE agent model.', pulls: '500K+', tags: ['3B', '8B', '70B', '405B'], updated: 'Hot', hot: true, agent: true, released: '2024-08' },
    { name: 'dolphin3', description: 'Dolphin 3 — uncensored from training. Coding, math, general purpose.', pulls: '3.7M', tags: ['8B'], updated: 'Hot', hot: true, released: '2024-12' },
    { name: 'huihui_ai/qwen3.5-abliterated', description: 'Qwen 3.5 abliterated — newest, strongest reasoning + coding.', pulls: '10K+', tags: ['9B', '27B', '35B'], updated: 'Hot', hot: true, released: '2026-03' },
    { name: 'huihui_ai/gpt-oss-abliterated', description: 'OpenAI GPT-OSS — abliterated open-source GPT model.', pulls: '15K+', tags: ['20B', '120B'], updated: 'Hot', hot: true, released: '2026-03' },
    { name: 'huihui_ai/qwen3-coder-abliterated', description: 'Qwen3-Coder abliterated — 30B MoE (3B active), built for code agents. 256K context.', pulls: '5K+', tags: ['30B', '480B'], updated: 'Hot', hot: true, agent: true, released: '2026-02' },
    { name: 'aratan/gemma-4-31B-it-uncensores', description: 'Gemma 4 31B uncensored — frontier dense model, native tool calling + vision. 256K context.', pulls: '400+', tags: ['31B'], updated: 'Hot', hot: true, agent: true, released: '2026-04' },
    { name: 'juilpark/gemma-4-26B-A4B-it-heretic', description: 'Gemma 4 26B MoE HERETIC — 26B brain, 4B active. Uncensored + tools + vision.', pulls: '30+', tags: ['26B'], updated: 'Hot', hot: true, agent: true, released: '2026-04' },
    { name: 'juilpark/gemma-4-31B-it-uncensored-heretic', description: 'Gemma 4 31B HERETIC — full uncensor, native tool calling, 256K context.', pulls: '80+', tags: ['31B'], updated: 'Hot', hot: true, agent: true, released: '2026-04' },
    { name: 'charaf/gemma4-31b-claude-opus-abliterated', description: 'Gemma 4 31B abliterated — Claude Opus-style tuning, strong reasoning.', pulls: '360+', tags: ['31B'], updated: 'New', hot: true, agent: true, released: '2026-04' },
    // ── Popular Uncensored ──
    { name: 'huihui_ai/qwen3-abliterated', description: 'Qwen3 abliterated — best overall. Exceptional reasoning, coding, multilingual.', pulls: '30K+', tags: ['8B', '30B'], updated: 'Popular', released: '2025-05' },
    { name: 'mannix/llama3.1-8b-abliterated', description: 'Llama 3.1 8B — fast, reliable, great entry point.', pulls: '200K+', tags: ['Q5_K_M', 'Q4_K_M'], updated: 'Popular', released: '2024-07' },
    { name: 'huihui_ai/deepseek-r1-abliterated', description: 'DeepSeek R1 — chain-of-thought reasoning. Scales to your hardware.', pulls: '40K+', tags: ['8B', '14B', '32B', '70B'], updated: 'Popular', released: '2025-01' },
    { name: 'huihui_ai/glm4.6-abliterated', description: 'GLM 4.6 abliterated — newest model, strong coding and reasoning.', pulls: '5K+', tags: ['357B'], updated: 'New', released: '2026-03' },
    { name: 'kiwi_kiwi/gemma-4-uncensores', description: 'Gemma 4 31B uncensored — strong all-rounder, vision + tool calling.', pulls: '400+', tags: ['31B'], updated: 'New', agent: true, released: '2026-04' },
    { name: 'huihui_ai/gemma3-abliterated', description: 'Google Gemma 3 — vision support, great quality.', pulls: '20K+', tags: ['4B', '12B', '27B'], updated: 'Popular', released: '2025-03' },
    { name: 'richardyoung/qwen3-14b-abliterated', description: 'Qwen3 14B — sweet spot of speed and intelligence.', pulls: '4K+', tags: ['Q4_K_M', 'Q5_K_M'], updated: 'Recent', released: '2025-05' },
    { name: 'huihui_ai/qwen2.5-abliterate', description: 'Qwen 2.5 abliterated series — proven and reliable.', pulls: '50K+', tags: ['7B', '14B', '32B'], updated: 'Popular', released: '2024-09' },
    { name: 'huihui_ai/llama3.3-abliterated', description: 'Llama 3.3 70B — maximum intelligence for high-VRAM setups.', pulls: '15K+', tags: ['70B'], updated: 'Popular', released: '2024-12' },
    { name: 'huihui_ai/mistral-small-abliterated', description: 'Mistral Small 24B — powerful, strong multilingual.', pulls: '10K+', tags: ['24B'], updated: 'Recent', released: '2024-09' },
    { name: 'huihui_ai/phi4-abliterated', description: 'Microsoft Phi-4 — excellent at math, logic, structured tasks.', pulls: '8K+', tags: ['14B'], updated: 'Recent', released: '2024-12' },
    { name: 'krith/mistral-nemo-instruct-2407-abliterated', description: 'Mistral Nemo 12B — multilingual powerhouse.', pulls: '5K+', tags: ['IQ4_XS', 'IQ3_M'], updated: 'Popular', released: '2024-07' },
  ])
}

/** Mainstream models — not uncensored but excellent for specific tasks */
export function getMainstreamTextModels(): DiscoverModel[] {
  return sortByRelease([
    { name: 'gemma4', description: 'Google Gemma 4 — native tool calling + vision. 128-256K context. Apache 2.0.', pulls: '100K+', tags: ['e2b', 'e4b', '26B', '31B'], updated: 'New', hot: true, agent: true, released: '2026-04' },
    { name: 'qwen3-coder', description: 'Qwen3-Coder — 30B MoE coding agent (3B active). Native tool calling, 256K context.', pulls: '100K+', tags: ['30B', '480B'], updated: 'New', hot: true, agent: true, released: '2026-02' },
    { name: 'qwen3-coder-next', description: 'Qwen3-Coder-Next — 80B MoE (3B active). Optimized for agentic coding workflows.', pulls: '10K+', tags: ['Q4_K_M', 'Q8_0'], updated: 'New', hot: true, agent: true, released: '2026-03' },
    { name: 'qwen3', description: 'Qwen 3 — top-tier reasoning and coding. Thinking mode support.', pulls: '5M+', tags: ['8B', '14B', '32B'], updated: 'Popular', agent: true, released: '2025-05' },
    { name: 'llama4', description: 'Meta Llama 4 — latest generation MoE. Needs 64GB+ RAM.', pulls: '1M+', tags: ['scout', 'maverick'], updated: 'New', agent: true, released: '2025-04' },
    { name: 'deepseek-r1', description: 'DeepSeek R1 — chain-of-thought reasoning model. Shows its thinking.', pulls: '2M+', tags: ['8B', '14B', '32B', '70B'], updated: 'Popular', released: '2025-01' },
    { name: 'phi4', description: 'Microsoft Phi 4 — excellent math, logic, structured tasks.', pulls: '500K+', tags: ['14B'], updated: 'Popular', agent: true, released: '2024-12' },
    { name: 'mistral-small', description: 'Mistral Small — fast, multilingual, native tool calling.', pulls: '300K+', tags: ['24B'], updated: 'Popular', agent: true, released: '2024-09' },
  ])
}

/** Combined curated list for search fallback — uncensored first */
function getCuratedTextModels(): DiscoverModel[] {
  return [...getUncensoredTextModels(), ...getMainstreamTextModels()]
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

// ─── HuggingFace GGUF Discovery ───

const HF = (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${file}`

/** Uncensored GGUF models from HuggingFace */
export function getHuggingFaceUncensoredModels(): DiscoverModel[] {
  return sortByRelease([
    { name: 'Hermes 3 Llama 3.1 8B', description: 'NousResearch Hermes 3 — uncensored + native tool calling. THE agent model.', tags: ['8B', 'Q4_K_M', '5 GB'], updated: 'Hot', hot: true, agent: true, released: '2024-08', downloadUrl: HF('bartowski/Hermes-3-Llama-3.1-8B-GGUF', 'Hermes-3-Llama-3.1-8B-Q4_K_M.gguf'), filename: 'Hermes-3-Llama-3.1-8B-Q4_K_M.gguf', sizeGB: 5 },
    { name: 'Dolphin 3 Llama 3.1 8B', description: 'Dolphin 3 — uncensored from training. Coding, math, general purpose.', tags: ['8B', 'Q4_K_M', '5 GB'], updated: 'Hot', hot: true, released: '2024-12', downloadUrl: HF('bartowski/dolphin-2.9.4-llama3.1-8b-GGUF', 'dolphin-2.9.4-llama3.1-8b-Q4_K_M.gguf'), filename: 'dolphin-2.9.4-llama3.1-8b-Q4_K_M.gguf', sizeGB: 5 },
  ])
}

/** Mainstream GGUF models from HuggingFace — all URLs verified */
export function getHuggingFaceMainstreamModels(): DiscoverModel[] {
  return sortByRelease([
    // ── Gemma 4 (April 2026) ──
    { name: 'Gemma 4 31B', description: 'Google Gemma 4 31B — frontier dense model, native tools + vision. 256K context.', tags: ['31B', 'Q4_K_M', '20 GB'], updated: 'Hot', hot: true, agent: true, released: '2026-04', downloadUrl: HF('unsloth/gemma-4-31B-it-GGUF', 'gemma-4-31B-it-Q4_K_M.gguf'), filename: 'gemma-4-31B-it-Q4_K_M.gguf', sizeGB: 20 },
    { name: 'Gemma 4 26B MoE', description: 'Gemma 4 26B MoE — 26B brain, runs like 4B. Tools + vision. Apache 2.0.', tags: ['26B', 'Q4_K_XL', '18 GB'], updated: 'Hot', hot: true, agent: true, released: '2026-04', downloadUrl: HF('unsloth/gemma-4-26B-A4B-it-GGUF', 'gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf'), filename: 'gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf', sizeGB: 18 },
    { name: 'Gemma 4 E4B', description: 'Gemma 4 E4B — lightweight 4.5B, great for small GPUs.', tags: ['4.5B', 'Q4_K_M', '5 GB'], updated: 'Hot', hot: true, released: '2026-04', downloadUrl: HF('unsloth/gemma-4-E4B-it-GGUF', 'gemma-4-E4B-it-Q4_K_M.gguf'), filename: 'gemma-4-E4B-it-Q4_K_M.gguf', sizeGB: 5 },
    { name: 'Gemma 4 E2B', description: 'Gemma 4 E2B — ultra-light 2.3B, runs on anything.', tags: ['2.3B', 'Q4_K_M', '3 GB'], updated: 'New', released: '2026-04', downloadUrl: HF('unsloth/gemma-4-E2B-it-GGUF', 'gemma-4-E2B-it-Q4_K_M.gguf'), filename: 'gemma-4-E2B-it-Q4_K_M.gguf', sizeGB: 3 },
    // ── Qwen 3.5 (March 2026) ──
    { name: 'Qwen 3.5 35B MoE', description: 'Qwen 3.5 35B MoE — best agentic, 256K context. SWE-bench leader.', tags: ['35B', 'Q4_K_M', '22 GB'], updated: 'Hot', hot: true, agent: true, released: '2026-03', downloadUrl: HF('unsloth/Qwen3.5-35B-A3B-GGUF', 'Qwen3.5-35B-A3B-Q4_K_M.gguf'), filename: 'Qwen3.5-35B-A3B-Q4_K_M.gguf', sizeGB: 22 },
    { name: 'Qwen 3.5 27B', description: 'Qwen 3.5 27B dense — strongest reasoning + coding.', tags: ['27B', 'Q4_K_M', '17 GB'], updated: 'Hot', hot: true, released: '2026-03', downloadUrl: HF('unsloth/Qwen3.5-27B-GGUF', 'Qwen3.5-27B-Q4_K_M.gguf'), filename: 'Qwen3.5-27B-Q4_K_M.gguf', sizeGB: 17 },
    { name: 'Qwen 3.5 9B', description: 'Qwen 3.5 9B — excellent balance of speed and quality.', tags: ['9B', 'Q4_K_M', '6 GB'], updated: 'New', released: '2026-03', downloadUrl: HF('unsloth/Qwen3.5-9B-GGUF', 'Qwen3.5-9B-Q4_K_M.gguf'), filename: 'Qwen3.5-9B-Q4_K_M.gguf', sizeGB: 6 },
    // ── GPT-OSS (March 2026) ──
    { name: 'GPT-OSS 20B', description: 'OpenAI GPT-OSS — open-source GPT model, strong all-rounder.', tags: ['20B', 'Q4_K_M', '13 GB'], updated: 'Hot', hot: true, released: '2026-03', downloadUrl: HF('unsloth/gpt-oss-20b-GGUF', 'gpt-oss-20b-Q4_K_M.gguf'), filename: 'gpt-oss-20b-Q4_K_M.gguf', sizeGB: 13 },
    // ── Qwen3-Coder (March 2026) ──
    { name: 'Qwen3-Coder-Next', description: 'Qwen3-Coder-Next — 80B MoE, optimized for agentic coding.', tags: ['80B MoE', 'Q4_K_M', '25 GB'], updated: 'Hot', hot: true, agent: true, released: '2026-03', downloadUrl: HF('unsloth/Qwen3-Coder-Next-GGUF', 'Qwen3-Coder-Next-Q4_K_M.gguf'), filename: 'Qwen3-Coder-Next-Q4_K_M.gguf', sizeGB: 25 },
    // ── DeepSeek (Jan-Jun 2025) ──
    { name: 'DeepSeek R1 Qwen3 8B', description: 'DeepSeek R1 distilled into Qwen3 8B — chain-of-thought reasoning.', tags: ['8B', 'Q4_K_M', '5 GB'], updated: 'Popular', released: '2025-06', downloadUrl: HF('unsloth/DeepSeek-R1-0528-Qwen3-8B-GGUF', 'DeepSeek-R1-0528-Qwen3-8B-Q4_K_M.gguf'), filename: 'DeepSeek-R1-0528-Qwen3-8B-Q4_K_M.gguf', sizeGB: 5 },
    { name: 'DeepSeek R1 Qwen 14B', description: 'DeepSeek R1 distilled into Qwen 14B — stronger reasoning.', tags: ['14B', 'Q4_K_M', '9 GB'], updated: 'Popular', released: '2025-01', downloadUrl: HF('unsloth/DeepSeek-R1-Distill-Qwen-14B-GGUF', 'DeepSeek-R1-Distill-Qwen-14B-Q4_K_M.gguf'), filename: 'DeepSeek-R1-Distill-Qwen-14B-Q4_K_M.gguf', sizeGB: 9 },
    // ── Qwen 3 (May 2025) ──
    { name: 'Qwen 3 8B', description: 'Qwen 3 8B — top-tier reasoning and coding. Thinking mode.', tags: ['8B', 'Q4_K_M', '5 GB'], updated: 'Popular', agent: true, released: '2025-05', downloadUrl: HF('unsloth/Qwen3-8B-GGUF', 'Qwen3-8B-Q4_K_M.gguf'), filename: 'Qwen3-8B-Q4_K_M.gguf', sizeGB: 5 },
    { name: 'Qwen 3 4B', description: 'Qwen 3 4B — fast, lightweight, solid for small GPUs.', tags: ['4B', 'Q4_K_M', '3 GB'], updated: 'Popular', released: '2025-05', downloadUrl: HF('unsloth/Qwen3-4B-GGUF', 'Qwen3-4B-Q4_K_M.gguf'), filename: 'Qwen3-4B-Q4_K_M.gguf', sizeGB: 3 },
    // ── Llama 4 (April 2025) ──
    { name: 'Llama 4 Scout', description: 'Meta Llama 4 Scout — 16x17B MoE. Massive context window.', tags: ['Scout', 'Q2_K_XL', '65 GB'], updated: 'New', agent: true, released: '2025-04', downloadUrl: HF('unsloth/Llama-4-Scout-17B-16E-Instruct-GGUF', 'Llama-4-Scout-17B-16E-Instruct-UD-Q2_K_XL.gguf'), filename: 'Llama-4-Scout-17B-16E-Instruct-UD-Q2_K_XL.gguf', sizeGB: 65 },
    // ── Gemma 3 (March 2025) ──
    { name: 'Gemma 3 12B', description: 'Google Gemma 3 12B — vision support, great quality.', tags: ['12B', 'Q4_K_M', '8 GB'], updated: 'Popular', released: '2025-03', downloadUrl: HF('unsloth/gemma-3-12b-it-GGUF', 'gemma-3-12b-it-Q4_K_M.gguf'), filename: 'gemma-3-12b-it-Q4_K_M.gguf', sizeGB: 8 },
    { name: 'Gemma 3 27B', description: 'Google Gemma 3 27B — strong reasoning + vision.', tags: ['27B', 'Q4_K_M', '17 GB'], updated: 'Popular', released: '2025-03', downloadUrl: HF('unsloth/gemma-3-27b-it-GGUF', 'gemma-3-27b-it-Q4_K_M.gguf'), filename: 'gemma-3-27b-it-Q4_K_M.gguf', sizeGB: 17 },
    // ── Phi 4 (Dec 2024) ──
    { name: 'Phi-4 14B', description: 'Microsoft Phi-4 — excellent at math, logic, structured tasks.', tags: ['14B', 'Q4_K_M', '9 GB'], updated: 'Popular', agent: true, released: '2024-12', downloadUrl: HF('bartowski/phi-4-GGUF', 'phi-4-Q4_K_M.gguf'), filename: 'phi-4-Q4_K_M.gguf', sizeGB: 9 },
    // ── Llama 3.3 / 3.1 ──
    { name: 'Llama 3.3 70B', description: 'Meta Llama 3.3 70B — maximum intelligence for high-end setups.', tags: ['70B', 'Q4_K_M', '42 GB'], updated: 'Popular', released: '2024-12', downloadUrl: HF('bartowski/Llama-3.3-70B-Instruct-GGUF', 'Llama-3.3-70B-Instruct-Q4_K_M.gguf'), filename: 'Llama-3.3-70B-Instruct-Q4_K_M.gguf', sizeGB: 42 },
    { name: 'Llama 3.1 8B', description: 'Meta Llama 3.1 8B — fast, reliable, great entry point.', tags: ['8B', 'Q4_K_M', '5 GB'], updated: 'Popular', released: '2024-07', downloadUrl: HF('bartowski/Meta-Llama-3.1-8B-Instruct-GGUF', 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf'), filename: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf', sizeGB: 5 },
    // ── Mistral ──
    { name: 'Mistral Small 24B', description: 'Mistral Small — fast, multilingual, native tool calling.', tags: ['24B', 'Q4_K_M', '14 GB'], updated: 'Popular', agent: true, released: '2024-09', downloadUrl: HF('bartowski/Mistral-Small-24B-Instruct-2501-GGUF', 'Mistral-Small-24B-Instruct-2501-Q4_K_M.gguf'), filename: 'Mistral-Small-24B-Instruct-2501-Q4_K_M.gguf', sizeGB: 14 },
    { name: 'Mistral Nemo 12B', description: 'Mistral Nemo 12B — multilingual powerhouse.', tags: ['12B', 'Q4_K_M', '7 GB'], updated: 'Popular', released: '2024-07', downloadUrl: HF('bartowski/Mistral-Nemo-Instruct-2407-GGUF', 'Mistral-Nemo-Instruct-2407-Q4_K_M.gguf'), filename: 'Mistral-Nemo-Instruct-2407-Q4_K_M.gguf', sizeGB: 7 },
    // ── Qwen 2.5 ──
    { name: 'Qwen 2.5 7B', description: 'Qwen 2.5 7B — proven and reliable all-rounder.', tags: ['7B', 'Q4_K_M', '5 GB'], updated: 'Popular', released: '2024-09', downloadUrl: HF('bartowski/Qwen2.5-7B-Instruct-GGUF', 'Qwen2.5-7B-Instruct-Q4_K_M.gguf'), filename: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf', sizeGB: 5 },
  ])
}

/** Combined HF models for search fallback */
export function getHuggingFaceModels(): DiscoverModel[] {
  return [...getHuggingFaceUncensoredModels(), ...getHuggingFaceMainstreamModels()]
}

/** Search HuggingFace for GGUF models */
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
      // Derive Q4_K_M filename from repo name: "user/Model-Name-GGUF" → "Model-Name-Q4_K_M.gguf"
      const repoName = repo.id.split('/').pop() || ''
      const baseName = repoName.replace(/-GGUF$/i, '').replace(/-gguf$/i, '')
      const q4File = `${baseName}-Q4_K_M.gguf`
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

// ─── Image Model Bundles ───

export function getImageBundles(): ModelBundle[] {
  return [
    {
      name: 'Juggernaut XL V9 (Photorealistic)',
      description: 'Best photorealistic SDXL checkpoint. All-in-one — just install and generate.',
      tags: ['SDXL', 'Photorealistic', '1024px'],
      uncensored: true,
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
      hot: true,
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
      hot: true,
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
      name: 'DreamShaper XL Turbo V2 (Anime/Stylized)',
      description: 'Fast anime and stylized art. Turbo mode for 4-step generation. Great for creative work.',
      tags: ['SDXL', 'Anime', 'Stylized', 'Turbo', '1024px'],
      uncensored: true,
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
    requiredNodes: ['FramePackModelLoader', 'FramePackEncode', 'FramePackSampler'],
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
}

export function getVideoBundles(): ModelBundle[] {
  return [
    {
      name: 'Wan 2.1 — 1.3B (Lightweight)',
      description: 'Best for 8-10 GB VRAM GPUs. Generates 480p video. Fast and lightweight.',
      tags: ['Wan 2.1', '480p', 'Fast'],
      hot: true,
      uncensored: true,
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
      hot: true,
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
      hot: true,
      uncensored: true,
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
