/**
 * @vitest-environment jsdom
 *
 * T2 (3.0.9): what the tray menu is told, taken from the real stores, and
 * what a click on its action does.
 *
 * Run: npx vitest run src/hooks/__tests__/tray-sync.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = []
let engineStatus: Record<string, unknown> = {}
let ollamaLoaded: Array<{ name: string }> | Error = []

vi.mock('../../api/backend', async (orig) => ({
  ...(await orig<typeof import('../../api/backend')>()),
  backendCall: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args })
    if (cmd === 'bundled_engine_status') return engineStatus
    return null
  }),
}))
vi.mock('../../api/ollama', async (orig) => ({
  ...(await orig<typeof import('../../api/ollama')>()),
  readLoadedModels: vi.fn(async () => {
    if (ollamaLoaded instanceof Error) throw ollamaLoaded
    return ollamaLoaded
  }),
}))

import { currentTrayStatus, openTrayAction, probeModelState, trayEngineName } from '../useTraySync'
import { useCloudAuthStore } from '../../stores/cloudAuthStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import type { AIModel } from '../../types/models'

const engineRow = { name: 'openai::Qwen3-8B-Q4_K_M', provider: 'openai', providerName: 'LU Engine', displayName: 'Qwen3 8B' } as unknown as AIModel
const ollamaRow = { name: 'llama3.2:3b', provider: 'ollama', providerName: 'Ollama' } as unknown as AIModel

function setMode(appMode: 'local' | 'cloud') {
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, appMode } }))
}

beforeEach(() => {
  calls.length = 0
  engineStatus = {}
  ollamaLoaded = []
  setMode('local')
  useModelStore.setState({ models: [engineRow, ollamaRow], activeModel: engineRow.name })
  useCloudAuthStore.getState().setSignedOut()
})

describe('tray sync (T2)', () => {
  it('names the engine that serves the selected model', () => {
    expect(trayEngineName(engineRow.name)).toBe('LU Engine')
    expect(trayEngineName(ollamaRow.name)).toBe('Ollama')
    expect(trayEngineName('unlisted-ollama-model')).toBe('Ollama')
  })

  it('LU Engine: ready only when it holds this model and answers', async () => {
    engineStatus = { running: true, healthy: true, model_path: '/m/Qwen3-8B-Q4_K_M.gguf' }
    expect(await probeModelState(engineRow.name)).toBe('ready')
    engineStatus = { running: true, healthy: false, model_path: '/m/Qwen3-8B-Q4_K_M.gguf' }
    expect(await probeModelState(engineRow.name)).toBe('loading')
    engineStatus = { running: true, healthy: true, model_path: '/m/Other.gguf' }
    expect(await probeModelState(engineRow.name)).toBe('idle')
    engineStatus = { running: false }
    expect(await probeModelState(engineRow.name)).toBe('idle')
  })

  it('Ollama: loaded, not loaded, not answering', async () => {
    ollamaLoaded = [{ name: 'llama3.2:3b' }]
    expect(await probeModelState(ollamaRow.name)).toBe('ready')
    ollamaLoaded = []
    expect(await probeModelState(ollamaRow.name)).toBe('idle')
    ollamaLoaded = new Error('connection refused')
    expect(await probeModelState(ollamaRow.name)).toBe('engine-off')
  })

  it('local mode shows the engine and the display name, with Models as the action', () => {
    const s = currentTrayStatus()
    expect(s.action).toBe('models')
    expect(s.lines[0].text).toBe('Local · LU Engine')
    expect(s.lines[1].text).toBe('Qwen3 8B')
  })

  it('a cloud model kept from the Cloud mode is not shown as the local model', () => {
    useModelStore.setState({ activeModel: 'lu-cloud::moonshotai/Kimi-K2.6' })
    expect(currentTrayStatus().lines.map((l) => l.text).slice(0, 2)).toEqual(['Local', 'No model selected'])
  })

  it('cloud mode: "Signed in", plan, credits incl. bought ones, never the e-mail', () => {
    setMode('cloud')
    useCloudAuthStore.getState().setSignedIn(
      { id: 'u1', email: 'someone@example.com' },
      {
        licenseActive: true,
        tier: 'hosted-pro',
        access: true,
        quota: {
          tier: 'hosted-pro',
          period: '2026-10',
          limits: { credits: 2000 },
          costs: { image: 1, video: 10 },
          used: { credits_used: 1060 },
          remaining: { credits: 940 },
          topup: { credits: 300 },
        },
      },
    )
    const s = currentTrayStatus()
    expect(s.action).toBe('plan')
    expect(s.lines.map((l) => l.text)).toEqual(['LU Cloud · Signed in', 'Hosted Pro plan · active', '1,240 credits left'])
    expect(JSON.stringify(s)).not.toContain('@')
  })

  it('the menu action opens Models or the account in Settings, anything else nothing', () => {
    useUIStore.getState().setView('chat')
    openTrayAction('models')
    expect(useUIStore.getState().currentView).toBe('models')
    openTrayAction('plan')
    expect(useUIStore.getState().currentView).toBe('settings')
    expect(useUIStore.getState().settingsFocus).toEqual({ tab: 'general' })
    useUIStore.getState().setView('chat')
    openTrayAction('delete')
    expect(useUIStore.getState().currentView).toBe('chat')
  })
})
