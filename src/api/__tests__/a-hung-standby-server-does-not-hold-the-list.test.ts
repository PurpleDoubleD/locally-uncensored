/**
 * A16 counter-check follow-up 02.09.: `listStandbyBackendModels` is awaited in
 * the middle of `fetchModels`, in front of the LU Engine rows, the Ollama rows
 * and the whole ComfyUI inventory. A standby server that accepts the
 * connection and then says nothing held every one of them up, on every
 * refresh, for as long as the platform's own timeout ran.
 *
 * That is not an exotic server: LM Studio loading a large model off a busy
 * disk does exactly this. The cost of giving up early is one missing heading
 * until the next refresh; the cost of waiting is an empty Models page.
 *
 * Run: npx vitest run src/api/__tests__/a-hung-standby-server-does-not-hold-the-list.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const listModels = vi.fn()

vi.mock('../providers/openai-provider', () => ({
  OpenAIProvider: class {
    listModels() { return listModels() }
  },
}))
vi.mock('../backend', () => ({
  isTauri: () => false, isMacOS: () => false, isWindows: () => false, isLinux: () => false,
  backendCall: vi.fn(async () => null),
  secretGet: vi.fn().mockRejectedValue(new Error('no vault')),
  secretSet: vi.fn(), secretDelete: vi.fn(),
}))

const { listStandbyBackendModels, STANDBY_MODEL_LIST_TIMEOUT_MS } = await import('../lu-engine-switch')

const LM_STUDIO = { name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', isLocal: true }

beforeEach(() => {
  vi.useFakeTimers()
  listModels.mockReset()
})
afterEach(() => { vi.useRealTimers() })

describe('the standby backend asked for its models', () => {
  it('gives up on a server that never answers, with an empty list', async () => {
    // The hang: connected, and then nothing. Never settles on its own.
    listModels.mockImplementation(() => new Promise(() => {}))

    const asked = listStandbyBackendModels(LM_STUDIO)
    await vi.advanceTimersByTimeAsync(STANDBY_MODEL_LIST_TIMEOUT_MS + 50)

    await expect(asked, 'the model list is still waiting on a dead server').resolves.toEqual([])
  })

  it('and the list is not held up for longer than the budget', async () => {
    listModels.mockImplementation(() => new Promise(() => {}))
    let settled = false
    void listStandbyBackendModels(LM_STUDIO).then(() => { settled = true })

    await vi.advanceTimersByTimeAsync(STANDBY_MODEL_LIST_TIMEOUT_MS - 100)
    expect(settled, 'it gave up before its own budget was spent').toBe(false)

    await vi.advanceTimersByTimeAsync(200)
    expect(settled, 'it was still waiting after the budget').toBe(true)
  })

  // NEGATIVE CONTROL: a server that answers in time is passed straight
  // through. Without this the fix could be "always return nothing".
  it('passes a real answer through untouched', async () => {
    const rows = [{ id: 'qwen2.5-0.5b-instruct@q4_k_m', name: 'qwen2.5-0.5b-instruct@q4_k_m' }]
    listModels.mockResolvedValue(rows)

    await expect(listStandbyBackendModels(LM_STUDIO)).resolves.toEqual(rows)
  })

  // NEGATIVE CONTROL: a refused connection still rejects, exactly as before.
  // The caller's catch is what turns that into "no rows", and swallowing it
  // here would take a real error away from a lane that already handles it.
  it('still throws when the server refuses outright', async () => {
    listModels.mockRejectedValue(new Error('connection refused'))
    await expect(listStandbyBackendModels(LM_STUDIO)).rejects.toThrow('connection refused')
  })
})
