/**
 * Review B2, 2026-09-02: the Docs panel was about to tell every Cloud-mode user
 * "your documents are indexed on this computer and stay here". That is true on
 * the bundled lane and on a loopback Ollama. It is FALSE the moment someone
 * points LU at another machine, which the app fully supports (the GUI endpoint
 * field, or OLLAMA_HOST at startup): indexing pushes every chunk of every
 * document to that host, not just the passages a question matches.
 *
 * A privacy sentence that is wrong in a supported configuration is worse than
 * no sentence. So the probe reports the LANE, and the wording follows it.
 *
 * Run: npx vitest run src/api/__tests__/embed-lane-names-the-host.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let embedRunning = false
let bundled: { name: string; path: string }[] = []
let ollamaUp = true
let ollamaModels: { name: string }[] = []
let base = 'http://localhost:11434'
const connectionArgs: (number | undefined)[] = []

vi.mock('../backend', () => ({
  backendCall: async (cmd: string) => {
    if (cmd === 'bundled_embed_status') return { running: embedRunning, healthy: embedRunning }
    if (cmd === 'list_bundled_models') return { dir: '/models', models: bundled }
    return null
  },
  localFetch: async () => new Response('{}', { status: 200 }),
  ollamaUrl: (p: string) => `${base}/api${p}`,
  isTauri: () => false,
  getOllamaBase: () => base,
  isOllamaLocal: () => {
    const h = new URL(base).hostname.toLowerCase()
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0'
  },
}))

vi.mock('../ollama', () => ({
  checkConnection: async (timeoutMs?: number) => {
    connectionArgs.push(timeoutMs)
    return ollamaUp
  },
  listModels: async () => ollamaModels,
}))

// The built-in engine is NOT the active backend in these cases, so the probe
// falls through to the bundled-server check and then to Ollama.
vi.mock('../../stores/providerStore', () => ({
  useProviderStore: {
    getState: () => ({ providers: { openai: { enabled: false, managed: false } } }),
  },
}))

import {
  embeddingLane,
  embeddingBackendReady,
  laneIsOnThisMachine,
  EMBED_PROBE_TIMEOUT_MS,
} from '../embed-availability'

beforeEach(() => {
  embedRunning = false
  bundled = []
  ollamaUp = true
  ollamaModels = []
  base = 'http://localhost:11434'
  connectionArgs.length = 0
})

describe('the probe reports WHERE the text would go, not just whether it can go', () => {
  it('the bundled embeddings server is the bundled lane, and it never leaves the box', async () => {
    embedRunning = true
    const info = await embeddingLane('nomic-embed-text')
    expect(info).toEqual({ lane: 'bundled', endpoint: null })
    expect(laneIsOnThisMachine(info.lane)).toBe(true)
  })

  it('loopback Ollama is a local lane and names no host', async () => {
    ollamaModels = [{ name: 'nomic-embed-text:latest' }]
    const info = await embeddingLane('nomic-embed-text')
    expect(info).toEqual({ lane: 'ollama-local', endpoint: null })
    expect(laneIsOnThisMachine(info.lane)).toBe(true)
  })

  it('127.0.0.1 counts as local too, spelled either way', async () => {
    base = 'http://127.0.0.1:11434'
    ollamaModels = [{ name: 'nomic-embed-text' }]
    expect((await embeddingLane('nomic-embed-text')).lane).toBe('ollama-local')
  })

  it('a LAN Ollama is a REMOTE lane and hands back the host it would ship to', async () => {
    base = 'http://192.168.0.54:11434'
    ollamaModels = [{ name: 'nomic-embed-text' }]
    const info = await embeddingLane('nomic-embed-text')
    expect(info.lane).toBe('ollama-remote')
    expect(info.endpoint).toBe('http://192.168.0.54:11434')
    // The claim the panel must not make in this configuration.
    expect(laneIsOnThisMachine(info.lane)).toBe(false)
  })

  it('a named remote host is remote as well, not just a raw IP', async () => {
    base = 'http://dd.local:11434'
    ollamaModels = [{ name: 'nomic-embed-text' }]
    expect((await embeddingLane('nomic-embed-text')).lane).toBe('ollama-remote')
  })

  it('nothing installed anywhere is no lane at all', async () => {
    ollamaModels = [{ name: 'llama3.1:8b' }]
    expect(await embeddingLane('nomic-embed-text')).toEqual({ lane: 'none', endpoint: null })
  })

  it('Ollama unreachable is no lane either, and no host is invented', async () => {
    ollamaUp = false
    const info = await embeddingLane('nomic-embed-text')
    expect(info.lane).toBe('none')
    expect(info.endpoint).toBeNull()
  })

  it('the yes/no question still answers the same way for every working lane', async () => {
    // Negative control: the richer return value must not have changed the
    // upload pre-flight's answer in any case.
    ollamaModels = [{ name: 'nomic-embed-text' }]
    expect(await embeddingBackendReady('nomic-embed-text')).toBe(true)
    base = 'http://192.168.0.54:11434'
    expect(await embeddingBackendReady('nomic-embed-text')).toBe(true)
    ollamaModels = []
    expect(await embeddingBackendReady('nomic-embed-text')).toBe(false)
  })
})

describe('the probe never hangs the UI on a dead host (review 3)', () => {
  it('asks Ollama with a short budget instead of the proxy default', async () => {
    // Without a budget the Rust proxy waits 300000 ms. A LAN box that is simply
    // switched off does not refuse the connection, it swallows it, so the Docs
    // tooltip, the install button and the privacy paragraph all froze for five
    // minutes. The paragraph froze hardest: it does not render until a lane is
    // measured at all.
    base = 'http://192.168.0.54:11434'
    ollamaModels = [{ name: 'nomic-embed-text' }]
    await embeddingLane('nomic-embed-text')
    expect(connectionArgs).toEqual([EMBED_PROBE_TIMEOUT_MS])
    expect(EMBED_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(3000)
  })

  it('a host that never answers is simply "no lane", not a five minute wait', async () => {
    ollamaUp = false
    expect((await embeddingLane('nomic-embed-text')).lane).toBe('none')
  })

  it('the bundled lane short-circuits and never asks Ollama at all', async () => {
    // Negative control: the timeout matters only on the path that uses it, and
    // the everyday case must not pay for a network probe it does not need.
    embedRunning = true
    await embeddingLane('nomic-embed-text')
    expect(connectionArgs).toEqual([])
  })
})
