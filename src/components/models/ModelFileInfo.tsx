// Details for a ComfyUI file of the Installed list: an image or video model,
// a LoRA, a VAE (D1, a user on Discord, 01.11.2026: the ⓘ beside the bin
// did nothing, and LoRA rows had none). What the disk says, the page the file
// came from when LU downloaded it, and the reason when the file cannot be read.
import { ExternalLink, Loader2 } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { ModalActions, ModalButton } from '../ui/ModalActions'
import { formatBytes } from '../../lib/formatters'
import { openExternal } from '../../api/backend'
import type { ComfyFileFacts } from '../../api/discover'

export interface ModelFileInfoState {
  /** The ComfyUI name, with its subfolder when it has one. */
  name: string
  /** "LoRA", "Checkpoint", … or null when the folder is not known. */
  kind: string | null
  /** Size from the inventory, for while the disk is still being asked. */
  size: number
  facts: ComfyFileFacts | null
  error: string | null
  /** Hugging Face or CivitAI page, only when LU wrote it down. */
  page: string | null
}

function when(secs: number | null): string | null {
  if (secs == null) return null
  return new Date(secs * 1000).toLocaleString()
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[6rem_1fr] gap-2 py-1">
      <dt className="t-micro text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className={`t-micro text-gray-900 dark:text-gray-100 break-all ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  )
}

export function ModelFileInfo({ info, onClose }: { info: ModelFileInfoState | null; onClose: () => void }) {
  const facts = info?.facts ?? null
  const file = info ? (info.name.split(/[\\/]/).pop() ?? info.name) : ''
  const bytes = facts ? facts.bytes : info?.size ?? 0
  return (
    <Modal open={!!info} onClose={onClose} title={file || 'Model details'}>
      {info && (
        <div data-testid="model-file-info">
          <dl className="mb-3">
            <Row label="File" value={file} mono />
            {info.kind && <Row label="Type" value={info.kind} />}
            {bytes > 0 && <Row label="Size" value={formatBytes(bytes)} />}
            {facts && <Row label="Folder" value={facts.folder} mono />}
            {facts && when(facts.modified) && <Row label="Changed" value={when(facts.modified)!} />}
          </dl>
          {facts?.ownFolder && (
            <p className="t-micro text-gray-600 dark:text-gray-300 mb-3">
              This file is in your own model folder (Settings, Storage). LU reads it from there and does not delete it.
            </p>
          )}
          {facts && facts.copies > 1 && (
            <p className="t-micro text-gray-600 dark:text-gray-300 mb-3">
              There are {facts.copies} files of this name in the model folders. This is the first one.
            </p>
          )}
          {!facts && !info.error && (
            <p className="t-micro text-gray-500 dark:text-gray-400 mb-3 flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" /> Reading the file…
            </p>
          )}
          {info.error && (
            <p role="alert" className="t-micro text-red-500 dark:text-red-400 mb-3 break-words">
              {info.error}
            </p>
          )}
        </div>
      )}
      <ModalActions>
        {info?.page && (
          <ModalButton variant="quiet" onClick={() => { void openExternal(info.page!) }}>
            <span className="inline-flex items-center gap-1.5"><ExternalLink size={12} /> Open source page</span>
          </ModalButton>
        )}
        <ModalButton onClick={onClose}>Close</ModalButton>
      </ModalActions>
    </Modal>
  )
}
