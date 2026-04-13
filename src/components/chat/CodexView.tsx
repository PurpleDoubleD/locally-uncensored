import { useCodex } from '../../hooks/useCodex'
import { useCodexStore } from '../../stores/codexStore'
import { useChatStore } from '../../stores/chatStore'
import { ChatInput } from './ChatInput'
import { ToolCallBlock } from './ToolCallBlock'
import { ThinkingBlock } from './ThinkingBlock'
import { MarkdownRenderer } from './MarkdownRenderer'
import { TokenCounter } from './TokenCounter'
import { MemoryDebugToggle } from './MemoryDebugPanel'
import { RealtimeCounter } from './RealtimeCounter'
import { PluginsDropdown } from './PluginsDropdown'
import { useSettingsStore } from '../../stores/settingsStore'
import { User, Code, Brain } from 'lucide-react'
import { useEffect, useRef } from 'react'

function stripChannelTags(text: string): string {
  return text
    .replace(/<\|?channel>?\s*thought\s*/gi, '')
    .replace(/<\|?channel\|?>/gi, '')
    .replace(/<channel\|>/gi, '')
    .trim()
}

export function CodexView() {
  const { sendInstruction, stopCodex, isRunning } = useCodex()
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const conversations = useChatStore((s) => s.conversations)
  const thread = useCodexStore((s) => activeConversationId ? s.threads[activeConversationId] : undefined)
  const scrollRef = useRef<HTMLDivElement>(null)

  const conversation = conversations.find(c => c.id === activeConversationId)
  const messages = conversation?.messages || []

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, thread?.events])

  const thinkingEnabled = useSettingsStore((s) => s.settings.thinkingEnabled)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Main panel */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        {/* Codex header */}
        <div className="flex items-center gap-1.5 px-2 py-0.5 border-b border-gray-200 dark:border-white/[0.04]">
          <Code size={9} className="text-gray-500" />
          <span className="text-[0.55rem] text-gray-600 dark:text-gray-400 font-medium">Codex</span>
          <div className="flex-1" />
          <TokenCounter />
          <MemoryDebugToggle />
          <PluginsDropdown />
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <Code size={24} className="text-gray-300 dark:text-gray-700 mb-2" />
              <p className="text-[0.7rem] text-gray-500 font-medium">Codex Coding Agent</p>
              <p className="text-[0.55rem] text-gray-400 dark:text-gray-600 mt-0.5 max-w-[300px]">
                Send a coding instruction. Codex will read your codebase, write code, and run commands.
              </p>
              {!thread?.workingDirectory && (
                <p className="text-[0.55rem] text-amber-500/70 mt-2">
                  Set a working directory in the file tree panel →
                </p>
              )}
            </div>
          ) : (
            <div className="py-1">
              {messages.map((msg) => {
                const cleanContent = msg.content ? stripChannelTags(msg.content) : ''
                return (
                  <div
                    key={msg.id}
                    className={`flex gap-2 px-3 py-1 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
                  >
                    <div className={`w-5 h-5 rounded flex items-center justify-center shrink-0 ${
                      msg.role === 'user'
                        ? 'bg-gray-100 dark:bg-white/8'
                        : 'bg-gray-50 dark:bg-white/5'
                    }`}>
                      {msg.role === 'user'
                        ? <User size={9} className="text-gray-400" />
                        : <Code size={9} className="text-gray-500" />
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
                      {cleanContent && (
                        <div className={`rounded-lg px-2.5 py-1.5 ${
                          msg.role === 'user'
                            ? 'bg-gray-100 dark:bg-white/[0.06] border border-gray-200 dark:border-white/[0.08]'
                            : 'bg-white dark:bg-white/[0.02] border border-gray-100 dark:border-white/[0.03]'
                        }`}>
                          <div className="text-[0.75rem] leading-relaxed">
                            {msg.role === 'user' ? (
                              <p className="text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{cleanContent}</p>
                            ) : (
                              <MarkdownRenderer content={cleanContent} />
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Realtime counter */}
        <RealtimeCounter isRunning={isRunning} />

        {/* Input */}
        <ChatInput
          onSend={(content) => sendInstruction(content)}
          onStop={stopCodex}
          isGenerating={isRunning}
        />
      </div>

      {/* Right sidebar: File Tree */}
      <div className="w-48 shrink-0">
        <FileTree />
      </div>
    </div>
  )
}

import { FileTree } from './FileTree'
