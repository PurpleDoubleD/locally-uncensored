import { useChatStore } from '../../stores/chatStore'
import { useCodexStore } from '../../stores/codexStore'
import { useRemoteStore } from '../../stores/remoteStore'
import { useUIStore } from '../../stores/uiStore'

/**
 * Does the Remote area show its own entry instead of a chat? Yes with no chat
 * open, and with an empty Remote chat no phone is attached to: a composer
 * there would just answer from the local model and look like Remote worked.
 * A Remote chat with history stays open, it has its own Restart banner.
 */
export function showsRemoteEntry(
  chatMode: string,
  conversation: { id: string; mode?: string; messages: readonly unknown[] } | null | undefined,
  dispatchedConversationId: string | null,
  remoteEnabled: boolean,
): boolean {
  if (chatMode !== 'remote') return false
  if (!conversation) return true
  if (conversation.mode !== 'remote' || conversation.messages.length > 0) return false
  return !(remoteEnabled && dispatchedConversationId === conversation.id)
}

/** The one way into the Remote area, from anywhere in the app. */
export function openRemoteArea(): void {
  useCodexStore.getState().setChatMode('remote')
  useChatStore.getState().setActiveConversation(useRemoteStore.getState().dispatchedConversationId)
  useUIStore.getState().setView('chat')
}
