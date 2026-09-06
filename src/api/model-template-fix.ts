/**
 * Model Template Fix for Agent Mode
 *
 * Abliterated/uncensored models lose their tool-calling template during modification.
 * This module can "fix" them by creating a new Ollama model variant with the correct
 * tool-calling template re-applied. The model weights are the same — only the template changes.
 *
 * Flow:
 * 1. Detect model family (llama, qwen, etc.) via `ollama show`
 * 2. Look up the correct tool-calling template for that family
 * 3. Create a new model via `ollama create` with: FROM <original> + TEMPLATE <tool-template>
 * 4. The new model name is: <original>-agent (e.g. "mannix/llama3.1-8b-abliterated:agent")
 */

import { localFetch, localFetchStream, ollamaUrl } from './backend'
import { isLocalTransportFailure, localBackendUnreachableMessage } from '../lib/local-backend-transport'

// ── Tool-Calling Templates per Model Family ───────────────────────

const LLAMA31_TOOL_TEMPLATE = `{{ if .Messages }}
{{- if or .System .Tools }}<|start_header_id|>system<|end_header_id|>
{{- if .System }}
{{ .System }}
{{- end }}
{{- if .Tools }}
You are a helpful assistant with tool calling capabilities. When you receive a tool call response, use the output to format an answer to the orginal use question.
{{- end }}<|eot_id|>
{{- end }}
{{- range $i, $_ := .Messages }}
{{- $last := eq (len (slice $.Messages $i)) 1 }}
{{- if eq .Role "user" }}<|start_header_id|>user<|end_header_id|>
{{- if and $.Tools $last }}
Given the following functions, please respond with a JSON for a function call with its proper arguments that best answers the given prompt.
Respond in the format {"name": function name, "parameters": dictionary of argument name and its value}. Do not use variables.
{{ $.Tools }}
{{- end }}
{{ .Content }}<|eot_id|>{{ if $last }}<|start_header_id|>assistant<|end_header_id|>
{{ end }}
{{- else if eq .Role "assistant" }}<|start_header_id|>assistant<|end_header_id|>
{{- if .ToolCalls }}
{{- range .ToolCalls }}{"name": "{{ .Function.Name }}", "parameters": {{ .Function.Arguments }}}{{ end }}
{{- else }}
{{ .Content }}{{ if not $last }}<|eot_id|>{{ end }}
{{- end }}
{{- else if eq .Role "tool" }}<|start_header_id|>ipython<|end_header_id|>
{{ .Content }}<|eot_id|>{{ if $last }}<|start_header_id|>assistant<|end_header_id|>
{{ end }}
{{- end }}
{{- end }}
{{- else }}
{{- if .System }}<|start_header_id|>system<|end_header_id|>
{{ .System }}<|eot_id|>{{ end }}{{ if .Prompt }}<|start_header_id|>user<|end_header_id|>
{{ .Prompt }}<|eot_id|>{{ end }}<|start_header_id|>assistant<|end_header_id|>
{{ end }}{{ .Response }}{{ if .Response }}<|eot_id|>{{ end }}`

const QWEN_TOOL_TEMPLATE = `{{- if .Messages }}
{{- if or .System .Tools }}<|im_start|>system
{{- if .System }}
{{ .System }}
{{- end }}
{{- if .Tools }}

# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{{- range .Tools }}
{"type": "function", "function": {{ .Function }}}
{{- end }}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call>
{{- end }}<|im_end|>
{{ end }}
{{- range $i, $_ := .Messages }}
{{- $last := eq (len (slice $.Messages $i)) 1 }}
{{- if eq .Role "user" }}<|im_start|>user
{{ .Content }}<|im_end|>
{{ if $last }}<|im_start|>assistant
{{ end }}
{{- else if eq .Role "assistant" }}<|im_start|>assistant
{{- if .ToolCalls }}
{{- range .ToolCalls }}
<tool_call>
{"name": "{{ .Function.Name }}", "arguments": {{ .Function.Arguments }}}
</tool_call>
{{- end }}
{{- else }}
{{ .Content }}
{{- end }}{{ if not $last }}<|im_end|>
{{ end }}
{{- else if eq .Role "tool" }}<|im_start|>user
<tool_response>
{{ .Content }}
</tool_response><|im_end|>
{{ if $last }}<|im_start|>assistant
{{ end }}
{{- end }}
{{- end }}
{{- else }}
{{- if .System }}<|im_start|>system
{{ .System }}<|im_end|>
{{ end }}{{ if .Prompt }}<|im_start|>user
{{ .Prompt }}<|im_end|>
{{ end }}<|im_start|>assistant
{{ end }}{{ .Response }}{{ if .Response }}<|im_end|>{{ end }}`

const MISTRAL_TOOL_TEMPLATE = `{{- if .Messages }}
{{- range $index, $_ := .Messages }}
{{- if eq .Role "user" }}[INST] {{ if and $.Tools (eq (len (slice $.Messages $index)) 1) }}[AVAILABLE_TOOLS] {{ $.Tools }} [/AVAILABLE_TOOLS] {{ end }}{{ .Content }} [/INST]
{{- else if eq .Role "assistant" }}
{{- if .ToolCalls }} [TOOL_CALLS] [
{{- range .ToolCalls }}{"name": "{{ .Function.Name }}", "arguments": {{ .Function.Arguments }}}
{{- end }}]
{{- else }} {{ .Content }}
{{- end }}</s>
{{- else if eq .Role "tool" }}[TOOL_RESULTS] {{ .Content }} [/TOOL_RESULTS]
{{- end }}
{{- end }}
{{- else }}[INST] {{ if .System }}{{ .System }} {{ end }}{{ .Prompt }} [/INST] {{ end }}{{ .Response }}</s>`

// Map model families to their tool templates
const FAMILY_TEMPLATES: Record<string, string> = {
  llama: LLAMA31_TOOL_TEMPLATE,
  qwen2: QWEN_TOOL_TEMPLATE,
  qwen3: QWEN_TOOL_TEMPLATE,
  mistral: MISTRAL_TOOL_TEMPLATE,
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Get the agent-variant model name for a given model.
 * e.g., "mannix/llama3.1-8b-abliterated:q5_K_M" → "mannix/llama3.1-8b-abliterated:agent"
 */
export function getAgentModelName(originalName: string): string {
  // Strip the tag and add :agent
  const baseName = originalName.replace(/:.*$/, '')
  return `${baseName}:agent`
}

/**
 * Check if a model family has a known tool template we can apply.
 */
export async function canFixModel(modelName: string): Promise<{ fixable: boolean; family: string }> {
  try {
    const res = await localFetch(ollamaUrl('/show'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
    })
    if (!res.ok) return { fixable: false, family: 'unknown' }
    const data = await res.json()
    const family = data.details?.family || ''

    // Check if we have a template for this family
    const hasTemplate = Object.keys(FAMILY_TEMPLATES).some(f => family.startsWith(f))
    return { fixable: hasTemplate, family }
  } catch {
    return { fixable: false, family: 'unknown' }
  }
}

/**
 * Check if the agent variant already exists.
 */
export async function agentVariantExists(modelName: string): Promise<boolean> {
  const agentName = getAgentModelName(modelName)
  try {
    const res = await localFetch(ollamaUrl('/show'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: agentName }),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Create an agent variant of a model by applying the correct tool-calling template.
 * This uses `ollama create` with a Modelfile that re-applies the template.
 *
 * Returns the new model name on success, or throws on failure.
 */
export async function createAgentVariant(
  modelName: string,
  onProgress?: (status: string) => void
): Promise<string> {
  // 1. Get model family
  const { fixable, family } = await canFixModel(modelName)
  if (!fixable) {
    throw new Error(`No tool template available for model family: ${family}`)
  }

  // 2. Find the right template
  const templateKey = Object.keys(FAMILY_TEMPLATES).find(f => family.startsWith(f))
  if (!templateKey) throw new Error(`No template for family: ${family}`)
  const template = FAMILY_TEMPLATES[templateKey]

  // 3. Create via new Ollama API format (model + from + template)
  const agentName = getAgentModelName(modelName)

  onProgress?.('Creating agent variant...')

  // Use localFetchStream because /api/create returns NDJSON stream
  const res = await localFetchStream(ollamaUrl('/create'), {
    method: 'POST',
    body: JSON.stringify({
      model: agentName,
      from: modelName,
      template: template,
    }),
  })

  if (!res.ok) {
    const error = await res.text()
    // Ollama nicht erreichbar: der Proxy antwortet mit seiner eigenen Zeile,
    // Rust-Befehlsname inklusive. Gleiche Behandlung wie im Chat und im
    // Agentenlauf (04.09.2026).
    const wo = ollamaUrl('/create')
    throw new Error(
      isLocalTransportFailure(error, wo)
        ? localBackendUnreachableMessage('Ollama', wo)
        : `Failed to create agent variant: ${error}`,
    )
  }

  // Consume the stream to completion
  const text = await res.text()
  if (text.includes('"error"')) {
    const match = text.match(/"error"\s*:\s*"([^"]+)"/)
    if (match) throw new Error(match[1])
  }

  onProgress?.('Agent variant ready!')
  return agentName
}
