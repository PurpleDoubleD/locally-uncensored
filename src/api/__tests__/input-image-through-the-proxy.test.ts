/**
 * D4 (Discord 07.11.2026, "i can't edit image, ref2image in qwen image 2.1"):
 * in the agent chat every edit and every start or reference picture ended as
 * "Image generation failed: Failed to fetch". resolveInputImage read the
 * picture from ComfyUI with the browser's own `fetch`, a cross-origin request
 * from the app's window that a ComfyUI without a CORS header for it refuses.
 * It now reads through the app's localhost proxy like every other ComfyUI
 * read, and a missing file is still told apart from an unreachable one.
 *
 * Run: npx vitest run src/api/__tests__/input-image-through-the-proxy.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const io = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  proxied: [] as string[],
  uploads: [] as string[],
}))

vi.mock('../backend', async (orig) => ({
  ...(await orig<typeof import('../backend')>()),
  isTauri: () => true,
  // proxy_localhost_stream: bytes for a file ComfyUI has, "HTTP 404: …" otherwise.
  fetchLocalhostBytes: vi.fn(async (url: string) => {
    io.proxied.push(url)
    const q = new URL(url, 'http://comfy.test').searchParams
    const hit = io.files.get(`${q.get('type')}/${q.get('filename')}`)
    if (!hit) throw new Error('HTTP 404: Not Found')
    return hit
  }),
  backendCall: vi.fn(async (cmd: string, args: { filename?: string }) => {
    if (cmd === 'comfy_upload_image') {
      io.uploads.push(String(args.filename))
      return JSON.stringify({ name: args.filename, subfolder: '', type: 'input' })
    }
    return {}
  }),
}))

import { resolveInputImage } from '../vram-handoff'

const PIXELS = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
let browserFetch: ReturnType<typeof vi.fn>

beforeEach(() => {
  io.files.clear()
  io.proxied = []
  io.uploads = []
  // The browser's fetch is what failed in the app; it must not be asked.
  browserFetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
  vi.stubGlobal('fetch', browserFetch)
})
afterEach(() => vi.unstubAllGlobals())

describe('D4: the input picture of an edit or a start image is read through the proxy', () => {
  it('an earlier result (output folder) is read by the proxy and handed to the input folder', async () => {
    io.files.set('output/ComfyUI_00012_.png', PIXELS)
    const out = await resolveInputImage('/comfyui/view?filename=ComfyUI_00012_.png&subfolder=&type=output')
    expect(out.name).toBe('ComfyUI_00012_.png')
    expect(io.proxied[0]).toContain('filename=ComfyUI_00012_.png')
    expect(io.uploads).toEqual(['ComfyUI_00012_.png'])
    expect(browserFetch).not.toHaveBeenCalled()
  })

  it('a staged chat attachment (input folder) is found after the 404 in the output folder', async () => {
    io.files.set('input/lu-chat-1xc1.png', PIXELS)
    const out = await resolveInputImage('lu-chat-1xc1.png')
    expect(out.name).toBe('lu-chat-1xc1.png')
    expect(io.proxied.map((u) => new URL(u, 'http://x').searchParams.get('type'))).toEqual(['output', 'input'])
    expect(io.uploads).toEqual([])
    expect(browserFetch).not.toHaveBeenCalled()
  })

  it('a name in neither folder still says so, not "Failed to fetch"', async () => {
    await expect(resolveInputImage('image.png')).rejects.toThrow(/no file of that name in ComfyUI's output or input folder/)
    expect(browserFetch).not.toHaveBeenCalled()
  })

  it('an unreachable ComfyUI names the cause of the proxy', async () => {
    const { fetchLocalhostBytes } = await import('../backend')
    vi.mocked(fetchLocalhostBytes).mockRejectedValueOnce(new Error('proxy_localhost_stream: connection refused'))
    await expect(resolveInputImage('/comfyui/view?filename=a.png&type=output')).rejects.toThrow(/from ComfyUI: proxy_localhost_stream: connection refused/)
  })
})
