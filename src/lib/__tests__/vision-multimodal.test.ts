import { describe, it, expect } from 'vitest'
import { isVisionCompatible, declaredVision } from '../model-compatibility'
import { isMultimodalUnsupportedError, MULTIMODAL_UNSUPPORTED_MESSAGE } from '../ollama-errors'

// #67 (gthvidsten, GH Discussion) — attaching an image to a text-only model.
// Two layers: a name-heuristic gate for a proactive composer hint, and a
// runtime error mapper that catches whatever slips through.

describe('isVisionCompatible', () => {
  it('accepts known local vision families', () => {
    expect(isVisionCompatible('gemma4:e4b')).toBe(true)
    expect(isVisionCompatible('gemma3:12b')).toBe(true)
    expect(isVisionCompatible('llava:13b')).toBe(true)
    expect(isVisionCompatible('llama3.2-vision:11b')).toBe(true)
    expect(isVisionCompatible('qwen2.5-vl:7b')).toBe(true)
    expect(isVisionCompatible('minicpm-v:8b')).toBe(true)
    expect(isVisionCompatible('moondream:latest')).toBe(true)
  })
  it('accepts dashed / community gemma variants via normalizeFamily', () => {
    expect(isVisionCompatible('hf.co/mradermacher/Gemma-4-31B-it-abliterated-GGUF:Q4_K_M')).toBe(true)
  })
  it('accepts GLM-4V (normalizes to glm4v) and versioned InternVL tags', () => {
    // glm-4v → normalizeFamily collapses glm-4→glm4 → "glm4v"; the family list
    // must hold the post-normalize form or these false-warn "can't read images".
    expect(isVisionCompatible('glm-4v:9b')).toBe(true)
    expect(isVisionCompatible('internvl2:8b')).toBe(true)
    expect(isVisionCompatible('internvl2.5:8b')).toBe(true)
    expect(isVisionCompatible('internvl3:14b')).toBe(true)
  })
  it('rejects text-only local models', () => {
    expect(isVisionCompatible('llama3.1:8b')).toBe(false)
    expect(isVisionCompatible('mistral:7b')).toBe(false)
    expect(isVisionCompatible('qwen2.5:7b')).toBe(false)
    expect(isVisionCompatible('deepseek-r1:8b')).toBe(false)
  })
  it('stays lenient for cloud providers (never false-warn a cloud vision model)', () => {
    expect(isVisionCompatible('anthropic::claude-opus-4-20250514')).toBe(true)
  })
  it('returns false for null', () => {
    expect(isVisionCompatible(null)).toBe(false)
  })
})

describe('isMultimodalUnsupportedError', () => {
  it('matches the OpenAI-style multimodal-unsupported 400 (gthvidsten #67)', () => {
    const raw = '{"error":{"code":400,"message":"Multimodal data provided, but model does not support multimodal requests.","type":"invalid_request_error"}}'
    expect(isMultimodalUnsupportedError(raw)).toBe(true)
  })
  it('matches native-style phrasings', () => {
    expect(isMultimodalUnsupportedError('this model does not support image input')).toBe(true)
    expect(isMultimodalUnsupportedError('model is not multimodal')).toBe(true)
  })
  it('matches the exact LM Studio 400 wording (verified live 2026-06-21)', () => {
    // LM Studio returns this bare-string error for an image on a text-only model.
    expect(isMultimodalUnsupportedError('Model does not support images. Please use a model that does.')).toBe(true)
  })
  it('does not match unrelated errors', () => {
    expect(isMultimodalUnsupportedError('model does not support thinking')).toBe(false)
    expect(isMultimodalUnsupportedError('connection refused')).toBe(false)
    expect(isMultimodalUnsupportedError(null)).toBe(false)
    expect(isMultimodalUnsupportedError(undefined)).toBe(false)
  })
  it('does NOT misfire on an image-GENERATION refusal (it is about image INPUT)', () => {
    expect(isMultimodalUnsupportedError('This model does not support image generation')).toBe(false)
    // but a real image-INPUT refusal still matches
    expect(isMultimodalUnsupportedError('this model does not support images')).toBe(true)
  })
  it('exposes actionable, vision-oriented copy', () => {
    expect(MULTIMODAL_UNSUPPORTED_MESSAGE).toMatch(/vision/i)
  })
})

/**
 * Runde 4, Nebenbefund N3 of the D1 counter-check: the app's own answer about
 * a model's image capability, read off a model entry. Two sources fill it and
 * both are facts: the built-in engine reports the vision projector on disk,
 * and a server model listing reports its input modalities.
 */
describe('declaredVision', () => {
  it('reads a declared true and a declared false', () => {
    expect(declaredVision({ supportsVision: true })).toBe(true)
    // The N3 witness: gemma3 by name, no projector next to the GGUF.
    expect(declaredVision({ supportsVision: false })).toBe(false)
  })

  // ── Negative controls: nothing declared, so the name heuristics decide. ──
  it('negative control: an entry without the field declares nothing', () => {
    expect(declaredVision({ name: 'openai::llama3' })).toBeUndefined()
  })

  it('negative control: a missing entry or a non-boolean declares nothing', () => {
    expect(declaredVision(undefined)).toBeUndefined()
    expect(declaredVision(null)).toBeUndefined()
    expect(declaredVision('gemma3')).toBeUndefined()
    expect(declaredVision({ supportsVision: 'yes' })).toBeUndefined()
  })

  it('negative control: the composer keeps the heuristic when nothing is declared', () => {
    // ChatInput's precedence in one line: declared wins, absent falls back.
    const fallback = isVisionCompatible('gemma3:12b')
    const declared = declaredVision({ name: 'openai::gemma-3-4b-it-abliterated', supportsVision: false })
    expect(fallback).toBe(true)
    expect(declared !== undefined ? declared : fallback).toBe(false)
    expect(declaredVision({ name: 'gemma3:12b' }) ?? fallback).toBe(true)
  })
})
