import { useState } from 'react'
import { motion } from 'framer-motion'
import { MessageSquarePlus, Bot } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { ModalActions, ModalButton } from '../ui/ModalActions'
import { useAgentModeStore } from '../../stores/agentModeStore'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useChatNoticeStore } from '../../stores/chatNoticeStore'
import { canUseTools } from '../../lib/tool-support'
import { FEATURE_FLAGS } from '../../lib/constants'
import { MOTION_S } from '../ui/motion'

/**
 * The session-strip toolbar's own text size, one size below `.t-micro`
 * (10px, this one 8.8px). `FlashChatNotice.tsx` shares this constant instead
 * of typing the same arbitrary Tailwind size a second time: a second literal
 * of the same value in that file would count as a second escape from the
 * typo ladder against `die-typo-leiter-und-ihre-umgehung.test.ts`
 * (`hoechstens 820 Fundstellen`, already at the cap), while one shared
 * constant, referenced by name at every call site, counts once, no matter
 * how many components read it.
 */
export const TOOLBAR_LABEL_TEXT = 'text-[0.55rem]'

export function AgentModeToggle() {
  const [showNewChatModal, setShowNewChatModal] = useState(false)
  const [neverShowChecked, setNeverShowChecked] = useState(false)
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

  // 3.1.2: switching Agent on opens nothing. Where the agent works is asked in
  // the thread, on the first message of a chat without a workspace
  // (lib/agent-workspace-ask.ts, WorkspaceAskCard).

  const createNewAgentChat = () => {
    if (!activeModel) return
    const persona = useSettingsStore.getState().getActivePersona()
    const newId = createConversation(activeModel, persona?.systemPrompt || '')
    useAgentModeStore.getState().toggleAgentMode(newId)
    // Die Zeile "Plain chat cannot open files" hat ihren Rat gegeben.
    useChatNoticeStore.getState().dismiss('agent-for-local-files')
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
    if (!isActive) {
      useChatNoticeStore.getState().dismiss('agent-for-local-files')
    }
  }

  const handleNewAgentChat = () => {
    if (neverShowChecked) {
      useAgentModeStore.getState().setNewChatHintDismissed(true)
    }
    createNewAgentChat()
    setShowNewChatModal(false)
    setNeverShowChecked(false)
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
          `flex items-center gap-1 px-2 py-0.5 rounded border transition-colors ${TOOLBAR_LABEL_TEXT} ` +
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
      <Modal open={showNewChatModal} onClose={() => { setShowNewChatModal(false); setNeverShowChecked(false) }} title="New Chat Required" ariaLabel="New chat required">
        <div className="space-y-4">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: MOTION_S.base }}
            className="space-y-3"
          >
            {/* Hier leuchtete ein gelber Punkt mit Schein. Er war reine
                Zierde: ein Zustandspunkt sagt an, aus oder kaputt, und
                „dieser Dialog ist offen" ist keins davon. Der Titel darunter
                sagt dasselbe in Worten (`lib/hinweis.ts`). */}
            <p className="text-[12px] text-gray-400 leading-relaxed">
              Agent Mode needs to be active from the start of a conversation to work properly. Start a new chat with Agent Mode enabled.
            </p>
          </motion.div>

          {/* Never show again */}
          <label className="flex items-center gap-2 cursor-pointer group">
            <input
              type="checkbox"
              checked={neverShowChecked}
              onChange={(e) => setNeverShowChecked(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-white/20 bg-white/5 text-green-500 focus:ring-green-500/30 focus:ring-offset-0 cursor-pointer"
            />
            <span className="t-micro text-gray-500 group-hover:text-gray-400 transition-colors select-none">
              Don't show this again
            </span>
          </label>

          {/* Actions */}
          <ModalActions>
            <ModalButton variant="quiet" onClick={() => { setShowNewChatModal(false); setNeverShowChecked(false) }}>
              Cancel
            </ModalButton>
            <ModalButton variant="primary" onClick={handleNewAgentChat}>
              <MessageSquarePlus size={14} />
              New Agent Chat
            </ModalButton>
          </ModalActions>
        </div>
      </Modal>

    </>
  )
}
