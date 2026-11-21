import { useEffect } from 'react'
import { Smartphone } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useRemoteStore } from '../../stores/remoteStore'
import { openRemoteArea } from '../remote/remote-entry'
import { HEADER_CHIP } from './header-chip'

/** A phone that can read shared chats is known to this computer. */
function hasPhone(): boolean {
  const { pairedDevices, connectedDevices } = useRemoteStore.getState()
  return pairedDevices.length > 0 || connectedDevices.length > 0
}

/**
 * "Continue on phone" in the chat's own strip (CHATS-V1.md): shares the open
 * chat with the paired phones, or ends that. With no phone paired yet the
 * click leads to the Remote setup and shares nothing.
 */
export function ContinueOnPhoneButton() {
  const id = useChatStore((s) => s.activeConversationId)
  const shared = useChatStore((s) => !!s.conversations.find((c) => c.id === s.activeConversationId)?.remoteShared)
  const paired = useRemoteStore((s) => s.pairedDevices.length > 0 || s.connectedDevices.length > 0)

  useEffect(() => {
    void useRemoteStore.getState().refreshPairedDevices()
  }, [])

  if (!id) return null
  const label = shared ? 'Stop sharing with phone' : paired ? 'Continue on phone' : 'Set up your phone'

  const onClick = async () => {
    if (shared) {
      useChatStore.getState().setRemoteShared(id, false)
      return
    }
    // Asked at click time: the list may not have loaded yet.
    await useRemoteStore.getState().refreshPairedDevices()
    if (hasPhone()) useChatStore.getState().setRemoteShared(id, true)
    else openRemoteArea()
  }

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      className={`${HEADER_CHIP} ${
        shared
          ? 'border-green-500/40 text-green-600 dark:text-green-400 hover:border-green-500/70'
          : 'border-gray-200 dark:border-white/[0.06] hover:border-gray-400 dark:hover:border-white/15 text-gray-500'
      }`}
      title={label}
      aria-label={label}
      aria-pressed={shared}
      data-testid="continue-on-phone"
    >
      <Smartphone size={10} />
      {shared && <span>Phone</span>}
    </button>
  )
}
