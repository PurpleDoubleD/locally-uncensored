import { test, expect, type Page, type Route } from '@playwright/test'
import { deflateSync } from 'node:zlib'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'

/**
 * 3D from words in the cloud, "Picture first" (3.1.0): the picker offers it
 * first on the Text way with the price of picture plus model, the run books
 * a picture on the open image model, shows it on the Stage, has the server
 * copy it (adopt) and builds the model from it. Nothing leaves this machine:
 * every cloud call is answered here.
 */

const WINDOWS_OPTS: TauriMockOptions = { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' }
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' }

/** A plain 256 px picture: a light ground with a dark square, so the Stage shows something. */
function picturePng(): Buffer {
  const n = 256
  const raw = Buffer.alloc((n * 3 + 1) * n)
  for (let y = 0; y < n; y++) {
    raw[y * (n * 3 + 1)] = 0
    for (let x = 0; x < n; x++) {
      const inside = x > 80 && x < 176 && y > 80 && y < 176
      const o = y * (n * 3 + 1) + 1 + x * 3
      raw[o] = inside ? 120 : 235; raw[o + 1] = inside ? 90 : 235; raw[o + 2] = inside ? 60 : 230
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, k) => { let c = k; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const PICTURE = picturePng()

/** One triangle as a GLB, the smallest model the viewer opens. */
function triangleGlb(): Buffer {
  const bin = Buffer.alloc(36)
  ;[0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => bin.writeFloatLE(v, i * 4))
  const gltf = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }], scene: 0, nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
  }
  let json = Buffer.from(JSON.stringify(gltf))
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)])
  const head = Buffer.alloc(12)
  head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8)
  const chunk = (b: Buffer, type: number) => { const h = Buffer.alloc(8); h.writeUInt32LE(b.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, b]) }
  return Buffer.concat([head, chunk(json, 0x4e4f534a), chunk(bin, 0x004e4942)])
}

interface Seen { submits: { kind: string; model: string; prompt: string; params: Record<string, unknown> }[]; adopted: string[] }

async function routePictureFirst(page: Page, meshStatus: 'succeeded' | 'failed'): Promise<Seen> {
  const seen: Seen = { submits: [], adopted: [] }
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const job = (id: string, kind: string, model: string, status: string, url: string | null) => ({
    job: { id, kind, model, provider: 'upstream', status, result_url: url, attestation: null, cost_units: 0, created_at: new Date().toISOString(), completed_at: new Date().toISOString(), error: status === 'failed' ? 'The provider could not build this one.' : null },
  })
  await page.route('https://lu-labs.ai/**', async (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fallback()
    const path = new URL(req.url()).pathname
    if (path === '/api/jobs/studio-quote') {
      const body = req.postDataJSON() as { model: string }
      return json(route, 200, { credits: body.model === 'z-image' ? 1000 : 20000 })
    }
    if (path === '/api/jobs' && req.method() === 'POST') {
      const body = req.postDataJSON() as Seen['submits'][number]
      seen.submits.push(body)
      return json(route, 202, { id: body.kind === 'image' ? 'job-pic-1' : 'job-mesh-1', status: 'queued', created_at: new Date().toISOString(), quota: { kind: body.kind, cost: 0 } })
    }
    if (path === '/api/jobs/adopt') {
      seen.adopted.push((req.postDataJSON() as { job_id: string }).job_id)
      return json(route, 201, { path: 'e2e-user-1/job-job-pic-1-copy.png', role: 'image', contentType: 'image/png' })
    }
    if (path === '/api/jobs/job-pic-1') return json(route, 200, job('job-pic-1', 'image', 'z-image', 'succeeded', 'https://lu-labs.ai/e2e/picture.png'))
    if (path === '/api/jobs/job-mesh-1') return json(route, 200, job('job-mesh-1', '3d', 'trellis-2', meshStatus, meshStatus === 'succeeded' ? 'https://lu-labs.ai/e2e/model.glb' : null))
    if (path === '/e2e/picture.png') return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'image/png' }, body: PICTURE })
    if (path === '/e2e/model.glb') return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'model/gltf-binary' }, body: triangleGlb() })
    return route.fallback()
  })
  return seen
}

async function bootInto3dText(page: Page, meshStatus: 'succeeded' | 'failed' = 'succeeded'): Promise<Seen> {
  await page.addInitScript(tauriMockInit, WINDOWS_OPTS)
  await seedOnboardingDone(page)
  await routeCloud(page, {
    license: 'active', access: true, mediaLive: true,
    extraCatalogModels: [
      { id: 'z-image', label: 'Z-Image Base', kind: 'image', adult: true, ops: ['studio'], quote_required: true, tier: 'best', weights: 'open' },
      { id: 'trellis-2', label: 'TRELLIS.2', kind: '3d', ops: ['studio'], quote_required: true, tier: 'best', weights: 'open', mesh: 'image' },
      { id: 'hunyuan-3d-3.1-text', label: 'Hunyuan3D 3.1 Rapid', kind: '3d', ops: ['studio'], quote_required: true, tier: 'standard', weights: 'open-family', mesh: 'text' },
    ],
  })
  const seen = await routePictureFirst(page, meshStatus)
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()
  await page.getByRole('radio', { name: /3D/ }).first().click()
  await page.getByRole('radio', { name: 'From text' }).click()
  return seen
}

test('Picture first is the default on the Text way, priced as picture plus model', async ({ page }) => {
  await bootInto3dText(page)
  await expect(page.getByTestId('three-d-picture-first')).toHaveText('LU paints a picture first, then builds the model from it.')
  await page.screenshot({ path: test.info().outputPath('picture-first-ready.png') })
  const chip = page.locator('button[aria-haspopup="listbox"]').last()
  await expect(chip).toContainText('Picture first')
  await chip.click()
  await expect(page.getByRole('option', { name: /Picture first/ })).toContainText('21k cr')
  await expect(page.getByRole('option', { name: /Hunyuan3D/ })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('picture-first-picker.png') })
})

test('the run paints, shows the picture, and builds the model from it', async ({ page }) => {
  const seen = await bootInto3dText(page)
  await page.locator('textarea').first().fill('classical marble statue of an athlete')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(() => seen.submits.length, { timeout: 30_000 }).toBe(2)
  expect(seen.submits.map((s) => [s.kind, s.model])).toEqual([['image', 'z-image'], ['3d', 'trellis-2']])
  expect(seen.submits[0].prompt).toContain('a single object, whole and centered')
  expect(seen.submits[0].params).toMatchObject({ op: 'studio', max_credits: 1000 })
  expect(seen.adopted).toEqual(['job-pic-1'])
  expect(seen.submits[1].params).toMatchObject({ op: 'studio', max_credits: 20000, source_path: 'e2e-user-1/job-job-pic-1-copy.png' })
  expect(String(seen.submits[1].params.source_prompt)).toContain('classical marble statue of an athlete')
  // The picture stands on the Stage under "From image".
  await expect(page.getByRole('radio', { name: 'From image' })).toBeChecked({ timeout: 15_000 })
  await page.screenshot({ path: test.info().outputPath('picture-first-done.png') })
})

test('a failed model keeps the picture and says so', async ({ page }) => {
  const seen = await bootInto3dText(page, 'failed')
  await page.locator('textarea').first().fill('a clay teapot with a bamboo handle')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect(page.getByText(/Your picture is in the gallery and on the Stage/)).toBeVisible({ timeout: 30_000 })
  expect(seen.submits).toHaveLength(2)
  // On the Stage, and one entry in the gallery.
  await expect(page.getByRole('img', { name: 'source' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open the gallery' })).toContainText('1')
  await expect(page.getByRole('radio', { name: 'From image' })).toBeChecked()
  await page.screenshot({ path: test.info().outputPath('picture-first-failed.png') })
})
