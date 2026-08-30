/**
 * What the open chat actually ran on, when that is not what the picker beside
 * it says.
 *
 * Meldung 4 of the R5 re-measure on the 2.6.7 Windows build (2026-08-30). The
 * only model name near a chat was the picker's, and the picker names the
 * global choice. So opening a 13 hour old chat while the pick stood on
 * Qwen3-4B put "Qwen3-4B" beside a transcript Hermes had written, three times
 * over in three measured cases.
 *
 * The picker is not moved: it says what the NEXT answer runs on, which is its
 * job and is true. This says what the answers on screen came from, which
 * nothing said. It is sourced from the conversation alone (the last assistant
 * turn's own record, falling back to the conversation field for chats from
 * before that record existed) and never from the global pick, and it is drawn
 * only when the two differ, so a chat continuing on its own model shows one
 * name and not the same name twice.
 */

import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { conversationModel, conversationModelDiffers } from '../../lib/conversation-model'
import { displayModelName } from '../../api/providers/registry'

export function ConversationModelNote() {
  const conv = useChatStore((s) => s.conversations.find((c) => c.id === s.activeConversationId))
  const activeModel = useModelStore((s) => s.activeModel)

  if (!conversationModelDiffers(conv, activeModel)) return null
  const ran = conversationModel(conv)

  return (
    <span
      className="hidden sm:flex items-center gap-1 h-[26px] px-2 rounded-md border border-white/[0.06] text-[0.6rem] text-gray-500 dark:text-gray-400 shrink-0"
      title={`The answers in this chat were written by ${ran}. The picker beside this is what the next answer would run on.`}
    >
      <span className="opacity-70">answers:</span>
      <span className="max-w-[110px] truncate leading-none">{displayModelName(ran).split(':')[0]}</span>
    </span>
  )
}
