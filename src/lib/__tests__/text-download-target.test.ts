/**
 * GH #118 (nayffy, 2026-08-27, Windows 11, v2.6.6): "Unable to load built in
 * engine or models". A fresh install downloaded a chat model, the tile said
 * Installed, the Chat tab never saw it, a restart flipped the tile back to
 * Get, and the Built-in Engine test in Settings answered
 * `GET http://127.0.0.1:8127/v1/models net::ERR_CONNECTION_REFUSED`.
 *
 * All three came from this one decision. The download target was derived from
 * the ACTIVE chat model, and a fresh install has none, so the code fell
 * through to the legacy "whichever backend is enabled" rule: it wrote the GGUF
 * into the LM Studio layout (`<models>/<user>/<repo>/`), which the flat
 * `list_bundled_models` scan does not read, and it skipped
 * `start_bundled_engine` because that call sits behind the same flag.
 *
 * Run: npx vitest run src/lib/__tests__/text-download-target.test.ts
 */
import { describe, it, expect } from 'vitest'
import { resolveTextDownloadTarget } from '../text-download-target'

const SHIPPED_DEFAULTS = {
  openai: { enabled: true, managed: true, name: 'Built-in Engine' },
  ollamaEnabled: false,
}

describe('resolveTextDownloadTarget: the fresh install from #118', () => {
  it('sends the download to the built-in engine when no chat model was ever picked', () => {
    expect(resolveTextDownloadTarget({ activeChatModel: null, ...SHIPPED_DEFAULTS })).toBe('builtin')
  })

  it('treats an empty string the same as no model', () => {
    expect(resolveTextDownloadTarget({ activeChatModel: '', ...SHIPPED_DEFAULTS })).toBe('builtin')
  })

  it('does not hand a GGUF to a cloud slot the user happens to be chatting on', () => {
    // A GGUF cannot run at Anthropic, so the local destination decides alone.
    expect(
      resolveTextDownloadTarget({ activeChatModel: 'anthropic::claude-sonnet-4', ...SHIPPED_DEFAULTS }),
    ).toBe('builtin')
    expect(
      resolveTextDownloadTarget({ activeChatModel: 'lu-cloud::glm-5.3', ...SHIPPED_DEFAULTS }),
    ).toBe('builtin')
  })
})

describe('resolveTextDownloadTarget: the active model still decides (Bug Y/a, v2.5.0)', () => {
  it('an Ollama tag keeps the ollama pull path', () => {
    expect(
      resolveTextDownloadTarget({
        activeChatModel: 'qwen2.5:7b',
        openai: { enabled: false },
        ollamaEnabled: true,
      }),
    ).toBe('ollama')
  })

  it('an active built-in model stays on the built-in engine even with Ollama running', () => {
    expect(
      resolveTextDownloadTarget({
        activeChatModel: 'openai::Cydonia-24B-v4.1-Q4_K_M',
        openai: { enabled: true, managed: true, name: 'Built-in Engine' },
        ollamaEnabled: true,
      }),
    ).toBe('builtin')
  })

  it('an active LM Studio model keeps the nested LM Studio layout', () => {
    expect(
      resolveTextDownloadTarget({
        activeChatModel: 'openai::qwen2.5-7b-instruct',
        openai: { enabled: true, managed: false, name: 'LM Studio' },
        ollamaEnabled: false,
      }),
    ).toBe('lmstudio')
  })

  it('an active custom OpenAI-compatible server is neither of those', () => {
    expect(
      resolveTextDownloadTarget({
        activeChatModel: 'openai::my-model',
        openai: { enabled: true, managed: false, name: 'vLLM' },
        ollamaEnabled: false,
      }),
    ).toBe('openai-compat')
  })
})

describe('resolveTextDownloadTarget: no active model, other setups', () => {
  it('an Ollama user is untouched: choosing Ollama in onboarding disables the managed slot', () => {
    expect(
      resolveTextDownloadTarget({
        activeChatModel: null,
        openai: { enabled: false, managed: false },
        ollamaEnabled: true,
      }),
    ).toBe('ollama')
  })

  it('an LM Studio slot wins over Ollama, as before', () => {
    expect(
      resolveTextDownloadTarget({
        activeChatModel: null,
        openai: { enabled: true, managed: false, name: 'LM Studio' },
        ollamaEnabled: true,
      }),
    ).toBe('lmstudio')
  })

  it('with nothing local enabled the file still lands where this app can load it', () => {
    expect(
      resolveTextDownloadTarget({
        activeChatModel: null,
        openai: { enabled: false },
        ollamaEnabled: false,
      }),
    ).toBe('builtin')
  })
})
