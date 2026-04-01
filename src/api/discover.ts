import { backendCall, fetchExternal } from "./backend"

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
}

export interface DownloadProgress {
  progress: number
  total: number
  speed: number
  filename: string
  status: 'connecting' | 'downloading' | 'complete' | 'error'
  error?: string
}

// ─── Download API ───

export async function startModelDownload(url: string, subfolder: string, filename: string): Promise<{ status: string; id: string; error?: string }> {
  return backendCall("download_model", { url, subfolder, filename })
}

export async function getDownloadProgress(): Promise<Record<string, DownloadProgress>> {
  try {
    return await backendCall("download_progress")
  } catch {
    return {}
  }
}

// ─── Ollama Text Models ───

export async function fetchAbliteratedModels(): Promise<DiscoverModel[]> {
  try {
    // In Tauri production mode, we can't proxy to ollama.com — fall back to curated list
    const { isTauri } = await import("./backend")
    if (isTauri()) {
      return getCuratedTextModels()
    }

    const res = await fetch('/ollama-search?q=abliterated&p=1')
    const html = await res.text()

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

    if (models.length === 0) return getCuratedTextModels()
    return models
  } catch {
    return getCuratedTextModels()
  }
}

function getCuratedTextModels(): DiscoverModel[] {
  return [
    { name: 'mannix/llama3.1-8b-abliterated', description: 'Llama 3.1 8B with safety filters removed', pulls: '200K+', tags: ['8B', 'Q5_K_M'], updated: 'Popular' },
    { name: 'huihui_ai/qwen2.5-abliterated', description: 'Qwen 2.5 abliterated series', pulls: '50K+', tags: ['7B', '14B', '32B'], updated: 'Popular' },
    { name: 'richardyoung/qwen3-14b-abliterated', description: 'Qwen3 14B with 80% reduced refusals', pulls: '4K+', tags: ['14B', 'Q4_K_M'], updated: 'Recent' },
    { name: 'huihui_ai/qwen3-abliterated', description: 'Qwen3 abliterated series', pulls: '30K+', tags: ['8B', '30B'], updated: 'Popular' },
    { name: 'huihui_ai/gemma3-abliterated', description: 'Google Gemma 3 abliterated', pulls: '20K+', tags: ['4B', '12B', '27B'], updated: 'Recent' },
    { name: 'huihui_ai/llama3.3-abliterated', description: 'Llama 3.3 70B abliterated', pulls: '15K+', tags: ['70B'], updated: 'Popular' },
    { name: 'huihui_ai/deepseek-r1-abliterated', description: 'DeepSeek R1 abliterated reasoning', pulls: '40K+', tags: ['8B', '14B', '32B', '70B'], updated: 'Recent' },
    { name: 'huihui_ai/mistral-small-abliterated', description: 'Mistral Small 24B abliterated', pulls: '10K+', tags: ['24B'], updated: 'Recent' },
    { name: 'krith/mistral-nemo-instruct-2407-abliterated', description: 'Mistral Nemo 12B abliterated', pulls: '5K+', tags: ['12B'], updated: 'Popular' },
    { name: 'huihui_ai/phi4-abliterated', description: 'Microsoft Phi-4 abliterated', pulls: '8K+', tags: ['14B'], updated: 'Recent' },
  ]
}

// ─── Image Model Bundles ───

export function getImageBundles(): ModelBundle[] {
  return [
    {
      name: 'Juggernaut XL V9 (Photorealistic)',
      description: 'Best photorealistic SDXL checkpoint. All-in-one — just install and generate.',
      tags: ['SDXL', 'Photorealistic', '1024px'],
      totalSizeGB: 6.5,
      vramRequired: '6-8 GB',
      workflow: 'wan', // not used for image, just satisfies type
      url: 'https://civitai.com/models/133005/juggernaut-xl',
      files: [
        {
          name: 'Juggernaut XL V9',
          description: 'SDXL checkpoint — includes VAE and CLIP.',
          pulls: '', tags: ['Checkpoint', '6.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/RunDiffusion/Juggernaut-XL-v9/resolve/main/Juggernaut-XL_v9_RunDiffusion.safetensors',
          filename: 'Juggernaut-XL_v9.safetensors', subfolder: 'checkpoints', sizeGB: 6.5,
        },
      ],
    },
    {
      name: 'RealVisXL V5 (Photorealistic)',
      description: 'Great for portraits, landscapes, and product photos. Ready to use.',
      tags: ['SDXL', 'Photorealistic', '1024px'],
      totalSizeGB: 6.5,
      vramRequired: '6-8 GB',
      workflow: 'wan',
      url: 'https://civitai.com/models/139562/realvisxl',
      files: [
        {
          name: 'RealVisXL V5',
          description: 'SDXL checkpoint — includes VAE and CLIP.',
          pulls: '', tags: ['Checkpoint', '6.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/SG161222/RealVisXL_V5.0/resolve/main/RealVisXL_V5.0.safetensors',
          filename: 'RealVisXL_V5.safetensors', subfolder: 'checkpoints', sizeGB: 6.5,
        },
      ],
    },
    {
      name: 'FLUX.1 [schnell] (Fast & Modern)',
      description: 'State-of-the-art image gen. 1-4 steps for fast results. Needs FLUX VAE + CLIP.',
      tags: ['FLUX', 'Fast', '1024px'],
      totalSizeGB: 11.8,
      vramRequired: '10-12 GB',
      workflow: 'wan',
      url: 'https://huggingface.co/black-forest-labs/FLUX.1-schnell',
      files: [
        {
          name: 'FLUX.1 schnell Model',
          description: 'The main FLUX diffusion model.',
          pulls: '', tags: ['Model', '11.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/black-forest-labs/FLUX.1-schnell/resolve/main/flux1-schnell.safetensors',
          filename: 'flux1-schnell.safetensors', subfolder: 'diffusion_models', sizeGB: 11.5,
        },
        {
          name: 'FLUX VAE',
          description: 'Required autoencoder for FLUX.',
          pulls: '', tags: ['VAE', '335 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/black-forest-labs/FLUX.1-schnell/resolve/main/ae.safetensors',
          filename: 'flux-ae.safetensors', subfolder: 'vae', sizeGB: 0.3,
        },
      ],
    },
    {
      name: 'FLUX.1 [dev] (High Quality)',
      description: 'Highest quality FLUX. More steps but better results. Needs FLUX VAE + CLIP.',
      tags: ['FLUX', 'Quality', '1024px'],
      totalSizeGB: 11.8,
      vramRequired: '10-12 GB',
      workflow: 'wan',
      url: 'https://huggingface.co/black-forest-labs/FLUX.1-dev',
      files: [
        {
          name: 'FLUX.1 dev Model',
          description: 'The main FLUX diffusion model (dev variant).',
          pulls: '', tags: ['Model', '11.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/flux1-dev.safetensors',
          filename: 'flux1-dev.safetensors', subfolder: 'diffusion_models', sizeGB: 11.5,
        },
        {
          name: 'FLUX VAE',
          description: 'Required autoencoder for FLUX.',
          pulls: '', tags: ['VAE', '335 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/black-forest-labs/FLUX.1-schnell/resolve/main/ae.safetensors',
          filename: 'flux-ae.safetensors', subfolder: 'vae', sizeGB: 0.3,
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

export interface ModelBundle {
  name: string
  description: string
  tags: string[]
  totalSizeGB: number
  vramRequired: string
  workflow: 'wan' | 'animatediff'
  files: DiscoverModel[]
  url?: string
}

export function getVideoBundles(): ModelBundle[] {
  return [
    {
      name: 'Wan 2.1 — 1.3B (Lightweight)',
      description: 'Best for 8-10 GB VRAM GPUs. Generates 480p video. Fast and lightweight.',
      tags: ['Wan 2.1', '480p', 'Fast'],
      totalSizeGB: 7.6,
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
          filename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 4.9,
        },
      ],
    },
    {
      name: 'Wan 2.1 — 14B FP8 (High Quality)',
      description: 'Best quality for 12+ GB VRAM. Generates up to 720p. Slower but much better results.',
      tags: ['Wan 2.1', '720p', 'Quality'],
      totalSizeGB: 19.1,
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
          filename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 4.9,
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
