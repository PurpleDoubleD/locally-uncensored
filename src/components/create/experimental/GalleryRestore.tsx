import { useState } from 'react'
import { ArchiveRestore } from 'lucide-react'
import { Modal } from '../../ui/Modal'
import { ModalActions, ModalButton } from '../../ui/ModalActions'
import { restoreFromOutputFolder, type RestoreResult } from '../../../lib/gallery-restore'
import { OnBody } from './GalleryFolders'

// "Restore from the output folder" (C27, 3.1.0): the gallery takes back the
// pictures and videos ComfyUI's output folder still has (lib/gallery-restore.ts).

/** What the dialog says after a run. */
export function restoreLine(r: RestoreResult): string {
  if (!r.reachable) return 'LU cannot read the output folder of this ComfyUI. It is on another computer, or not set up yet.'
  if (r.found === 0) return 'The output folder has no pictures or videos.'
  const found = `Found ${r.found} file${r.found === 1 ? '' : 's'}`
  const added = r.added === 0
    ? 'the gallery lists all of them already.'
    : `${r.added} ${r.added === 1 ? 'is' : 'are'} back in the gallery${r.withPrompt > 0 ? `, ${r.withPrompt} with their prompt` : ''}.`
  const cut = r.truncated ? ' The folder holds more than one look can take; run it again after sorting some out.' : ''
  return `${found}, ${added}${cut}`
}

/** The button in the gallery header and its dialog. */
export function RestoreFromOutputButton() {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [line, setLine] = useState<string | null>(null)
  const run = async () => {
    setBusy(true)
    setLine(null)
    try {
      setLine(restoreLine(await restoreFromOutputFolder()))
    } catch (err) {
      setLine(`Could not look through the output folder: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }
  const close = () => { if (!busy) { setOpen(false); setLine(null) } }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Restore from the output folder" aria-label="Restore from the output folder"
        className="ml-auto flex items-center justify-center w-6 h-6 rounded text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
      >
        <ArchiveRestore size={13} />
      </button>
      <OnBody>
      <Modal open={open} onClose={close} title="Restore from the output folder" maxWidth="max-w-md">
        <div className="flex flex-col gap-3" data-testid="gallery-restore">
          <p className="t-body text-gray-500">
            LU looks through ComfyUI&apos;s output folder and adds every picture, video and sound the gallery does not list yet.
            Prompts and settings come back where the file carries them. Nothing on disk changes.
          </p>
          {line && <p role="status" className="t-body text-gray-200">{line}</p>}
          <ModalActions>
            <ModalButton variant="quiet" onClick={close} disabled={busy}>{line ? 'Done' : 'Cancel'}</ModalButton>
            <ModalButton variant="primary" onClick={() => { void run() }} disabled={busy}>
              {busy ? 'Looking…' : line ? 'Look again' : 'Look now'}
            </ModalButton>
          </ModalActions>
        </div>
      </Modal>
      </OnBody>
    </>
  )
}
