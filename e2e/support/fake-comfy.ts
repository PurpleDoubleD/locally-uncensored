import type { Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './tauri-mock'
import { seedOnboardingDone } from './cloud-mock'

export interface FakeComfy {
  checkpoints: string[]
  loras: string[]
  vaes?: string[]
  samplers?: string[]
  schedulers?: string[]
  /** Files in models/upscale_models (Enhance Image). */
  upscaleModels?: string[]
  /** The image model the stored Create state starts on. */
  imageModel: string
}

/**
 * Local Create on Windows or Linux with a ComfyUI that answers through
 * proxy_localhost: the lists the pickers and the LoRA stack show are the ones
 * given here. Call before page.goto.
 */
export async function bootWithFakeComfy(page: Page, comfy: FakeComfy) {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await page.addInitScript((c) => {
    const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: { url?: string }) => Promise<unknown> } }
    if (!localStorage.getItem('create-store')) {
      localStorage.setItem('create-store', JSON.stringify({ state: { backend: 'local', imageModel: c.imageModel }, version: 2 }))
    }
    const bridge = w.__TAURI_INTERNALS__
    const invoke = bridge.invoke
    const combo = (v: string[]) => [v]
    const nodes: Record<string, unknown> = {
      CheckpointLoaderSimple: { input: { required: { ckpt_name: combo(c.checkpoints) } } },
      LoraLoader: { input: { required: { lora_name: combo(c.loras) } } },
      VAELoader: { input: { required: { vae_name: combo(c.vaes ?? ['ae.safetensors']) } } },
      KSampler: { input: { required: { sampler_name: combo(c.samplers ?? ['euler']), scheduler: combo(c.schedulers ?? ['simple']) } } },
    }
    if (c.upscaleModels) nodes.UpscaleModelLoader = { input: { required: { model_name: combo(c.upscaleModels) } } }
    bridge.invoke = (command, args) => {
      // Rust answers a list for every file; the header itself is not under test.
      if (command === 'sniff_model_files') return Promise.resolve([])
      if (command !== 'proxy_localhost' || !args?.url?.includes(':8188')) return invoke(command, args)
      const url = args.url
      if (url.includes('/system_stats')) return Promise.resolve(JSON.stringify({ devices: [{ name: 'RTX 3060', type: 'cuda', vram_total: 12 * 1024 ** 3 }] }))
      const one = /\/object_info\/([^/?]+)/.exec(url)
      if (one) return Promise.resolve(JSON.stringify(one[1] in nodes ? { [one[1]]: nodes[one[1]] } : {}))
      if (url.includes('/object_info')) return Promise.resolve(JSON.stringify(nodes))
      return Promise.resolve('{}')
    }
  }, comfy)
}

/** Create, Image, with the advanced settings open and the Expert group unfolded. */
export async function openImageExpert(page: Page) {
  await page.goto('/')
  const create = page.getByRole('button', { name: /^Create$/ })
  // Below 1024 px the top navigation folds into its menu.
  const folded = page.getByRole('button', { name: 'Main navigation' })
  await create.or(folded).first().waitFor({ timeout: 20_000 })
  if (await create.isVisible()) await create.click()
  else {
    await folded.click()
    await page.getByRole('menuitem', { name: 'Create' }).click()
  }
  await page.getByRole('radio', { name: 'Image', exact: true }).click()
  await page.getByRole('button', { name: 'Advanced settings' }).click()
  const expert = page.getByRole('button', { name: 'Expert', exact: true })
  await expert.waitFor({ timeout: 15_000 })
  if (!(await page.getByText(/^LoRA stack/).isVisible())) await expert.click()
  await page.getByRole('button', { name: /Rescan/ }).waitFor({ timeout: 15_000 })
}
