import { describe, it, expect, vi, beforeEach } from 'vitest'

const backendCall = vi.fn()
const fetchComfyImageBase64 = vi.fn()
vi.mock('../../api/backend', () => ({ backendCall: (...a: unknown[]) => backendCall(...a) }))
vi.mock('../../api/comfyui', () => ({ fetchComfyImageBase64: (...a: unknown[]) => fetchComfyImageBase64(...a) }))

import { generatedOk, readResultPicture, resultUrl } from '../chat-background'

describe('reading the image_generate result for a scene background', () => {
  it('finds the address on the last line', () => {
    const r = 'Image generated: LU_00012_.png (prompt: "harbour at dusk")\nhttp://127.0.0.1:8188/view?filename=LU_00012_.png&type=output'
    expect(resultUrl(r)).toBe('http://127.0.0.1:8188/view?filename=LU_00012_.png&type=output')
    expect(generatedOk(r)).toBe(true)
  })
  // Found in the real render against a test ComfyUI (10.11.2026): in a browser
  // the address is the dev proxy's relative one, and the picture was made but
  // the panel called it a failure.
  it('takes the relative /comfyui/view address of the browser build', () => {
    const r = 'Image generated: wide_background_00001_.png (prompt: "x")\n/comfyui/view?filename=wide_background_00001_.png&subfolder=&type=output'
    expect(generatedOk(r)).toBe(true)
  })
  it('takes the file a Mac render wrote', () => {
    expect(generatedOk('Image generated: mlx-1.png (prompt: "x")\nfile:///Users/a/Pictures/mlx-1.png')).toBe(true)
  })
  it('a prompt that quotes an address is not the result', () => {
    expect(generatedOk('Image generated: a.png (prompt: "like http://localhost:8188/view?filename=x.png")')).toBe(false)
  })
  it.each([
    'Error: No local image model is installed yet.',
    'Cannot generate: width must be a number from 64 to 4096 pixels',
    'Image generation cancelled.',
    'Image generated: but no address',
    'Image generated: clip.mp4 (prompt: "x")\ndata:video/mp4;base64,AAAA',
  ])('refuses %s', (r) => expect(generatedOk(r)).toBe(false))
})

describe('reading the picture behind the address', () => {
  beforeEach(() => { backendCall.mockReset(); fetchComfyImageBase64.mockReset() })
  it('a Mac file is read through read_media_file', async () => {
    backendCall.mockResolvedValue('QUJD')
    expect(await readResultPicture('file:///Users/a/My%20Pictures/mlx-1.png')).toBe('QUJD')
    expect(backendCall).toHaveBeenCalledWith('read_media_file', { path: '/Users/a/My Pictures/mlx-1.png' })
    expect(fetchComfyImageBase64).not.toHaveBeenCalled()
  })
  it('a ComfyUI address is fetched from ComfyUI', async () => {
    fetchComfyImageBase64.mockResolvedValue('REVG')
    expect(await readResultPicture('/comfyui/view?filename=a.png&type=output')).toBe('REVG')
    expect(backendCall).not.toHaveBeenCalled()
  })
})
