/**
 * goonerforporn, Discord #bug-reports 2026-08-28: "the field for the CivitAI
 * API key is gone from the UI", and downloads from the CivitAI search end in
 * 400s.
 *
 * He was right on both counts and he had searched before writing. The store
 * carried `civitaiApiKey`, `setCivitaiApiKey` was defined, the changelog named
 * the key. And NO component in the app called the setter, so there was no way
 * to enter one. The search read the empty value, the download path did not read
 * it at all, and CivitAI answered a bare number.
 *
 * Proven here: the key goes out with a CivitAI download and with nothing else.
 * The wire side (Bearer header, host gate, the wording of a refusal) is proven
 * in Rust, `src-tauri/src/commands/download.rs`, mod `civitai_auth_tests`.
 *
 * Run: npx vitest run src/api/__tests__/civitai-api-key.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const backendCall = vi.fn()
vi.mock('../backend', () => ({
  backendCall: (...args: unknown[]) => backendCall(...args),
  fetchExternal: vi.fn(),
  isTauri: () => true,
  isMacOS: () => false,
}))

import { isCivitaiUrl, civitaiAuthToken, startModelDownload, resumeDownload } from '../discover'
import { useWorkflowStore } from '../../stores/workflowStore'

const KEY = 'civitai-key-abcdef'
const CIVITAI = 'https://civitai.com/api/download/models/128713'
const HUGGINGFACE = 'https://huggingface.co/TheDrummer/Cydonia/resolve/main/model.gguf'

beforeEach(() => {
  backendCall.mockReset()
  backendCall.mockResolvedValue({ status: 'started', id: 'x' })
  useWorkflowStore.setState({ civitaiApiKey: KEY })
})

describe('who gets the key', () => {
  it('recognises CivitAI and its mirror by host', () => {
    expect(isCivitaiUrl(CIVITAI)).toBe(true)
    // GH #53: the mirror LU offers where .com is blocked.
    expect(isCivitaiUrl('https://civitai.red/api/download/models/1')).toBe(true)
    expect(civitaiAuthToken(CIVITAI)).toBe(KEY)
  })

  // Negative control, and the reason the check is on the host: a URL that only
  // mentions civitai must never collect the user's key.
  it('gives the key to nobody else', () => {
    expect(isCivitaiUrl(HUGGINGFACE)).toBe(false)
    expect(isCivitaiUrl('https://evil.test/?x=civitai.com')).toBe(false)
    expect(isCivitaiUrl('https://civitai.com.evil.test/file')).toBe(false)
    expect(isCivitaiUrl('not a url')).toBe(false)
    expect(civitaiAuthToken(HUGGINGFACE)).toBeNull()
    expect(civitaiAuthToken('https://evil.test/?x=civitai.com')).toBeNull()
  })

  it('sends nothing when no key is stored', () => {
    useWorkflowStore.setState({ civitaiApiKey: '' })
    expect(civitaiAuthToken(CIVITAI)).toBeNull()
    useWorkflowStore.setState({ civitaiApiKey: '   ' })
    expect(civitaiAuthToken(CIVITAI)).toBeNull()
  })
})

describe('the download carries it', () => {
  it('hands the key to a CivitAI download', async () => {
    await startModelDownload(CIVITAI, 'checkpoints', 'pony.safetensors')
    expect(backendCall).toHaveBeenCalledWith('download_model', {
      url: CIVITAI,
      subfolder: 'checkpoints',
      filename: 'pony.safetensors',
      expectedBytes: null,
      authToken: KEY,
    })
  })

  it('hands it to a resume too, so a paused CivitAI file can finish', async () => {
    await resumeDownload('pony.safetensors', CIVITAI, 'checkpoints')
    expect(backendCall).toHaveBeenCalledWith('resume_download', {
      id: 'pony.safetensors',
      url: CIVITAI,
      subfolder: 'checkpoints',
      authToken: KEY,
    })
  })

  // Negative control: every other catalog download goes out exactly as before.
  it('sends no token on a HuggingFace download', async () => {
    await startModelDownload(HUGGINGFACE, 'checkpoints', 'model.gguf', 42)
    expect(backendCall).toHaveBeenCalledWith('download_model', {
      url: HUGGINGFACE,
      subfolder: 'checkpoints',
      filename: 'model.gguf',
      expectedBytes: 42,
      authToken: null,
    })
  })
})
