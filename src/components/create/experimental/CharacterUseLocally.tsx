// "Use locally" on a row of the cloud character shelf: the weights go into
// this computer's LoRA folder under the local trainer's name, and the
// character shows on the local Use character shelf. Only Z-Image characters
// run locally; any other family gets a fixed "Cloud only" label instead of
// the button (3.0.8), so the row never offers what it cannot do.
import { useState } from 'react'
import { HardDriveDownload, Loader2, X } from 'lucide-react'
import { useCreateStore } from '../../../stores/createStore'
import type { CloudLora, LoraDownloadProgress } from '../../../api/cloud/loras'
import { CLOUD_ONLY_LABEL, ONLY_ZIMAGE_LOCALLY, canUseLocally, importCloudCharacter, keyFormatNote } from '../../../api/character-import'
import { errorText } from '../../../types/json-guards'
import { HINWEIS_TEXT } from '../../../lib/hinweis'
import { cn } from '../ui/cn'

/** After a file landed: ComfyUI rereads its folders, then every shelf asks
 *  again. The Mac lists its own folder and needs no rescan. */
export async function refreshLocalShelves(): Promise<void> {
  const { isMlxImageHost } = await import('../../../api/mlx-image')
  if (!isMlxImageHost()) {
    const [{ refreshComfyModels }, { clearNodeCache }] = await Promise.all([
      import('../../../api/comfyui'),
      import('../../../api/comfyui-nodes'),
    ])
    await refreshComfyModels().catch(() => { /* rescan is best-effort */ })
    clearNodeCache()
  }
  useCreateStore.getState().bumpCharactersVersion()
}

export function CharacterUseLocally({ lora }: { lora: CloudLora }) {
  const [progress, setProgress] = useState<LoraDownloadProgress | null>(null)
  const [running, setRunning] = useState<AbortController | null>(null)
  // A short line next to the buttons. Failures and a file LU cannot vouch
  // for go to the red bar of the Create surface, like a failed download.
  const [note, setNote] = useState<{ text: string; title?: string } | null>(null)
  const busy = progress !== null
  const fits = canUseLocally(lora)
  const percent = progress && progress.total > 0 ? Math.floor((progress.received / progress.total) * 100) : null

  if (!fits) {
    return (
      <span
        title={ONLY_ZIMAGE_LOCALLY}
        className={cn('t-micro px-1 whitespace-nowrap', HINWEIS_TEXT.ruhig)}
        data-testid="character-cloud-only"
      >
        {CLOUD_ONLY_LABEL}
      </span>
    )
  }

  const start = () => {
    if (busy) return
    const controller = new AbortController()
    const { setError } = useCreateStore.getState()
    setNote(null)
    setProgress({ received: 0, total: 0 })
    setRunning(controller)
    void importCloudCharacter(lora, setProgress, controller.signal)
      .then(async (end) => {
        if (end.status === 'stopped') { setNote({ text: 'Cancelled' }); return }
        await refreshLocalShelves()
        setNote({ text: 'Saved for local use', title: `${end.file} is on the Use character shelf of the local lane.` })
        const warn = keyFormatNote(end.keyFormat)
        if (warn) setError(warn)
      })
      .catch((err: unknown) => setError(`Use locally failed: ${errorText(err)}`))
      .finally(() => { setProgress(null); setRunning(null) })
  }

  return (
    <>
      <button
        onClick={start}
        disabled={busy}
        className={cn('flex items-center gap-1 p-1', busy ? 'text-gray-400' : 'text-gray-600 hover:text-gray-200')}
        title={busy
          ? `Saving for local use${percent === null ? '…' : `, ${percent}%`}`
          : 'Use locally: save it to the LoRA folder of this computer'}
        aria-label="Use locally"
        data-testid="character-use-locally"
      >
        {busy ? <Loader2 size={11} className="animate-spin" /> : <HardDriveDownload size={11} />}
        {percent !== null && <span className="t-micro tabular-nums">{percent}%</span>}
      </button>
      {running && (
        <button
          onClick={() => running.abort()}
          className="p-1 text-gray-600 hover:text-red-400"
          title="Cancel"
          aria-label="Cancel use locally"
          data-testid="character-use-locally-cancel"
        >
          <X size={11} />
        </button>
      )}
      {note && (
        <span role="status" title={note.title} className={cn('t-micro px-1', HINWEIS_TEXT.ruhig)} data-testid="character-use-locally-note">
          {note.text}
        </span>
      )}
    </>
  )
}
