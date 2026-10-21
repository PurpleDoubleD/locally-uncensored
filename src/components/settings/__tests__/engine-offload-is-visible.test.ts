/**
 * @vitest-environment jsdom
 *
 * 3.0.0 leftover, found 2026-09-11: the CPU fallback had no surface.
 *
 * Commit ccdc2d14 gave the engine a second start attempt that drops GPU
 * offload when the first one dies with layers on the card, and a layer count
 * measured against free graphics memory instead of a flat `-ngl 999`. Both
 * worked. Neither could be seen: `start_bundled_engine` answered
 * `cpuOnly: true` in the return value of one call, every caller read `.port`
 * out of that object and threw the rest away, and the layer count lived in the
 * argv and the log file. A user whose card could not hold the model got an
 * engine that looked ordinary, said nothing, and answered at a tenth of the
 * speed.
 *
 * Two surfaces, because the two facts have different lifetimes: the fallback
 * is an event and goes to the standing line above the composer, the layer
 * count is a condition and goes where Settings already names model, context
 * and port.
 *
 * Run: npx vitest run src/components/settings/__tests__/engine-offload-is-visible.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, act } from '@testing-library/react'

const backendCall = vi.fn()
vi.mock('../../../api/backend', () => ({
  backendCall: (cmd: string, args?: unknown) => backendCall(cmd, args),
  isTauri: () => true,
  isMacOS: () => false,
  isLinux: () => false,
  isWindows: () => false,
  openExternal: vi.fn(),
  secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))

const { engineOffloadLine, announceEngineCpuFallback, engineStandingNote, ENGINE_CPU_ONLY_NOTE, __resetEngineCpuFallbackNote } =
  await import('../../../lib/engine-offload')
const { bundledEngineStatus } = await import('../../../api/engine')
const { useLuEngineSwitchStore } = await import('../../../stores/luEngineSwitchStore')
const { BuiltinEngineSettings } = await import('../BuiltinEngineSettings')
const { LuEngineSwitchBar } = await import('../../chat/LuEngineSwitchBar')

/** A running engine that took the whole model onto the card. The ordinary one. */
const AUF_DER_KARTE = {
  running: true, healthy: true, port: 8127,
  model_path: '/m/phi.gguf', ctx: 8192, cpuOnly: false, gpuLayers: null,
}

/** The same engine after the GPU attempt died and the retry took the card out. */
const AUF_DEM_PROZESSOR = { ...AUF_DER_KARTE, cpuOnly: true, gpuLayers: 0 }

/** Bug a: the card came up, answered the sanity probe in question marks, and
 *  the ladder moved the engine to the processor. Sentence as Rust writes it. */
const SALAT_AUF_DEM_PROZESSOR = {
  ...AUF_DEM_PROZESSOR,
  sanityNote: 'The GPU produced unreadable output, the engine was restarted on the CPU. Please send the log file from Settings > Troubleshoot.',
}

/** Bug a, first rung: the same card kept its layers and lost Flash Attention. */
const OHNE_FLASH_ATTENTION = {
  ...AUF_DER_KARTE,
  gpuLayers: 18,
  sanityNote: 'The GPU produced unreadable output, the engine was restarted with Flash Attention switched off and reads correctly now. Please send the log file from Settings > Troubleshoot.',
}

beforeEach(() => {
  backendCall.mockReset()
  backendCall.mockResolvedValue({})
  __resetEngineCpuFallbackNote()
  useLuEngineSwitchStore.getState().dismiss()
})
afterEach(() => { cleanup(); vi.useRealTimers() })

/** Mount the expert panel over one status answer and read its offload line. */
async function panel(status: unknown): Promise<string | null> {
  backendCall.mockImplementation(async (cmd: string) =>
    cmd === 'bundled_engine_status' ? status : {})
  render(createElement(BuiltinEngineSettings))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  return screen.queryByTestId('builtin-engine-offload')?.textContent ?? null
}

/** Read one status through the app's own wrapper, then draw the standing line. */
async function standingLine(status: unknown): Promise<HTMLElement | null> {
  backendCall.mockImplementation(async (cmd: string) =>
    cmd === 'bundled_engine_status' ? status : {})
  await act(async () => { await bundledEngineStatus() })
  render(createElement(LuEngineSwitchBar))
  return screen.queryByTestId('lu-engine-switch-note')
}

describe('the line itself', () => {
  it('says the card was taken out, not just that nought layers went on it', () => {
    expect(engineOffloadLine(AUF_DEM_PROZESSOR)).toBe('GPU layers: 0, the GPU start failed')
  })

  it('names a measured layer count', () => {
    expect(engineOffloadLine({ running: true, gpuLayers: 18 })).toBe('GPU layers: 18')
  })

  it('identifies an engine fit without claiming a measured or full layer count', () => {
    expect(engineOffloadLine({ running: true, gpuLayers: null, gpuLayerMode: 'auto' }))
      .toBe('GPU layers: automatic (engine fit)')
    expect(engineOffloadLine({ ...AUF_DEM_PROZESSOR, gpuLayerMode: 'auto' }))
      .toBe('GPU layers: 0, the GPU start failed')
    expect(engineOffloadLine({ running: false, gpuLayerMode: 'auto' })).toBeNull()
  })

  it('stays silent when every layer was asked for', () => {
    // 999 is llama.cpp's sentinel for "all of them" and Rust withholds it, so
    // this is what an ordinary machine produces and it deserves no line.
    expect(engineOffloadLine(AUF_DER_KARTE)).toBeNull()
    expect(engineOffloadLine({ running: true })).toBeNull()
  })

  it('promises nothing about an engine that is not up', () => {
    expect(engineOffloadLine({ running: false, cpuOnly: true, gpuLayers: 0 })).toBeNull()
    expect(engineOffloadLine(null)).toBeNull()
  })

  // A user who wrote 0 into GPU Layers got what he asked for. Telling him the
  // graphics card failed would be an invention.
  it('does not call a typed zero a failed start', () => {
    expect(engineOffloadLine({ running: true, cpuOnly: false, gpuLayers: 0 })).toBe('GPU layers: 0')
  })

  // Bug a: a card that came up and then wrote question marks did not fail to
  // start. Saying so would send the user looking for the wrong error.
  it('tells a garbled card apart from a dead start', () => {
    expect(engineOffloadLine(SALAT_AUF_DEM_PROZESSOR)).toBe('GPU layers: 0, the GPU answered unreadably')
  })

  it('keeps the layer count of an engine that only lost Flash Attention', () => {
    expect(engineOffloadLine(OHNE_FLASH_ATTENTION)).toBe('GPU layers: 18')
  })
})

describe('Built-in Engine (expert) shows the layer count', () => {
  it('shows that the engine selected its own allocation', async () => {
    expect(await panel({ ...AUF_DER_KARTE, gpuLayerMode: 'auto' })).toBe('GPU layers: automatic (engine fit)')
  })
  it('says the engine ended up on the processor', async () => {
    expect(await panel(AUF_DEM_PROZESSOR)).toBe('GPU layers: 0, the GPU start failed')
  })

  it('names the layers a measured start bought', async () => {
    expect(await panel({ ...AUF_DER_KARTE, gpuLayers: 24 })).toBe('GPU layers: 24')
  })

  it('adds no line at all on the ordinary machine', async () => {
    expect(await panel(AUF_DER_KARTE)).toBeNull()
  })
})

describe('the standing line above the composer', () => {
  it('tells the user his engine is on the CPU and where to read why', async () => {
    const line = await standingLine(AUF_DEM_PROZESSOR)
    expect(line?.textContent).toContain(ENGINE_CPU_ONLY_NOTE)
    // Quiet, not red. lib/hinweis.ts: a slower engine that serves is not an
    // error, and this app has exactly two tones.
    expect(line?.getAttribute('data-tone')).toBe('info')
  })

  it('says nothing about an engine that got the card it wanted', async () => {
    expect(await standingLine(AUF_DER_KARTE)).toBeNull()
  })

  // Bug a. The sentence Rust wrote names the cause (unreadable output) and the
  // repair (CPU, or Flash Attention off); the generic fallback line would
  // claim a start that failed, which is not what happened.
  it('carries the sanity probe sentence instead of the generic fallback line', async () => {
    const line = await standingLine(SALAT_AUF_DEM_PROZESSOR)
    expect(line?.textContent).toContain(SALAT_AUF_DEM_PROZESSOR.sanityNote)
    expect(line?.textContent).not.toContain(ENGINE_CPU_ONLY_NOTE)
    expect(line?.getAttribute('data-tone')).toBe('info')
  })

  it('speaks for the flash attention rung, which keeps the card', async () => {
    const line = await standingLine(OHNE_FLASH_ATTENTION)
    expect(line?.textContent).toContain(OHNE_FLASH_ATTENTION.sanityNote)
  })

  it('speaks again when the same engine moves from one rung to the next', async () => {
    await standingLine(OHNE_FLASH_ATTENTION)
    useLuEngineSwitchStore.getState().dismiss()
    backendCall.mockImplementation(async (cmd: string) =>
      cmd === 'bundled_engine_status' ? SALAT_AUF_DEM_PROZESSOR : {})
    await act(async () => { await bundledEngineStatus() })
    expect(useLuEngineSwitchStore.getState().note).toBe(SALAT_AUF_DEM_PROZESSOR.sanityNote)
  })

  it('says it once per engine, not once per poll', async () => {
    await standingLine(AUF_DEM_PROZESSOR)
    useLuEngineSwitchStore.getState().dismiss()
    // Three more polls of the SAME process. A note the user has just closed
    // must not come back three seconds later.
    await act(async () => { await bundledEngineStatus() })
    await act(async () => { await bundledEngineStatus() })
    await act(async () => { await bundledEngineStatus() })
    expect(useLuEngineSwitchStore.getState().note).toBeNull()
  })

  it('speaks again when a new engine falls back', async () => {
    await standingLine(AUF_DEM_PROZESSOR)
    useLuEngineSwitchStore.getState().dismiss()
    backendCall.mockImplementation(async (cmd: string) =>
      cmd === 'bundled_engine_status' ? { ...AUF_DEM_PROZESSOR, model_path: '/m/qwen.gguf' } : {})
    await act(async () => { await bundledEngineStatus() })
    expect(useLuEngineSwitchStore.getState().note).toBe(ENGINE_CPU_ONLY_NOTE)
  })

  it('holds the note back while no view can draw it', async () => {
    // The poll behind Settings is one of the two that reach this code, and
    // Settings does not draw the line. Announcing there on the ordinary clock
    // would spend the whole twelve seconds on a page that cannot show it.
    const { useUIStore } = await import('../../../stores/uiStore')
    useUIStore.setState({ currentView: 'settings' })
    try {
      announceEngineCpuFallback(AUF_DEM_PROZESSOR)
      expect(useLuEngineSwitchStore.getState().note).toBe(ENGINE_CPU_ONLY_NOTE)
      // Still standing after the ordinary clock would have cleared it.
      vi.useFakeTimers()
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(useLuEngineSwitchStore.getState().note).toBe(ENGINE_CPU_ONLY_NOTE)
    } finally {
      useUIStore.setState({ currentView: 'chat' })
    }
  })
})

/** Sentence as Rust writes it (engine.rs IMAGE_PART_NO_ROOM_NOTE). */
const NO_ROOM = 'Loaded without image input: the graphics memory has no room for the image part next to the model. A smaller context makes room.'

describe('a model that came up without its image part', () => {
  it('says so in the standing line, on a card that otherwise runs as usual', () => {
    announceEngineCpuFallback({ ...AUF_DER_KARTE, imageNote: NO_ROOM })
    expect(useLuEngineSwitchStore.getState().note).toBe(NO_ROOM)
  })

  it('stands beside the sentence about where the engine computes', () => {
    expect(engineStandingNote({ ...AUF_DEM_PROZESSOR, imageNote: NO_ROOM })).toBe(`${ENGINE_CPU_ONLY_NOTE} ${NO_ROOM}`)
  })

  it('asks the model lists to fetch again when the answer changes, and only then', () => {
    const refreshed = vi.fn()
    window.addEventListener('lu-models-refresh', refreshed)
    try {
      announceEngineCpuFallback(AUF_DER_KARTE)
      expect(refreshed).not.toHaveBeenCalled()
      announceEngineCpuFallback({ ...AUF_DER_KARTE, imageNote: NO_ROOM })
      announceEngineCpuFallback({ ...AUF_DER_KARTE, imageNote: NO_ROOM })
      expect(refreshed).toHaveBeenCalledTimes(1)
      // Loaded again with the part: the lists have to learn that as well.
      announceEngineCpuFallback(AUF_DER_KARTE)
      expect(refreshed).toHaveBeenCalledTimes(2)
    } finally {
      window.removeEventListener('lu-models-refresh', refreshed)
    }
  })
})
