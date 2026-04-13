import { useClaudeCode } from '../../hooks/useClaudeCode'
import { useClaudeCodeStore } from '../../stores/claudeCodeStore'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { ChatInput } from './ChatInput'
import { ToolCallBlock } from './ToolCallBlock'
import { ThinkingBlock } from './ThinkingBlock'
import { MarkdownRenderer } from './MarkdownRenderer'
import { TokenCounter } from './TokenCounter'
import { RealtimeCounter } from './RealtimeCounter'
import { PluginsDropdown } from './PluginsDropdown'
import { FileTree } from './FileTree'
import { User, Terminal, Shield, ShieldCheck, AlertTriangle, AlertCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { backendCall } from '../../api/backend'
import { CLAUDE_CODE_RECOMMENDED_MODELS } from '../../stores/claudeCodeStore'
import { useModelStore } from '../../stores/modelStore'
import { isClaudeCodeCompatible } from '../../lib/model-compatibility'

export function ClaudeCodeView() {
  const { sendPrompt, stopSession, approvePermission, denyPermission, isRunning } = useClaudeCode()
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const conversations = useChatStore((s) => s.conversations)
  const session = useClaudeCodeStore((s) => activeConversationId ? s.sessions[activeConversationId] : undefined)
  const installed = useClaudeCodeStore((s) => s.installed)
  const version = useClaudeCodeStore((s) => s.version)
  const workingDirectory = useClaudeCodeStore((s) => s.workingDirectory)
  const claudeCodeModel = useSettingsStore((s) => s.settings.claudeCodeModel)
  const scrollRef = useRef<HTMLDivElement>(null)

  const activeModel = useModelStore((s) => s.activeModel)
  const modelCompatible = isClaudeCodeCompatible(claudeCodeModel || activeModel)

  const conversation = conversations.find(c => c.id === activeConversationId)
  const messages = conversation?.messages || []

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, session?.events])

  // Detect Claude Code on mount
  useEffect(() => {
    detectClaudeCode()
  }, [])

  async function detectClaudeCode() {
    try {
      const result = await backendCall<{ installed: boolean; version: string; path: string }>('detect_claude_code')
      useClaudeCodeStore.getState().setInstalled(result.installed, result.version, result.path)
    } catch {
      // Not in Tauri mode or detection failed
    }
  }

  const isWaitingPermission = session?.status === 'waiting_permission'

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Main panel */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        {/* Header */}
        <div className="flex items-center gap-1.5 px-3 py-1 border-b border-gray-200 dark:border-white/[0.04]">
          <Terminal size={11} className="text-gray-400" />
          <span className="text-[0.7rem] text-gray-700 dark:text-gray-300 font-medium">Claude Code</span>
          {claudeCodeModel && (
            <span className="text-[0.55rem] text-gray-500">{claudeCodeModel}</span>
          )}
          <div className="flex-1" />
          {installed && version && (
            <span className="text-[0.55rem] text-gray-500">{version}</span>
          )}
          <PluginsDropdown />
          <TokenCounter />
        </div>

        {/* Model compatibility warning */}
        {installed && !modelCompatible && (
          <div className="mx-3 mt-1.5 px-2.5 py-1.5 rounded-md bg-gray-100 dark:bg-white/[0.04] border border-gray-200 dark:border-white/[0.06] flex items-center gap-2">
            <AlertCircle size={12} className="text-gray-400 shrink-0" />
            <span className="text-[0.65rem] text-gray-600 dark:text-gray-400">
              {claudeCodeModel || activeModel || 'No model selected'} may not support tool calling. Recommended: GLM 5.1, Qwen 3.5 Coder, Hermes 3.
            </span>
          </div>
        )}

        {/* Ollama requirement — subtle, only on empty state */}
        {installed && messages.length === 0 && (
          <div className="mx-3 mt-1 px-2.5 py-1 flex items-center gap-1.5">
            <span className="text-[0.6rem] text-gray-500">
              Requires Ollama 0.14+ for local Anthropic API compatibility.
            </span>
          </div>
        )}

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin">
          {!installed ? (
            // Not installed state
            <ClaudeCodeInstallPrompt onDetect={detectClaudeCode} />
          ) : messages.length === 0 ? (
            // Empty state — clean, professional
            <div className="flex flex-col items-center justify-center h-full text-center px-6">
              <Terminal size={28} className="text-gray-300 dark:text-gray-600 mb-3" />
              <p className="text-[0.85rem] text-gray-700 dark:text-gray-300 font-medium">Claude Code</p>
              <p className="text-[0.7rem] text-gray-500 dark:text-gray-500 mt-1 max-w-[340px] leading-relaxed">
                Run the official Claude Code agent locally. File editing, shell commands, code search — all on your machine.
              </p>
              {!workingDirectory && (
                <p className="text-[0.65rem] text-gray-400 mt-3">
                  Set a working directory in the file tree panel to get started.
                </p>
              )}
              {!claudeCodeModel && (
                <div className="mt-4">
                  <p className="text-[0.6rem] text-gray-500 mb-2">Recommended models</p>
                  <div className="flex flex-wrap gap-1.5 justify-center max-w-[320px]">
                    {CLAUDE_CODE_RECOMMENDED_MODELS.slice(0, 4).map(m => (
                      <button
                        key={m.name}
                        onClick={() => useSettingsStore.getState().updateSettings({ claudeCodeModel: m.name })}
                        className="text-[0.6rem] px-2.5 py-1 rounded-md bg-gray-100 dark:bg-white/[0.05] text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/[0.08] border border-gray-200 dark:border-white/[0.06] transition-colors"
                        title={m.reason}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            // Message list
            <div className="py-1">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex gap-2 px-3 py-1 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
                >
                  <div className={`w-5 h-5 rounded flex items-center justify-center shrink-0 ${
                    msg.role === 'user'
                      ? 'bg-gray-100 dark:bg-white/8'
                      : 'bg-purple-500/10'
                  }`}>
                    {msg.role === 'user'
                      ? <User size={9} className="text-gray-400" />
                      : <Terminal size={9} className="text-purple-400" />
                    }
                  </div>
                  <div className="max-w-[85%] space-y-0.5">
                    {/* Thinking */}
                    {msg.role === 'assistant' && msg.thinking && (
                      <ThinkingBlock thinking={msg.thinking} />
                    )}
                    {/* Tool call blocks */}
                    {msg.role === 'assistant' && msg.agentBlocks && msg.agentBlocks.length > 0 && (
                      <div className="space-y-0">
                        {msg.agentBlocks
                          .filter(b => b.phase === 'tool_call' && b.toolCall)
                          .map(block => (
                            <ToolCallBlock key={block.id} toolCall={block.toolCall!} />
                          ))}
                      </div>
                    )}
                    {/* Text content */}
                    {msg.content && (
                      <div className={`rounded-lg px-2.5 py-1.5 ${
                        msg.role === 'user'
                          ? 'bg-gray-100 dark:bg-white/[0.06] border border-gray-200 dark:border-white/[0.08]'
                          : 'bg-white dark:bg-white/[0.02] border border-purple-500/10 dark:border-purple-500/10'
                      }`}>
                        <div className="text-[0.75rem] leading-relaxed">
                          {msg.role === 'user' ? (
                            <p className="text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{msg.content}</p>
                          ) : (
                            <MarkdownRenderer content={msg.content} />
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {/* Permission approval bar */}
              {isWaitingPermission && (
                <div className="mx-3 my-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center gap-2">
                  <Shield size={12} className="text-amber-400 shrink-0" />
                  <span className="text-[0.65rem] text-amber-300 flex-1">
                    Claude Code is requesting permission to proceed.
                  </span>
                  <button
                    onClick={approvePermission}
                    className="text-[0.55rem] px-2 py-0.5 rounded bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors flex items-center gap-0.5"
                  >
                    <ShieldCheck size={9} />
                    Approve
                  </button>
                  <button
                    onClick={denyPermission}
                    className="text-[0.55rem] px-2 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                  >
                    Deny
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Realtime counter */}
        <RealtimeCounter isRunning={isRunning} />

        {/* Input */}
        <ChatInput
          onSend={(content) => sendPrompt(content)}
          onStop={stopSession}
          isGenerating={isRunning}
          disabled={!installed}
        />
      </div>

      {/* Right sidebar: File Tree */}
      <div className="w-48 shrink-0">
        <FileTree />
      </div>
    </div>
  )
}

// ── Install Prompt Component ──────────────────────────────────────────────

function ClaudeCodeInstallPrompt({ onDetect }: { onDetect: () => void }) {
  const [installing, setInstalling] = useState(false)
  const [installLog, setInstallLog] = useState<string[]>([])
  const [error, setError] = useState('')

  async function handleInstall(method: 'npm' | 'native') {
    setInstalling(true)
    setError('')
    setInstallLog(['Starting installation...'])

    try {
      await backendCall('install_claude_code', { method })

      // Poll status
      const poll = setInterval(async () => {
        try {
          const status = await backendCall<{ status: string; logs: string[] }>('install_claude_code_status')
          setInstallLog(status.logs)

          if (status.status === 'complete') {
            clearInterval(poll)
            setInstalling(false)
            onDetect() // Re-detect
          } else if (status.status === 'error') {
            clearInterval(poll)
            setInstalling(false)
            setError(status.logs[status.logs.length - 1] || 'Installation failed')
          }
        } catch {
          clearInterval(poll)
          setInstalling(false)
        }
      }, 1000)
    } catch (err) {
      setInstalling(false)
      setError((err as Error).message)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
      <Terminal size={28} className="text-gray-300 dark:text-gray-600 mb-3" />
      <p className="text-[0.85rem] text-gray-700 dark:text-gray-300 font-medium mb-1">Claude Code not installed</p>
      <p className="text-[0.7rem] text-gray-500 max-w-[340px] mb-4 leading-relaxed">
        Install the Claude Code CLI to use this feature. Runs locally with Ollama 0.14+.
      </p>

      {!installing ? (
        <div className="flex gap-2">
          <button
            onClick={() => handleInstall('native')}
            className="text-[0.65rem] px-4 py-1.5 rounded-md bg-gray-800 dark:bg-white/10 text-white dark:text-gray-200 hover:bg-gray-700 dark:hover:bg-white/15 transition-colors border border-gray-700 dark:border-white/10"
          >
            Install (Native)
          </button>
          <button
            onClick={() => handleInstall('npm')}
            className="text-[0.65rem] px-4 py-1.5 rounded-md bg-gray-100 dark:bg-white/[0.04] text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/[0.08] transition-colors border border-gray-200 dark:border-white/[0.06]"
          >
            Install via npm
          </button>
        </div>
      ) : (
        <div className="w-full max-w-[320px]">
          <div className="text-[0.5rem] text-gray-500 space-y-0.5 text-left bg-black/20 rounded p-2 max-h-[120px] overflow-y-auto">
            {installLog.map((log, i) => (
              <p key={i}>{log}</p>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="mt-2 flex items-center gap-1 text-[0.55rem] text-red-400">
          <AlertTriangle size={10} />
          <span>{error}</span>
        </div>
      )}

      <button
        onClick={onDetect}
        className="mt-3 text-[0.5rem] text-gray-600 hover:text-gray-400 transition-colors"
      >
        Already installed? Click to re-detect
      </button>
    </div>
  )
}

