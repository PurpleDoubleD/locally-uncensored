/**
 * Der Download-Katalog: welche Dateien es gibt, wie groß sie sind und in
 * welchen ComfyUI-Ordner sie gehören. Reine Daten plus die Formen, die sie
 * beschreiben. Dieses Modul importiert außer einem Typ nur die reine
 * Grafikspeicher-Regel aus lib/vram-fit, die selbst nichts importiert.
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
import type { ModelTier } from '../lib/render/model-tier'
import { withVramNeed } from '../lib/vram-fit'

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
  /** Exact byte count, when the catalog knows it to the byte. A file of the same name
   *  and another size is NOT this file (a mirror's repack), so it never counts as installed. */
  sizeBytes?: number
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

// The Qwen-Image 2.1 files that more than one of its bundles load: the
// official image model (the official bundle and the one with the text encoder
// without refusals), the official text encoder (the official bundle and Noct
// Q) and the VAE (all three). One entry each, so the bundles can never drift
// apart and a machine that has one bundle does not fetch these again for
// another. Byte counts and SHA-256 are the Hugging Face LFS values of
// Comfy-Org/Qwen-Image-2.1, read on 2026-10-03.
const QWEN21_DIFFUSION_MODEL: DiscoverModel = {
  name: 'Qwen-Image 2.1 (INT8)',
  description: 'Diffusion model · generates and edits, native 2K, transparent backgrounds.',
  pulls: '', tags: ['Diffusion Model', '7.26 GB'], updated: 'New',
  downloadUrl: 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors',
  filename: 'qwen_image_2.1_int8_convrot.safetensors', subfolder: 'diffusion_models', sizeGB: 6.76,
  sizeBytes: 7256783064,
  sha256: 'cb74113cb03faecd79611b01fd7fd642f0aa60d6f0b95086abee214d75eaa57d',
}
const QWEN21_TEXT_ENCODER: DiscoverModel = {
  name: 'Qwen3-VL 8B Text Encoder (INT8)',
  description: 'Required text encoder for Qwen-Image 2.1 prompt understanding.',
  pulls: '', tags: ['Text Encoder', '9.35 GB'], updated: 'New',
  downloadUrl: 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors',
  filename: 'qwen3vl_8b_int8_convrot.safetensors', subfolder: 'text_encoders', sizeGB: 8.71,
  sizeBytes: 9350798360,
  sha256: '8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f',
}
const QWEN21_VAE: DiscoverModel = {
  name: 'Qwen-Image 2.1 VAE',
  description: 'Required autoencoder for Qwen-Image 2.1.',
  pulls: '', tags: ['VAE', '676 MB'], updated: '',
  downloadUrl: 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors',
  filename: 'qwen_image_2.1_vae_bf16.safetensors', subfolder: 'vae', sizeGB: 0.63,
  sizeBytes: 675509688,
  sha256: 'bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9',
}

// ─── Image Model Bundles ───

export function getImageBundles(): ModelBundle[] {
  return withVramNeed([
    {
      name: 'Juggernaut XL V9 (Photorealistic)',
      description: 'Best photorealistic SDXL checkpoint. All in one. Just install and generate.',
      tags: ['SDXL', 'Photorealistic', '1024px'],
      uncensored: true,
      verified: true,
      totalSizeGB: 6.5,
      vramRequired: '6-8 GB',
      workflow: 'sdxl',
      tier: 'older',
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
      tier: 'older',
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
      tier: 'older',
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
      tier: 'older',
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
      tier: 'best',
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
    // K9 nachbessert Runde 3 (GH #136): Krea 2 checkpoints come from LU's
    // built-in CivitAI search, not this catalog, so there is no "Krea 2"
    // checkpoint bundle here to attach these to. Without an entry the
    // "Download X from the Model Manager" text findMatchingVAE/findMatchingCLIP
    // throw (comfyui.ts) named two files the Model Manager had no way to
    // actually get, so a customer who followed the message got stuck at the
    // next step. Companions-only bundle, same pattern as every other type's
    // files array, so the get-path is real: search "Krea 2" in the Model
    // Manager, download both, done. Addresses verified reachable via HEAD
    // (2026-09-18) against the official Comfy-Org/Krea-2 repackage.
    {
      name: 'Krea 2 Companion Files (Text Encoder + VAE)',
      description: 'Not a checkpoint: the two files a Krea 2 CivitAI download needs alongside it (text encoder + VAE). Get the checkpoint itself from CivitAI search first.',
      tags: ['Krea 2', 'Companion Files', 'Text Encoder', 'VAE'],
      verified: true,
      totalSizeGB: 5.5,
      vramRequired: 'depends on the checkpoint',
      // A text encoder and a VAE for a checkpoint from elsewhere: an add-on,
      // so the card says what it is for where the others carry a verdict.
      addonFor: 'Krea 2 checkpoints',
      workflow: 'krea2',
      tier: 'best',
      url: 'https://huggingface.co/Comfy-Org/Krea-2',
      files: [
        {
          name: 'Qwen3-VL 4B Text Encoder (FP8)',
          description: 'Required text encoder for Krea 2 (matches the "qwen3vl_4b_fp8_scaled" pipeline, e.g. LUSTIFY! v10 Krea2).',
          pulls: '', tags: ['Text Encoder', '4.9 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_fp8_scaled.safetensors',
          filename: 'qwen3vl_4b_fp8_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 4.9,
        },
        {
          name: 'Qwen Image VAE',
          description: 'Required autoencoder for Krea 2 (matches the "qwen_image_vae" pipeline variant).',
          pulls: '', tags: ['VAE', '242 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Krea-2/resolve/main/vae/qwen_image_vae.safetensors',
          filename: 'qwen_image_vae.safetensors', subfolder: 'vae', sizeGB: 0.24,
        },
      ],
    },
    {
      name: 'Z-Image Turbo (Unfiltered, Fast)',
      description: 'Explicitly unfiltered image model. No safety filters. Text to Image and Image to Image.',
      tags: ['Z-Image', 'Unfiltered', 'Fast', '1024px'],
      uncensored: true,
      verified: true,
      totalSizeGB: 19.3,
      vramRequired: '10-16 GB',
      workflow: 'zimage',
      tier: 'best',
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
      tier: 'best',
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
      name: 'Qwen-Image 2.1 (Generate and Edit)',
      description: 'Generates from a prompt and edits a reference image from a prompt, no mask needed. Qwen Research License, non-commercial use: https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE',
      tags: ['Qwen Image 2.1', 'Image', 'Edit', '1024px'],
      uncensored: false,
      verified: true,
      // 6.76 + 8.71 + 0.63. sizeGB counts in gibibytes here (the install check
      // multiplies it by 1_073_741_824), so these are the HF byte counts read
      // on 2026-09-21 converted to GiB, not the decimal figures on the file
      // listing. Needs ComfyUI 0.37.0 or newer for the TextEncodeQwenImage21
      // node; an older one is told so before anything is built.
      totalSizeGB: 16.1,
      // Measured on the test box on 03.10.2026 (RTX 3060, 12 GB, ComfyUI
      // 0.38.0): cold load 46 s, a 768 x 768 picture in 74 s in all (25 steps,
      // about 1 s each), 1024 x 1024 warm in 85 s, peak 11.5 GB of graphics
      // memory, no error. The text encoder and the image model load one after
      // the other, so the card holds one at a time. Not measured below 12 GB.
      // The figure before this was "16-24 GB" off the model card, and it told
      // the owner of a 12 GB card "Needs more".
      vramRequired: '12 GB best, offloads on less',
      workflow: 'qwenimage',
      tier: 'best',
      url: 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1',
      files: [
        QWEN21_DIFFUSION_MODEL,
        QWEN21_TEXT_ENCODER,
        QWEN21_VAE,
      ],
    },
    // Qwen-Image 2.1 with the community text encoder that has its refusals
    // removed. Read off the model card on 2026-10-03
    // (pottokao/Qwen-Image-2.1-Text-Encoder-Heretic-int8-convrot, Apache 2.0):
    // a Heretic directional ablation of Qwen/Qwen3-VL-8B-Instruct, the model
    // Qwen-Image 2.1 uses as its text encoder, on o_proj and down_proj; the
    // card states that only the text encoder is modified and that the file
    // has the tensor names and the INT8 ConvRot layout of the official one,
    // so the stock CLIPLoader loads it. The image model and the VAE are the
    // official files, the same entries as in the bundle above, so a machine
    // that has that bundle fetches only the encoder. Byte count and SHA-256
    // are the Hugging Face LFS values read on 2026-10-03; the address answers
    // without a token. Not marked verified: no run on real hardware yet.
    {
      name: 'Qwen-Image 2.1 (No Refusals)',
      description: 'Qwen-Image 2.1 with a text encoder that has its refusal direction removed by the community (Heretic). Only the text encoder differs: the image model and the VAE are the official files, shared with the official bundle and not downloaded twice. Generates from a prompt and edits a reference image from a prompt, no mask needed. With both text encoders installed, pick one under Text encoder in the Expert settings. Image model under the Qwen Research License, non-commercial use: https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE. Text encoder under Apache 2.0.',
      tags: ['Qwen Image 2.1', 'Image', 'Edit', '1024px'],
      uncensored: true,
      // 6.76 + 8.71 + 0.63, in gibibytes like the official bundle. The VRAM
      // figure is the official bundle's measurement of 03.10.2026: the same
      // three file sizes on the same lane.
      totalSizeGB: 16.1,
      vramRequired: '12 GB best, offloads on less',
      workflow: 'qwenimage',
      tier: 'best',
      url: 'https://huggingface.co/pottokao/Qwen-Image-2.1-Text-Encoder-Heretic-int8-convrot',
      files: [
        QWEN21_DIFFUSION_MODEL,
        {
          name: 'Qwen3-VL 8B Text Encoder, No Refusals (INT8)',
          description: 'Text encoder for Qwen-Image 2.1 with the refusal direction removed (Heretic). From pottokao/Qwen-Image-2.1-Text-Encoder-Heretic.',
          pulls: '', tags: ['Text Encoder', '9.35 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/pottokao/Qwen-Image-2.1-Text-Encoder-Heretic-int8-convrot/resolve/main/qwen3vl_8b_int8_convrot_heretic.safetensors',
          filename: 'qwen3vl_8b_int8_convrot_heretic.safetensors', subfolder: 'text_encoders', sizeGB: 8.71,
          sizeBytes: 9350828392,
          sha256: 'f15ce4275428e04f42cdb59e3a253cb290cae5de99259527f01d3d2e51153653',
        },
        QWEN21_VAE,
      ],
    },
    // Noct Q, a community finetune of Qwen-Image 2.1. Read off Hugging Face on
    // 2026-10-03 (Noctaluna/Noct-Q-Uncensored-Qwen-Image-2.1, not gated, Qwen
    // Research License): the NOTICE file says "the Qwen-Image-2.1 transformer
    // weights were modified by noctaluna", the card calls the result
    // uncensored and says it edits with the same file in ComfyUI's Qwen Image
    // 2.1 edit template. Unlike the bundle above, the image model itself is
    // the changed file here. The safetensors header of NoctQ_V4_int8_convrot
    // carries the same 649 tensor names, shapes and data types as the official
    // qwen_image_2.1_int8_convrot, so UNETLoader and the whole Qwen-Image 2.1
    // lane take it as they take the official file.
    // The card names the official text encoder and the official VAE as its
    // companions, so those are the two shared entries: the file is published
    // against that encoder, and a machine with the official bundle fetches
    // only the image model. Whoever has the encoder without refusals too picks
    // it under Text encoder like for any Qwen-Image 2.1 run.
    // Byte count and SHA-256 are the Hugging Face LFS values; the address
    // answers without a token. Not marked verified: no run on real hardware.
    {
      name: 'Noct Q (Qwen-Image 2.1, Unfiltered)',
      description: 'A community finetune of Qwen-Image 2.1 by Noctaluna, published as an unfiltered edition. The image model itself is changed: its notice says the Qwen-Image 2.1 transformer weights were modified. Generates from a prompt and edits a reference image from a prompt, no mask needed. The text encoder and the VAE are the official files, shared with the official bundle and not downloaded twice. Qwen Research License, non-commercial use: https://huggingface.co/Noctaluna/Noct-Q-Uncensored-Qwen-Image-2.1/blob/main/LICENSE',
      tags: ['Qwen Image 2.1', 'Unfiltered', 'Image', 'Edit', '1024px'],
      uncensored: true,
      // 6.76 + 8.71 + 0.63, in gibibytes like the official bundle. The VRAM
      // figure is the official bundle's measurement of 03.10.2026: the same
      // three file sizes on the same lane.
      totalSizeGB: 16.1,
      vramRequired: '12 GB best, offloads on less',
      workflow: 'qwenimage',
      tier: 'best',
      url: 'https://huggingface.co/Noctaluna/Noct-Q-Uncensored-Qwen-Image-2.1',
      files: [
        {
          name: 'Noct Q V4 (INT8)',
          description: 'Diffusion model · Qwen-Image 2.1 with transformer weights modified by Noctaluna.',
          pulls: '', tags: ['Diffusion Model', '7.26 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Noctaluna/Noct-Q-Uncensored-Qwen-Image-2.1/resolve/main/NoctQ_V4_int8_convrot.safetensors',
          filename: 'NoctQ_V4_int8_convrot.safetensors', subfolder: 'diffusion_models', sizeGB: 6.76,
          sizeBytes: 7256784368,
          sha256: '4d92d5538253ab36e6a73b056cce5f697950f4303cb9e6686a3198d0ea13f9e8',
        },
        QWEN21_TEXT_ENCODER,
        QWEN21_VAE,
      ],
    },
    // The Qwen-Image 2.1 prompt enhancers (GH #148). Add-ons to the bundle
    // above, not models of their own: a 9B text model that turns a short
    // prompt or edit instruction into the long prompt Qwen-Image 2.1 works
    // best with. One file writes prompts for new pictures (t2i), the other
    // rewrites edit instructions and reads the pictures (i2i). ComfyUI runs
    // them with its own TextGenerate node, no node pack; "Improve my prompt"
    // uses them when they are installed (api/qwen-enhancer.ts), and that needs
    // ComfyUI 0.37.2 or newer. Byte counts and SHA-256 are the Hugging Face
    // LFS values read on 2026-10-03; all four addresses answer without a
    // token. sizeGB is gibibytes, as everywhere in this file. The VRAM figure
    // is measured on the test box on 03.10.2026 (RTX 3060, 12 GB, ComfyUI
    // 0.38.0) with the official enhancer: a 768 x 768 picture with the rewrite
    // in 160 s in all (74 s without it), the rewrite itself about 70 s for a
    // new picture and about 175 s for an edit, up to 9.7 GB of graphics memory
    // while it writes, peak 11.4 GB over the run, no error. The node pack
    // author's "16 GB recommended" told the owner of that card "Needs more".
    // The file without refusals has the same size and layout. The tier is the
    // family's, as for every add-on (local-model-tier.test.ts).
    {
      name: 'Qwen-Image 2.1 Prompt Enhancer (Official)',
      description: 'Add-on for Qwen-Image 2.1. Turns a short prompt or edit instruction into the long, detailed prompt the model works best with, and looks at your pictures when you edit. It runs before the image model and makes room for it afterwards. Made to play it safe: it can soften or refuse an instruction. Turn it on with Improve my prompt in the advanced settings. Qwen Research License, non-commercial use: https://huggingface.co/Qwen/Qwen-Image-2.1-PE-T2I/blob/main/LICENSE',
      tags: ['Qwen Image 2.1', 'Prompt Enhancer', 'Addon'],
      uncensored: false,
      totalSizeGB: 17.64,
      vramRequired: '12 GB best, offloads on less',
      workflow: 'qwenimage',
      tier: 'best',
      url: 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1',
      files: [
        {
          name: 'Qwen Prompt Enhancer, Image (INT8)',
          description: 'Writes the prompt for a new picture.',
          pulls: '', tags: ['Prompt Enhancer', '9.47 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors',
          filename: 'qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors', subfolder: 'text_encoders', sizeGB: 8.82,
          sizeBytes: 9471072252,
          sha256: '9182abae56fe05459840a86d22abd21f972061c92fce032630af680c8c5178d3',
        },
        {
          name: 'Qwen Prompt Enhancer, Edit (INT8)',
          description: 'Rewrites an edit instruction and reads your pictures.',
          pulls: '', tags: ['Prompt Enhancer', '9.47 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors',
          filename: 'qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors', subfolder: 'text_encoders', sizeGB: 8.82,
          sizeBytes: 9471072252,
          sha256: '32707d01b427e488af252b95c551989aad59f9fec611a694f5db6bde7f0f1f6c',
        },
      ],
    },
    {
      name: 'Qwen-Image 2.1 Prompt Enhancer (No Refusals)',
      description: 'Add-on for Qwen-Image 2.1. The same prompt enhancer with its refusals taken out by the community (Heretic), so your prompt and your edit instruction stay what you wrote. Turns a short prompt into a long, detailed one and looks at your pictures when you edit. It runs before the image model and makes room for it afterwards. Turn it on with Improve my prompt in the advanced settings. Qwen Research License, non-commercial use: https://huggingface.co/Adahm/PE-Heretic-INT8-ConvRot-for-Qwen-Image-2.1/blob/main/LICENSE',
      tags: ['Qwen Image 2.1', 'Prompt Enhancer', 'Addon'],
      uncensored: true,
      totalSizeGB: 17.64,
      vramRequired: '12 GB best, offloads on less',
      workflow: 'qwenimage',
      tier: 'best',
      url: 'https://huggingface.co/Adahm/PE-Heretic-INT8-ConvRot-for-Qwen-Image-2.1',
      files: [
        {
          name: 'Qwen Prompt Enhancer, Image, No Refusals (INT8)',
          description: 'Writes the prompt for a new picture. From pottokao/Qwen-Image-2.1-PE-T2I-Heretic.',
          pulls: '', tags: ['Prompt Enhancer', '9.47 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Adahm/PE-Heretic-INT8-ConvRot-for-Qwen-Image-2.1/resolve/main/qwen3.5_9b_qwen_image_2.1_pe_t2i_heretic.int8_convrot.safetensors',
          filename: 'qwen3.5_9b_qwen_image_2.1_pe_t2i_heretic.int8_convrot.safetensors', subfolder: 'text_encoders', sizeGB: 8.82,
          sizeBytes: 9471072252,
          sha256: '91b9ba42539fb662775181eabce845befe2c1441658a736fadf0033dd799d8f3',
        },
        {
          name: 'Qwen Prompt Enhancer, Edit, No Refusals (INT8)',
          description: 'Rewrites an edit instruction and reads your pictures. From darrellbest/Qwen-Image-2.1-PE-I2I-Heretic.',
          pulls: '', tags: ['Prompt Enhancer', '9.47 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Adahm/PE-Heretic-INT8-ConvRot-for-Qwen-Image-2.1/resolve/main/qwen3.5_9b_qwen_image_2.1_pe_i2i_heretic.int8_convrot.safetensors',
          filename: 'qwen3.5_9b_qwen_image_2.1_pe_i2i_heretic.int8_convrot.safetensors', subfolder: 'text_encoders', sizeGB: 8.82,
          sizeBytes: 9471072252,
          sha256: '979b9063dd16645f0191c9ff55aa5059105bfe84096d96a817a85deed22231f0',
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
      tier: 'older',
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
      tier: 'best',
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
      tier: 'best',
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
      addonFor: 'SDXL models',
      workflow: 'sdxl',
      tier: 'older',
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
      // 170 543 052 bytes on Hugging Face (read 03.10.2026), which is 162.6 MB
      // the way the app counts (sizeGB is in gibibytes, see Qwen-Image 2.1
      // above). 0.17 was the decimal figure and showed as 174.1 MB on the
      // card beside 162.6 MB under Installed.
      totalSizeGB: 0.1588,
      vramRequired: 'any',
      addonFor: 'SDXL models',
      workflow: 'sdxl',
      tier: 'older',
      url: 'https://huggingface.co/nerijs/pixel-art-xl',
      files: [
        {
          name: 'Pixel Art XL LoRA',
          description: 'SDXL pixel art style LoRA → models/loras.',
          pulls: '', tags: ['LoRA', '163 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/nerijs/pixel-art-xl/resolve/main/pixel-art-xl.safetensors',
          filename: 'pixel-art-xl.safetensors', subfolder: 'loras', sizeGB: 0.1588,
          sha256: '4234637cb80c998f41e348e6a6cb6bc20d8d038b2b0f256b6129b3b5e353eef7',
        },
      ],
    },
  ])
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

export interface CustomNodeEntry {
  repo: string
  name: string
  requiredNodes: string[]
  /**
   * A tested commit of the pack. The installer puts the checkout on exactly
   * this commit (fresh clone or one that is already there) instead of the
   * head of the repository. Only for a pack whose head was seen broken, with
   * the date and the reason next to it. To release a pin, delete the field:
   * the next install goes back to the default branch and pulls
   * (custom_nodes.rs, return_to_default_branch).
   */
  commit?: string
}

export const CUSTOM_NODE_REGISTRY: Record<string, CustomNodeEntry> = {
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
  //
  // Pinned on 03.10.2026 to 58f1947a (21.08.2026, pack version 3.1.0), the last
  // commit before the pack's 3.2.0 uploads of 30.09.2026. From 54e62337 on,
  // the pack's own loader dies on the first node file that fails to import
  // (its error line names a variable that does not exist), and on Windows one
  // always fails: the SAM3 node imports triton, which exists for Linux only.
  // ComfyUI then reports IMPORT FAILED for the whole pack and no RMBG node.
  // Measured on the Windows box: head 229529e0 does not load, 58f1947a lists
  // RMBG. Release the pin (delete `commit`) once the pack's head loads again
  // on Windows with no triton installed.
  'rmbg': {
    repo: 'https://github.com/1038lab/ComfyUI-RMBG',
    name: 'ComfyUI-RMBG',
    requiredNodes: ['RMBG'],
    commit: '58f1947a11567a9f8b707223185570850e773856',
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
  /**
   * The same requirement as numbers, stamped on every entry by the one rule in
   * lib/vram-fit (never written by hand, so no entry can disagree with its own
   * text): from `vramMinGB` the model runs, from `vramComfortGB` it runs
   * without moving weights out of graphics memory. Null when the text names no
   * number, which is the companion files whose need is the checkpoint's.
   */
  vramMinGB: number | null
  vramComfortGB: number | null
  /** See lib/vram-fit NeedSource: the authors' own comfortable value, for a
   *  model built to run mostly outside graphics memory. */
  vramComfortStatedGB?: number
  /** Set on an add-on (a LoRA, a VAE): what it belongs to. An add-on loads
   *  into its model's memory, so its card carries no verdict of its own and
   *  says what it is for instead ("For MiniMax H3"). */
  addonFor?: string
  workflow: string
  /**
   * How the pickers order this bundle (Oct 2026, David). 'best' is today's open
   * weight state of the art and stands on top with a small mark, 'older' is
   * collected under "Older models", everything else keeps its usual place.
   * Nothing is hidden by it. Every local model is an open weight, so there is
   * no weights field here (the cloud catalog carries one).
   */
  tier: ModelTier
  files: DiscoverModel[]
  url?: string
  hot?: boolean
  uncensored?: boolean
  customNodes?: string[]  // keys into CUSTOM_NODE_REGISTRY
  i2v?: boolean           // Image-to-Video model
  verified?: boolean      // E2E tested and confirmed working
}

// The three files MiniMax H3 and FastH3 share: the text encoder and both
// autoencoders. One definition, so an install of either bundle satisfies the
// other and the two can never drift apart.
const H3_SHARED_FILES: DiscoverModel[] = [
    {
      name: 'Qwen3-VL 32B Text Encoder (NVFP4)',
      description: 'Required text encoder for MiniMax H3. Runs on any NVIDIA card, not only Blackwell.',
      pulls: '', tags: ['Text Encoder', '15.7 GB'], updated: 'New',
      downloadUrl: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
      filename: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', subfolder: 'text_encoders', sizeGB: 15.7,
    },
    {
      name: 'MiniMax H3 Video VAE',
      description: 'Required, decodes the picture.',
      pulls: '', tags: ['VAE', '2.8 GB'], updated: 'New',
      downloadUrl: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_int8_convrot.safetensors',
      filename: 'minimax_h3_video_vae_int8_convrot.safetensors', subfolder: 'vae', sizeGB: 2.8,
    },
    {
      name: 'MiniMax H3 Audio VAE',
      description: 'Required, decodes the sound.',
      pulls: '', tags: ['VAE', '605 MB'], updated: 'New',
      downloadUrl: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors',
      filename: 'minimax_h3_audio_vae_fp32.safetensors', subfolder: 'vae', sizeGB: 0.6,
    },
]

/** The catalog's LoRA add-ons: bundles that are nothing but files for
 *  models/loras (Pixel Art XL, the MiniMax H3 turbo LoRA). Models, LoRAs,
 *  Get new lists them, so a LoRA is found where LoRAs are. */
export function getLoraAddonBundles(): ModelBundle[] {
  return [...getImageBundles(), ...getVideoBundles()]
    .filter((b) => b.files.length > 0 && b.files.every((f) => f.subfolder === 'loras'))
}

export function getVideoBundles(): ModelBundle[] {
  return withVramNeed([
    {
      name: 'Wan 2.1 · 1.3B (Lightweight)',
      description: 'Best for 8 to 10 GB VRAM GPUs. Generates 480p video. Fast and lightweight.',
      tags: ['Wan 2.1', '480p', 'Fast'],
      uncensored: true,
      verified: true,
      totalSizeGB: 9.2,
      vramRequired: '8-10 GB',
      workflow: 'wan',
      tier: 'older',
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
      tier: 'older',
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
      tier: 'standard',
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
      tier: 'older',
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
      name: 'LTX Video 2.3 · 22B FP8',
      description: 'Lightricks LTX Video 2.3 · fast inference, high quality. Uses Gemma 3 12B text encoder. Distilled for speed.',
      tags: ['LTX 2.3', '22B', 'Quality'],
      verified: true,
      totalSizeGB: 40,
      vramRequired: '16+ GB',
      workflow: 'ltx',
      tier: 'older',
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
    // MiniMax H3 (Discord, throwaway 2026-09-26). The files and the int8
    // tier are the official Comfy-Org templates' (video_minimax_h3_t2v/_i2v);
    // sizes read from Hugging Face on 2026-10-01. The 21 GB model alone sets
    // the VRAM line.
    {
      name: 'MiniMax H3 · Video with Sound',
      description: 'Video with its own sound from a prompt or a first frame, up to about 15 seconds. Fastest way: add the MiniMax H3 Turbo LoRA, 8 steps instead of 20.',
      tags: ['MiniMax H3', 'Audio', '768p'],
      verified: true,
      totalSizeGB: 40.1,
      vramRequired: '24+ GB',
      workflow: 'minimaxh3',
      tier: 'best',
      url: 'https://huggingface.co/Comfy-Org/MiniMax-H3',
      files: [
        {
          name: 'MiniMax H3 fl2va (int8)',
          description: 'Main model, text or first frame to video with sound.',
          pulls: '', tags: ['Model', '21 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors',
          filename: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', subfolder: 'diffusion_models', sizeGB: 21.0,
        },
        ...H3_SHARED_FILES,
      ],
    },
    // The 8 step turbo LoRA for MiniMax H3 (Discord 2026-10-03, boromirofgeo:
    // "how do I get the turbo lora into the stack"). The file is the one the
    // official templates video_minimax_h3_t2v and _i2v load with
    // LoraLoaderModelOnly at strength 1. Free to download, read from the
    // Hugging Face tree API and an anonymous HEAD on 2026-10-03: 1956193000
    // bytes, and lightx2v/Minimax-h3-Turbo (the origin) states the same digest.
    // It lands in models/loras, the LoRA stack lists it, and the H3 builder
    // reads the 8 steps from its name.
    {
      name: 'MiniMax H3 Turbo LoRA · 8 Steps',
      description: 'Add-on for MiniMax H3: 8 steps instead of 20, from a prompt or a first frame. After the download, turn it on in Create, Advanced settings, Expert, LoRA stack.',
      tags: ['MiniMax H3', 'LoRA', 'Addon'],
      totalSizeGB: 1.82,
      // Sized like the model it needs next to it, for the sort and the size
      // filters. The card itself shows no verdict for an add-on (addonFor):
      // "Needs more than your 12 GB card" under a 1.82 GB file read as a
      // statement about the LoRA.
      vramRequired: '24+ GB',
      addonFor: 'MiniMax H3',
      workflow: 'minimaxh3',
      tier: 'best',
      url: 'https://huggingface.co/Comfy-Org/MiniMax-H3',
      files: [
        {
          name: 'MiniMax H3 Turbo LoRA (8 steps)',
          description: 'Step distillation LoRA for the MiniMax H3 fl2va model → models/loras.',
          pulls: '', tags: ['LoRA', '1.82 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
          filename: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', subfolder: 'loras', sizeGB: 1.82,
          sizeBytes: 1956193000,
          sha256: '2339acdf19bfe123f46b971ea35d367a84adb85de43627e1eceafa5a5b2b111e',
        },
      ],
    },
    // FastH3 (FastVideo, 8 step distilled MiniMax H3). A full checkpoint of its
    // own, not a LoRA: FastVideo/FastVideo-FastH3-Comfy ships the distilled
    // weights as diffusion_models/fastvideo_fasth3_8step_v2_pruned_*.safetensors.
    // The official Comfy-Org template (video_fastvideo_fasth3_t2v) loads it with
    // the same Qwen3-VL encoder and the same two VAEs as MiniMax H3, so those
    // three files are shared. Text to video only: the model card says the
    // first/last frame and reference tasks were not distilled. Sizes and
    // digests read from the Hugging Face tree API on 2026-10-02. Needs ComfyUI
    // 0.35.0 or newer (BlockSparseAttention, comfy_extras/nodes_sparse_attention.py).
    {
      name: 'FastH3 · MiniMax H3 in 8 Steps',
      description: 'The quick MiniMax H3: video with its own sound from a prompt in 8 steps. Text to video only. Shares its text encoder and VAEs with MiniMax H3.',
      tags: ['FastH3', 'Audio', 'Fast'],
      totalSizeGB: 39.7,
      vramRequired: '24+ GB',
      workflow: 'minimaxh3',
      tier: 'best',
      url: 'https://huggingface.co/FastVideo/FastVideo-FastH3-Comfy',
      files: [
        {
          name: 'FastH3 8 Step V2 (int8)',
          description: 'Main model, distilled to 8 steps. Text to video with sound.',
          pulls: '', tags: ['Model', '20.6 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/FastVideo/FastVideo-FastH3-Comfy/resolve/main/diffusion_models/fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors',
          filename: 'fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors', subfolder: 'diffusion_models', sizeGB: 20.61,
          sha256: '0922785978dc9bfe1adf27d8b291b0ca763f9f165f882e6cb297c72fbb6deda8',
        },
        ...H3_SHARED_FILES,
      ],
    },
    // LTX 2.5 (Lightricks, open weights since 11.08.2026). Every file is the one
    // the official Comfy-Org template video_ltx2_5_t2v/_i2v loads. The official
    // repo Lightricks/LTX-2.5 is GATED (a download needs a Hugging Face token a
    // customer does not have), so the files come from FREE mirrors, checked on
    // 2026-10-02 with an anonymous HEAD (HTTP 200 on every file). Byte counts
    // equal the official repo's, and the SHA-256 of each file agrees between
    // independent mirrors (comfyicu/LTX-2.5, deAPI-ai/ltx2-5-22b-dist-int8,
    // osantinello/LTX25_Models). comfyicu's copy of the Gemma encoder differs
    // from the official byte count, so the encoder comes from deAPI-ai. The small
    // variant is a GGUF Q4_K_M of the distilled transformer (agosh/LTX-2.5-Comfy-GGUF),
    // loaded through ComfyUI-GGUF. The model patch for 2.5 reached ComfyUI in
    // 0.32.0 (PR 15499), and the graph needs LTXVDualCFGGuider from the same release.
    {
      name: 'LTX 2.5 · Video with Sound',
      description: 'Video with its own sound from a prompt or a first frame, with cuts between connected shots. Fast distilled version, full quality.',
      tags: ['LTX 2.5', 'Audio', 'Multishot'],
      totalSizeGB: 37.0,
      vramRequired: '24+ GB',
      workflow: 'ltx25',
      tier: 'best',
      url: 'https://huggingface.co/Lightricks/LTX-2.5',
      files: [
        {
          name: 'LTX 2.5 22B Distilled (int8)',
          description: 'Main video model, distilled for fast renders. Video and sound in one pass.',
          pulls: '', tags: ['Model', '21.5 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/comfyicu/LTX-2.5/resolve/main/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors',
          filename: 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors', subfolder: 'diffusion_models', sizeGB: 20.03,
          sizeBytes: 21504034224,
          sha256: 'c4279eeff115cbeaca494bd2183e7d768c38fe85a184dc6afbb7159157c44334',
        },
        {
          name: 'Gemma 4 12B Text Encoder (LTX 2.5, int8)',
          description: 'Required text encoder for LTX 2.5.',
          pulls: '', tags: ['Text Encoder', '15.4 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/deAPI-ai/ltx2-5-22b-dist-int8/resolve/main/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors',
          filename: 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', subfolder: 'text_encoders', sizeGB: 14.32,
          sizeBytes: 15372969374,
          sha256: '6ce688a0aa98a5fa36a9f1e6c3f42152a498cc2b53ee8c15674c64244f91487f',
        },
        {
          name: 'LTX 2.5 Video VAE',
          description: 'Required, decodes the picture.',
          pulls: '', tags: ['VAE', '1.5 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/comfyicu/LTX-2.5/resolve/main/vae/ltx-2.5-video-vae-bf16.safetensors',
          filename: 'ltx-2.5-video-vae-bf16.safetensors', subfolder: 'vae', sizeGB: 1.37,
          sizeBytes: 1472223346,
          sha256: '847e14ca7f3355debca0cea4eaa24ac0fbcdf0061da054ac89ca638a869ddba3',
        },
        {
          name: 'LTX 2.5 Audio VAE',
          description: 'Required, decodes the sound.',
          pulls: '', tags: ['VAE', '365 MB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/comfyicu/LTX-2.5/resolve/main/vae/ltx-2.5-audio-vae-bf16.safetensors',
          filename: 'ltx-2.5-audio-vae-bf16.safetensors', subfolder: 'vae', sizeGB: 0.34,
          sizeBytes: 364866540,
          sha256: 'c52733d37f6a7fb7949c3dc0fb468c6cb2169e4d836983a73babb9f0d54837a5',
        },
        {
          name: 'LTX 2.5 Latent Upscaler x2',
          description: 'Required, sharpens the picture in the second pass.',
          pulls: '', tags: ['Upscaler', '996 MB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/comfyicu/LTX-2.5/resolve/main/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors',
          filename: 'ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors', subfolder: 'latent_upscale_models', sizeGB: 0.93,
          sizeBytes: 995778752,
          sha256: 'eb5a71fe4068ee87ccdb1c3aa635e547ca76bd2d30ae20ae889f2c325c0677e8',
        },
      ],
    },
    {
      name: 'LTX 2.5 · Small (GGUF Q4)',
      description: 'The same video with sound model in a smaller 4 bit version for 16 GB graphics cards. The ComfyUI-GGUF node pack it needs is installed with it. Slightly softer detail than the full version.',
      tags: ['LTX 2.5', 'Audio', 'GGUF'],
      totalSizeGB: 28.4,
      vramRequired: '16 GB',
      workflow: 'ltx25',
      tier: 'best',
      customNodes: ['gguf'],
      url: 'https://huggingface.co/agosh/LTX-2.5-Comfy-GGUF',
      files: [
        {
          name: 'LTX 2.5 22B Distilled (GGUF Q4_K_M)',
          description: 'Main video model, 4 bit. Video and sound in one pass.',
          pulls: '', tags: ['Model', '12.2 GB', 'GGUF'], updated: 'New',
          downloadUrl: 'https://huggingface.co/agosh/LTX-2.5-Comfy-GGUF/resolve/main/ltx-2.5-22b-distilled-transformer-bf16-Q4_K_M.gguf',
          filename: 'ltx-2.5-22b-distilled-transformer-bf16-Q4_K_M.gguf', subfolder: 'diffusion_models', sizeGB: 11.38,
          sizeBytes: 12220864608,
          sha256: '0b1bca38240087117bb0d1379fdaf1bcdb53c40e63f5f9bcb1a7e793f9520cfb',
        },
        {
          name: 'Gemma 4 12B Text Encoder (LTX 2.5, int8)',
          description: 'Required text encoder for LTX 2.5.',
          pulls: '', tags: ['Text Encoder', '15.4 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/deAPI-ai/ltx2-5-22b-dist-int8/resolve/main/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors',
          filename: 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', subfolder: 'text_encoders', sizeGB: 14.32,
          sizeBytes: 15372969374,
          sha256: '6ce688a0aa98a5fa36a9f1e6c3f42152a498cc2b53ee8c15674c64244f91487f',
        },
        {
          name: 'LTX 2.5 Video VAE',
          description: 'Required, decodes the picture.',
          pulls: '', tags: ['VAE', '1.5 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/comfyicu/LTX-2.5/resolve/main/vae/ltx-2.5-video-vae-bf16.safetensors',
          filename: 'ltx-2.5-video-vae-bf16.safetensors', subfolder: 'vae', sizeGB: 1.37,
          sizeBytes: 1472223346,
          sha256: '847e14ca7f3355debca0cea4eaa24ac0fbcdf0061da054ac89ca638a869ddba3',
        },
        {
          name: 'LTX 2.5 Audio VAE',
          description: 'Required, decodes the sound.',
          pulls: '', tags: ['VAE', '365 MB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/comfyicu/LTX-2.5/resolve/main/vae/ltx-2.5-audio-vae-bf16.safetensors',
          filename: 'ltx-2.5-audio-vae-bf16.safetensors', subfolder: 'vae', sizeGB: 0.34,
          sizeBytes: 364866540,
          sha256: 'c52733d37f6a7fb7949c3dc0fb468c6cb2169e4d836983a73babb9f0d54837a5',
        },
        {
          name: 'LTX 2.5 Latent Upscaler x2',
          description: 'Required, sharpens the picture in the second pass.',
          pulls: '', tags: ['Upscaler', '996 MB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/comfyicu/LTX-2.5/resolve/main/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors',
          filename: 'ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors', subfolder: 'latent_upscale_models', sizeGB: 0.93,
          sizeBytes: 995778752,
          sha256: 'eb5a71fe4068ee87ccdb1c3aa635e547ca76bd2d30ae20ae889f2c325c0677e8',
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
      tier: 'older',
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
      tier: 'older',
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
      // FramePack is built to run with its weights outside graphics memory: it
      // predicts the next frame section from a fixed length context and moves
      // the 15.3 GB model through the card piece by piece. Its authors state
      // 6 GB as enough (github.com/lllyasviel/FramePack, Requirements). The
      // largest-weight rule read "tight" on every card below 16.8 GB, against
      // the bundle's own description, so the stated value stands here.
      vramComfortStatedGB: 8,
      workflow: 'framepack',
      tier: 'older',
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
      tier: 'older',
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
      tier: 'older',
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
      tier: 'older',
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
      name: 'Wan 14B Uncensored (GGUF)',
      description: 'Full uncensored finetune of Wan 2.1 14B. Text to video, motion trained in, no helper LoRA needed.',
      tags: ['Wan 2.1', 'Uncensored', 'GGUF', '480p'],
      uncensored: true,
      totalSizeGB: 15.5,
      vramRequired: '10-12 GB',
      workflow: 'wan',
      tier: 'older',
      customNodes: ['gguf'],
      url: 'https://huggingface.co/NSFW-API/NSFW_Wan_14b',
      files: [
        {
          name: 'Wan 14B Uncensored Q4 (GGUF)',
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
      tier: 'standard',
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
  ])
}

// ─── 2.5.8 specialized local-lane bundles (music / talking character / motion) ───
//
// Every URL below was HEAD-verified against HuggingFace on 2026-07-18 (status
// 200 + content-length; sizes in GiB from the actual response). Music and
// talking character have no censored/uncensored axis — local rendering runs
// unfiltered by nature, so no red badge games; the honest split lives in the
// video list above (real uncensored finetunes) instead.

export function getAudioBundles(): ModelBundle[] {
  return withVramNeed([
    {
      name: 'ACE Step 1.5 Turbo (Music)',
      description: 'Newest full song generator, MIT licensed. Vocals, lyrics and instruments from a text description. One file.',
      tags: ['Music', 'Vocals', 'MIT'],
      totalSizeGB: 9.4,
      vramRequired: '6-8 GB',
      workflow: 'ace',
      tier: 'best',
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
    // YuE2 (m-a-p, ComfyUI 0.36.0 and newer, PR 16250). Songs with vocals from a
    // style and lyrics. The int8 checkpoint is the one the official template
    // audio_yue2_text2music loads; it is an all in one file (model, text model
    // and audio VAE), so it goes to checkpoints like ACE Step. Size and digest
    // from the Hugging Face tree API on 2026-10-02. The model card says CC BY NC
    // 4.0, so the card says non-commercial.
    {
      name: 'YuE2 (Songs from Style and Lyrics)',
      description: 'Full songs with vocals from a style and your lyrics. Non-commercial use only (CC BY-NC 4.0).',
      tags: ['Music', 'Vocals', 'Lyrics'],
      totalSizeGB: 3.69,
      vramRequired: '6-8 GB',
      workflow: 'yue2',
      tier: 'best',
      url: 'https://huggingface.co/Comfy-Org/YuE2',
      files: [
        {
          name: 'YuE2 3B (int8, all in one)',
          description: 'Complete music model. Includes its text model and audio VAE.',
          pulls: '', tags: ['Checkpoint', '4.0 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/YuE2/resolve/main/checkpoints/yue2_3b_int8_convrot.safetensors',
          filename: 'yue2_3b_int8_convrot.safetensors', subfolder: 'checkpoints', sizeGB: 3.69,
          sha256: '96fe199377309001ed8cd26a944baeee8cc31a20ba7c36d1d3c0a7e1f4149db6',
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
      tier: 'standard',
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
  ])
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
  return withVramNeed([
    {
      name: 'Wan 2.2 S2V Q4 (Talking Character, GGUF)',
      description: 'A portrait plus any voice becomes a talking video. Q4 quant, the pick for 12 GB cards.',
      tags: ['Wan 2.2', 'S2V', 'GGUF'],
      totalSizeGB: 20.0,
      vramRequired: '10-12 GB',
      workflow: 'wans2v',
      tier: 'standard',
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
      tier: 'standard',
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
  ])
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
  return withVramNeed([
    {
      name: 'Wan VACE 1.3B (Motion Control, light)',
      description: 'Your character copies the moves from any dance or pose video. The light pick, runs from 8 GB VRAM.',
      tags: ['VACE', 'Motion', 'Light'],
      totalSizeGB: 10.5,
      vramRequired: '8-10 GB',
      workflow: 'wanvace',
      tier: 'older',
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
      tier: 'standard',
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
  ])
}
