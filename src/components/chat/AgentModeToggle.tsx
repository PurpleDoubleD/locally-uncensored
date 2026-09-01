import { useState } from 'react'
import { motion } from 'framer-motion'
import { MessageSquarePlus, Bot } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { useAgentModeStore } from '../../stores/agentModeStore'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { canUseTools } from '../../lib/tool-support'
import { FEATURE_FLAGS } from '../../lib/constants'
import { AgentWorkspaceDialog } from './AgentWorkspaceDialog'
import type { AgentWorkspace } from '../../types/agent-workspace'

export function AgentModeToggle() {
  const [showNewChatModal, setShowNewChatModal] = useState(false)
  const [neverShowChecked, setNeverShowChecked] = useState(false)
  // Workspace picker — opens after a fresh agent-mode activation when
  // the conversation doesn't yet have a workspace assigned. Cancelable
  // (the bridge falls back to its per-chat sandbox), but offered so
  // power users can point the agent at a real folder up front.
  const [showWorkspaceDialog, setShowWorkspaceDialog] = useState(false)
  const [workspaceDialogConvId, setWorkspaceDialogConvId] = useState<string | null>(null)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const conversations = useChatStore((s) => s.conversations)
  const createConversation = useChatStore((s) => s.createConversation)
  const activeModel = useModelStore((s) => s.activeModel)
  const activeModelMeta = useModelStore((s) => s.models.find((m) => m.name === s.activeModel))
  const { agentModeActive, toggleAgentMode, newChatHintDismissed } = useAgentModeStore()

  if (!FEATURE_FLAGS.AGENT_MODE || !activeConversationId) return null

  const isActive = agentModeActive[activeConversationId] ?? false
  // ONE source of truth for "can this model drive tools", the same function the
  // run itself asks. This toggle used to re-derive it, and the copy went stale:
  //   1. a run PROVED it rejects tools (reactive cache, cloud 405 / ollama
  //      "does not support tools") → disabled, even if the name looks capable
  //   2. server-declared capability (supports_tools): for a CLOUD model false
  //      still means disabled up front, so nobody eats a mid-run 400 on the
  //      models without function calling (Hermes 3, Euryale, …)
  //   3. otherwise the family name heuristic
  //
  // ⚠️ The old copy of this stopped at "serverTools === false → disabled" and
  // that is wrong for a LOCAL model. `resolveToolSupport` maps exactly that
  // case to 'hermes', because the prompt transport drives those models fine.
  // Measured on the installed build 2026-08-06: with
  // hf.co/DevQuasar/huihui-ai.Qwen3-4B-abliterated-GGUF, which Ollama reports
  // as `capabilities: ['completion']`, the Coding surface ran 51 tool steps
  // while this toggle sat greyed out saying "not agent-compatible". Same
  // model, same backend, same schema, opposite verdicts on the two surfaces.
  // The picker badge was corrected the same day (three states, not two) and
  // this toggle was not brought along.
  const serverTools = activeModelMeta && 'supportsTools' in activeModelMeta ? activeModelMeta.supportsTools : undefined
  const isCompatible = activeModel
    ? canUseTools({ name: activeModel, supportsTools: serverTools })
    : false

  const conversation = conversations.find((c) => c.id === activeConversationId)
  const hasMessages = (conversation?.messages?.length ?? 0) > 0

  /**
   * After an agent-mode activate, if the conversation hasn't picked a
   * workspace yet, open AgentWorkspaceDialog so the user can choose
   * between sandbox and a real folder. Skipped when a workspace is
   * already set (toggling back on after a deactivate) or when the user
   * has a `settings.defaultWorkspace` configured.
   */
  const maybeOpenWorkspaceDialog = (convId: string) => {
    const hasPerChat = !!useAgentModeStore.getState().workspaces[convId]
    const hasDefault = !!useSettingsStore.getState().settings.defaultWorkspace
    if (hasPerChat || hasDefault) return
    setWorkspaceDialogConvId(convId)
    setShowWorkspaceDialog(true)
  }

  const createNewAgentChat = () => {
    if (!activeModel) return
    const persona = useSettingsStore.getState().getActivePersona()
    const newId = createConversation(activeModel, persona?.systemPrompt || '')
    useAgentModeStore.getState().toggleAgentMode(newId)
    maybeOpenWorkspaceDialog(newId)
  }

  const handleToggle = () => {
    if (!isCompatible) return

    // Chat has messages and agent is off → redirect
    if (hasMessages && !isActive) {
      // "Never show again" was checked previously → skip modal, just create
      if (newChatHintDismissed) {
        createNewAgentChat()
        return
      }
      setShowNewChatModal(true)
      return
    }

    // 2.5.9 dropped the first-run Agent tutorial modal — flipping the switch
    // just flips it now.
    toggleAgentMode(activeConversationId)
    // If the user just turned agent ON (was inactive, now active) and
    // hasn't picked a workspace for this conversation, prompt for one.
    if (!isActive) maybeOpenWorkspaceDialog(activeConversationId)
  }

  const handleNewAgentChat = () => {
    if (neverShowChecked) {
      useAgentModeStore.getState().setNewChatHintDismissed(true)
    }
    createNewAgentChat()
    setShowNewChatModal(false)
    setNeverShowChecked(false)
  }

  const handleWorkspaceChoose = (workspace: AgentWorkspace) => {
    if (workspaceDialogConvId) {
      useAgentModeStore.getState().setWorkspace(workspaceDialogConvId, workspace)
    }
    setShowWorkspaceDialog(false)
    setWorkspaceDialogConvId(null)
  }

  const handleWorkspaceClose = () => {
    // Cancel just dismisses — bridge will fall back to per-chat sandbox.
    setShowWorkspaceDialog(false)
    setWorkspaceDialogConvId(null)
  }

  return (
    <>
      {/* Tools-style button (same size/look as the Tools toggle it sits next
          to). Green when active, dimmed + disabled when the model can't agent. */}
      <button
        onClick={handleToggle}
        disabled={!isCompatible}
        title={
          !isCompatible
            ? 'This model is not agent-compatible'
            : isActive
              ? 'Agent Mode is on. Click to turn off'
              : 'Agent Mode is off. Click to turn on'
        }
        className={
          'flex items-center gap-1 px-2 py-0.5 rounded border transition-colors text-[0.55rem] ' +
          (isActive
            ? 'border-green-500/30 text-green-400'
            : !isCompatible
              ? 'border-white/[0.04] text-gray-600 opacity-50 cursor-not-allowed'
              : 'border-gray-200 dark:border-white/[0.06] text-gray-500 hover:border-gray-400 dark:hover:border-white/15')
        }
      >
        <Bot size={9} />
        <span>Agent</span>
      </button>

      {/* New Chat Required Modal */}
      <Modal open={showNewChatModal} onClose={() => { setShowNewChatModal(false); setNeverShowChecked(false) }} title="" ariaLabel="New chat required">
        <div className="space-y-4">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="text-center space-y-3"
          >
            <div className="flex justify-center">
              <div
                className="w-3 h-3 rounded-full bg-amber-500 shadow-lg"
                style={{ boxShadow: '0 0 20px 4px rgba(245, 158, 11, 0.4)' }}
              />
            </div>

            <h3 className="text-base font-semibold text-white">New Chat Required</h3>
            <p className="text-[12px] text-gray-400 leading-relaxed">
              Agent Mode needs to be active from the start of a conversation to work properly. Start a new chat with Agent Mode enabled.
            </p>
          </motion.div>

          {/* Never show again */}
          <label className="flex items-center justify-center gap-2 cursor-pointer group">
            <input
              type="checkbox"
              checked={neverShowChecked}
              onChange={(e) => setNeverShowChecked(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-white/20 bg-white/5 text-green-500 focus:ring-green-500/30 focus:ring-offset-0 cursor-pointer"
            />
            <span className="text-[0.65rem] text-gray-500 group-hover:text-gray-400 transition-colors select-none">
              Don't show this again
            </span>
          </label>

          {/* Actions */}
          <div className="flex items-center justify-between pt-1">
            <button
              onClick={() => { setShowNewChatModal(false); setNeverShowChecked(false) }}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[0.7rem] text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
            >
              Cancel
            </button>

            <button
              onClick={handleNewAgentChat}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[0.7rem] font-medium bg-green-500/15 border border-green-500/30 text-green-300 hover:bg-green-500/25 transition-colors"
            >
              <MessageSquarePlus size={14} />
              New Agent Chat
            </button>
          </div>
        </div>
      </Modal>

      {showWorkspaceDialog && workspaceDialogConvId && (
        <AgentWorkspaceDialog
          open={showWorkspaceDialog}
          conversationId={workspaceDialogConvId}
          onChoose={handleWorkspaceChoose}
          onClose={handleWorkspaceClose}
        />
      )}
    </>
  )
}
