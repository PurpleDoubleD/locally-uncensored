/**
 * Backend Detector Tests
 *
 * Tests detectLocalBackends() with mocked fetch and isTauri.
 * Verifies correct probing of local LLM backends (Ollama, LM Studio, etc.)
 *
 * Run: npx vitest run src/lib/__tests__/backend-detector.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the backend module before importing the detector
vi.mock('../../api/backend', () => ({
  isTauri: vi.fn(() => false),
  localFetch: vi.fn(),
}))

import { detectLocalBackends } from '../backend-detector'
import { isTauri, localFetch } from '../../api/backend'
import { PROVIDER_PRESETS } from '../../api/providers/types'

// ── Helpers ──────────────────────────────────────────────────────

const localPresets = PROVIDER_PRESETS.filter((p) => p.isLocal && p.baseUrl)

/** Build a mock fetch that responds ok for specific ports. */
function mockFetchForPorts(reachablePorts: number[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(
    (input: string | URL | Request, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const portMatch = url.match(/:(\d+)/)
      const port = portMatch ? parseInt(portMatch[1]) : 80

      if (reachablePorts.includes(port)) {
        return Promise.resolve(new Response('{}', { status: 200 }))
      }
      return Promise.reject(new Error('Connection refused'))
    }
  )
}

// ── Tests ────────────────────────────────────────────────────────

describe('detectLocalBackends', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // Default: not in Tauri mode
    ;(isTauri as ReturnType<typeof vi.fn>).mockReturnValue(false)
  })

  it('returns empty array when no backends are reachable', async () => {
    mockFetchForPorts([])

    const result = await detectLocalBackends()

    expect(result).toEqual([])
  })

  it('detects only Ollama when port 11434 is reachable', async () => {
    mockFetchForPorts([11434])

    const result = await detectLocalBackends()

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('ollama')
    expect(result[0].name).toBe('Ollama')
    expect(result[0].baseUrl).toBe('http://localhost:11434')
    expect(result[0].port).toBe(11434)
  })

  it('detects only LM Studio when port 1234 is reachable', async () => {
    mockFetchForPorts([1234])

    const result = await detectLocalBackends()

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('lmstudio')
    expect(result[0].name).toBe('LM Studio')
    expect(result[0].baseUrl).toBe('http://localhost:1234/v1')
    expect(result[0].port).toBe(1234)
  })

  it('detects multiple backends simultaneously', async () => {
    mockFetchForPorts([11434, 1234, 8000])

    const result = await detectLocalBackends()

    const ids = result.map((b) => b.id)
    expect(ids).toContain('ollama')
    expect(ids).toContain('lmstudio')
    expect(ids).toContain('vllm')
    expect(result.length).toBe(3)
  })

  it('returned objects have correct DetectedBackend shape', async () => {
    mockFetchForPorts([11434])

    const result = await detectLocalBackends()

    for (const backend of result) {
      expect(backend).toHaveProperty('id')
      expect(backend).toHaveProperty('name')
      expect(backend).toHaveProperty('baseUrl')
      expect(backend).toHaveProperty('port')
      expect(typeof backend.id).toBe('string')
      expect(typeof backend.name).toBe('string')
      expect(typeof backend.baseUrl).toBe('string')
      expect(typeof backend.port).toBe('number')
    }
  })

  it('uses Ollama /api/tags endpoint for Ollama preset', async () => {
    const fetchSpy = mockFetchForPorts([11434])

    await detectLocalBackends()

    // Find the call to the Ollama endpoint
    const ollamaCall = fetchSpy.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('11434')
    )
    expect(ollamaCall).toBeDefined()
    expect(ollamaCall![0]).toContain('/api/tags')
  })

  it('uses /models endpoint for OpenAI-compat backends', async () => {
    const fetchSpy = mockFetchForPorts([1234])

    await detectLocalBackends()

    // Find the call to the LM Studio endpoint
    const lmStudioCall = fetchSpy.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('1234')
    )
    expect(lmStudioCall).toBeDefined()
    expect(lmStudioCall![0]).toContain('/models')
  })

  it('uses localFetch in Tauri mode instead of global fetch', async () => {
    ;(isTauri as ReturnType<typeof vi.fn>).mockReturnValue(true)
    ;(localFetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('{}', { status: 200 })
    )

    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const result = await detectLocalBackends()

    // In Tauri mode, localFetch should be called, not global fetch
    expect(localFetch).toHaveBeenCalled()
    // Global fetch should NOT have been called (Tauri proxies everything)
    expect(fetchSpy).not.toHaveBeenCalled()

    // Should detect all local presets since all localFetch calls return ok
    expect(result.length).toBe(localPresets.length)
  })

  it('handles mixed success and failure gracefully', async () => {
    // Only Ollama and GPT4All reachable
    mockFetchForPorts([11434, 4891])

    const result = await detectLocalBackends()

    expect(result).toHaveLength(2)
    const ids = result.map((b) => b.id)
    expect(ids).toContain('ollama')
    expect(ids).toContain('gpt4all')
  })

  it('handles fetch throwing AbortError (timeout)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const err = new DOMException('The operation was aborted', 'AbortError')
      return Promise.reject(err)
    })

    const result = await detectLocalBackends()

    expect(result).toEqual([])
  })

  it('probes only local presets (ignores cloud providers)', async () => {
    const fetchSpy = mockFetchForPorts([])

    await detectLocalBackends()

    // Count the number of fetch calls -- should match local presets count
    // (cloud providers like OpenRouter, Groq should not be probed)
    expect(fetchSpy.mock.calls.length).toBe(localPresets.length)
  })

  it('detects all local backends when everything is reachable', async () => {
    // Extract all ports from local presets
    const allPorts = localPresets.map((p) => {
      const match = p.baseUrl.match(/:(\d+)/)
      return match ? parseInt(match[1]) : 80
    })
    mockFetchForPorts(allPorts)

    const result = await detectLocalBackends()

    // Should detect all local presets
    expect(result.length).toBe(localPresets.length)
  })
})
