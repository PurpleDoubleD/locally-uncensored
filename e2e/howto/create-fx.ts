import { expect, type Page } from '@playwright/test'
import { readFileSync } from 'fs'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from '../support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from '../support/cloud-mock'
import { CLOUD_MODEL_SEED } from '../../src/lib/render/cloud-models'
import { Rec, HOWTO_OUT } from './rec'

/**
 * Fixtures for the Create how-tos that the plain rig cannot show
 * (video, animate, character, lipsync, extend, motion).
 *
 * The rig's catalog answer (cloud-mock.ts) knows one video model and no
 * talking, training or character model, so the pickers of these tabs would be
 * empty or one line long. FIXTURE: /api/jobs/catalog answers with the app's
 * own bundled model list (CLOUD_MODEL_SEED, src/lib/render/cloud-models.ts),
 * the list the app shows before the server has answered. Nothing is invented:
 * names, clip lengths and the negative-prompt flag are the app's own. Only a
 * placeholder price is added where the seed has none (prices are not a subject
 * of any caption).
 */
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' }
const BASE = { image: 300, video: 40000, audio: 1500 } as const

export const ASSETS = (id: string) => `${HOWTO_OUT}/${id}/assets`

export type Fx = {
  /** Trained cloud characters /api/loras answers with. */
  loras?: { id: string; name: string; trigger_word: string; base_family: string; created_at: string }[]
  /** Gallery as a finished earlier session leaves it (localStorage, key create-store). */
  gallery?: Record<string, unknown>[]
  /** Files the cloud serves: path on lu-labs.ai -> local file + content type. */
  files?: Record<string, { file: string; type: string }>
  /** The job a submit starts stays "running" and its cancel answers 409, as
   *  the server does once a GPU took the job. */
  runningJob?: boolean
  /** A local ComfyUI that answers (idle, no models), as on a machine where it
   *  runs. Without it the rig's red "ComfyUI is not running" line stands in
   *  the same bar a run's own message uses. */
  comfyUp?: boolean
}

export async function bootCreate(page: Page, id: string, title: string, fx: Fx = {}): Promise<Rec> {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  if (fx.gallery) {
    await page.addInitScript((gallery) => {
      if (!window.localStorage.getItem('create-store')) {
        window.localStorage.setItem('create-store', JSON.stringify({ state: { gallery }, version: 2 }))
      }
    }, fx.gallery)
  }
  if (fx.comfyUp) {
    await page.addInitScript(() => {
      const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: { url?: string }) => Promise<unknown> } }
      const bridge = w.__TAURI_INTERNALS__
      const invoke = bridge.invoke
      bridge.invoke = (command, args) => {
        if (command === 'sniff_model_files') return Promise.resolve([])
        if (command !== 'proxy_localhost' || !args?.url?.includes(':8188')) return invoke(command, args)
        const url = args.url
        if (url.includes('/system_stats')) return Promise.resolve(JSON.stringify({ devices: [{ name: 'GPU', type: 'cuda', vram_total: 12 * 1024 ** 3 }] }))
        // One checkpoint, the way e2e/support/fake-comfy.ts answers: with none
        // the app keeps saying "ComfyUI is loading models".
        const combo = (v: string[]) => [v]
        const nodes: Record<string, unknown> = {
          CheckpointLoaderSimple: { input: { required: { ckpt_name: combo(['sd_xl_base_1.0.safetensors']) } } },
          LoraLoader: { input: { required: { lora_name: combo([]) } } },
          VAELoader: { input: { required: { vae_name: combo(['ae.safetensors']) } } },
          KSampler: { input: { required: { sampler_name: combo(['euler']), scheduler: combo(['simple']) } } },
        }
        const one = /\/object_info\/([^/?]+)/.exec(url)
        if (one) return Promise.resolve(JSON.stringify(one[1] in nodes ? { [one[1]]: nodes[one[1]] } : {}))
        if (url.includes('/object_info')) return Promise.resolve(JSON.stringify(nodes))
        return Promise.resolve('{}')
      }
    })
  }
  await routeCloud(page, { license: 'active', access: true, mediaLive: true, studioCatalog: true })
  // Registered after the rig's routes, so these answer first.
  await page.route('https://lu-labs.ai/api/jobs/catalog*', (route) => route.fulfill({
    status: 200, headers: CORS, contentType: 'application/json',
    body: JSON.stringify({
      models: CLOUD_MODEL_SEED.map((m) => ({ ...m, credits: m.credits ?? { base: BASE[m.kind === '3d' ? 'image' : m.kind] } })),
      ops: { removebg: 1000, eraser: 2500, upscale_image: 1000, upscale_video_per_s: 500, upscale_video_min: 2500 },
      voice: { stt: 600, tts_per_1k_chars: 8000 },
      media_live: true, tier: 'hosted-max', monthly_credits: 2_550_000,
    }),
  }))
  await page.route('https://lu-labs.ai/api/loras', (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ loras: fx.loras ?? [] }) })
  })
  for (const [path, f] of Object.entries(fx.files ?? {})) {
    const body = readFileSync(f.file)
    await page.route(`https://lu-labs.ai${path}`, (route) => route.fulfill({ status: 200, headers: { ...CORS, 'content-type': f.type }, body }))
  }
  if (fx.runningJob) {
    await page.route('https://lu-labs.ai/api/jobs/job-e2e-1', (route) => route.fulfill({
      status: 200, headers: CORS, contentType: 'application/json',
      body: JSON.stringify({ job: { id: 'job-e2e-1', kind: 'video', model: 'wan-2.2-720p', provider: 'upstream', status: 'running', result_url: null, attestation: null, cost_units: 40000, created_at: new Date().toISOString(), completed_at: null, error: null } }),
    }))
    await page.route('https://lu-labs.ai/api/jobs/job-e2e-1/cancel', (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
      return route.fulfill({ status: 409, headers: CORS, contentType: 'application/json', body: JSON.stringify({ error: 'job already running' }) })
    })
  }
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked({ timeout: 20_000 })
  // Same standing exception as Rec.boot: the rig's "ComfyUI is not running" line.
  // Only that line: other alerts (a refused cancel) are part of the how-to.
  return new Rec(page, id, title)
}

/** Hides the rig's red ComfyUI line the way Rec.boot does. Call it for films
 *  that show no other alert. */
export async function hideRigAlert(page: Page) {
  await page.addStyleTag({ content: 'main [role="alert"]{display:none !important}' })
}
