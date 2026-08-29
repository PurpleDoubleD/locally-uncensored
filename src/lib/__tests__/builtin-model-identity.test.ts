/**
 * The rules behind "is the built-in engine holding the model this request
 * names". Pure, so the Rust twin in `commands/proxy.rs` can be read against
 * the same table.
 *
 * Run: npx vitest run src/lib/__tests__/builtin-model-identity.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  bareBuiltinModelName,
  builtinModelMatches,
  builtinModelMismatchMessage,
  builtinModelNameFromPath,
} from '../builtin-model-identity'

describe('builtinModelNameFromPath', () => {
  it('reads the picker id off a posix path', () => {
    expect(builtinModelNameFromPath('/Users/x/models/qwen2.5-0.5b.gguf')).toBe('qwen2.5-0.5b')
  })

  it('reads the picker id off a windows path, which is what Rust hands us there', () => {
    expect(
      builtinModelNameFromPath('C:\\Users\\ddrob\\AppData\\Roaming\\lu\\models\\mlabonne_gemma-3-4b-it-abliterated-Q4_K_M.gguf'),
    ).toBe('mlabonne_gemma-3-4b-it-abliterated-Q4_K_M')
  })

  it('collapses a gguf-split part back to the name the picker shows', () => {
    // scan_gguf_models lists a split set under the base name and points at
    // part 1, so a raw stem compare would call every split model a mismatch.
    expect(builtinModelNameFromPath('/m/DeepSeek-V4-Flash-Q4_K_M-00001-of-00003.gguf')).toBe('DeepSeek-V4-Flash-Q4_K_M')
  })

  it('tolerates an upper case extension from a hand copied file', () => {
    expect(builtinModelNameFromPath('/m/Model.GGUF')).toBe('Model')
  })

  it('answers empty for nothing loaded', () => {
    expect(builtinModelNameFromPath(null)).toBe('')
    expect(builtinModelNameFromPath(undefined)).toBe('')
    expect(builtinModelNameFromPath('   ')).toBe('')
  })

  // Negative control: a name that merely LOOKS like a shard keeps its suffix,
  // so a real model called "...-of-..." is not renamed out from under itself.
  it('does not strip a suffix that is not a shard marker', () => {
    expect(builtinModelNameFromPath('/m/best-of-both-worlds.gguf')).toBe('best-of-both-worlds')
    expect(builtinModelNameFromPath('/m/model-1-of-3.gguf')).toBe('model-1-of-3')
  })
})

describe('bareBuiltinModelName', () => {
  it('strips the provider prefix and nothing else', () => {
    expect(bareBuiltinModelName('openai::qwen2.5-0.5b')).toBe('qwen2.5-0.5b')
    expect(bareBuiltinModelName('qwen2.5-0.5b')).toBe('qwen2.5-0.5b')
  })

  // Negative control: this id is a lookup key against list_bundled_models and
  // the name in a user facing error, so it must come back verbatim. Trimming
  // an extension here would look up the wrong entry and rename the model in
  // the message.
  it('leaves a name that carries the file extension intact', () => {
    expect(bareBuiltinModelName('openai::qwen2.5-0.5b.gguf')).toBe('qwen2.5-0.5b.gguf')
  })

  it('leaves a name with more than one separator alone, as the registry does', () => {
    // getProviderIdFromModel only treats an exactly-two-part split as prefixed.
    expect(bareBuiltinModelName('a::b::c')).toBe('a::b::c')
  })

  it('answers empty for nothing', () => {
    expect(bareBuiltinModelName(undefined)).toBe('')
  })
})

describe('builtinModelMatches', () => {
  it('is true for the same model, prefixed or not, extension or not', () => {
    expect(builtinModelMatches('/m/qwen2.5-0.5b.gguf', 'qwen2.5-0.5b')).toBe(true)
    expect(builtinModelMatches('/m/qwen2.5-0.5b.gguf', 'openai::qwen2.5-0.5b')).toBe(true)
    expect(builtinModelMatches('/m/qwen2.5-0.5b.gguf', 'openai::qwen2.5-0.5b.gguf')).toBe(true)
  })

  it('is FALSE for the case the counter-check measured on the box', () => {
    // Gemma loaded, request says Hermes. The engine answered it with Gemma.
    expect(
      builtinModelMatches('C:\\m\\mlabonne_gemma-3-4b-it-abliterated-Q4_K_M.gguf', 'Hermes-3-Llama-3.2-3B.Q4_K_M'),
    ).toBe(false)
    // And the invented name, which was answered just as happily.
    expect(builtinModelMatches('C:\\m\\mlabonne_gemma-3-4b-it-abliterated-Q4_K_M.gguf', 'gibt-es-nicht-42')).toBe(false)
  })

  // Negative control: not knowing must never be reported as a mismatch, or
  // every send against an engine whose status carries no path would die.
  it('is true when either side is unknown', () => {
    expect(builtinModelMatches(null, 'qwen2.5-0.5b')).toBe(true)
    expect(builtinModelMatches('/m/qwen2.5-0.5b.gguf', '')).toBe(true)
    expect(builtinModelMatches(undefined, undefined)).toBe(true)
  })
})

describe('builtinModelMismatchMessage', () => {
  it('names both models, in English, without a dash', () => {
    const msg = builtinModelMismatchMessage('gemma-3-4b', 'Hermes-3')
    expect(msg).toContain('"gemma-3-4b"')
    expect(msg).toContain('"Hermes-3"')
    expect(msg).not.toMatch(/[—–]/)
    // English only: no localised operating system wording ever reaches here,
    // and no German word is allowed in a user facing string.
    expect(msg).toMatch(/^[\x20-\x7E]+$/)
  })
})
