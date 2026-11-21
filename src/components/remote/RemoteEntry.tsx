import { Globe, Radio, Wifi } from 'lucide-react'
import { useModelStore } from '../../stores/modelStore'
import { useRemoteStore } from '../../stores/remoteStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { useChatStore } from '../../stores/chatStore'
import { ModelSelector } from '../models/ModelSelector'
import { RecentChats } from '../chat/RecentChats'

/**
 * The Remote area when no phone session is open. It lives in the main window,
 * so it reads the same with the side panel open or collapsed.
 */
export function RemoteEntry() {
  const activeModel = useModelStore((s) => s.activeModel)
  const cloud = useSettingsStore((s) => s.settings.appMode === 'cloud')
  const loading = useRemoteStore((s) => s.loading)
  const error = useRemoteStore((s) => s.error)
  const enabled = useRemoteStore((s) => s.enabled)
  const liveId = useRemoteStore((s) => s.dispatchedConversationId)
  const start = useRemoteStore((s) => s.requestDispatch)
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const live = enabled && !!liveId

  return (
    <div data-testid="remote-entry" className="flex-1 flex flex-col items-center justify-center min-h-0 px-3 pb-4">
      <div className="w-full max-w-[var(--lu-measure)] flex flex-col items-center text-center gap-2">
        <Radio size={20} className="text-gray-400" />
        <h1 className="t-display text-gray-900 dark:text-gray-100">Use LU from your phone</h1>
        <p className="t-body text-gray-500 max-w-[44ch]">
          Your chats keep running on this computer. Start Remote, then scan the QR code with your phone.
        </p>
        {error && <p role="alert" className="t-micro text-red-500 max-w-[44ch] break-words">{error}</p>}
        {live ? (
          <button onClick={() => useChatStore.getState().setActiveConversation(liveId)} className="lu-primary lu-control mt-1">
            Open the live chat
          </button>
        ) : !activeModel ? (
          <>
            <p className="t-micro text-gray-500">Remote needs a model first.</p>
            {cloud ? (
              <ModelSelector />
            ) : (
              <button onClick={() => useUIStore.getState().setView('models')} className="lu-primary lu-control mt-1">
                Pick a model
              </button>
            )}
          </>
        ) : (
          <div className="flex items-center gap-2 mt-1">
            <button disabled={loading} onClick={() => start('lan')} title="Phone and computer on the same network" className="lu-primary lu-control inline-flex items-center gap-1.5">
              <Wifi size={12} /> Same Wi-Fi
            </button>
            <button disabled={loading} onClick={() => start('internet')} title="From anywhere, through an encrypted tunnel" className="lu-control inline-flex items-center gap-1.5">
              <Globe size={12} /> Over the internet
            </button>
          </div>
        )}
        <button onClick={() => useUIStore.getState().openSettingsAt({ tab: 'voice-remote' })} className="t-micro text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 underline underline-offset-2">
          Paired devices and settings
        </button>
        {/* Collapsed, the panel's list of earlier Remote chats is out of reach. */}
        {!sidebarOpen && (
          <div className="w-full pt-3 flex flex-col items-center text-left">
            <RecentChats />
          </div>
        )}
      </div>
    </div>
  )
}
