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
 * before that record existed) and never from the global pick, and it is only
 * there when the two differ, so a chat continuing on its own model does not
 * print the same name twice.
 *
 * It used to be a chip of its own in the composer row, printing the model name
 * under a small label. David on 2026-09-02: "mach das woanders hin, versteckter
 * bitte, muss nicht so sein". So the row carries no extra text any more. The
 * information rides on the picker itself instead: a 4 px dot on its corner,
 * and the full sentence in the picker's tooltip. Nothing is lost, it is just quiet until asked.
 */

import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { conversationModel, conversationModelDiffers } from '../../lib/conversation-model'
import { displayModelName } from '../../api/providers/registry'

/**
 * The display name of the model that wrote the open chat's answers, when that
 * is not the model the picker stands on. `null` otherwise, which is the normal
 * case and draws nothing at all.
 */
export function useConversationModelHint(): string | null {
  const conv = useChatStore((s) => s.conversations.find((c) => c.id === s.activeConversationId))
  const activeModel = useModelStore((s) => s.activeModel)

  if (!conversationModelDiffers(conv, activeModel)) return null
  return displayModelName(conversationModel(conv)).split(':')[0]
}
