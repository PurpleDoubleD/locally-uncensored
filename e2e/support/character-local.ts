import type { Page } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './tauri-mock'
import { seedOnboardingDone } from './cloud-mock'
import { gradientPng } from './png'

/** A stand-in ComfyUI on a Windows desktop for the Character area in local
 *  mode: a Z-Image model, a char_* LoRA, Wan 2.2 Animate and S2V (left out
 *  with `videoModels: false`), a trainer in the state asked for. It records
 *  every graph posted to /prompt. */

export type TrainerState = 'none' | 'bases' | 'ready'
export interface LocalBoot { trainer?: TrainerState; videoModels?: boolean; width?: number; height?: number }

export const ZIMAGE = 'z_image_turbo_bf16.safetensors'
export const ANIMATE = 'Wan2.2-Animate-14B-Q4_K_M.gguf'
export const S2V = 'Wan2.2-S2V-14B-Q4_K_M.gguf'
export const LORA = 'char_opa_zimage.safetensors'
export const PNG = gradientPng(512, 768)

export type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>

/** The app's own object_info fixture, and every node the builders name (a
 *  recent ComfyUI with the packs LU installs for these lanes). */
const OBJECT_INFO = {
  ...Object.fromEntries(['ADE_ApplyAnimateDiffModelSimple','ADE_LoadAnimateDiffModel','ADE_UseEvolvedSampling','ApplyTextureToMesh','AudioEncoderEncode','AudioEncoderLoader','BakeAmbientOcclusion','BakeNormalMapFromMesh','BakeTextureFromVoxel','BasicGuider','BasicScheduler','BlockSparseAttention','CFGGuider','CFGNorm','CFGOverride','CLIPLoader','CLIPSetLastLayer','CLIPTextEncode','CLIPVisionEncode','CLIPVisionLoader','CheckpointLoaderSimple','ConditioningZeroOut','CreateVideo','DWPreprocessor','DecimateMesh','DualCFGGuider','DualCLIPLoader','EmptyImage','EmptyLTXVLatentVideo','EmptyLatentImage','EmptyTrellis2LatentStructure','EmptyYuE2LatentAudio','FluxKontextImageScale','FluxKontextMultiReferenceLatentMethod','FramePackSampler','GetVideoComponents','GrowMask','ImageCompositeMasked','ImageCropToMask','ImageOnlyCheckpointLoader','ImageScale','ImageScaleBy','ImageScaleToTotalPixels','ImageToMask','ImageUpscaleWithModel','InpaintModelConditioning','KSampler','KSamplerAdvanced','KSamplerSelect','LoadAudio','LoadBackgroundRemovalModel','LoadFramePackModel','LoadImage','LoadImageMask','LoadVideo','LoraLoader','LoraLoaderModelOnly','ManualSigmas','MaskComposite','MeshSmoothNormals','MiniMaxH3SigmaShift','ModelSamplingAuraFlow','ModelSamplingFlux','ModelSamplingSD3','QuadrupleCLIPLoader','QwenImage21Cache','RMBG','RandomNoise','ReferenceLatent','RemeshMesh','RemoveBackground','RescaleCFG','SVD_img2vid_Conditioning','SamplerCustomAdvanced','SaveAudioMP3','SaveGLB','SaveImage','SaveVideo','TextEncodeQwenImage21','TextEncodeQwenImageEditPlus','ThresholdMask','Trellis2Conditioning','Trellis2ShapeStage','Trellis2TextureStage','Trellis2UpsampleStage','TrimVideoLatent','TripleCLIPLoader','UNETLoader','UnetLoaderGGUF','UnwrapMesh','UpscaleModelLoader','VAEDecode','VAEDecodeAudio','VAEEncode','VAEEncodeForInpaint','VAELoader','VHS_LoadVideo','VaeDecodeShapeTrellis','VaeDecodeStructureTrellis2','VaeDecodeTextureTrellis','VideoLinearCFGGuidance','Wan22ImageToVideoLatent','WanAnimateToVideo','WanSoundImageToVideo','WanVaceToVideo','YuE2GenerateMusic'].map((n) => [n, { input: { required: {} } }])),
  ...JSON.parse(readFileSync(join(process.cwd(), 'src/api/__tests__/fixtures/comfy-ui/object-info.json'), 'utf8')),
} as Record<string, unknown>

export async function bootLocal(page: Page, { trainer = 'ready', videoModels = true, width = 1296, height = 900 }: LocalBoot = {}) {
  await page.setViewportSize({ width, height })
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await page.addInitScript(({ zimage, animate, s2v, lora, base, trainer, videoModels }) => {
    const w = window as unknown as { __PROMPTS__: string[]; __UPLOADS__: string[]; __TAURI_INTERNALS__: { invoke: (c: string, a: { url?: string; method?: string; body?: string; filename?: string }) => Promise<unknown> } }
    if (!localStorage.getItem('create-store')) {
      localStorage.setItem('create-store', JSON.stringify({ state: { backend: 'local', imageModel: zimage }, version: 2 }))
    }
    w.__PROMPTS__ = []
    w.__UPLOADS__ = []
    const bridge = w.__TAURI_INTERNALS__
    const invoke = bridge.invoke
    const combo = (v: string[]) => [v]
    const any = { input: { required: {} } }
    const nodes: Record<string, unknown> = {
      ...base,
      UNETLoader: { input: { required: { unet_name: combo([zimage]), weight_dtype: combo(['default']) } } },
      UnetLoaderGGUF: { input: { required: { unet_name: combo(videoModels ? [animate, s2v] : []) } } },
      CLIPLoader: { input: { required: { clip_name: combo(['qwen_3_4b.safetensors', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors']), type: combo(['lumina2', 'wan', 'qwen_image', 'stable_diffusion']), device: combo(['default']) } } },
      VAELoader: { input: { required: { vae_name: combo(['ae.safetensors', 'wan_2.1_vae.safetensors']) } } },
      AudioEncoderLoader: { input: { required: { audio_encoder_name: combo(['wav2vec2_large_english_fp16.safetensors']) } } },
      LoraLoader: { input: { required: { model: ['MODEL'], clip: ['CLIP'], lora_name: combo([lora]), strength_model: ['FLOAT', { default: 1 }], strength_clip: ['FLOAT', { default: 1 }] } } },
      LoraLoaderModelOnly: { input: { required: { model: ['MODEL'], lora_name: combo([lora]), strength_model: ['FLOAT', { default: 1 }] } } },
      KSampler: { input: { required: { model: ['MODEL'], seed: ['INT'], steps: ['INT'], cfg: ['FLOAT'], sampler_name: combo(['euler', 'res_multistep']), scheduler: combo(['simple']), positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], denoise: ['FLOAT', { default: 1 }] } } },
      ImageScale: { input: { required: { image: ['IMAGE'], upscale_method: combo(['nearest-exact', 'lanczos']), width: ['INT'], height: ['INT'], crop: combo(['disabled', 'center']) } } },
      LoadImage: { input: { required: { image: combo(['source.png']) } } },
      DWPreprocessor: any, WanAnimateToVideo: any, WanSoundImageToVideo: any, TrimVideoLatent: any,
      LoadVideo: any, GetVideoComponents: any, CreateVideo: any, SaveVideo: any, VHS_LoadVideo: any, VHS_VideoCombine: any,
      LoadAudio: any, AudioEncoderEncode: any, ModelSamplingSD3: any, ModelSamplingAuraFlow: any,
      ImageToMask: any, MaskComposite: any, ThresholdMask: any, GrowMask: any, EmptyImage: any, ImageCompositeMasked: any,
      CLIPTextEncode: any, EmptySD3LatentImage: any, EmptyLatentImage: any, VAEDecode: any, VAEDecodeTiled: any, SaveImage: any,
      ConditioningZeroOut: any,
    }
    bridge.invoke = (command, args) => {
      if (command === 'sniff_model_files') return Promise.resolve([])
      if (command === 'trainer_setup_plan') {
        // The estimate of commands/trainer.rs (PLAN_*_BYTES).
        return Promise.resolve({ items: [{ label: 'Python', bytes: 60_000_000 }, { label: 'trainer source', bytes: 5_000_000 }, { label: 'PyTorch', bytes: 2_500_000_000 }, { label: 'packages', bytes: 500_000_000 }], downloadBytes: 3_065_000_000, diskGib: 12, replacesTorch: false, interrupted: false })
      }
      if (command === 'character_trainer_status') {
        const missing = trainer === 'ready' ? [] : [{ filename: 'z_image_bf16.safetensors', subfolder: 'diffusion_models', bytes: 12_309_866_400 }]
        return Promise.resolve({
          envReady: trainer !== 'none', basesReady: trainer === 'ready', dit: trainer === 'ready' ? 'z_image_bf16.safetensors' : null,
          textEncoder: 'qwen_3_4b.safetensors', vae: 'ae.safetensors', missingBases: missing,
          root: 'C:\\LU\\trainer', customized: false, suggestedRoot: null, install: { status: 'idle', logs: [] },
        })
      }
      if (command === 'detect_gpus') return Promise.resolve([{ index: 0, vendor: 'nvidia', name: 'RTX 3060', memory_mib: 12288, source: 'e2e' }])
      if (command === 'comfy_upload_image') {
        w.__UPLOADS__.push(String(args?.filename))
        return Promise.resolve(JSON.stringify({ name: String(args?.filename), subfolder: '', type: 'input' }))
      }
      if (command !== 'proxy_localhost' || !args?.url?.includes(':8188')) return invoke(command, args)
      const url = args.url
      if (url.includes('/system_stats')) return Promise.resolve(JSON.stringify({ devices: [{ name: 'RTX 3060', type: 'cuda', vram_total: 12 * 1024 ** 3 }] }))
      if (url.endsWith('/prompt') && args.method === 'POST') {
        w.__PROMPTS__.push(String(args.body))
        return Promise.resolve(JSON.stringify({ prompt_id: `p${w.__PROMPTS__.length}`, number: 1, node_errors: {} }))
      }
      const hist = /\/history\/(p\d+)/.exec(url)
      if (hist) {
        const images = [{ filename: `local_${hist[1]}.png`, subfolder: '', type: 'output' }]
        return Promise.resolve(JSON.stringify({ [hist[1]]: { status: { status_str: 'success', completed: true, messages: [] }, outputs: { '99': { images } } } }))
      }
      if (url.includes('/queue')) return Promise.resolve(JSON.stringify({ queue_running: [], queue_pending: [] }))
      const one = /\/object_info\/([^/?]+)/.exec(url)
      if (one) {
        const type = decodeURIComponent(one[1])
        return Promise.resolve(JSON.stringify(type in nodes ? { [type]: nodes[type] } : {}))
      }
      if (url.includes('/object_info')) return Promise.resolve(JSON.stringify(nodes))
      return Promise.resolve('{}')
    }
  }, { zimage: ZIMAGE, animate: ANIMATE, s2v: S2V, lora: LORA, base: OBJECT_INFO, trainer, videoModels })
  await page.route(/:8188\/view/, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await page.goto('/')
  await page.getByRole('button', { name: /^Create$/ }).click()
}
