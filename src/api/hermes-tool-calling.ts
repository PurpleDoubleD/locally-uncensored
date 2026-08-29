/**
 * Hermes XML-Tag Tool Calling — Prompt-Based Fallback
 *
 * Works with ANY model (abliterated, uncensored, standard, small, large).
 * Uses the Hermes/NousResearch format:
 *   - Tools described in <tools></tools> XML block in system prompt
 *   - Model responds with <tool_call>{"name": ..., "arguments": ...}</tool_call>
 *   - Results injected as <tool_response>...</tool_response>
 *
 * Reference: https://github.com/NousResearch/Hermes-Function-Calling
 */

import type { AgentToolDef } from '../types/agent-mode'
import { repairJson } from '../lib/tool-call-repair'

// Generic tool shape accepted by the prompt builder
type ToolLike = { name: string; description: string; parameters?: any; inputSchema?: any }

/**
 * Defuse the markers this dialect is built on, everywhere text we did not write
 * is folded into the prompt.
 *
 * On the native tool channel a result arrives in its own `tool` role and the
 * chat template fences it. Here it is prose inside a user turn, so a result
 * that literally contains `</tool_response>` closes its own fence and whatever
 * follows reads as the conversation. That text is routinely not ours:
 * web_fetch returns whatever a page says, shell_execute whatever a command
 * printed, and an MCP server the user installed writes its own tool
 * descriptions into the <tools> block.
 *
 * Locally this weighs more than it does in the cloud, because the tools on the
 * other end of the injected call run on the user's own machine.
 *
 * A zero-width space after the opening bracket is enough: the marker stops
 * being one for the model and for parseHermesToolCalls, while the text still
 * reads normally to a human and to a model summarising it. Ordinary prose with
 * a less-than sign is untouched. Mirrors apps/web/lib/chat/prompt-tools.ts.
 */
const TAG_MARKERS = /<(?=[|/]{0,2}(?:tool_call|tool_response|tools|tool)\b)/gi
const ZERO_WIDTH_SPACE = '\u200B'

export function neutralizeToolTags(text: string): string {
  return text.replace(TAG_MARKERS, `<${ZERO_WIDTH_SPACE}`)
}

// ── Build System Prompt with Tool Definitions ───────────────────

export function buildHermesToolPrompt(tools: (AgentToolDef | ToolLike)[]): string {
  // Descriptions are not ours once an MCP server is connected: they are
  // written by whoever wrote the server, so a description that ends the
  // <tools> block early must not be able to append a line to the contract.
  const toolDefs = tools.map((t) => neutralizeToolTags(JSON.stringify({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: (t as any).inputSchema || (t as any).parameters,
    },
  }))).join('\n')

  // Everything below the <tools> block is about HOW to use what is in it, so
  // each note only appears when the tool it talks about is actually offered.
  // The old prompt closed with a fixed "Other tools: ..." line naming four
  // hardcoded tools, and it had not been updated in five releases: it
  // contradicted the block right above it.
  const has = (name: string) => tools.some((t) => t.name === name)
  const notes: string[] = []
  if (has('todo_write')) {
    notes.push(
      'PLAN: for a task of more than about three calls, call todo_write FIRST with the whole plan, then again after each step with the COMPLETE list (finished item completed, next one in_progress). The user sees that list while you work.',
    )
  }
  if (has('web_search') && has('web_fetch')) {
    notes.push(
      'IMPORTANT: web_search returns ONLY short snippets, NOT real data. You MUST ALWAYS call web_fetch on the best URL to read actual page content before answering.\nWorkflow: web_search → get URLs → web_fetch → read page → answer based on real data.',
    )
  }
  if (has('file_edit')) {
    notes.push('To change part of an existing file use file_edit with a unique old_string, not file_write.')
  }
  notes.push('Respond in the same language the user uses.')

  return `You are a function calling AI model. You are provided with function signatures within <tools></tools> XML tags. You may call one or more functions to assist with the user query. Don't make assumptions about what values to plug into functions. Ask for clarification if needed.

<tools>
${toolDefs}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call>

${notes.join('\n\n')}`
}

// ── Build Tool Result Message ───────────────────────────────────

export function buildHermesToolResult(toolName: string, result: string): string {
  // The name comes back from the model, so it goes through JSON.stringify too:
  // interpolating it raw let a quote in an invented name break the object and
  // spill the rest of the line into the block.
  const body = JSON.stringify({ name: String(toolName ?? ''), content: result })
  return `<tool_response>
${neutralizeToolTags(body)}
</tool_response>`
}

// ── Parse Tool Calls from Model Output ──────────────────────────

export interface ParsedToolCall {
  name: string
  arguments: Record<string, any>
}

/**
 * Parse Hermes-format tool calls from model output.
 * Looks for <tool_call>...</tool_call> XML tags containing JSON.
 * Returns array of parsed tool calls (can be 0 or more).
 */
export function parseHermesToolCalls(output: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = []

  // Match all <tool_call>...</tool_call> blocks
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(output)) !== null) {
    const jsonStr = match[1].trim()
    // Try direct parse, then repair
    const parsed = repairJson(jsonStr)
    if (parsed && parsed.name) {
      calls.push({
        name: parsed.name,
        arguments: parsed.arguments || parsed.parameters || {},
      })
    } else {
      // Last resort regex
      const nameMatch = jsonStr.match(/["']?name["']?\s*[:=]\s*["']([^"']+)["']/i)
      const argsMatch = jsonStr.match(/["']?arguments["']?\s*[:=]\s*(\{[\s\S]*?\})/i)
      if (nameMatch) {
        let args = {}
        if (argsMatch) {
          const repaired = repairJson(argsMatch[1])
          if (repaired) args = repaired
        }
        calls.push({ name: nameMatch[1], arguments: args })
      }
    }
  }

  return calls
}

/**
 * Strip tool call tags from model output to get clean content.
 */
export function stripToolCallTags(output: string): string {
  return output
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, '')
    .trim()
}

/**
 * Check if model output contains any tool call tags.
 */
export function hasToolCallTags(output: string): boolean {
  return /<tool_call>/.test(output)
}

// ── Build a Tool CALL as prompt text ────────────────────────────

/**
 * The other half of the prompt transport: the model's own call, written back
 * into the history as text.
 *
 * On the native channel the call rides in `assistant.tool_calls` and the chat
 * template renders it. A template that has no tool support renders nothing at
 * all for that field, so the next turn shows the model a RESULT for a call it
 * can no longer see. Same dialect as buildHermesToolResult, so a history that
 * mixes the two reads as one conversation to the model.
 */
export function buildHermesToolCall(toolName: string, args: unknown): string {
  const body = JSON.stringify({ name: String(toolName ?? ''), arguments: args ?? {} })
  return `<tool_call>
${neutralizeToolTags(body)}
</tool_call>`
}
