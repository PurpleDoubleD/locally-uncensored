import { useState, useEffect } from 'react'
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
import { AgentWorkspaceBadge } from './AgentWorkspaceBadge'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { useSettingsStore } from '../../stores/settingsStore'
import { FileText, ChevronDown, Download, Wrench, Radio, RefreshCw, X } from 'lucide-react'
import { PluginsDropdown } from './PluginsDropdown'
import { ModelSelector } from '../models/ModelSelector'
import { ConversationModelNote } from './ConversationModelNote'
import { GoalBar } from './GoalBar'
import { PlanBar } from './PlanBar'
import { LoopBar } from './LoopBar'
import { GroupCostHint } from './GroupCostHint'
import { MemoryDebugToggle } from './MemoryDebugPanel'
import { TokenCounter } from './TokenCounter'
import { ContextDropdown } from './ContextDropdown'
import { SmallModelModeToggle } from './SmallModelModeToggle'
import { ABCompare } from './ABCompare'
import { RecentChats } from './RecentChats'
import { useUIStore } from '../../stores/uiStore'
import { useCompareStore } from '../../stores/compareStore'
import { exportConversation } from '../../lib/chat-export'
import { PermissionOverrideBar } from './PermissionOverrideBar'
import { CodexView } from './CodexView'
import { useCodexStore } from '../../stores/codexStore'
import { useGenerationStore } from '../../stores/generationStore'
import { useRemoteStore } from '../../stores/remoteStore'

export function ChatView() {
  const { sendMessage, stopGeneration, isGenerating, isLoadingModel, regenerateMessage, editAndResend, pendingApproval, approveToolCall, rejectToolCall } = useChat()
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  // Drives the recent-chats list on the empty screen: collapsed panel means
  // the list stands in the main area, expanded means it stands in the panel.
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const conversations = useChatStore((s) => s.conversations)
  const activeModel = useModelStore((s) => s.activeModel)
  const models = useModelStore((s) => s.models)
  const [ragPanelOpen, setRagPanelOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportToast, setExportToast] = useState<string>('')
  const [toolsDropdownOpen, setToolsDropdownOpen] = useState(false)
  const chatMode = useCodexStore((s) => s.chatMode)

  // Per-conversation generating flag (David 2026-06-12): the typing indicator
  // + realtime counter must show ONLY in the chat that is actually generating,
  // not in every other chat the user switches to. `isGenerating` from the hook
  // is global (and stays so for the input, where it guards shared stream refs);
  // the visual indicators below read this conversation-scoped map instead.
  const generatingMap = useGenerationStore((s) => s.generating)
  const activeGenerating = !!activeConversationId && !!generatingMap[activeConversationId]

  const docCount = useRAGStore((s) =>
    activeConversationId ? (s.documents[activeConversationId] || []).length : 0
  )
  const ragEnabled = useRAGStore((s) =>
    activeConversationId ? s.ragEnabled[activeConversationId] ?? false : false
  )
  // Docs (RAG) needs a LOCAL embeddings backend (built-in llama-server or
  // Ollama). In global Cloud mode there is none, so mirror the web app and
  // hide the Docs button rather than offer an upload that fails with
  // "Ollama is not running". Local mode keeps it (built-in engine embeds).
  const appMode = useSettingsStore((s) => s.settings.appMode)
  const isAgentActive = useAgentModeStore((s) =>
    activeConversationId ? s.agentModeActive[activeConversationId] ?? false : false
  )
  const isComparing = useCompareStore((s) => s.isComparing)

  // Remote-chat state: show a reactivate banner when the user is viewing a
  // Remote conversation whose server has been stopped.
  const remoteEnabled = useRemoteStore((s) => s.enabled)
  const remoteLoading = useRemoteStore((s) => s.loading)
  const remoteError = useRemoteStore((s) => s.error)
  const dispatchedConversationId = useRemoteStore((s) => s.dispatchedConversationId)
  const remoteRestart = useRemoteStore((s) => s.restart)
  const remoteClearError = useRemoteStore((s) => s.clearError)
  const connectedDevices = useRemoteStore((s) => s.connectedDevices)
  const refreshDevices = useRemoteStore((s) => s.refreshDevices)
  const activeConv = conversations.find((c) => c.id === activeConversationId)
  const isRemoteChat = activeConv?.mode === 'remote'
  const isThisRemoteActive = isRemoteChat && remoteEnabled && dispatchedConversationId === activeConversationId
  const isThisRemoteStopped = isRemoteChat && !isThisRemoteActive
  const mobileConnectedCount = connectedDevices.length

  // Bug #1: keep the "Live" banner honest. Poll the real connected-device
  // count every 5 s while we're viewing the dispatched chat so the badge
  // reflects whether a phone is actually attached, not just that the
  // server is running.
  useEffect(() => {
    if (!isThisRemoteActive) return
    refreshDevices()
    const t = setInterval(refreshDevices, 5000)
    return () => clearInterval(t)
  }, [isThisRemoteActive, refreshDevices])

  // Auto-dismiss the "saved to…" toast after a few seconds
  useEffect(() => {
    if (!exportToast) return
    const t = setTimeout(() => setExportToast(''), 4000)
    return () => clearTimeout(t)
  }, [exportToast])

  // Approval keyboard shortcuts — Enter approves, Esc rejects the
  // head-of-queue tool call. The buttons themselves now live inside
  // ToolCallBlock so they appear inline on the pending block, but the
  // keyboard layer stays here so the shortcuts work regardless of
  // scroll position.
  useEffect(() => {
    if (!pendingApproval || !approveToolCall || !rejectToolCall) return
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        approveToolCall()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        rejectToolCall()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [pendingApproval, approveToolCall, rejectToolCall])

  const handleRemoteReactivate = async () => {
    if (!activeConv || !activeConversationId) return
    try {
      await remoteRestart(activeConv.model, activeConv.systemPrompt)
      useRemoteStore.setState({ dispatchedConversationId: activeConversationId })
    } catch {
      // #29: restart now rethrows. The store's `error` already holds the
      // reason (e.g. "Could not bind 0.0.0.0:11435: Address already in
      // use"). The "Server stopped" banner below renders that reason
      // inline so the user knows what to do — instead of clicking Restart
      // forever and watching nothing change.
    }
  }

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
            <img src="/LU-monogram-bw.png" alt="" width={46} height={46} className="dark:invert-0 invert opacity-20 mb-5" />

            {/* The latest chats stand here only while the side panel is
                collapsed (David, web parity). Expanded, the list lives in the
                panel and would be on screen twice. */}
            {!sidebarOpen && <RecentChats />}

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
              ) : (<>
              {/* Top bar — slim: session/meta controls only. Docs · Plugins ·
                  Tools + the model picker moved into the composer action bar
                  (web parity, David 2026-07-11); Memory stands alone top-right. */}
              <div className="flex items-center gap-1.5 px-2 pt-0.5">
                <AgentModeToggle />
                <AgentWorkspaceBadge />

                {/* Spacer */}
                <div className="flex-1" />

                {/* Token Counter */}
                <TokenCounter />

                {/* Context window picker (Ollama num_ctx / LM Studio loaded ctx) */}
                <ContextDropdown />

                {/* Small-Model Mode — only relevant when the agent loop (tools)
                    is active; plain chat has no tool calls to lean out. */}
                {isAgentActive && <SmallModelModeToggle />}

                {/* Memory — standalone, top-right (moved out of the header model
                    picker; David 2026-07-11). View / add / delete injected context. */}
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
                            onClick={async () => {
                              const conv = conversations.find(c => c.id === activeConversationId)
                              setExportOpen(false)
                              if (!conv) return
                              const result = await exportConversation(conv, fmt)
                              if (result.status === 'saved' && result.path) {
                                setExportToast(`Saved to ${result.path}`)
                              } else if (result.status === 'downloaded') {
                                setExportToast(`Downloaded .${fmt === 'markdown' ? 'md' : 'json'}`)
                              }
                              // status === 'cancelled' → no toast, user closed the dialog
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
              </div>

              {/* The plan, for plain chat and for Agent alike. It belongs with
                  the standing status controls in the header, not at the prompt
                  box: the Chat surface has no right-hand column to hand it to,
                  and this row is where everything that is TRUE OF THE SESSION
                  rather than of the next message already lives (agent toggle,
                  workspace, token counter, context window, memory). Collapsed
                  by default so it costs one line above the transcript. */}
              <PlanBar />

              <MessageList
                isGenerating={isGenerating}
                isThisChatGenerating={activeGenerating}
                isLoadingModel={isLoadingModel}
                onRegenerate={regenerateMessage}
                onEdit={editAndResend}
                pendingApprovalId={pendingApproval?.id ?? null}
                onApprove={approveToolCall}
                onReject={rejectToolCall}
              />

              {/* Remote session banners */}
              {isThisRemoteActive && (
                <div className="mx-3 mb-1.5 flex items-center justify-between gap-2 px-2.5 py-1 rounded border border-green-500/25 bg-green-500/5 text-[0.6rem]">
                  <div className="flex items-center gap-1.5 text-green-400">
                    <Radio size={10} className="animate-pulse" />
                    <span className="font-medium">Live</span>
                    <span className="text-green-500/60">
                      {mobileConnectedCount > 0
                        ? `, ${mobileConnectedCount} mobile${mobileConnectedCount === 1 ? '' : 's'} connected`
                        : ', ready for mobile'}
                    </span>
                  </div>
                  <button
                    onClick={handleRemoteReactivate}
                    disabled={remoteLoading}
                    title="Regenerate passcode, keep this chat"
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-blue-400 hover:bg-blue-500/15 border border-blue-500/20 transition-all disabled:opacity-50"
                  >
                    <RefreshCw size={9} className={remoteLoading ? 'animate-spin' : ''} />
                    Restart
                  </button>
                </div>
              )}
              {isThisRemoteStopped && (
                <div
                  className={
                    'mx-3 mb-1.5 flex items-start justify-between gap-2 px-2.5 py-1 rounded border text-[0.6rem] ' +
                    (remoteError
                      ? 'border-red-500/30 bg-red-500/5'
                      : 'border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.02]')
                  }
                >
                  <div className={'flex flex-col gap-0.5 min-w-0 ' + (remoteError ? 'text-red-400' : 'text-gray-500')}>
                    <div className="flex items-center gap-1.5">
                      <Radio size={10} />
                      <span className="font-medium">Server stopped</span>
                      <span className={remoteError ? 'text-red-400/70' : 'text-gray-500/70'}>
                        {remoteError ? ', last attempt failed' : ', restart to reconnect mobile'}
                      </span>
                    </div>
                    {/* #29: surface the actual reason (port in use,
                        firewall, etc.) so the user knows why Restart is
                        not coming back, instead of staring at a button
                        that does nothing. */}
                    {remoteError && (
                      <div className="text-[0.55rem] text-red-300/80 break-words pl-4 leading-snug">
                        {remoteError}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {remoteError && (
                      <button
                        onClick={remoteClearError}
                        title="Dismiss error"
                        className="p-0.5 rounded text-red-400/70 hover:text-red-300 hover:bg-red-500/15 transition-all"
                      >
                        <X size={9} />
                      </button>
                    )}
                    <button
                      onClick={handleRemoteReactivate}
                      disabled={remoteLoading}
                      title="Start a fresh server and reattach this chat"
                      className={
                        'flex items-center gap-1 px-2 py-0.5 rounded transition-all disabled:opacity-50 font-medium ' +
                        (remoteError
                          ? 'text-red-300 hover:bg-red-500/15 border border-red-500/40'
                          : 'text-green-400 hover:bg-green-500/15 border border-green-500/30')
                      }
                    >
                      <RefreshCw size={9} className={remoteLoading ? 'animate-spin' : ''} />
                      {remoteError ? 'Retry' : 'Restart'}
                    </button>
                  </div>
                </div>
              )}

              <ChatInput
                onSend={sendMessage}
                onStop={stopGeneration}
                isGenerating={isGenerating}
                pendingApproval={pendingApproval}
                onApprove={approveToolCall}
                onReject={rejectToolCall}
                // Commands need the tool catalog to drive, which only Agent
                // mode has here. Plain chat leaves "/cmd" as ordinary text.
                slashCommands={isAgentActive}
                onAttachDocs={appMode !== 'cloud' ? () => setRagPanelOpen(true) : undefined}
                composerModel={
                  <div className="flex items-center gap-1.5">
                    {/* What this chat's answers were written by, when that is
                        not what the picker says (Meldung 4, R5 re-measure). */}
                    <ConversationModelNote />
                    <ModelSelector openUpward />
                  </div>
                }
                // No plan lives here. The prompt window is the prompt window
                // (David, 2026-08-22): the plan band sits under the header row
                // above, next to the other standing status controls.
                composerAbove={<><LoopBar onStop={stopGeneration} /><GoalBar /><GroupCostHint /></>}
                composerActions={
                  <>
                    {/* Documents (RAG) — local-embeddings only, so hide in
                        Cloud mode (web parity). */}
                    {appMode !== 'cloud' && (
                    <button
                      onClick={() => setRagPanelOpen(!ragPanelOpen)}
                      className={
                        'flex items-center gap-1 px-2 py-1.5 rounded-md transition-all shrink-0 text-[0.6rem] font-medium ' +
                        (ragPanelOpen || ragEnabled
                          ? 'bg-green-500/15 text-green-400 border border-green-500/30'
                          : 'text-gray-500 hover:text-gray-300 hover:bg-white/5')
                      }
                      title="Document Chat (RAG)"
                    >
                      <FileText size={11} />
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
                    )}

                    {/* Plugins (Chat Tools + Caveman + Personas) */}
                    <PluginsDropdown openUpward />

                    {/* Tools — agent permission overrides (only when agent active) */}
                    {isAgentActive && (
                      <div className="relative">
                        <button
                          onClick={() => setToolsDropdownOpen(!toolsDropdownOpen)}
                          className="flex items-center gap-1 px-2 py-1.5 rounded-md text-gray-500 hover:text-gray-300 hover:bg-white/5 transition-all shrink-0 text-[0.6rem] font-medium"
                        >
                          <Wrench size={11} className="text-green-400" />
                          <span>Tools</span>
                          <ChevronDown size={9} className={`transition-transform ${toolsDropdownOpen ? 'rotate-180' : ''}`} />
                        </button>
                        {toolsDropdownOpen && (
                          <>
                            <div className="fixed inset-0 z-40" onClick={() => setToolsDropdownOpen(false)} />
                            <div className="absolute left-0 bottom-full mb-0.5 z-50 w-28 rounded-md bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/10 shadow-xl py-0.5 px-0.5">
                              <PermissionOverrideBar />
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </>
                }
              />
            </>)}
            </div>

            {/* RAG Panel */}
            <AnimatePresence>
              {ragPanelOpen && (
                <ErrorBoundary fallbackClassName="w-[280px] shrink-0 h-full border-l border-white/5 bg-[#363636] flex flex-col items-center justify-center p-6 gap-3">
                  <RAGPanel conversationId={activeConversationId} onClose={() => setRagPanelOpen(false)} />
                </ErrorBoundary>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Export toast */}
      <AnimatePresence>
        {exportToast && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.18 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[120] px-4 py-2 rounded-lg bg-[#262626] border border-green-500/30 text-green-400 text-[0.7rem] shadow-xl max-w-[min(90vw,520px)] truncate"
          >
            {exportToast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
