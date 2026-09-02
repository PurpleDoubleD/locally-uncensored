/**
 * @vitest-environment jsdom
 *
 * Review B1, second half: the Docs button now always opens the RAG panel, and
 * the panel's install card is the only thing in the app that can give a user an
 * embedding lane from inside a chat. That card therefore has to work on every
 * box it can be reached from.
 *
 * It did not. `pullEmbeddingModel` sent everyone who is not on the managed
 * built-in engine to `ollama pull`. On a box with LM Studio, a plain
 * openai-compat backend, or nothing but LU Cloud, there is no Ollama to pull
 * from, so the card spun and changed nothing. The bundled GGUF is the lane
 * api/rag.ts would take there anyway, so that is where the install goes.
 *
 * Run: npx vitest run src/hooks/__tests__/the-install-card-has-a-working-path.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

let managed = false
let ollamaUp = true
const installBundled = vi.fn(async () => {})
const pullTauri = vi.fn(() => ({ promise: Promise.resolve(), cancel: () => {} }))

vi.mock('../../api/engine', () => ({
  isManagedBuiltinActive: () => managed,
}))
vi.mock('../../api/embed-availability', () => ({
  builtinEmbedReady: async () => false,
  embeddingBackendReady: async () => false,
}))
vi.mock('../../api/embed-install', () => ({
  installBundledEmbedModel: (...a: any[]) => installBundled(...(a as [])),
}))
vi.mock('../../api/ollama', () => ({
  checkConnection: async () => ollamaUp,
  getModelContext: async () => 8192,
  pullModelTauri: (...a: any[]) => pullTauri(...(a as [])),
}))
vi.mock('../../api/rag', () => ({
  indexDocument: async () => ({ chunks: [] }),
  retrieveContext: async () => ({ context: { chunks: [] }, scoredChunks: [] }),
}))

import { useRAG } from '../useRAG'

beforeEach(() => {
  managed = false
  ollamaUp = true
  installBundled.mockClear()
  pullTauri.mockClear()
})

async function install() {
  const { result } = renderHook(() => useRAG('conv-1'))
  let ok = false
  await act(async () => {
    ok = await result.current.pullEmbeddingModel()
  })
  return ok
}

describe('the install card reaches a real shop from wherever it was opened', () => {
  it('built-in engine: the bundled GGUF, as before', async () => {
    managed = true
    expect(await install()).toBe(true)
    expect(installBundled).toHaveBeenCalledTimes(1)
    expect(pullTauri).not.toHaveBeenCalled()
  })

  it('no Ollama reachable: the bundled GGUF instead of a pull that cannot start (B1)', async () => {
    managed = false
    ollamaUp = false
    expect(await install()).toBe(true)
    expect(installBundled).toHaveBeenCalledTimes(1)
    expect(pullTauri).not.toHaveBeenCalled()
  })

  it('Ollama running: still `ollama pull`, because that is the lane rag.ts would use', async () => {
    // Negative control: the new fallback must not hijack the case that worked.
    managed = false
    ollamaUp = true
    expect(await install()).toBe(true)
    expect(pullTauri).toHaveBeenCalledTimes(1)
    expect(installBundled).not.toHaveBeenCalled()
  })
})
