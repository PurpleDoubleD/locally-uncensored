import { describe, it, expect, vi, beforeEach } from 'vitest'

// Vision feedback: after image_generate, hand the still to a vision model so it
// SEES the result. Live 2026-06-22 (gemma4 + Wan T2V): a video_generate whose
// output is an animated .webp slipped past urlIsVideo's mp4/webm-only check and
// got fed to Ollama as an image → HTTP 400 "Failed to load image or audio file".
// Fix: only image_generate produces a feedable still — video_generate always
// no-ops, regardless of output container (mp4 / webm / animated webp / gif).
//
// 2026-06-22 (konata): the loop was Ollama-only, so a non-Ollama vision model
// never received the image and described from the prompt (hallucination). Now
// provider-aware: Ollama uses modelSupportsVision (/api/show); other providers
// use the STRICT model-name family match (modelNameSuggestsVision) so a
// text-only LM Studio model is never sent an image (which would SSE-error).

const { modelSupportsVision, fetchComfyImageBase64 } = vi.hoisted(() => ({
  modelSupportsVision: vi.fn(),
  fetchComfyImageBase64: vi.fn(),
}))

vi.mock('../ollama', () => ({ modelSupportsVision: (...a: unknown[]) => modelSupportsVision(...a) }))
vi.mock('../comfyui', () => ({ fetchComfyImageBase64: (...a: unknown[]) => fetchComfyImageBase64(...a) }))
vi.mock('../../lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
// NOTE: ../../lib/model-compatibility is intentionally NOT mocked — the
// non-Ollama tests exercise the real modelNameSuggestsVision family match.

import { buildVisionFeedback } from '../vision-feedback'

const VIEW = (fn: string) => `http://127.0.0.1:8188/view?filename=${fn}&type=output`

beforeEach(() => {
  modelSupportsVision.mockReset()
  fetchComfyImageBase64.mockReset()
  modelSupportsVision.mockResolvedValue(true)
  fetchComfyImageBase64.mockResolvedValue('BASE64DATA')
})

describe('buildVisionFeedback — video_generate never feeds the model an image', () => {
  it('video_generate with an animated .webp output → null (the live bug: webp slipped past urlIsVideo)', async () => {
    const result = `Video generated: ocean_waves_vid_00001_.webp (prompt: "waves")\n${VIEW('ocean_waves_vid_00001_.webp')}`
    expect(await buildVisionFeedback('gemma4:e4b', 'video_generate', result, 'ollama')).toBeNull()
    // must NOT even fetch the file — bails on the tool name, before any image work
    expect(fetchComfyImageBase64).not.toHaveBeenCalled()
  })

  it('video_generate with .gif output → null', async () => {
    const result = `Video generated: clip.gif (prompt: "x")\n${VIEW('clip.gif')}`
    expect(await buildVisionFeedback('gemma4:e4b', 'video_generate', result, 'ollama')).toBeNull()
  })

  it('video_generate with .mp4 output → null', async () => {
    const result = `Video generated: clip.mp4 (prompt: "x")\n${VIEW('clip.mp4')}`
    expect(await buildVisionFeedback('gemma4:e4b', 'video_generate', result, 'ollama')).toBeNull()
  })
})

describe('buildVisionFeedback — image_generate feeds a still to a vision model (Ollama)', () => {
  it('image_generate .png on a vision model → returns a vf message carrying the image', async () => {
    const result = `Image generated: cat.png (prompt: "a cat")\n${VIEW('cat.png')}`
    const vf = await buildVisionFeedback('gemma4:e4b', 'image_generate', result, 'ollama')
    expect(vf).not.toBeNull()
    expect(vf!.role).toBe('user')
    expect(vf!.images[0].data).toBe('BASE64DATA')
    expect(vf!.content).toMatch(/describe/i)
  })

  it('image_generate .webp STILL is still fed (webp is a valid still image — do not over-block)', async () => {
    const result = `Image generated: art.webp (prompt: "art")\n${VIEW('art.webp')}`
    expect(await buildVisionFeedback('gemma4:e4b', 'image_generate', result, 'ollama')).not.toBeNull()
  })

  it('text-only Ollama model → null (no useless base64 blob)', async () => {
    modelSupportsVision.mockResolvedValue(false)
    const result = `Image generated: cat.png (prompt: "x")\n${VIEW('cat.png')}`
    expect(await buildVisionFeedback('qwen2.5-coder:14b', 'image_generate', result, 'ollama')).toBeNull()
  })

  it('non-generation tool → null', async () => {
    expect(await buildVisionFeedback('gemma4:e4b', 'web_search', 'some search text', 'ollama')).toBeNull()
  })

  it('no ComfyUI /view url in the result → null', async () => {
    expect(await buildVisionFeedback('gemma4:e4b', 'image_generate', 'Image generated: x.png (no url here)', 'ollama')).toBeNull()
  })
})

describe('buildVisionFeedback — provider-aware: non-Ollama uses the strict name check (konata)', () => {
  it('non-Ollama VISION model (llava on an openai-compatible endpoint) → feeds the image', async () => {
    const result = `Image generated: frog.png (prompt: "a frog")\n${VIEW('frog.png')}`
    const vf = await buildVisionFeedback('openai::llava-v1.6-mistral-7b', 'image_generate', result, 'openai')
    expect(vf).not.toBeNull()
    expect(vf!.images[0].data).toBe('BASE64DATA')
    // never calls the Ollama-only /api/show capability probe for a non-Ollama model
    expect(modelSupportsVision).not.toHaveBeenCalled()
  })

  it('non-Ollama VISION model with provider:: prefix (gemma) → feeds (prefix stripped before family match)', async () => {
    const result = `Image generated: bird.png (prompt: "a bird")\n${VIEW('bird.png')}`
    expect(await buildVisionFeedback('lmstudio::gemma-3-12b-it', 'image_generate', result, 'lmstudio')).not.toBeNull()
  })

  it('non-Ollama TEXT model (mistral-7b) → null — NOT fed an image (avoids the image→text SSE error)', async () => {
    const result = `Image generated: cat.png (prompt: "x")\n${VIEW('cat.png')}`
    expect(await buildVisionFeedback('openai::mistral-7b-instruct', 'image_generate', result, 'openai')).toBeNull()
    expect(fetchComfyImageBase64).not.toHaveBeenCalled()
  })

  it('non-Ollama path ignores the Ollama capability probe even when it would say yes', async () => {
    // modelSupportsVision defaults to true in beforeEach; a non-Ollama text
    // model must STILL be null because the non-Ollama branch never consults it.
    const result = `Image generated: x.png (prompt: "x")\n${VIEW('x.png')}`
    expect(await buildVisionFeedback('openai::some-unknown-text-llm', 'image_generate', result, 'openai')).toBeNull()
  })
})

/**
 * Runde 4, Nebenbefund N3 of the D1 counter-check (Windows build 2026-08-29):
 * every successful picture was followed by a red "This model can't read
 * images" line, because the built-in engine ran a text-only conversion of a
 * vision family (gemma-3-4b-it-abliterated, no projector on disk) and the
 * name heuristic called it vision-capable.
 *
 * The app knows the truth: the built-in engine reports whether the projector
 * sits next to the GGUF, the same file it passes as --mmproj. That answer is
 * handed in as `declaredVision` and beats the heuristic in both directions.
 */
describe('buildVisionFeedback, a declared capability beats the name', () => {
  const RESULT = `Image generated: cat.png (prompt: "a cat")\n${VIEW('cat.png')}`

  it('N3 witness: a gemma3 by name with no projector on disk is never fed the picture', async () => {
    expect(await buildVisionFeedback('gemma-3-4b-it-abliterated', 'image_generate', RESULT, 'openai', false)).toBeNull()
    // The bytes are not even fetched, so a text-only model costs nothing.
    expect(fetchComfyImageBase64).not.toHaveBeenCalled()
  })

  it('a declared false overrides Ollama capability reporting too', async () => {
    modelSupportsVision.mockResolvedValue(true)
    expect(await buildVisionFeedback('gemma4:e4b', 'image_generate', RESULT, 'ollama', false)).toBeNull()
    expect(modelSupportsVision).not.toHaveBeenCalled()
  })

  it('a declared true feeds a model whose name the strict family match misses', async () => {
    const vf = await buildVisionFeedback('my-own-import-q4', 'image_generate', RESULT, 'openai', true)
    expect(vf).not.toBeNull()
    expect(vf!.images).toHaveLength(1)
    expect(vf!.visionFeedback).toBe(true)
  })

  // ── Negative controls: nothing declared, and the old heuristics decide. ──
  it('negative control: undefined keeps the strict name match on a non-Ollama provider', async () => {
    expect(await buildVisionFeedback('gemma-3-4b-it-abliterated', 'image_generate', RESULT, 'openai')).not.toBeNull()
    expect(await buildVisionFeedback('qwen2.5-coder:14b', 'image_generate', RESULT, 'openai')).toBeNull()
  })

  it('negative control: undefined keeps Ollama asking the server', async () => {
    modelSupportsVision.mockResolvedValue(false)
    expect(await buildVisionFeedback('gemma4:e4b', 'image_generate', RESULT, 'ollama')).toBeNull()
    expect(modelSupportsVision).toHaveBeenCalledWith('gemma4:e4b')
  })

  it('negative control: a declared true still refuses a video result', async () => {
    const video = `Video generated: clip.mp4 (prompt: "x")\n${VIEW('clip.mp4')}`
    expect(await buildVisionFeedback('gemma4:e4b', 'video_generate', video, 'ollama', true)).toBeNull()
  })
})
