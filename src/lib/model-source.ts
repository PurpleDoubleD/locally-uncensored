/**
 * Where an installed model file came from (D1, a user on Discord,
 * 01.11.2026: "from an installed model or LoRA, jump to its CivitAI or Hugging
 * Face page"). LU writes the page down when it starts the download; a file
 * from before 3.0.9, or one put there by hand, has none, and the Details
 * dialog then shows no link.
 */

const HF_HOSTS = ['huggingface.co', 'hf.co']
const CIVITAI_HOSTS = ['civitai.com', 'civitai.red']

function hostIn(host: string, list: string[]): boolean {
  return list.some((h) => host === h || host.endsWith(`.${h}`))
}

/** Only an https page of Hugging Face or CivitAI is kept and opened. A model
 *  page is untrusted text, and this link ends in the system's browser. */
export function isModelSourcePage(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' || u.username || u.password) return false
    const host = u.hostname.toLowerCase()
    return hostIn(host, HF_HOSTS) || hostIn(host, CIVITAI_HOSTS)
  } catch {
    return false
  }
}

/**
 * The page a download address belongs to, when the address shows it: a
 * Hugging Face `…/{owner}/{repo}/resolve/…` file is that repository's page.
 * A CivitAI download address names a version, not the page, so null: the
 * CivitAI panels pass the page they showed instead.
 */
export function sourcePageFromDownloadUrl(downloadUrl: string): string | null {
  let u: URL
  try {
    u = new URL(downloadUrl)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || !hostIn(u.hostname.toLowerCase(), HF_HOSTS)) return null
  const parts = u.pathname.split('/').filter(Boolean)
  const at = parts.indexOf('resolve')
  if (at !== 2) return null
  return `https://huggingface.co/${parts[0]}/${parts[1]}`
}

/** One key per file, whatever folder or subfolder the name carries: the
 *  inventory says `loras/sub/x.safetensors` or `x.safetensors`, the download
 *  knows `x.safetensors`. */
export function modelSourceKey(filename: string): string {
  return (filename.split(/[\\/]/).pop() ?? filename).toLowerCase()
}

/** What the Details dialog says a ComfyUI folder holds. */
export function comfyKindLabel(source: string | undefined): string | null {
  switch (source) {
    case 'checkpoint': return 'Checkpoint'
    case 'diffusion_model': return 'Diffusion model'
    case 'motion_module': return 'Motion module'
    case 'lora': return 'LoRA'
    case 'vae': return 'VAE'
    case 'text_encoder': return 'Text encoder'
    case 'clip_vision': return 'CLIP vision'
    case 'controlnet': return 'ControlNet'
    case 'upscale_model': return 'Upscaler'
    case 'embedding': return 'Embedding'
    case 'style_model': return 'Style model'
    default: return null
  }
}
