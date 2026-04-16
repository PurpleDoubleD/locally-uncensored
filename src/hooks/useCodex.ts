import { useRef, useState, useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import { useCodexStore } from '../stores/codexStore'
import { useModelStore } from '../stores/modelStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useChatStore } from '../stores/chatStore'
import { getProviderForModel, getProviderIdFromModel } from '../api/providers'
import { toolRegistry } from '../api/mcp'
import { usePermissionStore } from '../stores/permissionStore'
import { getToolCallingStrategy } from '../lib/model-compatibility'
import { buildHermesToolPrompt, buildHermesToolResult, parseHermesToolCalls, stripToolCallTags, hasToolCallTags } from '../api/hermes-tool-calling'
import { chatNonStreaming } from '../api/agents'
import { setActiveChatId, clearActiveChatId } from '../api/agent-context'
import type { CodexEvent } from '../types/codex'
import type { AgentBlock, AgentToolCall } from '../types/agent-mode'
import { selectRelevantTools } from '../lib/tool-selection'
import { isThinkingCompatible, isPlainTextPlanner } from '../lib/model-compatibility'
import type { ChatMessage, ToolCall, ToolDefinition } from '../api/providers/types'
import { executeParallel, applyResultToToolCall, type ExecutionRequest } from '../api/agents/tool-executor'
import { useToolAuditStore } from '../stores/toolAuditStore'
import { makeInTurnCacheLookup } from '../api/agents/in-turn-cache'
import { explainError as explainToolError } from '../api/agents/error-hints'
import { budgetFromSettings } from '../api/agents/budget'
import { finalStripThinkingTags } from '../lib/thinking-stripper'
import { ollamaUrl, localFetchStream } from '../api/backend'
import { repairToolCallArgs } from '../lib/tool-call-repair'

const CODEX_SYSTEM_PROMPT = `You are Codex, an autonomous coding agent inside Locally Uncensored. You execute coding tasks end-to-end by reading files, writing code, and running shell commands. You MUST use tools — never guess file contents.

AUTONOMY CONTRACT (read carefully):
- You are expected to COMPLETE multi-step tasks without the user prompting between steps.
- NEVER say "Now I will create X" or "Next I'll write Y" as plain text and then stop. That is a FAILURE.
- When your plan has N steps, execute ALL N steps in one session — each step as a concrete tool call.
- The ONLY reasons to finish without calling another tool are:
    (a) the task is 100% complete AND verified, or
    (b) you hit an error you cannot recover from after trying.
- Narrative "I'm about to do X" text with no tool call after it = premature stop. Don't do it.

Workflow per task:
1. Understand the task (optional brief sentence)
2. Explore the codebase — file_list / file_read / file_search
3. Implement ALL required changes — file_write, as many calls as needed in one go
4. Verify — shell_execute to run tests, lint, or build
5. Only THEN write a short summary of what you did

Rules:
- Always read a file before modifying it
- Chain tool calls: after each tool result, if there is another step left, IMMEDIATELY call the next tool
- If a command fails, diagnose and retry with a different approach — don't hand back to the user unless truly stuck
- Be concise in text. All the work happens in tool calls.`

// ── Streaming tool-call helper for Ollama ──────────────────────────────
// Replaces the non-streaming chatWithTools() so the user sees live
// content/thinking tokens while Gemma 4 generates (2+ minutes).
async function streamWithTools(
  modelId: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  options: { temperature?: number; thinking?: boolean; maxTokens?: number; signal?: AbortSignal },
  onContent: (content: string) => void,
  onThinking: (thinking: string) => void,
): Promise<{ content: string; toolCalls: ToolCall[]; thinking: string }> {
  const ollamaMessages = messages.map(m => {
    const msg: Record<string, any> = { role: m.role, content: m.content }
    if (m.tool_calls) msg.tool_calls = m.tool_calls
    if ((m as any).images?.length) msg.images = (m as any).images.map((img: any) => img.data)
    return msg
  })

  const body: Record<string, any> = {
    model: modelId,
    messages: ollamaMessages,
    tools,
    stream: true,
    options: { num_gpu: 99 },
  }
  if (options.temperature !== undefined) body.options.temperature = options.temperature
  if (options.maxTokens) body.options.num_predict = options.maxTokens
  if (options.thinking === true) body.think = true
  else if (options.thinking === false) body.think = false

  const url = ollamaUrl('/chat')
  // Use localFetchStream which tries direct fetch first, then falls back
  // to the Tauri Rust proxy (proxy_localhost_stream). Plain `fetch` fails
  // in the Tauri .exe because WebView can't reach localhost:11434 directly.
  let response: Response
  try {
    response = await localFetchStream(url, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: options.signal,
    })
  } catch (fetchErr) {
    throw fetchErr
  }

  // Retry without think on 400 (old Ollama builds / non-thinking models)
  if (!response.ok && response.status === 400 && 'think' in body) {
    delete body.think
    response = await localFetchStream(url, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: options.signal,
    })
  }

  if (!response.ok) {
    const text = await response.text()
    const err = new Error(`HTTP ${response.status}: ${text}`) as any
    err.statusCode = response.status
    throw err
  }

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
  let thinking = ''
  let toolCalls: ToolCall[] = []

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const j = JSON.parse(trimmed)
        if (j.message) {
          if (j.message.content) {
            content += j.message.content
            onContent(content)
          }
          if (j.message.thinking) {
            thinking += j.message.thinking
            onThinking(thinking)
          }
          // Ollama may split tool_calls across chunks — append, don't overwrite
          if (j.message.tool_calls && Array.isArray(j.message.tool_calls)) {
            toolCalls = [...toolCalls, ...j.message.tool_calls.map((tc: any) => ({
              function: { name: tc.function.name, arguments: repairToolCallArgs(tc.function.arguments) },
            }))]
          }
        }
      } catch { /* partial JSON line — skip */ }
    }
  }

  // Process any remaining buffer
  if (buf.trim()) {
    try {
      const j = JSON.parse(buf.trim())
      if (j.message?.tool_calls && Array.isArray(j.message.tool_calls)) {
        toolCalls = [...toolCalls, ...j.message.tool_calls.map((tc: any) => ({
          function: { name: tc.function.name, arguments: repairToolCallArgs(tc.function.arguments) },
        }))]
      }
      if (j.message?.content) {
        content += j.message.content
        onContent(content)
      }
      if (j.message?.thinking) {
        thinking += j.message.thinking
        onThinking(thinking)
      }
    } catch { /* ignore */ }
  }

  return { content, toolCalls, thinking }
}

// Coding-relevant tool categories
const CODEX_CATEGORIES = ['filesystem', 'terminal', 'system', 'web'] as const

export function useCodex() {
  const [isRunning, setIsRunning] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const runningRef = useRef(false)

  const sendInstruction = useCallback(async (instruction: string) => {
    const { activeModel } = useModelStore.getState()
    if (!activeModel) return

    const store = useChatStore.getState()
    const codexStore = useCodexStore.getState()
    const { settings } = useSettingsStore.getState()
    const persona = useSettingsStore.getState().getActivePersona()

    // Ensure conversation exists
    let convId = store.activeConversationId
    if (!convId) {
      convId = store.createConversation(activeModel, persona?.systemPrompt || '', 'codex')
    }

    // Per-chat agent workspace → `~/agent-workspace/<convId>/`.
    // Cleared in the finally block so standalone tool calls elsewhere
    // don't leak into this conversation's folder.
    setActiveChatId(convId)

    // Init codex thread if needed
    if (!codexStore.getThread(convId)) {
      codexStore.initThread(convId, codexStore.workingDirectory || '.')
    }

    const thread = codexStore.getThread(convId)!
    const workDir = thread.workingDirectory || codexStore.workingDirectory || '.'

    // Add instruction event
    codexStore.addEvent(convId, {
      id: uuid(), type: 'instruction', content: instruction, timestamp: Date.now(),
    })

    // Add user message to chat store
    useChatStore.getState().addMessage(convId, {
      id: uuid(), role: 'user', content: instruction, timestamp: Date.now(),
    })

    // Add empty assistant message
    const assistantMsg = {
      id: uuid(), role: 'assistant' as const, content: '', thinking: '', timestamp: Date.now(), agentBlocks: [],
    }
    useChatStore.getState().addMessage(convId, assistantMsg)
    let thinkingContent = ''

    const blocks: AgentBlock[] = []
    function addBlock(block: AgentBlock) {
      blocks.push(block)
      useChatStore.getState().updateMessageAgentBlocks(convId!, assistantMsg.id, [...blocks])
    }
    function updateBlockById(blockId: string, updates: Partial<AgentBlock>) {
      const idx = blocks.findIndex((b) => b.id === blockId)
      if (idx < 0) return
      blocks[idx] = { ...blocks[idx], ...updates }
      useChatStore.getState().updateMessageAgentBlocks(convId!, assistantMsg.id, [...blocks])
    }

    // Resolve provider
    const { provider, modelId } = getProviderForModel(activeModel)
    const providerId = getProviderIdFromModel(activeModel)
    const strategy = providerId === 'ollama'
      ? getToolCallingStrategy(activeModel)
      : 'native'
    const modelToUse = activeModel.includes('::') ? activeModel.split('::')[1] : activeModel

    // Build permissions — auto-approve reads, confirm writes
    const permissions = usePermissionStore.getState().getEffectivePermissions(convId)

    // System prompt with working directory
    let systemPrompt = `${CODEX_SYSTEM_PROMPT}\n\nWorking directory: ${workDir}`

    // For non-Ollama providers, inject thinking via system prompt
    if (settings.thinkingEnabled && providerId !== 'ollama') {
      systemPrompt += '\n\nBefore answering, reason through your thinking inside <think></think> tags. Your thinking will be hidden from the user. After thinking, provide your answer outside the tags.'
    }

    // Caveman mode: append as response style modifier after Codex instructions
    if (settings.cavemanMode && settings.cavemanMode !== 'off') {
      const { CAVEMAN_PROMPTS } = await import('../lib/constants')
      const cavemanPrompt = CAVEMAN_PROMPTS[settings.cavemanMode]
      if (cavemanPrompt) {
        systemPrompt += `\n\nResponse style: ${cavemanPrompt}`
      }
    }

    // Per-message Caveman reminder for non-thinking models
    const cavemanReminder = (settings.cavemanMode && settings.cavemanMode !== 'off')
      ? (await import('../lib/constants')).CAVEMAN_REMINDERS?.[settings.cavemanMode as 'lite' | 'full' | 'ultra'] || ''
      : ''

    // Build message history
    const conv = useChatStore.getState().conversations.find(c => c.id === convId)
    if (!conv) return

    let messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...conv.messages
        .filter(m => m.role !== 'system' && (m.content.trim() || m.hidden))
        .map(m => {
          const msg: ChatMessage = {
            role: m.role as 'user' | 'assistant' | 'tool',
            content: m.role === 'user' && cavemanReminder
              ? `${cavemanReminder}\n${m.content}`
              : m.content,
          }
          // Carry over tool_calls from hidden assistant messages so the
          // model sees the full tool-call chain from previous turns
          // (continue capability, parity with original Codex CLI).
          if (m.tool_calls) msg.tool_calls = m.tool_calls as any
          return msg
        }),
    ]
    const messagesStartLen = messages.length

    // Setup
    const abort = new AbortController()
    abortRef.current = abort
    runningRef.current = true
    setIsRunning(true)
    codexStore.setThreadStatus(convId, 'running')

    let fullContent = ''

    // Phase 6: pin turn start so in-turn cache scopes to this user prompt.
    const turnStartMs = Date.now()
    // Phase 10: Codex already capped at 20 iterations historically; the
    // AgentBudget also tracks tool calls and the iteration cap pulled
    // from settings. The legacy for-loop cap stays as the outer guard.
    const budget = budgetFromSettings({
      agentMaxToolCalls: settings.agentMaxToolCalls ?? 50,
      agentMaxIterations: settings.agentMaxIterations ?? 25,
    })

    try {
      // Agent loop — max 20 iterations (legacy cap) AND AgentBudget cap,
      // whichever is tighter.
      for (let i = 0; i < 20 && runningRef.current && !abort.signal.aborted; i++) {
        budget.addIteration()
        const bx = budget.exceeded()
        if (bx.kind !== 'none') {
          useChatStore.getState().updateMessageContent(
            convId!,
            assistantMsg.id,
            (fullContent ? fullContent + '\n\n' : '') + budget.haltMessage()
          )
          break
        }
        let toolCalls: ToolCall[] = []
        let turnContent = ''

        // Plain-text-planner escape for Gemma 3/4 — see useChat.ts.
        const canThinkCx = isThinkingCompatible(activeModel)
        const plainPlanCx = isPlainTextPlanner(activeModel)
        const thinkOptCx: boolean | undefined = canThinkCx
          ? (settings.thinkingEnabled === false && plainPlanCx
              ? undefined
              : settings.thinkingEnabled === true)
          : undefined

        const chatOptions = {
          temperature: 0.1, // Low temp for coding precision
          maxTokens: settings.maxTokens || undefined,
          thinking: thinkOptCx as unknown as boolean,
          signal: abort.signal,
        }

        if (strategy === 'native') {
          const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || ''
          const relevantDefs = selectRelevantTools(lastUserMsg, toolRegistry.getAll(), permissions)
          const tools: ToolDefinition[] = relevantDefs.map(t => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          }))

          const keepThinking = settings.thinkingEnabled === true && isThinkingCompatible(activeModel)

          if (providerId === 'ollama') {
            // ── Streaming path for Ollama ──────────────────────────────
            // Shows live content/thinking tokens so the user isn't staring
            // at an empty bubble for 2+ minutes while the model generates.
            let turn: { content: string; toolCalls: ToolCall[]; thinking: string }
            try {
              turn = await streamWithTools(
                modelToUse, messages, tools,
                { temperature: 0.1, thinking: chatOptions.thinking, maxTokens: chatOptions.maxTokens, signal: abort.signal },
                (c) => useChatStore.getState().updateMessageContent(convId!, assistantMsg.id, fullContent ? fullContent + '\n\n' + c : c),
                (t) => {
                  if (keepThinking) {
                    const combined = thinkingContent ? thinkingContent + '\n\n' + t : t
                    useChatStore.getState().updateMessageThinking(convId!, assistantMsg.id, combined)
                  }
                },
              )
            } catch (thinkErr: any) {
              if (thinkErr?.statusCode === 400 || thinkErr?.message?.includes('does not support thinking')) {
                turn = await streamWithTools(
                  modelToUse, messages, tools,
                  { temperature: 0.1, thinking: undefined, maxTokens: chatOptions.maxTokens, signal: abort.signal },
                  (c) => useChatStore.getState().updateMessageContent(convId!, assistantMsg.id, fullContent ? fullContent + '\n\n' + c : c),
                  () => {},
                )
              } else {
                throw thinkErr
              }
            }
            toolCalls = turn.toolCalls
            turnContent = turn.content || ''
            if (keepThinking && turn.thinking) {
              thinkingContent += (thinkingContent ? '\n\n' : '') + turn.thinking
              useChatStore.getState().updateMessageThinking(convId!, assistantMsg.id, thinkingContent)
            }
          } else {
            // ── Non-streaming fallback for OpenAI/Anthropic providers ──
            let turn: { content: string; toolCalls: ToolCall[] }
            try {
              turn = await provider.chatWithTools(modelToUse, messages, tools, chatOptions)
            } catch (thinkErr: any) {
              if (thinkErr?.message?.includes('does not support thinking') || thinkErr?.statusCode === 400) {
                turn = await provider.chatWithTools(modelToUse, messages, tools, { ...chatOptions, thinking: undefined as unknown as boolean })
              } else {
                throw thinkErr
              }
            }
            toolCalls = turn.toolCalls
            turnContent = turn.content || ''
            if (keepThinking && (turn as any).thinking) {
              thinkingContent += (thinkingContent ? '\n\n' : '') + (turn as any).thinking
              useChatStore.getState().updateMessageThinking(convId!, assistantMsg.id, thinkingContent)
            }
          }
        } else {
          const hermesTools = toolRegistry.toHermesToolDefs(permissions)
          const hermesSystem = buildHermesToolPrompt(hermesTools) + `\n\n${systemPrompt}`
          messages[0] = { role: 'system', content: hermesSystem }
          const raw = await chatNonStreaming(
            modelToUse,
            messages.map(m => ({ role: m.role, content: m.content })),
            abort.signal,
          )
          if (hasToolCallTags(raw)) {
            toolCalls = parseHermesToolCalls(raw).map(tc => ({
              function: { name: tc.name, arguments: tc.arguments },
            }))
            turnContent = stripToolCallTags(raw)
          } else {
            turnContent = raw
          }
        }

        // Inline <think>…</think> tags — route inner text into thinking
        // block when toggle is ON, else discard. Non-canonical markers
        // (Gemma channel tags, <thought>, <reasoning>, etc.) are always
        // stripped — they are never user-facing content.
        {
          const keepThinking = settings.thinkingEnabled === true && isThinkingCompatible(activeModel)
          turnContent = turnContent.replace(/<think>([\s\S]*?)<\/think>/g, (_m, inner) => {
            if (keepThinking) {
              thinkingContent += (thinkingContent ? '\n\n' : '') + inner
              useChatStore.getState().updateMessageThinking(convId!, assistantMsg.id, thinkingContent)
            }
            return ''
          })
          turnContent = finalStripThinkingTags(turnContent, keepThinking)
        }

        if (turnContent) {
          fullContent += (fullContent ? '\n\n' : '') + turnContent
          useChatStore.getState().updateMessageContent(convId, assistantMsg.id, fullContent)
        }

        // No tool calls → done
        if (toolCalls.length === 0) break

        // Phase 5b (v2.4.0) — parallel tool execution via tool-executor.
        if (!runningRef.current || abort.signal.aborted) break

        type BatchEntry = { tc: typeof toolCalls[number]; ac: AgentToolCall; blockId: string; injectedArgs: Record<string, any> }
        const batch: BatchEntry[] = []
        budget.addToolCalls(toolCalls.length)
        for (const tc of toolCalls) {
          const toolName = tc.function.name
          const toolArgs = { ...tc.function.arguments }

          // Inject working directory for file/shell tools (skip if workDir is just '.' or empty)
          const hasValidWorkDir = workDir && workDir !== '.' && workDir.length > 2
          if (toolName === 'shell_execute' && !toolArgs.cwd) {
            if (hasValidWorkDir) toolArgs.cwd = workDir
            if (!toolArgs.timeout) toolArgs.timeout = 30000
          }
          if (toolName === 'code_execute' && !toolArgs.cwd) {
            if (hasValidWorkDir) toolArgs.cwd = workDir
            if (!toolArgs.timeout) toolArgs.timeout = 30000
          }
          // Resolve relative file paths against working directory.
          // Absolute-path detection must accept ANY drive letter (C:, D:, E:, …),
          // not just C:. Previously `!p.startsWith('C:')` classified
          // `D:/Pictures/foo/bar.html` as relative and prepended workDir,
          // producing the "doubled path" bug:
          //   workDir=D:/Pictures/foo, p=D:/Pictures/foo/bar.html →
          //   D:/Pictures/foo/D:/Pictures/foo/bar.html
          // which then grew further on retry as the model re-emitted the path.
          if ((toolName === 'file_read' || toolName === 'file_write' || toolName === 'file_list' || toolName === 'file_search') && toolArgs.path) {
            const p: string = toolArgs.path
            const isAbsolute =
              /^[a-zA-Z]:[/\\]/.test(p) ||  // Windows drive letter: C:/ D:\ etc.
              p.startsWith('/') ||          // Unix absolute
              p.startsWith('\\\\')          // UNC path: \\server\share
            if (!isAbsolute && workDir) {
              toolArgs.path = workDir.replace(/\\/g, '/').replace(/\/$/, '') + '/' + p
            }
          }

          const toolCallId = uuid()
          const blockId = uuid()
          const ac: AgentToolCall = {
            id: toolCallId, toolName, args: toolArgs,
            status: 'running', timestamp: Date.now(),
          }
          addBlock({
            id: blockId, phase: 'tool_call', content: `Running: ${toolName}`,
            toolCall: ac, toolCalls: [ac], timestamp: Date.now(),
          })
          batch.push({ tc, ac, blockId, injectedArgs: toolArgs })
        }

        const requests: ExecutionRequest[] = batch.map((e) => ({
          id: e.ac.id,
          toolName: e.ac.toolName,
          args: e.injectedArgs,
        }))
        const auditIds = new Map<string, string>()

        // 60 s per-call timeout is enforced by wrapping the executor function
        // (keeps the original safety guard — a runaway tool cannot wedge the
        // whole agent turn).
        const withTimeout = (name: string, args: Record<string, any>) =>
          Promise.race([
            toolRegistry.execute(name, args),
            new Promise<string>((_, reject) =>
              setTimeout(() => reject(new Error('Tool execution timed out (60s)')), 60000)
            ),
          ])

        const results = await executeParallel(requests, {
          getTool: (name) => {
            const td = toolRegistry.getToolByName(name)
            return td ? { name: td.name, inputSchema: td.inputSchema } : undefined
          },
          execute: (name: string, args: Record<string, any>) => withTimeout(name, args),
          lookupCache: convId ? makeInTurnCacheLookup({ convId, turnStartMs }) : undefined,
          explainError: (toolName, err) => explainToolError(toolName, err),
          // Codex is auto-approve (coding agent runs unattended). The
          // awaitApproval hook is intentionally omitted so the executor
          // dispatches immediately.
          recordAudit: (entry) => {
            if (!convId) return
            if (entry.kind === 'start') {
              const aid = useToolAuditStore.getState().record({
                convId,
                toolCallId: entry.id,
                toolName: entry.toolName,
                args: entry.args,
                startedAt: entry.startedAt,
                parentToolCallId: entry.parentToolCallId,
              })
              auditIds.set(entry.id, aid)
            } else {
              const aid = auditIds.get(entry.id)
              if (aid) {
                useToolAuditStore.getState().complete(aid, {
                  status: entry.status,
                  completedAt: entry.completedAt,
                  resultPreview: entry.resultPreview,
                  error: entry.error,
                  errorHint: entry.errorHint,
                  cacheHit: entry.cacheHit,
                })
              }
            }
          },
          abortSignal: abort.signal,
        })

        for (const entry of batch) {
          const result = results.find((r) => r.id === entry.ac.id)
          if (!result) continue
          applyResultToToolCall(entry.ac, result)
          const isError = result.status === 'failed'
          updateBlockById(entry.blockId, {
            toolCall: { ...entry.ac },
            toolCalls: [{ ...entry.ac }],
            content:
              result.status === 'completed'
                ? `Completed: ${entry.ac.toolName}`
                : result.status === 'cached'
                  ? `Cached: ${entry.ac.toolName}`
                  : `Failed: ${entry.ac.toolName}`,
          })

          // Codex event log parity with the old path.
          const resultStr = entry.ac.result ?? entry.ac.error ?? ''
          if (entry.ac.toolName === 'shell_execute' || entry.ac.toolName === 'code_execute') {
            codexStore.addEvent(convId, {
              id: uuid(), type: 'terminal_output', content: resultStr, timestamp: Date.now(),
            })
          } else if (entry.ac.toolName === 'file_write') {
            codexStore.addEvent(convId, {
              id: uuid(), type: 'file_change', content: resultStr,
              filePath: entry.injectedArgs.path, timestamp: Date.now(),
            })
          } else if (isError) {
            codexStore.addEvent(convId, {
              id: uuid(), type: 'error', content: resultStr, timestamp: Date.now(),
            })
          }
        }

        // Feed results back into LLM history (batched per-provider shape).
        const resultTextFor = (r: typeof results[number]): string => {
          if (r.status === 'completed' || r.status === 'cached') return r.result ?? ''
          return r.errorHint ? `${r.error ?? 'Tool failed'} — ${r.errorHint}` : (r.error ?? 'Tool failed')
        }

        if (providerId === 'openai' || providerId === 'anthropic') {
          messages.push({ role: 'assistant', content: turnContent || '', tool_calls: toolCalls })
          for (const { tc } of batch) {
            const result = results.find((r) => r.id === batch.find((b) => b.tc === tc)?.ac.id)!
            messages.push({ role: 'tool', content: resultTextFor(result), tool_call_id: tc.id })
          }
        } else if (strategy === 'native') {
          messages.push({
            role: 'assistant',
            content: turnContent || '',
            tool_calls: batch.map((e) => ({
              function: { name: e.ac.toolName, arguments: e.injectedArgs },
            })),
          })
          for (const { tc } of batch) {
            const result = results.find((r) => r.id === batch.find((b) => b.tc === tc)?.ac.id)!
            messages.push({ role: 'tool', content: resultTextFor(result) })
          }
        } else {
          for (const entry of batch) {
            const result = results.find((r) => r.id === entry.ac.id)!
            messages.push({
              role: 'assistant',
              content: `<tool_call>\n{"name": "${entry.ac.toolName}", "arguments": ${JSON.stringify(entry.injectedArgs)}}\n</tool_call>`,
            })
            messages.push({ role: 'user', content: buildHermesToolResult(entry.ac.toolName, resultTextFor(result)) })
          }
        }
      }

      // Bug fix: when the model's final turn returns empty content (all
      // work happened via tool calls), build a fallback summary from the
      // blocks array so the assistant bubble is never blank.
      if (!fullContent.trim()) {
        const completed = blocks.filter(b => b.phase === 'tool_call' && b.toolCall?.status === 'completed')
        const failed = blocks.filter(b => b.phase === 'tool_call' && b.toolCall?.status === 'failed')
        const writes = completed.filter(b => b.toolCall?.toolName === 'file_write')
        const reads = completed.filter(b => b.toolCall?.toolName === 'file_read')

        const parts: string[] = []
        if (writes.length) parts.push(`${writes.length} file(s) written`)
        if (reads.length) parts.push(`${reads.length} file(s) read`)
        const otherCompleted = completed.length - writes.length - reads.length
        if (otherCompleted > 0) parts.push(`${otherCompleted} other operation(s) completed`)
        if (failed.length) parts.push(`${failed.length} operation(s) failed`)

        fullContent = parts.length > 0
          ? `Task completed: ${parts.join(', ')}.`
          : 'Task completed.'
        useChatStore.getState().updateMessageContent(convId, assistantMsg.id, fullContent)
      }

      // Final update
      codexStore.addEvent(convId, {
        id: uuid(), type: 'done', content: 'Task completed.', timestamp: Date.now(),
      })

    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        const e = err as any
        const parts: string[] = []
        if (e?.code) parts.push(`[${e.code}]`)
        if (typeof e?.statusCode === 'number') parts.push(`HTTP ${e.statusCode}`)
        parts.push(e?.message || String(err) || 'Codex error')
        const msg = parts.join(' ')
        // Surface common causes so the user can see WHY it failed instead of
        // a bare "Connection error" — previously we only printed `.message`,
        // which for a TypeError from fetch is just "Failed to fetch".
        let hint = ''
        if (/Failed to fetch|NetworkError|net::ERR/i.test(msg)) {
          hint = '\n\nHint: the Ollama server is unreachable. Is `ollama serve` running on localhost:11434?'
        } else if (/does not support tools|tool.*not.*support/i.test(msg)) {
          hint = '\n\nHint: this model does not support native tool calling. Pick a tool-capable model (Qwen 3, Llama 3.1+, Gemma 4) or switch to a model without the coder-only restriction.'
        } else if (/timed out/i.test(msg)) {
          hint = '\n\nHint: the tool call took longer than 60 s. Try a smaller model or a more targeted prompt.'
        }
        fullContent += `\n\nError: ${msg}${hint}`
        useChatStore.getState().updateMessageContent(convId, assistantMsg.id, fullContent)
        codexStore.addEvent(convId, {
          id: uuid(), type: 'error', content: msg, timestamp: Date.now(),
        })
      }
    } finally {
      // ── Continue capability (parity with original Codex CLI) ────────
      // Persist the tool-call chain from this turn as hidden messages in
      // the chat store. On the next turn, the history builder includes
      // them in the API payload so the model sees what it did before.
      // Hidden messages are filtered out by MessageBubble rendering.
      const toolHistory = messages.slice(messagesStartLen)
      if (toolHistory.length > 0 && convId) {
        const store = useChatStore.getState()
        // Find the assistant message we just filled so we can insert BEFORE it
        const convNow = store.conversations.find(c => c.id === convId)
        const assistantIdx = convNow?.messages.findIndex(m => m.id === assistantMsg.id) ?? -1
        if (assistantIdx > 0) {
          for (const tm of toolHistory) {
            store.insertMessageBefore(convId, assistantMsg.id, {
              id: uuid(),
              role: tm.role as 'assistant' | 'tool',
              content: tm.content || '',
              timestamp: Date.now(),
              hidden: true,
              tool_calls: tm.tool_calls as any,
            })
          }
        }
      }

      setIsRunning(false)
      runningRef.current = false
      abortRef.current = null
      clearActiveChatId()
      codexStore.setThreadStatus(convId, 'idle')
    }
  }, [])

  const stopCodex = useCallback(() => {
    runningRef.current = false
    abortRef.current?.abort()
    abortRef.current = null
    setIsRunning(false)
  }, [])

  return { sendInstruction, stopCodex, isRunning }
}
