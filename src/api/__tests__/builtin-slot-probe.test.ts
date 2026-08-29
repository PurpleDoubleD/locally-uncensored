/**
 * The second half of the #118 leftover: the reader, and the two places in
 * Settings, AI Backends that have to go through it.
 *
 * Counter-check on the real 2.6.7 Windows build (2026-08-29): the Built-in
 * Engine row read "Failed" right after app start, and the Test click that
 * disproved it first printed `GET http://127.0.0.1:8127/v1/models
 * net::ERR_CONNECTION_REFUSED` in the console. Both halves come from the same
 * habit of asking a port instead of asking the app that owns the process.
 *
 * The React half is asserted at the source level, the way
 * model-visible-wait.test.ts does it: mounting the whole settings tree around a
 * mocked engine would test the mock.
 *
 * Run: npx vitest run src/api/__tests__/builtin-slot-probe.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const backendCall = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>()
const localFetch = vi.fn()
vi.mock('../backend', () => ({
  backendCall: (...a: unknown[]) => backendCall(...(a as [string, unknown])),
  localFetch: (...a: unknown[]) => localFetch(...a),
  fetchExternal: vi.fn(),
}))

let managed = true
vi.mock('../../stores/providerStore', () => ({
  useProviderStore: { getState: () => ({ providers: { openai: { enabled: true, managed } } }) },
}))
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ settings: { builtinEngine: {} } }) },
}))

const { readBuiltinSlotStatus } = await import('../builtin-ensure')

beforeEach(() => {
  vi.clearAllMocks()
  managed = true
})

describe('readBuiltinSlotStatus — ask the app, not the port', () => {
  it('THE FIX: an engine that never started reads stopped, with no request sent', async () => {
    backendCall.mockResolvedValue({ running: false, healthy: false })
    expect(await readBuiltinSlotStatus()).toBe('stopped')
    expect(localFetch).not.toHaveBeenCalled()
  })

  it('a healthy engine reads connected, still with no request sent', async () => {
    backendCall.mockResolvedValue({ running: true, healthy: true })
    expect(await readBuiltinSlotStatus()).toBe('connected')
    expect(localFetch).not.toHaveBeenCalled()
  })

  it('up but not answering yet hands the question back to a real probe', async () => {
    backendCall.mockResolvedValue({ running: true, healthy: false })
    expect(await readBuiltinSlotStatus()).toBeNull()
  })

  it('a slot that is NOT the app-managed engine is none of our business', async () => {
    managed = false
    expect(await readBuiltinSlotStatus()).toBeNull()
    expect(backendCall).not.toHaveBeenCalled()
  })

  it('a backend that cannot answer decides nothing (browser and dev)', async () => {
    backendCall.mockRejectedValue(new Error('command not found'))
    expect(await readBuiltinSlotStatus()).toBeNull()
  })

  it('never answers failed, whatever the engine says', async () => {
    for (const answer of [{ running: false, healthy: false }, { running: true, healthy: false }, {}]) {
      backendCall.mockResolvedValue(answer)
      expect(await readBuiltinSlotStatus()).not.toBe('failed')
    }
  })
})

const here = dirname(fileURLToPath(import.meta.url))
const providerConfig = readFileSync(resolve(here, '../../components/settings/ProviderConfig.tsx'), 'utf8')

describe('the AI Backends row goes through that reader', () => {
  it('the mount check calls probeSlot, not checkConnection directly', () => {
    // The old loop was `const ok = await client.checkConnection()` inside the
    // mount effect, which is what stamped "Failed" on an engine nobody had
    // started yet.
    expect(providerConfig).toMatch(/const status = await probeSlot\(id\)/)
    expect(providerConfig).toMatch(/const probeSlot = async[\s\S]{0,400}readBuiltinSlotStatus\(\)/)
  })

  it('the Test click skips the doomed request when the engine is stopped', () => {
    expect(providerConfig).toMatch(
      /const stopped = providerId === 'openai' && \(await readBuiltinSlotStatus\(\)\) === 'stopped'/,
    )
    expect(providerConfig).toMatch(/if \(!stopped\) \{[\s\S]{0,200}checkConnection\(\)/)
  })

  it('there is a "Not running" state and it is not painted as a failure', () => {
    expect(providerConfig).toContain('Not running')
    expect(providerConfig).toMatch(/status === 'stopped' \? 'bg-amber-500'/)
  })

  it('the user-facing strings on this row are English', () => {
    for (const s of ['Not running', 'Connected', 'Failed']) {
      expect(providerConfig).toContain(s)
    }
  })
})
