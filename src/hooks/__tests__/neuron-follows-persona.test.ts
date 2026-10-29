/**
 * @vitest-environment jsdom
 *
 * P11 (3.0.9): a persona with its own Neuron tweaker sliders brings them to
 * the engine when it becomes active; a switch between two personas without
 * their own sliders restarts nothing. The persona that counts is the one the
 * open chat speaks as (T1: a chat's own persona was ignored); a group chat
 * runs on the model's sliders.
 *
 * Run: npx vitest run src/hooks/__tests__/neuron-follows-persona.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const apply = vi.fn(async (_p: string, _e: unknown[], _t?: unknown) => ({ mix: null, restarted: true, load: 0 }))
vi.mock('../../api/engine', () => ({
  bundledEngineStatus: async () => ({ running: true, healthy: true, port: 8127, model_path: '/m/qwen.gguf' }),
}))
vi.mock('../../api/neuron', () => ({
  neuronInfo: async () => ({ modelKey: 'qwen-1', vectors: [{ id: 'cheerful' }, { id: 'casual' }] }),
  neuronApply: (p: string, e: unknown[], t?: unknown) => apply(p, e, t),
}))

import { followPersona, useNeuronFollowsPersona } from '../useNeuronFollowsPersona'
import { steeringPersona } from '../../lib/neuron'
import { useNeuronStore } from '../../stores/neuronStore'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { renderHook } from '@testing-library/react'
import type { Persona } from '../../types/settings'

const PIRATE = { id: 'pirate', name: 'Pirate', systemPrompt: 'Arr.' } as Persona
const CODER = { id: 'coder', name: 'Coder', systemPrompt: 'Code.' } as Persona

beforeEach(() => {
  apply.mockClear()
  useNeuronStore.setState({
    profiles: { 'qwen-1': { cheerful: 0.5 }, 'qwen-1::persona:pirate': { casual: 0.8 } },
    scopeByModel: {},
  })
})

describe('Neuron sliders follow the persona', () => {
  it('applies the persona profile when switching to it', async () => {
    expect(await followPersona('unrestricted', 'pirate')).toBe(true)
    expect(apply.mock.calls[0][0]).toBe('/m/qwen.gguf')
    expect(apply.mock.calls[0][1]).toEqual([{ id: 'casual', strength: 0.8 }])
  })

  it('goes back to the model profile when leaving it', async () => {
    expect(await followPersona('pirate', 'unrestricted')).toBe(true)
    expect(apply.mock.calls[0][1]).toEqual([{ id: 'cheerful', strength: 0.5 }])
  })

  it('restarts nothing between two personas without own sliders', async () => {
    expect(await followPersona('unrestricted', 'coder')).toBe(false)
    expect(apply).not.toHaveBeenCalled()
  })
})

describe('which persona steers', () => {
  it('is the open chat\'s own persona, not the app wide pick', () => {
    const conv = { personaId: 'pirate', personaEnabled: true }
    expect(steeringPersona(conv, [PIRATE, CODER], 'coder', true)).toEqual({ id: 'pirate', group: false })
  })

  it('is none while the persona is off for the chat or in Settings', () => {
    expect(steeringPersona({ personaId: 'pirate', personaEnabled: false }, [PIRATE], 'pirate', true).id).toBeNull()
    expect(steeringPersona({ personaId: 'pirate', personaEnabled: true }, [PIRATE], 'pirate', false).id).toBeNull()
  })

  it('is the app wide pick with no chat open, and none in a group chat', () => {
    expect(steeringPersona(undefined, [PIRATE], 'pirate', true)).toEqual({ id: 'pirate', group: false })
    expect(steeringPersona({ personaId: 'pirate', personaEnabled: true, groupModels: ['a', 'b'] }, [PIRATE], 'pirate', true)).toEqual({ id: null, group: true })
  })

  it('restarts the engine when the user opens a chat that speaks as a persona with own sliders', async () => {
    useSettingsStore.setState((s) => ({ personas: [PIRATE, CODER], activePersonaId: 'coder', settings: { ...s.settings, personasEnabled: true } }))
    useChatStore.setState({
      conversations: [
        { id: 'a', title: 'A', messages: [], model: 'm', createdAt: 1, updatedAt: 1, personaId: 'coder', personaEnabled: true },
        { id: 'b', title: 'B', messages: [], model: 'm', createdAt: 1, updatedAt: 1, personaId: 'pirate', personaEnabled: true },
      ] as never,
      activeConversationId: 'a',
    })
    const { unmount } = renderHook(() => useNeuronFollowsPersona())
    useChatStore.setState({ activeConversationId: 'b' })
    await vi.waitFor(() => expect(apply).toHaveBeenCalled())
    expect(apply.mock.calls[0][1]).toEqual([{ id: 'casual', strength: 0.8 }])
    unmount()
  })
})
