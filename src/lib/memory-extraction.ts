/**
 * Memory Extraction — LLM-based auto-extraction of memorable information.
 *
 * After each conversation turn, optionally asks the LLM to analyze the exchange
 * and extract information worth remembering across conversations.
 *
 * Categories:
 * - user:      User preferences, role, knowledge level
 * - feedback:  Corrections and confirmations ("don't do X", "yes, keep doing Y")
 * - project:   Ongoing work context, goals, decisions
 * - reference: Pointers to external resources, tools, URLs
 */

import { extractJsonObject } from './json-scan'
import { isRecord, asString, asStringArray } from '../types/json-guards'
import type { MemoryType } from '../types/agent-mode'
import { onlyStatesAGap } from './memory-gap'

export interface ExtractedMemory {
  type: MemoryType
  title: string
  description: string
  content: string
  tags: string[]
}

export interface ExtractionResult {
  shouldSave: boolean
  memories: ExtractedMemory[]
}

/**
 * Build the prompt that instructs the LLM to analyze a conversation exchange
 * and decide what (if anything) should be remembered.
 */
export function buildExtractionPrompt(
  userMessage: string,
  assistantResponse: string,
  existingMemoriesSummary: string,
  /** Further lines for the rules. The desktop passes none, its prompt is word for word what it was. */
  extraRules: readonly string[] = [],
): Array<{ role: 'system' | 'user'; content: string }> {
  const systemPrompt = `You are a memory extraction system. Analyze the conversation exchange below and decide if anything should be remembered for future conversations.

## Memory Types
- **user**: User preferences, role, expertise, knowledge level, how they like to work
- **feedback**: Corrections ("don't do X") or confirmations ("yes, keep doing Y")
- **project**: Ongoing work context, goals, decisions, deadlines
- **reference**: External resources, tools, URLs, documentation pointers

## Rules
- Only extract genuinely useful cross-conversation information
- Do NOT save: trivial greetings, one-off questions, code snippets, debugging sessions
- Do NOT save that a tool, a file or the app failed, was denied or is unavailable: that state ends with the conversation, and a memory of it stops the assistant from trying again
- Do NOT save instructions about what to remember or how memories work
- Do NOT duplicate existing memories (listed below)
- Keep titles under 60 characters, descriptions under 120 characters
- Content should be concise but complete (1-3 sentences)
${extraRules.map((rule) => `- ${rule}\n`).join('')}
## Existing Memories
${existingMemoriesSummary || 'None yet.'}

## Response Format
Respond with ONLY valid JSON (no markdown, no explanation):
{"shouldSave": true/false, "memories": [{"type": "user|feedback|project|reference", "title": "...", "description": "...", "content": "...", "tags": ["..."]}]}`

  const userPrompt = `## User said:
${userMessage.substring(0, 500)}

## Assistant replied:
${assistantResponse.substring(0, 500)}

Analyze this exchange. What (if anything) should be remembered?`

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]
}

/** How much of a persona's text the extraction reads, for the spelling of names. */
export const EXTRACTION_PERSONA_CHARS = 600

/**
 * The rules every extraction gets on top of the fixed ones (GH #255).
 *
 * The extractor read only the last exchange and wrote in English, so a
 * Japanese story chat got memories in English with the characters' names
 * spelled its own way, next to the user's own entries about the same day. It
 * now writes in the language of the conversation and, when the chat plays a
 * persona, reads the start of that persona for the names.
 */
export function extractionContextRules(persona?: { name: string; text?: string }): string[] {
  const rules = ['Write title, description and content in the language the user writes in. Do not translate them into English']
  const name = persona?.name.trim()
  if (name) {
    const excerpt = (persona?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, EXTRACTION_PERSONA_CHARS)
    rules.push(`The assistant plays the persona "${name}". Spell the names of the persona and of its characters exactly as written here${excerpt ? `: ${excerpt}` : ''}`)
  }
  return rules
}

/**
 * The rules a phone adds to the prompt (hooks/useMemory.ts, behind isMobile).
 * Second check on Android, F12, and the small iPhone, K12: a question about a
 * ship became the entry "User Inquiry about Ship Zephyr-15's Cargo Code"
 * under "About you", and another entry came out of a PDF.
 */
export const PHONE_EXTRACTION_RULES: readonly string[] = [
  'A question the user asked is NOT a fact about the user. Never save "the user asked about X" or "user inquiry about X"',
  'Only save what the user states about themselves, their work or how they want answers. If the user states nothing like that, respond with {"shouldSave": false, "memories": []}',
  'What a document, a file or a web page says is never a fact about the user',
]

const FIRST_PERSON = /(^|[^\p{L}])(i|i'm|i've|i'd|i'll|im|my|me|mine|myself|we|we're|our|ours|us|ich|mein|meine|meinen|meinem|meiner|meins|mir|mich|wir|unser|unsere|unseren|unserem|uns)(?=$|[^\p{L}])/iu
const KEEP_REQUEST = /\b(remember|keep in mind|don't forget|do not forget|from now on|always|never|merk dir|merke dir|vergiss nicht|ab jetzt|immer|nie)\b/i

/**
 * Pure: does this message say anything about the user at all. False for a
 * bare question or a bare order ("What is the cargo code of the ship
 * Zephyr-12?"): no first person, no "remember", no "from now on". A phone does
 * not ask the model for memories after such a message; nothing in it is about
 * the user, and a small model answers the extraction anyway.
 */
export function saysSomethingAboutTheUser(userMessage: string): boolean {
  const text = userMessage.trim()
  if (!text) return false
  return FIRST_PERSON.test(text) || KEEP_REQUEST.test(text)
}

const RETELLS_A_QUESTION = /\b(inquir(y|ies|ed|es)|enquir(y|ies|ed|es)|asked|asks|asking|question(s|ed)?|query|queried|request(s|ed)?|wants? to know|wanted to know|looking for|look(ed|s)? up|searched for)\b/i

/**
 * Pure: is this extracted memory only the retelling of what the user asked
 * ("User Inquiry about ...", "The user asked for the cargo code"). Judged by
 * the title, and by the content when it opens with "The user asked".
 */
export function retellsAQuestion(memory: Pick<ExtractedMemory, 'title' | 'content'>): boolean {
  if (RETELLS_A_QUESTION.test(memory.title)) return true
  return /^\s*(the\s+)?user\s+(has\s+|had\s+|is\s+|was\s+)?(asked|asks|asking|inquired|inquires|enquired|requested|requests|wanted to know|wants to know|is looking for|was looking for)\b/i.test(memory.content)
}

/**
 * Pure: is this extracted memory only the retelling of what the ASSISTANT
 * wrote ("Assistant's response content", "Assistant explained that ...").
 * Check 4 on Android, finding F1: after "I am a nurse" a model of 0.8B kept
 * exactly that under "How to answer", and nothing about the user.
 */
export function retellsTheAnswer(memory: Pick<ExtractedMemory, 'title' | 'content'>): boolean {
  if (/\b(assistant|ai|model|chatbot)('s)?\s+(response|reply|answer|explanation|output|message)\b/i.test(memory.title)) return true
  return /^\s*(the\s+)?(assistant|ai|model|chatbot)\s+(has\s+|had\s+)?(explained|said|says|replied|responded|answered|provided|described|gave|told|wrote|listed|suggested|recommended|outlined|mentioned|noted)\b/i.test(memory.content)
}

/**
 * What a user says about themselves in plain words, in English and German:
 * "I am a nurse", "I work as ...", "My name is ...", "I live in ...".
 * Narrow on purpose: "I am a bit tired" and "I am not sure" are no facts.
 */
const SELF_STATEMENTS: readonly RegExp[] = [
  /(?:^|[^\p{L}])(?:i am|i'm|i\u2019m|im) (?!a (?:bit|little|lot|tad)\b)(?:a|an|the) \p{L}[^.!?\n]{1,100}/iu,
  /(?:^|[^\p{L}])i work (?:as|at|in|for) \p{L}[^.!?\n]{1,100}/iu,
  /(?:^|[^\p{L}])my name is \p{L}[^.!?\n]{0,60}/iu,
  /(?:^|[^\p{L}])i live in \p{L}[^.!?\n]{0,60}/iu,
  /(?:^|[^\p{L}])ich bin (?!ein (?:bisschen|wenig)\b)(?:ein|eine|der|die) \p{L}[^.!?\n]{1,100}/iu,
  /(?:^|[^\p{L}])ich arbeite (?:als|bei|in|f\u00fcr) \p{L}[^.!?\n]{1,100}/iu,
  /(?:^|[^\p{L}])(?:ich hei(?:\u00df|ss)e|mein name ist) \p{L}[^.!?\n]{0,60}/iu,
  /(?:^|[^\p{L}])ich wohne in \p{L}[^.!?\n]{0,60}/iu,
]

/**
 * Pure: the plain statement about the user in this message, as a memory of
 * the type "user", or null when there is none.
 *
 * The phone keeps it when the model did not (hooks/useMemory.ts, behind
 * isMobile): a model small enough for a phone answers the extraction with
 * the topic of the chat or with what the assistant said, and the one thing
 * the switch promises, that LU learns who it talks to, did not happen
 * (check 4 on Android, F1: three times "I am a nurse", no entry about the
 * user). The words are the user's own, nothing is inferred.
 */
export function plainSelfStatement(userMessage: string): ExtractedMemory | null {
  for (const pattern of SELF_STATEMENTS) {
    const match = pattern.exec(userMessage)
    if (!match) continue
    // Up to the first comma that opens a new clause is too little ("a nurse, and I ..."): the sentence is kept whole.
    const sentence = match[0].replace(/^[^\p{L}]+/u, '').replace(/\s+/g, ' ').trim().replace(/[,;:\s]+$/, '')
    if (sentence.length < 8) continue
    const said = sentence.charAt(0).toUpperCase() + sentence.slice(1)
    return {
      type: 'user',
      title: said.length > 60 ? `${said.slice(0, 57).trimEnd()}...` : said,
      description: 'Said by you in a chat.',
      content: `The user said: "${said}."`,
      tags: [],
    }
  }
  return null
}

/**
 * Pure: is this memory already kept. True for the same words (case and
 * spaces aside), and true when an entry of the same type carries every
 * longer word of it: "I am a nurse" next to "The user is a nurse and works
 * night shifts" would be the same fact twice.
 */
export function alreadyKept(memory: Pick<ExtractedMemory, 'type' | 'content'>, existing: ReadonlyArray<{ type: string; content: string }>): boolean {
  const norm = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()
  const wanted = norm(memory.content)
  const words = (wanted.match(/\p{L}{4,}/gu) ?? []).filter((word) => word !== 'user' && word !== 'said')
  return existing.some((e) => {
    if (e.type !== memory.type) return false
    const have = norm(e.content)
    return have === wanted || (words.length > 0 && words.every((word) => have.includes(word)))
  })
}

/** The four categories the prompt offers; anything else is not a category. */
const VALID_MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference']

function asMemoryType(v: unknown): MemoryType | undefined {
  return VALID_MEMORY_TYPES.find((t) => t === v)
}

/**
 * Parse the LLM's extraction response. Handles models that wrap JSON in
 * markdown code blocks or add preamble text.
 */
export function parseExtractionResponse(response: string): ExtractionResult {
  const fallback: ExtractionResult = { shouldSave: false, memories: [] }

  try {
    // Try to extract JSON from the response
    let jsonStr = response.trim()

    // Reasoning models prepend a think block, and extractJsonObject takes the
    // FIRST balanced object that parses, so a brace pair inside that block would
    // be stored as the user's memory. Drop it (an unterminated one means the
    // token budget died mid-think: nothing to parse). Word for word the web's
    // the web app.
    jsonStr = jsonStr.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
    if (/<think>/i.test(jsonStr)) return fallback

    // Strip markdown code blocks
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim()
    }

    // Try to find JSON object in the response
    const data = extractJsonObject(jsonStr)
    if (!isRecord(data)) return fallback

    if (typeof data.shouldSave !== 'boolean') return fallback
    if (!data.shouldSave) return { shouldSave: false, memories: [] }
    if (!Array.isArray(data.memories)) return fallback

    // Validate each memory. Everything below the guard is derived from checked
    // values — the model wrote this array and gets no say in the shape.
    const memories: ExtractedMemory[] = []
    for (const raw of data.memories) {
      if (!isRecord(raw)) continue
      const type = asMemoryType(raw.type)
      const title = asString(raw.title)
      const content = asString(raw.content)
      if (!type || !title || !content) continue
      const description = asString(raw.description) || content.substring(0, 120)
      // "X is unknown" is not a fact about the user (memory-gap.ts).
      if (onlyStatesAGap({ content, description })) continue
      memories.push({
        type,
        title: title.substring(0, 60),
        description: description.substring(0, 120),
        content,
        tags: asStringArray(raw.tags),
      })
    }

    return { shouldSave: memories.length > 0, memories }
  } catch {
    return fallback
  }
}

// ── Write-decision resolution (Feature FF, v2.5.0) ────────────────
//
// When a freshly-extracted fact is SIMILAR (but not identical) to existing
// memories, a second lightweight LLM call decides whether to ADD it as new,
// UPDATE/merge it into one existing entry, or treat it as a NOOP (already
// captured). This is the "is this new information, a correction, or a
// duplicate?" judgement the embedding distance alone can't make.

export type WriteAction = 'ADD' | 'UPDATE' | 'NOOP'

export interface ResolutionDecision {
  action: WriteAction
  /** For UPDATE: id of the existing memory to merge into. */
  targetId?: string
  /** For UPDATE: the merged content that should replace the target's content. */
  mergedContent?: string
}

/** A candidate existing memory passed to the resolver (top-K by similarity). */
export interface SimilarExisting {
  id: string
  title: string
  content: string
}

/**
 * Build the prompt that asks the LLM to resolve a new fact against the most
 * similar existing memories. Mirrors the extraction prompt's contract:
 * JSON-only output, no markdown, explicit allowed shapes.
 */
export function buildResolutionPrompt(
  newFact: { title: string; content: string },
  topKSimilarExisting: SimilarExisting[],
): Array<{ role: 'system' | 'user'; content: string }> {
  const existingList = topKSimilarExisting.length > 0
    ? topKSimilarExisting
        .map((e) => `- id: ${e.id}\n  title: ${e.title}\n  content: ${e.content}`)
        .join('\n')
    : 'None.'

  const systemPrompt = `You are a memory reconciliation system. A new fact has been extracted from a conversation. Decide how it relates to the most similar existing memories.

## Actions
- **ADD**: the new fact is genuinely new information not covered by any existing memory.
- **UPDATE**: the new fact corrects, refines, or supersedes ONE existing memory. Provide that memory's "targetId" and a "mergedContent" string that combines the still-valid parts with the new information (prefer the newer fact on conflict).
- **NOOP**: the new fact is already fully captured by an existing memory — nothing to do.

## Rules
- Choose UPDATE only when the new fact clearly relates to exactly one existing memory.
- For UPDATE, "targetId" MUST be one of the ids listed below, and "mergedContent" MUST be a single concise sentence or two, written in the language of that existing memory.
- When in doubt between ADD and UPDATE, prefer ADD (losing a correction is worse than a near-duplicate).

## Existing similar memories
${existingList}

## Response Format
Respond with ONLY valid JSON (no markdown, no explanation):
{"action": "ADD|UPDATE|NOOP", "targetId": "<id or omit>", "mergedContent": "<merged text or omit>"}`

  const userPrompt = `## New fact
title: ${newFact.title.substring(0, 120)}
content: ${newFact.content.substring(0, 500)}

How does this new fact relate to the existing memories? Respond with the JSON decision.`

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]
}

/**
 * Parse the resolver's decision. Reuses the same JSON-only / markdown-strip /
 * validate pattern as parseExtractionResponse. Defends against the model
 * choosing UPDATE without a usable targetId/mergedContent by downgrading to a
 * safe action (ADD when targetId is missing, NOOP-equivalent handled by the
 * caller). Falls back to ADD on any parse failure — the safe default that
 * never silently drops a fact.
 */
export function parseResolutionResponse(
  response: string,
  validIds?: string[],
): ResolutionDecision {
  const fallback: ResolutionDecision = { action: 'ADD' }

  try {
    let jsonStr = response.trim()

    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim()

    const data = extractJsonObject(jsonStr)
    if (!isRecord(data)) return fallback
    const action = (asString(data.action) ?? '').toUpperCase()

    if (action === 'NOOP') return { action: 'NOOP' }

    if (action === 'UPDATE') {
      const targetId = asString(data.targetId) ?? ''
      const mergedContent = (asString(data.mergedContent) ?? '').trim()
      // UPDATE needs a valid target + non-empty merged content; otherwise the
      // safest interpretation is "this is new" → ADD.
      const idOk = targetId && (!validIds || validIds.includes(targetId))
      if (idOk && mergedContent) {
        return { action: 'UPDATE', targetId, mergedContent }
      }
      return { action: 'ADD' }
    }

    if (action === 'ADD') return { action: 'ADD' }

    return fallback
  } catch {
    return fallback
  }
}
