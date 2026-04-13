import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useChat } from '../../hooks/useChat'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useRAGStore } from '../../stores/ragStore'
import { useAgentModeStore } from '../../stores/agentModeStore'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { RAGPanel } from './RAGPanel'
import { AgentModeToggle } from './AgentModeToggle'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { useSettingsStore } from '../../stores/settingsStore'
import { FEATURE_FLAGS } from '../../lib/constants'
import { isAgentCompatible, isThinkingCompatible } from '../../lib/model-compatibility'
import { FileText, Bot, ChevronDown, Download, Brain, Wrench } from 'lucide-react'
import { PluginsDropdown } from './PluginsDropdown'
import { TokenCounter } from './TokenCounter'
import { MemoryDebugToggle } from './MemoryDebugPanel'
import { ABCompare } from './ABCompare'
import { useCompareStore } from '../../stores/compareStore'
import { exportConversation } from '../../lib/chat-export'
import { PermissionOverrideBar } from './PermissionOverrideBar'
import { RealtimeCounter } from './RealtimeCounter'
import { CodexView } from './CodexView'
import { ClaudeCodeView } from './ClaudeCodeView'
import { useCodexStore } from '../../stores/codexStore'

export function ChatView() {
  const { sendMessage, stopGeneration, isGenerating, isLoadingModel, regenerateMessage, editAndResend, pendingApproval, approveToolCall, rejectToolCall } = useChat()
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const conversations = useChatStore((s) => s.conversations)
  const activeModel = useModelStore((s) => s.activeModel)
  const models = useModelStore((s) => s.models)
  const [ragPanelOpen, setRagPanelOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [toolsDropdownOpen, setToolsDropdownOpen] = useState(false)
  const [thinkHint, setThinkHint] = useState('')
  const thinkingEnabled = useSettingsStore((s) => s.settings.thinkingEnabled)
  const canThink = isThinkingCompatible(activeModel)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const chatMode = useCodexStore((s) => s.chatMode)

  const docCount = useRAGStore((s) =>
    activeConversationId ? (s.documents[activeConversationId] || []).length : 0
  )
  const ragEnabled = useRAGStore((s) =>
    activeConversationId ? s.ragEnabled[activeConversationId] ?? false : false
  )
  const isAgentActive = useAgentModeStore((s) =>
    activeConversationId ? s.agentModeActive[activeConversationId] ?? false : false
  )
  const isComparing = useCompareStore((s) => s.isComparing)

  // A/B Compare mode takes over the entire view
  if (isComparing) {
    return <ABCompare />
  }

  return (
    <div className="h-full flex flex-col min-w-0">
      <AnimatePresence mode="wait">
        {!activeConversationId ? (
          // ── Homepage: just logo, no prompt ──
          <motion.div
            key="home"
            className="flex-1 flex flex-col items-center justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.2 }}
          >
            <img src="/LU-monogram-bw.png" alt="" width={46} height={46} className="dark:invert-0 invert opacity-20 mb-3" />
            <h1 className="text-[0.95rem] font-semibold text-gray-400 mb-0.5 tracking-wide">LUncensored</h1>
            <p className="text-[0.72rem] text-gray-600">Generate anything. Locally. Uncensored.</p>

            {models.length > 0 && !activeModel && (
              <p className="text-[0.6rem] text-amber-500/60 mt-3">Select a model above.</p>
            )}
          </motion.div>
        ) : (
          // ── Active chat ──
          <motion.div
            key="chat"
            className="flex-1 flex overflow-hidden"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
          >
            <div className="flex-1 flex flex-col min-w-0 relative">
              {chatMode === 'codex' ? (
                <CodexView />
              ) : chatMode === 'claude-code' ? (
                <ClaudeCodeView />
              ) : (<>
              {/* Top bar — compact (LU mode) */}
              <div className="flex items-center gap-1.5 px-2 pt-0.5">
                {/* Left: Tools Active dropdown (only when agent is active) */}
                {isAgentActive && (
                  <div className="relative">
                    <button
                      onClick={() => setToolsDropdownOpen(!toolsDropdownOpen)}
                      className="flex items-center gap-1 px-2 py-0.5 rounded border border-gray-200 dark:border-white/[0.06] text-gray-500 hover:border-gray-400 dark:hover:border-white/15 transition-colors text-[0.55rem]"
                    >
                      <Wrench size={9} className="text-green-400" />
                      <span>Tools</span>
                      <ChevronDown size={8} className={`transition-transform ${toolsDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>
                    {toolsDropdownOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setToolsDropdownOpen(false)} />
                        <div className="absolute left-0 top-full mt-0.5 z-50 w-28 rounded-md bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/10 shadow-xl py-0.5 px-0.5">
                          <PermissionOverrideBar />
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Spacer */}
                <div className="flex-1" />

                {/* Token Counter */}
                <TokenCounter />

                {/* Memory Debug */}
                <MemoryDebugToggle />

                {/* Export */}
                <div className="relative">
                  <button
                    onClick={() => setExportOpen(!exportOpen)}
                    className="flex items-center gap-1 px-2 py-0.5 rounded border border-gray-200 dark:border-white/[0.06] hover:border-gray-400 dark:hover:border-white/15 text-gray-500 transition-colors text-[0.55rem]"
                    title="Export chat"
                  >
                    <Download size={10} />
                  </button>
                  {exportOpen && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setExportOpen(false)} />
                      <div className="absolute right-0 top-full mt-1 z-50 w-32 rounded-lg bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/10 shadow-xl py-1">
                        {(['markdown', 'json'] as const).map(fmt => (
                          <button
                            key={fmt}
                            onClick={() => {
                              const conv = conversations.find(c => c.id === activeConversationId)
                              if (conv) exportConversation(conv, fmt)
                              setExportOpen(false)
                            }}
                            className="w-full text-left px-3 py-1 text-[0.55rem] text-gray-400 hover:bg-white/5 hover:text-gray-200 transition-colors"
                          >
                            .{fmt === 'markdown' ? 'md' : fmt}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                {/* Plugins dropdown (Caveman + Personas) */}
                <PluginsDropdown />

                {/* Documents (RAG) */}
                <button
                  onClick={() => setRagPanelOpen(!ragPanelOpen)}
                  className={
                    'flex items-center gap-1 px-2 py-0.5 rounded border transition-colors text-[0.55rem] ' +
                    (ragPanelOpen || ragEnabled
                      ? 'border-green-500/30 text-green-400'
                      : 'border-gray-200 dark:border-white/[0.06] hover:border-gray-400 dark:hover:border-white/15 text-gray-500')
                  }
                  title="Document Chat (RAG)"
                >
                  <FileText size={10} />
                  <span>Docs</span>
                  {docCount > 0 && (
                    <span className={
                      'min-w-[12px] h-[12px] flex items-center justify-center rounded-full text-[0.45rem] font-bold ' +
                      (ragEnabled ? 'bg-green-500 text-white' : 'bg-white/15 text-gray-300')
                    }>
                      {docCount}
                    </span>
                  )}
                </button>

                {/* Agent Mode */}
                {FEATURE_FLAGS.AGENT_MODE && (
                  <div className={
                    'flex items-center gap-1 px-2 py-0.5 rounded border transition-colors text-[0.55rem] ' +
                    (isAgentActive
                      ? 'border-green-500/30 text-green-400'
                      : activeModel && !isAgentCompatible(activeModel)
                        ? 'border-white/[0.04] text-gray-600 opacity-50'
                        : 'border-gray-200 dark:border-white/[0.06] text-gray-500')
                  }>
                    <Bot size={10} />
                    <span>Agent</span>
                    <AgentModeToggle />
                  </div>
                )}
              </div>

              <MessageList
                isGenerating={isGenerating}
                isLoadingModel={isLoadingModel}
                onRegenerate={regenerateMessage}
                onEdit={editAndResend}
              />
              <RealtimeCounter isRunning={isGenerating} />
              <ChatInput
                onSend={sendMessage}
                onStop={stopGeneration}
                isGenerating={isGenerating}
                pendingApproval={pendingApproval}
                onApprove={approveToolCall}
                onReject={rejectToolCall}
              />
            </>)}
            </div>

            {/* RAG Panel */}
            <AnimatePresence>
              {ragPanelOpen && (
                <ErrorBoundary fallbackClassName="w-[280px] shrink-0 h-full border-l border-white/5 bg-[#2a2a2a] flex flex-col items-center justify-center p-6 gap-3">
                  <RAGPanel conversationId={activeConversationId} />
                </ErrorBoundary>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
