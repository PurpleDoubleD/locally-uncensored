import type { Persona } from '../../types/settings'
import { isGroupChat } from '../group-chat'
import { resolveChatPersona } from '../chat-persona'

/**
 * A19 (Discord, 12.11.2026): Voice ignored the persona of the chat.
 *
 * A voice session keeps its transcript in a conversation of its own, made
 * fresh at Start. A new conversation starts with the persona OFF (the
 * owner's rule for new chats), and the session built its prompt from that
 * new record. So whatever persona the chat on screen spoke as, Voice always
 * answered as the plain assistant.
 *
 * The persona now comes from the chat that was open when Start was pressed,
 * resolved the way every send resolves it (GH #170): a plain chat with its
 * persona switched on, and personas switched on in Settings. The record of
 * the session carries the same persona, so its Plugins menu says what Voice
 * spoke as. A chat with the persona off, an agent or code chat, a group
 * chat: no persona, as before.
 *
 * A46 (Discord, 17.11.2026): with no chat at all there is no chat to hold
 * the persona switch, so Voice spoke as the plain assistant although a
 * persona was picked. Without an open chat the persona picked app wide (the
 * one the Plugins menu names then, and the one a new chat starts with) is
 * the one Voice speaks as, while personas are on in Settings.
 */
export interface VoicePersona {
  /** The persona, absent for a kept prompt that no persona has any more. */
  persona?: Persona
  /** The prompt that goes into the session's system prompt. */
  prompt: string
}

export function voicePersonaFrom(
  shown:
    | {
        mode?: string
        personaId?: string
        systemPrompt?: string | null
        personaEnabled?: boolean
        groupModels?: string[]
      }
    | null
    | undefined,
  personas: readonly Persona[],
  activePersonaId: string | undefined,
  personasOn: boolean,
): VoicePersona | null {
  if (!personasOn) return null
  if (!shown) {
    const picked = resolveChatPersona({}, personas, activePersonaId)
    return picked.prompt.trim() ? picked : null
  }
  if (shown.personaEnabled !== true) return null
  if ((shown.mode ?? 'lu') !== 'lu') return null
  if (isGroupChat(shown.groupModels)) return null
  const resolved = resolveChatPersona(shown, personas, activePersonaId)
  if (!resolved.prompt.trim()) return null
  return resolved
}
