import { Smartphone } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { HEADER_CHIP } from './header-chip'
import { SHARED_CHATS_PHONE_NOTE } from './shared-chats-note'

/**
 * "Continue on phone" in the chat's own strip (CHATS-V1.md): shares the open
 * chat with the paired phones, or ends that. A shared chat is listed in the
 * app under "Remote desktop", and it runs on this computer either way.
 */
export function ContinueOnPhoneButton() {
  const id = useChatStore((s) => s.activeConversationId)
  const shared = useChatStore((s) => !!s.conversations.find((c) => c.id === s.activeConversationId)?.remoteShared)
  if (!id) return null
  const label = shared ? 'Shared with your phone. Click to stop sharing.' : 'Continue on phone'
  const title = `${shared ? label : `${label}.`} ${SHARED_CHATS_PHONE_NOTE}`
  return (
    <button
      type="button"
      onClick={() => useChatStore.getState().setRemoteShared(id, !shared)}
      className={`${HEADER_CHIP} ${
        shared
          ? 'border-green-500/40 text-green-600 dark:text-green-400 hover:border-green-500/70'
          : 'border-gray-200 dark:border-white/[0.06] hover:border-gray-400 dark:hover:border-white/15 text-gray-500'
      }`}
      title={title}
      aria-label={label}
      aria-pressed={shared}
      data-testid="continue-on-phone"
    >
      <Smartphone size={10} />
      {shared && <span>Phone</span>}
    </button>
  )
}
