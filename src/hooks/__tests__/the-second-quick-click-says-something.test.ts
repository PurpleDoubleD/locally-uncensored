/**
 * @vitest-environment jsdom
 *
 * A16 (A14-6), Windows counter-check 02.09.: two LU Engine tiles clicked
 * 150 ms apart. Exactly one engine started, which is the point of the bolt and
 * was right. The second click, though, "verpufft ohne jede Rueckmeldung": no
 * queue, no line, nothing. Round 5 had written a sentence for exactly this
 * ("The LU Engine is still switching, one moment.") and the counter-check
 * never saw it.
 *
 * Two reasons, and both are fixed here.
 *
 *  1. The composer's picker never reached the sentence at all. One line above
 *     the bolt sat `if (selectingLms || togglingLms) return`, a silent early
 *     return on the component's own in-flight state, so on that door a quick
 *     second pick fell out before anything could be said.
 *
 *  2. On the door where the line WAS written, the Installed tile, it was on
 *     the ordinary twelve second clock. A cold multi-gigabyte GGUF outlives
 *     that, so the line could clear itself while the swap it describes was
 *     still running, leaving behind the same silence that made the user click
 *     twice. It stands while the swap does now.
 *
 * Run: npx vitest run src/hooks/__tests__/the-second-quick-click-says-something.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const activateBuiltinModel = vi.fn(async () => true)

vi.mock('../../api/backend', () => ({
  isTauri: () => true, isMacOS: () => false, isWindows: () => true, isLinux: () => false,
  backendCall: vi.fn(async () => null),
  secretGet: vi.fn().mockRejectedValue(new Error('no vault')),
  secretSet: vi.fn(), secretDelete: vi.fn(),
}))
vi.mock('../../api/comfyui', () => ({
  getInstalledImageModels: vi.fn(async () => []),
  getInstalledVideoModels: vi.fn(async () => []),
  checkComfyConnection: vi.fn(async () => false),
  readModelDiskSizes: vi.fn(async () => new Map()),
}))
vi.mock('../../api/ollama', () => ({
  listModels: vi.fn(async () => []), unloadModel: vi.fn(async () => undefined),
  pullModel: vi.fn(), pullModelTauri: vi.fn(), deleteModel: vi.fn(), showModel: vi.fn(),
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
    isManagedBuiltinActive: () => true,
    bundledEngineStatus: vi.fn(async () => ({ running: true, healthy: true, port: 8127 })),
    bundledEmbedStatus: vi.fn(async () => ({ running: true, healthy: true, port: 8128 })),
    startBundledEmbed: vi.fn(),
    activateBuiltinModel: (...a: unknown[]) => activateBuiltinModel(...(a as [])),
  }
})

const { useModels } = await import('../useModels')
const { useModelStore } = await import('../../stores/modelStore')
const { useProviderStore } = await import('../../stores/providerStore')
const { useLuEngineSwitchStore, LU_ENGINE_SWITCH_NOTE_MS, HOLD_CHECK_MS } = await import('../../stores/luEngineSwitchStore')
const { LU_ENGINE_SWAP_BUSY_NOTE } = await import('../../api/lu-engine-switch')
const { __resetLuEngineSwapLockForTests } = await import('../../api/lu-engine-swap-lock')

// The two tiles the counter-check clicked, in the state it clicked them in:
// the LU Engine already holds the chat, so the first click has nothing to
// announce and the only line that can appear is the one for the second.
const FIRST = 'openai::Phi-4-mini-instruct-Q4_K_M'
const SECOND = 'openai::mlabonne_gemma-3-4b-it-abliterated-Q4_K_M'

/** The gap the counter-check used between the two clicks. */
const CLICK_GAP_MS = 150

beforeEach(() => {
  vi.useFakeTimers()
  activateBuiltinModel.mockReset()
  activateBuiltinModel.mockResolvedValue(true)
  useLuEngineSwitchStore.setState({ note: null, tone: 'info', generation: 0 })
  __resetLuEngineSwapLockForTests()
  useProviderStore.getState().resetProvidersToDefaults()
  useProviderStore.getState().setProviderConfig('openai', {
    enabled: true, managed: true, name: 'LU Engine', baseUrl: 'http://127.0.0.1:8127/v1',
  })
  useModelStore.setState({
    models: [
      { name: FIRST, model: 'Phi-4-mini-instruct-Q4_K_M', size: 1, type: 'text', provider: 'openai', providerName: 'LU Engine' },
      { name: SECOND, model: 'mlabonne_gemma-3-4b-it-abliterated-Q4_K_M', size: 1, type: 'text', provider: 'openai', providerName: 'LU Engine' },
    ] as never,
    activeModel: FIRST,
  })
})
afterEach(() => { vi.useRealTimers(); __resetLuEngineSwapLockForTests() })

describe('two LU Engine tiles clicked 150 ms apart', () => {
  it('tells the user the second one is waiting, not broken', async () => {
    // A swap that does not finish on its own: exactly the window the second
    // click lands in.
    let release: (v: boolean) => void = () => {}
    activateBuiltinModel.mockImplementation(() => new Promise<boolean>((r) => { release = r }))

    const { result } = renderHook(() => useModels())
    await act(async () => { void result.current.setActiveModel(FIRST) })
    expect(useLuEngineSwitchStore.getState().note, 'the first click had nothing to report').toBeNull()

    await act(async () => { await vi.advanceTimersByTimeAsync(CLICK_GAP_MS) })
    await act(async () => { void result.current.setActiveModel(SECOND) })

    expect(useLuEngineSwitchStore.getState().note).toBe(LU_ENGINE_SWAP_BUSY_NOTE)
    expect(useLuEngineSwitchStore.getState().tone, 'a wait is not a failure').toBe('info')
    // And the bolt did its own job: one swap, on the first tile.
    expect(activateBuiltinModel).toHaveBeenCalledTimes(1)
    expect(activateBuiltinModel).toHaveBeenCalledWith(FIRST)

    await act(async () => { release(true); await Promise.resolve() })
  })

  it('leaves the line standing while the swap it describes is still running', async () => {
    // The counter-check's screenshot of this case shows no line at all. A
    // multi-gigabyte GGUF loading off a cold disk outlives the twelve seconds
    // an info line normally gets, and a sentence that says "still switching"
    // must not leave before the switching does.
    let release: (v: boolean) => void = () => {}
    activateBuiltinModel.mockImplementation(() => new Promise<boolean>((r) => { release = r }))

    const { result } = renderHook(() => useModels())
    await act(async () => { void result.current.setActiveModel(FIRST) })
    await act(async () => { await vi.advanceTimersByTimeAsync(CLICK_GAP_MS) })
    await act(async () => { void result.current.setActiveModel(SECOND) })

    await act(async () => { await vi.advanceTimersByTimeAsync(LU_ENGINE_SWITCH_NOTE_MS * 2) })
    expect(
      useLuEngineSwitchStore.getState().note,
      'the line walked off while the swap was still going',
    ).toBe(LU_ENGINE_SWAP_BUSY_NOTE)

    // NEGATIVE CONTROL in the same frame: it is a hold, not a line that never
    // goes away. Once the swap is done it clears on the normal clock.
    //
    // Geaendert 04.09.2026: die Uhr laeuft jetzt AB dem Ende des Halts, nicht
    // im Zwoelf-Sekunden-Raster darueber hinweg. Der Nutzer bekommt seine
    // volle Lesezeit, nachdem die Zeile wahr geworden ist, also dauert das
    // Raeumen hier eine Nachsehrunde laenger. Genau darum geht der Fix.
    await act(async () => { release(true); await Promise.resolve(); await Promise.resolve() })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_CHECK_MS + LU_ENGINE_SWITCH_NOTE_MS + 100)
    })
    expect(useLuEngineSwitchStore.getState().note, 'the line never left').toBeNull()
  })

  // NEGATIVE CONTROL: a single click still says nothing when there is nothing
  // to say. Otherwise the fix would be a line on every pick.
  it('says nothing at all when only one tile is clicked', async () => {
    const { result } = renderHook(() => useModels())
    await act(async () => { await result.current.setActiveModel(SECOND) })
    expect(useLuEngineSwitchStore.getState().note).toBeNull()
    expect(useModelStore.getState().activeModel).toBe(SECOND)
  })

  // The picker has no render harness (see model-selector-lms.test.ts), so its
  // half is pinned by reading the source. The weaker proof, and labelled as
  // such: it catches the silent early return coming back, not a picker that
  // fails to render.
  it('and the composer picker no longer drops the second pick in silence', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../components/models/ModelSelector.tsx'),
      'utf8',
    )
    // The LU Engine branch: one condition, one answer, and the bolt asked last
    // so a blocked pick does not take it.
    expect(src).toContain('if (selectingLms || togglingLms || !tryAcquireLuEngineSwap()) {')
    expect(src, 'and it says so on the standing row, not only in the dropdown')
      .toContain('announceLuEngineSwapBusy()')
    // The shape that hid the sentence: a bare `return` on the component's own
    // in-flight state, above the bolt.
    expect(src, 'the silent early return is back').not.toContain('if (selectingLms || togglingLms) return\n      // A14 fourth review')
  })
})
