import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'

/**
 * Swap Character (07.11.2026, port of the web's C52; two steps with SCAIL 2
 * and Kling since 14.11.2026) in the real app, Tauri stubbed, cloud mocked:
 * the pill, the panel in the web's order, the marks on the first frame, the
 * frame step (Build first frame, Does this look right?, Continue), Kling for
 * one person only, and Create only with every input, the consent and the
 * confirmed frame. Nothing is booked: the frame step runs against the mock,
 * and the spec never presses Create.
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
interface Seen { submits: Array<{ model: string; prompt: string; params: Record<string, unknown> }>; uploads: number }

async function openSwap(page: Page): Promise<Seen> {
  await page.setViewportSize({ width: 1296, height: 900 })
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true, extraCatalogModels: SWAP_CATALOG })
  // The frame step against the mock: upload, submit, poll, and the built
  // frame. Registered after routeCloud, so these answer first; anything
  // else falls back to the shared mock.
  const seen: Seen = { submits: [], uploads: 0 }
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
    if (path === '/api/jobs' && req.method() === 'POST') {
      const body = req.postDataJSON() as Seen['submits'][number]
      seen.submits.push(body)
      // Only the frame step may book here; a video run would be a real Create.
      if (body.params?.swap_step !== 'frame') return json({ error: 'e2e: only the frame step is mocked' }, 400)
      return json({ id: `job-frame-${seen.submits.length}`, status: 'queued', created_at: new Date().toISOString(), quota: { kind: 'image', cost: 14000, used: 0, limit: 2_550_000 } }, 202)
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
  await page.getByRole('radio', { name: 'Swap Character', exact: true }).click()
  await expect(page.locator('[data-swap-controls]')).toBeVisible({ timeout: 15_000 })
  return seen
}

async function shoot(page: Page, name: string, focus?: string) {
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
    await page.screenshot({ path: `${dir}/desktop-app-${name}-${theme}.png` })
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

test('Swap Character in two steps: marks, first frame, Continue, Kling for one person', async ({ page }) => {
  const seen = await openSwap(page)
  const panel = page.locator('[data-swap-controls]')
  const create = page.getByRole('button', { name: /^Create/ }).last()

  // SCAIL 2 is the default, the notes stand grey.
  await expect(panel.locator('[data-swap-tips]')).toContainText('Up to 3 people with SCAIL-2, one person with Kling (highest resolution).')
  await expect(panel).toHaveAttribute('data-swap-two-step', 'true')
  await expect(page.getByRole('radio', { name: '720p' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('[data-swap-stage]')).toBeVisible()
  await expect(create).toBeDisabled()
  await shoot(page, 'swap-empty')

  // The original video: the first frame is drawn in the WebView.
  await panel.locator('input[type=file][accept^="video"]').setInputFiles(await media('clip.mp4', 'video/mp4', page))
  await expect(page.getByText('Tap each person you want to replace')).toBeVisible({ timeout: 20_000 })
  // Two people tapped: numbered marks, their place becomes the role.
  await tapFrame(page, 0.45, 0.35)
  await tapFrame(page, 0.68, 0.38)
  await expect(page.getByRole('button', { name: 'Remove mark 2' })).toBeVisible()
  await expect(page.locator('[data-swap-frame-count]')).toHaveText('2 of 4 people marked. Tap a number to remove it.')
  await expect(page.getByRole('textbox', { name: 'Who person 1 replaces' })).toHaveAttribute('placeholder', /^the person on the left/)
  await expect(page.getByRole('textbox', { name: 'Who person 2 replaces' })).toHaveAttribute('placeholder', /^the person on the right/)
  await page.locator('[data-swap-photo-input="1"]').setInputFiles(await media('face1.png', 'image/png'))
  await page.locator('[data-swap-photo-input="2"]').setInputFiles(await media('face2.png', 'image/png'))
  await expect(page.getByRole('button', { name: 'Change photo of person 2' })).toBeVisible()
  // The slider prices frame and video together.
  await expect(page.locator('[data-clip-price]')).toContainText('credits · frame + video')
  await expect(page.locator('[data-clip-split]')).toContainText('First frame 14,000')

  // Kling stands greyed out for two people, SCAIL 2 is recommended.
  await page.getByRole('button', { name: /SCAIL 2/ }).first().click()
  const kling = page.getByRole('option', { name: /Kling 3.0 Pro/ })
  await expect(kling).toBeDisabled()
  await expect(kling).toContainText('one person only')
  await expect(page.getByRole('option', { name: /SCAIL 2/ })).toContainText('Recommended')
  await page.keyboard.press('Escape')
  await expect(kling).toBeHidden()

  // The frame step waits for the tick, Create waits for the frame.
  const build = page.getByRole('button', { name: /Build first frame/ })
  await expect(build).toBeDisabled()
  await shoot(page, 'swap-two-marks')
  await page.getByRole('checkbox').check()
  await expect(build).toBeEnabled()
  await expect(build).toHaveAttribute('title', 'Build first frame · 14,000 credits')
  await expect(create).toBeDisabled()
  await build.click()
  await expect(page.getByText('Does this look right?')).toBeVisible({ timeout: 20_000 })
  expect(seen.submits).toHaveLength(1)
  expect(seen.submits[0].model).toBe('nano-banana-pro-edit')
  expect(seen.submits[0].params).toMatchObject({ op: 'studio', swap_step: 'frame', swap_consent: true, max_credits: 14000 })
  expect(seen.submits[0].params.image_paths).toHaveLength(3)
  expect(seen.submits[0].prompt).toContain('replace the person on the left with the person from the second image and replace the person on the right with the person from the third image')
  await expect(page.getByRole('img', { name: 'New first frame' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Try again · 14k credits/ })).toBeEnabled()
  await expect(page.getByRole('textbox', { name: "What's wrong?" })).toHaveAttribute('placeholder', "What's wrong? (optional)")
  await expect(create).toBeDisabled()
  await shoot(page, 'swap-review', '[data-swap-built]')

  // Continue: now Create is armed, its price names the video.
  await page.getByRole('button', { name: /Continue/ }).click()
  await expect(page.getByText('First frame ready. Create starts the video.')).toBeVisible()
  await expect(create).toBeEnabled({ timeout: 15_000 })
  await shoot(page, 'swap-ready-scail2', '[data-swap-built]')

  // Kling for one person: the second mark goes, the built frame expires.
  await page.getByRole('button', { name: 'Remove mark 2' }).click()
  await expect(page.locator('[data-swap-frame-count]')).toHaveText('1 of 4 people marked. Tap a number to remove it.')
  await expect(create).toBeDisabled()
  await page.getByRole('button', { name: /SCAIL 2/ }).first().click()
  await expect(page.getByRole('option', { name: /Kling 3.0 Pro/ })).toBeEnabled()
  await page.getByRole('option', { name: /Kling 3.0 Pro/ }).click()
  await expect(page.getByRole('radiogroup', { name: 'Resolution' })).toHaveCount(0)
  await expect(page.getByRole('checkbox')).toBeChecked()
  await page.getByRole('button', { name: /Build first frame/ }).click()
  await expect(page.getByText('Does this look right?')).toBeVisible({ timeout: 20_000 })
  expect(seen.submits).toHaveLength(2)
  // One mark left: "the person", one photo.
  expect(seen.submits[1].prompt).toMatch(/^Replace the person in the first image with the person from the second image\./)
  expect(seen.submits[1].params.image_paths).toHaveLength(2)
  await page.getByRole('button', { name: /Continue/ }).click()
  await expect(create).toBeEnabled({ timeout: 15_000 })
  await expect(page.locator('[data-clip-split]')).toContainText('16,800/s')
  await shoot(page, 'swap-kling-one-person', '[data-swap-built]')

  // Nothing but the frame step ever went to the queue.
  expect(seen.submits.every((b) => b.params.swap_step === 'frame')).toBe(true)
})

test('Swap Character with OpenJutsu: one step, people up to four, consent before Create', async ({ page }) => {
  await openSwap(page)
  const panel = page.locator('[data-swap-controls]')
  const create = page.getByRole('button', { name: /^Create/ }).last()
  await page.getByRole('button', { name: /SCAIL 2/ }).first().click()
  await page.getByRole('option', { name: /OpenJutsu/ }).click()
  await expect(panel).not.toHaveAttribute('data-swap-two-step', 'true')

  await page.locator('[data-swap-photo-input="1"]').setInputFiles(await media('face1.png', 'image/png'))
  await page.getByRole('button', { name: /Add person/ }).click()
  await expect(page.getByRole('button', { name: /Add person/ })).toHaveText('+ Add person (2/4)')
  await page.getByRole('checkbox').check()
  await expect(create).toBeDisabled()
  await page.locator('[data-swap-photo-input="2"]').setInputFiles(await media('face2.png', 'image/png'))
  await page.getByRole('textbox', { name: 'Who person 1 replaces' }).fill('the woman on the left')
  await page.getByRole('textbox', { name: 'Who person 2 replaces' }).fill('the woman on the right')
  // Without the video Create stays off.
  await expect(create).toBeDisabled()
  await panel.locator('input[type=file][accept^="video"]').setInputFiles(await media('clip.mp4', 'video/mp4', page))
  // No frame step on OpenJutsu: Create is armed and names its price.
  await expect(page.locator('[data-swap-built]')).toHaveCount(0)
  await expect(create).toBeEnabled({ timeout: 15_000 })
  await expect(page.locator('[data-clip-price]')).toContainText('credits')

  await page.getByRole('button', { name: /Add person/ }).click()
  await page.getByRole('button', { name: /Add person/ }).click()
  await expect(page.getByRole('button', { name: /Add person/ })).toHaveText('+ Add person (4/4)')
  await expect(page.getByRole('button', { name: /Add person/ })).toBeDisabled()
  await expect(create).toBeDisabled()
})
