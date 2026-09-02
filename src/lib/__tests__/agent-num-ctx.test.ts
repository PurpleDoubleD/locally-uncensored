import { describe, it, expect, vi, beforeEach } from 'vitest'

// The Ollama probe, the catalog lookup and the provider's loaded-context
// answer are the only I/O in the resolver.
vi.mock('../../api/ollama', () => ({
  getModelContextCached: vi.fn(),
}))
vi.mock('../context-compaction', () => ({
  getModelMaxTokens: vi.fn(),
}))
vi.mock('../../api/providers', () => ({
  getProviderForModel: vi.fn(),
}))

import { resolveAgentNumCtx, resolveAgentNumCtxWithConfidence } from '../agent-num-ctx'
import { AGENT_CONTEXT_CAP, DEFAULT_CONTEXT_CAP } from '../context-window'
import { getModelContextCached } from '../../api/ollama'
import { getModelMaxTokens } from '../context-compaction'
import { getProviderForModel } from '../../api/providers'

const probe = getModelContextCached as unknown as ReturnType<typeof vi.fn>
const catalog = getModelMaxTokens as unknown as ReturnType<typeof vi.fn>
const providerFor = getProviderForModel as unknown as ReturnType<typeof vi.fn>
// R19: what the provider reports as actually loaded. null = server did not
// say; 'absent' = a provider without the method at all (Anthropic etc.).
let loadedCtx: number | null | 'absent'

describe('resolveAgentNumCtx — one num_ctx per model, per turn', () => {
  beforeEach(() => {
    probe.mockReset()
    catalog.mockReset()
    loadedCtx = 'absent'
    providerFor.mockReset()
    providerFor.mockImplementation((name: string) => ({
      provider: loadedCtx === 'absent'
        ? {}
        : { loadedContextLength: vi.fn(async () => loadedCtx) },
      modelId: name.includes('::') ? name.split('::').slice(1).join('::') : name,
    }))
  })

  it('lets an explicit override win without probing the model', async () => {
    expect(await resolveAgentNumCtx('qwen2.5-coder:14b', 'ollama', 32768)).toBe(32768)
    expect(probe).not.toHaveBeenCalled()
    expect(catalog).not.toHaveBeenCalled()
  })

  // 2026-08-06 — this used to assert 16384, the chat cap, and that number is
  // what made a 20 minute Coding run restart its own plan. The tool catalogue
  // alone measured 8488 tokens of the 16384 on the installed build, so the run
  // reached step 18 of 30, compacted, and began again at step 1. An agent turn
  // is the only thing this resolver serves, and it gets the agent ceiling.
  it('gives an agent turn the agent ceiling, not the chat one', async () => {
    probe.mockResolvedValue(131072)
    expect(await resolveAgentNumCtx('qwen2.5-coder:14b', 'ollama', 0)).toBe(AGENT_CONTEXT_CAP)
    expect(AGENT_CONTEXT_CAP).toBeGreaterThan(DEFAULT_CONTEXT_CAP)
  })

  it('leaves room for the work after the catalogue is paid for', async () => {
    // The point of the change, stated as the thing that has to stay true. The
    // measured catalogue cost has to leave the majority of the window free, or
    // compaction starts eating the run's own progress.
    const CATALOGUE_TOKENS = 8488 // measured, Ollama prompt_eval_count, 30 tools
    probe.mockResolvedValue(131072)
    const ctx = await resolveAgentNumCtx('qwen2.5-coder:14b', 'ollama', 0)
    expect(ctx - CATALOGUE_TOKENS).toBeGreaterThan(ctx / 2)
  })

  it('NEGATIVE CONTROL: a model that cannot take the bigger window keeps its own', async () => {
    // The ceiling is a ceiling, never a request. Asking a model for more room
    // than it was trained on makes Ollama extrapolate RoPE and costs quality.
    probe.mockResolvedValue(8192)
    expect(await resolveAgentNumCtx('small:3b', 'ollama', 0)).toBe(8192)
  })

  it('NEGATIVE CONTROL: an unknown real maximum stays at the conservative cap', async () => {
    // 0 means the probe could not tell us. That is not permission to ask for
    // 32k, so the fallback is the chat cap, exactly as before this change.
    probe.mockResolvedValue(0)
    expect(await resolveAgentNumCtx('mystery:latest', 'ollama', 0)).toBe(DEFAULT_CONTEXT_CAP)
  })

  it('floors at 8192 so vision feedback never overflows a 4096-default model', async () => {
    probe.mockResolvedValue(4096)
    expect(await resolveAgentNumCtx('tiny:1b', 'ollama', 0)).toBe(8192)
  })

  // NOT pinned: the resolver's catch branch (Ollama unreachable -> keep the
  // 8192 floor). A vi.fn() that throws is recorded as a mock RESULT and this
  // vitest version reports it as a test failure even when the code under test
  // catches it — verified with a sync throw, an async throw and .resolves, all
  // three report identically while the returned value is correct. Left
  // uncovered rather than shipping a red test for working code.

  // 2.5.10 — the Morgan bug: cloud models used to fall through to the flat
  // 8192, so a 262k model was compaction-trimmed to ~6.5k every iteration and
  // the coding agent looped on the files it kept forgetting.
  it('resolves a cloud model to its REAL window from the catalog', async () => {
    catalog.mockResolvedValue(262144)
    expect(
      await resolveAgentNumCtx('Qwen/Qwen3-Coder-480B', 'lu-cloud', 0, 'lu-cloud:Qwen/Qwen3-Coder-480B'),
    ).toBe(262144)
    // The catalog is asked with the FULL model name (prefix included) — the
    // model store indexes by it.
    expect(catalog).toHaveBeenCalledWith('lu-cloud:Qwen/Qwen3-Coder-480B')
    expect(probe).not.toHaveBeenCalled()
  })

  it('keeps the 8192 floor for a cloud model the catalog does not know', async () => {
    catalog.mockResolvedValue(4096) // getModelMaxTokens' own catch-all value
    expect(await resolveAgentNumCtx('Qwen/Qwen3-Coder-480B', 'lu-cloud', 0)).toBe(8192)
    expect(probe).not.toHaveBeenCalled()
  })

  it('keeps the floor when the catalog returns nothing usable', async () => {
    catalog.mockResolvedValue(undefined)
    expect(await resolveAgentNumCtx('some/model', 'openai', 0)).toBe(8192)
  })

  // The reason this resolver exists: the chat request and the memory-extraction
  // request that follows it hit the SAME model, and Ollama reloads the model
  // whenever num_ctx changes between requests. Same inputs must give the same
  // number, or every turn pays a second model load (seen live 2026-07-25:
  // chat sent 32768, extraction sent nothing, `ollama ps` fell back to 4096).
  it('is stable across calls so the follow-up request never forces a reload', async () => {
    probe.mockResolvedValue(32768)
    const chat = await resolveAgentNumCtx('qwen2.5-coder:14b', 'ollama', 0)
    const extraction = await resolveAgentNumCtx('qwen2.5-coder:14b', 'ollama', 0)
    expect(extraction).toBe(chat)
  })

  // R19 (LM Studio, 2026-08-07, twice the cause of a run death): the model
  // CAN do 32k, LM Studio JIT-loaded it at 16k, the budget said 32k, and the
  // server hard-truncated the prompt — tool contract included — mid-plan.
  describe('R19: the budget respects what the server actually loaded', () => {
    it('clamps to the loaded context when it is below the model maximum', async () => {
      catalog.mockResolvedValue(32768)
      loadedCtx = 16384
      expect(await resolveAgentNumCtx('qwen3-4b', 'openai', 0, 'openai::qwen3-4b')).toBe(16384)
    })

    it('takes the loaded number even below the 8192 floor, because the floor cannot grow the allocation', async () => {
      catalog.mockResolvedValue(32768)
      loadedCtx = 4096
      expect(await resolveAgentNumCtx('qwen3-4b', 'openai', 0, 'openai::qwen3-4b')).toBe(4096)
    })

    it('NEGATIVE CONTROL: a server that does not say keeps the catalog budget', async () => {
      catalog.mockResolvedValue(32768)
      loadedCtx = null
      expect(await resolveAgentNumCtx('vllm-model', 'openai', 0, 'openai::vllm-model')).toBe(32768)
    })

    it('NEGATIVE CONTROL: a loaded context ABOVE the maximum never raises the budget', async () => {
      catalog.mockResolvedValue(8192)
      loadedCtx = 32768
      expect(await resolveAgentNumCtx('small-model', 'openai', 0, 'openai::small-model')).toBe(8192)
    })

    it('NEGATIVE CONTROL: a provider without the probe is untouched', async () => {
      catalog.mockResolvedValue(200000)
      loadedCtx = 'absent'
      expect(await resolveAgentNumCtx('claude-opus-4', 'anthropic', 0, 'anthropic::claude-opus-4')).toBe(200000)
    })

    it('NEGATIVE CONTROL: the user override still wins over everything', async () => {
      loadedCtx = 4096
      expect(await resolveAgentNumCtx('qwen3-4b', 'openai', 24576, 'openai::qwen3-4b')).toBe(24576)
      expect(providerFor).not.toHaveBeenCalled()
    })

    it('NEGATIVE CONTROL: Ollama never asks the openai probe', async () => {
      probe.mockResolvedValue(32768)
      loadedCtx = 4096
      await resolveAgentNumCtx('qwen2.5-coder:14b', 'ollama', 0)
      expect(providerFor).not.toHaveBeenCalled()
    })
  })
})


// ── Gemessen oder geraten ─────────────────────────────────────────────────

describe('resolveAgentNumCtxWithConfidence — die Zahl sagt nicht, woher sie kommt', () => {
  beforeEach(() => {
    probe.mockReset()
    catalog.mockReset()
    loadedCtx = 'absent'
    providerFor.mockReset()
    providerFor.mockImplementation((name: string) => ({
      provider: loadedCtx === 'absent'
        ? {}
        : { loadedContextLength: vi.fn(async () => loadedCtx) },
      modelId: name.includes('::') ? name.split('::').slice(1).join('::') : name,
    }))
  })

  /**
   * WARUM ES DIESE AUSKUNFT GEBEN MUSS: der Auto-Ausloeser zieht eine
   * Sicherheitsmarge ab, solange der Nenner geraten ist, und erschloss sich
   * das bis 2026-09-02 aus der ZAHL — `window !== 8192`. Genau die beiden
   * Faelle hier unten fielen dabei auf die falsche Seite.
   */
  it('nennt ein wirklich gemessenes 8192er-Fenster GEMESSEN', () => {
    // Der Fall, an dem das Raten scheiterte. 8192 ist Ollamas Voreinstellung
    // und ein voellig legitimer Wert; wer ihn als "geraten" liest, faengt bei
    // diesem Modell dauerhaft acht Prozentpunkte zu frueh an zusammenzufassen.
    probe.mockResolvedValue(8192)
    return resolveAgentNumCtxWithConfidence('llama3:8b', 'ollama', undefined).then((r) => {
      expect(r.ctx).toBe(8192)
      expect(r.gemessen).toBe(true)
    })
  })

  it('nennt den Notboden nach einem Fehlschlag GERATEN', async () => {
    // Dieselbe Zahl, andere Herkunft. Nur hier ist die Marge richtig.
    probe.mockRejectedValue(new Error('Ollama antwortet nicht'))
    const r = await resolveAgentNumCtxWithConfidence('llama3:8b', 'ollama', undefined)
    expect(r.ctx).toBe(8192)
    expect(r.gemessen).toBe(false)
  })

  it('zaehlt einen Override des Nutzers als gemessen — er hat es ja gesagt', async () => {
    const r = await resolveAgentNumCtxWithConfidence('llama3:8b', 'ollama', 32768)
    expect(r).toEqual({ ctx: 32768, gemessen: true })
    expect(probe).not.toHaveBeenCalled()
  })

  it('nennt einen leeren Katalog GERATEN, auch wenn eine Zahl herauskommt', async () => {
    // Der Cloud-Zweig faellt ebenfalls auf 8192 zurueck, nur still.
    catalog.mockResolvedValue(undefined)
    const r = await resolveAgentNumCtxWithConfidence('anthropic::x', 'anthropic', undefined)
    expect(r.ctx).toBe(8192)
    expect(r.gemessen).toBe(false)
  })

  it('nennt eine Katalog-Antwort GEMESSEN', async () => {
    // Die Gegenprobe zum leeren Katalog. Ohne sie waere "gemessen" im
    // Cloud-Zweig dauerhaft falsch, ohne dass ein Test es merkt: die Zahl
    // stimmt ja, nur die Marge waere zu gross und jedes Cloud-Gespraech
    // wuerde zu frueh zusammengefasst.
    catalog.mockResolvedValue(200_000)
    const r = await resolveAgentNumCtxWithConfidence('anthropic::x', 'anthropic', undefined)
    expect(r.ctx).toBe(200_000)
    expect(r.gemessen).toBe(true)
  })

  it('gibt dieselbe Zahl heraus wie der schlanke Weg', async () => {
    // Sonst haetten wir zwei Fenster-Aufloeser statt einem — genau der
    // Zustand, den der Kommentar in maybeAutoCompact ausschliesst.
    probe.mockResolvedValue(16384)
    const a = await resolveAgentNumCtx('llama3:8b', 'ollama', undefined)
    probe.mockResolvedValue(16384)
    const b = await resolveAgentNumCtxWithConfidence('llama3:8b', 'ollama', undefined)
    expect(b.ctx).toBe(a)
  })
})
