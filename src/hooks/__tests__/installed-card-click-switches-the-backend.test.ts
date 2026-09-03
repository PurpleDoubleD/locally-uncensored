/**
 * @vitest-environment jsdom
 *
 * A14 second review, the heavy one: a click on an LU Engine card under
 * Installed did half the job, and the half it skipped was the point.
 *
 * The guard on the activation path asked "is the openai slot already ours".
 * With Ollama in front the answer is no, so a click wrote openai::<gguf> into
 * the store, unloaded the Ollama model to make room for a model nobody was
 * starting, and then switched nothing and started nothing. The user was left
 * on a model that answers from nowhere, with his Ollama model evicted, and no
 * line on screen saying anything had happened.
 *
 * The Use button on Discover and the composer's picker both did the whole job
 * already. This drives the third door, the Installed card, through the same
 * route: hand the slot over, announce it, then start the engine.
 *
 * Run: npx vitest run src/hooks/__tests__/installed-card-click-switches-the-backend.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const activateBuiltinModel = vi.fn(async () => true)
const unloadModel = vi.fn(async () => undefined)

vi.mock('../../api/backend', () => ({
  isTauri: () => true,
  isMacOS: () => true,
  isWindows: () => false,
  isLinux: () => false,
  backendCall: vi.fn(async () => null),
  secretGet: vi.fn().mockRejectedValue(new Error('no vault')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))
vi.mock('../../api/comfyui', () => ({
  getInstalledImageModels: vi.fn(async () => []),
  getInstalledVideoModels: vi.fn(async () => []),
  checkComfyConnection: vi.fn(async () => false),
  readModelDiskSizes: vi.fn(async () => new Map()),
}))
vi.mock('../../api/ollama', () => ({
  listModels: vi.fn(async () => []),
  unloadModel: (...a: unknown[]) => unloadModel(...(a as [])),
  pullModel: vi.fn(),
  pullModelTauri: vi.fn(),
  deleteModel: vi.fn(),
  showModel: vi.fn(),
}))
vi.mock('../../api/providers', async () => {
  const actual = await vi.importActual<typeof import('../../api/providers')>('../../api/providers')
  return { ...actual, getEnabledProviders: () => [] }
})
vi.mock('../../api/engine', async () => {
  const actual = await vi.importActual<typeof import('../../api/engine')>('../../api/engine')
  return {
    ...actual,
    listBundledModels: vi.fn(async () => []),
    isManagedBuiltinActive: () => false,
    bundledEngineStatus: vi.fn(async () => ({ running: true, healthy: true, port: 8127 })),
    bundledEmbedStatus: vi.fn(async () => ({ running: true, healthy: true, port: 8128 })),
    startBundledEmbed: vi.fn(),
    activateBuiltinModel: (...a: unknown[]) => activateBuiltinModel(...(a as [])),
  }
})

const { useModels } = await import('../useModels')
const { useModelStore } = await import('../../stores/modelStore')
const { useProviderStore } = await import('../../stores/providerStore')
const { useLuEngineSwitchStore } = await import('../../stores/luEngineSwitchStore')
const { LU_ENGINE_SWAP_BUSY_NOTE } = await import('../../api/lu-engine-switch')
const {
  tryAcquireLuEngineSwap, releaseLuEngineSwap, __resetLuEngineSwapLockForTests,
} = await import('../../api/lu-engine-swap-lock')

const GGUF = 'openai::Qwen2.5-0.5B-Instruct-Q8_0'
const SECOND_GGUF = 'openai::gemma-3-4b-it-Q4_K_M'
const OLLAMA = 'llama3.2:3b'
const SWITCH_NOTE = 'Switched your chat provider to the LU Engine for this model.'

/** The Installed list as David's Mac draws it: an Ollama model in front, two
 *  GGUFs from the LU Engine folder beside it. */
function installedList() {
  return [
    { name: OLLAMA, model: OLLAMA, size: 1, type: 'text', provider: 'ollama', providerName: 'Ollama' },
    { name: GGUF, model: 'Qwen2.5-0.5B-Instruct-Q8_0', size: 1, type: 'text', provider: 'openai', providerName: 'LU Engine' },
    { name: SECOND_GGUF, model: 'gemma-3-4b-it-Q4_K_M', size: 1, type: 'text', provider: 'openai', providerName: 'LU Engine' },
  ] as never
}

/** The click ModelManager's card makes. */
async function clickCard(name: string) {
  const { result } = renderHook(() => useModels())
  await act(async () => { result.current.setActiveModel(name) })
  return result
}

beforeEach(() => {
  activateBuiltinModel.mockReset()
  activateBuiltinModel.mockResolvedValue(true)
  unloadModel.mockClear()
  useLuEngineSwitchStore.setState({ note: null, tone: 'info', generation: 0 })
  // The bolt is app state, not hook state, so a test that leaves it shut would
  // silently block every test after it.
  __resetLuEngineSwapLockForTests()
  useProviderStore.getState().resetProvidersToDefaults()
  // Ollama in front, the openai slot parked, which is what onboarding leaves
  // behind when the user picks Ollama.
  useProviderStore.getState().setProviderConfig('ollama', { enabled: true })
  useProviderStore.getState().setProviderConfig('openai', { enabled: false, managed: false })
  useModelStore.setState({ models: installedList(), activeModel: OLLAMA })
})

describe('clicking an LU Engine card while Ollama holds the chat', () => {
  it('hands the chat slot to the LU Engine', async () => {
    await clickCard(GGUF)
    const slot = useProviderStore.getState().providers.openai
    expect(slot.enabled, 'the slot has to be on for anything to route there').toBe(true)
    expect(slot.managed, 'and it has to be OUR engine in it').toBe(true)
    expect(slot.name).toBe('LU Engine')
  })

  it('starts the engine on that GGUF', async () => {
    await clickCard(GGUF)
    expect(activateBuiltinModel).toHaveBeenCalledWith(GGUF)
  })

  it('says on screen that the chat backend moved', async () => {
    await clickCard(GGUF)
    expect(useLuEngineSwitchStore.getState().note).toBe(SWITCH_NOTE)
    expect(useLuEngineSwitchStore.getState().tone, 'nothing went wrong yet').toBe('info')
  })

  it('and the model really is the active one afterwards', async () => {
    await clickCard(GGUF)
    expect(useModelStore.getState().activeModel).toBe(GGUF)
  })

  // NEGATIVE CONTROL: a click on the Ollama card is untouched by all of this.
  // It must not move the slot, must not start the engine, and must not print a
  // line about a switch that never happened.
  it('leaves an Ollama card alone', async () => {
    useModelStore.setState({ activeModel: GGUF })
    await clickCard(OLLAMA)
    expect(useProviderStore.getState().providers.openai.managed).not.toBe(true)
    expect(activateBuiltinModel).not.toHaveBeenCalled()
    expect(useLuEngineSwitchStore.getState().note).toBeNull()
  })

  // NEGATIVE CONTROL: with the LU Engine already in front there is no switch,
  // so no line, but the GGUF swap still has to happen.
  it('swaps without announcing when the engine already held the chat', async () => {
    useProviderStore.getState().setProviderConfig('openai', { enabled: true, managed: true, name: 'LU Engine' })
    await clickCard(GGUF)
    expect(activateBuiltinModel).toHaveBeenCalledWith(GGUF)
    expect(useLuEngineSwitchStore.getState().note).toBeNull()
  })

  // NEGATIVE CONTROL: an LM Studio row shares provider id 'openai' with ours.
  // Clicking it must not hand the slot to our engine and evict LM Studio.
  it('never mistakes an LM Studio row for one of ours', async () => {
    const LMS = 'openai::qwen2.5-0.5b-instruct'
    useModelStore.setState({
      models: [{ name: LMS, model: 'qwen2.5-0.5b-instruct', size: 1, type: 'text', provider: 'openai', providerName: 'LM Studio' }] as never,
      activeModel: null,
    })
    useProviderStore.getState().setProviderConfig('openai', { enabled: true, managed: false, name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' })
    await clickCard(LMS)
    expect(useProviderStore.getState().providers.openai.name).toBe('LM Studio')
    expect(useLuEngineSwitchStore.getState().note).toBeNull()
  })
})

// ── A14 third review: a start that dies must not look like a start ──────────

describe('when the engine does not come up for the card that was clicked', () => {
  it('names the real reason instead of swallowing it', async () => {
    activateBuiltinModel.mockRejectedValue(new Error('llama-server exited: unknown model architecture'))
    await clickCard(GGUF)
    const { note, tone } = useLuEngineSwitchStore.getState()
    // The picker's sentence, word for word, from the shared helper.
    expect(note).toContain('Couldn\'t start the LU Engine with "Qwen2.5-0.5B-Instruct-Q8_0"')
    // Including the tail Rust appends, which is the whole point of showing it.
    expect(note).toContain('unknown model architecture')
    expect(tone, 'a dead engine is not a quiet grey line').toBe('error')
  })

  it('keeps saying that the chat backend has already moved', async () => {
    // The slot was handed over BEFORE the start, and the Ollama model was
    // unloaded to make room. A failure that only names the failure would leave
    // the user guessing what he is talking to now.
    activateBuiltinModel.mockRejectedValue(new Error('port 8127 is taken'))
    await clickCard(GGUF)
    const note = useLuEngineSwitchStore.getState().note
    expect(note, 'the switch sentence has to survive the failure').toContain(SWITCH_NOTE)
    expect(note, 'and stand beside the failure, not instead of it').toContain('port 8127 is taken')
    expect(useProviderStore.getState().providers.openai.managed).toBe(true)
  })

  it('treats a false answer as a failure too, and says which file is gone', async () => {
    // activateBuiltinModel answers false when it cannot resolve the GGUF path,
    // even after refreshing the list once. Nothing was started.
    activateBuiltinModel.mockResolvedValue(false)
    await clickCard(GGUF)
    const { note, tone } = useLuEngineSwitchStore.getState()
    expect(note).toContain('Couldn\'t start the LU Engine with "Qwen2.5-0.5B-Instruct-Q8_0"')
    expect(note).toContain('not in the LU Engine folder any more')
    expect(tone).toBe('error')
  })

  // NEGATIVE CONTROL: a start that works says nothing about a failure, and the
  // line stays the quiet one.
  it('says nothing of the sort when the start works', async () => {
    await clickCard(GGUF)
    expect(useLuEngineSwitchStore.getState().note).toBe(SWITCH_NOTE)
    expect(useLuEngineSwitchStore.getState().tone).toBe('info')
  })
})

// ── A14 third review: one swap at a time, as in the picker ─────────────────

describe('two LU Engine cards clicked in quick succession', () => {
  it('send one swap, not two', async () => {
    // Two cards, two clicks, and the first swap still running. Without the
    // bolt this is two swap_bundled_model calls at one engine, the second one
    // landing on a process the first is still restarting.
    let release: (v: boolean) => void = () => {}
    activateBuiltinModel.mockImplementation(() => new Promise<boolean>((r) => { release = r }))
    const { result } = renderHook(() => useModels())
    await act(async () => {
      result.current.setActiveModel(GGUF)
      result.current.setActiveModel(SECOND_GGUF)
    })
    expect(activateBuiltinModel).toHaveBeenCalledTimes(1)
    expect(activateBuiltinModel).toHaveBeenCalledWith(GGUF)
    // The blocked click changed nothing else either: it never reached the
    // store, so the engine is still pointed at the first card.
    expect(useModelStore.getState().activeModel).toBe(GGUF)

    // NEGATIVE CONTROL in the same frame: the bolt is a bolt, not a lock. Once
    // the first swap is done the next click gets through. Counted as "more
    // than before" rather than as an exact number, because the store's own
    // chokepoint swaps built-in to built-in as well and Rust's argv
    // idempotence makes that pair a no-op (modelStore.ts).
    await act(async () => { release(true) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const before = activateBuiltinModel.mock.calls.length
    await act(async () => { result.current.setActiveModel(SECOND_GGUF) })
    expect(activateBuiltinModel.mock.calls.length).toBeGreaterThan(before)
    expect(activateBuiltinModel).toHaveBeenLastCalledWith(SECOND_GGUF)
    await act(async () => { release(true) })
  })

  // NEGATIVE CONTROL: the bolt belongs to the LU Engine path only. An Ollama
  // card clicked while a swap is running is not blocked by it.
  it('never blocks a click on another backend', async () => {
    let release: (v: boolean) => void = () => {}
    activateBuiltinModel.mockImplementation(() => new Promise<boolean>((r) => { release = r }))
    const { result } = renderHook(() => useModels())
    await act(async () => { result.current.setActiveModel(GGUF) })
    await act(async () => { result.current.setActiveModel(OLLAMA) })
    expect(useModelStore.getState().activeModel).toBe(OLLAMA)
    await act(async () => { release(true) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  })
})

// ── A14 fourth review: the card and the picker are two doors, one engine ────

describe('the bolt is shared with the composer picker', () => {
  it('a swap the picker started blocks a card click', async () => {
    // Exactly what ModelSelector does one line before it calls
    // activateBuiltinModel. Before the bolt was shared, the card knew nothing
    // about this and sent a second swap_bundled_model at a llama-server the
    // picker's swap was still restarting.
    expect(tryAcquireLuEngineSwap(), 'the picker holds it').toBe(true)
    await clickCard(GGUF)
    expect(activateBuiltinModel, 'one engine, one swap').not.toHaveBeenCalled()
    // And the blocked click left the chat exactly where it was: the bolt is
    // taken BEFORE the slot is handed over, so nothing was evicted for a swap
    // that never happened.
    expect(useModelStore.getState().activeModel).toBe(OLLAMA)
    expect(useProviderStore.getState().providers.openai.managed).not.toBe(true)
  })

  // A14 fourth review, the small half: the blocked click returned in silence,
  // and a button that does nothing gets clicked again.
  it('and says so instead of doing nothing', async () => {
    tryAcquireLuEngineSwap()
    await clickCard(GGUF)
    expect(useLuEngineSwitchStore.getState().note).toBe(LU_ENGINE_SWAP_BUSY_NOTE)
    expect(useLuEngineSwitchStore.getState().tone, 'a wait is not a failure').toBe('info')
  })

  it('and a card swap blocks the picker the same way round', async () => {
    let release: (v: boolean) => void = () => {}
    activateBuiltinModel.mockImplementation(() => new Promise<boolean>((r) => { release = r }))
    const { result } = renderHook(() => useModels())
    await act(async () => { result.current.setActiveModel(GGUF) })
    expect(tryAcquireLuEngineSwap(), 'the picker asks this before it swaps').toBe(false)

    // NEGATIVE CONTROL in the same frame: a bolt that never opens is a lock.
    await act(async () => { release(true) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(tryAcquireLuEngineSwap(), 'the card is done, the picker may go').toBe(true)
    releaseLuEngineSwap()
  })

  // NEGATIVE CONTROL: an engine that refuses to start must free the next
  // click, or one bad GGUF takes the model list down for the session.
  it('frees the bolt after a swap that was rejected', async () => {
    activateBuiltinModel.mockRejectedValue(new Error('llama-server exited'))
    await clickCard(GGUF)
    expect(tryAcquireLuEngineSwap(), 'a failed start is a finished start').toBe(true)
    releaseLuEngineSwap()
  })

  // The picker itself has no render harness (see model-selector-lms.test.ts),
  // so its half of the wiring is pinned by reading the source. The weaker
  // proof, and labelled as such: it catches the picker going back to a bolt of
  // its own, not a picker that fails to render.
  it('and the picker really goes through the shared bolt', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../components/models/ModelSelector.tsx'),
      'utf8',
    )
    expect(src).toContain("from '../../api/lu-engine-swap-lock'")
    // A16: the picker's own in-flight state and the shared bolt are one
    // condition now, with the bolt asked last so it is only taken when the
    // other two are clear.
    expect(src).toContain('if (selectingLms || togglingLms || !tryAcquireLuEngineSwap()) {')
    expect(src, 'and a blocked pick says so on both surfaces').toContain('announceLuEngineSwapBusy()')
    expect(src, 'and gives it back in a finally').toContain('releaseLuEngineSwap()')
  })
})
