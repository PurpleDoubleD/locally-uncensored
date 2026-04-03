import { useRef, useState, useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import { chatNonStreaming } from '../api/agents'
import { useChatStore } from '../stores/chatStore'
import { agentVariantExists, createAgentVariant, getAgentModelName, canFixModel } from '../api/model-template-fix'
import { useModelStore } from '../stores/modelStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useRAGStore } from '../stores/ragStore'
import { useVoiceStore } from '../stores/voiceStore'
import { retrieveContext } from '../api/rag'
import { speakStreaming, isSpeechSynthesisSupported, getVoicesAsync } from '../api/voice'
import { getOllamaTools, getToolPermission, executeAgentTool, AGENT_TOOL_DEFS } from '../api/tool-registry'
import { getToolCallingStrategy, type ToolCallingStrategy } from '../lib/model-compatibility'
import { buildHermesToolPrompt, buildHermesToolResult, parseHermesToolCalls, stripToolCallTags, hasToolCallTags } from '../api/hermes-tool-calling'
import { compactMessages, getModelMaxTokens } from '../lib/context-compaction'
import { useMemoryStore } from '../stores/memoryStore'
import { getProviderForModel, getProviderIdFromModel } from '../api/providers'
import type { AgentBlock, AgentToolCall, OllamaChatMessage } from '../types/agent-mode'
import type { ChatMessage, ToolCall, ToolDefinition } from '../api/providers/types'

// ── Approval promise management ───────────────────────────────

interface ApprovalResolver {
  resolve: (approved: boolean) => void
}

// ── Hook ──────────────────────────────────────────────────────

export function useAgentChat() {
  const [isAgentRunning, setIsAgentRunning] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<AgentToolCall | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const approvalRef = useRef<ApprovalResolver | null>(null)
  const contentRef = useRef('')
  const thinkingRef = useRef('')
  const blocksRef = useRef<AgentBlock[]>([])
  const runningRef = useRef(false)

  // ── Approval callbacks ────────────────────────────────────

  const approveToolCall = useCallback(() => {
    approvalRef.current?.resolve(true)
    approvalRef.current = null
    setPendingApproval(null)
  }, [])

  const rejectToolCall = useCallback(() => {
    approvalRef.current?.resolve(false)
    approvalRef.current = null
    setPendingApproval(null)
  }, [])

  // ── Wait for user approval ────────────────────────────────

  function waitForApproval(toolCall: AgentToolCall): Promise<boolean> {
    return new Promise((resolve) => {
      approvalRef.current = { resolve }
      setPendingApproval(toolCall)
    })
  }

  // ── Add agent block and sync to store ─────────────────────

  function addBlock(convId: string, msgId: string, block: AgentBlock) {
    blocksRef.current = [...blocksRef.current, block]
    useChatStore.getState().updateMessageAgentBlocks(convId, msgId, blocksRef.current)
  }

  function updateLastBlock(convId: string, msgId: string, updates: Partial<AgentBlock>) {
    const blocks = [...blocksRef.current]
    const last = blocks[blocks.length - 1]
    if (last) {
      blocks[blocks.length - 1] = { ...last, ...updates }
      blocksRef.current = blocks
      useChatStore.getState().updateMessageAgentBlocks(convId, msgId, blocks)
    }
  }

  // ── Main agent message handler ────────────────────────────

  const sendAgentMessage = useCallback(async (userContent: string) => {
    const { activeModel } = useModelStore.getState()
    const { settings } = useSettingsStore.getState()
    const store = useChatStore.getState()
    const persona = useSettingsStore.getState().getActivePersona()

    if (!activeModel) return

    // ── Resolve provider ────────────────────────────────────
    const providerId = getProviderIdFromModel(activeModel)
    const { provider, modelId } = getProviderForModel(activeModel)

    // ── Pre-flight: determine tool calling strategy ─────────
    let modelToUse = modelId
    let strategy: ToolCallingStrategy

    if (providerId === 'openai' || providerId === 'anthropic') {
      // Cloud providers always support native tool calling
      strategy = 'native'
    } else {
      // Ollama: check model compatibility
      strategy = getToolCallingStrategy(modelId)

      if (strategy === 'template_fix') {
        const agentName = getAgentModelName(modelId)
        const exists = await agentVariantExists(modelId)

        if (exists) {
          modelToUse = agentName
          strategy = 'native'
        } else {
          const { fixable } = await canFixModel(modelId)
          if (fixable) {
            try {
              modelToUse = await createAgentVariant(modelId)
              strategy = 'native'
            } catch {
              strategy = 'hermes_xml'
            }
          } else {
            strategy = 'hermes_xml'
          }
        }
      }
    }

    // Create or get conversation
    let convId = store.activeConversationId
    if (!convId) {
      convId = store.createConversation(activeModel, persona?.systemPrompt || '')
    }

    // Add user message
    const userMessage = {
      id: uuid(),
      role: 'user' as const,
      content: userContent,
      timestamp: Date.now(),
    }
    useChatStore.getState().addMessage(convId, userMessage)

    // Add empty assistant message
    const assistantMessage = {
      id: uuid(),
      role: 'assistant' as const,
      content: '',
      thinking: '',
      timestamp: Date.now(),
      agentBlocks: [],
    }
    useChatStore.getState().addMessage(convId, assistantMessage)

    // Build conversation context
    const conv = useChatStore.getState().conversations.find((c) => c.id === convId)
    if (!conv) return

    // RAG context injection
    let systemPrompt = conv.systemPrompt
    const ragState = useRAGStore.getState()
    const ragEnabled = ragState.ragEnabled[convId] ?? false

    if (ragEnabled) {
      await ragState.loadChunksFromDB(convId)
      const chunks = ragState.getConversationChunks(convId)
      if (chunks.length > 0) {
        try {
          const { context: ragContext } = await retrieveContext(userContent, chunks, ragState.embeddingModel)
          if (ragContext.chunks.length > 0) {
            const contextBlock = ragContext.chunks
              .map((c: any, i: number) => `[Source ${i + 1}]\n${c.content}`)
              .join('\n\n')
            systemPrompt = `Use the following document context to help answer the user's question. If the context is not relevant, ignore it and answer normally.\n\n---\n${contextBlock}\n---\n\n${systemPrompt || ''}`
          }
        } catch (err) {
          console.error('RAG retrieval failed:', err)
        }
      }
    }

    // Memory context injection
    const memoryContext = useMemoryStore.getState().getMemoryForPrompt(userContent, 2000)
    if (memoryContext) {
      systemPrompt = (systemPrompt || '') + `\n\n## Remembered Context\n${memoryContext}`
    }

    // Build agent system prompt
    const agentSystemPrompt = strategy === 'hermes_xml'
      ? buildHermesToolPrompt(AGENT_TOOL_DEFS) + (systemPrompt ? `\n\n${systemPrompt}` : '')
      : buildAgentSystemPrompt(systemPrompt)

    // Build messages array
    let agentMessages: ChatMessage[] = [
      ...(agentSystemPrompt ? [{ role: 'system' as const, content: agentSystemPrompt }] : []),
      ...conv.messages
        .filter((m) => m.role !== 'system' && m.content.trim() !== '')
        .map((m) => ({ role: m.role as 'user' | 'assistant' | 'tool', content: m.content })),
    ]

    // Setup
    const abort = new AbortController()
    abortRef.current = abort
    runningRef.current = true
    setIsAgentRunning(true)
    contentRef.current = ''
    thinkingRef.current = ''
    blocksRef.current = []

    let frameScheduled = false

    function scheduleUIUpdate() {
      if (!frameScheduled) {
        frameScheduled = true
        requestAnimationFrame(() => {
          const cId = convId!
          const mId = assistantMessage.id
          useChatStore.getState().updateMessageContent(cId, mId, contentRef.current)
          if (thinkingRef.current) {
            useChatStore.getState().updateMessageThinking(cId, mId, thinkingRef.current)
          }
          frameScheduled = false
        })
      }
    }

    try {
      // ── Agent Loop ──────────────────────────────────────────
      while (runningRef.current && !abort.signal.aborted) {
        let toolCalls: ToolCall[] = []
        let turnContent = ''
        let turnThinking = ''

        const chatOptions = {
          temperature: settings.temperature,
          topP: settings.topP,
          topK: settings.topK,
          maxTokens: settings.maxTokens || undefined,
          signal: abort.signal,
        }

        // Context compaction
        const maxCtx = await getModelMaxTokens(activeModel)
        agentMessages = compactMessages(
          agentMessages as OllamaChatMessage[],
          Math.floor(maxCtx * 0.8)
        ) as ChatMessage[]

        if (strategy === 'native') {
          // ── Native tool calling (works with Ollama, OpenAI, Anthropic) ──
          const tools: ToolDefinition[] = getOllamaTools()
          const turn = await provider.chatWithTools(modelToUse, agentMessages, tools, chatOptions)

          toolCalls = turn.toolCalls
          turnContent = turn.content || ''

        } else {
          // ── Hermes XML prompt-based tool calling (Ollama fallback) ──
          const rawContent = await chatNonStreaming(
            modelToUse,
            agentMessages.map(m => ({ role: m.role, content: m.content })),
          )

          if (hasToolCallTags(rawContent)) {
            toolCalls = parseHermesToolCalls(rawContent).map(tc => ({
              function: { name: tc.name, arguments: tc.arguments },
            }))
            turnContent = stripToolCallTags(rawContent)
          } else {
            turnContent = rawContent
          }
        }

        // Parse think tags
        const thinkMatch = turnContent.match(/<think>([\s\S]*?)<\/think>/)
        if (thinkMatch) {
          turnThinking = thinkMatch[1]
          turnContent = turnContent.replace(/<think>[\s\S]*?<\/think>/, '').trim()
        }

        // Update UI
        contentRef.current = turnContent
        thinkingRef.current = turnThinking
        scheduleUIUpdate()

        // If no tool calls, the model is done
        if (toolCalls.length === 0) break

        // Process each tool call
        for (const tc of toolCalls) {
          if (!runningRef.current || abort.signal.aborted) break

          const toolCallId = uuid()
          const agentToolCall: AgentToolCall = {
            id: toolCallId,
            toolName: tc.function.name,
            args: tc.function.arguments,
            status: 'running',
            timestamp: Date.now(),
          }

          // Check permission
          const permission = getToolPermission(tc.function.name)

          if (permission === 'confirm') {
            agentToolCall.status = 'pending_approval'
            addBlock(convId!, assistantMessage.id, {
              id: uuid(),
              phase: 'tool_call',
              content: `Requesting approval: ${tc.function.name}`,
              toolCall: agentToolCall,
              timestamp: Date.now(),
            })

            const approved = await waitForApproval(agentToolCall)

            if (!approved) {
              agentToolCall.status = 'rejected'
              updateLastBlock(convId!, assistantMessage.id, {
                toolCall: { ...agentToolCall, status: 'rejected' },
                content: `Rejected: ${tc.function.name}`,
              })

              // Feed rejection back
              agentMessages.push({
                role: 'assistant',
                content: turnContent || '',
                tool_calls: [tc],
              })

              if (providerId === 'openai' || providerId === 'anthropic') {
                agentMessages.push({
                  role: 'tool',
                  content: 'User rejected this action. Try a different approach.',
                  tool_call_id: tc.id,
                })
              } else if (strategy === 'native') {
                agentMessages.push({
                  role: 'tool',
                  content: 'User rejected this action. Try a different approach.',
                })
              } else {
                agentMessages.push({
                  role: 'user',
                  content: buildHermesToolResult(tc.function.name, 'User rejected this action. Try a different approach.'),
                })
              }
              continue
            }

            agentToolCall.status = 'running'
            updateLastBlock(convId!, assistantMessage.id, {
              toolCall: { ...agentToolCall, status: 'running' },
              content: `Running: ${tc.function.name}`,
            })
          } else {
            addBlock(convId!, assistantMessage.id, {
              id: uuid(),
              phase: 'tool_call',
              content: `Running: ${tc.function.name}`,
              toolCall: agentToolCall,
              timestamp: Date.now(),
            })
          }

          // Execute the tool
          const startTime = Date.now()
          const result = await executeAgentTool(tc.function.name, tc.function.arguments)
          const duration = Date.now() - startTime

          // Update block with result
          const isError = result.startsWith('Error:')
          agentToolCall.status = isError ? 'failed' : 'completed'
          agentToolCall.result = isError ? undefined : result
          agentToolCall.error = isError ? result : undefined
          agentToolCall.duration = duration

          updateLastBlock(convId!, assistantMessage.id, {
            toolCall: { ...agentToolCall },
            content: isError ? `Failed: ${tc.function.name}` : `Completed: ${tc.function.name}`,
          })

          // Auto-save tool result to memory
          if (!isError) {
            const argsShort = JSON.stringify(tc.function.arguments).substring(0, 100)
            const resultShort = result.substring(0, 200)
            useMemoryStore.getState().addEntry(
              'tool_result',
              `${tc.function.name}(${argsShort}) → ${resultShort}`,
              `agent:${tc.function.name}`
            )
          }

          // Append tool call + result to messages for next iteration
          if (providerId === 'openai') {
            // OpenAI format: assistant with tool_calls, then tool role with tool_call_id
            agentMessages.push({
              role: 'assistant',
              content: turnContent || '',
              tool_calls: [tc],
            })
            agentMessages.push({
              role: 'tool',
              content: result,
              tool_call_id: tc.id,
            })
          } else if (providerId === 'anthropic') {
            // Anthropic format: same structure, tool_call_id maps to tool_use id
            agentMessages.push({
              role: 'assistant',
              content: turnContent || '',
              tool_calls: [tc],
            })
            agentMessages.push({
              role: 'tool',
              content: result,
              tool_call_id: tc.id,
            })
          } else if (strategy === 'native') {
            // Ollama native
            agentMessages.push({
              role: 'assistant',
              content: turnContent || '',
              tool_calls: [{ function: { name: tc.function.name, arguments: tc.function.arguments } }],
            })
            agentMessages.push({
              role: 'tool',
              content: result,
            })
          } else {
            // Hermes XML
            agentMessages.push({
              role: 'assistant',
              content: `<tool_call>\n{"name": "${tc.function.name}", "arguments": ${JSON.stringify(tc.function.arguments)}}\n</tool_call>`,
            })
            agentMessages.push({
              role: 'user',
              content: buildHermesToolResult(tc.function.name, result),
            })
          }
        }

        // Reset content for next iteration
        contentRef.current = ''
        thinkingRef.current = ''
      }

      // Final store update
      useChatStore.getState().updateMessageContent(convId!, assistantMessage.id, contentRef.current)
      if (thinkingRef.current) {
        useChatStore.getState().updateMessageThinking(convId!, assistantMessage.id, thinkingRef.current)
      }

    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        const errorMsg = (err as Error).message || 'Connection failed'

        if (errorMsg.includes('does not support tools')) {
          useChatStore.getState().updateMessageContent(
            convId!, assistantMessage.id,
            `This model does not support tool calling.\n\nThe auto-fix could not be applied. Try pulling a standard model like:\n• qwen2.5:7b\n• llama3.1:8b\n• mistral:7b`
          )
        } else {
          useChatStore.getState().updateMessageContent(
            convId!, assistantMessage.id,
            contentRef.current + '\n\nAgent error: ' + errorMsg
          )
        }
      }
    } finally {
      setIsAgentRunning(false)
      runningRef.current = false
      abortRef.current = null
      setPendingApproval(null)
      approvalRef.current = null

      // Auto-speak if TTS enabled
      const voiceState = useVoiceStore.getState()
      if (voiceState.ttsEnabled && isSpeechSynthesisSupported() && contentRef.current.trim()) {
        try {
          let voice: SpeechSynthesisVoice | undefined
          if (voiceState.ttsVoice) {
            const voices = await getVoicesAsync()
            voice = voices.find((v) => v.name === voiceState.ttsVoice)
          }
          voiceState.setSpeaking(true)
          await speakStreaming(contentRef.current, voice, voiceState.ttsRate, voiceState.ttsPitch)
        } catch { /* TTS errors non-critical */ }
        finally { voiceState.setSpeaking(false) }
      }
    }
  }, [])

  // ── Stop the agent ────────────────────────────────────────────

  const stopAgent = useCallback(() => {
    runningRef.current = false
    abortRef.current?.abort()
    approvalRef.current?.resolve(false)
    approvalRef.current = null
    setPendingApproval(null)
  }, [])

  return {
    sendAgentMessage,
    stopAgent,
    approveToolCall,
    rejectToolCall,
    isAgentRunning,
    pendingApproval,
  }
}

// ── Agent System Prompt Builder ─────────────────────────────────

function buildAgentSystemPrompt(basePrompt: string): string {
  const agentInstructions = `You are an autonomous AI agent. You MUST use tools — NEVER answer from memory.

IMPORTANT: web_search returns ONLY short snippets, NOT real data. You MUST ALWAYS call web_fetch on the best URL to read the actual page content before answering.

Workflow:
1. web_search → get URLs
2. web_fetch → read actual page content from the best URL
3. Answer based on real data from web_fetch

Other tools: file_read, file_write, code_execute, image_generate.
Chain multiple tools as needed. If a tool fails, try a different approach.
Respond in the same language the user uses.`

  if (basePrompt) {
    return `${agentInstructions}\n\n${basePrompt}`
  }
  return agentInstructions
}
