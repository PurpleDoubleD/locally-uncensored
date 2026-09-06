import { extractToolCallsWithRanges, stripRanges } from '../../lib/tool-call-repair'
import type { ToolCall } from '../../api/providers/types'

/**
 * Werkzeugaufrufe, die das Modell in seinen Fliesstext geschrieben hat.
 *
 * Der Schnitt folgt dem geteilten Zustand `turnContent`/`toolCalls`: DREI
 * Regeln lasen und schrieben in useCodex.ts dieselben zwei Variablen
 * hintereinander, und nur zusammen ergeben sie den Vertrag "was ist Aufruf,
 * was ist Antwort". Auseinandergenommen kippt der Rest sofort — deshalb liegen
 * sie hier zu dritt und nicht als drei Helferlein.
 *
 *  1. NATIVE LISTE LEER, aber der Text sieht aus wie ein Aufruf: qwen2.5-coder:3b
 *     schickt einen ```json-Block in `content` statt in `message.tool_calls`.
 *     Herausziehen und den Block aus dem Text schneiden, damit der Nutzer kein
 *     rohes JSON sieht.
 *
 *  2. NATIVE LISTE VOLL, und dasselbe JSON steht TROTZDEM noch im Text.
 *     Ebenfalls herausschneiden — die Aufrufe sind schon geparst.
 *
 *  3. WAS UEBRIG BLEIBT, IST ANTWORT. Das ist die Regel, die man am leichtesten
 *     falsch macht: die Prosa um das JSON herum wird BEHALTEN, damit die
 *     Zwischenantworten in der Zeitleiste stehen bleiben (David 2026-06-02 r2:
 *     "antworten zwischen drin verschwinden immer, darf nicht sein"). Geleert
 *     wird nur, wenn nach dem Schnitt nichts als Satzzeichen und Leerraum
 *     dasteht.
 *
 * Reine Funktion von (Aufrufe, Text) auf (Aufrufe, Text) — in einem
 * 2358-Zeilen-`useCallback` war keine dieser drei Regeln einzeln erreichbar.
 */

export interface RecoveredTurn {
  toolCalls: ToolCall[]
  content: string
  /** Ob ueberhaupt etwas aus dem Text geschnitten wurde. */
  extractedFromContent: boolean
}

export function recoverToolCallsFromContent(toolCalls: ToolCall[], content: string): RecoveredTurn {
  let calls = toolCalls
  let turnContent = content
  // v2.5.0 fix (post-merge bug hunt): some Ollama models
  // (qwen2.5-coder:3b confirmed) emit tool calls as a fenced
  // ```json { "name":..., "arguments":... } ``` block inside
  // message.content INSTEAD of the native message.tool_calls
  // array. When the native list is empty but content looks like
  // a tool call, extract it and strip the fence so the user
  // doesn't see raw JSON.
  // Track whether this iteration's content held tool-call JSON.
  // qwen2.5-coder:3b emits the JSON in content rather than native
  // tool_calls, and every iteration wraps the JSON with the same
  // narrative ("I'm about to verify…" + code blocks). Those lines
  // are not the FINAL answer — they're filler between tool calls
  // and would duplicate across iterations if accumulated.
  let extractedFromContent = false
  if (calls.length === 0 && turnContent) {
    const { calls: extracted, ranges } = extractToolCallsWithRanges(turnContent)
    if (extracted.length > 0) {
      calls = extracted.map(tc => ({ function: { name: tc.name, arguments: tc.arguments } }))
      turnContent = stripRanges(turnContent, ranges)
      extractedFromContent = true
    }
  }
  // Safety net for qwen2.5-coder: sometimes the model emits the
  // tool-call JSON alongside native tool_calls — native was parsed
  // already, but the same JSON still sits in the content. Strip
  // those too so the chat bubble stays readable.
  if (calls.length > 0 && turnContent && /\{\s*"(?:name|tool|function)"\s*:/.test(turnContent)) {
    const { ranges } = extractToolCallsWithRanges(turnContent)
    if (ranges.length > 0) {
      turnContent = stripRanges(turnContent, ranges)
      extractedFromContent = true
    }
  }
  // When the model bundles its tool-call JSON INSIDE the text
  // (qwen2.5-coder & co.), KEEP the surrounding prose as this
  // iteration's commentary — the JSON itself was already removed by
  // stripRanges above. Keeping it (instead of clearing) is what makes
  // every between-tool answer survive so the renderer can interleave
  // them chronologically: tool → answer → tool → tool → answer …
  // (David 2026-06-02 r2: "antworten zwischen drin verschwinden immer,
  // darf nicht sein"). Older answers auto-collapse in the UI, so the
  // old "stack of duplicated I'm-about-to paragraphs" problem is gone.
  // Only drop it when nothing but punctuation/whitespace remains.
  if (extractedFromContent && !/[A-Za-z0-9]/.test(turnContent)) turnContent = ''
  return { toolCalls: calls, content: turnContent, extractedFromContent }
}
