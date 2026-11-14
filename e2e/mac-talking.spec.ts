import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, cloudSwitch } from './support/cloud-mock'
import { mlxCalls, comfyCalls, requireCall } from './support/recorded'
import { openCharacterAction, openCharacterWhat } from './support/character-hub'

/**
 * Talking Character on a Mac (3.0.8): LTX-2.3 4-bit turns a portrait and a
 * voice into a clip whose lips follow the speech, through the engine's `a2v`
 * (commands/video_ltx2mlx.rs). The tab is a local tab while that model is
 * installed; the extra download the run reads (the dev transformer) is
 * offered on the tab itself. Without the model the tab stays the cloud
 * teaser it was (mac-create-mlx.spec.ts).
 */

const MAC_OPTS: TauriMockOptions = {
  assistantReply: DEFAULT_ASSISTANT_REPLY,
  modelName: DEFAULT_MODEL_NAME,
  platform: 'mac',
}

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** A WAV of a tenth of a second of silence: header and samples. */
function silentWav(): Buffer {
  const samples = 1600
  const data = Buffer.alloc(samples * 2)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(16000, 24)
  head.writeUInt32LE(32000, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

async function bootLocalCreate(page: Page, opts: TauriMockOptions) {
  await page.addInitScript(tauriMockInit, opts)
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()
}

test('mac local: without LTX-2.3 4-bit Talking Character stays the cloud teaser', async ({ page }) => {
  await bootLocalCreate(page, { ...MAC_OPTS, mlx: { installedVideos: ['wan21-t2v-1.3b'] } })
  await openCharacterWhat(page)
  await expect(page.getByRole('radio', { name: 'Talking Character, runs on LU Cloud' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('radio', { name: 'Talking Character', exact: true })).toHaveCount(0)
})

test('mac local: Talking Character offers its own download and runs it on the video slot', async ({ page }) => {
  await bootLocalCreate(page, { ...MAC_OPTS, mlx: { ltx2EngineInstalled: true, installedVideos: ['ltx-2.3-q4'] } })
  await openCharacterWhat(page)
  const tab = page.getByRole('radio', { name: 'Talking Character', exact: true })
  await expect(tab).toBeVisible({ timeout: 15_000 })
  await tab.click()

  const part = page.getByTestId('mac-talking-part')
  await expect(part).toContainText('needs one more download for it, 11.3 GB')
  // Not ready: the button waits for the download, whatever is staged.
  await page.locator('input[type="file"][accept="image/*"]').last().setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG })
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({ name: 'hello.wav', mimeType: 'audio/wav', buffer: silentWav() })
  await expect(page.getByRole('button', { name: /^Create$/ }).last()).toBeDisabled()

  await part.getByRole('button', { name: 'Get Talking Character' }).click()
  await expect(part).toHaveCount(0, { timeout: 20_000 })
  const install = requireCall(await mlxCalls(page), 'video_install_model')
  expect(install.id).toBe('ltx-2.3-q4')
  expect(install.raw.part).toBe('talking')
  await expect(page.getByRole('button', { name: /^Create$/ }).last()).toBeEnabled()
})

test('mac local: a portrait and a voice go to the a2v run of LTX-2.3 4-bit, never to ComfyUI', async ({ page }) => {
  await bootLocalCreate(page, {
    ...MAC_OPTS,
    mlx: { ltx2EngineInstalled: true, installedVideos: ['wan21-t2v-1.3b', 'ltx-2.3-q4'], talkingVideos: ['ltx-2.3-q4'] },
  })
  await openCharacterAction(page, 'Talking Character')
  await expect(page.getByTestId('mac-talking-part')).toHaveCount(0)
  // No prompt field on this tab, and no clip to resync: a portrait and a voice.
  await expect(page.getByText('Add portrait')).toBeVisible()
  await expect(page.getByText('Add video to resync')).toHaveCount(0)
  const create = page.getByRole('button', { name: /^Create$/ }).last()
  await expect(create).toBeDisabled()

  await page.locator('input[type="file"][accept="image/*"]').last().setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG })
  await expect(create).toBeDisabled()
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({ name: 'hello.wav', mimeType: 'audio/wav', buffer: silentWav() })
  await expect(create).toBeEnabled()
  // What the voice says goes into the prompt, quoted: the lips follow it.
  await page.getByLabel('What the voice says').fill('Hello there, this is "me" talking.')
  if (process.env.LU_SHOTS) await page.screenshot({ path: `${process.env.LU_SHOTS}/mac-talking-ready.png` })
  await create.click()

  await expect
    .poll(async () => (await mlxCalls(page)).filter((c) => c.cmd === 'video_generate').length, { timeout: 40_000 })
    .toBeGreaterThan(0)
  const calls = await mlxCalls(page)
  expect(Number(requireCall(calls, 'video_stage_start_image').raw.bytes)).toBeGreaterThan(0)
  expect(Number(requireCall(calls, 'video_stage_voice').raw.bytes)).toBeGreaterThan(0)
  const gen = requireCall(calls, 'video_generate')
  // The model that talks, not the one picked for Video.
  expect(gen.id).toBe('ltx-2.3-q4')
  expect(gen.raw.audio).toBe('/tmp/lu-e2e/videos/voices/e2e-voice.wav')
  expect(gen.raw.init_image).toBe('/tmp/lu-e2e/videos/start-images/e2e-start.png')
  // The clip is as long as the voice, which Rust reads: no length is sent.
  expect(gen.raw.seconds).toBeUndefined()
  expect(gen.raw.loras).toBeUndefined()
  expect(String(gen.prompt)).toContain('says: "Hello there, this is \'me\' talking." Their lips move clearly with every word')
  // On the 64 grid of the engine.
  expect(Number(gen.raw.width) % 64).toBe(0)
  expect(Number(gen.raw.height) % 64).toBe(0)
  expect(await comfyCalls(page)).toHaveLength(0)
  // The clip lands in the gallery as a Talking Character video.
  await expect(page.locator('video').first()).toBeAttached({ timeout: 20_000 })
})
