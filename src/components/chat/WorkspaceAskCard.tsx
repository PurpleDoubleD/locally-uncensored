import { useEffect, useState } from 'react'
import { FolderOpen, Shield, Folder, Clock } from 'lucide-react'
import { backendCall } from '../../api/backend'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { useAgentModeStore } from '../../stores/agentModeStore'
import { useChatStore } from '../../stores/chatStore'
import { resolveWorkspaceAsk, useWorkspaceAskStore, type Resend } from '../../lib/agent-workspace-ask'

interface Props {
  conversationId: string
  /** Der Sendeweg des Chats; die geparkte Nachricht geht nach der Wahl hier hinaus. */
  resend: Resend
}

/**
 * Die Frage vor dem ersten Agentenzug, als Karte im Verlauf (3.1.2).
 *
 * Gebaut wie eine wartende Werkzeugkarte (ToolCallBlock): eine Kopfzeile mit
 * grauem Zeichen und der Uhr im ruhigen Ton, darunter eingerueckt ein Satz und
 * die zwei Wege. Kein Kasten, keine Flaeche, keine Bewegung.
 *
 * "Folder…" oeffnet den nativen Ordnerwaehler mit `asWorkspace: true`: ein
 * Ordner, den die Rust-Seite nicht annimmt, kommt als Fehler zurueck und steht
 * dann hier, gesetzt wird er nicht. Abbrechen im Waehler laesst die Frage
 * offen.
 */
export function WorkspaceAskCard({ conversationId, resend }: Props) {
  const ask = useWorkspaceAskStore((s) => s.asks[conversationId])
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Chosen elsewhere while the card was open (the workspace pill next to the
  // Agent switch): that choice answers the card too, and the message goes out.
  const chosen = useAgentModeStore((s) => s.workspaces[conversationId])
  useEffect(() => {
    if (ask && chosen) void resolveWorkspaceAsk(conversationId, chosen, resend)
  }, [ask, chosen, conversationId, resend])

  // The parked message left the thread another way (edited, deleted): the
  // question has nothing left to carry and goes with it.
  const parkedGone = useChatStore((s) => {
    if (!ask) return false
    const msgs = s.conversations.find((c) => c.id === conversationId)?.messages ?? []
    return !ask.messageIds.some((id) => msgs.some((m) => m.id === id))
  })
  useEffect(() => {
    if (ask && parkedGone) useWorkspaceAskStore.getState().clear(conversationId)
  }, [ask, parkedGone, conversationId])

  if (!ask || parkedGone) return null
  const shownError = error ?? ask.error

  const chooseSandbox = () => {
    setError(null)
    void resolveWorkspaceAsk(conversationId, { kind: 'sandbox' }, resend)
  }

  const chooseFolder = async () => {
    setPicking(true)
    setError(null)
    try {
      const path = await backendCall<string | null>('pick_folder', { asWorkspace: true })
      if (path) {
        await resolveWorkspaceAsk(conversationId, { kind: 'folder', path, extraPaths: [] }, resend)
        return
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Folder picker unavailable (bridge offline?)')
    } finally {
      setPicking(false)
    }
  }

  const btn =
    'flex items-center gap-1 px-2.5 py-1 rounded t-micro text-gray-700 dark:text-gray-200 border border-gray-300 dark:border-white/15 hover:bg-gray-100 dark:hover:bg-white/[0.06] transition-colors disabled:opacity-50 disabled:cursor-not-allowed'

  return (
    <div className="mb-0.5" data-testid="workspace-ask" data-status="pending_approval">
      <div className="flex items-center gap-2 py-1">
        <FolderOpen size={13} className="text-gray-400 dark:text-gray-500 shrink-0" />
        <span className="t-control text-gray-600 dark:text-gray-400 truncate min-w-0">
          Where should I work?
        </span>
        <Clock size={11} className={`shrink-0 ${HINWEIS_TEXT.ruhig}`} />
      </div>
      <div className="pl-5 pb-1.5 space-y-1">
        <p className="t-micro text-gray-500 dark:text-gray-400" data-testid="workspace-ask-boundary">
          Sandbox is a separate folder for this chat. A folder lets me edit your files there.
          Commands run on this computer.
        </p>
        <div className="flex items-center gap-1.5 pt-1">
          <button type="button" onClick={chooseSandbox} disabled={picking} className={btn} data-testid="workspace-ask-sandbox">
            <Shield size={10} /> Sandbox
          </button>
          <button type="button" onClick={() => void chooseFolder()} disabled={picking} className={btn} data-testid="workspace-ask-folder">
            <Folder size={10} /> {picking ? 'Opening picker…' : 'Folder…'}
          </button>
        </div>
        {shownError && <p className="t-micro text-red-500" data-testid="workspace-ask-error">{shownError}</p>}
      </div>
    </div>
  )
}
