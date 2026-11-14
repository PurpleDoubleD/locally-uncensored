import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'
import { openCharacterAction } from './support/character-hub'

/**
 * Swap Character (07.11.2026, port of the web's C52; two steps with SCAIL 2
 * and Kling since 14.11.2026; one click since 14.11.2026, only with the
 * account switch) in the real app, Tauri stubbed, cloud mocked: the panel in
 * the web's order, the marks on the first frame, one Create with the total,
 * the switches Uncensored and Check first frame, the check (Does this look
 * right?, Continue), the video on the new frame, Kling for one person only.
 * Nothing is booked: frame and video run against the mock, the video job
 * never finishes.
 *
 * Media come from LU_SWAP_MEDIA_DIR (clip.mp4, face1.png, face2.png and
 * frame-new.jpg, the built frame the mock hands back) when it is set; without
 * it the spec uses a 1x1 picture and a short clip the browser records from a
 * canvas, which tests the same panel and only looks plainer. LU_SWAP_SHOTS_DIR, when set, receives
 * screenshots of the tab in the dark and the light theme.
 */

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

/** The swap models and the frame model as a server that knows them lists them. */
const SWAP_CATALOG = [
  ['scail-2', 'SCAIL 2'],
  ['kling-v3-pro-motion-control', 'Kling 3.0 Pro \u2022 Motion Control'],
  ['openjutsu-character-swap', 'OpenJutsu Character Swap'],
  ['wan-2.2-animate-replace', 'Wan 2.2 Animate Replace'],
].map(([id, label]) => ({ id, label, kind: 'video', ops: ['studio'], quote_required: true, t2v: false, i2v: false }))
  .concat([{ id: 'nano-banana-pro-edit', label: 'Nano Banana Pro', kind: 'image', ops: ['studio'], quote_required: true, t2v: false, i2v: false }])
  // The lip sync step of "New voice, lips in sync" (14.11.2026), priced by the
  // length of the voice as the server lists it.
  .concat([{
    id: 'latentsync', label: 'LatentSync', kind: 'video', ops: ['lipsync'], quote_required: false, t2v: false, i2v: false,
    credits: { base: 9000, length: { basis: 'audio', block: 1, per_block: 3000, min: 3, max: 300, quote: 10 } },
  } as never])

async function media(name: string, mimeType: string, page?: Page) {
  const dir = process.env.LU_SWAP_MEDIA_DIR
  if (dir) {
    const { readFileSync } = await import('node:fs')
    return { name, mimeType, buffer: readFileSync(`${dir}/${name}`) }
  }
  if (mimeType.startsWith('video') && page) return { name: 'clip.webm', mimeType: 'video/webm', buffer: await recordedClip(page) }
  return { name, mimeType, buffer: mimeType.startsWith('image') ? PNG_1PX : Buffer.from('stub') }
}

/** A short real video without a file on disk: the page records a canvas with
 *  two figures for under a second. The first frame step needs a clip the
 *  WebView can decode; a stub of bytes has no first frame. */
async function recordedClip(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 180
    const ctx = canvas.getContext('2d')!
    const paint = (t: number) => {
      ctx.fillStyle = '#d8d4cc'
      ctx.fillRect(0, 0, 320, 180)
      ctx.fillStyle = '#6b4f3a'
      ctx.beginPath(); ctx.arc(140 + t, 70, 28, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#2f2a28'
      ctx.beginPath(); ctx.arc(215 - t, 76, 28, 0, Math.PI * 2); ctx.fill()
    }
    paint(0)
    const rec = new MediaRecorder(canvas.captureStream(15), { mimeType: 'video/webm' })
    const parts: Blob[] = []
    rec.ondataavailable = (e) => parts.push(e.data)
    const done = new Promise<void>((r) => { rec.onstop = () => r() })
    rec.start()
    for (let i = 0; i < 12; i++) { paint(i); await new Promise((r) => setTimeout(r, 60)) }
    rec.stop()
    await done
    const bytes = new Uint8Array(await new Blob(parts, { type: 'video/webm' }).arrayBuffer())
    let bin = ''
    for (const x of bytes) bin += String.fromCharCode(x)
    return btoa(bin)
  })
  return Buffer.from(b64, 'base64')
}

/** What the mock saw of the frame step: every submit body. */
interface Seen { submits: Array<{ model: string; prompt: string; params: Record<string, unknown> }>; uploads: number; adopts: unknown[] }

async function openSwap(page: Page): Promise<Seen> {
  await page.setViewportSize({ width: 1296, height: 900 })
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  // An account the server released the Character area for (CHARACTER_HUB).
  await routeCloud(page, { license: 'active', access: true, mediaLive: true, extraCatalogModels: SWAP_CATALOG, characterHub: true })
  // The frame step against the mock: upload, submit, poll, and the built
  // frame. Registered after routeCloud, so these answer first; anything
  // else falls back to the shared mock.
  const seen: Seen = { submits: [], uploads: 0, adopts: [] }
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' }
  const frameImage = await media('frame-new.jpg', 'image/jpeg')
  await page.route('https://lu-labs.ai/**', async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    if (req.method() === 'OPTIONS') return route.fallback()
    const json = (body: unknown, status = 200) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (path === '/api/jobs/upload' && req.method() === 'POST') {
      seen.uploads++
      return json({ path: `e2e-user-1/staged-${seen.uploads}.bin` })
    }
    if (path === '/api/jobs/adopt' && req.method() === 'POST') {
      seen.adopts.push(req.postDataJSON())
      return json({ path: `e2e-user-1/adopted-${seen.adopts.length}.jpg` })
    }
    if (path === '/api/jobs' && req.method() === 'POST') {
      const body = req.postDataJSON() as Seen['submits'][number]
      seen.submits.push(body)
      // The video step of the chain: taken, then it keeps rendering (no result,
      // nothing booked). Anything else but the frame step is refused.
      if (body.params?.swap_step === 'video') {
        return json({ id: 'job-video-1', status: 'queued', created_at: new Date().toISOString(), quota: { kind: 'video', cost: 48000, used: 0, limit: 2_550_000 } }, 202)
      }
      if (body.params?.swap_step !== 'frame') return json({ error: 'e2e: only the frame step is mocked' }, 400)
      return json({ id: `job-frame-${seen.submits.length}`, status: 'queued', created_at: new Date().toISOString(), quota: { kind: 'image', cost: 14000, used: 0, limit: 2_550_000 } }, 202)
    }
    if (path === '/api/jobs/job-video-1' && req.method() === 'GET') {
      return json({ job: {
        id: 'job-video-1', kind: 'video', model: 'scail-2', provider: 'upstream', status: 'running',
        result_url: null, attestation: null, cost_units: 0, created_at: new Date().toISOString(), completed_at: null, error: null,
      } })
    }
    const job = /^\/api\/jobs\/(job-frame-\d+)$/.exec(path)
    if (job && req.method() === 'GET') {
      return json({ job: {
        id: job[1], kind: 'image', model: 'nano-banana-pro-edit', provider: 'upstream', status: 'succeeded',
        result_url: `https://lu-labs.ai/e2e/${job[1]}.jpg`, attestation: null, cost_units: 14000,
        created_at: new Date().toISOString(), completed_at: new Date().toISOString(), error: null,
      } })
    }
    if (/^\/e2e\/job-frame-\d+\.jpg$/.test(path)) {
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': frameImage.mimeType }, body: frameImage.buffer })
    }
    return route.fallback()
  })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()
  // Since 3.1.0 part B an action of the Character area.
  await openCharacterAction(page, 'Swap Character')
  await expect(page.locator('[data-swap-controls]')).toBeVisible({ timeout: 15_000 })
  return seen
}

async function shoot(page: Page, name: string, focus?: string, prefix = 'desktop-app') {
  const dir = process.env.LU_SWAP_SHOTS_DIR
  if (!dir) return
  // The part the shot is about, scrolled into the panel's view.
  if (focus) await page.locator(focus).first().evaluate((el) => el.scrollIntoView({ block: 'end' }))
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => {
      document.documentElement.classList.toggle('dark', t === 'dark')
      document.documentElement.classList.toggle('light', t === 'light')
    }, theme)
    await page.waitForTimeout(250)
    await page.screenshot({ path: `${dir}/${prefix}-${name}-${theme}.png` })
  }
  await page.evaluate(() => {
    document.documentElement.classList.add('dark')
    document.documentElement.classList.remove('light')
  })
}

/** A tap on the first frame at a share of its width and height. */
async function tapFrame(page: Page, x: number, y: number) {
  const frame = page.getByRole('group', { name: /First frame of your video/ })
  const box = await frame.boundingBox()
  if (!box) throw new Error('first frame not on screen')
  await frame.click({ position: { x: box.width * x, y: box.height * y } })
}

test('Swap with one click: marks, one total, the check, then the video on the new frame', async ({ page }) => {
  const seen = await openSwap(page)
  const panel = page.locator('[data-swap-controls]')
  const create = page.getByRole('button', { name: /^Create/ }).last()

  // SCAIL 2 is the default, the notes stand grey, both switches off.
  await expect(panel.locator('[data-swap-tips]')).toContainText('Up to 3 people with SCAIL-2, one person with Kling (highest resolution).')
  await expect(page.locator('[data-swap-summary]')).toHaveText('Auto · SCAIL-2 · 720p')
  // The resolution is under More options (sketches v2), with the engines.
  await page.getByRole('button', { name: 'More options' }).click()
  await expect(page.getByRole('radio', { name: '720p' })).toHaveAttribute('aria-checked', 'true')
  await expect(create).toBeDisabled()
  await shoot(page, 'swap-empty')

  // The original video: the first frame is drawn in the WebView.
  await panel.locator('input[type=file][accept^="video"]').setInputFiles(await media('clip.mp4', 'video/mp4', page))
  await expect(page.getByText('Tap each person you want to replace')).toBeVisible({ timeout: 20_000 })
  // Two people tapped: numbered marks, their place becomes the role.
  await tapFrame(page, 0.45, 0.35)
  await tapFrame(page, 0.68, 0.38)
  await expect(page.getByRole('button', { name: 'Remove mark 2' })).toBeVisible()
  await expect(page.locator('[data-swap-frame-count]')).toHaveAttribute('data-swap-frame-count', '2')
  await expect(page.getByRole('textbox', { name: 'Who person 1 replaces' })).toHaveAttribute('placeholder', /^the person on the left/)
  await expect(page.getByRole('textbox', { name: 'Who person 2 replaces' })).toHaveAttribute('placeholder', /^the person on the right/)
  await page.locator('[data-swap-photo-input="1"]').setInputFiles(await media('face1.png', 'image/png'))
  await page.locator('[data-swap-photo-input="2"]').setInputFiles(await media('face2.png', 'image/png'))
  await expect(page.getByRole('button', { name: 'Character for person 2' })).toContainText('Photo')
  // The bar prices frame and video together, the button names the total.
  await expect(page.locator('[data-clip-price]')).toHaveAttribute('title', /credits$/)
  await expect(page.locator('[data-clip-split]')).toContainText('frame 14k + video')

  // Under More options: Kling stands greyed out for two people.
  await page.getByRole('button', { name: 'Video model' }).click()
  const kling = page.getByRole('option', { name: /Kling 3.0 Pro/ })
  await expect(kling).toBeDisabled()
  await expect(kling).toContainText('one person only')
  await page.keyboard.press('Escape')
  await expect(kling).toBeHidden()
  await expect(page.getByRole('button', { name: 'First-frame model' })).toContainText('Auto (Nano Banana Pro)')

  // The switches: Uncensored off, the check off; Uncensored takes the check along.
  const uncensored = page.getByRole('switch', { name: 'Uncensored' })
  const check = page.getByRole('switch', { name: 'Check first frame before video' })
  await expect(uncensored).toHaveAttribute('aria-checked', 'false')
  await expect(check).toHaveAttribute('aria-checked', 'false')
  await uncensored.click()
  await expect(check).toHaveAttribute('aria-checked', 'true')
  await uncensored.click()
  await expect(check).toHaveAttribute('aria-checked', 'false')

  // Create waits for the consent.
  await expect(create).toBeDisabled()
  await shoot(page, 'swap-two-marks')
  await page.getByRole('checkbox').check()
  await expect(create).toBeEnabled({ timeout: 15_000 })
  await expect(create).toContainText(/^Create · \d+k$/)
  await shoot(page, 'swap-ready-scail2', '[data-swap-bar]')

  // With the check: one press builds the frame and stops.
  await check.click()
  await create.click()
  await expect(page.getByText('Does this look right?')).toBeVisible({ timeout: 20_000 })
  expect(seen.submits).toHaveLength(1)
  expect(seen.submits[0].model).toBe('nano-banana-pro-edit')
  expect(seen.submits[0].params).toMatchObject({ op: 'studio', swap_step: 'frame', swap_consent: true, max_credits: 14000 })
  expect(seen.submits[0].params.image_paths).toHaveLength(3)
  expect(seen.submits[0].prompt).toContain('replace the person on the left with the person from the second image and replace the person on the right with the person from the third image')
  await expect(page.getByRole('img', { name: /^New first frame/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Try again · 14k/ })).toBeEnabled()
  await expect(page.getByRole('textbox', { name: "What's wrong?" })).toHaveAttribute('placeholder', "What's wrong? (optional)")
  await shoot(page, 'swap-review')

  // Continue: the video starts on the new frame (adopted), with the consent.
  await page.getByRole('button', { name: /^Continue/ }).click()
  await expect(page.locator('[data-swap-one-click=running]')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[data-swap-step=frame]')).toHaveAttribute('data-state', 'done')
  await expect(page.locator('[data-swap-step=video]')).toHaveAttribute('data-state', 'now')
  expect(seen.adopts).toEqual([{ job_id: 'job-frame-1', role: 'image' }])
  const video = seen.submits[1]
  expect(video.model).toBe('scail-2')
  expect(video.params).toMatchObject({ op: 'studio', swap_step: 'video', swap_consent: true, sound: 'original', source_path: 'e2e-user-1/adopted-1.jpg' })
  expect(video.params.image_paths).toBeUndefined()
  await shoot(page, 'swap-running')
})

test('Swap with OpenJutsu: four people run in one step, no switches', async ({ page }) => {
  await openSwap(page)
  const panel = page.locator('[data-swap-controls]')
  const create = page.getByRole('button', { name: /^Create/ }).last()
  await page.locator('[data-swap-photo-input="1"]').setInputFiles(await media('face1.png', 'image/png'))
  await page.getByRole('button', { name: /Add person/ }).click()
  await expect(page.getByRole('button', { name: /Add person/ })).toHaveText('+ Add person (2/4)')
  await page.getByRole('button', { name: /Add person/ }).click()
  await page.getByRole('button', { name: /Add person/ }).click()
  await expect(page.getByRole('button', { name: /Add person/ })).toHaveText('+ Add person (4/4)')
  await expect(page.getByRole('button', { name: /Add person/ })).toBeDisabled()
  // Four people: OpenJutsu by itself, one step, so no frame switches.
  await expect(page.locator('[data-swap-summary]')).toContainText('Auto · OpenJutsu')
  await expect(page.getByRole('switch', { name: 'Uncensored' })).toHaveCount(0)
  for (const i of [2, 3, 4]) await page.locator(`[data-swap-photo-input="${i}"]`).setInputFiles(await media('face2.png', 'image/png'))
  await page.getByRole('checkbox').check()
  // Without the video Create stays off.
  await expect(create).toBeDisabled()
  await panel.locator('input[type=file][accept^="video"]').setInputFiles(await media('clip.mp4', 'video/mp4', page))
  await expect(create).toBeEnabled({ timeout: 15_000 })
  await expect(page.locator('[data-clip-price]')).toHaveAttribute('title', /credits$/)
  await expect(page.locator('[data-clip-split]')).not.toContainText('frame')
})

/** A voice of `seconds` seconds as a WAV (a quiet tone), made here so the
 *  WebView can measure it; no file on disk. */
function voiceWav(seconds: number) {
  const rate = 8000
  const n = rate * seconds
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 220) * 3000), 44 + i * 2)
  return { name: 'voice.wav', mimeType: 'audio/wav', buffer: buf }
}

test('Sound in Swap: original by default, lip sync greyed out for two people, a new voice priced with the video', async ({ page }) => {
  const seen = await openSwap(page)
  const panel = page.locator('[data-swap-controls]')
  const sound = page.getByRole('radiogroup', { name: 'Sound' })
  const lipsync = page.getByRole('radio', { name: 'New voice, lips in sync' })
  await expect(sound).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Original sound' })).toHaveAttribute('aria-checked', 'true')

  await panel.locator('input[type=file][accept^="video"]').setInputFiles(await media('clip.mp4', 'video/mp4', page))
  await expect(page.getByText('Tap each person you want to replace')).toBeVisible({ timeout: 20_000 })
  await tapFrame(page, 0.45, 0.35)
  await page.locator('[data-swap-photo-input="1"]').setInputFiles(await media('face1.png', 'image/png'))
  await shoot(page, 'swap-original', '[data-sound-controls]', 'desktop-ton')

  // A new voice: the voice chip, the price of both steps on slider and button.
  await lipsync.click()
  await expect(page.locator('[data-sound-lipsync]')).toBeVisible()
  await page.locator('[data-sound-lipsync] input[type=file][accept="audio/*"]').setInputFiles(voiceWav(8))
  await expect(page.locator('[data-sound-price]')).toContainText('+ lip sync')
  await expect(page.locator('[data-clip-split]')).toContainText('frame 14k + video')
  await expect(page.locator('[data-clip-split]')).toContainText('lip sync')
  await page.getByRole('checkbox').check()
  const create = page.getByRole('button', { name: /^Create/ }).last()
  await expect(create).toBeEnabled({ timeout: 15_000 })
  await expect(create).toContainText('Create ·')
  await shoot(page, 'swap-lipsync-voice-price', '[data-sound-controls]', 'desktop-ton')

  // A second person: lip sync goes grey, back to the original sound.
  await tapFrame(page, 0.68, 0.38)
  await expect(lipsync).toBeDisabled()
  await expect(lipsync).toHaveAttribute('title', 'Lip sync works with one person')
  await expect(page.locator('[data-sound-note=lipsync-blocked]')).toHaveText('one person only')
  await expect(page.getByRole('radio', { name: 'Original sound' })).toHaveAttribute('aria-checked', 'true')
  await shoot(page, 'swap-lipsync-blocked-two-people', '[data-sound-controls]', 'desktop-ton')

  // Create was never pressed: nothing went to the queue.
  expect(seen.submits).toHaveLength(0)
})

test('Sound in Motion: on the cloud lanes only', async ({ page }) => {
  await openSwap(page)
  await openCharacterAction(page, 'Motion Control')
  const sound = page.locator('[data-sound-controls=motion]')
  await expect(sound).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('radio', { name: 'Original sound' })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('radio', { name: 'New voice, lips in sync' }).click()
  await page.locator('[data-sound-lipsync] input[type=file][accept="audio/*"]').setInputFiles(voiceWav(4))
  await expect(page.locator('[data-sound-price]')).toContainText('credits')
  await shoot(page, 'motion-cloud', '[data-sound-controls]', 'desktop-ton')

  // The local lanes: no sound choice (no lip sync step, no worker there).
  await cloudSwitch(page).click()
  await expect(cloudSwitch(page)).not.toBeChecked({ timeout: 15_000 })
  await expect(page.locator('[data-sound-controls]')).toHaveCount(0)
  await shoot(page, 'motion-local', undefined, 'desktop-ton')
})
