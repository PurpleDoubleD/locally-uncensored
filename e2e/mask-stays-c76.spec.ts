import { test, expect, type Page } from '@playwright/test'
import { deflateSync } from 'node:zlib'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, cloudSwitch } from './support/cloud-mock'
import { mlxCalls } from './support/recorded'

/**
 * C76 (Discord help-chat, 11.11.2026): the mask of the Edit tab was gone when
 * the mask editor was opened again, and the preview showed only the words
 * "mask painted". The editor built an empty engine every time, and Apply on
 * that empty canvas threw the painted mask away.
 *
 * Here, in the real app with the Tauri bridge stubbed (Mac, Qwen-Image 2.1
 * edit): paint the left half, apply, see it on the preview, open the editor
 * again and find it there, apply again, Create, and read the mask the run
 * stages for mflux: white on the left, black on the right.
 */

const QWEN_MAC: TauriMockOptions = {
  assistantReply: DEFAULT_ASSISTANT_REPLY,
  modelName: DEFAULT_MODEL_NAME,
  platform: 'mac',
  mlx: { installedImages: ['sd-turbo', 'qwen-image-2.1-8bit'], mfluxEngineInstalled: true },
}

/** A grey PNG of `w` x `h`, RGB, no filter. */
function greyPng(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Buffer) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const rows = Buffer.alloc((w * 3 + 1) * h, 0x80)
  for (let y = 0; y < h; y++) rows[y * (w * 3 + 1)] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const SIDE = 256

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, QWEN_MAC)
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()
  await page.getByRole('radio', { name: 'Edit / Image to Image', exact: true }).click()
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'grey.png', mimeType: 'image/png', buffer: greyPng(SIDE, SIDE) })
  await expect(page.getByRole('img', { name: 'source' })).toBeVisible({ timeout: 15_000 })
}

/** Share of painted pixels in the editor's red layer, left and right half. */
async function editorPaint(page: Page): Promise<{ left: number; right: number }> {
  return page.evaluate((side) => {
    const layer = document.querySelectorAll<HTMLCanvasElement>('[role="dialog"] canvas')[1]
    const { data } = layer.getContext('2d')!.getImageData(0, 0, side, side)
    let left = 0, right = 0
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      if (data[(y * side + x) * 4 + 3] > 0) { if (x < side / 2) left++; else right++ }
    }
    const half = (side * side) / 2
    return { left: left / half, right: right / half }
  }, SIDE)
}

/** Paint the left half with a few strokes, in screen coordinates of the canvas. */
async function paintLeftHalf(page: Page) {
  const box = (await page.locator('[role="dialog"] canvas').first().boundingBox())!
  for (let row = 0; row < 8; row++) {
    const y = box.y + ((row + 0.5) / 8) * box.height
    await page.mouse.move(box.x + box.width * 0.05, y)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.4, y, { steps: 6 })
    await page.mouse.up()
  }
}

test('C76: a painted mask stays when the editor opens again, shows on the preview and reaches the edit', async ({ page }) => {
  await boot(page)
  const shots = process.env.LU_SHOTS

  await page.getByRole('button', { name: /Paint mask/ }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await paintLeftHalf(page)
  const painted = await editorPaint(page)
  expect(painted.left).toBeGreaterThan(0.3)
  expect(painted.right).toBe(0)
  await page.getByRole('button', { name: 'Apply mask' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // The preview shows the mask itself, on the picture.
  const overlay = page.getByTestId('source-mask-overlay')
  await expect(overlay).toBeVisible({ timeout: 5_000 })
  const [src, img] = [await overlay.boundingBox(), await page.getByRole('img', { name: 'source' }).boundingBox()]
  expect(src && img && Math.abs(src.x - img.x) < 1 && Math.abs(src.y - img.y) < 1 && Math.abs(src.width - img.width) < 1).toBe(true)
  if (shots) await page.screenshot({ path: `${shots}/c76-vorschau-mit-maske.png` })

  // Open again: the mask is where the editor starts.
  await page.getByRole('button', { name: /Edit mask/ }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect.poll(async () => (await editorPaint(page)).left, { timeout: 5_000 }).toBeGreaterThan(0.3)
  const again = await editorPaint(page)
  expect(Math.abs(again.left - painted.left)).toBeLessThan(0.02)
  expect(again.right).toBe(0)
  if (shots) { await page.waitForTimeout(500); await page.screenshot({ path: `${shots}/c76-editor-wieder-offen.png` }) }
  // Apply without a stroke keeps it (it used to clear the mask here).
  await page.getByRole('button', { name: 'Apply mask' }).click()
  await expect(page.getByTestId('source-mask-overlay')).toBeVisible()

  // The edit: the mask staged for mflux is white on the left, black on the right.
  await page.locator('textarea').first().fill('make the left half blue')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(async () => (await mlxCalls(page)).filter((c) => c.cmd === 'mlx_generate').length, { timeout: 30_000 }).toBe(1)
  const calls = await mlxCalls(page)
  const gen = calls.find((c) => c.cmd === 'mlx_generate')!
  expect(gen.raw.mask).toBe('/tmp/lu-e2e/videos/start-images/e2e-start.png')
  // Staged first the picture, then the mask.
  const staged = calls.filter((c) => c.cmd === 'video_stage_start_image')
  expect(staged).toHaveLength(2)
  const maskB64 = String(staged[1].raw.data)
  const halves = await page.evaluate(async ({ b64, side }) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = side; c.height = side
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0, side, side)
    const { data } = ctx.getImageData(0, 0, side, side)
    let left = 0, right = 0
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      const v = data[(y * side + x) * 4]
      if (x < side / 2) left += v; else right += v
    }
    const half = (side * side) / 2
    return { size: [img.naturalWidth, img.naturalHeight], left: left / half / 255, right: right / half / 255 }
  }, { b64: maskB64, side: SIDE })
  expect(halves.size).toEqual([SIDE, SIDE])
  expect(halves.left).toBeGreaterThan(0.3)
  // The feather softens the edge a little into the right half, no more.
  expect(halves.right).toBeLessThan(0.05)
})
