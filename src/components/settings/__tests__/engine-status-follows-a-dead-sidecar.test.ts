/**
 * @vitest-environment jsdom
 *
 * A16, Windows counter-check 02.09. (A15-4a): the LU Engine panel read the
 * engine status once, on mount. Kill lu-llama-server with the section standing
 * open and the line kept saying "Engine running · Port: 8127" through all
 * sixteen samples the counter-check took over thirty seconds. Folding the
 * section and unfolding it corrected it, because that mounted the panel again
 * and asked again, which is exactly the wrong thing to have to know.
 *
 * The panel follows the engine now: Rust's watch reaps the dead handle and
 * emits `lu-sidecar-gone`, and this is the belt behind it, a three second poll
 * for the case where the event never lands.
 *
 * Run: npx vitest run src/components/settings/__tests__/engine-status-follows-a-dead-sidecar.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, act } from '@testing-library/react'

const bundledEngineStatus = vi.fn()
/** The Rust-side listeners this panel registered, so the test can fire one. */
const listeners: Record<string, ((e: unknown) => void)[]> = {}
const unlisten = vi.fn()

vi.mock('../../../api/backend', () => ({
  isTauri: () => true,
  isMacOS: () => false,
  backendCall: vi.fn(async () => null),
}))
vi.mock('../../../api/engine', async () => {
  const actual = await vi.importActual<typeof import('../../../api/engine')>('../../../api/engine')
  return {
    ...actual,
    bundledEngineStatus: (...a: unknown[]) => bundledEngineStatus(...(a as [])),
    swapBundledModel: vi.fn(async () => ({ port: 8127 })),
  }
})
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, cb: (e: unknown) => void) => {
    ;(listeners[name] ??= []).push(cb)
    return unlisten
  },
}))

const { BuiltinEngineSettings } = await import('../BuiltinEngineSettings')
// Die Schleife wohnt seit dem 04.09.2026 im Hook, weil die Models-Seite
// dieselbe Frage stellen muss (Persona P2). Das Fenster hier bleibt der Ort,
// an dem sie geprueft wird, aber die Namen kommen von dort.
const { ENGINE_STATUS_POLL_MS, SIDECAR_GONE_EVENT } =
  await import('../../../hooks/useBuiltinEngineStatus')

const RUNNING = { running: true, healthy: true, port: 8127, model_path: 'C:\\m\\Phi-4-mini-instruct-Q4_K_M.gguf', ctx: 8192 }
const DEAD = { running: false, healthy: false, port: 8127, model_path: null, ctx: null }

/** Mount the panel with the engine up, and let the mount read settle. */
async function panelWithARunningEngine() {
  bundledEngineStatus.mockResolvedValue(RUNNING)
  render(createElement(BuiltinEngineSettings))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  expect(document.body.textContent).toContain('Engine running')
  expect(screen.getByTestId('builtin-engine-port').textContent).toContain('8127')
}

/** What `taskkill /F /IM lu-llama-server.exe` leaves behind. */
function theEngineIsKilledFromOutside() {
  bundledEngineStatus.mockResolvedValue(DEAD)
}

async function fireSidecarGone() {
  await act(async () => {
    for (const cb of listeners[SIDECAR_GONE_EVENT] ?? []) cb({ payload: { sidecar: 'engine', port: 8127 } })
    await Promise.resolve(); await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  bundledEngineStatus.mockReset()
  unlisten.mockClear()
  for (const k of Object.keys(listeners)) delete listeners[k]
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('an engine killed from outside while the panel stands open', () => {
  it('says so within five seconds without anyone touching the section', async () => {
    await panelWithARunningEngine()
    theEngineIsKilledFromOutside()

    // The whole promise, in one number: the counter-check watched for thirty
    // seconds and saw nothing change.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })

    expect(document.body.textContent).toContain('Engine not running')
    expect(document.body.textContent).not.toContain('Engine running ·')
  })

  it('and does not wait for the poll when Rust says the sidecar is gone', async () => {
    await panelWithARunningEngine()
    theEngineIsKilledFromOutside()

    // No timer advanced at all: this is the event path on its own.
    await fireSidecarGone()

    expect(document.body.textContent).toContain('Engine not running')
  })

  // NEGATIVE CONTROL: the panel must not simply decay to "not running". An
  // engine that is still there stays on screen however long the section is
  // open, or the fix would have traded a stale display for a wrong one.
  it('leaves a living engine alone however long the section stands open', async () => {
    await panelWithARunningEngine()

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })

    expect(document.body.textContent).toContain('Engine running')
    expect(screen.getByTestId('builtin-engine-port').textContent).toContain('8127')
  })

  // NEGATIVE CONTROL: it is a poll, not a one-off retry. The engine coming
  // back has to reach the panel too.
  it('picks an engine back up when it is started again', async () => {
    await panelWithARunningEngine()
    theEngineIsKilledFromOutside()
    await act(async () => { await vi.advanceTimersByTimeAsync(ENGINE_STATUS_POLL_MS + 100) })
    expect(document.body.textContent).toContain('Engine not running')

    bundledEngineStatus.mockResolvedValue(RUNNING)
    await act(async () => { await vi.advanceTimersByTimeAsync(ENGINE_STATUS_POLL_MS + 100) })
    expect(document.body.textContent).toContain('Engine running')
  })

  it('stops asking once the section is folded away', async () => {
    await panelWithARunningEngine()
    const asked = bundledEngineStatus.mock.calls.length
    cleanup()
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(bundledEngineStatus.mock.calls.length, 'the poll outlived the panel').toBe(asked)
    expect(unlisten, 'the Rust listener outlived the panel').toHaveBeenCalled()
  })

  it('polls often enough to keep the five second promise', () => {
    expect(ENGINE_STATUS_POLL_MS).toBeLessThanOrEqual(3_000)
  })
})
