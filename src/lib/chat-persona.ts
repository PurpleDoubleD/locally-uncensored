import type { Persona, SamplerValues, Settings } from '../types/settings'
import { buildSamplingRequest, type SamplingOverrides, type SamplingRequest } from './sampling'
import { substituteMacros, DEFAULT_USER_NAME } from './character-card'
import { isGroupChat } from './group-chat'
import { mergeCustomParams, resolveCustomParams, type CustomParam } from './custom-params'

/**
 * Which persona a chat speaks as, and which prompt that means (GH #170).
 *
 * A chat used to keep only a frozen copy of the prompt that was active when it
 * was created (`Conversation.systemPrompt`). The Plugins menu, though, named
 * the app wide pick and changed only that. So the menu said "Baron" while the
 * request carried the prompt of whoever was picked when the chat was opened,
 * and the model introduced itself as the other character.
 *
 * Now a chat records the persona itself (`Conversation.personaId`), the menu
 * writes it, and both the menu and every send read it through this one
 * function, so what the menu shows is what goes out:
 *
 *   1. The chat has a persona id and the persona still exists: that persona,
 *      with its prompt as it stands today (an edit in Settings applies).
 *   2. The chat has a persona id but the persona was deleted: the copy the
 *      chat kept, under no persona name.
 *   3. A chat from before this field with a copy of its own: that copy, and
 *      the persona whose prompt it is when one still matches.
 *   4. Nothing chosen and nothing kept: the app wide pick, which is what the
 *      menu has always shown for such a chat.
 */

/** The prompt a persona contributes. A character card keeps `{{char}}` and
 *  `{{user}}` in its prompt; they are filled in here, as when a card chat
 *  starts. */
export function personaPromptOf(persona: Pick<Persona, 'name' | 'systemPrompt' | 'card'>): string {
  return persona.card
    ? substituteMacros(persona.systemPrompt, persona.name, DEFAULT_USER_NAME)
    : persona.systemPrompt
}

export interface ChatPersona {
  /** The persona, absent when the chat runs on a kept prompt no persona has. */
  persona?: Persona
  /** The prompt that is sent while the persona is switched on for the chat. */
  prompt: string
}

export function resolveChatPersona(
  conv: { personaId?: string; systemPrompt?: string | null },
  personas: readonly Persona[],
  activePersonaId: string | undefined,
): ChatPersona {
  const kept = conv.systemPrompt ?? ''
  if (conv.personaId) {
    const persona = personas.find((p) => p.id === conv.personaId)
    return persona ? { persona, prompt: personaPromptOf(persona) } : { prompt: kept }
  }
  if (kept.trim()) {
    return { persona: personas.find((p) => personaPromptOf(p) === kept), prompt: kept }
  }
  const active = personas.find((p) => p.id === activePersonaId)
  return active ? { persona: active, prompt: personaPromptOf(active) } : { prompt: '' }
}

/** GH #180: the persona a plain chat speaks as right now, the way
 *  `buildChatSystemPrompt` decides it: switched on for the chat and in
 *  Settings, and an existing persona. Undefined when the model speaks as
 *  itself. */
export function plainChatSpeaker(
  conv: { personaId?: string; systemPrompt?: string | null; personaEnabled?: boolean },
  personas: readonly Persona[],
  activePersonaId: string | undefined,
  personasOn = true,
): { id: string; name: string } | undefined {
  if (!personasOn || conv.personaEnabled !== true) return undefined
  const persona = resolveChatPersona(conv, personas, activePersonaId).persona
  return persona ? { id: persona.id, name: persona.name } : undefined
}

/** The conversation as `buildChatSystemPrompt` should see it: the same object
 *  with the resolved prompt in place of the kept copy. */
export function withChatPersona<T extends { personaId?: string; systemPrompt?: string | null }>(
  conv: T,
  personas: readonly Persona[],
  activePersonaId: string | undefined,
): T & { systemPrompt: string } {
  return { ...conv, systemPrompt: resolveChatPersona(conv, personas, activePersonaId).prompt }
}

export interface SpeakerSampling {
  /** The persona whose values apply, absent when none does. */
  persona?: Persona
  /** Its sampling values, absent when it carries none. */
  preset?: SamplerValues
}

/** What `speakerPersonaFor` reads of a conversation. */
export type SpeakerConv = {
  personaId?: string
  systemPrompt?: string | null
  personaEnabled?: boolean
  groupModels?: string[]
  groupPersonas?: Record<string, string>
}

/**
 * The persona ONE speaker of a chat speaks as, by the rule its prompt
 * follows: a group member with a persona of its own has that one, with no
 * further switch; everyone else has the chat's persona while it is switched
 * on for the chat and app wide (`personasOn`). Undefined when none applies.
 * Its sampling values (GH #175) and its reminder (GH #181) both hang off
 * this answer, so they apply exactly where the persona's prompt does.
 */
export function speakerPersonaFor(
  conv: SpeakerConv,
  model: string,
  personas: readonly Persona[],
  activePersonaId: string | undefined,
  personasOn: boolean,
): Persona | undefined {
  const inGroup = isGroupChat(conv.groupModels) && conv.groupModels.includes(model)
  const ownId = inGroup ? conv.groupPersonas?.[model] : undefined
  const own = ownId ? personas.find((p) => p.id === ownId) : undefined
  return own ?? (personasOn && conv.personaEnabled === true
    ? resolveChatPersona(conv, personas, activePersonaId).persona
    : undefined)
}

/**
 * GH #175: the sampling preset for ONE speaker of a chat.
 *
 * A group member with a persona of its own gets that persona's values, with
 * no further switch, the same rule its prompt follows. Everyone else gets the
 * values of the chat's persona, but only while that persona is switched on
 * for the chat and app wide (`personasOn`), again exactly when its prompt is
 * sent. The chat's own values from the Sampling popup sit on top of this; the
 * caller hands both to `buildSamplingRequest`.
 */
export function samplingPresetFor(
  conv: SpeakerConv,
  model: string,
  personas: readonly Persona[],
  activePersonaId: string | undefined,
  personasOn: boolean,
): SpeakerSampling {
  const persona = speakerPersonaFor(conv, model, personas, activePersonaId, personasOn)
  if (!persona) return {}
  return persona.sampling ? { persona, preset: persona.sampling } : { persona }
}

/**
 * The sampling part of the request options for one speaker: the Settings page
 * top K as before, then this chat's values over the speaker's persona preset
 * over the Settings page (lib/sampling.ts). A persona that sets its own top K
 * replaces the Settings page value.
 */
export function speakerSamplingOptions(
  settings: Pick<Settings, 'temperature' | 'topP' | 'maxTokens' | 'topK'>,
  conv: Parameters<typeof samplingPresetFor>[0] & { sampling?: SamplingOverrides; customParams?: CustomParam[] },
  model: string,
  personas: readonly Persona[],
  activePersonaId: string | undefined,
  personasOn: boolean,
): SamplingRequest & { topK: number; customParams?: Record<string, unknown> } {
  const { persona, preset } = samplingPresetFor(conv, model, personas, activePersonaId, personasOn)
  const custom = speakerCustomParams(conv, persona)
  return {
    topK: settings.topK,
    ...buildSamplingRequest(settings, conv.sampling, preset),
    ...(Object.keys(custom).length > 0 ? { customParams: custom } : {}),
  }
}

/**
 * GH #198: the custom sampling rows for one speaker, parsed: this chat's rows
 * over the rows of the speaker's persona (the one `samplingPresetFor` found,
 * so a group member brings its own), by key.
 */
export function speakerCustomParams(
  conv: { customParams?: CustomParam[] },
  persona: Pick<Persona, 'customParams'> | undefined,
): Record<string, unknown> {
  return resolveCustomParams(mergeCustomParams(conv.customParams, persona?.customParams))
}
