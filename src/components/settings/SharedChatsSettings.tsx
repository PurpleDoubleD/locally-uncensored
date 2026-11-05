import { Smartphone, X } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { SHARED_CHATS_PHONE_NOTE_LONG } from '../chat/shared-chats-note'

/** The id and title of every shared chat, as a stable string so a streaming
 *  answer does not repaint this list. */
function sharedKey(s: ReturnType<typeof useChatStore.getState>): string {
  return JSON.stringify(s.conversations.filter((c) => c.remoteShared).map((c) => [c.id, c.title]))
}

/**
 * Shared chats in the Remote settings (CHATS-V1.md): whether new chats are
 * shared with the paired phones, and the list "Shared with your phone" with
 * a way to end it per chat.
 */
export function SharedChatsSettings() {
  const shareNew = useSettingsStore((s) => !!s.settings.shareNewChatsWithPhone)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const key = useChatStore(sharedKey)
  const shared = JSON.parse(key) as [string, string][]
  return (
    <div className="space-y-2" data-testid="shared-chats-settings">
      <div className="flex items-center gap-1.5">
        <Smartphone size={12} className="text-gray-500" />
        <span className="t-micro font-medium text-gray-400">Shared with your phone</span>
      </div>
      <p className="t-micro text-gray-500 dark:text-gray-600" data-testid="shared-chats-phone-note">{SHARED_CHATS_PHONE_NOTE_LONG}</p>
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={shareNew}
          onChange={(e) => updateSettings({ shareNewChatsWithPhone: e.target.checked })}
          className="mt-0.5"
          aria-label="Share new chats with paired phones"
        />
        <span>
          <span className="t-micro text-gray-700 dark:text-gray-300 block">Share new chats with paired phones</span>
          <span className="t-micro text-gray-500 dark:text-gray-600 block">A shared chat runs on this computer. The phone shows it, writes into it and can approve its tools, within the rights of the phone.</span>
        </span>
      </label>
      {shared.length === 0 ? (
        <p className="t-micro text-gray-500 dark:text-gray-600">No chat is shared yet. Use Continue on phone in a chat or in its menu in the chat list.</p>
      ) : (
        <ul className="space-y-1">
          {shared.map(([id, title]) => (
            <li key={id} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => { useChatStore.getState().setActiveConversation(id); useUIStore.getState().setView('chat') }}
                className="flex-1 min-w-0 text-left t-micro text-gray-700 dark:text-gray-300 truncate hover:underline"
                title={title}
              >
                {title || 'Untitled chat'}
              </button>
              <button
                type="button"
                onClick={() => useChatStore.getState().setRemoteShared(id, false)}
                className="flex items-center gap-1 t-micro text-gray-500 hover:text-red-500"
                aria-label={`Stop sharing ${title || 'this chat'} with your phone`}
              >
                <X size={11} /> Stop sharing
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
