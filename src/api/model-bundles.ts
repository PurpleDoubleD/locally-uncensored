/**
 * Der Download-Katalog: welche Dateien es gibt, wie groß sie sind und in
 * welchen ComfyUI-Ordner sie gehören. Reine Daten plus die Formen, die sie
 * beschreiben — dieses Modul importiert außer einem Typ nichts.
 *
 * Audit W-T2: Der Katalog stand in api/discover.ts, dem Modul, das Downloads
 * anstößt und ComfyUI nach installierten Dateien fragt. api/comfyui.ts braucht
 * aus dem Katalog nur die erwarteten Dateigrößen (filterPartialFiles blendet
 * angefangene Downloads aus) — und discover.ts braucht umgekehrt ein Dutzend
 * Loader aus comfyui.ts. comfyui.ts hat sich deshalb mit
 * `await import('./discover')` mitten in getKnownFileSizes() beholfen, mit dem
 * Kommentar "we defer the import to break the cycle at runtime".
 *
 * Der Zyklus war echt, der dynamische Import hat ihn nur unsichtbar gemacht.
 * Aufgelöst wird er dort, wo er entsteht: Daten, die beide Seiten brauchen,
 * gehören keiner der beiden Seiten. Der Katalog liegt jetzt hier, comfyui.ts
 * und discover.ts lesen ihn beide statisch, und discover.ts re-exportiert
 * jeden Namen weiter, damit kein Aufrufer und kein Test seinen Importpfad
 * ändern muss.
 */

import type { ProviderId } from './providers/types'

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
  // Vision projector that belongs to `downloadUrl`. A text GGUF carries no
  // image tower: llama.cpp keeps it in a separate mmproj file and only sees
  // images when the server is started with `--mmproj`. When this is set the
  // download writes BOTH files into the model folder and the built-in engine
  // picks the projector up by name (see `mmprojFileName`). Ollama entries never
  // need it, their tag already ships a projector layer.
  mmprojUrl?: string
  mmprojSizeGB?: number
  // Discovery flags
  hot?: boolean       // Featured/trending model
  agent?: boolean     // Supports Agent Mode tool calling
  released?: string   // Release date YYYY-MM for sorting (newest first)
  // F4 (juliandiggins-stack GH#21): explicit CPU-only / ≤8 GB RAM
  // tag. Surfaces a green "CPU-friendly" badge in DiscoverModels and
  // exposes the optional "Lightweight" filter. Set true for ≤4B
  // unfiltered models we have personally test-loaded on a CPU-only
  // 8 GB box.
  lightweight?: boolean
  // Multi-provider
  provider?: ProviderId   // Which provider this model belongs to
  providerName?: string   // Display name of the provider
  canPull?: boolean       // false = no download/pull capability (cloud/external)
  ollamaModel?: string    // Ollama model tag for `ollama pull` (e.g. 'qwen3.6')
  // Model Hub grouping (2.5.8 redesign): entries that are the SAME model in a
  // different quant share a `group` and render as ONE card with a size picker.
  // Different parameter sizes stay separate cards on purpose.
  group?: string
  // Optional hand-written one-liner for the card. When absent the card derives
  // a short line from `description` (text after the first "·", first sentence).
  blurb?: string
  /**
   * SHA256 of the file at `downloadUrl`, 64 hex characters.
   *
   * The only thing that can tell a complete multi-gigabyte model from a
   * plausible-looking truncated one. `sizeGB` cannot: it is a rounded human
   * number ("9.2"), which is why the old completeness check ran on a 10 %
   * tolerance and accepted a download that died at 91 %.
   *
   * Optional on purpose. HuggingFace states this digest for every LFS file
   * (`lfs.oid` in the tree API, which `resolveHfGgufFiles` now reads), but the
   * hand-written catalog entries below carry none yet. When it is absent the
   * download is checked against the server's exact byte count and the Rust side
   * logs, per file, that the CONTENT went unverified.
   */
  sha256?: string
}

// ─── Image Model Bundles ───

export function getImageBundles(): ModelBundle[] {
  return [
    {
      name: 'Juggernaut XL V9 (Photorealistic)',
      description: 'Best photorealistic SDXL checkpoint. All in one. Just install and generate.',
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
          description: 'SDXL checkpoint · includes VAE and CLIP.',
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
          description: 'SDXL checkpoint · includes VAE and CLIP.',
          pulls: '', tags: ['Checkpoint', '6.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/SG161222/RealVisXL_V5.0/resolve/main/RealVisXL_V5.0_fp16.safetensors',
          filename: 'RealVisXL_V5.safetensors', subfolder: 'checkpoints', sizeGB: 6.5,
        },
      ],
    },
    {
      name: 'FLUX.1 [schnell] FP8 (Fast & Modern)',
      description: 'State of the art image gen. 1 to 4 steps for fast results. Complete package with all required encoders.',
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
          description: 'Required autoencoder for FLUX.1 (16 channel ae).',
          pulls: '', tags: ['VAE', '335 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors',
          filename: 'ae.safetensors', subfolder: 'vae', sizeGB: 0.3,
        },
        {
          name: 'T5-XXL Text Encoder (FP8)',
          description: 'Required text encoder for FLUX prompt understanding.',
          pulls: '', tags: ['Text Encoder', '4.6 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors',
          filename: 't5xxl_fp8_e4m3fn.safetensors', subfolder: 'text_encoders', sizeGB: 4.6,
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
          description: 'Required autoencoder for FLUX.1 (16 channel ae).',
          pulls: '', tags: ['VAE', '335 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors',
          filename: 'ae.safetensors', subfolder: 'vae', sizeGB: 0.3,
        },
        {
          name: 'T5-XXL Text Encoder (FP8)',
          description: 'Required text encoder for FLUX prompt understanding.',
          pulls: '', tags: ['Text Encoder', '4.6 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors',
          filename: 't5xxl_fp8_e4m3fn.safetensors', subfolder: 'text_encoders', sizeGB: 4.6,
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
      name: 'FLUX 2 Klein 4B (Next Gen)',
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
          description: 'FLUX 2 Klein diffusion model · next gen image generation.',
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
      name: 'Z-Image Turbo (Unfiltered, Fast)',
      description: 'Explicitly unfiltered image model. 8 to 15 seconds per image. No safety filters. Text to Image and Image to Image.',
      tags: ['Z-Image', 'Unfiltered', 'Fast', '1024px'],
      uncensored: true,
      verified: true,
      totalSizeGB: 19.3,
      vramRequired: '10-16 GB',
      workflow: 'zimage',
      url: 'https://huggingface.co/Comfy-Org/z_image_turbo',
      files: [
        {
          name: 'Z-Image Turbo BF16',
          description: 'Unfiltered diffusion model · no safety filters, fast generation.',
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
      name: 'Z-Image Base (Unfiltered, Quality)',
      description: 'Highest quality unfiltered model. 30 to 50 steps for maximum detail and composition diversity. Shares VAE/CLIP with Z-Image Turbo.',
      tags: ['Z-Image', 'Unfiltered', 'Quality', '1024px'],
      uncensored: true,
      verified: true,
      totalSizeGB: 19.3,
      vramRequired: '10-16 GB',
      workflow: 'zimage',
      url: 'https://huggingface.co/Comfy-Org/z_image',
      files: [
        {
          name: 'Z-Image Base BF16',
          description: 'Unfiltered diffusion model · maximum quality, more compositional diversity.',
          pulls: '', tags: ['Diffusion Model', '11.5 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/diffusion_models/z_image_bf16.safetensors',
          filename: 'z_image_bf16.safetensors', subfolder: 'diffusion_models', sizeGB: 11.5,
        },
        {
          name: 'Z-Image VAE',
          description: 'Required autoencoder · shared with Z-Image Turbo.',
          pulls: '', tags: ['VAE', '335 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/vae/ae.safetensors',
          filename: 'ae.safetensors', subfolder: 'vae', sizeGB: 0.3,
        },
        {
          name: 'Qwen 3 4B Text Encoder',
          description: 'Required text encoder · shared with Z-Image Turbo.',
          pulls: '', tags: ['Text Encoder', '7.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors',
          filename: 'qwen_3_4b.safetensors', subfolder: 'text_encoders', sizeGB: 7.5,
        },
      ],
    },
    {
      name: 'DreamShaper XL Turbo V2 (Anime/Stylized)',
      description: 'Fast anime and stylized art. Turbo mode for 4 step generation. Great for creative work.',
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
          description: 'SDXL checkpoint · anime and stylized art, turbo mode.',
          pulls: '', tags: ['Checkpoint', '6.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Lykon/dreamshaper-xl-v2-turbo/resolve/main/DreamShaperXL_Turbo_V2-SFW.safetensors',
          filename: 'DreamShaperXL_Turbo_V2.safetensors', subfolder: 'checkpoints', sizeGB: 6.5,
        },
      ],
    },
    {
      name: 'ERNIE-Image Turbo',
      description: 'Baidu ERNIE-Image Turbo · 8B DiT, 8 steps, 1024x1024. Fastest ERNIE variant with Ministral-3B encoder + Prompt Enhancer.',
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
          description: 'Required autoencoder · shared with FLUX 2.',
          pulls: '', tags: ['VAE', '335 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/vae/flux2-vae.safetensors',
          filename: 'flux2-vae.safetensors', subfolder: 'vae', sizeGB: 0.3,
        },
      ],
    },
    {
      name: 'ERNIE-Image Base',
      description: 'Baidu ERNIE-Image Base · 8B DiT, 50 steps, 1024x1024. Highest quality ERNIE variant.',
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
          description: 'Required autoencoder · shared with FLUX 2.',
          pulls: '', tags: ['VAE', '335 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/vae/flux2-vae.safetensors',
          filename: 'flux2-vae.safetensors', subfolder: 'vae', sizeGB: 0.3,
        },
      ],
    },
    {
      name: 'SDXL VAE (fp16-fix) · addon',
      description: 'Standard SDXL VAE (madebyollin fp16-fix). Optional VAE override for any SDXL checkpoint; fixes washed out / desaturated output on some models. After download, pick it under Advanced → VAE.',
      tags: ['SDXL', 'VAE', 'Addon'],
      verified: true,
      totalSizeGB: 0.33,
      vramRequired: 'any',
      workflow: 'sdxl',
      url: 'https://huggingface.co/madebyollin/sdxl-vae-fp16-fix',
      files: [
        {
          name: 'SDXL VAE fp16-fix',
          description: 'Drop in SDXL VAE → models/vae.',
          pulls: '', tags: ['VAE', '335 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/madebyollin/sdxl-vae-fp16-fix/resolve/main/sdxl_vae.safetensors',
          filename: 'sdxl_vae.safetensors', subfolder: 'vae', sizeGB: 0.33,
        },
      ],
    },
    {
      name: 'Pixel Art XL · SDXL LoRA',
      description: 'nerijs Pixel Art XL · turns any SDXL model into crisp pixel art. A clearly visible style LoRA. After download, pick it under Advanced → LoRA and raise the strength.',
      tags: ['SDXL', 'LoRA', 'Style'],
      verified: true,
      totalSizeGB: 0.17,
      vramRequired: 'any',
      workflow: 'sdxl',
      url: 'https://huggingface.co/nerijs/pixel-art-xl',
      files: [
        {
          name: 'Pixel Art XL LoRA',
          description: 'SDXL pixel art style LoRA → models/loras.',
          pulls: '', tags: ['LoRA', '170 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/nerijs/pixel-art-xl/resolve/main/pixel-art-xl.safetensors',
          filename: 'pixel-art-xl.safetensors', subfolder: 'loras', sizeGB: 0.17,
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
  // VHS_VideoCombine · the ONLY ComfyUI node that produces actual .mp4 video
  // output. Without it, the workflow falls back to SaveAnimatedWEBP which
  // makes "video generation" emit an animated .webp file. Two reporters
  // (miguelkodoatie on Discord 2026-05-14, Turbulent_Tomato7559 on Reddit
  // 2026-05-10) hit this on v2.4.3/2.4.4: t2i works, t2v "succeeds" but the
  // output is a .webp that no video player will open. v2.4.4 added a
  // warning banner; v2.4.5 makes it a one-click install instead.
  'videohelpersuite': {
    repo: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite',
    name: 'ComfyUI-VideoHelperSuite',
    requiredNodes: ['VHS_VideoCombine', 'VHS_LoadVideo'],
  },
  // Background removal (Create → Remove Background). ComfyUI-RMBG registers the
  // `RMBG` node · the exact class the capability probe + workflow builder look
  // for · and auto-downloads its cutout model (BiRefNet / RMBG-2.0, ~300 MB)
  // into ComfyUI/models/RMBG on first use. So the one-click action only needs to
  // install the node; the model lands on the first cutout run.
  'rmbg': {
    repo: 'https://github.com/1038lab/ComfyUI-RMBG',
    name: 'ComfyUI-RMBG',
    requiredNodes: ['RMBG'],
  },
  // GGUF quant loader (city96). Lets the 2.5.8 lanes offer Q4 quants of the
  // 14B Wan models (S2V / Animate / NSFW finetunes) — the difference between
  // "needs 16 GB on disk and heavy offload" and "runs comfortably on 12 GB".
  // requirements.txt is just the gguf package, no exotic wheels.
  'gguf': {
    repo: 'https://github.com/city96/ComfyUI-GGUF',
    name: 'ComfyUI-GGUF',
    requiredNodes: ['UnetLoaderGGUF'],
  },
  // Pose extraction for the local Motion Control lane (DWPose skeletons feed
  // WanAnimateToVideo / WanVaceToVideo). Its requirements pull the CPU
  // onnxruntime wheel — works on every Windows box, no GPU wheel roulette;
  // the DWPose onnx models auto-download on first run.
  'controlnet-aux': {
    repo: 'https://github.com/Fannovel16/comfyui_controlnet_aux',
    name: 'comfyui_controlnet_aux',
    requiredNodes: ['DWPreprocessor'],
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
      name: 'Wan 2.1 · 1.3B (Lightweight)',
      description: 'Best for 8 to 10 GB VRAM GPUs. Generates 480p video. Fast and lightweight.',
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
      name: 'Wan 2.1 · 14B FP8 (High Quality)',
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
      name: 'Wan 2.2 · TI2V 5B (Image + Text to Video)',
      description: 'Wan 2.2 TI2V-5B · ONE model for both text to video and faithful image to video (the clip opens on your source image). Native 1280×704 @ 24 fps, smooth 2 to 7 s clips. The best quality video model that fits 12 GB.',
      tags: ['Wan 2.2', '720p', 'I2V', 'T2V', 'Quality'],
      uncensored: true,
      verified: true,
      i2v: true,
      hot: true,
      totalSizeGB: 16.9,
      vramRequired: '12+ GB',
      workflow: 'wan22',
      url: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged',
      files: [
        {
          name: 'Wan 2.2 TI2V 5B Model (FP16)',
          description: 'The unified text + image to video model.',
          pulls: '', tags: ['Model', '~9.3 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors',
          filename: 'wan2.2_ti2v_5B_fp16.safetensors', subfolder: 'diffusion_models', sizeGB: 9.3,
        },
        {
          name: 'Wan 2.2 VAE',
          description: 'Required video encoder/decoder · the 2.2 VAE (NOT the 2.1 VAE: higher compression, different latent shape).',
          pulls: '', tags: ['VAE', '~1.3 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors',
          filename: 'wan2.2_vae.safetensors', subfolder: 'vae', sizeGB: 1.3,
        },
        {
          name: 'Wan CLIP (UMT5-XXL FP8)',
          description: 'Required text encoder · shared with Wan 2.1, so it is skipped if already installed.',
          pulls: '', tags: ['CLIP', '6.3 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
          filename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 6.3,
        },
      ],
    },
    {
      name: 'HunyuanVideo 1.5 T2V FP8 (High Quality)',
      description: 'Tencent HunyuanVideo 1.5 · excellent temporal consistency and visual quality. 480p text to video with CFG distillation.',
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
          pulls: '', tags: ['Text Encoder', '8.8 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors',
          filename: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 8.8,
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
      name: 'LTX Video 2.3 · 22B FP8 (Latest)',
      description: 'Lightricks LTX Video 2.3 · fast inference, high quality. Uses Gemma 3 12B text encoder. Distilled for speed.',
      tags: ['LTX 2.3', '22B', 'Quality'],
      verified: true,
      totalSizeGB: 40,
      vramRequired: '16+ GB',
      workflow: 'ltx',
      url: 'https://huggingface.co/Lightricks/LTX-2.3-fp8',
      files: [
        {
          name: 'LTX 2.3 22B Distilled FP8',
          description: 'Main video model · distilled for fast inference.',
          pulls: '', tags: ['Model', '~22 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Lightricks/LTX-2.3-fp8/resolve/main/ltx-2.3-22b-distilled-fp8.safetensors',
          filename: 'ltx-2.3-22b-distilled-fp8.safetensors', subfolder: 'diffusion_models', sizeGB: 27.5,
        },
        {
          name: 'Gemma 3 12B Text Encoder (FP8)',
          description: 'Required text encoder for LTX Video 2.x.',
          pulls: '', tags: ['Text Encoder', '12.4 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ltx-2/resolve/main/split_files/text_encoders/gemma_3_12B_it_fp8_scaled.safetensors',
          filename: 'gemma_3_12B_it_fp8_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 12.4,
        },
      ],
    },
    // ─── NEW VIDEO BUNDLES ───
    {
      name: 'AnimateDiff Lightning',
      description: 'Ultra fast 4 step animation on any SD1.5 checkpoint. Great for quick iterations. Needs an SD1.5 base model.',
      tags: ['AnimateDiff', '512x512', 'Lightning'],
      verified: true,
      totalSizeGB: 2.8,
      vramRequired: '6-8 GB',
      workflow: 'animatediff',
      customNodes: ['animatediff-evolved'],
      url: 'https://huggingface.co/ByteDance/AnimateDiff-Lightning',
      files: [
        {
          name: 'AnimateDiff Lightning Motion Model (4 step)',
          description: 'Lightning fast motion model. Only 4 sampling steps needed.',
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
          description: 'Standard motion model · 20 steps, good quality.',
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
    // CogVideoX removed 2026-07-24 (D#88) · both bundles were 21 GB of download
    // for a lane that could never run. buildCogVideoWorkflow emits five class
    // types that exist in no version of kijai/ComfyUI-CogVideoXWrapper
    // (CogVideoXCLIPLoader, CogVideoXTextEncode, CogVideoXEmptyLatents,
    // CogVideoXSampler, CogVideoXVAEDecode · the real names are CogVideoTextEncode,
    // CogVideoSampler, CogVideoDecode and there is no empty latents node at all),
    // so every submit came back a 400. Verified against a real checkout of the
    // wrapper. Offering the download again needs a rebuilt builder plus a real
    // end to end run, not a rename. Wan, LTX and SVD cover the same ground and
    // are proven.
    {
      name: 'FramePack F1 (Image to Video)',
      description: 'Revolutionary I2V: runs on 6 GB VRAM via next frame prediction. Upload an image, get a video. Uses HunyuanVideo backbone.',
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
          description: 'Main I2V model · generates video from a single image.',
          pulls: '', tags: ['Model', '15.3 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Kijai/HunyuanVideo_comfy/resolve/main/FramePackI2V_HY_fp8_e4m3fn.safetensors',
          filename: 'FramePackI2V_HY_fp8_e4m3fn.safetensors', subfolder: 'diffusion_models', sizeGB: 15.3,
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
          description: 'Required video encoder/decoder (HunyuanVideo 1.0, the backbone FramePack was trained on).',
          pulls: '', tags: ['VAE', '493 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/resolve/main/split_files/vae/hunyuan_video_vae_bf16.safetensors',
          filename: 'hunyuan_video_vae_bf16.safetensors', subfolder: 'vae', sizeGB: 0.5,
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
      name: 'SVD-XT 1.1 (Image to Video)',
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
          description: 'Complete I2V model · no additional downloads needed.',
          pulls: '', tags: ['Checkpoint', '4.8 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/vdo/stable-video-diffusion-img2vid-xt-1-1/resolve/main/svd_xt_1_1.safetensors',
          filename: 'svd_xt_1_1.safetensors', subfolder: 'checkpoints', sizeGB: 4.8,
        },
      ],
    },
    {
      name: 'Mochi 1 Preview (FP8)',
      description: 'Genmo Mochi · 848x480 video at 24 FPS. Good motion and temporal consistency. Native ComfyUI support.',
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
    // Pyramid Flow removed 2026-07-24 (same audit as CogVideoX) · the builder was
    // written against invented node names too. Checked against a real checkout of
    // kijai/ComfyUI-PyramidFlowWrapper: the loader is registered as
    // PyramidFlowTransformerLoader (not PyramidFlowModelLoader), decode is
    // PyramidFlowVAEDecode (not PyramidFlowDecode) and needs a vae input we never
    // wired, the text encoder takes clip + positive_prompt + negative_prompt (we
    // passed a single `text` and no CLIP at all), and the sampler wants
    // prompt_embeds plus per stage step strings rather than steps and frames. That
    // is a rewrite, not a rename, so the 4.6 GB download comes back only with a
    // real run behind it.
    // Allegro removed · diffusers format only, no single-file safetensors available for one-click install
    {
      name: 'NVIDIA Cosmos 7B',
      description: 'NVIDIA Cosmos Diffusion 7B Text to World. 1024x1024 output at 24 FPS. Native ComfyUI support. Uses oldt5 text encoder (NOT t5xxl).',
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
          description: 'Required text encoder · NOT the same as regular T5-XXL!',
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
    {
      name: 'NSFW Wan 14B (Uncensored, GGUF)',
      description: 'Full uncensored finetune of Wan 2.1 14B. Text to video, motion trained in, no helper LoRA needed.',
      tags: ['Wan 2.1', 'Uncensored', 'GGUF', '480p'],
      uncensored: true,
      totalSizeGB: 15.5,
      vramRequired: '10-12 GB',
      workflow: 'wan',
      customNodes: ['gguf'],
      url: 'https://huggingface.co/NSFW-API/NSFW_Wan_14b',
      files: [
        {
          name: 'NSFW Wan 14B Q4 (GGUF)',
          description: 'The finetuned video model, final e15 epoch, Q4 quant.',
          pulls: '', tags: ['Model', '9 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/NSFW-API/NSFW_Wan_14b/resolve/main/nsfw_wan_14b_e15_q4_k.gguf',
          filename: 'nsfw_wan_14b_e15_q4_k.gguf', subfolder: 'diffusion_models', sizeGB: 9.0,
        },
        {
          name: 'Wan 2.1 VAE',
          description: 'Required video encoder/decoder.',
          pulls: '', tags: ['VAE', '250 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors',
          filename: 'wan_2.1_vae.safetensors', subfolder: 'vae', sizeGB: 0.24,
        },
        {
          name: 'Wan CLIP (UMT5-XXL FP8)',
          description: 'Required text encoder.',
          pulls: '', tags: ['CLIP', '6.3 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
          filename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 6.27,
        },
      ],
    },
    {
      name: 'Wan 2.2 Rapid AIO (Uncensored I2V, GGUF)',
      description: 'Uncensored Wan 2.2 image to video, lightning merged for few step renders. Great for Animate and Extend.',
      tags: ['Wan 2.2', 'Uncensored', 'I2V', 'GGUF', 'Fast'],
      uncensored: true,
      i2v: true,
      totalSizeGB: 16.6,
      vramRequired: '10-12 GB',
      workflow: 'wan',
      customNodes: ['gguf'],
      url: 'https://huggingface.co/desirel/WAN2.2-14B-Rapid-AllInOne-GGUF-NSFW-v10',
      files: [
        {
          name: 'Wan 2.2 Rapid AIO v10 Q4 (GGUF)',
          description: 'The merged uncensored i2v model, Q4 quant.',
          pulls: '', tags: ['Model', '10.1 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/desirel/WAN2.2-14B-Rapid-AllInOne-GGUF-NSFW-v10/resolve/main/wan2.2-i2v-rapid-aio-v10-nsfw-Q4_K_M.gguf',
          filename: 'wan2.2-i2v-rapid-aio-v10-nsfw-Q4_K_M.gguf', subfolder: 'diffusion_models', sizeGB: 10.1,
        },
        {
          name: 'Wan 2.1 VAE',
          description: 'Required video encoder/decoder.',
          pulls: '', tags: ['VAE', '250 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors',
          filename: 'wan_2.1_vae.safetensors', subfolder: 'vae', sizeGB: 0.24,
        },
        {
          name: 'Wan CLIP (UMT5-XXL FP8)',
          description: 'Required text encoder.',
          pulls: '', tags: ['CLIP', '6.3 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
          filename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 6.27,
        },
      ],
    },
  ]
}

// ─── 2.5.8 specialized local-lane bundles (music / talking character / motion) ───
//
// Every URL below was HEAD-verified against HuggingFace on 2026-07-18 (status
// 200 + content-length; sizes in GiB from the actual response). Music and
// talking character have no censored/uncensored axis — local rendering runs
// unfiltered by nature, so no red badge games; the honest split lives in the
// video list above (real uncensored finetunes) instead.

export function getAudioBundles(): ModelBundle[] {
  return [
    {
      name: 'ACE Step 1.5 Turbo (Music)',
      description: 'Newest full song generator, MIT licensed. Vocals, lyrics and instruments from a text description. One file.',
      tags: ['Music', 'Vocals', 'MIT'],
      totalSizeGB: 9.4,
      vramRequired: '6-8 GB',
      workflow: 'ace',
      url: 'https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files',
      files: [
        {
          name: 'ACE Step 1.5 Turbo (all in one)',
          description: 'Complete music model. Includes its text encoder and audio VAE.',
          pulls: '', tags: ['Checkpoint', '9.3 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/checkpoints/ace_step_1.5_turbo_aio.safetensors',
          filename: 'ace_step_1.5_turbo_aio.safetensors', subfolder: 'checkpoints', sizeGB: 9.34,
        },
      ],
    },
    {
      name: 'ACE Step v1 3.5B (Music, lighter)',
      description: 'The proven full song generator. Smaller download, runs from 4 GB VRAM.',
      tags: ['Music', 'Vocals', 'Light'],
      totalSizeGB: 7.2,
      vramRequired: '4-6 GB',
      workflow: 'ace',
      url: 'https://huggingface.co/Comfy-Org/ACE-Step_ComfyUI_repackaged',
      files: [
        {
          name: 'ACE Step v1 3.5B (all in one)',
          description: 'Complete music model. Includes its text encoder and audio VAE.',
          pulls: '', tags: ['Checkpoint', '7.2 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ACE-Step_ComfyUI_repackaged/resolve/main/all_in_one/ace_step_v1_3.5b.safetensors',
          filename: 'ace_step_v1_3.5b.safetensors', subfolder: 'checkpoints', sizeGB: 7.17,
        },
      ],
    },
  ]
}

export function getLipsyncBundles(): ModelBundle[] {
  // Shared support files for the S2V graph (text encoder, VAE, audio encoder).
  const s2vSupport: DiscoverModel[] = [
    {
      name: 'Wan CLIP (UMT5-XXL FP8)',
      description: 'Required text encoder.',
      pulls: '', tags: ['CLIP', '6.3 GB'], updated: '',
      downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
      filename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 6.27,
    },
    {
      name: 'Wan 2.1 VAE',
      description: 'Required video encoder/decoder.',
      pulls: '', tags: ['VAE', '250 MB'], updated: '',
      downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors',
      filename: 'wan_2.1_vae.safetensors', subfolder: 'vae', sizeGB: 0.24,
    },
    {
      name: 'Wav2Vec2 Audio Encoder',
      description: 'Turns the speech audio into the embeddings the model lip reads from.',
      pulls: '', tags: ['Audio Encoder', '600 MB'], updated: '',
      downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/audio_encoders/wav2vec2_large_english_fp16.safetensors',
      filename: 'wav2vec2_large_english_fp16.safetensors', subfolder: 'audio_encoders', sizeGB: 0.59,
    },
  ]
  return [
    {
      name: 'Wan 2.2 S2V Q4 (Talking Character, GGUF)',
      description: 'A portrait plus any voice becomes a talking video. Q4 quant, the comfortable pick for 12 GB cards.',
      tags: ['Wan 2.2', 'S2V', 'GGUF'],
      totalSizeGB: 20.0,
      vramRequired: '10-12 GB',
      workflow: 'wans2v',
      customNodes: ['gguf'],
      url: 'https://huggingface.co/QuantStack/Wan2.2-S2V-14B-GGUF',
      files: [
        {
          name: 'Wan 2.2 S2V 14B Q4 (GGUF)',
          description: 'The sound to video model, Q4 quant.',
          pulls: '', tags: ['Model', '12.9 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/QuantStack/Wan2.2-S2V-14B-GGUF/resolve/main/Wan2.2-S2V-14B-Q4_K_M.gguf',
          filename: 'Wan2.2-S2V-14B-Q4_K_M.gguf', subfolder: 'diffusion_models', sizeGB: 12.91,
        },
        ...s2vSupport,
      ],
    },
    {
      name: 'Wan 2.2 S2V FP8 (Talking Character)',
      description: 'The full precision friendly variant. Bigger file; offloads below 16 GB VRAM, so renders take longer there.',
      tags: ['Wan 2.2', 'S2V', 'FP8'],
      totalSizeGB: 22.4,
      vramRequired: '16 GB best, offloads on less',
      workflow: 'wans2v',
      url: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged',
      files: [
        {
          name: 'Wan 2.2 S2V 14B (FP8)',
          description: 'The sound to video model.',
          pulls: '', tags: ['Model', '15.3 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_s2v_14B_fp8_scaled.safetensors',
          filename: 'wan2.2_s2v_14B_fp8_scaled.safetensors', subfolder: 'diffusion_models', sizeGB: 15.27,
        },
        ...s2vSupport,
      ],
    },
  ]
}

export function getMotionBundles(): ModelBundle[] {
  const wanSupport: DiscoverModel[] = [
    {
      name: 'Wan CLIP (UMT5-XXL FP8)',
      description: 'Required text encoder.',
      pulls: '', tags: ['CLIP', '6.3 GB'], updated: '',
      downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
      filename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 6.27,
    },
    {
      name: 'Wan 2.1 VAE',
      description: 'Required video encoder/decoder.',
      pulls: '', tags: ['VAE', '250 MB'], updated: '',
      downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors',
      filename: 'wan_2.1_vae.safetensors', subfolder: 'vae', sizeGB: 0.24,
    },
  ]
  return [
    {
      name: 'Wan VACE 1.3B (Motion Control, light)',
      description: 'Your character copies the moves from any dance or pose video. The light pick, runs from 8 GB VRAM.',
      tags: ['VACE', 'Motion', 'Light'],
      totalSizeGB: 10.5,
      vramRequired: '8-10 GB',
      workflow: 'wanvace',
      customNodes: ['controlnet-aux'],
      url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged',
      files: [
        {
          name: 'Wan 2.1 VACE 1.3B',
          description: 'The motion control model.',
          pulls: '', tags: ['Model', '4 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/diffusion_models/wan2.1_vace_1.3B_fp16.safetensors',
          filename: 'wan2.1_vace_1.3B_fp16.safetensors', subfolder: 'diffusion_models', sizeGB: 4.01,
        },
        ...wanSupport,
      ],
    },
    {
      name: 'Wan 2.2 Animate Q4 (Motion Control, GGUF)',
      description: 'The bigger, better motion transfer model. Q4 quant for 12 GB cards.',
      tags: ['Wan 2.2', 'Animate', 'GGUF'],
      totalSizeGB: 17.3,
      vramRequired: '10-12 GB',
      workflow: 'wananimate',
      customNodes: ['gguf', 'controlnet-aux'],
      url: 'https://huggingface.co/QuantStack/Wan2.2-Animate-14B-GGUF',
      files: [
        {
          name: 'Wan 2.2 Animate 14B Q4 (GGUF)',
          description: 'The motion transfer model, Q4 quant.',
          pulls: '', tags: ['Model', '10.7 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/QuantStack/Wan2.2-Animate-14B-GGUF/resolve/main/Wan2.2-Animate-14B-Q4_K_M.gguf',
          filename: 'Wan2.2-Animate-14B-Q4_K_M.gguf', subfolder: 'diffusion_models', sizeGB: 10.71,
        },
        ...wanSupport,
      ],
    },
  ]
}
