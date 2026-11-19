/**
 * A46: with no chat at all, Voice started without the persona that was
 * picked. It now speaks as the persona picked app wide.
 *
 * Run: npx vitest run src/lib/voice/__tests__/a46-voice-persona-without-a-chat.test.ts
 */
import { describe, expect, it } from 'vitest'
import type { Persona } from '../../../types/settings'
import { voicePersonaFrom } from '../voice-persona'

const pirate: Persona = { id: 'pirate', name: 'Pirate', icon: 'x', systemPrompt: 'You are a pirate.', isBuiltIn: false }
const plain: Persona = { id: 'unrestricted', name: 'Unrestricted', icon: 'x', systemPrompt: '', isBuiltIn: true }
const personas = [plain, pirate]

describe('voice persona without an open chat', () => {
  it('speaks as the persona picked app wide', () => {
    const got = voicePersonaFrom(null, personas, 'pirate', true)
    expect(got?.persona?.id).toBe('pirate')
    expect(got?.prompt).toContain('pirate')
  })

  it('speaks as itself when nothing is picked', () => {
    expect(voicePersonaFrom(undefined, personas, 'unrestricted', true)).toBeNull()
  })

  it('speaks as itself when personas are off in Settings', () => {
    expect(voicePersonaFrom(null, personas, 'pirate', false)).toBeNull()
  })

  it('keeps the rule of an open chat: persona off there means none', () => {
    expect(voicePersonaFrom({ personaEnabled: false }, personas, 'pirate', true)).toBeNull()
    expect(voicePersonaFrom({ personaEnabled: true, personaId: 'pirate' }, personas, 'unrestricted', true)?.persona?.id).toBe('pirate')
  })
})
