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
import type { CodexEvent } from '../types/codex'
import type { AgentBlock, AgentToolCall } from '../types/agent-mode'
import { selectRelevantTools } from '../lib/tool-selection'
import { isThinkingCompatible } from '../lib/model-compatibility'
import type { ChatMessage, ToolCall, ToolDefinition } from '../api/providers/types'
import { executeParallel, applyResultToToolCall, type ExecutionRequest } from '../api/agents/tool-executor'
import { useToolAuditStore } from '../stores/toolAuditStore'
import { makeInTurnCacheLookup } from '../api/agents/in-turn-cache'
import { explainError as explainToolError } from '../api/agents/error-hints'

const CODEX_SYSTEM_PROMPT = `You are Codex, an autonomous coding agent inside Locally Uncensored. You execute coding tasks by reading files, writing code, and running shell commands. You MUST use tools to interact with the filesystem — never guess file contents.

Workflow:
1. Understand the task
2. Explore the codebase (file_list, file_read, file_search)
3. Plan your changes
4. Implement changes (file_write)
5. Verify your work (shell_execute to run tests, lint, or build)

Rules:
- Always read a file before modifying it
- Explain what you are doing before each action
- After writing files, show a summary of changes made
- If a command fails, diagnose the issue and try a different approach
- Be concise — show results, not verbose explanations`

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
        .filter(m => m.role !== 'system' && m.content.trim())
        .map(m => ({
          role: m.role as 'user' | 'assistant' | 'tool',
          content: m.role === 'user' && cavemanReminder
            ? `${cavemanReminder}\n${m.content}`
            : m.content,
        })),
    ]

    // Setup
    const abort = new AbortController()
    abortRef.current = abort
    runningRef.current = true
    setIsRunning(true)
    codexStore.setThreadStatus(convId, 'running')

    let fullContent = ''

    // Phase 6: pin turn start so in-turn cache scopes to this user prompt.
    const turnStartMs = Date.now()

    try {
      // Agent loop — max 20 iterations
      for (let i = 0; i < 20 && runningRef.current && !abort.signal.aborted; i++) {
        let toolCalls: ToolCall[] = []
        let turnContent = ''

        const chatOptions = {
          temperature: 0.1, // Low temp for coding precision
          maxTokens: settings.maxTokens || undefined,
          // Tri-state think flag — see useChat.ts for rationale.
          thinking: isThinkingCompatible(activeModel)
            ? settings.thinkingEnabled === true
            : (undefined as unknown as boolean),
          signal: abort.signal,
        }

        if (strategy === 'native') {
          const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || ''
          const relevantDefs = selectRelevantTools(lastUserMsg, toolRegistry.getAll(), permissions)
          const tools: ToolDefinition[] = relevantDefs.map(t => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          }))

          let turn: { content: string; toolCalls: ToolCall[] }
          try {
            turn = await provider.chatWithTools(modelToUse, messages, tools, chatOptions)
          } catch (thinkErr: any) {
            if (thinkErr?.message?.includes('does not support thinking') || thinkErr?.statusCode === 400) {
              // Retry with `undefined` so the provider omits the think
              // field entirely (old Ollama builds reject both `think: true`
              // and `think: false`).
              turn = await provider.chatWithTools(modelToUse, messages, tools, { ...chatOptions, thinking: undefined as unknown as boolean })
            } else {
              throw thinkErr
            }
          }

          toolCalls = turn.toolCalls
          turnContent = turn.content || ''
          // Codex parity with Agent / Chat: Thinking visibility is driven
          // by the toggle. Native Ollama `thinking` field is only surfaced
          // when the user asked for it. Drop it silently otherwise.
          const keepThinking = settings.thinkingEnabled === true && isThinkingCompatible(activeModel)
          if (keepThinking && (turn as any).thinking) {
            thinkingContent += (thinkingContent ? '\n\n' : '') + (turn as any).thinking
            useChatStore.getState().updateMessageThinking(convId!, assistantMsg.id, thinkingContent)
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

        // Strip Gemma 4 channel tags from content
        turnContent = turnContent
          .replace(/<\|?channel>?\s*thought\s*/gi, '')
          .replace(/<\|?channel\|?>/gi, '')
          .replace(/<channel\|>/gi, '')

        // Inline <think>…</think> tags — always remove from content so the
        // assistant bubble never shows raw tags. Route the inner text into
        // the thinking block only when the toggle is ON (QwQ / DeepSeek-R1
        // emit these unconditionally; we must not leak them when the user
        // asked for thinking to be OFF).
        {
          const keepThinking = settings.thinkingEnabled === true && isThinkingCompatible(activeModel)
          turnContent = turnContent.replace(/<think>([\s\S]*?)<\/think>/g, (_m, inner) => {
            if (keepThinking) {
              thinkingContent += (thinkingContent ? '\n\n' : '') + inner
              useChatStore.getState().updateMessageThinking(convId!, assistantMsg.id, thinkingContent)
            }
            return ''
          })
        }
        turnContent = turnContent.trim()

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
          // Resolve relative file paths against working directory
          if ((toolName === 'file_read' || toolName === 'file_write' || toolName === 'file_list' || toolName === 'file_search') && toolArgs.path) {
            const p = toolArgs.path
            if (!p.startsWith('/') && !p.startsWith('C:') && !p.startsWith('\\\\') && workDir) {
              toolArgs.path = workDir.replace(/\\/g, '/') + '/' + p
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
      setIsRunning(false)
      runningRef.current = false
      abortRef.current = null
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
