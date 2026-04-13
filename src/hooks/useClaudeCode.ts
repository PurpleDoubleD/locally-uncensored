import { useCallback, useEffect, useRef, useState } from 'react'
import { v4 as uuid } from 'uuid'
import { backendCall, isTauri } from '../api/backend'
import { useClaudeCodeStore } from '../stores/claudeCodeStore'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useProviderStore } from '../stores/providerStore'
import type { ClaudeCodeEvent } from '../stores/claudeCodeStore'
import type { AgentBlock, AgentToolCall } from '../types/agent-mode'

/**
 * Hook for running Claude Code sessions.
 *
 * Unlike useCodex (which runs an agentic loop in JS), this hook
 * spawns the Claude Code CLI as a Tauri subprocess and streams
 * JSON events back to the frontend. The CLI handles all tool
 * execution internally.
 *
 * Requires: Ollama 0.14+ (native Anthropic API compatibility).
 */
export function useClaudeCode() {
  const [isRunning, setIsRunning] = useState(false)
  const unlistenRef = useRef<(() => void) | null>(null)

  // Cleanup event listener on unmount
  useEffect(() => {
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current()
        unlistenRef.current = null
      }
    }
  }, [])

  const sendPrompt = useCallback(async (prompt: string) => {
    const claudeStore = useClaudeCodeStore.getState()
    const { settings } = useSettingsStore.getState()
    const chatStore = useChatStore.getState()
    const providerState = useProviderStore.getState()

    // Get Ollama base URL from provider store
    const ollamaConfig = providerState.providers.ollama
    const ollamaBaseUrl = ollamaConfig?.baseUrl || 'http://localhost:11434'

    // Get model: settings override → active Ollama model → fallback
    const { activeModel } = await import('../stores/modelStore').then(m => m.useModelStore.getState())
    const model = settings.claudeCodeModel || activeModel || 'glm5.1'

    // Get or create conversation
    let convId = chatStore.activeConversationId
    if (!convId) {
      convId = chatStore.createConversation(model, '', 'claude-code')
    }

    // Init session if needed
    // Use configured working directory, or user's home directory as fallback
    const workDir = claudeStore.workingDirectory || (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__ ? '' : '.')
    // If no workDir, let Rust use the app's current directory
    if (!claudeStore.getSession(convId)) {
      claudeStore.initSession(convId, workDir)
    }

    // Caveman mode: prepend style directive to prompt for CLI
    let effectivePrompt = prompt
    if (settings.cavemanMode && settings.cavemanMode !== 'off') {
      const { CAVEMAN_PROMPTS } = await import('../lib/constants')
      const cavemanPrompt = CAVEMAN_PROMPTS[settings.cavemanMode as keyof typeof CAVEMAN_PROMPTS]
      if (cavemanPrompt) {
        effectivePrompt = `[Response style: ${cavemanPrompt}]\n\n${prompt}`
      }
    }

    // Add user message (show original prompt, not style-prefixed)
    chatStore.addMessage(convId, {
      id: uuid(), role: 'user', content: prompt, timestamp: Date.now(),
    })

    // Add empty assistant message (will be streamed into)
    const assistantMsgId = uuid()
    chatStore.addMessage(convId, {
      id: assistantMsgId, role: 'assistant', content: '', timestamp: Date.now(), agentBlocks: [],
    })

    // Add instruction event
    claudeStore.addEvent(convId, {
      id: uuid(), type: 'text', content: prompt, timestamp: Date.now(),
    })

    setIsRunning(true)
    claudeStore.setSessionStatus(convId, 'running')

    let fullContent = ''
    const blocks: AgentBlock[] = []

    // In Tauri mode: spawn CLI and listen for events
    if (isTauri()) {
      try {
        // Set up event listener BEFORE starting the process
        const { listen } = await import('@tauri-apps/api/event')
        const unlisten = await listen<Record<string, unknown>>('claude-code-event', (event) => {
          const data = event.payload as any
          const convIdCurrent = convId!

          // Create store event
          const storeEvent: ClaudeCodeEvent = {
            id: uuid(),
            type: data.type || 'text',
            content: data.content || '',
            timestamp: Date.now(),
            toolName: data.tool_name,
            toolArgs: data.tool_args,
            toolResult: data.tool_result,
            filePath: data.file_path,
          }
          claudeStore.addEvent(convIdCurrent, storeEvent)

          // Map to chat UI
          switch (data.type) {
            case 'text':
            case 'assistant': {
              const text = data.content || data.text || ''
              if (text) {
                fullContent += (fullContent ? '\n' : '') + text
                chatStore.updateMessageContent(convIdCurrent, assistantMsgId, fullContent)
              }
              break
            }
            case 'tool_use': {
              const toolCall: AgentToolCall = {
                id: uuid(),
                toolName: data.tool_name || data.name || 'unknown',
                args: data.tool_args || data.input || {},
                status: 'running',
                timestamp: Date.now(),
              }
              blocks.push({
                id: uuid(),
                phase: 'tool_call',
                content: `Running: ${toolCall.toolName}`,
                toolCall,
                timestamp: Date.now(),
              })
              chatStore.updateMessageAgentBlocks(convIdCurrent, assistantMsgId, [...blocks])
              break
            }
            case 'tool_result': {
              // Update the last tool call block with result
              const lastBlock = blocks[blocks.length - 1]
              if (lastBlock?.toolCall) {
                lastBlock.toolCall.status = 'completed'
                lastBlock.toolCall.result = data.content || data.output || ''
                lastBlock.toolCall.duration = Date.now() - lastBlock.timestamp
                lastBlock.content = `Completed: ${lastBlock.toolCall.toolName}`
                chatStore.updateMessageAgentBlocks(convIdCurrent, assistantMsgId, [...blocks])
              }
              break
            }
            case 'permission_request': {
              claudeStore.setSessionStatus(convIdCurrent, 'waiting_permission')
              blocks.push({
                id: uuid(),
                phase: 'tool_call',
                content: `Permission required: ${data.tool_name || 'action'}`,
                toolCall: {
                  id: uuid(),
                  toolName: data.tool_name || 'permission',
                  args: data.tool_args || {},
                  status: 'running',
                  timestamp: Date.now(),
                },
                timestamp: Date.now(),
              })
              chatStore.updateMessageAgentBlocks(convIdCurrent, assistantMsgId, [...blocks])
              break
            }
            case 'error': {
              const errContent = data.content || 'Unknown error'
              fullContent += (fullContent ? '\n\n' : '') + `Error: ${errContent}`
              chatStore.updateMessageContent(convIdCurrent, assistantMsgId, fullContent)
              claudeStore.addEvent(convIdCurrent, {
                id: uuid(), type: 'error', content: errContent, timestamp: Date.now(),
              })
              break
            }
            case 'done': {
              setIsRunning(false)
              claudeStore.setSessionStatus(convIdCurrent, 'idle')
              claudeStore.setSessionPid(convIdCurrent, null)
              // Cleanup listener
              if (unlistenRef.current) {
                unlistenRef.current()
                unlistenRef.current = null
              }
              break
            }
          }
        })

        unlistenRef.current = unlisten

        // Determine permission mode
        const permissionMode = settings.claudeCodeAutoApprove ? 'auto-approve' : 'ask'

        // Start Claude Code subprocess
        const result = await backendCall<{ status: string; pid?: number }>('start_claude_code', {
          workingDir: workDir,
          model,
          prompt: effectivePrompt,
          ollamaBaseUrl,
          permissionMode,
        })

        if (result.pid) {
          claudeStore.setSessionPid(convId, result.pid)
        }

        if (result.status === 'already_running') {
          fullContent = 'A Claude Code session is already running. Stop it first.'
          chatStore.updateMessageContent(convId, assistantMsgId, fullContent)
          setIsRunning(false)
          claudeStore.setSessionStatus(convId, 'idle')
        }
      } catch (err) {
        const msg = typeof err === 'string' ? err : (err as Error).message || 'Failed to start Claude Code'
        fullContent = `Error: ${msg}`
        chatStore.updateMessageContent(convId, assistantMsgId, fullContent)
        setIsRunning(false)
        claudeStore.setSessionStatus(convId, 'error')
      }
    } else {
      // Dev mode (no Tauri) — show info message
      fullContent = 'Claude Code requires the Tauri desktop app (Ollama 0.14+). It is not available in browser dev mode.'
      chatStore.updateMessageContent(convId, assistantMsgId, fullContent)
      setIsRunning(false)
      claudeStore.setSessionStatus(convId, 'idle')
    }
  }, [])

  const stopSession = useCallback(async () => {
    try {
      await backendCall('stop_claude_code')
    } catch (err) {
      console.warn('[ClaudeCode] Stop failed:', err)
    }
    setIsRunning(false)

    // Cleanup listener
    if (unlistenRef.current) {
      unlistenRef.current()
      unlistenRef.current = null
    }

    // Update session status
    const convId = useChatStore.getState().activeConversationId
    if (convId) {
      useClaudeCodeStore.getState().setSessionStatus(convId, 'idle')
      useClaudeCodeStore.getState().setSessionPid(convId, null)
    }
  }, [])

  const approvePermission = useCallback(async () => {
    try {
      await backendCall('send_claude_code_input', { input: 'yes' })
      const convId = useChatStore.getState().activeConversationId
      if (convId) {
        useClaudeCodeStore.getState().setSessionStatus(convId, 'running')
      }
    } catch (err) {
      console.warn('[ClaudeCode] Approve failed:', err)
    }
  }, [])

  const denyPermission = useCallback(async () => {
    try {
      await backendCall('send_claude_code_input', { input: 'no' })
      const convId = useChatStore.getState().activeConversationId
      if (convId) {
        useClaudeCodeStore.getState().setSessionStatus(convId, 'running')
      }
    } catch (err) {
      console.warn('[ClaudeCode] Deny failed:', err)
    }
  }, [])

  return { sendPrompt, stopSession, approvePermission, denyPermission, isRunning }
}

