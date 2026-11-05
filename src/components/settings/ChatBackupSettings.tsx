import { useEffect, useRef, useState } from 'react'
import { Download, Upload, History } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { exportAllConversations, parseImportedChats, missingImagesNote } from '../../lib/chat-export'
import { backendCall, isTauri } from '../../api/backend'
import { countRestorableChats, restoreChatsFromBackup } from '../../lib/chat-rescue'

/**
 * Chat Backup (a user 2026-06-28) — export ALL conversations to one JSON file
 * and re-import them. The web build has no store_backup.json, so a web user on
 * an SSH tunnel loses chats when the origin (host/port) changes; this is their
 * manual backup + restore path. Works on desktop too (native Save As dialog).
 */
export function ChatBackupSettings() {
  const conversations = useChatStore((s) => s.conversations)
  const importConversations = useChatStore((s) => s.importConversations)
  const fileRef = useRef<HTMLInputElement>(null)
  const [msg, setMsg] = useState<string>('')

  const handleExport = async () => {
    if (conversations.length === 0) {
      setMsg('No chats to export yet.')
      return
    }
    const res = await exportAllConversations(conversations)
    if (res.status === 'cancelled') return
    if (res.status === 'error') { setMsg(res.error ?? 'Could not export chats.'); return }
    if (res.status === 'saved') {
      setMsg(`Saved ${res.count} chat${res.count === 1 ? '' : 's'} to ${res.path}.${missingImagesNote(res.missing)}`)
    } else {
      setMsg(`Downloaded ${res.count} chat${res.count === 1 ? '' : 's'} as JSON.`)
    }
  }

  const importText = (content: string) => {
    try {
      const convs = parseImportedChats(content)
      const { added, skipped } = importConversations(convs, 'merge')
      setMsg(
        added > 0
          ? `Imported ${added} chat${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} already present` : ''}.`
          : `Nothing new, all ${skipped} chat${skipped === 1 ? '' : 's'} were already here.`,
      )
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Could not import that file.')
    }
  }

  // Desktop: the file is read natively and its images are moved into the
  // attachment store before the WebView parses it, so a large export with
  // every image inline is never one string in the renderer.
  const handleImportClick = async () => {
    if (!isTauri()) { fileRef.current?.click(); return }
    try {
      const content = await backendCall<string | null>('import_chats_dialog')
      if (content) importText(content)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const content = ev.target?.result as string
      if (!content) {
        setMsg('Could not read that file.')
        return
      }
      importText(content)
    }
    reader.onerror = () => setMsg('Could not read that file.')
    reader.readAsText(file)
  }

  return (
    <div className="space-y-2">
      <div className="text-[0.6rem] text-gray-500 dark:text-gray-500 leading-relaxed">
        Save all your chats to a single JSON file, or restore them from one. On the web version your chats live in the
        browser, so this is your backup if you ever open LU from a different address (e.g. after a tunnel reconnect).
      </div>
      <div className="flex gap-2">
        <button
          onClick={handleExport}
          className="flex-1 text-[0.65rem] flex items-center justify-center gap-1.5 px-2 py-1.5 rounded border border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:border-gray-400 dark:hover:border-white/20 transition-colors"
        >
          <Download size={12} /> Export all chats
        </button>
        <button
          onClick={() => void handleImportClick()}
          className="flex-1 text-[0.65rem] flex items-center justify-center gap-1.5 px-2 py-1.5 rounded border border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:border-gray-400 dark:hover:border-white/20 transition-colors"
        >
          <Upload size={12} /> Import chats
        </button>
        <input ref={fileRef} type="file" accept=".json,application/json" onChange={handleImport} className="hidden" />
      </div>
      {msg && <div className="text-[0.6rem] text-gray-500 dark:text-gray-400">{msg}</div>}
      {isTauri() && <RestoreFromBackup />}
    </div>
  )
}

/**
 * Restore chats from backup (3.0.10). LU keeps several copies of its stores
 * in the app data folder; this reads all of them and puts back every chat the
 * list here does not have. Chats that are here stay as they are.
 */
function RestoreFromBackup() {
  const importConversations = useChatStore((s) => s.importConversations)
  const liveCount = useChatStore((s) => s.conversations.length)
  const [found, setFound] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  useEffect(() => {
    let gone = false
    countRestorableChats(() => useChatStore.getState().conversations)
      .then((n) => { if (!gone) setFound(n) })
      .catch(() => { if (!gone) setFound(0) })
    return () => { gone = true }
  }, [liveCount])

  const restore = async () => {
    setBusy(true)
    try {
      const added = await restoreChatsFromBackup(() => useChatStore.getState().conversations, importConversations)
      setNote(added > 0 ? `Restored ${added} chat${added === 1 ? '' : 's'} from the backup.` : 'Nothing to restore, every chat in the backup is already here.')
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not read the backup.')
    } finally {
      setBusy(false)
    }
  }

  // A backup the user kept somewhere else (copied out of the app data folder,
  // for example into a rescue folder on the desktop). Read natively, so a
  // store_backup*.json reaches the WebView as its chat list (externalize_import).
  const pickFile = async () => {
    setBusy(true)
    try {
      const content = await backendCall<string | null>('import_chats_dialog')
      if (!content) return
      const { added, skipped } = importConversations(parseImportedChats(content), 'merge')
      setNote(added > 0
        ? `Restored ${added} chat${added === 1 ? '' : 's'} from that file${skipped ? `, ${skipped} were already here` : ''}.`
        : 'Nothing new in that file, every chat in it is already here.')
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not read that file.')
    } finally {
      setBusy(false)
    }
  }

  const label = found === null
    ? 'Looking in the backup...'
    : found === 0
      ? 'No missing chats in the backup'
      : `Restore chats from backup (${found} found)`

  return (
    <div className="pt-2 space-y-1">
      <button
        onClick={() => void restore()}
        disabled={busy || !found}
        data-testid="restore-chats-from-backup"
        className="w-full t-micro flex items-center justify-center gap-1.5 px-2 py-1.5 rounded border border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:border-gray-400 dark:hover:border-white/20 transition-colors disabled:opacity-50 disabled:cursor-default"
      >
        <History size={12} /> {busy ? 'Restoring...' : label}
      </button>
      <button
        onClick={() => void pickFile()}
        disabled={busy}
        data-testid="restore-chats-from-file"
        className="w-full t-micro flex items-center justify-center gap-1.5 px-2 py-1.5 rounded border border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:border-gray-400 dark:hover:border-white/20 transition-colors disabled:opacity-50 disabled:cursor-default"
      >
        <Upload size={12} /> Choose a backup file...
      </button>
      <div className="t-micro text-gray-500 dark:text-gray-500 leading-relaxed">
        LU keeps copies of your chats in its app data folder. This brings back the ones missing here and leaves the others as they are. Kept a copy of that folder somewhere else? Choose a store_backup file from it.
      </div>
      {note && <div className="t-micro text-gray-500 dark:text-gray-400">{note}</div>}
    </div>
  )
}
