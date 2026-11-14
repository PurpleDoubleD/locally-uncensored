import { test, expect, type Page, type Route } from '@playwright/test'
import { readFileSync } from 'fs'
import { Rec, HOWTO_OUT } from './rec'
import { publicCatalog, publicQuota, ASSETS } from './public-catalog'
import { cloudSwitch } from '../support/cloud-mock'

// How 3D works (3.1.0), two films: "3d" (making a model) and "3d-view"
// (the result). Recorded on claude/c3d-film (f127f24bf). Facts, all
// from that head:
//  - lib/three/three-d-text.ts: the ways "From text", "From image", "From
//    video", "Detail" with Draft, Standard, Fine, "Cut out the background",
//    "Drop a picture of one object".
//  - lib/three/three-d-models.ts threeDControlFacts: in the cloud the model
//    cuts out the object itself (no switch); the local lane has LU's own
//    cutout switch and a detail step.
//  - components/three/ModelViewer.tsx: the 3D view turns by itself until it is
//    touched ("Drag to turn. Scroll to zoom."), Color, Clay, Wireframe, and the
//    Download menu (GLB, OBJ, STL, USDZ) with the Blender entries
//    (api/blender.ts blenderMenu: Open in Blender, Save as .blend, FBX) when a
//    Blender is found.
//  - components/create/experimental/CreatePanel.tsx: a 3D result is a gallery
//    tile with a still of the model (ModelThumb, mesh-poster.ts).
//  - components/create/experimental/ThreeDStage.tsx: "Local 3D is never
//    filtered" (setup card); the local lane runs on this computer.
//
// Fixtures (nothing on the page is altered):
//  1. Catalog: the public price list (public-catalog.ts) plus one 3D model,
//     TRELLIS.2, shaped like the server's entry (studio, quote_required, the
//     way e2e/create-3d-picture-first.spec.ts sends it). The app prices it from
//     its own registry; no picker is opened and no price is on screen. The
//     balance is the Hosted plan's public monthly credits.
//  2. The cloud run: /api/jobs/upload keeps the picture, POST /api/jobs books
//     job-3d-1, which has succeeded at the first look and serves chair.glb.
//     chair.glb is a real TRELLIS.2 result of chair.png from the C3D cloud
//     test (LU-3D-test/cloud/trellis-2-512.glb); chair.png is a plain render
//     of a chair (LU-3D-test/inputs/chair-front.png). Not real: no run here.
//  3. initScript: blender_status answers "Blender 4.5.3 found", so the menu
//     carries the Blender entries as on a machine that has it; no Blender
//     command is called. mlx_mesh3d_status answers "installed", so the local
//     lane shows its controls instead of the one-time setup card. Platform
//     'mac' (the Mac lane; the Windows lane has the same switch and steps).
test.use({ viewport: { width: 1200, height: 1020 }, deviceScaleFactor: 2 })

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' }
const TRELLIS = { id: 'trellis-2', label: 'TRELLIS.2', kind: '3d', ops: ['studio'], quote_required: true, tier: 'best', weights: 'open', mesh: 'image' }

async function fixtures(page: Page, a: string) {
  const glb = readFileSync(`${a}/chair.glb`)
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route('https://lu-labs.ai/**', async (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const path = new URL(req.url()).pathname
    if (path === '/api/jobs/catalog') {
      const cat = publicCatalog()
      return json(route, 200, { ...cat, models: [...cat.models, TRELLIS] })
    }
    if (path === '/api/jobs/quota') return json(route, 200, publicQuota())
    if (path === '/api/loras') return json(route, 200, { loras: [] })
    if (path === '/api/jobs/studio-quote') return json(route, 200, { credits: 20000 })
    if (path === '/api/jobs/upload') return json(route, 200, { path: 'e2e-user-1/chair.png' })
    if (path === '/api/jobs' && req.method() === 'POST') {
      return json(route, 202, { id: 'job-3d-1', status: 'queued', created_at: new Date().toISOString(), quota: { kind: '3d', cost: 0 } })
    }
    if (path === '/api/jobs/job-3d-1') {
      const now = new Date().toISOString()
      return json(route, 200, { job: { id: 'job-3d-1', kind: '3d', model: 'trellis-2', provider: 'upstream', status: 'succeeded', result_url: 'https://lu-labs.ai/e2e/chair.glb', attestation: null, cost_units: 0, created_at: now, completed_at: now, error: null } })
    }
    if (path === '/e2e/chair.glb') return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'model/gltf-binary' }, body: glb })
    return route.fallback()
  })
}

async function boot(page: Page, id: string, title: string): Promise<{ rec: Rec; a: string }> {
  const a = ASSETS('3d')
  const rec = await Rec.boot(page, id, title, {
    scenario: { tier: 'hosted' },
    tauri: { platform: 'mac' },
    fixtures: (p) => fixtures(p, a),
    initScript: () => {
      // Fixture 3.
      const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } }
      const bridge = w.__TAURI_INTERNALS__
      const invoke = bridge.invoke
      bridge.invoke = (command, args) => {
        if (command === 'blender_status') return Promise.resolve({ found: true, version: '4.5.3', tooOld: false })
        if (command === 'mlx_mesh3d_status') return Promise.resolve({ installed: true, running: false, models: [] })
        return invoke(command, args)
      }
    },
  })
  await rec.openCreate('3D Model')
  await expect(page.getByRole('radio', { name: 'From image', exact: true })).toBeVisible()
  return { rec, a }
}

const putChair = async (page: Page, a: string) => {
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'chair.png', mimeType: 'image/png', buffer: readFileSync(`${a}/chair.png`) })
  await expect(page.getByAltText('source')).toBeVisible()
}

// Film 1: how a model is made (the ways, Detail, the local lane with Cutout).
test('3d', async ({ page }) => {
  test.skip(!HOWTO_OUT, 'set LU_HOWTO_OUT')
  test.setTimeout(240_000)
  const { rec, a } = await boot(page, '3d', 'How 3D works')
  const way = (name: string) => page.getByRole('radio', { name, exact: true })
  await page.mouse.move(1000, 640)

  await rec.key()
  rec.hold(0.3)
  rec.scene('3D makes a model of one object, from a description, a picture or a short video.')
  await rec.cam(way('From image'), 1.45)
  await rec.click(way('From text'), { dur: 0.7, after: 0.5 })
  await rec.click(way('From video'), { dur: 0.5, after: 0.5 })
  await rec.click(way('From image'), { dur: 0.45, after: 0.1 })
  await rec.cam('full', 1, 0.8)
  await rec.move(page.getByText('Drop a picture of one object'), { dur: 0.7 })
  await putChair(page, a)
  rec.t += 0.1
  await rec.key(900)
  rec.hold(0.7)

  rec.scene('Detail sets how fine the model is: Draft, Standard or Fine.')
  const detail = page.getByRole('radiogroup', { name: 'Detail' })
  await rec.cam(detail, 1.6)
  await rec.move(detail.getByRole('radio', { name: 'Draft' }), { dur: 0.7 })
  rec.hold(0.3)
  await rec.move(detail.getByRole('radio', { name: 'Fine' }), { dur: 0.6 })
  rec.hold(0.7)

  rec.scene('Switch to Local and it runs on this computer, where Cutout can clear the background first.')
  const sw = cloudSwitch(page)
  await rec.cam(sw, 1.4)
  await rec.click(sw, { dur: 0.8, settle: 1200, after: 0.3, until: () => expect(sw).not.toBeChecked() })
  const cut = page.getByTestId('three-d-cutout')
  await expect(cut).toBeVisible({ timeout: 15_000 })
  await rec.cam(cut, 1.5)
  await rec.move(cut, { dur: 0.8, at: { dx: 60 } })
  rec.hold(1.4)
  await rec.cam('full', 1, 0.9)
  rec.finish(1.2)
})

// Film 2: the result (the 3D view, its looks, the downloads, the gallery).
test('3d-view', async ({ page }) => {
  test.skip(!HOWTO_OUT, 'set LU_HOWTO_OUT')
  test.setTimeout(240_000)
  const { rec, a } = await boot(page, '3d-view', 'How 3D works')
  await putChair(page, a)
  await page.mouse.move(1000, 640)
  await rec.key(900)
  rec.hold(0.3)

  rec.scene('The model opens in a 3D view. Drag to turn it, scroll to zoom.')
  const create = page.getByRole('button', { name: /^Create$/ }).last()
  const viewer = page.getByTestId('model-viewer').first()
  await rec.click(create, {
    dur: 0.8, settle: 2500, after: 0.2,
    until: () => expect(viewer).toHaveAttribute('data-phase', 'ready', { timeout: 60_000 }),
  })
  const canvas = page.getByTestId('model-viewer-canvas').first()
  await rec.cam(canvas, 1.25)
  const box = (await canvas.boundingBox())!
  const cx = box.x + box.width / 2, cy = box.y + box.height * 0.55
  const path = Array.from({ length: 16 }, (_, i) => ({ x: Math.round(cx - 110 + i * 15), y: Math.round(cy + Math.sin(i / 5) * 8) }))
  await rec.drag(path, { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) }, { stepDur: 0.08 })
  rec.hold(0.3)

  rec.scene('Color, Clay and Wireframe show its surface, its bare shape and its mesh.')
  await rec.cam(page.getByTestId('mv-look-clay').first(), 1.45)
  await rec.click(page.getByTestId('mv-look-clay').first(), { dur: 0.6, settle: 600, after: 0.7 })
  await rec.click(page.getByTestId('mv-look-wireframe').first(), { dur: 0.45, settle: 600, after: 0.1 })
  // Scroll to zoom: the real wheel, then the closer view.
  await rec.cam({ x: Math.round(cx), y: Math.round(cy - 60) }, 1.5)
  await rec.move({ x: Math.round(cx), y: Math.round(cy - 60) }, { dur: 0.5 })
  for (let i = 0; i < 18; i++) { await page.mouse.wheel(0, -200); await page.waitForTimeout(100) }
  await rec.key(1200)
  rec.hold(1.0)
  await rec.cam(page.getByTestId('mv-look-clay').first(), 1.45)
  await rec.click(page.getByTestId('mv-look-color').first(), { dur: 0.6, settle: 600, after: 0.1 })
  // Back to the whole model: the view's own Reset button.
  await rec.click(page.getByTestId('mv-reset').first(), { dur: 0.4, settle: 1200, after: 0.2 })

  rec.scene('Download it as GLB, OBJ, STL or USDZ, or hand it straight to Blender.')
  const dl = page.getByTestId('mv-download').first()
  await rec.click(dl, { dur: 0.6, settle: 700, after: 0.4 })
  await expect(page.getByTestId('mv-blender-open')).toBeVisible()
  await rec.cam(page.getByTestId('mv-save-usdz'), 1.4)
  await rec.move(page.getByTestId('mv-save-stl'), { dur: 0.6 })
  rec.hold(0.4)
  await rec.move(page.getByTestId('mv-blender-open'), { dur: 0.6 })
  await rec.key(400)
  rec.hold(1.0)
  await rec.click(dl, { dur: 0.5, settle: 500, after: 0.1 })
  await rec.cam('full', 1, 0.8)

  rec.scene('Every model also lands in your gallery, shown as a still of itself.')
  await rec.click(page.getByRole('button', { name: 'Open the gallery' }), { dur: 0.7, settle: 1500, after: 0.4 })
  const tile = page.getByTestId('thumb-3d').first()
  if (await tile.isVisible().catch(() => false)) {
    await rec.cam(tile, 1.5)
    await rec.move(tile, { dur: 0.7 })
  }
  rec.hold(1.0)
  await rec.cam('full', 1, 0.9)
  rec.finish(1.0)
})
