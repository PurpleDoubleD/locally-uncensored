/**
 * Regression test for `deriveQ4FilenameFromRepo` — the heuristic that turns a
 * HuggingFace repo name into the guessed GGUF filename for the download URL.
 *
 * Pre-v2.4.0 the heuristic unconditionally appended "-Q4_K_M.gguf" to the
 * base name, which produced doubled tags like
 *   "TinyLlama-1.1B-Chat-v1.0-Q4_K_M-GGUF" → "TinyLlama-1.1B-Chat-v1.0-Q4_K_M-Q4_K_M.gguf"
 * and every download from a HF-search result into a repo-name-with-quant-in-it
 * failed with HTTP 404. Surfaced during v2.4.0 E2E of the new Model Storage
 * override feature. Fix: detect the quant suffix and collapse to "{name}.gguf".
 */
import { describe, it, expect } from 'vitest'
import { deriveQ4FilenameFromRepo } from '../discover'

describe('deriveQ4FilenameFromRepo', () => {
  it('TinyLlama-1.1B-Chat-v1.0-Q4_K_M-GGUF does not double the quant suffix', () => {
    expect(deriveQ4FilenameFromRepo('TinyLlama-1.1B-Chat-v1.0-Q4_K_M-GGUF'))
      .toBe('TinyLlama-1.1B-Chat-v1.0-Q4_K_M.gguf')
  })

  it('plain -GGUF repo without a quant in name appends -Q4_K_M.gguf', () => {
    expect(deriveQ4FilenameFromRepo('Qwen3-4B-GGUF'))
      .toBe('Qwen3-4B-Q4_K_M.gguf')
  })

  it('lowercase -gguf stripped, then Q4_K_M appended', () => {
    expect(deriveQ4FilenameFromRepo('gemma-3-12b-it-gguf'))
      .toBe('gemma-3-12b-it-Q4_K_M.gguf')
  })

  it('preserves Q3_K_M / Q5_K_M / Q8_0 suffixes without doubling', () => {
    expect(deriveQ4FilenameFromRepo('Llama-3.1-8B-Instruct-Q3_K_M-GGUF'))
      .toBe('Llama-3.1-8B-Instruct-Q3_K_M.gguf')
    expect(deriveQ4FilenameFromRepo('Llama-3.1-8B-Instruct-Q5_K_M-GGUF'))
      .toBe('Llama-3.1-8B-Instruct-Q5_K_M.gguf')
    expect(deriveQ4FilenameFromRepo('Llama-3.1-8B-Instruct-Q8_0-GGUF'))
      .toBe('Llama-3.1-8B-Instruct-Q8_0.gguf')
  })

  it('preserves IQ2_XXS / IQ3_M / UD-IQ / UD-Q suffixes', () => {
    expect(deriveQ4FilenameFromRepo('Qwen3.6-27B-UD-IQ2_XXS-GGUF'))
      .toBe('Qwen3.6-27B-UD-IQ2_XXS.gguf')
    expect(deriveQ4FilenameFromRepo('Qwen3.6-27B-UD-Q4_K_XL-GGUF'))
      .toBe('Qwen3.6-27B-UD-Q4_K_XL.gguf')
    expect(deriveQ4FilenameFromRepo('Some-Model-IQ3_M-GGUF'))
      .toBe('Some-Model-IQ3_M.gguf')
  })

  it('preserves BF16 / FP16 / F16 / F32 suffixes', () => {
    expect(deriveQ4FilenameFromRepo('Model-BF16-GGUF')).toBe('Model-BF16.gguf')
    expect(deriveQ4FilenameFromRepo('Model-FP16-GGUF')).toBe('Model-FP16.gguf')
    expect(deriveQ4FilenameFromRepo('Model-F16-gguf')).toBe('Model-F16.gguf')
    expect(deriveQ4FilenameFromRepo('Model-F32-GGUF')).toBe('Model-F32.gguf')
  })

  it('lowercase quant tag still counts as a match (case-insensitive)', () => {
    expect(deriveQ4FilenameFromRepo('TinyLlama-1.1B-Chat-v1.0-q4_k_m-GGUF'))
      .toBe('TinyLlama-1.1B-Chat-v1.0-q4_k_m.gguf')
  })

  it('does NOT strip quant-like substrings in the middle of the name', () => {
    // Only the trailing position triggers the "don't double" path.
    expect(deriveQ4FilenameFromRepo('Q4-Study-Model-GGUF'))
      .toBe('Q4-Study-Model-Q4_K_M.gguf')
  })

  it('repo name without -GGUF still gets .gguf appended correctly', () => {
    expect(deriveQ4FilenameFromRepo('TinyLlama-1.1B-Chat'))
      .toBe('TinyLlama-1.1B-Chat-Q4_K_M.gguf')
  })
})
