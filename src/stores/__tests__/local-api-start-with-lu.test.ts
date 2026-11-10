/**
 * fanezeu (Discord, 23.10.2026): LU on a Linux server without a screen in
 * front of it. The Local API only ran after a click in Settings, so every
 * reboot of the server took it away. "Start with LU" brings it up at launch,
 * and only what the Start button would also start.
 *
 * Run: npx vitest run src/stores/__tests__/local-api-start-with-lu.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: Array<{ cmd: string; args?: unknown }> = []
let running = false
vi.mock('../../api/backend', () => ({
  backendCall: vi.fn(async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args })
    if (cmd === 'local_api_status') return running ? { running: true, address: '0.0.0.0:8129' } : { running: false }
    if (cmd === 'start_local_api') { running = true; return { address: '0.0.0.0:8129' } }
    return null
  }),
}))

import { useLocalApiStore, startLocalApiAtLaunch } from '../localApiStore'
import { sollBeimStartStarten } from '../../lib/local-api'

const TOKEN = 'lu-test-token-not-a-secret'

beforeEach(() => {
  calls.length = 0
  running = false
  useLocalApiStore.setState({ port: 8129, lan: true, token: TOKEN, corsOrigins: [], mitLuStarten: false, laeuft: false, adresse: null, fehler: null })
})

describe('sollBeimStartStarten', () => {
  it('starts only what the user switched on and the Start button would start', () => {
    expect(sollBeimStartStarten({ mitLuStarten: true, token: TOKEN, port: 8129, laeuft: false })).toBe(true)
    expect(sollBeimStartStarten({ mitLuStarten: false, token: TOKEN, port: 8129, laeuft: false })).toBe(false)
    expect(sollBeimStartStarten({ mitLuStarten: true, token: '  ', port: 8129, laeuft: false })).toBe(false)
    expect(sollBeimStartStarten({ mitLuStarten: true, token: TOKEN, port: 11434, laeuft: false })).toBe(false)
    expect(sollBeimStartStarten({ mitLuStarten: true, token: TOKEN, port: 8129, laeuft: true })).toBe(false)
  })
})

describe('startLocalApiAtLaunch', () => {
  it('is off by default and then asks Rust nothing', async () => {
    await startLocalApiAtLaunch()
    expect(calls).toEqual([])
    expect(useLocalApiStore.getState().laeuft).toBe(false)
  })

  it('starts the API with the saved settings, LAN included', async () => {
    useLocalApiStore.setState({ mitLuStarten: true })
    await startLocalApiAtLaunch()
    const start = calls.find((c) => c.cmd === 'start_local_api')
    expect(start?.args).toMatchObject({ port: 8129, lan: true, token: TOKEN, corsOrigins: [], engineDirs: [] })
    // C57: the API loads LU Engine models itself, with the tuning the chat uses.
    expect(start?.args).toHaveProperty('engineTuning')
    expect(useLocalApiStore.getState().laeuft).toBe(true)
  })

  it('does not start a second server when one already runs (window reload)', async () => {
    running = true
    useLocalApiStore.setState({ mitLuStarten: true })
    await startLocalApiAtLaunch()
    expect(calls.map((c) => c.cmd)).toEqual(['local_api_status'])
    expect(useLocalApiStore.getState().laeuft).toBe(true)
  })

  it('keeps the switch in the saved settings, the running state out of them', () => {
    useLocalApiStore.getState().setMitLuStarten(true)
    useLocalApiStore.setState({ laeuft: true })
    const persisted = useLocalApiStore.persist.getOptions().partialize?.(useLocalApiStore.getState()) as Record<string, unknown>
    expect(persisted.mitLuStarten).toBe(true)
    expect('laeuft' in persisted).toBe(false)
  })
})

describe('wiring', () => {
  it('App.tsx calls it at launch', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const app = readFileSync(join(__dirname, '../../App.tsx'), 'utf8')
    expect(app).toContain('startLocalApiAtLaunch()')
  })
})
