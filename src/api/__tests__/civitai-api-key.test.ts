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
const fetchExternal = vi.fn()
vi.mock('../backend', () => ({
  backendCall: (...args: unknown[]) => backendCall(...args),
  fetchExternal: (...args: unknown[]) => fetchExternal(...args),
  isTauri: () => true,
  isMacOS: () => false,
  secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))

import {
  isCivitaiUrl, civitaiAuthToken, startModelDownload, resumeDownload, searchCivitaiModels,
} from '../discover'
import { useWorkflowStore } from '../../stores/workflowStore'

const KEY = 'civitai-key-abcdef'
const CIVITAI = 'https://civitai.com/api/download/models/128713'
const HUGGINGFACE = 'https://huggingface.co/TheDrummer/Cydonia/resolve/main/model.gguf'

beforeEach(() => {
  backendCall.mockReset()
  fetchExternal.mockReset()
  backendCall.mockResolvedValue({ status: 'started', id: 'x' })
  fetchExternal.mockResolvedValue(JSON.stringify({ items: [] }))
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
    // The backslash forms: in a special scheme a backslash ends the authority,
    // so this one really reaches evil.test. `new URL()` knows that, and so does
    // the Rust gate behind it (url::Url::parse), which is the point: both sides
    // have to agree with the host the request will actually reach.
    expect(new URL('https://evil.test\\.civitai.com/x').hostname).toBe('evil.test')
    expect(isCivitaiUrl('https://evil.test\\.civitai.com/x')).toBe(false)
    expect(civitaiAuthToken('https://evil.test\\.civitai.com/x')).toBeNull()
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

describe('the search does not put the key in the URL', () => {
  it('sends the key beside the URL, not inside it', async () => {
    await searchCivitaiModels('pony', 'Checkpoint', KEY)
    const [url, token] = fetchExternal.mock.calls[0]
    // The URL is what an error message and a log line quote, and the scrubber
    // cannot see a secret that is only another substring of a URL.
    expect(url).not.toContain(KEY)
    expect(url).not.toContain('token=')
    expect(url).toContain('https://civitai.com/api/v1/models?')
    expect(token).toBe(KEY)
  })

  // Negative control: no key is still a valid, anonymous search, and the query
  // the user typed still goes out.
  it('searches without a key just as it did', async () => {
    await searchCivitaiModels('pony')
    const [url, token] = fetchExternal.mock.calls[0]
    expect(url).toContain('query=pony')
    expect(url).not.toContain('token')
    expect(token).toBeNull()
  })

  // Negative control: the mirror is still honoured (GH #53).
  it('still asks the mirror when one is chosen', async () => {
    await searchCivitaiModels('pony', 'LORA', KEY, 'civitai.red')
    expect(fetchExternal.mock.calls[0][0]).toContain('https://civitai.red/api/v1/models?')
  })
})
