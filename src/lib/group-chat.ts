// Group chat v1 (a user, Discord 2026-08-07): two to four models
// answer in turn inside ONE conversation, SillyTavern-style turn order.
// Plain conversation only by design: the agent path and the chat-tools
// router stay out, a group round is talk, never a tool run.
//
// Attribution is the whole trick. Every model receives the shared history
// with the OTHER models' lines tagged "[model-name] ..." and its own lines
// untagged, so each participant can tell who said what without any provider
// support for multi-speaker roles.
import type { Message } from '../types/chat'
import type { AIModel } from '../types/models'
import { substituteMacros, DEFAULT_USER_NAME } from './character-card'

export const GROUP_CHAT_MIN = 2
export const GROUP_CHAT_MAX = 4

/**
 * The models that may sit at the table.
 *
 * Counter-check round 2 (2026-08-29): the picker listed the whole model store,
 * so `sd_turbo.safetensors`, `Realistic_Vision_V6.0_NV_B1_fp16.safetensors` and
 * `z_image_bf16.safetensors` were offered as conversation partners. An image
 * checkpoint has nothing to say in a talking round. The chat model picker has
 * always filtered on `type === 'text'`; the group picker simply never did.
 *
 * Anything already picked stays in the list even when it fails the test, so a
 * group saved before this fix can still be taken apart by hand instead of
 * showing a member nobody can reach.
 */
export function groupChatCandidates(models: AIModel[], selected: string[] = []): AIModel[] {
  return models.filter((m) => m.type === 'text' || selected.includes(m.name))
}

/**
 * GH #165: the members whose model is not in the model list right now.
 *
 * Such a member used to stay in the group invisibly: it was counted, it kept
 * its turn in every round, and the request under its name was answered by
 * whatever model the backend had loaded, so one model spoke twice per round
 * under two names. It now sits out until its model is listed again, and the
 * group menu shows it as unavailable so it can be removed.
 *
 * A list that has not landed yet, or a refresh in which every backend failed
 * (an empty list, see modelStore.setModels), says nothing about any one
 * model, so nobody is judged on it.
 */
export function unavailableGroupMembers(
  members: readonly string[],
  models: readonly Pick<AIModel, 'name'>[],
  inventoryLoaded: boolean,
): string[] {
  if (!inventoryLoaded || models.length === 0) return []
  const listed = new Set(models.map((m) => m.name))
  return members.filter((m) => !listed.has(m))
}

/** The members that take a turn in the next round, in their order. */
export function availableGroupMembers(
  members: readonly string[],
  models: readonly Pick<AIModel, 'name'>[],
  inventoryLoaded: boolean,
): string[] {
  const missing = unavailableGroupMembers(members, models, inventoryLoaded)
  return members.filter((m) => !missing.includes(m))
}

export interface GroupChatRow {
  name: string
  /** A member whose model is not in the model list right now (GH #165). */
  unavailable: boolean
  /** The additional OpenAI-compatible backend the model comes from, with its
   *  name, so the same model on two servers reads as two choices (GH #173). */
  providerEntry?: string
  providerName?: string
}

/**
 * The rows of the group menu: every model that may sit at the table, once
 * each, and after them every member whose model left the list, so it stays
 * visible and can be taken out of the group without bringing the model back.
 *
 * Once each, because a server can report the same model twice (KoboldCpp in
 * Ollama mode, GH #165). The selection is keyed by name, so two rows of one
 * name ticked together and the header counted the model twice.
 */
export function groupChatRows(models: AIModel[], selected: string[], inventoryLoaded: boolean): GroupChatRow[] {
  const missing = new Set(unavailableGroupMembers(selected, models, inventoryLoaded))
  const seen = new Set<string>()
  const rows: GroupChatRow[] = []
  for (const m of groupChatCandidates(models, selected)) {
    if (seen.has(m.name)) continue
    seen.add(m.name)
    const entry = 'providerEntry' in m && typeof m.providerEntry === 'string' ? m.providerEntry : undefined
    rows.push(entry
      ? { name: m.name, unavailable: false, providerEntry: entry, providerName: 'providerName' in m && typeof m.providerName === 'string' ? m.providerName : undefined }
      : { name: m.name, unavailable: false })
  }
  for (const name of selected) {
    if (seen.has(name)) continue
    seen.add(name)
    rows.push({ name, unavailable: missing.has(name) })
  }
  return rows
}

/** True when this conversation runs as a group. */
export function isGroupChat(groupModels: string[] | undefined): groupModels is string[] {
  return Array.isArray(groupModels) && groupModels.length >= GROUP_CHAT_MIN
}

/**
 * Who sits at the table, and as whom (3.0.5, a user on Discord).
 *
 * Until now every model in a group answered under the ONE persona of the
 * chat, so two models were both told "You are Sherlock" and promptly spoke
 * over each other. Each participant can now have its own persona, picked next
 * to its name in the group menu and stored on the conversation
 * (`groupPersonas`, model name to persona id).
 *
 * A participant without an entry is exactly what it was before: it follows
 * the chat's own persona setting and is called by its model name. A persona
 * id that no longer exists (the persona was deleted) reads as no entry, so a
 * stale pick never leaves a participant without a role.
 */
export interface GroupSpeaker {
  /** The name the others see this participant under. */
  name: string
  /** Its own persona prompt, absent when it follows the chat's setting. */
  personaPrompt?: string
  /** The id of its own persona, absent when it follows the chat's setting. */
  personaId?: string
}

export function groupSpeakers(
  models: readonly string[],
  groupPersonas: Readonly<Record<string, string>> | undefined,
  personas: readonly { id: string; name: string; systemPrompt: string; card?: unknown }[],
): Record<string, GroupSpeaker> {
  const picked = models.map((model) => {
    const id = groupPersonas?.[model]
    return { model, persona: id ? personas.find((p) => p.id === id) : undefined }
  })
  const speakers: Record<string, GroupSpeaker> = {}
  for (const { model, persona } of picked) {
    if (!persona) {
      speakers[model] = { name: model }
      continue
    }
    // Two participants on the same persona still need two names, or the tags
    // in the shared history could not tell them apart.
    const shared = picked.filter((other) => other.persona?.name === persona.name).length > 1
    speakers[model] = {
      name: shared ? `${persona.name} (${model})` : persona.name,
      personaId: persona.id,
      // A character card persona keeps `{{char}}` / `{{user}}` in its
      // prompt; fill them in here like a role play chat does.
      personaPrompt: persona.card
        ? substituteMacros(persona.systemPrompt, persona.name, DEFAULT_USER_NAME)
        : persona.systemPrompt,
    }
  }
  return speakers
}

/** True when at least one participant speaks as a persona of its own. */
export function hasOwnPersonas(speakers: Readonly<Record<string, GroupSpeaker>> | undefined): speakers is Record<string, GroupSpeaker> {
  return !!speakers && Object.values(speakers).some((s) => s.personaPrompt !== undefined)
}

export function groupSystemPrompt(
  model: string,
  allModels: string[],
  personaPrompt: string,
  /** From `groupSpeakers`. Without own personas the wording stays the one
   *  every group has had since v1. */
  speakers?: Readonly<Record<string, GroupSpeaker>>,
): string {
  let line: string
  if (hasOwnPersonas(speakers)) {
    const nameOf = (m: string) => speakers[m]?.name ?? m
    const self = nameOf(model)
    const others = allModels.filter((m) => m !== model).map((m) => `"${nameOf(m)}"`).join(', ')
    // The role belongs to ONE participant. Saying so, and naming the others,
    // is what keeps a model from answering as the character next to it.
    line =
      `In this group conversation you are "${self}" and only "${self}". The other participants are ${others}. ` +
      `What they said arrives as user messages that start with a [name] tag; the assistant messages are your own earlier turns. ` +
      `Stay in your own role: never speak as another participant and never write their lines. ` +
      `Add something new, and do not repeat what another participant already said.`
  } else {
    const others = allModels.filter((m) => m !== model).map((m) => `"${m}"`).join(', ')
    line =
      `You are "${model}", one of several AI models answering in the same group conversation with ${others}. ` +
      `What the other models said arrives as user messages that start with a [model-name] tag; the assistant messages are your own earlier turns. ` +
      `Answer as yourself in your own voice, add something new, and do not repeat what another model already said.`
  }
  return personaPrompt ? `${personaPrompt}\n\n${line}` : line
}

export interface GroupWireMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  images?: { data: string; mimeType: string }[]
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A model's OWN lines go over the wire untagged; the other speakers arrive
 *  tagged "[model-id] …". So a "[other-model] …" line in a model's own reply can
 *  only be fabrication: a weak model (two Phi-4-mini in one group, Discord
 *  2026-08-08) copies the format and appends a line pretending to BE the next
 *  speaker. v1 let that through. Cut from the first line that starts with another
 *  participant's exact tag to the end. Line-anchored and exact-id-only, so an
 *  inline mention ("I agree with [other]") or an ordinary "[note]" in prose is
 *  untouched; only a fabricated turn header is removed. */
export function stripImpersonatedSpeakers(text: string, otherModels: string[]): string {
  const ids = otherModels.filter((m) => m.trim()).map(escapeRegExp)
  if (!ids.length) return text
  const tag = new RegExp(`^[ \\t>]*\\[(?:${ids.join('|')})\\]`)
  const lines = text.split('\n')
  const cut = lines.findIndex((l) => tag.test(l))
  return cut === -1 ? text : lines.slice(0, cut).join('\n').trim()
}

/** The shared history as one model sees it: the OTHER speakers arrive as
 *  tagged user turns, this model's own turns stay assistant, empty
 *  placeholders and app notices are dropped.
 *
 *  Bug B3: role:'system' is an app notice here, not a turn. The caller puts the
 *  group system prompt at index 0 itself, so letting a stored one through would
 *  hand the engine a second system message somewhere in the middle, and a strict
 *  Jinja chat template refuses that outright with "System message must be at the
 *  beginning".
 *
 *  Bug B3 round 2: the other speakers used to arrive as assistant turns, tagged
 *  but assistant all the same. From round two on that puts two assistant
 *  messages next to each other in every payload, one per speaker, and a
 *  template that demands strict user/assistant alternation raises on it. The
 *  counter-check killed both speakers of a two-model group that way on the
 *  installed 2.6.7 build. A foreign turn is not this model's own speech, so
 *  the honest role for it is user; the [model-name] tag and the system prompt
 *  above say who is talking, which is how attribution worked all along. It
 *  also fixes round one for the second speaker, whose prompt used to end on
 *  somebody else's assistant turn and asked it to carry on mid-sentence. */
export function groupHistory(
  messages: Message[],
  model: string,
  /** From `groupSpeakers`: a participant with its own persona is tagged with
   *  that name, everyone else with the model name as before. */
  speakers?: Readonly<Record<string, GroupSpeaker>>,
  /** Who played which persona, for turns that carry no persona of their own
   *  (see `groupTurnAuthor`). */
  authors?: GroupAuthors,
): GroupWireMessage[] {
  const self = speakerKey(model, speakers)
  return messages
    // A failed turn carries the app's sentence behind its answer (`error.at`,
    // lib/message-error.ts). That sentence is not the speaker's: sent along,
    // the next speaker read "This message is longer than the model can read"
    // as what the one before it had said (T1 2026-10-29).
    .map((m) => (m.error ? { ...m, content: m.content.slice(0, Math.max(0, m.error.at)).trimEnd() } : m))
    .filter((m) => m.role !== 'system' && m.content.trim() !== '')
    .map((m) => {
      const author = m.role === 'assistant' ? groupTurnAuthor(m, speakers, authors) : null
      const foreign = !!author && author.key !== self
      return {
        role: (foreign ? 'user' : m.role) as GroupWireMessage['role'],
        content: foreign ? `[${author.name}] ${m.content}` : m.content,
        ...(m.images?.length ? { images: m.images.map((i) => ({ data: i.data, mimeType: i.mimeType })) } : {}),
      }
    })
}

/** What `groupTurnAuthor` needs besides the current speakers. */
export interface GroupAuthors {
  /** The conversation's persona picks, model name to persona id. Also covers
   *  a member that sits out because its model left the list. */
  groupPersonas?: Readonly<Record<string, string>>
  /** Every persona, to name one that no current member plays. */
  personas?: readonly { id: string; name: string }[]
}

/** Who a speaker is, for deciding which turns are its own: its persona when
 *  it is the only one playing it, otherwise its model. */
function speakerKey(model: string, speakers: Readonly<Record<string, GroupSpeaker>> | undefined): string {
  const personaId = speakers?.[model]?.personaId
  if (!personaId) return `model:${model}`
  const players = Object.values(speakers ?? {}).filter((s) => s.personaId === personaId).length
  return players === 1 ? `persona:${personaId}` : `model:${model}`
}

/**
 * The persona a group turn was written as, by the same fallbacks
 * `groupTurnAuthor` uses: the one recorded on the turn, else the one its
 * model plays now, else the one it played when it left the group or changed
 * persona. Undefined when the model played none.
 */
export function groupTurnPersonaId(
  m: Pick<Message, 'modelId' | 'groupPersonaId' | 'noGroupPersona'>,
  speakers: Readonly<Record<string, GroupSpeaker>> | undefined,
  authors?: GroupAuthors,
): string | undefined {
  if (!m.modelId || m.noGroupPersona) return undefined
  return m.groupPersonaId ?? speakers?.[m.modelId]?.personaId ?? authors?.groupPersonas?.[m.modelId]
}

/**
 * GH #169: who wrote a group turn. The persona decides, not the model.
 *
 * Turns used to be attributed by model id alone. After a persona moved to
 * another model (untick X, tick Z, give Z the persona), X's turns reached the
 * other participants as "[provider::X] ..." from a stranger, and Z received
 * the persona's own earlier lines as somebody else's.
 *
 * A turn written since 3.0.7 carries the persona it was written as
 * (`groupPersonaId`). An older turn falls back to the persona its model plays
 * now, or played when it left the group (chatStore stamps that on the way
 * out). The persona then belongs to whichever current member plays it.
 * Without any persona the model is the author, exactly as before.
 *
 * `key` says whose turn it is (compare with the speaker's own key), `name` is
 * the tag the others read.
 */
export function groupTurnAuthor(
  m: Pick<Message, 'modelId' | 'groupPersonaId' | 'groupSpeakerName' | 'noGroupPersona'>,
  speakers: Readonly<Record<string, GroupSpeaker>> | undefined,
  authors?: GroupAuthors,
): { key: string; name: string } | null {
  if (!m.modelId) return null
  // GH #180: written outside the group by the model as itself, so it goes by
  // the model's name, not by a persona the model plays today.
  if (m.noGroupPersona) return { key: `model:${m.modelId}`, name: m.modelId }
  const member = speakers?.[m.modelId]
  const personaId = groupTurnPersonaId(m, speakers, authors)
  if (!personaId) return { key: `model:${m.modelId}`, name: member?.name ?? m.modelId }
  const players = Object.entries(speakers ?? {}).filter(([, s]) => s.personaId === personaId)
  if (players.length === 1) {
    const [model, speaker] = players[0]
    return { key: speakerKey(model, speakers), name: speaker.name }
  }
  // Several current members play it: the one that wrote the turn, if it is
  // still one of them, keeps it under its own two part name.
  const writer = players.find(([model]) => model === m.modelId)
  if (writer) return { key: `model:${writer[0]}`, name: writer[1].name }
  const persona = authors?.personas?.find((p) => p.id === personaId)
  return { key: `persona:${personaId}`, name: persona?.name ?? m.groupSpeakerName ?? m.modelId }
}

/**
 * GH #180: a conversation that is, or has been, a group. Turning group chat
 * off leaves `groupModels` as an empty list (a chat that never was a group has
 * none), and a turn that names its persona was written in one.
 */
export function hasGroupHistory(conv: { groupModels?: readonly string[]; messages: readonly Pick<Message, 'groupPersonaId'>[] }): boolean {
  return Array.isArray(conv.groupModels) || conv.messages.some((m) => !!m.groupPersonaId)
}

/** The one speaker of a plain chat, in the shape `groupTurnAuthor` reads:
 *  the chat's own persona when one is on, otherwise the model itself. */
export function soloSpeakers(model: string, persona?: { id: string; name: string }): Record<string, GroupSpeaker> {
  return { [model]: persona ? { name: persona.name, personaId: persona.id } : { name: model } }
}

/** What a new plain turn in a thread with group history records about its
 *  author, so the turn keeps it when group chat is turned on again. */
export function soloTurnAuthorFields(persona?: { id: string; name: string }): Pick<Message, 'groupPersonaId' | 'groupSpeakerName' | 'noGroupPersona'> {
  return persona ? { groupPersonaId: persona.id, groupSpeakerName: persona.name } : { noGroupPersona: true }
}

/**
 * GH #180: the tag a stored turn carries in a PLAIN chat payload, or null
 * when it goes out as it is.
 *
 * With group chat off, every earlier turn of every speaker used to go out as
 * the current model's own assistant turn, so the model took the other
 * characters' lines for its own and carried on in their voice. In a thread
 * with group history the other speakers now arrive exactly as `groupHistory`
 * sends them: a user turn tagged "[name]". Who the current speaker is follows
 * `groupTurnAuthor`, with the chat's own persona standing in for a group pick;
 * without one, the model's own turns are its own whatever persona it played.
 *
 * An assistant turn that called tools stays as it is: the tool results after
 * it answer that call, and a user turn cannot carry one.
 */
export function soloHistoryTag(
  m: Pick<Message, 'role' | 'modelId' | 'groupPersonaId' | 'groupSpeakerName' | 'noGroupPersona' | 'tool_calls'>,
  model: string,
  speakers: Readonly<Record<string, GroupSpeaker>>,
  authors?: GroupAuthors,
): string | null {
  if (m.role !== 'assistant' || m.tool_calls?.length) return null
  // A model speaking as itself keeps every turn it wrote, under any persona:
  // nobody else in this chat could own them.
  if (!speakers[model]?.personaId && m.modelId === model) return null
  const author = groupTurnAuthor(m, speakers, authors)
  if (!author || author.key === speakerKey(model, speakers)) return null
  return author.name
}

/** The system line that tells a plain chat model what the tags mean. Only
 *  sent when the payload carries at least one tagged turn. */
export const SOLO_HISTORY_LINE =
  'Earlier turns of this conversation were written by other participants. ' +
  'What they said arrives as user messages that start with a [name] tag; the assistant messages are your own earlier turns. ' +
  'Stay in your own role and never write their lines.'
