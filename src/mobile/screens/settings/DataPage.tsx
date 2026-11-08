/**
 * E16 Backup and import. Route /settings/data, page, strand 5 (Account, cloud, settings).
 *
 * All chats into one file through the share sheet, back from such a file,
 * the import from other chat apps, the automatic backup in the app folder,
 * and deleting every chat behind two questions.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ArchiveRestore, DatabaseBackup, FileDown, FileUp, Import, Save, Trash2 } from 'lucide-react'
import { portableConversation, serializeAllConversations } from '../../../lib/chat-export'
import { backupStoresNow, lastStoreBackupAt, onStoreBackupWritten } from '../../../lib/store-backup'
import { useChatStore } from '../../../stores/chatStore'
import { restorableChats, restoreChatsFromPhoneBackup } from '../../lib/chat-rescue'
import type { Conversation } from '../../../types/chat'
import { nav } from '../../nav'
import { hasNativeBridge, isNativeUnavailable, pickFiles, saveToDevice, shareFile } from '../../platform'
import { marketed } from '../../policy/gates'
import { SETTINGS_STRINGS } from '../../strings/settings'
import { Button, ListGroup, Notice, Page, Row, toast } from '../../ui'
import { backupFileName, backupNote,
  backupToast, backupWhen, forgetCreateDraftEverywhere, isLargeFile, readBackupText, type BackupNote, type BackupOutcome } from './parts/data'
import { chatsAreWritten } from './parts/durable'
import { Block, Hint } from './parts/layout'
import { useMobilePrefs } from './parts/prefs'

const T = SETTINGS_STRINGS.data

type Restore =
  | { kind: 'idle' }
  | { kind: 'reading'; large: boolean }
  | { kind: 'found'; conversations: Conversation[] }
  /** The chats are in the list and on their way into the storage of the phone. Not done yet. */
  | { kind: 'writing' }
  | { kind: 'error'; text: string }

/** When the automatic backup was last written in this session (the logic layer knows it exactly), or null. */
function useWrittenAt(): number | null {
  return useSyncExternalStore(onStoreBackupWritten, lastStoreBackupAt, () => null)
}

export default function DataPage() {
  const count = useChatStore((s) => s.conversations.length)
  const askedAt = useMobilePrefs((s) => s.lastBackupAt)
  const setPref = useMobilePrefs((s) => s.setPref)
  const writtenAt = useWrittenAt()
  // The time the file was written wins. The time of the last "Back up now" is what is known across a restart.
  const lastBackupAt = Math.max(askedAt, writtenAt ?? 0)
  const [exporting, setExporting] = useState<'save' | 'share' | null>(null)
  const [note, setNote] = useState<BackupNote | null>(null)
  const [restore, setRestore] = useState<Restore>({ kind: 'idle' })
  const [backingUp, setBackingUp] = useState(false)
  const [deleting, setDeleting] = useState(false)
  /** Chats of the automatic backup that are not in the list (C46). null: still looking; 'unreadable': the backup could not be read. */
  const [inBackup, setInBackup] = useState<number | 'unreadable' | null>(hasNativeBridge() ? null : 0)
  const [rescuing, setRescuing] = useState(false)

  const lookInBackup = async () => {
    try {
      setInBackup((await restorableChats()).length)
    } catch {
      setInBackup('unreadable')
    }
  }
  useEffect(() => {
    if (hasNativeBridge()) void lookInBackup()
  }, [count])

  /**
   * One file with every chat, out of the app in one of two ways: into a folder
   * the user picks in the save dialog of the system ("Restore" then finds it
   * in the file picker), or to the share sheet. What happened stays on the
   * page as a sentence, because a toast is gone before the system dialog is.
   */
  const backup = async (how: 'save' | 'share') => {
    if (exporting) return
    const conversations = useChatStore.getState().conversations
    if (conversations.length === 0) {
      toast(T.backupNone, { testid: 'backup-none' })
      return
    }
    setExporting(how)
    setNote(null)
    try {
      const portable: Conversation[] = []
      for (const conversation of conversations) portable.push(await portableConversation(conversation))
      const name = backupFileName(portable.length)
      const file = { name, mime: 'application/json', data: serializeAllConversations(portable, marketed('locally-uncensored', 'lu')) }
      let outcome: BackupOutcome
      if (how === 'save') {
        try {
          const result = await saveToDevice({ ...file, target: 'files' })
          outcome = { how: 'save', saved: result.saved, via: result.via }
        } catch (err) {
          outcome = isNativeUnavailable(err) ? { how: 'save', unavailable: true } : { how: 'save', failed: true }
        }
      } else {
        const result = await shareFile({ ...file, title: T.backup })
        outcome = { how: 'share', completed: result.completed, via: result.via }
      }
      const said = backupNote(outcome, portable.length, name)
      setNote(said)
      const which = backupToast(outcome, said.ok)
      if (which === 'downloaded') toast(T.backupDownloaded(portable.length), { testid: 'backup-done' })
      else if (which === 'saved') toast(T.backupSavedToast(portable.length), { testid: 'backup-done' })
      else if (which === 'cancelled') toast(T.backupCancelled, { testid: 'backup-cancelled' })
    } catch {
      toast(T.backupFailed, { tone: 'error', testid: 'backup-failed' })
    } finally {
      setExporting(null)
    }
  }

  const pickRestore = async () => {
    const picked = await pickFiles({ accept: '.json,application/json' })
    const first = picked[0]
    if (!first) return
    setRestore({ kind: 'reading', large: isLargeFile(first.size) })
    let text: string
    try {
      text = await first.file.text()
    } catch {
      setRestore({ kind: 'error', text: T.fileUnreadable })
      return
    }
    const read = readBackupText(text)
    if (!read.ok) setRestore({ kind: 'error', text: read.reason === 'not-json' ? T.fileNotJson : T.fileNoChats })
    else setRestore({ kind: 'found', conversations: read.conversations })
  }

  const doRestore = async () => {
    if (restore.kind !== 'found') return
    const wanted = restore.conversations
    setRestore({ kind: 'writing' })
    const { added, skipped } = useChatStore.getState().importConversations(wanted, 'merge')
    // "Restored" is only true once the chats are in the storage of the phone: a restore must not
    // depend on the app staying open a little longer. Written out now, then read back.
    const ids = new Set(wanted.map((c) => c.id))
    const present = useChatStore.getState().conversations.filter((c) => ids.has(c.id)).map((c) => c.id)
    const written = await chatsAreWritten({ present })
    if (!written) {
      setRestore({ kind: 'error', text: T.restoreNotSaved })
      return
    }
    setRestore({ kind: 'idle' })
    toast(T.restoreDone(added, skipped), { testid: 'restore-done' })
  }

  /** Every chat of the automatic backup that is not in the list, "restored" only once it is written. */
  const rescue = async () => {
    if (rescuing) return
    setRescuing(true)
    try {
      const ids = await restoreChatsFromPhoneBackup()
      const written = ids.length === 0 || (await chatsAreWritten({ present: ids }))
      if (written) toast(T.rescueDone(ids.length), { testid: 'rescue-done' })
      else toast(T.restoreNotSaved, { tone: 'error', testid: 'rescue-not-saved' })
    } catch {
      toast(T.rescueUnreadable, { tone: 'error', testid: 'rescue-unreadable' })
    } finally {
      setRescuing(false)
      void lookInBackup()
    }
  }

  const backupNow = async () => {
    if (backingUp) return
    setBackingUp(true)
    try {
      const written = await backupStoresNow()
      if (written) {
        setPref('lastBackupAt', Date.now())
        toast(T.autoDone, { testid: 'auto-backup-done' })
      } else {
        toast(T.autoUnavailable, { tone: 'error', testid: 'auto-backup-unavailable' })
      }
    } finally {
      setBackingUp(false)
    }
  }

  const deleteAll = async () => {
    const first = await nav.confirm({ title: T.deleteQuestion, text: T.deleteText, confirmLabel: T.deleteConfirm, cancelLabel: T.deleteKeep, tone: 'danger', testid: 'delete-all-1' })
    if (!first) return
    const second = await nav.confirm({
      title: T.deleteQuestion2,
      text: T.deleteText2,
      confirmLabel: T.deleteConfirm2,
      cancelLabel: T.deleteKeep,
      tone: 'danger',
      requireText: T.deleteWord,
      testid: 'delete-all-2',
    })
    if (!second) return
    // One by one through the store, so a running answer is stopped and the
    // side data of every chat (documents, drafts) goes with it.
    setDeleting(true)
    try {
      const ids = useChatStore.getState().conversations.map((c) => c.id)
      for (const id of ids) useChatStore.getState().deleteConversation(id)
      // The unsent draft of Create (words and photos) goes with it.
      await forgetCreateDraftEverywhere()
      // Said only once the storage of the phone agrees, so the chats do not come back when the app is closed right after.
      const written = await chatsAreWritten({ absent: ids })
      if (written) toast(T.deleted(ids.length), { testid: 'delete-all-done' })
      else toast(T.deleteNotSaved, { tone: 'error', testid: 'delete-all-not-saved' })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Page title={T.title} screen="settings-data">
      <ListGroup title={T.groupBackup}>
        <Row
          icon={Save}
          title={T.backupSave}
          subtitle={exporting === 'save' ? T.backupWorking : T.backupSaveSub}
          chevron={false}
          disabled={exporting !== null}
          onPress={() => void backup('save')}
          testid="m-settings-data-backup-save"
          el="E16.1"
        />
        <Row
          icon={FileUp}
          title={T.backupShareTitle}
          subtitle={exporting === 'share' ? T.backupWorking : T.backupShareSub}
          chevron={false}
          disabled={exporting !== null}
          onPress={() => void backup('share')}
          risk="leaves-app" testid="m-settings-data-backup"
          el="E16.1"
        />
        <Row
          icon={FileDown}
          title={T.restore}
          subtitle={T.restoreSub}
          chevron={false}
          disabled={restore.kind === 'writing'}
          disabledReason={T.restoreWriting}
          onPress={() => void pickRestore()}
          testid="m-settings-data-restore"
          el="E16.2"
        />
        <Row icon={Import} title={T.importOther} subtitle={T.importOtherSub} onPress={() => nav.push('/settings/data/import')} testid="m-settings-data-import" el="E16.3" />
      </ListGroup>

      {note ? (
        <Notice variant={note.tone} testid="m-settings-data-backup-note">
          <span data-ok={note.ok ? 'yes' : 'no'} data-testid="m-settings-data-backup-note-text">
            {note.text}
          </span>
          {note.restoreHint ? ` ${T.backupRestoreHint}` : null}
        </Notice>
      ) : null}
      {restore.kind === 'reading' ? (
        <Notice testid="m-settings-data-restore-reading">{restore.large ? SETTINGS_STRINGS.dataImport.tooLarge : T.restoreReading}</Notice>
      ) : null}
      {restore.kind === 'writing' ? <Notice testid="m-settings-data-restore-writing">{T.restoreWriting}</Notice> : null}
      {restore.kind === 'error' ? (
        <Notice variant="error" testid="m-settings-data-restore-error">
          {restore.text}
        </Notice>
      ) : null}
      {restore.kind === 'found' ? (
        <Notice
          title={T.restoreFound(restore.conversations.length)}
          testid="m-settings-data-restore-found"
          actions={
            <>
              <Button compact variant="primary" onPress={() => void doRestore()} risk="destructive" testid="m-settings-data-restore-confirm" el="E16.2">
                {T.restoreConfirm}
              </Button>
              <Button compact variant="quiet" onPress={() => setRestore({ kind: 'idle' })} testid="m-settings-data-restore-cancel">
                {T.restoreCancel}
              </Button>
            </>
          }
        >
          {T.restoreFoundText}
        </Notice>
      ) : null}

      <ListGroup title={T.groupAuto}>
        <Row
          icon={DatabaseBackup}
          title={T.autoLabel}
          subtitle={lastBackupAt ? T.autoAt(backupWhen(lastBackupAt)) : hasNativeBridge() ? T.autoNever : T.autoNeedsApp}
          testid="m-settings-data-auto"
          el="E16.4"
        />
        {hasNativeBridge() ? (
          <Row
            icon={ArchiveRestore}
            title={T.rescue}
            subtitle={
              rescuing ? T.rescueWorking : inBackup === null ? T.rescueLooking : inBackup === 'unreadable' ? T.rescueUnreadable : inBackup > 0 ? T.rescueFound(inBackup) : T.rescueNone
            }
            chevron={false}
            disabled={rescuing || inBackup === null || inBackup === 'unreadable' || inBackup === 0}
            disabledReason={inBackup === 0 ? T.rescueNone : inBackup === 'unreadable' ? T.rescueUnreadable : T.rescueLooking}
            onPress={() => void rescue()}
            testid="m-settings-data-rescue"
            state={typeof inBackup === 'number' ? `found-${inBackup}` : inBackup === null ? 'looking' : inBackup}
            el="E16.4"
          />
        ) : null}
      </ListGroup>
      <Block>
        <Hint>{T.autoText}</Hint>
        <Button block busy={backingUp} onPress={() => void backupNow()} testid="m-settings-data-auto-now" el="E16.4">
          {T.autoNow}
        </Button>
      </Block>

      <ListGroup title={T.groupDanger}>
        <Row
          icon={Trash2}
          title={T.deleteAll}
          subtitle={deleting ? T.deleting : T.deleteAllSub(count)}
          danger
          chevron={false}
          disabled={count === 0 || deleting}
          disabledReason={T.deleteAllSub(0)}
          onPress={() => void deleteAll()}
          risk="destructive" testid="m-settings-data-all-delete"
          el="E16.5"
        />
      </ListGroup>
    </Page>
  )
}
