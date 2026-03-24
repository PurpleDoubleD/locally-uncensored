export interface ComfyUIModel {
  name: string
  type: 'checkpoint' | 'lora' | 'vae'
}

export interface GenerateParams {
  prompt: string
  negativePrompt: string
  model: string
  sampler: string
  steps: number
  cfgScale: number
  width: number
  height: number
  seed: number
  batchSize?: number
}

export interface VideoParams extends GenerateParams {
  frames: number
  fps: number
}

export interface ComfyUIOutput {
  filename: string
  subfolder: string
  type: string
}

export async function checkComfyConnection(): Promise<boolean> {
  try {
    const res = await fetch('/comfyui/system_stats')
    return res.ok
  } catch {
    return false
  }
}

export async function getCheckpoints(): Promise<string[]> {
  try {
    const res = await fetch('/comfyui/object_info/CheckpointLoaderSimple')
    const data = await res.json()
    return data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || []
  } catch {
    return []
  }
}

export async function getSamplers(): Promise<string[]> {
  try {
    const res = await fetch('/comfyui/object_info/KSampler')
    const data = await res.json()
    return data?.KSampler?.input?.required?.sampler_name?.[0] || []
  } catch {
    return ['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_sde', 'ddim']
  }
}

export async function getSchedulers(): Promise<string[]> {
  try {
    const res = await fetch('/comfyui/object_info/KSampler')
    const data = await res.json()
    return data?.KSampler?.input?.required?.scheduler?.[0] || []
  } catch {
    return ['normal', 'karras', 'exponential', 'sgm_uniform']
  }
}

export async function submitWorkflow(workflow: Record<string, any>): Promise<string> {
  const res = await fetch('/comfyui/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  })
  if (!res.ok) throw new Error('Failed to submit workflow')
  const data = await res.json()
  return data.prompt_id
}

export async function getHistory(promptId: string): Promise<any> {
  const res = await fetch(`/comfyui/history/${promptId}`)
  if (!res.ok) return null
  const data = await res.json()
  return data[promptId] || null
}

export function getImageUrl(filename: string, subfolder: string = '', type: string = 'output'): string {
  return `/comfyui/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${type}`
}

export function buildTxt2ImgWorkflow(params: GenerateParams): Record<string, any> {
  return {
    '1': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: params.model },
    },
    '2': {
      class_type: 'CLIPTextEncode',
      inputs: { text: params.prompt, clip: ['1', 1] },
    },
    '3': {
      class_type: 'CLIPTextEncode',
      inputs: { text: params.negativePrompt || '', clip: ['1', 1] },
    },
    '4': {
      class_type: 'EmptyLatentImage',
      inputs: { width: params.width, height: params.height, batch_size: params.batchSize || 1 },
    },
    '5': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
        seed: params.seed === -1 ? Math.floor(Math.random() * 2147483647) : params.seed,
        steps: params.steps,
        cfg: params.cfgScale,
        sampler_name: params.sampler,
        scheduler: 'normal',
        denoise: 1.0,
      },
    },
    '6': {
      class_type: 'VAEDecode',
      inputs: { samples: ['5', 0], vae: ['1', 2] },
    },
    '7': {
      class_type: 'SaveImage',
      inputs: { images: ['6', 0], filename_prefix: 'locally_uncensored' },
    },
  }
}

export function buildTxt2VidWorkflow(params: VideoParams): Record<string, any> {
  // Wan2.1 Text-to-Video workflow
  return {
    '1': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: params.model },
    },
    '2': {
      class_type: 'CLIPTextEncode',
      inputs: { text: params.prompt, clip: ['1', 1] },
    },
    '3': {
      class_type: 'CLIPTextEncode',
      inputs: { text: params.negativePrompt || '', clip: ['1', 1] },
    },
    '4': {
      class_type: 'EmptyLatentImage',
      inputs: { width: params.width, height: params.height, batch_size: params.frames },
    },
    '5': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
        seed: params.seed === -1 ? Math.floor(Math.random() * 2147483647) : params.seed,
        steps: params.steps,
        cfg: params.cfgScale,
        sampler_name: params.sampler,
        scheduler: 'normal',
        denoise: 1.0,
      },
    },
    '6': {
      class_type: 'VAEDecode',
      inputs: { samples: ['5', 0], vae: ['1', 2] },
    },
    '7': {
      class_type: 'SaveImage',
      inputs: { images: ['6', 0], filename_prefix: 'locally_uncensored_vid' },
    },
  }
}
