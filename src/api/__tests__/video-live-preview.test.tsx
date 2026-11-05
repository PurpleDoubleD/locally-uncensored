// @vitest-environment jsdom
/**
 * B28 (3.0.9): Discord .molot, 28.10.2026, "a preview while the video
 * renders, to stop early". ComfyUI can send a picture per sampling step, but
 * it starts with previews off, LU never asked for them, and the desktop's
 * socket proxy dropped every binary frame. Now a video run asks for them in
 * its own prompt (extra_data.preview_method), the frame reaches the page, and
 * the waiting area shows the newest one.
 *
 * Run: npx vitest run src/api/__tests__/video-live-preview.test.tsx
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, cleanup } from '@testing-library/react'

const fetched = vi.hoisted(() => ({ bodies: [] as unknown[] }))
vi.mock('../backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../backend')>()),
  comfyuiUrl: (p: string) => `http://test${p}`,
  localFetch: vi.fn(async (_url: string, init?: { body?: string }) => {
    fetched.bodies.push(init?.body ? JSON.parse(init.body) : null)
    return new Response(JSON.stringify({ prompt_id: 'p-1', node_errors: {} }), { status: 200 })
  }),
}))

const { previewDataUrl } = await import('../comfyui-ws')
const { submitWorkflow } = await import('../comfyui')
const { GeneratingView } = await import('../../components/create/experimental/OutputView')
const { useRenderPreviewStore } = await import('../../stores/renderPreviewStore')

const frame = (event: number, kind: number, image: number[]) => {
  const b = new Uint8Array(8 + image.length)
  const v = new DataView(b.buffer)
  v.setUint32(0, event)
  v.setUint32(4, kind)
  b.set(image, 8)
  return b.buffer
}

describe('the preview frame', () => {
  it('a JPEG or PNG preview becomes a data URL', () => {
    expect(previewDataUrl(frame(1, 1, [0xff, 0xd8, 0xff]))).toBe('data:image/jpeg;base64,/9j/')
    expect(previewDataUrl(frame(1, 2, [0x89, 0x50]))).toMatch(/^data:image\/png;base64,/)
  })
  it('any other binary frame is not a preview', () => {
    expect(previewDataUrl(frame(4, 1, [1, 2]))).toBeNull()
    expect(previewDataUrl(frame(1, 7, [1]))).toBeNull()
    expect(previewDataUrl(new Uint8Array([0, 0, 0, 1]))).toBeNull()
  })
})

describe('the prompt asks ComfyUI for previews', () => {
  beforeEach(() => { fetched.bodies.length = 0 })
  it('with previewMethod the prompt carries extra_data.preview_method', async () => {
    await submitWorkflow({ '1': { class_type: 'SaveImage', inputs: {} } }, 'lu-x', { previewMethod: 'auto' })
    expect(fetched.bodies[0]).toMatchObject({ client_id: 'lu-x', extra_data: { preview_method: 'auto' } })
  })
  it('without it nothing changes for a picture', async () => {
    await submitWorkflow({ '1': { class_type: 'SaveImage', inputs: {} } }, 'lu-x')
    expect(fetched.bodies[0]).not.toHaveProperty('extra_data')
  })
  it('Create asks for it on a video run, follows the previews and drops the last one at the end', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'hooks', 'useCreate.ts'), 'utf8')
    expect(src).toMatch(/const livePreview = mode === 'video'/)
    expect(src).toMatch(/offPreview = comfyWS\.onPreview\(\(url\) => useRenderPreviewStore\.getState\(\)\.setUrl\(url\)\)/)
    expect(src).toMatch(/submitWorkflow\(workflow, CLIENT_ID, livePreview \? \{ previewMethod: 'auto' \} : \{\}\)/)
    expect(src).toMatch(/offPreview\?\.\(\)\n\s+useRenderPreviewStore\.getState\(\)\.setUrl\(null\)/)
  })
  it('the desktop proxy passes preview frames on instead of dropping them', () => {
    const rs = readFileSync(resolve(__dirname, '..', '..', '..', 'src-tauri', 'src', 'commands', 'comfy_ws.rs'), 'utf8')
    expect(rs).toMatch(/Message::Binary\(bytes\)\)\) => \{\n\s+if let Some\(preview\) = preview_payload\(&bytes\)/)
    const ws = readFileSync(resolve(__dirname, '..', 'comfyui-ws.ts'), 'utf8')
    expect(ws).toMatch(/listen<[^>]*>\('comfy-ws-preview'/)
  })
})

describe('the waiting area shows it', () => {
  beforeEach(() => cleanup())
  it('the newest preview, with what it is and what to do', () => {
    useRenderPreviewStore.getState().setUrl('data:image/jpeg;base64,/9j/')
    render(<GeneratingView />)
    const fig = screen.getByTestId('render-live-preview')
    expect(fig.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,/9j/')
    expect(fig.textContent).toContain('Cancel if it is going the wrong way')
  })
  it('nothing while there is none', () => {
    useRenderPreviewStore.getState().setUrl(null)
    render(<GeneratingView />)
    expect(screen.queryByTestId('render-live-preview')).toBeNull()
  })
})
