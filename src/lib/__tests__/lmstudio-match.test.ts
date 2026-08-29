import { describe, it, expect } from 'vitest'
import { matchesLmStudioInstalled, matchesLocalGgufInstalled, modelIdentity, extractQuant, type InstalledModelLike } from '../lmstudio-match'

const lms = (id: string, field: 'model' | 'name' | 'lmsKey' = 'model'): InstalledModelLike => ({
  provider: 'openai',
  providerName: 'LM Studio',
  [field]: id,
})

describe('matchesLmStudioInstalled — exact / quant-precise matches (Bug Y/b)', () => {
  it('matches the older exact full-basename id form', () => {
    expect(matchesLmStudioInstalled('Hermes-3-Llama-3.1-8B.Q4_K_M.gguf', [lms('hermes-3-llama-3.1-8b.q4_k_m.gguf')])).toBe(true)
  })
  it('matches via a publisher/ path suffix', () => {
    expect(matchesLmStudioInstalled('Hermes-3-Llama-3.1-8B.Q4_K_M.gguf', [lms('mradermacher/hermes-3-llama-3.1-8b.q4_k_m')])).toBe(true)
  })
  it('matches the key@quant id form against the SAME quant', () => {
    expect(matchesLmStudioInstalled('Qwen2.5-0.5B-Instruct-Q4_K_M.gguf', [lms('qwen2.5-0.5b-instruct@q4_k_m')])).toBe(true)
  })
  it('also reads the lmsKey field', () => {
    expect(matchesLmStudioInstalled('Qwen2.5-0.5B-Instruct-Q4_K_M.gguf', [lms('qwen2.5-0.5b-instruct@q4_k_m', 'lmsKey')])).toBe(true)
  })
  it('matches a quant-LESS Discover entry from a quant-less id (generic row)', () => {
    expect(matchesLmStudioInstalled('Qwen2.5-VL-7B-Instruct.gguf', [lms('qwen/qwen2.5-vl-7b')])).toBe(true)
  })
})

describe('matchesLmStudioInstalled — NO false positives (v2.5.0 adversarial-audit regression guards)', () => {
  it('does NOT light a DIFFERENT quant of the same model (q4 id vs q8 row)', () => {
    expect(matchesLmStudioInstalled('Qwen2.5-0.5B-Instruct-Q8_0.gguf', [lms('qwen2.5-0.5b-instruct@q4_k_m')])).toBe(false)
  })
  it('does NOT light quant-specific rows from a COLLAPSED quant-less id — the live over-match', () => {
    // LM Studio reports "qwen3.6-27b" (one quant on disk, no @quant). The curated
    // list has 7 quant rows; installing one must NOT badge the siblings.
    expect(matchesLmStudioInstalled('Qwen3.6-27B-Q4_K_M.gguf', [lms('qwen3.6-27b')])).toBe(false)
    expect(matchesLmStudioInstalled('Qwen3.6-27B-Q8_0.gguf', [lms('qwen3.6-27b')])).toBe(false)
    expect(matchesLmStudioInstalled('Qwen3.6-27B-Q5_K_M.gguf', [lms('qwen3.6-27b')])).toBe(false)
  })
  it('does NOT collapse genuinely different finetunes (abliterated vs plain)', () => {
    expect(matchesLmStudioInstalled('Qwen3-8B-abliterated.Q4_K_M.gguf', [lms('qwen3-8b@q4_k_m')])).toBe(false)
  })
  it('does NOT light a different model (coder vs vl)', () => {
    expect(matchesLmStudioInstalled('Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf', [lms('qwen2.5-coder-7b-instruct@q4_k_m')])).toBe(false)
  })
  it('ignores non-LM-Studio (ollama) installed entries', () => {
    expect(matchesLmStudioInstalled('Qwen2.5-0.5B-Instruct-Q4_K_M.gguf', [{ provider: 'ollama', model: 'qwen2.5-0.5b-instruct' }])).toBe(false)
  })
  it('empty filename never matches', () => {
    expect(matchesLmStudioInstalled('', [lms('qwen/qwen2.5-vl-7b')])).toBe(false)
  })
})

describe('extractQuant + modelIdentity', () => {
  it('extractQuant pulls the trailing quant tag', () => {
    expect(extractQuant('Qwen3.6-27B-Q4_K_M.gguf')).toBe('q4km')
    expect(extractQuant('qwen2.5-0.5b-instruct@q4_k_m')).toBe('q4km')
    expect(extractQuant('zai-org_GLM-4.7-Flash-IQ2_M.gguf')).toBe('iq2m')
    expect(extractQuant('qwen/qwen2.5-vl-7b')).toBe(null)
  })
  it('modelIdentity drops publisher, quant, decoration + separators', () => {
    expect(modelIdentity('Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf')).toBe('qwen25vl7b')
    expect(modelIdentity('qwen/qwen2.5-vl-7b')).toBe('qwen25vl7b')
  })
})

describe('split GGUF (-NNNNN-of-NNNNN) shard tails', () => {
  const lms = (model: string) => ({ provider: 'openai', providerName: 'LM Studio', model })
  it('extractQuant sees the quant BEFORE the shard tail', () => {
    expect(extractQuant('DeepSeek-V4-Flash-0731-UD-IQ1_S-00001-of-00003.gguf')).toBe('udiq1s')
    expect(extractQuant('GLM-5.2-UD-Q2_K_XL-00001-of-00007.gguf')).toBe('udq2kxl')
  })
  it('modelIdentity is shard-independent', () => {
    expect(modelIdentity('DeepSeek-V4-Flash-0731-UD-IQ1_S-00001-of-00003.gguf'))
      .toBe(modelIdentity('DeepSeek-V4-Flash-0731-UD-IQ1_S.gguf'))
  })
  it('a first-shard Discover filename matches the collapsed installed name', () => {
    expect(matchesLmStudioInstalled('DeepSeek-V4-Flash-0731-UD-IQ1_S-00001-of-00003.gguf', [
      lms('DeepSeek-V4-Flash-0731-UD-IQ1_S'),
    ])).toBe(true)
  })
  it('also matches when the installed side reports the first shard itself', () => {
    expect(matchesLmStudioInstalled('DeepSeek-V4-Flash-0731-UD-IQ1_S-00001-of-00003.gguf', [
      lms('DeepSeek-V4-Flash-0731-UD-IQ1_S-00001-of-00003.gguf'),
    ])).toBe(true)
  })
  it('still refuses a quant sibling across shard tails', () => {
    expect(matchesLmStudioInstalled('DeepSeek-V4-Flash-0731-UD-IQ1_S-00001-of-00003.gguf', [
      lms('DeepSeek-V4-Flash-0731-UD-Q2_K_XL'),
    ])).toBe(false)
  })
  it('does not mistake short numeric names for shard tails', () => {
    expect(modelIdentity('llama-2-of-3.gguf')).toBe('llama2of3')
    expect(extractQuant('phi-4-Q4_K_M.gguf')).toBe('q4km')
  })
})

// GH #118 (nayffy, 2026-08-27): "If i close and reopen LU, it changed from
// 'Installed' to 'Get', but the 'Get' button doesn't do anything as the files
// are still downloaded." The badge only ever asked the LM Studio half of the
// installed list, and a built-in-engine model is stamped
// providerName: 'Built-in Engine'. The in-session download store was the only
// other evidence and it does not survive a restart.
const builtin = (id: string): InstalledModelLike => ({
  provider: 'openai',
  providerName: 'Built-in Engine',
  model: id,
})

describe('matchesLocalGgufInstalled: the built-in engine counts as installed too', () => {
  it('lights the badge for a GGUF the built-in engine reports from disk', () => {
    // list_bundled_models returns the file STEM, no .gguf.
    expect(matchesLocalGgufInstalled('Cydonia-24B-v4.1-Q4_K_M.gguf', [builtin('Cydonia-24B-v4.1-Q4_K_M')])).toBe(true)
  })
  it('still lights for LM Studio, so the old path is untouched', () => {
    expect(matchesLocalGgufInstalled('Hermes-3-Llama-3.1-8B.Q4_K_M.gguf', [lms('hermes-3-llama-3.1-8b.q4_k_m.gguf')])).toBe(true)
  })
  it('keeps the quant rule: a sibling quant on the built-in engine does NOT light the row', () => {
    expect(matchesLocalGgufInstalled('Cydonia-24B-v4.1-Q4_K_M.gguf', [builtin('Cydonia-24B-v4.1-Q6_K')])).toBe(false)
  })
  it('ignores a cloud slot that happens to sit on provider openai', () => {
    expect(matchesLocalGgufInstalled('Cydonia-24B-v4.1-Q4_K_M.gguf', [
      { provider: 'openai', providerName: 'OpenAI', model: 'Cydonia-24B-v4.1-Q4_K_M' },
    ])).toBe(false)
  })
  it('the LM-Studio-only function stays LM-Studio-only', () => {
    expect(matchesLmStudioInstalled('Cydonia-24B-v4.1-Q4_K_M.gguf', [builtin('Cydonia-24B-v4.1-Q4_K_M')])).toBe(false)
  })
})
