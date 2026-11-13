// A19 (setimu, Discord 12.11.2026): Voice ignored the persona of the chat.
//
// A voice session keeps its transcript in a conversation made fresh at Start,
// and a fresh conversation starts with the persona off. The system prompt was
// built from that record, so Voice always answered as the plain assistant.
//
// This drives the real startVoiceSession up to the request that opens the
// session on the voice loop (/session) and reads the system prompt it sends.
// Only the edges are stubbed: microphone, the voice loop process, the brain.
//
// Run: npx vitest run src/api/__tests__/a19-voice-speaks-as-the-persona.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../voice-media', () => {
  class VoiceMicError extends Error {}
  class LuVoiceMediaManager {
    selectedMic = {}
    updateMic = vi.fn(async () => {})
    initialize() { return Promise.resolve() }
    disconnect() { return Promise.resolve() }
    enableMic() {}
    levels() { return { mic: 0, bot: 0 } }
  }
  return { LuVoiceMediaManager, VoiceMicError }
})
vi.mock('../microphone', () => ({ listMicrophones: vi.fn(async () => []), onMicrophoneChosen: () => () => {} }))
vi.mock('../voice-loop', () => ({
  getVoiceLoopStatus: vi.fn(async () => ({ ready: true })),
  startVoiceLoop: vi.fn(async () => ({ port: 1, token: 't', baseUrl: 'http://127.0.0.1:1', voice: 'v' })),
  stopVoiceLoop: vi.fn(async () => {}),
}))
vi.mock('../voice-speech', () => ({ voiceSessionSpeech: vi.fn(async () => ({})) }))
vi.mock('../workspace-slug', () => ({ resolveChatWorkspaceSlug: vi.fn(async () => 'voice-test') }))
vi.mock('../voice-brain', async (orig) => {
  const real = await orig<typeof import('../voice-brain')>()
  return {
    ...real,
    resolveVoiceBrain: vi.fn(async () => ({
      llm: { base_url: 'http://127.0.0.1:2/v1', model: 'test-model' },
      providerId: 'openai',
      modelLabel: 'Test model',
      toolsSupported: false,
      local: true,
      thinking: () => ({ extra: {}, directExtra: {}, wanted: false, always: false }),
    })),
  }
})

import { startVoiceSession, stopVoiceSession } from '../voice-session'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useModelStore } from '../../stores/modelStore'
import type { Persona } from '../../types/settings'

const BARON: Persona = {
  id: 'baron',
  name: 'Baron',
  icon: 'Crown',
  systemPrompt: 'You are Baron von Pfeffer, a grumpy aristocrat who answers every question with a sigh.',
  isBuiltIn: false,
} as Persona

let sentPrompt: string | null = null
/** The conversations as they stood when /session was asked for. A start
 *  that fails afterwards removes its empty record again. */
let atSession: ReturnType<typeof useChatStore.getState>['conversations'] = []

beforeEach(() => {
  sentPrompt = null
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/session')) {
      sentPrompt = JSON.parse(String(init?.body)).system_prompt
      atSession = useChatStore.getState().conversations
      // The test has what it came for; the start ends here.
      return new Response('stop here', { status: 500 })
    }
    return new Response('{}', { status: 404 })
  }))
  useModelStore.setState({ activeModel: 'openai::test-model' } as never)
  useSettingsStore.setState((s) => ({
    personas: [...s.personas.filter((p) => p.id !== BARON.id), BARON],
    activePersonaId: undefined,
    settings: { ...s.settings, personasEnabled: true },
  }) as never)
})

afterEach(() => {
  stopVoiceSession()
  vi.unstubAllGlobals()
})

async function startAndRead(): Promise<string> {
  await startVoiceSession().catch(() => {})
  await vi.waitFor(() => expect(sentPrompt).not.toBeNull(), { timeout: 3000 })
  return sentPrompt!
}

describe('A19: Voice speaks as the persona of the chat it was started from', () => {
  it('a chat with Baron switched on: the session prompt carries Baron', async () => {
    const chat = useChatStore.getState()
    const id = chat.createConversation('openai::test-model', BARON.systemPrompt, undefined)
    useChatStore.getState().setConversationPersona(id, BARON)
    useChatStore.getState().setConversationPersonaEnabled(id, true)
    useChatStore.getState().setActiveConversation(id)

    const prompt = await startAndRead()
    expect(prompt).toContain('Baron von Pfeffer')
    // Still a voice prompt: the speech rules are kept behind the persona.
    expect(prompt).toContain('live voice conversation')

    // The session's own record speaks as Baron too, and the open chat stays open.
    expect(useChatStore.getState().activeConversationId).toBe(id)
    const record = atSession.find((c) => c.id !== id && c.personaId === BARON.id)
    expect(record?.personaEnabled).toBe(true)
  })

  it('a chat with the persona off: no persona, as before', async () => {
    const id = useChatStore.getState().createConversation('openai::test-model', BARON.systemPrompt, undefined)
    useChatStore.getState().setConversationPersona(id, BARON)
    useChatStore.getState().setConversationPersonaEnabled(id, false)
    useChatStore.getState().setActiveConversation(id)
    expect(await startAndRead()).not.toContain('Baron von Pfeffer')
  })

  it('personas switched off in Settings win over the chat', async () => {
    const id = useChatStore.getState().createConversation('openai::test-model', BARON.systemPrompt, undefined)
    useChatStore.getState().setConversationPersona(id, BARON)
    useChatStore.getState().setConversationPersonaEnabled(id, true)
    useChatStore.getState().setActiveConversation(id)
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, personasEnabled: false } }) as never)
    expect(await startAndRead()).not.toContain('Baron von Pfeffer')
  })
})
