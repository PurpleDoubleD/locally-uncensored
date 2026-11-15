/**
 * @vitest-environment jsdom
 *
 * A silent run steps aside when the person picks, loads or unloads a model.
 *
 * Found by hand on 10.10.2026: after a voice session the digest of the whole
 * session ran on the active local model for a minute and a half. The model
 * picked in that time could not load, because a local backend does not swap a
 * model that is still computing, and the row's switch span with no reason and
 * no way to stop it.
 *
 * `yieldSilentLocalRuns` (lib/silent-runs.ts) is the one function the model
 * controls call. These tests drive the real extraction against the real lane
 * module; only the provider stream and the stores around it are stand-ins.
 *
 * Run: npx vitest run src/hooks/__tests__/silent-run-yields-to-model-switch.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCloudAuthStore } from '../../stores/cloudAuthStore'
import { useGenerationStore } from '../../stores/generationStore'
import { useAgentTaskStore } from '../../stores/agentTaskStore'
import { useAgentLoopStore } from '../../stores/agentLoopStore'
import { yieldSilentLocalRuns } from '../../lib/silent-runs'
import { runInLane } from '../../lib/run-slot'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { admit, release, localLaneHolder, queuedRunIds, __resetRunLanesForTests } from '../../lib/run-lanes'

const chatStream = vi.fn()
const addMemory = vi.fn(() => 'mem-1')
/** The `AbortSignal` the extraction's last `chatStream` call was given, so a
 *  test can check whether `stopAllBackgroundWork` actually reached it. */
let lastSignal: AbortSignal | undefined

let activeModel = 'qwen3:8b'

vi.mock('../../stores/modelStore', () => ({
  useModelStore: { getState: () => ({ activeModel, models: [] }) },
}))
// Stable references for `settings` and `entries`: `extractMemoriesFromPair`'s
// own write guard compares `getState().entries` against the snapshot it took
// at the start via `!==`, exactly the check that catches a memory edited
// underneath a running extraction. A mock that hands back a FRESH array or
// object literal on every call looks changed on every read, exactly like a
// real edit, and the guard correctly revokes the whole call before it ever
// reaches `chatStream`.
const memorySettings = { autoExtractEnabled: true, autoExtractInAllModes: false }
const memoryEntries: unknown[] = []
vi.mock('../../stores/memoryStore', () => ({
  useMemoryStore: {
    getState: () => ({
      settings: memorySettings,
      entries: memoryEntries,
      addMemory,
      removeMemory: vi.fn(),
      applyWriteDecision: vi.fn(),
    }),
  },
}))
vi.mock('../../stores/providerStore', () => ({
  useProviderStore: {
    getState: () => ({
      providers: { openai: { enabled: true, isLocal: true }, anthropic: { enabled: false } },
    }),
  },
}))
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ settings: { memoryCloudOptIn: false, contextWindowOverride: 0 } }),
  },
}))
vi.mock('../../api/providers', () => ({
  getProviderForModel: () => ({ provider: { chatStream }, modelId: 'qwen3:8b' }),
  getProviderIdFromModel: () => 'ollama',
}))
vi.mock('../../api/rag', () => ({
  generateEmbeddings: vi.fn(async () => [[]]),
  cosineSimilarity: vi.fn(() => 0),
}))
vi.mock('../../lib/memoryEmbedDB', () => ({
  loadVectors: vi.fn(async () => new Map()),
}))

const { extractMemoriesFromPair } = await import('../useMemory')

/** A stream that hangs until its `signal` aborts, mirroring the shape a real provider stream
 *  takes when its underlying fetch is cancelled mid-flight. */
function haengenderStream(signal?: AbortSignal) {
  return (async function* () {
    yield { content: '', done: false }
    await new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
    yield { content: '{"shouldSave": false, "memories": []}', done: true }
  })()
}

beforeEach(() => {
  __resetRunLanesForTests()
  useGenerationStore.setState({ generating: {}, aborters: {}, runs: {} })
  useAgentTaskStore.setState({ byConv: {} })
  useAgentLoopStore.setState({ loops: {} })
  chatStream.mockReset()
  chatStream.mockImplementation((_model: string, _messages: unknown, options?: { signal?: AbortSignal }) => {
    lastSignal = options?.signal
    return haengenderStream(options?.signal)
  })
  addMemory.mockClear()
  useCloudAuthStore.getState().setSignedOut()
  lastSignal = undefined
  activeModel = 'qwen3:8b'
})

const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const digest = { sourceKind: 'voice' as const, digest: true, contextWindow: undefined }

describe('a silent run yields to the model controls', () => {
  it('ends a running voice digest: the request is aborted, nothing is saved, the lane is free', async () => {
    const run = extractMemoriesFromPair('what was said', 'x'.repeat(200), 'voice-1', digest)
    await tick()
    expect(chatStream).toHaveBeenCalledTimes(1)
    expect(localLaneHolder()).toBe('voice-1::memory-extraction')
    expect(lastSignal?.aborted).toBe(false)

    // Somebody else is already waiting for the local model.
    expect(admit('local', 'chat-2', () => {})).toBe('queued')

    expect(yieldSilentLocalRuns()).toBe(1)

    // The signal the provider was handed is the one that closes the request.
    expect(lastSignal?.aborted).toBe(true)
    await expect(run).resolves.toBeUndefined()
    expect(addMemory).not.toHaveBeenCalled()
    expect(localLaneHolder()).toBe('chat-2')
    expect(useGenerationStore.getState().runs['voice-1::memory-extraction']).toBeUndefined()
  })

  it('takes a queued digest out of the line without touching the turn in front of it', async () => {
    expect(admit('local', 'chat-1', () => {})).toBe('started')
    const run = extractMemoriesFromPair('what was said', 'x'.repeat(200), 'voice-1', digest)
    await tick()
    expect(queuedRunIds()).toEqual(['voice-1::memory-extraction'])

    expect(yieldSilentLocalRuns()).toBe(1)
    await run

    expect(chatStream).not.toHaveBeenCalled()
    expect(addMemory).not.toHaveBeenCalled()
    expect(queuedRunIds()).toEqual([])
    expect(localLaneHolder()).toBe('chat-1')
    release('chat-1')
  })

  it('leaves a visible local turn and a hosted silent run alone', async () => {
    const chatAbort = vi.fn()
    const hostedAbort = vi.fn()
    let endChat: () => void = () => {}
    let endHosted: () => void = () => {}
    const chat = runInLane({ conversationId: 'chat-1', lane: 'local', abort: chatAbort }, () => new Promise<void>((r) => { endChat = r }))
    const hosted = runInLane({ conversationId: 'chat-9::memory-extraction', lane: 'cloud', abort: hostedAbort }, () => new Promise<void>((r) => { endHosted = r }))
    await tick()

    expect(yieldSilentLocalRuns()).toBe(0)
    expect(chatAbort).not.toHaveBeenCalled()
    expect(hostedAbort).not.toHaveBeenCalled()

    endChat(); endHosted()
    await Promise.all([chat, hosted])
  })

  it('is safe when nothing runs', () => {
    expect(yieldSilentLocalRuns()).toBe(0)
  })
})

describe('every model control calls it', () => {
  const read = (path: string) => readFileSync(resolve(__dirname, '../..', path), 'utf8')
  const bodyOf = (source: string, start: string, length = 900) => {
    const at = source.indexOf(start)
    expect(at, start).toBeGreaterThan(-1)
    return source.slice(at, at + length)
  }

  it('the pick, both row switches and "Unload all models" in the model selector', () => {
    const selector = read('components/models/ModelSelector.tsx')
    expect(bodyOf(selector, 'const handleSelectModel = async')).toContain('yieldSilentLocalRuns()')
    expect(bodyOf(selector, 'const toggleOllamaLoad = async')).toContain('yieldSilentLocalRuns()')
    expect(bodyOf(selector, 'const toggleLmStudioLoad = async')).toContain('yieldSilentLocalRuns()')
    const unloadAll = selector.indexOf('await unloadEverything(')
    expect(selector.slice(unloadAll - 200, unloadAll)).toContain('yieldSilentLocalRuns()')
  })

  it('the load button in the header', () => {
    expect(bodyOf(read('components/layout/Header.tsx'), 'const handleLoad = async')).toContain('yieldSilentLocalRuns()')
  })

  it('the extraction books under the id the function looks for', () => {
    expect(read('hooks/useMemory.ts')).toContain('conversationId: memoryExtractionRunId(conversationId)')
  })
})
