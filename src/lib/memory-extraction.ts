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
  existingMemoriesSummary: string
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
- Do NOT duplicate existing memories (listed below)
- Keep titles under 60 characters, descriptions under 120 characters
- Content should be concise but complete (1-3 sentences)

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
- For UPDATE, "targetId" MUST be one of the ids listed below, and "mergedContent" MUST be a single concise sentence or two.
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
